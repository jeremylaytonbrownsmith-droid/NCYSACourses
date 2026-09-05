// NCYSA Learn — self-hosted course platform (Thinkific/Teachable style).
//
// Gating rules (enforced server-side, not just in the UI):
//   * Lessons unlock strictly in order; completing lesson N requires N-1 done.
//   * Video lessons require watchedSeconds >= minWatchSeconds (58s of a 60s
//     video) accumulated through real playback heartbeats.
//   * Quiz lessons require a graded score >= passPercent.
//   * Completing the final lesson completes the course, issues a certificate,
//     and fires notifications to the learner AND to NCYSA.

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

const { load, save, id, initFromCloud } = require('./lib/store');
const { onCourseCompleted, sendTestEmail } = require('./lib/notifier');
const courseSeed = require('./data/courses');
// The 2026 NCSRA video "Recertification Refresher" pilot has been retired in
// favour of the uploaded SCORM referee modules. Its data file (data/ncsra-pilot.js)
// is kept for reference/restore, but it is no longer code-managed into the store,
// and its id is retired below so the live copy is removed on boot.

// Courses live in the persisted store so admins can edit them at runtime.
// Seed from the static catalog on first boot.
function allCourses() { return load().courses; }
// A course is visible to learners once published. Existing/seeded courses have
// no `published` field and are treated as published (so nothing disappears);
// newly created courses start as drafts until the designer publishes them.
function isPublished(c) { return c.published !== false; }
// Seeds run at startup AFTER cloud state is loaded (see the startup block), so
// existing courses in Firestore are never overwritten by the static seed.
function seedCourses() {
  const db = load();
  if (!db.courses || db.courses.length === 0) {
    db.courses = structuredClone(courseSeed);
    save();
  }
}

// Courses we've retired: remove them from the live store on boot so a formerly
// code-managed course that was later dropped doesn't linger (and can't be kept
// alive by re-seeding). To retire a course, add its id here.
const RETIRED_COURSE_IDS = ['ncsra-referee-2026-part-1'];
function removeRetiredCourses() {
  const db = load();
  const before = db.courses.length;
  db.courses = db.courses.filter((c) => !RETIRED_COURSE_IDS.includes(c.id));
  if (db.courses.length !== before) save();
}

// One-time launch finalization for the NCSRA referee recertification course, so
// the site is roll-out ready without manual clicks: (1) clean the URL slug (drop
// "regional"), (2) remove the per-module time gate, (3) apply NCSRA certificate
// branding. Guarded by a stored flag so it runs exactly once and never overrides
// a later manual edit. If the course isn't in the store yet, it retries next boot.
const REFEREE_FINALIZE_FLAG = 'referee-launch-finalize-v1';
function finalizeRefereeCourse() {
  const db = load();
  db.migrations = db.migrations || {};
  if (db.migrations[REFEREE_FINALIZE_FLAG]) return;
  const course = db.courses.find((c) => c.audience === 'referees' && /regional/i.test(c.id))
    || db.courses.find((c) => c.audience === 'referees' && (c.lessons || []).some((l) => l.type === 'scorm'));
  if (!course) return; // not uploaded yet — try again on the next boot (flag stays unset)

  // 1) URL slug → ncsra-referee-recertification (packages are untouched; remap
  //    enrollments/progress that key off the old id).
  const desiredId = 'ncsra-referee-recertification';
  if (course.id !== desiredId && !db.courses.some((c) => c.id === desiredId)) {
    const oldId = course.id;
    course.id = desiredId;
    for (const e of db.enrollments) if (e.courseId === oldId) e.courseId = desiredId;
    for (const p of db.lessonProgress) if (p.courseId === oldId) p.courseId = desiredId;
  }
  // 2) No time gate on any module.
  for (const l of (course.lessons || [])) if (l.type === 'scorm') l.minSeconds = 0;
  // 3) NCSRA certificate/branding — only fill blanks, never overwrite a manual value.
  const brand = {
    coBrandName: 'NCSRA Referee Education',
    coLogoUrl: '/media/ncsra-logo.png',
    certOrg: 'North Carolina Soccer Referee Association',
    certTitle: 'Certificate of Recertification Training',
    certPrefix: 'NCSRA',
  };
  for (const [k, v] of Object.entries(brand)) if (!course[k]) course[k] = v;

  db.migrations[REFEREE_FINALIZE_FLAG] = new Date().toISOString();
  save();
  console.log('[finalize] referee course finalized as', course.id);
}

// One-time: make sure the referee course TITLE has no "Regional" in it (the
// completion screen and certificate show the title). Runs once; only touches a
// title that still contains "regional", so a deliberate title is left alone.
const REFEREE_TITLE_FLAG = 'referee-title-fix-v1';
function fixRefereeTitle() {
  const db = load();
  db.migrations = db.migrations || {};
  if (db.migrations[REFEREE_TITLE_FLAG]) return;
  const course = db.courses.find((c) => c.audience === 'referees' && (c.lessons || []).some((l) => l.type === 'scorm'));
  if (!course) return; // try again next boot
  if (/regional/i.test(course.title || '')) course.title = 'NCSRA Referee Recertification';
  db.migrations[REFEREE_TITLE_FLAG] = new Date().toISOString();
  save();
  console.log('[finalize] referee title is now:', course.title);
}

// One-time: stamp the year on the referee certificate title so referees submit
// the correct course/year. Only sets it while the current value is blank or the
// prior default — a deliberate later edit is left alone.
const REFEREE_CERT_YEAR_FLAG = 'referee-cert-year-2027-v1';
function setRefereeCertYear() {
  const db = load();
  db.migrations = db.migrations || {};
  if (db.migrations[REFEREE_CERT_YEAR_FLAG]) return;
  const course = db.courses.find((c) => c.audience === 'referees' && (c.lessons || []).some((l) => l.type === 'scorm'));
  if (!course) return; // try again next boot
  const cur = (course.certTitle || '').trim();
  if (!cur || cur === 'Certificate of Recertification Training') {
    course.certTitle = '2027 Certificate of Recertification Training';
  }
  db.migrations[REFEREE_CERT_YEAR_FLAG] = new Date().toISOString();
  save();
  console.log('[finalize] referee certTitle is now:', course.certTitle);
}

// ---------- multi-organization support ----------
// Each course belongs to an organization (orgId). NCYSA/NCSRA is the default org
// ('ncysa'); a course with no orgId is treated as NCYSA, so existing NC courses,
// links, and records behave exactly as before. Additional orgs (e.g. OMG) get
// their own portal, branding, course, and separate learner records.
const DEFAULT_ORG = 'ncysa';
const ORGS = {
  ncysa: { slug: 'ncysa', name: 'NCYSA' },
  omg: { slug: 'omg', name: 'Officials Management Group' },
};
const orgOf = (c) => (c && c.orgId) || DEFAULT_ORG;

// One-time: give the OMG organization its own referee recertification course by
// cloning the NCSRA course's lessons (same uploaded module files — the lessons
// keep their packageId, so nothing is re-uploaded), with OMG branding and its
// own course id (so OMG's learner records are entirely separate from NC's).
const OMG_COURSE_FLAG = 'omg-referee-course-v1';
function setupOmgCourse() {
  const db = load();
  db.migrations = db.migrations || {};
  if (db.migrations[OMG_COURSE_FLAG]) return;
  const src = db.courses.find((c) => orgOf(c) === 'ncysa' && c.audience === 'referees' && (c.lessons || []).some((l) => l.type === 'scorm'));
  if (!src) return; // NC referee course not in the store yet — retry next boot
  if (!db.courses.some((c) => c.id === 'omg-referee-recertification')) {
    db.courses.push({
      id: 'omg-referee-recertification',
      orgId: 'omg',
      title: 'OMG Referee Recertification',
      tagline: src.tagline || 'US Soccer referee recertification for OMG officials.',
      description: src.description || '',
      badge: src.badge || 'Recertification',
      estMinutes: src.estMinutes || 60,
      heroEmoji: src.heroEmoji,
      audience: 'referees',
      published: true,
      coBrandName: 'OMG Referee Education',
      coLogoUrl: '/media/omg-logo.png',
      certOrg: 'Officials Management Group',
      certTitle: '2027 Certificate of Recertification Training',
      certPrefix: 'OMG',
      instructions: src.instructions || '',
      completionRedirectUrl: '',
      // Clone lessons with fresh ids but the SAME packageId → shared module files.
      lessons: (src.lessons || []).map((l) => ({ ...l, id: slugify(l.title) + '-' + crypto.randomBytes(3).toString('hex') })),
    });
    console.log('[org] created OMG referee course cloning', (src.lessons || []).length, 'lessons');
  }
  db.migrations[OMG_COURSE_FLAG] = new Date().toISOString();
  save();
}

// Add a specific course if it isn't already present, without touching the rest.
// Unlike seedCourses (which only runs on an empty DB), this lets us ship a new
// example course to an existing site.
//
// If the course already exists, backfill any top-level fields it's MISSING
// (e.g. branding or a completion redirect added after it was first seeded) —
// without overwriting values already set and without touching its lessons. This
// is how a course created on an earlier deploy picks up newly-added metadata.
function ensureCourse(courseObj) {
  const db = load();
  const existing = db.courses.find((c) => c.id === courseObj.id);
  if (!existing) {
    db.courses.push(structuredClone(courseObj));
    save();
    return;
  }
  // This is a fully code-managed pilot course: keep ALL of it (settings and
  // lessons) in sync with the source file on each deploy, so changes we make in
  // code reliably reach the live course. (Trade-off: editing it in the Course
  // Designer won't stick across deploys — manage this course's content in code.)
  let changed = false;
  for (const [k, v] of Object.entries(courseObj)) {
    if (JSON.stringify(existing[k]) !== JSON.stringify(v)) { existing[k] = structuredClone(v); changed = true; }
  }
  if (changed) save();
}

const app = express();
app.use(express.json());
// Always revalidate the app shell (HTML/JS/CSS) so a new deploy is picked up on
// the next page load instead of a stale cached copy lingering in the browser.
app.use((req, res, next) => {
  if (req.method === 'GET' && /(\/|\.html|\.js|\.css)$/.test(req.path)) {
    res.setHeader('Cache-Control', 'no-cache');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Where uploaded SCORM course packages live on disk. They must be served
// SAME-ORIGIN as the app (SCORM 1.2 discovers window.API by walking up the
// parent window, which the browser blocks cross-origin), so they're served
// through this app rather than a separate CDN. Default is a folder beside the
// data store; in production set SCORM_DIR to a PERSISTENT disk so uploads
// survive restarts/redeploys (a fresh container otherwise starts empty).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SCORM_DIR = process.env.SCORM_DIR || path.join(DATA_DIR, 'scorm');
const BUNDLED_SCORM_DIR = path.join(__dirname, 'public', 'scorm'); // e.g. the sample module

// Optional: offload module VIDEOS to a Bunny CDN (bunny.net) so they don't
// stream through this server. The SCORM shell (HTML/JS/images) stays same-origin
// — required for the window.parent.API discovery — while the heavy .mp4 files are
// pushed to Bunny at upload time and rewritten to the CDN URL at play time.
// Entirely OFF unless all four env vars are set, so nothing changes until Bunny
// is configured. Set in Render (BUNNY_STORAGE_KEY is a secret; never committed):
//   BUNNY_STORAGE_ZONE  e.g. ncysa-modules
//   BUNNY_STORAGE_HOST  region endpoint host, e.g. ny.storage.bunnycdn.com
//   BUNNY_STORAGE_KEY   the storage zone password (Access Key)
//   BUNNY_CDN_HOST      the pull-zone hostname, e.g. ncysa-modules.b-cdn.net
const BUNNY = {
  zone: process.env.BUNNY_STORAGE_ZONE || '',
  host: process.env.BUNNY_STORAGE_HOST || '',
  key: process.env.BUNNY_STORAGE_KEY || '',
  cdn: process.env.BUNNY_CDN_HOST || '',
};
function bunnyEnabled() { return !!(BUNNY.zone && BUNNY.host && BUNNY.key && BUNNY.cdn); }
async function bunnyPut(remotePath, buf) {
  const url = `https://${BUNNY.host.replace(/\/+$/, '')}/${BUNNY.zone}/${remotePath}`;
  const res = await fetch(url, { method: 'PUT', headers: { AccessKey: BUNNY.key, 'Content-Type': 'application/octet-stream' }, body: buf });
  if (!res.ok) throw new Error(`Bunny PUT ${res.status} for ${remotePath}`);
}
// Push a freshly-extracted package's videos to Bunny. All-or-nothing: only marks
// the package CDN-backed (and drops the local .mp4s) if EVERY video uploads;
// otherwise everything stays served from disk, unchanged.
async function offloadVideosToBunny(pkg, dest) {
  if (!bunnyEnabled()) return { cdn: false };
  const vids = [];
  (function walk(dir, rel) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name), r = rel ? rel + '/' + name : name;
      if (fs.statSync(full).isDirectory()) walk(full, r);
      else if (/\.mp4$/i.test(name)) vids.push({ full, rel: r });
    }
  })(dest, '');
  if (!vids.length) return { cdn: false };
  try {
    for (const v of vids) await bunnyPut(`${pkg}/${v.rel}`, fs.readFileSync(v.full));
  } catch (e) {
    return { cdn: false, error: e.message }; // keep everything local on any failure
  }
  for (const v of vids) { try { fs.rmSync(v.full, { force: true }); } catch { /* ignore */ } }
  fs.writeFileSync(path.join(dest, '.cdn'), `https://${BUNNY.cdn.replace(/\/+$/, '')}/${pkg}/`);
  return { cdn: true, count: vids.length };
}
// Rewrite relative video references (.mp4/.m4v/.webm/.mov) to the package's CDN
// base. Robust across how framework modules (Adapt/Evolve, iSpring, etc.) load
// video: it patches the media-element src setter AND Element.setAttribute, sweeps
// any <video>/<source> already in the page, and watches (MutationObserver) for
// ones added later — reloading the <video> when its source is rewritten. Runs
// before the module's own scripts so the video loads from Bunny, not from us.
function injectCdnShim(html, cdnBase) {
  const body = '(function(){var C=' + JSON.stringify(cdnBase) + ';' +
    'function fix(u){try{if(typeof u==="string"&&!/^https?:/i.test(u)&&/\\.(mp4|m4v|webm|mov)(\\?|$)/i.test(u))return C+u.replace(/^\\.?\\//,"");}catch(e){}return u;}' +
    'try{var p=HTMLMediaElement.prototype,d=Object.getOwnPropertyDescriptor(p,"src");if(d&&d.set)Object.defineProperty(p,"src",{configurable:true,get:function(){return d.get.call(this);},set:function(v){d.set.call(this,fix(v));}});}catch(e){}' +
    'try{var sa=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){try{if(n==="src"){var t=this.tagName;if(t==="SOURCE"||t==="VIDEO"||t==="AUDIO")v=fix(v);}}catch(e){}return sa.call(this,n,v);};}catch(e){}' +
    'function sweep(r){try{var e=r.querySelectorAll?r.querySelectorAll("video[src],source[src]"):[];for(var i=0;i<e.length;i++){var el=e[i],s=el.getAttribute("src"),f=fix(s);if(f!==s){el.setAttribute("src",f);var v=el.tagName==="SOURCE"?el.parentNode:el;if(v&&v.load){try{v.load();}catch(x){}}}}}catch(x){}}' +
    'try{new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var m=ms[i];if(m.type==="attributes")sweep(m.target.parentNode||document);if(m.addedNodes)for(var j=0;j<m.addedNodes.length;j++){var n=m.addedNodes[j];if(n.nodeType===1)sweep(n);}}}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["src"]});}catch(e){}' +
    'if(document.readyState!=="loading")sweep(document);else document.addEventListener("DOMContentLoaded",function(){sweep(document);});' +
    '})();';
  const shim = '<script>/* CDN video rewrite (HTMLMediaElement) */' + body + '</script>';
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + shim) : shim + html;
}

// Serve an uploaded package's files at /scorm/<packageId>/<path>, same-origin,
// with strict path containment. Falls back to the bundled samples in public/.
app.get('/scorm/:pkg/*', (req, res) => {
  const pkg = String(req.params.pkg).replace(/[^A-Za-z0-9._-]/g, '');
  let rel = String(req.params[0] || 'index.html').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel) rel = 'index.html';
  for (const root of [SCORM_DIR, BUNDLED_SCORM_DIR]) {
    const base = path.resolve(root, pkg); // absolute base so containment holds for relative SCORM_DIR
    const file = path.resolve(base, rel);
    if (file !== base && !file.startsWith(base + path.sep)) return res.status(400).end(); // traversal
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      // If this package's videos are on the CDN, inject the rewrite shim into the
      // launch HTML so the <video> loads from Bunny instead of from us.
      if (/\.html?$/i.test(rel) && fs.existsSync(path.join(base, '.cdn'))) {
        const cdnBase = fs.readFileSync(path.join(base, '.cdn'), 'utf8').trim();
        return res.type('html').send(injectCdnShim(fs.readFileSync(file, 'utf8'), cdnBase));
      }
      return res.sendFile(file);
    }
  }
  // The launch page missing usually means the package files aren't on disk
  // (e.g. uploaded to ephemeral storage, then lost on a redeploy). Show a clear
  // message inside the iframe instead of a blank black player, so it's obvious
  // the module needs re-uploading rather than looking like a broken video.
  if (/\.html?$/.test(rel)) {
    return res.status(404).type('html').send(
      '<!doctype html><meta charset="utf-8"><body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0e1726;color:#eef3fa;font-family:system-ui,Arial,sans-serif;text-align:center;padding:24px">' +
      '<div><h2 style="margin:0 0 8px">This module’s files aren’t available</h2>' +
      '<p style="color:#9fb4d6;max-width:420px">The course package isn’t on the server. An administrator needs to re-upload this module in the Course Designer (make sure the persistent disk is attached first).</p></div></body>'
    );
  }
  res.status(404).end();
});

// ---------- auth helpers ----------

// Staff accounts are password-protected (learners remain passwordless).
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

// Resolve a seeded account's password WITHOUT baking a usable secret into the
// production build. In production the env var is required; if it's missing we
// fall back to a random, unguessable value (so no known default password is
// ever live) and warn. Locally/tests we use a friendly default for convenience.
function seedPassword(envVar, devDefault) {
  if (process.env[envVar]) return process.env[envVar];
  if (process.env.NODE_ENV === 'production') {
    console.warn(`[auth] ${envVar} is not set — that account is locked with a random password until you set it.`);
    return crypto.randomBytes(24).toString('hex');
  }
  return devDefault; // local/demo/test only
}

// ---------- staff-area access code ----------
// The Staff Portal (onboarding + policy trainings) is gated by a shared access
// code so only staff/board/volunteers can see or take those courses — even
// though the page URL isn't advertised. Set STAFF_ACCESS_CODE in the environment;
// without it, only signed-in staff/admins can reach the area. A correct code
// sets a signed, unforgeable cookie (HMAC of the code) that grants access.
const STAFF_ACCESS_CODE = seedPassword('STAFF_ACCESS_CODE', 'ncysa-staff-2026');
function staffCookieValue() {
  return crypto.createHmac('sha256', String(STAFF_ACCESS_CODE)).update('staff-portal-v1').digest('hex');
}
function staffAuthorized(req) {
  const user = currentUser(req);
  if (user && STAFF_ROLES.includes(user.role)) return true; // admins/designers always in
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)staff_access=([a-f0-9]+)/);
  return !!(m && m[1] === staffCookieValue());
}

function setSession(res, userId) {
  const db = load();
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = userId;
  save();
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`);
}

function currentUser(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)session=([a-f0-9]+)/);
  if (!m) return null;
  const db = load();
  const userId = db.sessions[m[1]];
  return db.users.find((u) => u.id === userId) || null;
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'NCYSA staff only' });
    next();
  });
}

// Course designers (collaborators) and admins can edit the course catalog.
// Collaborators do NOT get the completion dashboard or learner records.
const STAFF_ROLES = ['admin', 'editor'];
function requireEditor(req, res, next) {
  requireAuth(req, res, () => {
    if (!STAFF_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Course designers only' });
    next();
  });
}

// Seed the NCYSA admin account. Staff sign-in requires a password so random
// visitors can't reach the dashboard just by typing the admin email. Set a
// strong ADMIN_PASSWORD in production; the default exists only for local/demo.
// The platform owner's personal admin login (separate from the shared NCYSA
// staff account and from Colin's designer account). Change OWNER_EMAIL /
// OWNER_PASSWORD in the environment for production.
const OWNER_EMAIL = (process.env.OWNER_EMAIL || 'jeremy.layton.brown.smith@gmail.com').toLowerCase();

const MANAGER_EMAIL = (process.env.EDITOR_EMAIL || 'DA@ncsoccer.org').toLowerCase(); // Colin

function seedAdmin() {
  const db = load();
  const email = process.env.ADMIN_EMAIL || 'admin@ncysa.org';
  const password = seedPassword('ADMIN_PASSWORD', 'ncysa-staff-2026');
  // Match the shared staff admin by role, but never the named personal admins
  // (owner or manager) — those are managed by their own seeds below.
  const reserved = new Set([OWNER_EMAIL, MANAGER_EMAIL]);
  const existing = db.users.find((u) => u.role === 'admin' && !reserved.has(u.email.toLowerCase()));
  const salt = existing?.salt || crypto.randomBytes(8).toString('hex');
  const passHash = hashPassword(password, salt);
  if (!existing) {
    db.users.push({
      id: id('usr'), name: 'NCYSA Education Staff', email,
      role: 'admin', salt, passHash, createdAt: new Date().toISOString(),
    });
    save();
  } else if (existing.passHash !== passHash || existing.email !== email) {
    // Keep the seeded admin in sync with the configured credentials.
    existing.email = email; existing.salt = salt; existing.passHash = passHash;
    save();
  }
}

// Seed the course manager (Colin) — a full admin: builds courses AND can view
// and download the learner completion records/export, same as the owner.
function seedEditor() {
  const db = load();
  const email = process.env.EDITOR_EMAIL || 'DA@ncsoccer.org';
  const password = seedPassword('EDITOR_PASSWORD', 'ncysa-designer-2026');
  const existing = db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  const salt = existing?.salt || crypto.randomBytes(8).toString('hex');
  const passHash = hashPassword(password, salt);
  if (!existing) {
    db.users.push({
      id: id('usr'), name: 'Course Manager', email,
      role: 'admin', salt, passHash, createdAt: new Date().toISOString(),
    });
    save();
  } else if (existing.role !== 'admin' || existing.passHash !== passHash) {
    existing.role = 'admin'; existing.salt = salt; existing.passHash = passHash;
    save();
  }
}

// Seed the owner's personal admin login (Jeremy) — full access: build courses
// AND the completion dashboard/export, separate from Colin's designer account.
function seedOwner() {
  const db = load();
  const password = seedPassword('OWNER_PASSWORD', 'ncysa-admin-2026');
  const existing = db.users.find((u) => u.email.toLowerCase() === OWNER_EMAIL);
  const salt = existing?.salt || crypto.randomBytes(8).toString('hex');
  const passHash = hashPassword(password, salt);
  if (!existing) {
    db.users.push({
      id: id('usr'), name: 'Jeremy Layton-Brown-Smith',
      email: process.env.OWNER_EMAIL || 'jeremy.layton.brown.smith@gmail.com',
      role: 'admin', salt, passHash, createdAt: new Date().toISOString(),
    });
    save();
  } else if (existing.role !== 'admin' || existing.passHash !== passHash) {
    existing.role = 'admin'; existing.salt = salt; existing.passHash = passHash;
    save();
  }
}

// ---------- course helpers ----------

// Public view of a course: strips quiz answers so they never reach the client.
function publicCourse(course) {
  return {
    ...course,
    lessons: course.lessons.map((l) =>
      l.type === 'quiz'
        ? { ...l, questions: l.questions.map(({ answer, ...q }) => q) }
        : l
    ),
  };
}

function getProgress(db, userId, courseId) {
  return db.lessonProgress.filter((p) => p.userId === userId && p.courseId === courseId);
}

function lessonState(course, progress, lessonId) {
  const idx = course.lessons.findIndex((l) => l.id === lessonId);
  const done = (lid) => progress.some((p) => p.lessonId === lid && p.completed);
  const unlocked = course.lessons.slice(0, idx).every((l) => done(l.id));
  return { idx, unlocked, completed: done(lessonId) };
}

function progressSummary(course, progress) {
  const done = course.lessons.filter((l) =>
    progress.some((p) => p.lessonId === l.id && p.completed)
  ).length;
  return {
    completedLessons: done,
    totalLessons: course.lessons.length,
    percent: course.lessons.length ? Math.round((done / course.lessons.length) * 100) : 0,
    lessons: course.lessons.map((l) => {
      const st = lessonState(course, progress, l.id);
      const rec = progress.find((p) => p.lessonId === l.id);
      return {
        id: l.id,
        completed: st.completed,
        unlocked: st.unlocked,
        watchedSeconds: rec?.watchedSeconds || 0,
        quizScore: rec?.quizScore ?? null,
        scorm: rec?.scorm || null,
      };
    }),
  };
}

// ---------- auth API ----------

// Passwordless sign-up for the demo: name + email only, no password to create
// or remember. (For production, add real auth — a password or an emailed
// magic-link — before storing real learner records.)
app.post('/api/register', (req, res) => {
  const b = req.body || {};
  const firstName = String(b.firstName || '').trim();
  const lastName = String(b.lastName || '').trim();
  const email = String(b.email || '').trim();
  // Compose a display name from first + last; fall back to a single `name` field.
  const name = (firstName || lastName) ? `${firstName} ${lastName}`.trim() : String(b.name || '').trim();
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
  const db = load();
  const existing = db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    // A password-protected (staff/admin) account must NEVER be signed in just by
    // typing its email here — that would bypass the password. Send them to the
    // staff sign-in. Passwordless learners keep the friendly "email signs you
    // back in" behavior.
    if (existing.passHash || STAFF_ROLES.includes(existing.role)) {
      return res.status(403).json({ error: 'That email has a staff account — please use the staff sign-in with your password.', needsPassword: true });
    }
    setSession(res, existing.id);
    return res.json({ user: { id: existing.id, name: existing.name, email: existing.email, role: existing.role } });
  }
  const user = {
    id: id('usr'), name,
    firstName: firstName || undefined, lastName: lastName || undefined,
    email, role: 'learner', createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  save();
  setSession(res, user.id);
  res.json({ user: { id: user.id, name, email, role: user.role } });
});

// Sign-in. Learners are passwordless (email only). Staff/admin accounts
// require the correct password, so only authorized staff reach the dashboard.
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const db = load();
  const user = db.users.find((u) => u.email.toLowerCase() === String(email || '').toLowerCase());
  if (!user)
    return res.status(401).json({ error: 'No account with that email yet — use “Get started” to create one.' });
  if (STAFF_ROLES.includes(user.role)) {
    if (!password || !user.passHash || hashPassword(password, user.salt) !== user.passHash)
      return res.status(401).json({ error: 'Incorrect password.', needsPassword: true });
  }
  setSession(res, user.id);
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.post('/api/logout', (req, res) => {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)session=([a-f0-9]+)/);
  if (m) { const db = load(); delete db.sessions[m[1]]; save(); }
  res.setHeader('Set-Cookie', 'session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  const staffAccess = staffAuthorized(req);
  if (!user) return res.json({ user: null, staffAccess });
  const db = load();
  const unread = db.notifications.filter(
    (n) => n.audience === 'user' && n.userId === user.id && !n.read
  ).length;
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role }, unread, staffAccess });
});

// Unlock the staff area with the shared access code (sets a signed cookie).
app.post('/api/staff-access', (req, res) => {
  const code = String((req.body && req.body.code) || '');
  if (!code || code !== String(STAFF_ACCESS_CODE)) return res.status(403).json({ error: 'That staff access code isn’t right.' });
  res.setHeader('Set-Cookie', `staff_access=${staffCookieValue()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`);
  res.json({ ok: true });
});

// ---------- catalog & enrollment ----------

app.get('/api/courses', (req, res) => {
  const user = currentUser(req);
  const isStaff = !!user && STAFF_ROLES.includes(user.role);
  const staffOK = staffAuthorized(req);
  // Organization scope: a portal passes ?org=<slug> to see only that org's
  // courses. With no org param, all orgs are returned (the admin course designer
  // relies on this). A course with no orgId counts as the default org.
  const org = req.query.org ? String(req.query.org) : null;
  const db = load();
  res.json({
    // Staff-audience trainings are hidden from everyone who hasn't unlocked the
    // staff area with the access code (admins are always authorized).
    courses: allCourses().filter((c) => isStaff || isPublished(c))
      .filter((c) => c.audience !== 'staff' || staffOK)
      .filter((c) => !org || orgOf(c) === org)
      .map((c) => {
      const enr = user && db.enrollments.find((e) => e.userId === user.id && e.courseId === c.id);
      const prog = user ? progressSummary(c, getProgress(db, user.id, c.id)) : null;
      return {
        id: c.id, title: c.title, tagline: c.tagline, description: c.description,
        badge: c.badge, estMinutes: c.estMinutes, heroEmoji: c.heroEmoji,
        audience: c.audience || 'everyone',
        orgId: orgOf(c),
        coBrandName: c.coBrandName || null,
        coLogoUrl: c.coLogoUrl || null,
        publicVideoGate: !!c.publicVideoGate,
        published: isPublished(c),
        lessonCount: c.lessons.length,
        enrolled: !!enr, completedAt: enr?.completedAt || null, certId: enr?.certId || null,
        percent: prog?.percent ?? 0,
      };
    }),
  });
});

app.post('/api/courses/:courseId/enroll', requireAuth, (req, res) => {
  const course = allCourses().find((c) => c.id === req.params.courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  if (!isPublished(course) && !STAFF_ROLES.includes(req.user.role)) return res.status(404).json({ error: 'Course not found' });
  if (course.audience === 'staff' && !staffAuthorized(req)) return res.status(403).json({ error: 'This is a staff training — unlock the staff area with the access code first.', needsStaffCode: true });
  const db = load();
  if (!db.enrollments.some((e) => e.userId === req.user.id && e.courseId === course.id)) {
    db.enrollments.push({
      userId: req.user.id, courseId: course.id,
      startedAt: new Date().toISOString(), completedAt: null, certId: null,
    });
    save();
  }
  res.json({ ok: true });
});

app.get('/api/courses/:courseId', requireAuth, (req, res) => {
  const course = allCourses().find((c) => c.id === req.params.courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  if (!isPublished(course) && !STAFF_ROLES.includes(req.user.role)) return res.status(404).json({ error: 'Course not found' });
  if (course.audience === 'staff' && !staffAuthorized(req)) return res.status(403).json({ error: 'This is a staff training — unlock the staff area with the access code first.', needsStaffCode: true });
  const db = load();
  const enr = db.enrollments.find((e) => e.userId === req.user.id && e.courseId === course.id);
  if (!enr) return res.status(403).json({ error: 'Enroll in this course first' });
  res.json({
    course: publicCourse(course),
    progress: progressSummary(course, getProgress(db, req.user.id, course.id)),
    enrollment: enr,
  });
});

// Public "watch & redirect" — NO login. Serves a published course's video plus
// its redirect (e.g. a Brainshark comprehension test) for a no-account flow,
// where another system (Brainshark → Arbiter) owns the test and the credit.
// Gated on the course opting in via `publicVideoGate` so ordinary courses are
// never exposed without login.
app.get('/api/watch/:courseId', (req, res) => {
  const course = allCourses().find((c) => c.id === req.params.courseId);
  if (!course || !isPublished(course) || !course.publicVideoGate) return res.status(404).json({ error: 'Not available' });
  const v = course.lessons.find((l) => l.type === 'video');
  if (!v) return res.status(404).json({ error: 'This course has no video' });
  res.json({
    title: course.title,
    coBrandName: course.coBrandName || null,
    coLogoUrl: course.coLogoUrl || null,
    redirectUrl: course.completionRedirectUrl || null,
    video: {
      videoUrl: v.videoUrl,
      videoUrlWebm: v.videoUrlWebm || null,
      durationSeconds: videoDuration(v),
    },
  });
});

// ---------- lesson progression (the gate) ----------

function findLesson(req, res) {
  const course = allCourses().find((c) => c.id === req.params.courseId);
  const lesson = course?.lessons.find((l) => l.id === req.params.lessonId);
  if (!course || !lesson) { res.status(404).json({ error: 'Lesson not found' }); return null; }
  const db = load();
  if (!db.enrollments.some((e) => e.userId === req.user.id && e.courseId === course.id)) {
    res.status(403).json({ error: 'Enroll in this course first' });
    return null;
  }
  return { course, lesson, db };
}

function upsertProgress(db, userId, courseId, lessonId) {
  let rec = db.lessonProgress.find(
    (p) => p.userId === userId && p.courseId === courseId && p.lessonId === lessonId
  );
  if (!rec) {
    rec = { userId, courseId, lessonId, watchedSeconds: 0, completed: false, completedAt: null, quizScore: null };
    db.lessonProgress.push(rec);
  }
  return rec;
}

// Video heartbeat. The player reports `position` — the furthest point it has
// reached through real playback. The server credits watch time up to that point
// but never lets it jump more than WATCH_STEP_CAP seconds in a single call, so a
// forged request still can't skip the whole video (it would take many calls over
// real time). Legacy `secondsWatched` (a delta) is still accepted for safety.
const WATCH_STEP_CAP = 30;
const WATCH_PCT = 0.97; // fraction of the real video that must be watched
const SCORM_STEP_CAP = 15; // max seconds of module time credited per heartbeat
const DEFAULT_SCORM_MIN_SECONDS = 0; // no time gate by default — the module's own "complete every element" requirement is the anti-skip

// The trustworthy length of a video lesson: the real duration observed from the
// player once known, otherwise the (possibly approximate) configured value. This
// lets a course designer paste a video without knowing its exact length — the
// watch requirement snaps to the actual video, so no one is ever stranded short.
function videoDuration(lesson) {
  const obs = Number(lesson.observedDuration);
  if (Number.isFinite(obs) && obs > 0) return obs;
  return Math.max(1, Number(lesson.durationSeconds) || 60);
}
function videoRequired(lesson) {
  const obs = Number(lesson.observedDuration);
  if (Number.isFinite(obs) && obs > 0) return Math.max(1, Math.floor(obs * WATCH_PCT));
  // No real duration observed yet: fall back to the configured minimum (used only
  // for the very first frames before the player reports the true length).
  const cfg = Number(lesson.minWatchSeconds);
  return Number.isFinite(cfg) && cfg > 0 ? cfg : Math.max(1, Math.floor(videoDuration(lesson) * WATCH_PCT));
}

app.post('/api/courses/:courseId/lessons/:lessonId/watch', requireAuth, (req, res) => {
  const found = findLesson(req, res);
  if (!found) return;
  const { course, lesson, db } = found;
  if (lesson.type !== 'video') return res.status(400).json({ error: 'Not a video lesson' });
  const st = lessonState(course, getProgress(db, req.user.id, course.id), lesson.id);
  if (!st.unlocked) return res.status(403).json({ error: 'This lesson is locked. Complete the previous lessons first.' });

  // Learn the real video length from the player (take the max ever reported, so a
  // forged short duration can't lower the requirement).
  const reported = Number(req.body?.duration);
  if (Number.isFinite(reported) && reported > 0 && reported < 21600) {
    if (reported > (Number(lesson.observedDuration) || 0)) lesson.observedDuration = reported;
  }
  const cap = videoDuration(lesson);
  const required = videoRequired(lesson);

  const rec = upsertProgress(db, req.user.id, course.id, lesson.id);
  const position = Number(req.body?.position);
  if (Number.isFinite(position)) {
    rec.watchedSeconds = Math.min(cap, Math.max(rec.watchedSeconds, Math.min(position, rec.watchedSeconds + WATCH_STEP_CAP)));
  } else {
    const delta = Number(req.body?.secondsWatched) || 0;
    rec.watchedSeconds = Math.min(cap, rec.watchedSeconds + Math.max(0, Math.min(delta, WATCH_STEP_CAP)));
  }
  save();
  res.json({
    watchedSeconds: rec.watchedSeconds,
    required,
    duration: cap,
    satisfied: rec.watchedSeconds >= required,
  });
});

// Quiz submission: graded server-side (answers never leave the server).
app.post('/api/courses/:courseId/lessons/:lessonId/quiz', requireAuth, async (req, res) => {
  const found = findLesson(req, res);
  if (!found) return;
  const { course, lesson, db } = found;
  if (lesson.type !== 'quiz') return res.status(400).json({ error: 'Not a quiz lesson' });
  const st = lessonState(course, getProgress(db, req.user.id, course.id), lesson.id);
  if (!st.unlocked) return res.status(403).json({ error: 'This lesson is locked. Complete the previous lessons first.' });

  const answers = req.body?.answers || {};
  const correct = lesson.questions.filter((q) => Number(answers[q.id]) === q.answer).length;
  const score = Math.round((correct / lesson.questions.length) * 100);
  const passed = score >= lesson.passPercent;

  const rec = upsertProgress(db, req.user.id, course.id, lesson.id);
  rec.quizScore = score;
  if (passed && !rec.completed) {
    rec.completed = true;
    rec.completedAt = new Date().toISOString();
  }
  save();
  const completion = passed ? await maybeCompleteCourse(req.user, course) : null;
  res.json({ score, passed, passPercent: lesson.passPercent, correct, total: lesson.questions.length, courseCompleted: !!completion, certId: completion?.certId || null });
});

// Generic completion for text/video lessons.
app.post('/api/courses/:courseId/lessons/:lessonId/complete', requireAuth, async (req, res) => {
  const found = findLesson(req, res);
  if (!found) return;
  const { course, lesson, db } = found;
  const progress = getProgress(db, req.user.id, course.id);
  const st = lessonState(course, progress, lesson.id);

  if (!st.unlocked)
    return res.status(403).json({ error: 'This lesson is locked. Complete the previous lessons first.' });
  if (lesson.type === 'quiz')
    return res.status(400).json({ error: 'The exam must be submitted and passed, not marked complete.' });

  const rec = upsertProgress(db, req.user.id, course.id, lesson.id);
  if (lesson.type === 'video') {
    const required = videoRequired(lesson);
    if (rec.watchedSeconds < required) {
      return res.status(403).json({
        error: `You must watch at least ${required} seconds of this video to continue. ` +
               `Watched so far: ${Math.floor(rec.watchedSeconds)}s.`,
        watchedSeconds: rec.watchedSeconds,
        required,
      });
    }
  }

  if (!rec.completed) {
    rec.completed = true;
    rec.completedAt = new Date().toISOString();
    save();
  }
  const completion = await maybeCompleteCourse(req.user, course);
  res.json({ ok: true, courseCompleted: !!completion, certId: completion?.certId || null });
});

// SCORM 1.2 runtime callback. The in-page window.API (public/app.js) relays the
// module's cmi values here. These modules complete on reaching the final slide,
// which the package reports as cmi.core.lesson_status = "completed"; we record
// that against the enrolled referee. lesson_location / suspend_data are stored so
// a learner resumes where they left off. No score to grade — completion is the
// signal that feeds the dashboard export.
app.post('/api/courses/:courseId/lessons/:lessonId/scorm', requireAuth, async (req, res) => {
  const found = findLesson(req, res);
  if (!found) return;
  const { course, lesson, db } = found;
  if (lesson.type !== 'scorm') return res.status(400).json({ error: 'Not a SCORM module' });
  const progress = getProgress(db, req.user.id, course.id);
  const st = lessonState(course, progress, lesson.id);
  if (!st.unlocked)
    return res.status(403).json({ error: 'This module is locked. Complete the previous modules first.' });

  const b = req.body || {};
  const rec = upsertProgress(db, req.user.id, course.id, lesson.id);
  rec.scorm = rec.scorm || { status: 'not attempted', location: '', suspendData: '', activeSeconds: 0 };
  if (typeof rec.scorm.activeSeconds !== 'number') rec.scorm.activeSeconds = 0;

  // Reset an in-progress module (e.g. the learner was away from the tab too
  // long). Never un-completes a module already finished.
  if (b.reset && !rec.completed) {
    rec.scorm = { status: 'incomplete', location: '', suspendData: '', activeSeconds: 0 };
    save();
    return res.json({ ok: true, reset: true, status: 'incomplete', activeSeconds: 0, required: lesson.minSeconds != null ? Math.max(0, Number(lesson.minSeconds) || 0) : DEFAULT_SCORM_MIN_SECONDS, remaining: null, reachedEnd: false, completed: false, courseCompleted: false, certId: null });
  }
  // Accrue time spent in the module. The client sends small deltas on a heartbeat;
  // each is capped so accrued time can't be jumped ahead in a single forged call —
  // real time must actually pass (same anti-skip principle as the video gate).
  const delta = Math.max(0, Math.min(SCORM_STEP_CAP, Number(b.activeDelta) || 0));
  rec.scorm.activeSeconds += delta;
  if (typeof b.status === 'string' && b.status) rec.scorm.status = b.status;
  if (b.location != null) rec.scorm.location = String(b.location).slice(0, 4096);
  if (b.suspendData != null) rec.scorm.suspendData = String(b.suspendData).slice(0, 4096);

  // Minimum time before completion counts. Modules uploaded before this gate
  // existed have no minSeconds field, so they fall back to the default (rather
  // than 0 = no gate) — the anti-skip protection applies without re-uploading.
  const required = lesson.minSeconds != null ? Math.max(0, Number(lesson.minSeconds) || 0) : DEFAULT_SCORM_MIN_SECONDS;
  const timeMet = rec.scorm.activeSeconds >= required;
  const reachedEnd = rec.scorm.status === 'completed' || rec.scorm.status === 'passed';
  let newlyCompleted = false;
  if (reachedEnd && timeMet && !rec.completed) {
    rec.completed = true;
    rec.completedAt = new Date().toISOString();
    newlyCompleted = true;
  }
  save();
  const completion = newlyCompleted ? await maybeCompleteCourse(req.user, course) : null;
  res.json({
    ok: true, status: rec.scorm.status, completed: rec.completed,
    activeSeconds: Math.floor(rec.scorm.activeSeconds), required,
    remaining: Math.max(0, required - Math.floor(rec.scorm.activeSeconds)),
    reachedEnd,
    courseCompleted: !!completion, certId: completion?.certId || null,
  });
});

// When every lesson is done: complete the course, mint a certificate,
// notify the learner and NCYSA.
async function maybeCompleteCourse(user, course) {
  const db = load();
  const enr = db.enrollments.find((e) => e.userId === user.id && e.courseId === course.id);
  if (!enr || enr.completedAt) return null;
  const progress = getProgress(db, user.id, course.id);
  const allDone = course.lessons.length > 0 && course.lessons.every((l) => progress.some((p) => p.lessonId === l.id && p.completed));
  if (!allDone) return null;

  enr.completedAt = new Date().toISOString();
  const prefix = (course.certPrefix || 'NCYSA').replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'NCYSA';
  enr.certId = `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  save();

  const quiz = progress.find((p) => p.quizScore != null);
  await onCourseCompleted({ user, course, certId: enr.certId, score: quiz?.quizScore ?? null });
  return enr;
}

// ---------- notifications & certificate ----------

app.get('/api/notifications', requireAuth, (req, res) => {
  const db = load();
  res.json({
    notifications: db.notifications
      .filter((n) => n.audience === 'user' && n.userId === req.user.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  });
});

app.post('/api/notifications/read', requireAuth, (req, res) => {
  const db = load();
  db.notifications.forEach((n) => {
    if (n.audience === 'user' && n.userId === req.user.id) n.read = true;
  });
  save();
  res.json({ ok: true });
});

// Public, read-only: a certificate is meant to be shown and verified, so it can
// be viewed by anyone holding its (random, unguessable) ID — this is what makes
// the link emailed to the learner openable without signing in. Only the
// non-sensitive fields are returned (name, course, date — never the email).
app.get('/api/certificate/:certId', (req, res) => {
  const db = load();
  const enr = db.enrollments.find((e) => e.certId === req.params.certId && e.completedAt);
  if (!enr) return res.status(404).json({ error: 'Certificate not found' });
  const user = db.users.find((u) => u.id === enr.userId);
  const course = allCourses().find((c) => c.id === enr.courseId);
  res.json({
    certId: enr.certId, learner: user?.name || 'NCYSA Learner',
    course: course?.title || 'NCYSA Course', completedAt: enr.completedAt,
    // Per-course certificate branding (e.g. an NCSRA course issues an NCSRA cert).
    org: course?.certOrg || null,
    certTitle: course?.certTitle || null,
    logoUrl: course?.coLogoUrl || null,
  });
});

// ---------- NCYSA admin ----------

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const db = load();
  res.json({
    completions: db.enrollments
      .filter((e) => e.completedAt)
      .map((e) => {
        const u = db.users.find((u) => u.id === e.userId);
        return {
          learner: u?.name,
          firstName: u?.firstName || '',
          lastName: u?.lastName || '',
          email: u?.email,
          course: allCourses().find((c) => c.id === e.courseId)?.title,
          completedAt: e.completedAt,
          certId: e.certId,
        };
      })
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt)),
    // Every enrollment with its module progress — so the dashboard can show and
    // export in-progress referees (X of N modules), not just finished ones.
    // This is what the Arbiter hand-off is built from.
    enrollments: db.enrollments.map((e) => {
      const u = db.users.find((x) => x.id === e.userId);
      const course = allCourses().find((c) => c.id === e.courseId);
      const total = course ? course.lessons.length : 0;
      const prog = course ? getProgress(db, e.userId, e.courseId) : [];
      const doneCount = course ? course.lessons.filter((l) => prog.some((p) => p.lessonId === l.id && p.completed)).length : 0;
      return {
        userId: e.userId,
        learner: u?.name, firstName: u?.firstName || '', lastName: u?.lastName || '',
        email: u?.email, course: course?.title, courseId: e.courseId,
        modulesComplete: doneCount, totalModules: total,
        completedAt: e.completedAt || null, certId: e.certId || null,
        startedAt: e.startedAt || null,
      };
    }).sort((a, b) => String(b.completedAt || b.startedAt || '').localeCompare(String(a.completedAt || a.startedAt || ''))),
    ncysaNotifications: db.notifications
      .filter((n) => n.audience === 'ncysa')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    outbox: db.outbox.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    learnerCount: db.users.filter((u) => u.role === 'learner').length,
  });
});

// Delete a learner's record for a course — for clearing out test data before
// launch. Removes the enrollment, its lesson progress, and any completion
// notifications for it. If the learner is a plain (passwordless) learner with no
// other enrollments left, the account is removed too. Staff/admin accounts are
// NEVER deleted (only their enrollment is), so the owner and staff logins survive.
app.delete('/api/admin/enrollments', requireAdmin, (req, res) => {
  const userId = String(req.body?.userId || '');
  const courseId = String(req.body?.courseId || '');
  if (!userId || !courseId) return res.status(400).json({ error: 'userId and courseId are required.' });
  const db = load();
  const gone = db.enrollments.filter((e) => e.userId === userId && e.courseId === courseId);
  if (!gone.length) return res.status(404).json({ error: 'No matching record.' });
  const certIds = gone.map((e) => e.certId).filter(Boolean);
  db.enrollments = db.enrollments.filter((e) => !(e.userId === userId && e.courseId === courseId));
  db.lessonProgress = db.lessonProgress.filter((p) => !(p.userId === userId && p.courseId === courseId));
  // Drop the completion notifications for this record (they carry the cert id).
  db.notifications = db.notifications.filter((n) => !(certIds.some((cid) => String(n.body || '').includes(cid))));
  // If it was a throwaway learner with nothing else, remove the account entirely.
  const user = db.users.find((u) => u.id === userId);
  let removedAccount = false;
  if (user && user.role === 'learner' && !db.enrollments.some((e) => e.userId === userId)) {
    db.users = db.users.filter((u) => u.id !== userId);
    for (const tok of Object.keys(db.sessions)) if (db.sessions[tok] === userId) delete db.sessions[tok];
    removedAccount = true;
  }
  save();
  res.json({ ok: true, removedEnrollments: gone.length, removedAccount });
});

// Send a test email so staff can verify mail delivery is configured correctly.
app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  const to = String(req.body?.to || '').trim() || req.user.email;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'Enter a valid email address.' });
  try {
    const status = await sendTestEmail(to);
    res.json({ to, status, delivered: /delivered/.test(status) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- admin course editor (create/edit courses & lessons, no code) ----

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'course';
}

// Normalize a lesson payload from the editor into a stored lesson.
function buildLesson(body) {
  const type = ['text', 'video', 'quiz', 'scorm'].includes(body.type) ? body.type : 'text';
  const base = { id: body.id || slugify(body.title) + '-' + crypto.randomBytes(3).toString('hex'), type, title: String(body.title || 'Untitled lesson') };
  if (type === 'text') return { ...base, html: String(body.html || '') };
  if (type === 'video') {
    const duration = Math.max(1, Number(body.durationSeconds) || 60);
    return {
      ...base, html: String(body.html || ''),
      videoUrl: String(body.videoUrl || ''),
      videoUrlWebm: body.videoUrlWebm ? String(body.videoUrlWebm) : undefined,
      durationSeconds: duration,
      minWatchSeconds: Math.min(duration, Math.max(1, Number(body.minWatchSeconds) || Math.max(1, duration - 2))),
    };
  }
  if (type === 'scorm') {
    // A SCORM module: a self-contained package served same-origin under
    // /scorm/<packageId>/. packageId is the folder; launchFile is its entry
    // page. Completion is recorded when the module reports lesson_status
    // "completed" (see the /scorm endpoint below). Sanitize both so a stored
    // lesson can never point outside its package folder.
    const packageId = String(body.packageId || '').replace(/[^A-Za-z0-9._-]/g, '');
    const launchFile = (String(body.launchFile || 'index.html').replace(/[^A-Za-z0-9._/-]/g, '').replace(/\.\.+/g, '') || 'index.html');
    // Minimum time (seconds) a learner must spend in the module before its
    // completion is accepted — the anti-skip gate. Set via "minMinutes" in the
    // Course Designer; minMinutes:0 disables the gate. Defaults when unspecified.
    let minSeconds;
    if (body.minMinutes != null) minSeconds = Math.max(0, Math.round(Number(body.minMinutes) * 60)) || 0;
    else if (body.minSeconds != null) minSeconds = Math.max(0, Math.round(Number(body.minSeconds))) || 0;
    else minSeconds = DEFAULT_SCORM_MIN_SECONDS;
    return { ...base, html: String(body.html || ''), packageId, launchFile, minSeconds };
  }
  // quiz
  const questions = (Array.isArray(body.questions) ? body.questions : []).map((q, i) => ({
    id: q.id || 'q' + (i + 1),
    prompt: String(q.prompt || ''),
    options: (Array.isArray(q.options) ? q.options : []).map(String).filter(Boolean),
    answer: Number(q.answer) || 0,
  })).filter((q) => q.prompt && q.options.length >= 2);
  return { ...base, html: String(body.html || ''), passPercent: Math.min(100, Math.max(0, Number(body.passPercent) || 80)), questions };
}

app.post('/api/admin/courses', requireEditor, (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'Course title is required' });
  const db = load();
  const course = {
    id: slugify(b.title) + '-' + crypto.randomBytes(3).toString('hex'),
    title: String(b.title),
    tagline: String(b.tagline || ''),
    description: String(b.description || ''),
    badge: String(b.badge || 'Course'),
    audience: ['everyone', 'coaches', 'referees', 'staff'].includes(b.audience) ? b.audience : 'everyone',
    estMinutes: Math.max(1, Number(b.estMinutes) || 30),
    heroEmoji: String(b.heroEmoji || '⚽'),
    completionRedirectUrl: String(b.completionRedirectUrl || ''),
    publicVideoGate: !!b.publicVideoGate,
    published: false, // start as a draft; the designer publishes when ready
    lessons: [],
  };
  db.courses.push(course);
  save();
  res.json({ course });
});

// Publish or unpublish a course (show/hide it from learners).
app.post('/api/admin/courses/:courseId/publish', requireEditor, (req, res) => {
  const db = load();
  const course = db.courses.find((c) => c.id === req.params.courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  course.published = !!(req.body && req.body.published);
  save();
  res.json({ id: course.id, published: course.published });
});

// Reorder a lesson within its course (move up or down one place).
app.post('/api/admin/courses/:courseId/lessons/:lessonId/move', requireEditor, (req, res) => {
  const db = load();
  const course = db.courses.find((c) => c.id === req.params.courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const i = course.lessons.findIndex((l) => l.id === req.params.lessonId);
  if (i < 0) return res.status(404).json({ error: 'Lesson not found' });
  const j = i + ((req.body && req.body.dir) === 'up' ? -1 : 1);
  if (j < 0 || j >= course.lessons.length) return res.json({ ok: true }); // already at an end
  const [l] = course.lessons.splice(i, 1);
  course.lessons.splice(j, 0, l);
  save();
  res.json({ ok: true });
});

app.put('/api/admin/courses/:courseId', requireEditor, (req, res) => {
  const db = load();
  const course = db.courses.find((c) => c.id === req.params.courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const b = req.body || {};
  for (const f of ['title', 'tagline', 'description', 'badge', 'heroEmoji', 'completionRedirectUrl', 'instructions',
    'coBrandName', 'coLogoUrl', 'certOrg', 'certTitle', 'certPrefix']) if (b[f] != null) course[f] = String(b[f]);
  if (b.audience && ['everyone', 'coaches', 'referees', 'staff'].includes(b.audience)) course.audience = b.audience;
  if (b.publicVideoGate != null) course.publicVideoGate = !!b.publicVideoGate;
  if (b.estMinutes != null) course.estMinutes = Math.max(1, Number(b.estMinutes) || course.estMinutes);
  save();
  res.json({ course });
});

app.delete('/api/admin/courses/:courseId', requireEditor, (req, res) => {
  const db = load();
  const i = db.courses.findIndex((c) => c.id === req.params.courseId);
  if (i < 0) return res.status(404).json({ error: 'Course not found' });
  db.courses.splice(i, 1);
  save();
  res.json({ ok: true });
});

// Change a course's URL slug (its id) in place — without deleting or
// re-uploading anything. The uploaded packages live on disk by their own
// packageId and are referenced inside the course's lessons, so they travel with
// the course object untouched. Enrollments and lesson progress that key off the
// old course id are remapped to the new one.
app.post('/api/admin/courses/:courseId/slug', requireEditor, (req, res) => {
  const db = load();
  const course = db.courses.find((c) => c.id === req.params.courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const newId = slugify(req.body && req.body.slug);
  if (!newId) return res.status(400).json({ error: 'Enter a web address (letters, numbers, dashes).' });
  const oldId = course.id;
  if (newId === oldId) return res.json({ id: oldId, unchanged: true });
  if (db.courses.some((c) => c.id === newId)) return res.status(409).json({ error: 'Another course already uses that web address — pick a different one.' });
  course.id = newId;
  for (const e of db.enrollments) if (e.courseId === oldId) e.courseId = newId;
  for (const p of db.lessonProgress) if (p.courseId === oldId) p.courseId = newId;
  save();
  res.json({ id: newId, oldId });
});

app.post('/api/admin/courses/:courseId/lessons', requireEditor, (req, res) => {
  const db = load();
  const course = db.courses.find((c) => c.id === req.params.courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const lesson = buildLesson(req.body || {});
  course.lessons.push(lesson);
  save();
  res.json({ lesson });
});

app.put('/api/admin/courses/:courseId/lessons/:lessonId', requireEditor, (req, res) => {
  const db = load();
  const course = db.courses.find((c) => c.id === req.params.courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const idx = course.lessons.findIndex((l) => l.id === req.params.lessonId);
  if (idx < 0) return res.status(404).json({ error: 'Lesson not found' });
  course.lessons[idx] = buildLesson({ ...req.body, id: req.params.lessonId });
  save();
  res.json({ lesson: course.lessons[idx] });
});

app.delete('/api/admin/courses/:courseId/lessons/:lessonId', requireEditor, (req, res) => {
  const db = load();
  const course = db.courses.find((c) => c.id === req.params.courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const i = course.lessons.findIndex((l) => l.id === req.params.lessonId);
  if (i < 0) return res.status(404).json({ error: 'Lesson not found' });
  course.lessons.splice(i, 1);
  save();
  res.json({ ok: true });
});

// Minimal HTML-entity decode for a manifest <title>.
function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

// Upload a SCORM package (.zip). The raw zip is POSTed as the body. We unzip it
// into SCORM_DIR/<packageId>, read imsmanifest.xml for the launch file and
// title, and return metadata for the designer to attach as a `scorm` lesson.
// The package is served same-origin at /scorm/<packageId>/.
app.post('/api/admin/scorm', requireEditor,
  express.raw({ type: ['application/zip', 'application/octet-stream', 'application/x-zip-compressed'], limit: '500mb' }),
  async (req, res) => {
    let dest = null; // hoisted so a failed extraction can clean up its partial folder
    try {
      const buf = req.body;
      if (!buf || !buf.length) return res.status(400).json({ error: 'No file received.' });
      let zip;
      try { zip = new AdmZip(buf); } catch { return res.status(400).json({ error: 'That file is not a valid .zip.' }); }
      const entries = zip.getEntries();
      const manEntry = entries.find((e) => /(^|\/)imsmanifest\.xml$/i.test(e.entryName));
      if (!manEntry) return res.status(400).json({ error: 'Not a SCORM package — no imsmanifest.xml inside the .zip.' });

      // The manifest may sit inside a wrapping folder; everything is relative to it.
      const rootPrefix = manEntry.entryName.slice(0, manEntry.entryName.toLowerCase().lastIndexOf('imsmanifest.xml'));
      const manifest = zip.readAsText(manEntry);
      const launchRaw = (manifest.match(/<resource\b[^>]*\bhref="([^"]+)"/i) || [])[1] || 'index.html';
      const launchFile = launchRaw.replace(/^\.?\//, '').replace(/\\/g, '/');
      const title = decodeEntities(
        ((manifest.match(/<organization\b[^>]*>[\s\S]*?<title>([\s\S]*?)<\/title>/i)
          || manifest.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim()
      );

      const packageId = slugify(req.query.name || title || 'module') + '-' + crypto.randomBytes(3).toString('hex');
      dest = path.resolve(SCORM_DIR, packageId); // absolute, so containment checks hold even when SCORM_DIR is relative
      fs.mkdirSync(dest, { recursive: true });
      let wrote = 0;
      for (const e of entries) {
        if (e.isDirectory) continue;
        if (rootPrefix && !e.entryName.startsWith(rootPrefix)) continue;
        const relName = (rootPrefix ? e.entryName.slice(rootPrefix.length) : e.entryName).replace(/\\/g, '/');
        if (!relName || relName.includes('..')) continue;
        const outPath = path.resolve(dest, relName);
        if (outPath !== dest && !outPath.startsWith(dest + path.sep)) continue; // containment
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, e.getData());
        wrote++;
      }
      if (!wrote) { fs.rmSync(dest, { recursive: true, force: true }); return res.status(400).json({ error: 'The .zip was empty.' }); }
      // Offload videos to the Bunny CDN if configured (no-op otherwise).
      let cdn = { cdn: false };
      try { cdn = await offloadVideosToBunny(packageId, dest); }
      catch (e) { cdn = { cdn: false, error: e.message }; }
      if (!fs.existsSync(path.join(dest, launchFile))) {
        // Launch file named in the manifest isn't where expected — flag it rather
        // than silently shipping a broken module.
        return res.json({ packageId, launchFile, title, cdn: cdn.cdn, warning: `Uploaded, but the launch file "${launchFile}" wasn't found in the package — double-check it plays.` });
      }
      res.json({ packageId, launchFile, title, cdn: cdn.cdn, cdnVideos: cdn.count || 0 });
    } catch (e) {
      // A failed upload (e.g. ENOSPC mid-extract) must not leave a half-written
      // package folder behind — that would silently eat disk on every retry.
      if (dest) { try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ } }
      const msg = /ENOSPC/.test(e.message || '')
        ? 'Out of disk space. Free up module storage (Manage courses → Module storage → clean up) or enlarge the disk, then re-upload.'
        : 'Could not read package: ' + e.message;
      res.status(400).json({ error: msg });
    }
  }
);

// ---- Module storage housekeeping -------------------------------------------
// Every package folder in SCORM_DIR that no lesson points at is dead weight
// (an orphan from a deleted course or a failed upload). These endpoints report
// disk usage and let an editor reclaim the space — critical because module
// videos are large and the disk is finite.
function referencedPackageIds() {
  const ids = new Set();
  for (const c of allCourses()) for (const l of (c.lessons || [])) {
    if (l.type === 'scorm' && l.packageId) ids.add(l.packageId);
  }
  return ids;
}
function dirSizeBytes(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSizeBytes(full);
    else { try { total += fs.statSync(full).size; } catch { /* ignore */ } }
  }
  return total;
}
function listScormPackages() {
  const referenced = referencedPackageIds();
  let names = [];
  try { names = fs.readdirSync(SCORM_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { names = []; }
  return names.map((name) => ({
    packageId: name,
    bytes: dirSizeBytes(path.join(SCORM_DIR, name)),
    referenced: referenced.has(name),
    cdn: fs.existsSync(path.join(SCORM_DIR, name, '.cdn')), // videos already offloaded to Bunny
  })).sort((a, b) => b.bytes - a.bytes);
}
app.get('/api/admin/scorm/storage', requireEditor, (req, res) => {
  const packages = listScormPackages();
  let freeBytes = null, totalBytes = null;
  try { const s = fs.statfsSync(SCORM_DIR); freeBytes = s.bfree * s.bsize; totalBytes = s.blocks * s.bsize; } catch { /* older node / unsupported */ }
  res.json({
    dir: SCORM_DIR,
    usedByPackages: packages.reduce((n, p) => n + p.bytes, 0),
    orphanBytes: packages.filter((p) => !p.referenced).reduce((n, p) => n + p.bytes, 0),
    orphanCount: packages.filter((p) => !p.referenced).length,
    freeBytes, totalBytes,
    bunny: bunnyEnabled(), // are all four BUNNY_* env vars set?
    cdnPending: packages.filter((p) => !p.cdn).length,
    packages,
  });
});
// Move the videos in already-uploaded packages to the Bunny CDN — so existing
// modules get CDN offload without re-uploading. Only runs when Bunny is fully
// configured; skips packages already on the CDN.
app.post('/api/admin/scorm/migrate-cdn', requireEditor, async (req, res) => {
  if (!bunnyEnabled()) return res.status(400).json({ error: 'Bunny CDN is not configured yet — set the four BUNNY_* variables in Render, then try again.' });
  let names = [];
  try { names = fs.readdirSync(SCORM_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* none */ }
  // Optionally migrate just one package first (to test before doing them all).
  const only = req.body && req.body.packageId ? String(req.body.packageId).replace(/[^A-Za-z0-9._-]/g, '') : null;
  if (only) names = names.filter((n) => n === only);
  const results = [];
  for (const pkg of names) {
    const dest = path.resolve(SCORM_DIR, pkg);
    if (fs.existsSync(path.join(dest, '.cdn'))) { results.push({ pkg, status: 'already-cdn' }); continue; }
    try {
      const r = await offloadVideosToBunny(pkg, dest);
      results.push({ pkg, status: r.cdn ? 'migrated' : (r.error ? 'error' : 'no-video'), videos: r.count || 0, error: r.error });
    } catch (e) { results.push({ pkg, status: 'error', error: e.message }); }
  }
  res.json({
    migrated: results.filter((r) => r.status === 'migrated').length,
    videos: results.reduce((n, r) => n + (r.videos || 0), 0),
    errors: results.filter((r) => r.status === 'error').length,
    results,
  });
});
// Peek inside one uploaded package: the file tree with sizes, plus which files
// look like video and whether the launch HTML references them. Diagnostic for
// "the slides show but the video won't play".
app.get('/api/admin/scorm/:pkg/files', requireEditor, (req, res) => {
  const pkg = String(req.params.pkg).replace(/[^A-Za-z0-9._-]/g, '');
  const base = path.resolve(SCORM_DIR, pkg);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return res.status(404).json({ error: 'Package not found on disk.' });
  const files = [];
  (function walk(dir, rel) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name), r = rel ? rel + '/' + name : name;
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, r);
      else files.push({ path: r, bytes: st.size });
    }
  })(base, '');
  const videos = files.filter((f) => /\.(mp4|m4v|webm|mov|ogg)$/i.test(f.path));
  // Find which text file(s) reference the first video by its basename, and grab a
  // snippet around the reference — this reveals HOW the player loads the video.
  const refs = [];
  if (videos.length) {
    const vname = videos[0].path.split('/').pop();
    const textFiles = files.filter((f) => /\.(html?|js|json|xml|css|txt)$/i.test(f.path) && f.bytes < 3_000_000);
    for (const t of textFiles) {
      try {
        const txt = fs.readFileSync(path.join(base, t.path), 'utf8');
        const i = txt.indexOf(vname);
        if (i >= 0) refs.push({ file: t.path, snippet: txt.slice(Math.max(0, i - 80), i + vname.length + 80) });
      } catch { /* ignore */ }
      if (refs.length >= 3) break;
    }
  }
  // Does ANY player file (not the manifest inventory) show the player knows about
  // video at all? Scan the non-manifest text files for video tokens.
  const playerText = files
    .filter((f) => /\.(html?|js|css|txt)$/i.test(f.path) && f.bytes < 3_000_000)
    .map((f) => { try { return { path: f.path, txt: fs.readFileSync(path.join(base, f.path), 'utf8') }; } catch { return null; } })
    .filter(Boolean);
  const tokenHits = {};
  for (const tok of ['.mp4', 'video', '<video', 'item-014']) {
    tokenHits[tok] = playerText.filter((f) => f.txt.toLowerCase().includes(tok.toLowerCase())).map((f) => f.path);
  }
  res.json({
    packageId: pkg,
    fileCount: files.length,
    totalBytes: files.reduce((n, f) => n + f.bytes, 0),
    videos,
    refs,
    playerKnowsVideo: Object.values(tokenHits).some((arr) => arr.length > 0),
    tokenHits,
    nonMedia: files.filter((f) => !/^media\//i.test(f.path)).map((f) => f.path).slice(0, 40),
    files: files.sort((a, b) => b.bytes - a.bytes).slice(0, 60),
  });
});
app.post('/api/admin/scorm/cleanup', requireEditor, (req, res) => {
  const mode = (req.body && req.body.mode) === 'all' ? 'all' : 'orphans';
  const referenced = referencedPackageIds();
  const packages = listScormPackages();
  let removed = 0, freed = 0;
  for (const p of packages) {
    if (mode === 'orphans' && referenced.has(p.packageId)) continue;
    try { fs.rmSync(path.resolve(SCORM_DIR, p.packageId), { recursive: true, force: true }); removed++; freed += p.bytes; }
    catch { /* ignore */ }
  }
  res.json({ mode, removed, freedBytes: freed });
});

// Full course (with quiz answers) for the admin editor.
app.get('/api/admin/courses/:courseId', requireEditor, (req, res) => {
  const course = allCourses().find((c) => c.id === req.params.courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  res.json({ course });
});

// SPA fallback
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  // 1) Load existing state from the cloud (Firestore) if configured, so a
  //    fresh/ephemeral instance (e.g. Render's free tier) restores all courses
  //    and records. 2) THEN run the seeds, which only fill gaps — this order is
  //    what prevents the static seed from wiping cloud data on restart.
  initFromCloud()
    .catch(() => {})
    .then(() => { seedCourses(); seedAdmin(); seedEditor(); seedOwner(); removeRetiredCourses(); finalizeRefereeCourse(); fixRefereeTitle(); setRefereeCertYear(); setupOmgCourse(); })
    .then(() => app.listen(PORT, () => console.log(`NCYSA Learn running on http://localhost:${PORT}`)));
}
module.exports = app;
