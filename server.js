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
const unzipper = require('unzipper'); // streaming unzip — never loads the whole .zip into memory

const { load, save, id, initFromCloud } = require('./lib/store');
const { onCourseCompleted, sendTestEmail } = require('./lib/notifier');
const { signToken, verifyToken, sendCompletionWebhook, integrationEnabled, integrationSecret, integrationApiKey, mapScormStatus, scoreObject, allowedCallbackUrl } = require('./lib/integration');
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
}

// One-time: correct the "NCSYA" misspelling (transposed letters) of NCYSA in any
// course's visible text. Safe and unambiguous — NCSYA is never intentional.
const FIX_NCSYA_FLAG = 'fix-ncsya-typo-v1';
function fixNcsyaTypo() {
  const db = load();
  db.migrations = db.migrations || {};
  if (db.migrations[FIX_NCSYA_FLAG]) return;
  let fixed = 0;
  for (const c of db.courses) {
    for (const f of ['title', 'tagline', 'description', 'certOrg', 'certTitle', 'coBrandName']) {
      if (typeof c[f] === 'string' && c[f].includes('NCSYA')) { c[f] = c[f].replace(/NCSYA/g, 'NCYSA'); fixed++; }
    }
  }
  db.migrations[FIX_NCSYA_FLAG] = new Date().toISOString();
  save();
  if (fixed) console.log('[fix] corrected NCSYA→NCYSA in', fixed, 'field(s)');
}

// One-time: put NCYSA's example courses in the right portal. The Grassroots
// coaching license is coach content (off the staff page); New Registrar Training
// is staff/registrar content (off the public coaches portal). Only touches
// NCYSA's own catalog and only when the audience is still the broad default.
const FIX_AUDIENCE_FLAG = 'fix-course-audiences-v1';
function fixCourseAudiences() {
  const db = load();
  db.migrations = db.migrations || {};
  if (db.migrations[FIX_AUDIENCE_FLAG]) return;
  for (const c of db.courses) {
    if (orgOf(c) !== DEFAULT_ORG) continue; // never touch a partner org's courses
    if (c.id === 'grassroots-coaching-license' && (!c.audience || c.audience === 'everyone')) c.audience = 'coaches';
    if (/registrar/i.test(c.title || '') && c.audience !== 'staff') c.audience = 'staff';
  }
  db.migrations[FIX_AUDIENCE_FLAG] = new Date().toISOString();
  save();
}

// One-time: show the New Referee course first in the OMG portal. Moves the OMG
// "New Referee" course to the front of OMG's list; the others keep their order.
const OMG_NEW_FIRST_FLAG = 'omg-new-referee-first-v1';
function omgNewRefereeFirst() {
  const db = load();
  db.migrations = db.migrations || {};
  if (db.migrations[OMG_NEW_FIRST_FLAG]) return;
  const idx = db.courses.findIndex((c) => orgOf(c) === 'omg'
    && (/new referee/i.test(c.badge || '') || /\bnew\b/i.test(c.title || '')));
  if (idx >= 0) {
    const [course] = db.courses.splice(idx, 1);
    const insertAt = db.courses.findIndex((c) => orgOf(c) === 'omg');
    db.courses.splice(insertAt < 0 ? db.courses.length : insertAt, 0, course);
    console.log('[order] moved OMG New Referee course to the front of OMG');
  }
  db.migrations[OMG_NEW_FIRST_FLAG] = new Date().toISOString();
  save();
}

// One-time: set the full OMG portal order — New Referee, then Regional Referee
// Recertification, then Referee Recertification. Recomputes from scratch, so it
// supersedes the earlier "new first" pass regardless of the current order.
const OMG_ORDER_V2_FLAG = 'omg-course-order-v2';
function omgCourseOrder() {
  const db = load();
  db.migrations = db.migrations || {};
  if (db.migrations[OMG_ORDER_V2_FLAG]) return;
  const rank = (c) => {
    if (/new referee/i.test(c.badge || '') || /\bnew\b/i.test(c.title || '')) return 0; // New Referee
    if (/regional/i.test(c.title || '')) return 1;                                       // Regional Recertification
    return 2;                                                                            // Referee Recertification / other
  };
  const slots = [], omg = [];
  db.courses.forEach((c, i) => { if (orgOf(c) === 'omg') { slots.push(i); omg.push(c); } });
  omg.sort((a, b) => rank(a) - rank(b)); // stable
  slots.forEach((slot, k) => { db.courses[slot] = omg[k]; });
  db.migrations[OMG_ORDER_V2_FLAG] = new Date().toISOString();
  save();
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
// v2: re-run the clone once more to restore the OMG referee course after it was
// deleted. The clone reuses the NCSRA course's existing package files (same
// packageId), so nothing is re-uploaded. The inner guard below only recreates
// the course when it is actually missing, so this never duplicates it.
const OMG_COURSE_FLAG = 'omg-referee-course-v2';
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
      certAccent: '#2f5a9e',  // OMG navy (shield border) — cert border + title
      certAccent2: '#ce2b37', // OMG red (shield stripes) — cert seal
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

// One-time: a short "OMG Webhook Test" course in the OMG portal — a single
// one-screen SCORM 2004 sample with no time gate, so a partner can trigger the
// completion webhook end to end in seconds and repeat it freely (each fresh
// launch is a new enrollment that fires again). Uses the bundled test-2004
// package, so nothing needs to be uploaded.
const OMG_WEBHOOK_TEST_FLAG = 'omg-webhook-test-v1';
function setupOmgWebhookTest() {
  const db = load();
  db.migrations = db.migrations || {};
  if (db.migrations[OMG_WEBHOOK_TEST_FLAG]) return;
  if (!db.courses.some((c) => c.id === 'omg-webhook-test')) {
    db.courses.push({
      id: 'omg-webhook-test',
      orgId: 'omg',
      title: 'OMG Webhook Test',
      tagline: 'A one-screen module for testing the completion webhook end to end.',
      description: 'A short SCORM 2004 sample. Finish it and the completion webhook fires. Launch it as often as you like to test your endpoint.',
      badge: 'Test',
      estMinutes: 1,
      audience: 'referees',
      published: true,
      coBrandName: 'OMG Referee Education',
      coLogoUrl: '/media/omg-logo.png',
      certOrg: 'Officials Management Group',
      certTitle: 'Webhook Test',
      certPrefix: 'OMG',
      lessons: [{
        id: 'welcome-' + crypto.randomBytes(3).toString('hex'),
        type: 'scorm',
        title: 'Welcome Screen',
        packageId: 'test-2004',
        minSeconds: 0,
      }],
    });
  }
  db.migrations[OMG_WEBHOOK_TEST_FLAG] = new Date().toISOString();
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
// Baseline security headers on every response. Conservative so nothing breaks:
// SAMEORIGIN still allows our own SCORM iframes (served same-origin) while
// blocking third-party framing (clickjacking); nosniff stops MIME-sniffing;
// HSTS is only asserted over real HTTPS so local/test HTTP is unaffected.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});
// Always revalidate the app shell (HTML/JS/CSS) so a new deploy is picked up on
// the next page load instead of a stale cached copy lingering in the browser.
app.use((req, res, next) => {
  if (req.method === 'GET' && /(\/|\.html|\.js|\.css)$/.test(req.path)) {
    res.setHeader('Cache-Control', 'no-cache');
  }
  next();
});
// PWA manifest — makes the site installable ("Add to Home Screen" / "Install
// app") on phone, tablet and desktop. Served from a route (not a static file)
// so the installed app's name + icon match the domain's brand: GetMatchReady on
// the product domain, NCYSA Learn on NCYSA's own hosts. There is NO offline
// behavior — see public/sw.js, which is a network-only no-op.
app.get(['/manifest.webmanifest', '/manifest.json'], (req, res) => {
  const host = String(req.hostname || '').toLowerCase();
  const isProduct = host === 'getmatchready.app' || host === 'www.getmatchready.app';
  const brand = isProduct
    ? { key: 'gmr', name: 'GetMatchReady', theme: '#0b1220' }
    : { key: 'ncysa', name: 'NCYSA Learn', theme: '#17224f' };
  const manifest = {
    id: '/',
    name: brand.name,
    short_name: brand.name,
    description: 'Referee and coach education & training.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#ffffff',
    theme_color: brand.theme,
    icons: [
      { src: `/icons/${brand.key}-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `/icons/${brand.key}-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `/icons/${brand.key}-maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  res.type('application/manifest+json');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(JSON.stringify(manifest));
});
app.use(express.static(path.join(__dirname, 'public')));

// GetMatchReady partnership proposal — a standalone, password-gated page served
// at /proposal (e.g. getmatchready.app/proposal). Self-contained; not part of
// any org portal or the SPA, and it touches no NCYSA/NCSRA data.
app.get('/proposal', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'proposal.html'));
});

// Partner launch (e.g. OMS): a signed JWT carries the referee's identity and the
// module to open. We verify it, sign the referee in as a learner (no password),
// enroll them, and drop them straight into the module. On completion, a signed
// webhook reports back (see maybeCompleteCourse). The partner never touches the
// player internals — they mint a token and receive a callback.
app.get('/launch', (req, res) => {
  if (!integrationEnabled()) return res.status(503).send('Integration is not configured on this server.');
  let claims;
  try { claims = verifyToken(req.query.token); }
  catch (e) {
    return res.status(400).send('This training link is invalid or has expired. Please return to your dashboard and open the module again.');
  }
  const db = load();
  const courseId = String(claims.moduleId || claims.courseId || '');
  const course = allCourses().find((c) => c.id === courseId);
  if (!course) return res.status(404).send('That training module was not found.');
  const email = String(claims.email || '').trim().toLowerCase();
  // Never launch as a staff/admin account (those carry a password hash).
  let user = email ? db.users.find((u) => u.email.toLowerCase() === email) : null;
  if (user && user.passHash) return res.status(403).send('This email belongs to a staff account and cannot be used for a referee launch.');
  if (!user) {
    user = {
      id: id('usr'), name: claims.name || 'Referee', email,
      role: 'learner', externalRef: claims.refId || null, externalOrg: claims.org || null,
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
  } else {
    if (claims.refId) user.externalRef = claims.refId;
    if (claims.org) user.externalOrg = claims.org;
    if (claims.name && !user.name) user.name = claims.name;
  }
  let enr = db.enrollments.find((e) => e.userId === user.id && e.courseId === course.id);
  if (!enr) { enr = { userId: user.id, courseId: course.id, startedAt: new Date().toISOString(), completedAt: null, certId: null }; db.enrollments.push(enr); }
  // Mark this enrollment as partner-launched so completion reports back.
  enr.externalRef = claims.refId || enr.externalRef || null;
  enr.externalOrg = claims.org || enr.externalOrg || null;
  enr.reportBack = true;
  // Where to send the referee when they finish (only accept absolute http(s)).
  const returnUrl = (typeof claims.returnUrl === 'string' && /^https?:\/\//i.test(claims.returnUrl)) ? claims.returnUrl : null;
  enr.returnUrl = returnUrl || enr.returnUrl || null;
  // Per-launch completion webhook URL (each OMS state has its own endpoint).
  // Validated + host-allow-listed; falls back to the global webhook when absent.
  const callbackUrl = allowedCallbackUrl(claims.callbackUrl);
  enr.callbackUrl = callbackUrl || enr.callbackUrl || null;
  save();
  setSession(req, res, user.id);
  res.redirect(302, `/#/course/${course.id}`);
});

// Reconciliation pull API: a partner (e.g. OMS) can fetch a referee's completion
// status on demand to reconcile its own records. Read-only, scoped to one
// referee id, and authenticated with the shared integration secret as a bearer
// token (constant-time compared). Only active when the integration is configured.
app.get('/api/v1/completions', (req, res) => {
  if (!integrationEnabled()) return res.status(503).json({ error: 'Integration is not configured.' });
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  const apiKey = integrationApiKey();
  let ok = false;
  if (m && apiKey) {
    const a = Buffer.from(m[1]); const b = Buffer.from(apiKey);
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (!ok) return res.status(401).json({ error: 'Invalid or missing API key.' });
  const refId = String(req.query.refId || '').trim();
  if (!refId) return res.status(400).json({ error: 'refId is required.' });
  // Optional: narrow to a single module for this referee (check one lesson
  // instead of the whole array). Accept either casing of the parameter.
  const moduleId = String(req.query.moduleId || req.query.moduleid || '').trim();
  const db = load();
  const rows = db.enrollments
    .filter((e) => e.externalRef === refId && (!moduleId || e.courseId === moduleId))
    .map((e) => {
      const rec = db.lessonProgress.find((p) => p.userId === e.userId && p.courseId === e.courseId && p.scorm);
      let status;
      if (e.completedAt) status = mapScormStatus(rec && rec.scorm && rec.scorm.status) === 'passed' ? 'passed' : 'completed';
      else if (rec && rec.scorm && rec.scorm.reported) status = rec.scorm.reported; // terminal failure (failed / incomplete)
      else status = 'in-progress'; // started but not finished
      return {
        moduleId: e.courseId,
        org: e.externalOrg || null,
        status,
        score: scoreObject(rec && rec.scorm && rec.scorm.score),
        completedAt: e.completedAt || null,
        certificateId: e.certId || null,
      };
    });
  res.json(rows);
});

// Constant-time check of the partner's Bearer integration API key (the same
// per-tenant key used by the reconciliation and test-webhook endpoints).
function partnerKeyOk(req) {
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  const apiKey = integrationApiKey();
  if (!m || !apiKey) return false;
  const a = Buffer.from(m[1]); const b = Buffer.from(apiKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Simple in-memory per-key sliding-window rate limiter. Keeps only timestamps
// within the window; returns true when the caller is over the limit.
const _rlBuckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const arr = (_rlBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { _rlBuckets.set(key, arr); return true; }
  arr.push(now);
  _rlBuckets.set(key, arr);
  return false;
}

// Failed-password tracking for sign-in brute-force protection. Separate from the
// generic limiter because only FAILURES count and a success clears them, so a
// legitimate user is never locked out by their own successful login.
const LOGIN_MAX_FAILURES = 10;      // per account+IP
const LOGIN_WINDOW_MS = 15 * 60_000; // rolling 15 minutes
const _loginFails = new Map();
function loginBlocked(key) {
  const now = Date.now();
  const arr = (_loginFails.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  _loginFails.set(key, arr);
  return arr.length >= LOGIN_MAX_FAILURES;
}
function noteLoginFailure(key) {
  const now = Date.now();
  const arr = (_loginFails.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  arr.push(now);
  _loginFails.set(key, arr);
}
function clearLoginFailures(key) { _loginFails.delete(key); }

// On-demand test webhook: fire a sample (or custom) completion callback to a URL
// so a partner can debug their receiver as many times as they like, without
// paging through a whole course. Same per-tenant API-key auth as reconciliation.
// Returns the exact body and signature that were sent, so the partner can check
// their HMAC verification against ground truth.
app.post('/api/v1/test-webhook', async (req, res) => {
  if (!integrationEnabled()) return res.status(503).json({ error: 'Integration is not configured.' });
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  const apiKey = integrationApiKey();
  let ok = false;
  if (m && apiKey) {
    const a = Buffer.from(m[1]); const b = Buffer.from(apiKey);
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (!ok) return res.status(401).json({ error: 'Invalid or missing API key.' });
  if (rateLimited('test-webhook:' + m[1], 30, 60000)) {
    return res.status(429).json({ error: 'Rate limit exceeded: at most 30 test webhooks per minute.' });
  }

  const b = req.body || {};
  // Where to send: an explicit (allow-listed) url, else the configured default.
  const url = b.url ? allowedCallbackUrl(b.url) : (process.env.INTEGRATION_WEBHOOK_URL || null);
  if (!url) {
    return res.status(400).json({ error: b.url
      ? 'That url is not allowed (must be HTTPS and, if an allow-list is set, within it).'
      : 'No url provided and no default webhook is configured.' });
  }
  const status = ['passed', 'completed', 'failed', 'incomplete'].includes(b.status) ? b.status : 'passed';
  const now = new Date().toISOString();
  const payload = {
    event: 'module.' + status,
    refId: b.refId || 'TEST-REF',
    moduleId: b.moduleId || 'omg-test',
    org: b.org || 'DEMO',
    status,
    score: (b.score !== undefined) ? b.score : { raw: 8, min: 0, max: 10, percent: 80 },
    startedAt: now,
    completedAt: now,
    certificateId: (status === 'passed' || status === 'completed') ? 'TEST-CERT' : null,
    durationSeconds: 5,
    test: true, // marks this as a test event, not a real completion
  };
  const result = await sendCompletionWebhook(payload, url);
  recordWebhook({ event: payload.event, refId: payload.refId, moduleId: payload.moduleId, org: payload.org, status, url, result });
  res.json({
    sent: !!result.sent,
    httpStatus: result.status || null,
    url,
    signatureHeader: result.signature || null,
    body: result.body || JSON.stringify(payload),
    error: result.error || result.reason || null,
  });
});

// Clean per-org shortcut: /omg (and any partner-org slug) forwards to that org's
// portal. Lets a partner hand out a tidy URL (e.g. getmatchready.app/omg) that
// resolves to the hash-routed portal. Only single-segment, known non-default org
// slugs match; everything else falls through untouched.
app.get('/:slug', (req, res, next) => {
  const slug = String(req.params.slug || '').toLowerCase();
  if (ORGS[slug] && slug !== DEFAULT_ORG) return res.redirect(302, `/#/org/${slug}/referees`);
  next();
});

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
// Upload a file to Bunny by STREAMING it from disk — never load the whole video
// into memory (a 300 MB readFileSync is what pushed the instance past its RAM
// limit). Content-Length comes from the file size so Bunny gets a normal PUT.
async function bunnyPut(remotePath, filePath) {
  const url = `https://${BUNNY.host.replace(/\/+$/, '')}/${BUNNY.zone}/${remotePath}`;
  const size = fs.statSync(filePath).size;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { AccessKey: BUNNY.key, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
    body: fs.createReadStream(filePath),
    duplex: 'half', // required by undici when the body is a stream
  });
  if (!res.ok) throw new Error(`Bunny PUT ${res.status} for ${remotePath}`);
}
// Best-guess video MIME from the file extension, so the streamed response carries
// a real video type even if Bunny storage returns application/octet-stream.
function videoMime(rel) {
  if (/\.webm$/i.test(rel)) return 'video/webm';
  if (/\.mov$/i.test(rel)) return 'video/quicktime';
  if (/\.m4v$/i.test(rel)) return 'video/x-m4v';
  return 'video/mp4';
}
// Does a file exist in Bunny storage? A tiny Range GET (bytes=0-0) so we don't
// pull the whole video just to check. Used by the slide inventory so a video
// that was offloaded to Bunny (its local copy deleted) isn't falsely flagged as
// "missing" — only a video that's truly gone from Bunny is. Returns false when
// Bunny is off or unreachable.
async function bunnyHas(pkg, rel) {
  if (!bunnyEnabled()) return false;
  const url = `https://${BUNNY.host.replace(/\/+$/, '')}/${BUNNY.zone}/${pkg}/${rel}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(url, { headers: { AccessKey: BUNNY.key, Range: 'bytes=0-0' }, signal: ac.signal });
    clearTimeout(timer);
    return r.ok || r.status === 206;
  } catch (e) { clearTimeout(timer); return false; }
}
// Stream a video straight from Bunny STORAGE through us (same-origin), using the
// storage Access Key. This is the reliable path when a package's local video was
// dropped after offload and the CDN pull-zone delivery isn't serving it: the file
// is in storage (that's where the offload put it), so we fetch and relay it,
// forwarding Range so the browser can seek. Sends the response itself: the video
// on success, 404 if Bunny doesn't have it, 502 if Bunny is unreachable.
async function pipeBunnyVideo(req, res, pkg, rel) {
  const url = `https://${BUNNY.host.replace(/\/+$/, '')}/${BUNNY.zone}/${pkg}/${rel}`;
  const headers = { AccessKey: BUNNY.key };
  if (req.headers.range) headers.Range = req.headers.range;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  let r;
  try { r = await fetch(url, { headers, signal: ac.signal }); }
  catch (e) { clearTimeout(timer); if (!res.headersSent) res.status(502).end(); return; }
  clearTimeout(timer);
  if (!(r.ok || r.status === 206)) { if (!res.headersSent) res.status(r.status === 404 ? 404 : 502).end(); return; }
  res.status(r.status);
  const ct = r.headers.get('content-type') || '';
  res.setHeader('Content-Type', /^(video|audio)\//i.test(ct) ? ct : videoMime(rel));
  for (const h of ['content-length', 'content-range', 'etag', 'last-modified']) {
    const v = r.headers.get(h); if (v) res.setHeader(h, v);
  }
  res.setHeader('Accept-Ranges', r.headers.get('accept-ranges') || 'bytes');
  if (req.method === 'HEAD' || !r.body) { res.end(); return; }
  try { require('stream').Readable.fromWeb(r.body).on('error', () => { try { res.destroy(); } catch (e) {} }).pipe(res); }
  catch (e) { if (!res.headersSent) res.status(502).end(); }
}
// Video file extensions we offload — MUST match what the CDN shim rewrites
// (below), or a package with e.g. .mov videos would be rewritten to a CDN URL
// that was never uploaded. Kept in one place so the two never drift apart.
const VIDEO_EXT_RE = /\.(mp4|m4v|webm|mov)$/i;
// Does a package folder contain any video file on disk (i.e. something to move)?
function dirHasVideo(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (dirHasVideo(full)) return true; }
    else if (VIDEO_EXT_RE.test(e.name)) return true;
  }
  return false;
}
// Push a freshly-extracted package's videos to Bunny. All-or-nothing: only marks
// the package CDN-backed (and drops the local videos) if EVERY video uploads;
// otherwise everything stays served from disk, unchanged.
async function offloadVideosToBunny(pkg, dest) {
  if (!bunnyEnabled()) return { cdn: false };
  const vids = [];
  (function walk(dir, rel) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name), r = rel ? rel + '/' + name : name;
      if (fs.statSync(full).isDirectory()) walk(full, r);
      else if (VIDEO_EXT_RE.test(name)) vids.push({ full, rel: r });
    }
  })(dest, '');
  if (!vids.length) return { cdn: false };
  try {
    for (const v of vids) await bunnyPut(`${pkg}/${v.rel}`, v.full);
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

// Phone layout fix for OUR slideshow player only. Its bottom toolbar centers the
// Prev/Next controls and uses two flex spacers to push the menu (left) and
// full-screen (right) icon buttons to the edges — which on a narrow phone shoves
// those two buttons off-screen. On phone widths we drop the spacers and let the
// toolbar wrap, so every button stays in frame. Landscape/desktop (>640px) are
// untouched. Scoped by the player's own element ids so it can never affect a
// third-party (e.g. Captivate) package a partner uploads.
function injectPlayerMobileFix(html) {
  if (!/id=["']toolbar["']/.test(html) || !/id=["']menuBtn["']/.test(html)) return html;
  const style = '<style id="gmr-mobile-fix">@media (max-width:640px){'
    + '#toolbar{flex-wrap:wrap;row-gap:8px}'
    + '#toolbar .spacer{display:none}'
    + '}</style>';
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, style + '</head>');
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, style + '</body>');
  return html + style;
}

// Per-slide review gate for OUR slideshow player only. Holds the Next control
// (and the keyboard/swipe "next" paths) for a minimum time on each slide so a
// learner has to actually look at it: 30 seconds on a normal slide, 60 on a
// video slide. A slide already waited on is not re-gated when revisited, the
// last slide is left alone, and a live countdown shows why Next is disabled.
// The per-slide time is configured per module ("Time on each slide" in the
// Course Designer) and passed in as slideSec: 0 = off, otherwise the seconds a
// normal slide is held; video slides wait at least 60s. Tests can still override
// with window.GMR_GATE_SLIDE / GMR_GATE_VIDEO. Scoped by the player's own ids so
// third-party packages are never touched.
function injectSlideGate(html, slideSec) {
  if (!/id=["']nextBtn["']/.test(html) || !/id=["']counter["']/.test(html) || !/id=["']viewer["']/.test(html)) return html;
  const sl = slideSec == null ? DEFAULT_SLIDE_GATE_SECONDS : Math.min(600, Math.max(0, Math.round(Number(slideSec)) || 0));
  const vid = sl > 0 ? Math.max(sl, 60) : 0;
  if (sl <= 0) return html; // gate turned off for this module
  const script = `<script>/* GMR per-slide review gate */(function(){
  var SL=(+window.GMR_GATE_SLIDE||${sl}),VID=(+window.GMR_GATE_VIDEO||${vid});
  var nextBtn=document.getElementById('nextBtn'),counter=document.getElementById('counter'),viewer=document.getElementById('viewer');
  if(!nextBtn||!counter||!viewer)return;
  var done={},locked=false,endAt=0,iv=null;
  var lbl=document.createElement('span');lbl.style.cssText='margin-left:10px;font-size:13px;color:#9fb4d6;font-weight:700;white-space:nowrap';
  nextBtn.parentNode.insertBefore(lbl,nextBtn);
  function nums(){var p=counter.textContent.split('/');return {c:parseInt(p[0],10)||1,t:parseInt(p[1],10)||1};}
  function isVideo(){return viewer.classList.contains('has-video');}
  function clr(){if(iv){clearInterval(iv);iv=null;}}
  function paint(){var r=Math.max(0,Math.ceil((endAt-Date.now())/1000));if(r<=0){unlock();return;}var m=Math.floor(r/60),s=r%60;lbl.textContent='You can continue in '+(m?m+':'+(s<10?'0':'')+s:r+'s');}
  function lock(){locked=true;nextBtn.disabled=true;nextBtn.style.opacity='.45';endAt=Date.now()+(isVideo()?VID:SL)*1000;paint();clr();iv=setInterval(paint,250);}
  function unlock(){locked=false;clr();lbl.textContent='';nextBtn.disabled=false;nextBtn.style.opacity='';done[nums().c]=true;}
  function onSlide(){var n=nums();if(n.c>=n.t){locked=false;clr();lbl.textContent='';return;}if(done[n.c]){locked=false;clr();lbl.textContent='';nextBtn.disabled=false;nextBtn.style.opacity='';return;}setTimeout(lock,0);}
  document.addEventListener('keydown',function(e){if(!locked)return;var k=e.key,f=(k==='PageDown')||((k==='ArrowRight'||k===' '||k==='Spacebar')&&!isVideo());if(f){e.preventDefault();e.stopImmediatePropagation();}},true);
  var sx=0;document.addEventListener('touchstart',function(e){if(e.changedTouches.length)sx=e.changedTouches[0].clientX;},true);
  document.addEventListener('touchend',function(e){if(!locked||!e.changedTouches.length)return;if(e.changedTouches[0].clientX-sx<-40){e.preventDefault();e.stopImmediatePropagation();}},true);
  new MutationObserver(onSlide).observe(counter,{childList:true,characterData:true,subtree:true});
  onSlide();
})();</script>`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, script + '</body>');
  return html + script;
}

// Video load diagnostic for OUR slideshow player only. When a video slide's clip
// fails to load (missing file, or a format the device can't play), the <video>
// element normally just shows black with no explanation. This surfaces a clear
// on-slide message naming the file, so a broken clip is obvious to the learner
// and diagnosable by the admin instead of silently "not playing". Purely
// additive — it never touches the player's own playback logic. Scoped by the
// player's #video + #viewer ids so third-party packages are untouched.
function injectVideoError(html) {
  if (!/id=["']video["']/.test(html) || !/id=["']viewer["']/.test(html)) return html;
  const script = `<script>/* GMR video load diagnostic */(function(){
  var v=document.getElementById('video'),viewer=document.getElementById('viewer');
  if(!v||!viewer)return;
  var box=null;
  function anchor(){return document.getElementById('stage')||viewer;}
  function show(msg){var a=anchor();if(getComputedStyle(a).position==='static')a.style.position='relative';
    if(!box){box=document.createElement('div');box.setAttribute('role','alert');box.style.cssText='position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:82%;background:rgba(14,23,38,.96);color:#eef3fa;font:600 14px/1.45 system-ui,Arial,sans-serif;padding:14px 16px;border-radius:10px;text-align:center;z-index:60';a.appendChild(box);}
    box.textContent=msg;box.style.display='block';}
  function hide(){if(box)box.style.display='none';}
  v.addEventListener('error',function(){
    var s=(v.currentSrc||v.getAttribute('src')||'');
    var name=s?(s.split('/').pop().split('?')[0]):'the video clip';
    if(!s){show('This video slide has no clip attached. The module is missing its video file.');return;}
    var sameOrigin=true;try{sameOrigin=(new URL(s,location.href).origin===location.origin);}catch(e){}
    if(!sameOrigin){show('This video didn\\u2019t load ('+name+'). If it\\u2019s hosted externally it may be unavailable right now \\u2014 try again, or let the administrator know.');return;}
    // Same-origin clip: probe it so we can say definitively whether the file is
    // missing (needs re-uploading) or present but in an unplayable format.
    fetch(s,{method:'HEAD'}).then(function(r){
      if(!r.ok){show('This video isn\\u2019t on the server ('+name+', error '+r.status+'). It needs to be re-uploaded with the module.');}
      else{show('This video is on the server but this device can\\u2019t play its format ('+name+'). It should be a standard H.264/AAC .mp4.');}
    }).catch(function(){show('This video couldn\\u2019t be loaded ('+name+'). Check the connection, or let the administrator know.');});
  },true);
  v.addEventListener('loadeddata',hide);v.addEventListener('playing',hide);
})();</script>`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, script + '</body>');
  return html + script;
}

// Find the per-slide review time configured for the module served from this
// package folder. A package can be attached to more than one lesson; we use the
// first lesson that points at it. Falls back to the platform default when no
// lesson has set a value (so already-uploaded modules behave as before).
function slideGateForPackage(pkg) {
  try {
    for (const c of allCourses()) {
      for (const l of (c.lessons || [])) {
        if (l && l.type === 'scorm' && l.packageId === pkg && l.slideGateSeconds != null) {
          return l.slideGateSeconds;
        }
      }
    }
  } catch (e) { /* fall through to default */ }
  return DEFAULT_SLIDE_GATE_SECONDS;
}

// The slides hidden for the module served from this package (original 1-based
// numbers). First lesson pointing at the package wins; [] when none.
function hiddenSlidesForPackage(pkg) {
  try {
    for (const c of allCourses()) {
      for (const l of (c.lessons || [])) {
        if (l && l.type === 'scorm' && l.packageId === pkg && Array.isArray(l.hiddenSlides) && l.hiddenSlides.length) {
          return l.hiddenSlides;
        }
      }
    }
  } catch (e) { /* none */ }
  return [];
}

// Read a package's manifest.js and pull out its ITEMS ("i"/"v" per slide) and
// TITLES arrays. Returns null when the file is missing or ITEMS can't be parsed
// (so a non-slideshow package is never touched). Also returns the raw text and
// every top-level `var NAME=[...]` array literal it could JSON-parse, so we can
// trim per-slide arrays generically without knowing all their names.
function readSlideManifest(base) {
  const file = path.join(base, 'manifest.js');
  if (!fs.existsSync(file)) return null;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const arrays = {}; // name -> { value:[], litStart, litEnd } (offsets of the [...] literal)
  const re = /(?:var|const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(\[[\s\S]*?\])\s*;/g;
  let m;
  while ((m = re.exec(text))) {
    const litStart = m.index + m[0].indexOf(m[2]);
    try { arrays[m[1]] = { value: JSON.parse(m[2]), litStart, litEnd: litStart + m[2].length }; }
    catch { /* not a plain JSON array (skip) */ }
  }
  if (!arrays.ITEMS || !Array.isArray(arrays.ITEMS.value)) return null;
  return { text, arrays, items: arrays.ITEMS.value, titles: arrays.TITLES ? arrays.TITLES.value : null };
}

// Rewrite manifest.js so the player sees only the visible slides, in order.
// Every top-level array whose length equals the original slide count is treated
// as per-slide (ITEMS, TITLES, FPS, …) and trimmed by the same mask; other
// declarations are left exactly as they were.
function rewriteManifestForHidden(man, hiddenSet) {
  const L = man.items.length;
  const keep = []; // 0-based positions to keep
  for (let p = 0; p < L; p++) if (!hiddenSet.has(p + 1)) keep.push(p);
  if (!keep.length) return man.text; // never hide everything — serve as-is
  // Replace matching array literals from the end so earlier offsets stay valid.
  const edits = Object.values(man.arrays)
    .filter((a) => Array.isArray(a.value) && a.value.length === L)
    .sort((a, b) => b.litStart - a.litStart);
  let out = man.text;
  for (const a of edits) {
    const trimmed = keep.map((p) => a.value[p]);
    out = out.slice(0, a.litStart) + JSON.stringify(trimmed) + out.slice(a.litEnd);
  }
  return out;
}

// Map a media request against the visible deck back to the original file.
// The player asks for media/item-<newIndex> (positional in the trimmed deck);
// we serve the original slide's file. Returns the rewritten relative path, or
// null when the request isn't an item-N media path.
function remapMediaRel(rel, keep) {
  const m = /^media\/item-(\d+)(\D[\s\S]*)?$/i.exec(rel);
  if (!m) return null;
  const newIdx = parseInt(m[1], 10); // 1-based position in the trimmed deck
  if (!Number.isInteger(newIdx) || newIdx < 1 || newIdx > keep.length) return null;
  const orig = keep[newIdx - 1] + 1; // 1-based original slide number
  const pad = String(orig).padStart(Math.max(3, m[1].length), '0');
  return 'media/item-' + pad + (m[2] || '');
}

// Serve an uploaded package's files at /scorm/<packageId>/<path>, same-origin,
// with strict path containment. Falls back to the bundled samples in public/.
app.get('/scorm/:pkg/*', async (req, res) => {
  const pkg = String(req.params.pkg).replace(/[^A-Za-z0-9._-]/g, '');
  let rel = String(req.params[0] || 'index.html').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel) rel = 'index.html';
  // Slides an admin has hidden for this module (original 1-based numbers). When
  // set, the player is served a trimmed deck: manifest.js is rewritten to the
  // visible slides and media/item-NNN requests are remapped to the originals.
  // Nothing on disk changes, so this is fully reversible and never breaks the
  // package. Empty for every third-party or unedited module.
  const hidden = hiddenSlidesForPackage(pkg);
  const hiddenSet = new Set(hidden);
  for (const root of [SCORM_DIR, BUNDLED_SCORM_DIR]) {
    const base = path.resolve(root, pkg); // absolute base so containment holds for relative SCORM_DIR
    // Trimmed-deck handling for our slideshow player (only when slides are hidden
    // and this really is our player, i.e. a parseable manifest.js).
    if (hidden.length && fs.existsSync(base)) {
      const man = readSlideManifest(base);
      if (man) {
        const keep = man.items.map((_, p) => p).filter((p) => !hiddenSet.has(p + 1));
        if (keep.length) {
          if (rel === 'manifest.js') {
            return res.type('application/javascript').send(rewriteManifestForHidden(man, hiddenSet));
          }
          const remapped = remapMediaRel(rel, keep);
          if (remapped) rel = remapped;
        }
      }
    }
    const file = path.resolve(base, rel);
    if (file !== base && !file.startsWith(base + path.sep)) return res.status(400).end(); // traversal
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      // For a launch HTML page we may rewrite it on the way out: a small phone
      // layout fix, the slide gate, and the video diagnostic. Non-HTML is served
      // as-is.
      //
      // NOTE: we intentionally no longer inject the CDN shim (which rewrote video
      // <src> to the Bunny CDN pull-zone host). That pull-zone delivery proved
      // unreliable, and rewriting client-side sent the browser straight to the
      // broken CDN URL — bypassing our server, so our storage fallback could
      // never help. By leaving video src same-origin, the request comes to us and
      // pipeBunnyVideo streams it from Bunny storage (see the serve fallback
      // below). Re-enable the shim only once a Bunny pull zone is confirmed
      // delivering, to offload video bandwidth from the app.
      if (/\.html?$/i.test(rel)) {
        let html = fs.readFileSync(file, 'utf8');
        html = injectPlayerMobileFix(html);
        html = injectSlideGate(html, slideGateForPackage(pkg));
        html = injectVideoError(html);
        return res.type('html').send(html);
      }
      return res.sendFile(file);
    }
  }
  // Video fallback → stream from Bunny storage. Once a video is offloaded to
  // Bunny its local copy is deleted; the package normally gets a .cdn marker so
  // the player loads it from the Bunny CDN. If that marker is lost (the app's
  // disk was reset on a redeploy) or the CDN pull-zone isn't delivering, the
  // player asks us for the now-deleted local file. The video is still in Bunny
  // storage, so we stream it back ourselves (same-origin, Range-aware) instead
  // of 404-ing. No re-upload needed. Only for real video requests, only when
  // Bunny is configured.
  if (bunnyEnabled() && VIDEO_EXT_RE.test(rel)) {
    return pipeBunnyVideo(req, res, pkg, rel);
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

// True when the request reached us over HTTPS (directly, or via a TLS-terminating
// proxy like Render that sets x-forwarded-proto). Used to add the cookie Secure
// flag in production without breaking plain-HTTP local/test runs.
function isHttps(req) {
  return !!(req && (req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'));
}
function cookieFlags(req) {
  return `HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000${isHttps(req) ? '; Secure' : ''}`;
}
function setSession(req, res, userId) {
  const db = load();
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = userId;
  save();
  res.setHeader('Set-Cookie', `session=${token}; ${cookieFlags(req)}`);
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
    setSession(req, res, existing.id);
    return res.json({ user: { id: existing.id, name: existing.name, email: existing.email, role: existing.role } });
  }
  const user = {
    id: id('usr'), name,
    firstName: firstName || undefined, lastName: lastName || undefined,
    email, role: 'learner', createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  save();
  setSession(req, res, user.id);
  res.json({ user: { id: user.id, name, email, role: user.role } });
});

// Sign-in. Learners are passwordless (email only). Staff/admin accounts
// require the correct password, so only authorized staff reach the dashboard.
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const emailKey = String(email || '').toLowerCase();
  // Brute-force guard for password (staff/admin) sign-in. Keyed on the account
  // being targeted plus the caller IP, so guessing one account's password is
  // throttled without locking out everyone behind a shared IP. Only failures
  // count (a correct password is never blocked). Learner sign-in is passwordless
  // and unaffected.
  const clientIp = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  const lockKey = `login:${emailKey}:${clientIp}`;
  const db = load();
  const user = db.users.find((u) => u.email.toLowerCase() === emailKey);
  if (!user)
    return res.status(401).json({ error: 'No account with that email yet — use “Get started” to create one.' });
  if (STAFF_ROLES.includes(user.role)) {
    if (loginBlocked(lockKey))
      return res.status(429).json({ error: 'Too many sign-in attempts. Please wait a few minutes and try again.', needsPassword: true });
    if (!password || !user.passHash || hashPassword(password, user.salt) !== user.passHash) {
      noteLoginFailure(lockKey);
      return res.status(401).json({ error: 'Incorrect password.', needsPassword: true });
    }
    clearLoginFailures(lockKey); // a good password resets the counter
  }
  setSession(req, res, user.id);
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
  res.setHeader('Set-Cookie', `staff_access=${staffCookieValue()}; ${cookieFlags(req)}`);
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
  const db = load();
  const enr = db.enrollments.find((e) => e.userId === req.user.id && e.courseId === course.id);
  // A draft (unpublished) course is hidden from the public portal, but staff and
  // anyone explicitly enrolled may still open it — e.g. a referee launched via a
  // signed partner token to preview/QA a not-yet-live module. Public self-enroll
  // into a draft is still blocked (see /enroll), so this only opens what was
  // deliberately handed out.
  if (!isPublished(course) && !STAFF_ROLES.includes(req.user.role) && !enr) return res.status(404).json({ error: 'Course not found' });
  if (course.audience === 'staff' && !staffAuthorized(req)) return res.status(403).json({ error: 'This is a staff training — unlock the staff area with the access code first.', needsStaffCode: true });
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
const DEFAULT_SLIDE_GATE_SECONDS = 30; // per-slide review time for our slideshow player when a module doesn't set its own (matches the platform-wide behavior before it became configurable)

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
  res.json({ score, passed, passPercent: lesson.passPercent, correct, total: lesson.questions.length, courseCompleted: !!completion, certId: completion?.certId || null, returnUrl: (completion && completion.returnUrl) || null });
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
  res.json({ ok: true, courseCompleted: !!completion, certId: completion?.certId || null, returnUrl: (completion && completion.returnUrl) || null });
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
  // Capture the SCORM test score the package reports (cmi.core.score.raw/min/max).
  // Stored as-is so we can pass raw + min/max through without guessing the scale.
  const numOrNull = (v) => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);
  if (b.scoreRaw != null || b.scoreMin != null || b.scoreMax != null || b.scoreScaled != null) {
    const prev = rec.scorm.score || {};
    rec.scorm.score = {
      raw: b.scoreRaw != null && b.scoreRaw !== '' ? numOrNull(b.scoreRaw) : (prev.raw ?? null),
      min: b.scoreMin != null && b.scoreMin !== '' ? numOrNull(b.scoreMin) : (prev.min ?? null),
      max: b.scoreMax != null && b.scoreMax !== '' ? numOrNull(b.scoreMax) : (prev.max ?? null),
      // SCORM 2004 cmi.score.scaled (0..1), kept distinct from raw so the partner
      // can tell a reported percentage from a raw score (Captivate sends one or
      // the other). See scoreObject in lib/integration.js.
      scaled: b.scoreScaled != null && b.scoreScaled !== '' ? numOrNull(b.scoreScaled) : (prev.scaled ?? null),
    };
  }

  // Minimum time before completion counts. Modules uploaded before this gate
  // existed have no minSeconds field, so they fall back to the default (rather
  // than 0 = no gate) — the anti-skip protection applies without re-uploading.
  const required = lesson.minSeconds != null ? Math.max(0, Number(lesson.minSeconds) || 0) : DEFAULT_SCORM_MIN_SECONDS;
  const timeMet = rec.scorm.activeSeconds >= required;
  const reachedEnd = rec.scorm.status === 'completed' || rec.scorm.status === 'passed';
  const mapped = mapScormStatus(rec.scorm.status);
  const scoreObj = scoreObject(rec.scorm.score);
  let newlyCompleted = false;
  if (reachedEnd && timeMet && !rec.completed) {
    rec.completed = true;
    rec.completedAt = new Date().toISOString();
    newlyCompleted = true;
  }

  // A terminal FAILURE (the package reported "failed", or finished as
  // "incomplete" — which Captivate uses when the embedded test is failed) never
  // completes the course, but for a partner-launched enrollment it is still an
  // outcome the partner needs. Report it once per distinct terminal status.
  const enr = db.enrollments.find((e) => e.userId === req.user.id && e.courseId === course.id);
  const terminalFailure = !rec.completed && (mapped === 'failed' || (b.finished && mapped === 'incomplete'));
  if (enr && enr.reportBack && terminalFailure && rec.scorm.reported !== mapped) {
    rec.scorm.reported = mapped;
    save();
    sendPartnerOutcome(enr, course, { status: mapped, score: scoreObj, completedAt: new Date().toISOString() });
  } else {
    save();
  }
  // On success, pass the real SCORM status (completed/passed) + score through to
  // the completion webhook.
  const completion = newlyCompleted
    ? await maybeCompleteCourse(req.user, course, { status: mapped === 'passed' ? 'passed' : 'completed', score: scoreObj })
    : null;
  res.json({
    ok: true, status: rec.scorm.status, completed: rec.completed,
    activeSeconds: Math.floor(rec.scorm.activeSeconds), required,
    remaining: Math.max(0, required - Math.floor(rec.scorm.activeSeconds)),
    reachedEnd,
    requiredMinutes: Math.round(required / 60),
    courseCompleted: !!completion, certId: completion?.certId || null,
    returnUrl: (completion && completion.returnUrl) || null,
  });
});

// Fire a signed outcome webhook to a partner. Used for both a successful
// completion and a terminal failure; only fires for partner-launched
// enrollments (reportBack). `status` is one of completed/passed/failed/
// incomplete; the event name mirrors it (module.completed, module.failed, …).
// `score` is a { raw, min, max, percent } object or null. Never throws/blocks.
// Append a partner-webhook delivery result to a capped log, so the admin can see
// what fired and whether the partner's endpoint accepted it (200 vs error).
function recordWebhook({ event, refId, moduleId, org, status, url, result }) {
  const db = load();
  db.webhookLog = db.webhookLog || [];
  db.webhookLog.push({
    id: id('whk'), at: new Date().toISOString(),
    event, refId: refId || null, moduleId: moduleId || null, org: org || null, status: status || null,
    url: url || null,
    ok: !!(result && result.sent),
    httpStatus: (result && result.status) || null,
    error: (result && (result.error || result.reason)) || null,
  });
  if (db.webhookLog.length > 200) db.webhookLog = db.webhookLog.slice(-200); // keep the most recent 200
  save();
}

// Audit log of partner SCORM uploads (who uploaded what, how big, when) — so
// every module added over the API is accountable and the hosting footprint is
// visible. Kept alongside the webhook log and surfaced in the admin overview.
function recordUpload({ org, moduleId, packageId, title, bytes, published, action }) {
  const db = load();
  db.uploadLog = db.uploadLog || [];
  db.uploadLog.push({
    id: id('upl'), at: new Date().toISOString(),
    org: org || null, moduleId: moduleId || null, packageId: packageId || null,
    title: title || null, bytes: Number(bytes) || 0,
    published: !!published, action: action || 'create',
  });
  if (db.uploadLog.length > 200) db.uploadLog = db.uploadLog.slice(-200);
  save();
}

function sendPartnerOutcome(enr, course, { status, score = null, certificateId = null, completedAt = null }) {
  if (!enr || !enr.reportBack) return;
  const endedAt = completedAt || null;
  const durationSeconds = (enr.startedAt && endedAt)
    ? Math.max(0, Math.round((new Date(endedAt) - new Date(enr.startedAt)) / 1000)) : null;
  const event = 'module.' + status;
  const refId = enr.externalRef || null;
  const org = enr.externalOrg || null;
  const url = enr.callbackUrl || process.env.INTEGRATION_WEBHOOK_URL || null;
  sendCompletionWebhook({
    event, refId, moduleId: course.id, org, status, score,
    startedAt: enr.startedAt || null, completedAt: endedAt, certificateId, durationSeconds,
  }, enr.callbackUrl || undefined)
    .then((result) => recordWebhook({ event, refId, moduleId: course.id, org, status, url, result }))
    .catch((e) => recordWebhook({ event, refId, moduleId: course.id, org, status, url, result: { sent: false, error: e && e.message } }));
}

// When every lesson is done: complete the course, mint a certificate,
// notify the learner and NCYSA. `outcome` (optional) carries the real SCORM
// status + score object when completion came from a SCORM module.
async function maybeCompleteCourse(user, course, outcome) {
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

  // Partner callback: if this enrollment came from a signed launch (e.g. OMS),
  // push a signed completion webhook back to them. Prefer an explicit SCORM
  // outcome; otherwise fall back to a quiz score (a known 0–100 percentage).
  if (enr.reportBack) {
    const status = (outcome && outcome.status) || 'completed';
    const score = (outcome && outcome.score)
      || (quiz && quiz.quizScore != null ? { raw: quiz.quizScore, min: 0, max: 100, percent: quiz.quizScore } : null);
    sendPartnerOutcome(enr, course, { status, score, certificateId: enr.certId, completedAt: enr.completedAt });
  }
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
    // Optional per-course accent colors (border/title + seal) so the certificate
    // carries the org's color scheme, not just its logo.
    certAccent: course?.certAccent || null,
    certAccent2: course?.certAccent2 || null,
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
    partnerWebhooks: (db.webhookLog || []).slice().sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 50),
    partnerUploads: (db.uploadLog || []).slice().sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 50),
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
    // Per-slide review time (seconds) for our slideshow player: how long a learner
    // must stay on each slide before "Next" enables. Set via the "Time on each
    // slide" dropdown in the Course Designer (0 = off, otherwise 30/45/60/90).
    // Video slides automatically wait at least 60s. Only affects our own player;
    // third-party packages ignore it. Defaults to 30 to match the platform-wide
    // behavior modules had before this became configurable.
    let slideGateSeconds = DEFAULT_SLIDE_GATE_SECONDS;
    if (body.slideGateSeconds != null) slideGateSeconds = Math.min(600, Math.max(0, Math.round(Number(body.slideGateSeconds)) || 0));
    // Slides to hide from our slideshow player (original 1-based slide numbers).
    // Non-destructive: the files stay on disk; the player is served a trimmed
    // deck (see the /scorm serve path). Sanitized to unique positive integers.
    let hiddenSlides = [];
    if (Array.isArray(body.hiddenSlides)) {
      hiddenSlides = [...new Set(body.hiddenSlides.map((n) => Math.round(Number(n))).filter((n) => Number.isInteger(n) && n >= 1))].sort((a, b) => a - b).slice(0, 2000);
    }
    return { ...base, html: String(body.html || ''), packageId, launchFile, minSeconds, slideGateSeconds, hiddenSlides };
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
    // Organization the course belongs to (which portal shows it). Unknown/blank
    // → the default org, so it behaves exactly as NC courses always have.
    orgId: ORGS[String(b.orgId || '').toLowerCase()] ? String(b.orgId).toLowerCase() : DEFAULT_ORG,
    estMinutes: Math.max(1, Number(b.estMinutes) || 30),
    heroEmoji: String(b.heroEmoji || '⚽'),
    completionRedirectUrl: String(b.completionRedirectUrl || ''),
    publicVideoGate: !!b.publicVideoGate,
    published: false, // start as a draft; the designer publishes when ready
    // Who built this course, and when — so staff can see who designed each one.
    // Set once at creation and never overwritten by later edits.
    createdBy: { id: req.user.id, name: req.user.name || '', email: req.user.email || '', role: req.user.role },
    createdAt: new Date().toISOString(),
    lessons: [],
  };
  db.courses.push(course);
  save();
  res.json({ course });
});

// Generate a signed launch link for a course — the same kind a partner (OMS)
// would mint, so it can be demoed live without their system. Admin/editor only.
app.post('/api/admin/integration/test-link', requireEditor, (req, res) => {
  if (!integrationEnabled()) return res.status(400).json({ error: 'Set INTEGRATION_SECRET in the environment first, then redeploy.' });
  const b = req.body || {};
  const course = allCourses().find((c) => c.id === b.courseId);
  if (!course) return res.status(404).json({ error: 'Pick a valid course.' });
  const rand = crypto.randomBytes(3).toString('hex');
  // Demo links are for hand-off/testing, so default to a long life (7 days) and
  // allow up to 30, instead of the old 1-hour expiry that kept links dying
  // before the recipient clicked them.
  const expiresInSec = Math.min(Math.max(Number(b.expiresInSec) || 604800, 300), 2592000);
  const claims = {
    refId: b.refId || `DEMO-${rand}`,
    name: b.name || 'Demo Referee',
    email: b.email || `demo+${rand}@getmatchready.app`,
    moduleId: course.id,
    org: b.org || 'DEMO',
  };
  // Optional per-launch completion webhook (validated + host-allow-listed).
  const cb = allowedCallbackUrl(b.callbackUrl);
  if (cb) claims.callbackUrl = cb;
  const token = signToken(claims, undefined, expiresInSec);
  // Prefer the branded public domain over the raw Render host for shared links.
  const base = (process.env.PUBLIC_URL || process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  res.json({ url: `${base}/launch?token=${token}`, expiresInMinutes: Math.round(expiresInSec / 60) });
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

// Reorder a course within its own organization — this controls the order that
// org's portal lists its courses. Swaps with the nearest same-org neighbor so
// up/down moves within that org's list even if orgs are interleaved.
app.post('/api/admin/courses/:courseId/move', requireEditor, (req, res) => {
  const db = load();
  const idx = db.courses.findIndex((c) => c.id === req.params.courseId);
  if (idx < 0) return res.status(404).json({ error: 'Course not found' });
  const org = orgOf(db.courses[idx]);
  const dir = (req.body && req.body.dir) === 'up' ? -1 : 1;
  let j = idx + dir;
  while (j >= 0 && j < db.courses.length && orgOf(db.courses[j]) !== org) j += dir;
  if (j < 0 || j >= db.courses.length) return res.json({ ok: true }); // already first/last in its org
  const t = db.courses[idx]; db.courses[idx] = db.courses[j]; db.courses[j] = t;
  save();
  res.json({ ok: true });
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
  // Certificate accent colors (border/title + seal). Accept only a valid hex, or
  // an empty string to clear back to the default gold/navy scheme.
  for (const f of ['certAccent', 'certAccent2']) {
    if (b[f] == null) continue;
    const v = String(b[f]).trim();
    if (v === '') delete course[f];
    else if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v)) course[f] = v;
  }
  // Move a course between organizations (e.g. NC → OMG). Only a known org is
  // accepted; an unknown value leaves the course where it is.
  if (b.orgId != null) { const o = String(b.orgId).toLowerCase(); if (ORGS[o]) course.orgId = o; }
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
  const existing = course.lessons[idx] || {};
  const body = { ...req.body, id: req.params.lessonId };
  // Carry over the per-slide review time on a partial edit (the quick
  // Module-minutes editor only sends minMinutes), so it isn't silently reset.
  if (body.type === 'scorm' && body.slideGateSeconds == null && existing.slideGateSeconds != null) {
    body.slideGateSeconds = existing.slideGateSeconds;
  }
  // Same for hidden slides — a partial save mustn't un-hide slides.
  if (body.type === 'scorm' && !Array.isArray(body.hiddenSlides) && Array.isArray(existing.hiddenSlides)) {
    body.hiddenSlides = existing.hiddenSlides;
  }
  course.lessons[idx] = buildLesson(body);
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
// Uploads stream straight to disk and unzip with a streaming reader, so a very
// large module (hundreds of MB, or more) never has to fit in memory — which is
// what previously forced a 500 MB cap and risked an out-of-memory restart.
// Upload size cap. Generous by default so a partner's own video-heavy courses
// go through, and adjustable from the environment (MAX_UPLOAD_GB) without a code
// change if a course is ever larger. Keep it comfortably under the persistent
// disk size, since a big upload holds the temp .zip plus its extracted files at
// once (video is then offloaded to the CDN).
const MAX_UPLOAD_BYTES = Math.round((Number(process.env.MAX_UPLOAD_GB) || 5) * 1024 * 1024 * 1024);

// Shared SCORM ingest. Streams the POSTed .zip to disk (never to RAM), validates
// it's a SCORM package, extracts it into SCORM_DIR/<packageId>, offloads videos
// to Bunny when configured, and returns the package metadata. Used by BOTH the
// Course Designer upload (session-authenticated) and the partner upload API
// (key-authenticated) so the two can never drift apart. Throws an Error carrying
// a `.status` and a client-safe message on a bad upload; cleans up any
// half-written package folder or temp zip on failure.
async function ingestScormUpload(req, nameHint) {
  let dest = null;   // package folder — cleaned up if extraction fails
  let tmpZip = null; // temp upload file — always removed
  try {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared && declared > MAX_UPLOAD_BYTES) {
      throw Object.assign(new Error(`That file is ${(declared / 1e9).toFixed(2)} GB — over the ${(MAX_UPLOAD_BYTES / 1e9).toFixed(0)} GB limit.`), { status: 413 });
    }
    // 1) Stream the request body to a temp file on disk (bounded), never to RAM.
    fs.mkdirSync(SCORM_DIR, { recursive: true });
    tmpZip = path.resolve(SCORM_DIR, `.upload-${crypto.randomBytes(6).toString('hex')}.zip`);
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmpZip);
      let received = 0, tooBig = false;
      req.on('data', (c) => {
        received += c.length;
        if (received > MAX_UPLOAD_BYTES && !tooBig) { tooBig = true; req.destroy(); ws.destroy(); reject(new Error('UPLOAD_TOO_LARGE')); }
      });
      req.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      req.pipe(ws);
    });
    const uploadBytes = fs.statSync(tmpZip).size;
    if (!uploadBytes) throw Object.assign(new Error('No file received.'), { status: 400 });

    // 2) Read the zip's directory via random-access (does NOT load the whole file).
    let directory;
    try { directory = await unzipper.Open.file(tmpZip); }
    catch { throw Object.assign(new Error('That file is not a valid .zip.'), { status: 400 }); }
    const files = directory.files.filter((f) => f.type === 'File');
    const manEntry = files.find((f) => /(^|\/)imsmanifest\.xml$/i.test(f.path));
    if (!manEntry) throw Object.assign(new Error('Not a SCORM package — no imsmanifest.xml inside the .zip.'), { status: 400 });

    // The manifest may sit inside a wrapping folder; everything is relative to it.
    const rootPrefix = manEntry.path.slice(0, manEntry.path.toLowerCase().lastIndexOf('imsmanifest.xml'));
    const manifest = (await manEntry.buffer()).toString('utf8');
    const launchRaw = (manifest.match(/<resource\b[^>]*\bhref="([^"]+)"/i) || [])[1] || 'index.html';
    const launchFile = launchRaw.replace(/^\.?\//, '').replace(/\\/g, '/');
    const title = decodeEntities(
      ((manifest.match(/<organization\b[^>]*>[\s\S]*?<title>([\s\S]*?)<\/title>/i)
        || manifest.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim()
    );

    const packageId = slugify(nameHint || title || 'module') + '-' + crypto.randomBytes(3).toString('hex');
    dest = path.resolve(SCORM_DIR, packageId); // absolute, so containment checks hold even when SCORM_DIR is relative
    fs.mkdirSync(dest, { recursive: true });

    // 3) Stream each entry to disk (containment-checked), stripping the wrapper folder.
    let wrote = 0;
    for (const entry of files) {
      if (rootPrefix && !entry.path.startsWith(rootPrefix)) continue;
      const relName = (rootPrefix ? entry.path.slice(rootPrefix.length) : entry.path).replace(/\\/g, '/');
      if (!relName || relName.includes('..')) continue;
      const outPath = path.resolve(dest, relName);
      if (outPath !== dest && !outPath.startsWith(dest + path.sep)) continue; // containment
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      await new Promise((resolve, reject) => {
        const rs = entry.stream();
        const ws = fs.createWriteStream(outPath);
        rs.on('error', reject); ws.on('error', reject); ws.on('finish', resolve);
        rs.pipe(ws);
      });
      wrote++;
    }
    fs.rmSync(tmpZip, { force: true }); tmpZip = null; // extraction done — drop the temp zip

    if (!wrote) throw Object.assign(new Error('The .zip was empty.'), { status: 400 });
    // Offload videos to the Bunny CDN if configured (streams; no-op otherwise).
    let cdn = { cdn: false };
    try { cdn = await offloadVideosToBunny(packageId, dest); }
    catch (e) { cdn = { cdn: false, error: e.message }; }
    // Launch file named in the manifest isn't where expected — flag it (as a
    // warning) rather than silently shipping a broken module.
    const warning = !fs.existsSync(path.join(dest, launchFile))
      ? `Uploaded, but the launch file "${launchFile}" wasn't found in the package — double-check it plays.`
      : null;
    return { packageId, launchFile, title, bytes: uploadBytes, cdn: cdn.cdn, cdnVideos: cdn.count || 0, warning };
  } catch (e) {
    // A failed upload must not leave a half-written package folder or temp zip
    // behind — that would silently eat disk on every retry.
    if (dest) { try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ } }
    if (tmpZip) { try { fs.rmSync(tmpZip, { force: true }); } catch { /* ignore */ } }
    throw e;
  }
}

// Map an ingest error to an HTTP response (shared by both upload routes).
function sendScormUploadError(res, e) {
  if (e && e.status) return res.status(e.status).json({ error: e.message });
  const msg = e.message === 'UPLOAD_TOO_LARGE'
    ? `That file is over the ${(MAX_UPLOAD_BYTES / 1e9).toFixed(0)} GB limit.`
    : /ENOSPC/.test(e.message || '')
      ? 'Out of disk space. Free up module storage (Manage courses → Module storage → clean up) or enlarge the disk, then re-upload.'
      : 'Could not read package: ' + e.message;
  res.status(e.message === 'UPLOAD_TOO_LARGE' ? 413 : 400).json({ error: msg });
}

app.post('/api/admin/scorm', requireEditor, async (req, res) => {
  try { res.json(await ingestScormUpload(req, req.query.name)); }
  catch (e) { sendScormUploadError(res, e); }
});

// Partner upload API. A partner (OMS) can push a published SCORM package straight
// into their own org's library over HTTP, so their system can AUTOMATE adding new
// lessons instead of sending them to us by hand. Bearer-authenticated with the
// same per-tenant integration API key as reconciliation. The module is created
// as a published course in the partner org (never NCYSA/NCSRA), and the returned
// `moduleId` is exactly what a launch token's `moduleId` claim references — so the
// full loop is self-service: upload → moduleId → mint launch link → referee runs
// it → completion webhook fires. The .zip is POSTed as the raw request body; all
// options are query-string params (?title=, ?minMinutes=, ?moduleId=, ?publish=).
const PARTNER_UPLOAD_ORG = (process.env.INTEGRATION_ORG || 'omg').toLowerCase();
app.post('/api/v1/scorm', async (req, res) => {
  if (!integrationEnabled()) return res.status(503).json({ error: 'Integration is not configured.' });
  if (!partnerKeyOk(req)) return res.status(401).json({ error: 'Invalid or missing API key.' });
  if (rateLimited('scorm-upload:' + (req.headers.authorization || ''), 60, 60000)) {
    return res.status(429).json({ error: 'Rate limit exceeded: at most 60 uploads per minute.' });
  }
  const org = ORGS[PARTNER_UPLOAD_ORG] ? PARTNER_UPLOAD_ORG : DEFAULT_ORG; // the key belongs to this org; uploads never touch another
  const q = req.query || {};

  // Extract first (this consumes the request body stream).
  let meta;
  try { meta = await ingestScormUpload(req, q.title || q.name); }
  catch (e) { return sendScormUploadError(res, e); }

  const db = load();
  const title = String(q.title || meta.title || 'Referee Module').slice(0, 200);
  const minMinutes = q.minMinutes != null && q.minMinutes !== '' ? Number(q.minMinutes) : undefined;
  const lesson = buildLesson({
    type: 'scorm', title, packageId: meta.packageId, launchFile: meta.launchFile,
    ...(Number.isFinite(minMinutes) ? { minMinutes } : {}),
  });

  // Publishing kill-switch. Until the license agreement is active, partner
  // uploads are held as drafts NO MATTER what ?publish says — so states can load
  // and preview real lessons without OMS going into production before signing.
  // Flip INTEGRATION_PUBLISH_ENABLED=true once the agreement is in force.
  const publishAllowed = String(process.env.INTEGRATION_PUBLISH_ENABLED || '').toLowerCase() === 'true';

  // With ?moduleId=, replace the module inside an existing course of THIS org
  // (a lesson update); otherwise create a new course for this module.
  let course = null, action = 'create', requestedPublish = false;
  if (q.moduleId) {
    action = 'replace';
    course = db.courses.find((c) => c.id === String(q.moduleId));
    if (!course) return res.status(404).json({ error: `No module with id "${q.moduleId}".` });
    if (orgOf(course) !== org) return res.status(403).json({ error: 'That module is not in your organization.' });
    course.title = title;
    course.lessons = [lesson];
    requestedPublish = q.publish === 'true' ? true : q.publish === 'false' ? false : (course.published !== false);
    course.published = publishAllowed && requestedPublish; // never live until the switch is on
  } else {
    requestedPublish = q.publish !== 'false'; // create defaults to publish
    course = {
      id: slugify(title) + '-' + crypto.randomBytes(3).toString('hex'),
      title, tagline: '', description: '', badge: 'Module',
      audience: 'referees', orgId: org,
      estMinutes: 60, heroEmoji: '⚽',
      completionRedirectUrl: '', publicVideoGate: false,
      published: publishAllowed && requestedPublish,
      lessons: [lesson],
    };
    db.courses.push(course);
  }
  save();
  recordUpload({ org, moduleId: course.id, packageId: meta.packageId, title, bytes: meta.bytes, published: course.published, action });

  const base = (process.env.PUBLIC_URL || process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  res.json({
    ok: true,
    moduleId: course.id,          // ← use this as the launch token's `moduleId` claim
    packageId: meta.packageId,
    launchFile: meta.launchFile,
    title,
    published: course.published,
    cdn: meta.cdn, cdnVideos: meta.cdnVideos,
    launchBase: `${base}/launch`, // mint a signed JWT then launch at `${launchBase}?token=...`
    // Be explicit when a requested publish was held back by the switch. Neutral
    // wording — no contractual language in a machine response the partner logs.
    ...(requestedPublish && !publishAllowed ? { note: 'Uploaded as a draft (not yet visible to referees). Preview it with a launch link; it goes live when publishing is enabled.' } : {}),
    ...(meta.warning ? { warning: meta.warning } : {}),
  });
});

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
    hasVideo: dirHasVideo(path.join(SCORM_DIR, name)), // any local video left to move?
  })).sort((a, b) => b.bytes - a.bytes);
}
// Attribute storage to each organization so the hosting footprint (and the
// at-cost bill to a partner like OMS) is easy to tally. A package referenced by
// more than one org (e.g. a course cloned across orgs) is counted as "shared"
// rather than billed to any single org.
function storageByOrg(packages) {
  const pkgOrgs = new Map(); // packageId -> Set(orgId)
  for (const c of allCourses()) {
    const o = orgOf(c);
    for (const l of (c.lessons || [])) {
      if (l.type === 'scorm' && l.packageId) {
        if (!pkgOrgs.has(l.packageId)) pkgOrgs.set(l.packageId, new Set());
        pkgOrgs.get(l.packageId).add(o);
      }
    }
  }
  const sizeOf = new Map(packages.map((p) => [p.packageId, p.bytes]));
  const orgs = {}; let sharedBytes = 0, sharedCount = 0;
  for (const [pkg, set] of pkgOrgs) {
    const bytes = sizeOf.get(pkg) || 0;
    if (set.size > 1) { sharedBytes += bytes; sharedCount += 1; continue; }
    const o = [...set][0];
    orgs[o] = orgs[o] || { org: o, name: (ORGS[o] && ORGS[o].name) || o, bytes: 0, modules: 0 };
    orgs[o].bytes += bytes; orgs[o].modules += 1;
  }
  return { byOrg: Object.values(orgs).sort((a, b) => b.bytes - a.bytes), sharedBytes, sharedCount };
}
app.get('/api/admin/scorm/storage', requireEditor, (req, res) => {
  const packages = listScormPackages();
  let freeBytes = null, totalBytes = null;
  try { const s = fs.statfsSync(SCORM_DIR); freeBytes = s.bfree * s.bsize; totalBytes = s.blocks * s.bsize; } catch { /* older node / unsupported */ }
  const perOrg = storageByOrg(packages);
  res.json({
    dir: SCORM_DIR,
    usedByPackages: packages.reduce((n, p) => n + p.bytes, 0),
    orphanBytes: packages.filter((p) => !p.referenced).reduce((n, p) => n + p.bytes, 0),
    orphanCount: packages.filter((p) => !p.referenced).length,
    freeBytes, totalBytes,
    bunny: bunnyEnabled(), // are all four BUNNY_* env vars set?
    // Only packages that still have a local video to move count as "pending" —
    // a package with no video (or already on the CDN) is nothing to do.
    cdnPending: packages.filter((p) => !p.cdn && p.hasVideo).length,
    byOrg: perOrg.byOrg,               // storage attributed to each org (for the at-cost bill)
    sharedBytes: perOrg.sharedBytes,   // packages used by more than one org
    sharedCount: perOrg.sharedCount,
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
// Recover an already-extracted package's launch file + title from its manifest,
// so an existing (already-uploaded) package can be attached to a course as a
// lesson without re-uploading it. Reads imsmanifest.xml at the package root
// (the wrapper folder, if any, was stripped at upload time).
function manifestFromDir(dir) {
  let manifestName = null;
  try { manifestName = fs.readdirSync(dir).find((n) => /^imsmanifest\.xml$/i.test(n)); } catch { return null; }
  if (!manifestName) return null;
  let manifest;
  try { manifest = fs.readFileSync(path.join(dir, manifestName), 'utf8'); } catch { return null; }
  const launchRaw = (manifest.match(/<resource\b[^>]*\bhref="([^"]+)"/i) || [])[1] || 'index.html';
  const launchFile = launchRaw.replace(/^\.?\//, '').replace(/\\/g, '/');
  const title = decodeEntities(
    ((manifest.match(/<organization\b[^>]*>[\s\S]*?<title>([\s\S]*?)<\/title>/i)
      || manifest.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim()
  );
  return { launchFile, title };
}
app.get('/api/admin/scorm/:pkg/launch', requireEditor, (req, res) => {
  const pkg = String(req.params.pkg).replace(/[^A-Za-z0-9._-]/g, '');
  const base = path.resolve(SCORM_DIR, pkg);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return res.status(404).json({ error: 'Package not found on disk.' });
  const m = manifestFromDir(base);
  if (!m) return res.status(400).json({ error: 'No imsmanifest.xml found in that package.' });
  res.json({ packageId: pkg, launchFile: m.launchFile, title: m.title });
});

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

// Slide inventory for the "Manage slides" editor: every slide in our slideshow
// player, by original number, with its title and whether it's an image or video.
// Returns slideshow:false for a package that isn't our player (no parseable
// manifest.js) so the UI can explain hiding isn't available for it.
app.get('/api/admin/scorm/:pkg/slides', requireEditor, async (req, res) => {
  const pkg = String(req.params.pkg).replace(/[^A-Za-z0-9._-]/g, '');
  const base = path.resolve(SCORM_DIR, pkg);
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return res.status(404).json({ error: 'Package not found on disk.' });
  const man = readSlideManifest(base);
  if (!man) return res.json({ packageId: pkg, slideshow: false, slides: [] });
  const slides = man.items.map((t, i) => {
    const pad = String(i + 1).padStart(3, '0');
    const rel = 'media/item-' + pad + (t === 'v' ? '.mp4' : '.jpg');
    // Is the media on the local disk?
    let onDisk = false;
    try { const f = path.resolve(base, rel); onDisk = f.startsWith(base + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile(); } catch { onDisk = false; }
    return {
      n: i + 1,
      type: t === 'v' ? 'video' : 'image',
      title: (man.titles && man.titles[i] != null && String(man.titles[i]).trim()) ? String(man.titles[i]) : `Slide ${i + 1}`,
      rel,
      onDisk,
      onBunny: false, // filled in below for videos that aren't on disk
      // Original file, shown through the raw admin route so the preview ignores any
      // hiding currently in effect (admins always see the true, full deck).
      thumb: t === 'v' ? null : `/api/admin/scorm/${encodeURIComponent(pkg)}/rawmedia/${rel}`,
    };
  });
  // Videos are offloaded to Bunny and deleted locally, so "not on disk" doesn't
  // mean missing. For each video that's not on disk, check Bunny before flagging
  // it — only a video that's in neither place is truly missing (needs re-upload).
  await Promise.all(slides
    .filter((s) => s.type === 'video' && !s.onDisk)
    .map(async (s) => { s.onBunny = await bunnyHas(pkg, s.rel); }));
  for (const s of slides) { s.missing = !(s.onDisk || s.onBunny); delete s.rel; }
  res.json({ packageId: pkg, slideshow: true, count: slides.length, missingCount: slides.filter((s) => s.missing).length, slides });
});

// Serve a package file straight from disk with NO trimmed-deck remap, for the
// Manage-slides thumbnails — admins must always see the real, original slides.
app.get('/api/admin/scorm/:pkg/rawmedia/*', requireEditor, (req, res) => {
  const pkg = String(req.params.pkg).replace(/[^A-Za-z0-9._-]/g, '');
  const rel = String(req.params[0] || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const base = path.resolve(SCORM_DIR, pkg);
  const file = path.resolve(base, rel);
  if (file !== base && !file.startsWith(base + path.sep)) return res.status(400).end(); // traversal
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return res.status(404).end();
  res.sendFile(file);
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
    .then(() => {
      // Seeds and one-time migrations only fill gaps. Wrap them so a single
      // failing migration can never stop the server from listening — the site
      // stays up (degraded at worst) instead of going fully down on boot.
      try {
        seedCourses(); seedAdmin(); seedEditor(); seedOwner(); removeRetiredCourses();
        finalizeRefereeCourse(); fixRefereeTitle(); setRefereeCertYear(); fixNcsyaTypo();
        fixCourseAudiences(); setupOmgCourse(); setupOmgWebhookTest(); omgNewRefereeFirst(); omgCourseOrder();
      } catch (e) {
        console.error('[boot] a seed/migration failed (continuing to serve):', e && e.stack || e);
      }
    })
    .then(() => {
      const server = app.listen(PORT, () => console.log(`NCYSA Learn running on http://localhost:${PORT}`));
      // Large SCORM modules (hundreds of MB) upload slowly on shaky connections.
      // The default 5-minute request cap cuts them off ("Upload failed"), so give
      // uploads plenty of room to finish.
      server.requestTimeout = 30 * 60 * 1000; // 30 min for a full request/body
      server.headersTimeout = 60 * 1000;      // headers still bounded (default)
      server.timeout = 0;                     // no fixed socket inactivity cap
      server.keepAliveTimeout = 75 * 1000;
    });
}
module.exports = app;
