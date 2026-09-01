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
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return res.sendFile(file);
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
    // Friendly: an existing email just signs back in rather than erroring.
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
  if (!user) return res.json({ user: null });
  const db = load();
  const unread = db.notifications.filter(
    (n) => n.audience === 'user' && n.userId === user.id && !n.read
  ).length;
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role }, unread });
});

// ---------- catalog & enrollment ----------

app.get('/api/courses', (req, res) => {
  const user = currentUser(req);
  const isStaff = !!user && STAFF_ROLES.includes(user.role);
  const db = load();
  res.json({
    courses: allCourses().filter((c) => isStaff || isPublished(c)).map((c) => {
      const enr = user && db.enrollments.find((e) => e.userId === user.id && e.courseId === c.id);
      const prog = user ? progressSummary(c, getProgress(db, user.id, c.id)) : null;
      return {
        id: c.id, title: c.title, tagline: c.tagline, description: c.description,
        badge: c.badge, estMinutes: c.estMinutes, heroEmoji: c.heroEmoji,
        audience: c.audience || 'everyone',
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
const DEFAULT_SCORM_MIN_SECONDS = 300; // default minimum time in a module before completion counts (5 min)

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
  for (const f of ['title', 'tagline', 'description', 'badge', 'heroEmoji', 'completionRedirectUrl', 'instructions']) if (b[f] != null) course[f] = String(b[f]);
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
  (req, res) => {
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
      const dest = path.resolve(SCORM_DIR, packageId); // absolute, so containment checks hold even when SCORM_DIR is relative
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
      if (!fs.existsSync(path.join(dest, launchFile))) {
        // Launch file named in the manifest isn't where expected — flag it rather
        // than silently shipping a broken module.
        return res.json({ packageId, launchFile, title, warning: `Uploaded, but the launch file "${launchFile}" wasn't found in the package — double-check it plays.` });
      }
      res.json({ packageId, launchFile, title });
    } catch (e) {
      res.status(400).json({ error: 'Could not read package: ' + e.message });
    }
  }
);

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
    .then(() => { seedCourses(); seedAdmin(); seedEditor(); seedOwner(); removeRetiredCourses(); })
    .then(() => app.listen(PORT, () => console.log(`NCYSA Learn running on http://localhost:${PORT}`)));
}
module.exports = app;
