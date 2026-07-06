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

const { load, save, id, initFromCloud } = require('./lib/store');
const { onCourseCompleted } = require('./lib/notifier');
const courses = require('./data/courses');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- auth helpers ----------

// Staff accounts are password-protected (learners remain passwordless).
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
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

// Seed the NCYSA admin account. Staff sign-in requires a password so random
// visitors can't reach the dashboard just by typing the admin email. Set a
// strong ADMIN_PASSWORD in production; the default exists only for local/demo.
(function seedAdmin() {
  const db = load();
  const email = process.env.ADMIN_EMAIL || 'admin@ncysa.org';
  const password = process.env.ADMIN_PASSWORD || 'ncysa-staff-2026';
  const existing = db.users.find((u) => u.role === 'admin');
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
})();

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
    percent: Math.round((done / course.lessons.length) * 100),
    lessons: course.lessons.map((l) => {
      const st = lessonState(course, progress, l.id);
      const rec = progress.find((p) => p.lessonId === l.id);
      return {
        id: l.id,
        completed: st.completed,
        unlocked: st.unlocked,
        watchedSeconds: rec?.watchedSeconds || 0,
        quizScore: rec?.quizScore ?? null,
      };
    }),
  };
}

// ---------- auth API ----------

// Passwordless sign-up for the demo: name + email only, no password to create
// or remember. (For production, add real auth — a password or an emailed
// magic-link — before storing real learner records.)
app.post('/api/register', (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
  const db = load();
  const existing = db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    // Friendly: an existing email just signs back in rather than erroring.
    setSession(res, existing.id);
    return res.json({ user: { id: existing.id, name: existing.name, email: existing.email, role: existing.role } });
  }
  const user = { id: id('usr'), name, email, role: 'learner', createdAt: new Date().toISOString() };
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
  if (user.role === 'admin') {
    if (!password || !user.passHash || hashPassword(password, user.salt) !== user.passHash)
      return res.status(401).json({ error: 'Incorrect staff password.', needsPassword: true });
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
  const db = load();
  res.json({
    courses: courses.map((c) => {
      const enr = user && db.enrollments.find((e) => e.userId === user.id && e.courseId === c.id);
      const prog = user ? progressSummary(c, getProgress(db, user.id, c.id)) : null;
      return {
        id: c.id, title: c.title, tagline: c.tagline, description: c.description,
        badge: c.badge, estMinutes: c.estMinutes, heroEmoji: c.heroEmoji,
        lessonCount: c.lessons.length,
        enrolled: !!enr, completedAt: enr?.completedAt || null, certId: enr?.certId || null,
        percent: prog?.percent ?? 0,
      };
    }),
  });
});

app.post('/api/courses/:courseId/enroll', requireAuth, (req, res) => {
  const course = courses.find((c) => c.id === req.params.courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });
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
  const course = courses.find((c) => c.id === req.params.courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const db = load();
  const enr = db.enrollments.find((e) => e.userId === req.user.id && e.courseId === course.id);
  if (!enr) return res.status(403).json({ error: 'Enroll in this course first' });
  res.json({
    course: publicCourse(course),
    progress: progressSummary(course, getProgress(db, req.user.id, course.id)),
    enrollment: enr,
  });
});

// ---------- lesson progression (the gate) ----------

function findLesson(req, res) {
  const course = courses.find((c) => c.id === req.params.courseId);
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
app.post('/api/courses/:courseId/lessons/:lessonId/watch', requireAuth, (req, res) => {
  const found = findLesson(req, res);
  if (!found) return;
  const { course, lesson, db } = found;
  if (lesson.type !== 'video') return res.status(400).json({ error: 'Not a video lesson' });
  const st = lessonState(course, getProgress(db, req.user.id, course.id), lesson.id);
  if (!st.unlocked) return res.status(403).json({ error: 'This lesson is locked. Complete the previous lessons first.' });

  const rec = upsertProgress(db, req.user.id, course.id, lesson.id);
  const position = Number(req.body?.position);
  if (Number.isFinite(position)) {
    rec.watchedSeconds = Math.min(
      lesson.durationSeconds,
      Math.max(rec.watchedSeconds, Math.min(position, rec.watchedSeconds + WATCH_STEP_CAP))
    );
  } else {
    const delta = Number(req.body?.secondsWatched) || 0;
    rec.watchedSeconds = Math.min(
      lesson.durationSeconds,
      rec.watchedSeconds + Math.max(0, Math.min(delta, WATCH_STEP_CAP))
    );
  }
  save();
  res.json({
    watchedSeconds: rec.watchedSeconds,
    required: lesson.minWatchSeconds,
    satisfied: rec.watchedSeconds >= lesson.minWatchSeconds,
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
  if (lesson.type === 'video' && rec.watchedSeconds < lesson.minWatchSeconds) {
    return res.status(403).json({
      error: `You must watch at least ${lesson.minWatchSeconds} seconds of this video to continue. ` +
             `Watched so far: ${Math.floor(rec.watchedSeconds)}s.`,
      watchedSeconds: rec.watchedSeconds,
      required: lesson.minWatchSeconds,
    });
  }

  if (!rec.completed) {
    rec.completed = true;
    rec.completedAt = new Date().toISOString();
    save();
  }
  const completion = await maybeCompleteCourse(req.user, course);
  res.json({ ok: true, courseCompleted: !!completion, certId: completion?.certId || null });
});

// When every lesson is done: complete the course, mint a certificate,
// notify the learner and NCYSA.
async function maybeCompleteCourse(user, course) {
  const db = load();
  const enr = db.enrollments.find((e) => e.userId === user.id && e.courseId === course.id);
  if (!enr || enr.completedAt) return null;
  const progress = getProgress(db, user.id, course.id);
  const allDone = course.lessons.every((l) => progress.some((p) => p.lessonId === l.id && p.completed));
  if (!allDone) return null;

  enr.completedAt = new Date().toISOString();
  enr.certId = 'NCYSA-' + crypto.randomBytes(4).toString('hex').toUpperCase();
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

app.get('/api/certificate/:certId', requireAuth, (req, res) => {
  const db = load();
  const enr = db.enrollments.find((e) => e.certId === req.params.certId);
  if (!enr || (enr.userId !== req.user.id && req.user.role !== 'admin'))
    return res.status(404).json({ error: 'Certificate not found' });
  const user = db.users.find((u) => u.id === enr.userId);
  const course = courses.find((c) => c.id === enr.courseId);
  res.json({
    certId: enr.certId, learner: user.name, course: course.title,
    completedAt: enr.completedAt,
  });
});

// ---------- NCYSA admin ----------

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const db = load();
  res.json({
    completions: db.enrollments
      .filter((e) => e.completedAt)
      .map((e) => ({
        learner: db.users.find((u) => u.id === e.userId)?.name,
        email: db.users.find((u) => u.id === e.userId)?.email,
        course: courses.find((c) => c.id === e.courseId)?.title,
        completedAt: e.completedAt,
        certId: e.certId,
      }))
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt)),
    ncysaNotifications: db.notifications
      .filter((n) => n.audience === 'ncysa')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    outbox: db.outbox.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    learnerCount: db.users.filter((u) => u.role === 'learner').length,
  });
});

// SPA fallback
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  // Seed in-memory state from the cloud (if Firestore is configured) before
  // accepting traffic, so progress persists across restarts and instances.
  initFromCloud().finally(() => {
    app.listen(PORT, () => console.log(`NCYSA Learn running on http://localhost:${PORT}`));
  });
}
module.exports = app;
