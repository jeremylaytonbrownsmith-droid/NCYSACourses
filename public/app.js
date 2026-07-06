/* NCYSA Learn — single-page app.
   Hash routing keeps the whole product one static bundle behind one Express server. */

// Official NCYSA logo. Preference order: the official PNG committed to this
// repo, then the copy hosted on ncsoccer.org, then the bundled vector mark.
const LOGO_SOURCES = [
  '/media/ncysa-logo.png',
  'https://www.ncsoccer.org/wp-content/uploads/sites/167/2026/02/cropped-USYS_NCYSA_50th_RGB.png',
  '/media/ncysa-logo.svg',
];
window.logoNext = (img) => {
  const i = Number(img.dataset.idx) + 1;
  if (i < LOGO_SOURCES.length) { img.dataset.idx = i; img.src = LOGO_SOURCES[i]; }
  else img.onerror = null;
};
function logoImg(cls) {
  return `<img class="${cls}" src="${LOGO_SOURCES[0]}" data-idx="0" onerror="logoNext(this)" alt="NC Youth Soccer logo" />`;
}

const app = document.getElementById('app');
const topnav = document.getElementById('topnav');
let me = null;        // { user, unread }
let videoTracker = null; // active video watch tracker (cleaned up on route change)

// ---------- utilities ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 3500);
}

function fmtTime(s) {
  s = Math.floor(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- nav ----------

function renderNav() {
  const user = me?.user;
  topnav.innerHTML = `
    <a class="logo" href="#/">
      ${logoImg('brandmark')}
      <span>NCYSA Learn<span class="sub">Coaching Education Platform</span></span>
    </a>
    <span class="spacer"></span>
    <a class="navlink" href="#/courses">Courses</a>
    ${user ? `
      ${user.role === 'admin' ? '<a class="navlink" href="#/admin">NCYSA Dashboard</a>' : ''}
      <button class="bell" id="bellBtn" title="Notifications">🔔${me.unread ? `<span class="dot">${me.unread}</span>` : ''}</button>
      <span class="navlink" style="cursor:default">Hi, ${esc(user.name.split(' ')[0])}</span>
      <button class="btn btn-ghost" id="logoutBtn">Sign out</button>
    ` : `
      <a class="navlink" href="#/login">Sign in</a>
      <a class="btn btn-primary" href="#/register">Get started</a>
    `}`;
  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    await refreshMe();
    location.hash = '#/';
  });
  document.getElementById('bellBtn')?.addEventListener('click', () => (location.hash = '#/notifications'));
}

async function refreshMe() {
  me = await api('/api/me');
  renderNav();
}

// ---------- views ----------

async function viewHome() {
  const { courses } = await api('/api/courses');
  app.innerHTML = `
    <section class="hero">
      ${logoImg('hero-logo')}
      <h1>Coaching education, built by NCYSA for North Carolina soccer.</h1>
      <p>Take your required licenses and professional development courses online — free,
         self-paced, and tracked automatically with NCYSA.</p>
      <div class="cta-row">
        ${me?.user
          ? `<a class="btn btn-accent btn-lg" href="#/courses">Browse courses</a>`
          : `<a class="btn btn-accent btn-lg" href="#/register">Create free account</a>
             <a class="btn btn-ghost btn-lg" href="#/login">Sign in</a>`}
      </div>
    </section>
    <div class="feature-strip">
      <div class="feature"><div class="fi">📚</div><h3>Self-paced lessons</h3><p>Reading, video, and exams that unlock in order — no skipping ahead.</p></div>
      <div class="feature"><div class="fi">🎬</div><h3>Verified video watching</h3><p>Video lessons track real watch time, so licenses mean something.</p></div>
      <div class="feature"><div class="fi">🏅</div><h3>Instant certificates</h3><p>Finish a course and your certificate is issued on the spot.</p></div>
      <div class="feature"><div class="fi">📨</div><h3>NCYSA notified automatically</h3><p>Completions are reported to NCYSA and emailed to you instantly.</p></div>
    </div>
    <section class="section">
      <h2>Course catalog</h2>
      <p class="lead">Official NCYSA coaching education courses.</p>
      <div class="course-grid">${courses.map(courseCard).join('')}</div>
    </section>
    <footer class="footer">North Carolina Youth Soccer Association · NCYSA Learn · Built in-house, no per-seat fees.</footer>`;
  bindCourseCards();
}

function courseCard(c) {
  return `
    <div class="course-card">
      <div class="thumb"><span class="badge">${esc(c.badge)}</span>${logoImg('thumb-logo')}</div>
      <div class="body">
        <h3>${esc(c.title)}</h3>
        <div class="meta">${c.lessonCount} lessons · ~${c.estMinutes} min · Certificate included</div>
        <p class="desc">${esc(c.tagline)}</p>
        ${c.enrolled ? `
          <div class="progress-track"><div class="progress-fill" style="width:${c.percent}%"></div></div>
          <div class="foot">
            <span class="meta">${c.percent}% complete</span>
            ${c.completedAt
              ? `<span class="pill-done">✓ Completed</span>`
              : `<a class="btn btn-primary" href="#/course/${c.id}">Continue</a>`}
          </div>
          ${c.certId ? `<a href="#/cert/${c.certId}">View certificate →</a>` : ''}
        ` : `
          <div class="foot">
            <span class="meta">Free</span>
            <button class="btn btn-accent enroll-btn" data-course="${c.id}">Enroll now</button>
          </div>`}
      </div>
    </div>`;
}

function bindCourseCards() {
  document.querySelectorAll('.enroll-btn').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!me?.user) { location.hash = '#/register'; return; }
      await api(`/api/courses/${btn.dataset.course}/enroll`, { method: 'POST' });
      location.hash = `#/course/${btn.dataset.course}`;
    })
  );
}

async function viewCatalog() {
  const { courses } = await api('/api/courses');
  app.innerHTML = `
    <section class="section">
      <h2>Course catalog</h2>
      <p class="lead">Official NCYSA coaching education courses. Enroll free with your NCYSA Learn account.</p>
      <div class="course-grid">${courses.map(courseCard).join('')}</div>
    </section>`;
  bindCourseCards();
}

function authForm({ title, sub, fields, submitLabel, alt, onSubmit }) {
  app.innerHTML = `
    <div class="auth-wrap"><div class="card">
      <h2>${title}</h2><p class="sub">${sub}</p>
      <form id="authForm">
        ${fields.map((f) => `
          <div class="field">
            <label for="${f.name}">${f.label}</label>
            <input id="${f.name}" name="${f.name}" type="${f.type}" required autocomplete="${f.auto || 'off'}" />
          </div>`).join('')}
        <div class="form-error" id="formError"></div>
        <button class="btn btn-primary btn-lg" style="width:100%" type="submit">${submitLabel}</button>
      </form>
      <div class="auth-alt">${alt}</div>
    </div></div>`;
  document.getElementById('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.target).entries());
    try { await onSubmit(values); }
    catch (err) { document.getElementById('formError').textContent = err.message; }
  });
}

function viewLogin() {
  authForm({
    title: 'Welcome back',
    sub: 'Sign in to continue your coursework.',
    fields: [
      { name: 'email', label: 'Email', type: 'email', auto: 'email' },
      { name: 'password', label: 'Password', type: 'password', auto: 'current-password' },
    ],
    submitLabel: 'Sign in',
    alt: 'New to NCYSA Learn? <a href="#/register">Create a free account</a>',
    onSubmit: async (v) => {
      await api('/api/login', { method: 'POST', body: v });
      await refreshMe();
      location.hash = '#/courses';
    },
  });
}

function viewRegister() {
  authForm({
    title: 'Create your free account',
    sub: 'One account for all your NCYSA education courses.',
    fields: [
      { name: 'name', label: 'Full name', type: 'text', auto: 'name' },
      { name: 'email', label: 'Email', type: 'email', auto: 'email' },
      { name: 'password', label: 'Password', type: 'password', auto: 'new-password' },
    ],
    submitLabel: 'Create account',
    alt: 'Already have an account? <a href="#/login">Sign in</a>',
    onSubmit: async (v) => {
      await api('/api/register', { method: 'POST', body: v });
      await refreshMe();
      location.hash = '#/courses';
    },
  });
}

// ---------- course player ----------

async function viewCourse(courseId, lessonId) {
  if (!me?.user) { location.hash = '#/login'; return; }
  let data;
  try { data = await api(`/api/courses/${courseId}`); }
  catch (e) {
    if (e.status === 403) { await api(`/api/courses/${courseId}/enroll`, { method: 'POST' }); data = await api(`/api/courses/${courseId}`); }
    else throw e;
  }
  const { course, progress } = data;

  // Default to the first incomplete unlocked lesson ("continue where you left off").
  if (!lessonId) {
    const next = progress.lessons.find((l) => l.unlocked && !l.completed) || progress.lessons[progress.lessons.length - 1];
    lessonId = next.id;
  }
  const lesson = course.lessons.find((l) => l.id === lessonId) || course.lessons[0];
  const lp = progress.lessons.find((l) => l.id === lesson.id);

  const typeLabel = { text: '📖 Reading', video: '🎬 Video', quiz: '📝 Exam' };
  app.innerHTML = `
    <div class="player-layout">
      <aside class="curriculum">
        <div class="course-head">
          <h2>${esc(course.title)}</h2>
          <div class="prog-label">${progress.completedLessons} of ${progress.totalLessons} lessons complete · ${progress.percent}%</div>
          <div class="progress-track"><div class="progress-fill" style="width:${progress.percent}%"></div></div>
        </div>
        ${course.lessons.map((l, i) => {
          const st = progress.lessons.find((p) => p.id === l.id);
          const cls = ['lesson-item', l.id === lesson.id ? 'active' : '', st.unlocked ? '' : 'locked'].join(' ');
          const icon = st.completed ? '<span class="stat done">✓</span>' : st.unlocked ? `<span class="stat">${i + 1}</span>` : '<span class="stat">🔒</span>';
          return `<button class="${cls}" data-lesson="${l.id}" data-unlocked="${st.unlocked}">
            ${icon}
            <span class="l-title">${esc(l.title)}<span class="l-type">${typeLabel[l.type] || l.type}</span></span>
          </button>`;
        }).join('')}
      </aside>
      <section class="lesson-pane" id="lessonPane"></section>
    </div>`;

  document.querySelectorAll('.lesson-item').forEach((btn) =>
    btn.addEventListener('click', () => {
      if (btn.dataset.unlocked !== 'true') {
        toast('🔒 This lesson is locked — complete the previous lessons first.', true);
        return;
      }
      location.hash = `#/course/${courseId}/lesson/${btn.dataset.lesson}`;
    })
  );

  const pane = document.getElementById('lessonPane');
  if (lesson.type === 'video') renderVideoLesson(pane, course, lesson, lp);
  else if (lesson.type === 'quiz') renderQuizLesson(pane, course, lesson, lp);
  else renderTextLesson(pane, course, lesson, lp);
}

function lessonHeader(lesson) {
  const typeLabel = { text: 'Reading', video: 'Video lesson', quiz: 'Final exam' };
  return `<div class="lesson-kind">${typeLabel[lesson.type]}</div><h1>${esc(lesson.title)}</h1>`;
}

async function completeLesson(course, lesson) {
  const r = await api(`/api/courses/${course.id}/lessons/${lesson.id}/complete`, { method: 'POST' });
  if (r.courseCompleted) return showCourseComplete(course, r.certId);
  const idx = course.lessons.findIndex((l) => l.id === lesson.id);
  const next = course.lessons[idx + 1];
  toast('✓ Lesson complete!');
  location.hash = next ? `#/course/${course.id}/lesson/${next.id}` : `#/course/${course.id}`;
}

function renderTextLesson(pane, course, lesson, lp) {
  pane.innerHTML = `
    ${lessonHeader(lesson)}
    <div class="lesson-content">${lesson.html}</div>
    <div class="lesson-actions">
      ${lp.completed
        ? `<span class="pill-done">✓ Completed</span><button class="btn btn-primary" id="nextBtn">Next lesson →</button>`
        : `<button class="btn btn-accent btn-lg" id="completeBtn">Complete &amp; continue →</button>`}
    </div>`;
  document.getElementById('completeBtn')?.addEventListener('click', () => completeLesson(course, lesson).catch((e) => toast(e.message, true)));
  document.getElementById('nextBtn')?.addEventListener('click', () => {
    const idx = course.lessons.findIndex((l) => l.id === lesson.id);
    const next = course.lessons[idx + 1];
    location.hash = next ? `#/course/${course.id}/lesson/${next.id}` : `#/course/${course.id}`;
  });
}

// --- Video lesson with the 58/60-second watch gate -------------------------
// Rules:
//  * Watch time only accrues during actual playback (timeupdate deltas).
//  * Seeking forward past what you've already watched snaps back.
//  * Heartbeats report accrued seconds to the server, which owns the gate.
//  * "Complete & continue" stays disabled until the server confirms the
//    requirement (58s of a 60s video) is satisfied.
function renderVideoLesson(pane, course, lesson, lp) {
  const required = lesson.minWatchSeconds;
  pane.innerHTML = `
    ${lessonHeader(lesson)}
    <div class="lesson-content">${lesson.html}</div>
    <div class="video-shell">
      <video id="lessonVideo" src="${lesson.videoUrl}" preload="metadata" playsinline></video>
      <div class="v-controls">
        <button id="playBtn" title="Play / pause">▶</button>
        <div class="v-track"><div class="v-fill" id="vFill"></div></div>
        <span class="v-time" id="vTime">0:00 / ${fmtTime(lesson.durationSeconds)}</span>
        <button id="muteBtn" title="Mute / unmute">🔊</button>
      </div>
    </div>
    <div class="watch-meter">
      <span>Watch requirement:</span>
      <div class="progress-track"><div class="progress-fill" id="watchFill" style="width:0%"></div></div>
      <span id="watchLabel">0s / ${required}s</span>
    </div>
    <p class="no-skip-tip">⏩ Fast-forwarding is disabled. You must watch at least ${required} seconds of this
      ${lesson.durationSeconds}-second video before you can continue.</p>
    <div class="lesson-actions">
      ${lp.completed
        ? `<span class="pill-done">✓ Completed</span><button class="btn btn-primary" id="nextBtn">Next lesson →</button>`
        : `<button class="btn btn-accent btn-lg" id="completeBtn" disabled>Complete &amp; continue →</button>
           <span class="gate-note" id="gateNote">Watch the video to unlock this button.</span>`}
    </div>`;

  const video = document.getElementById('lessonVideo');
  const playBtn = document.getElementById('playBtn');
  const muteBtn = document.getElementById('muteBtn');
  const completeBtn = document.getElementById('completeBtn');

  // We credit watch time by the furthest point the learner has legitimately
  // reached through real playback (a high-water mark), not by summing per-tick
  // deltas — the latter silently loses fractional seconds and could strand a
  // diligent viewer just short of the requirement. Because seeking forward is
  // blocked (see below), maxPlayed only advances during genuine playback, so
  // it is both lossless and cheat-resistant. The server clamps how far this can
  // jump per heartbeat, so a forged request still can't skip the whole video.
  let serverWatched = lp.watchedSeconds || 0; // furthest point the server has credited
  let maxPlayed = serverWatched;              // furthest point reached via real playback
  let lastReported = serverWatched;           // last position sent to the server
  let satisfied = lp.completed || serverWatched >= required;
  let sending = false;

  function updateMeter() {
    const total = Math.min(required, Math.max(serverWatched, maxPlayed));
    document.getElementById('watchFill').style.width = `${Math.min(100, (total / required) * 100)}%`;
    const label = document.getElementById('watchLabel');
    label.textContent = `${Math.floor(total)}s / ${required}s`;
    if (satisfied || maxPlayed >= required) {
      satisfied = true;
      label.innerHTML = `<span class="ok">✓ Requirement met</span>`;
      if (completeBtn) {
        completeBtn.disabled = false;
        const note = document.getElementById('gateNote');
        if (note) note.textContent = 'Nice — requirement met. You can continue.';
      }
    }
  }

  async function flushWatch(force = false) {
    // Report the furthest point played. Skip if nothing new to report.
    if (sending || (!force && maxPlayed - lastReported < 4)) return;
    if (maxPlayed <= lastReported && !force) return;
    sending = true;
    const position = maxPlayed;
    try {
      const r = await api(`/api/courses/${course.id}/lessons/${lesson.id}/watch`, {
        method: 'POST', body: { position },
      });
      serverWatched = r.watchedSeconds;
      lastReported = position;
      if (r.satisfied) satisfied = true;
    } catch { /* keep lastReported; retry on next flush */ }
    sending = false;
    updateMeter();
  }

  video.addEventListener('timeupdate', () => {
    // Advance the high-water mark only during real playback. Seeking forward is
    // blocked, so currentTime can only exceed maxPlayed by playing through.
    if (!video.paused && video.currentTime > maxPlayed) {
      maxPlayed = Math.min(video.duration || lesson.durationSeconds, video.currentTime);
    }
    document.getElementById('vFill').style.width = `${(video.currentTime / (video.duration || lesson.durationSeconds)) * 100}%`;
    document.getElementById('vTime').textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration || lesson.durationSeconds)}`;
    updateMeter();
    flushWatch();
  });

  // Anti-skip: any attempt to seek beyond what's been watched snaps back.
  video.addEventListener('seeking', () => {
    if (video.currentTime > maxPlayed + 1) {
      video.currentTime = maxPlayed;
      toast('⏩ Skipping ahead is disabled for this lesson.', true);
    }
  });
  video.addEventListener('pause', () => flushWatch(true));
  video.addEventListener('ended', () => {
    playBtn.textContent = '▶';
    // Reaching the end is only possible by playing through (seeking forward is
    // blocked), so the learner has watched the whole video — credit its full
    // length, including the final seconds that pause between the last
    // timeupdate and this event.
    maxPlayed = video.duration || lesson.durationSeconds;
    updateMeter();
    flushWatch(true);
  });

  playBtn.addEventListener('click', () => {
    if (video.paused) { video.play(); playBtn.textContent = '⏸'; }
    else { video.pause(); playBtn.textContent = '▶'; }
  });
  muteBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    muteBtn.textContent = video.muted ? '🔇' : '🔊';
  });

  videoTracker = { flush: () => flushWatch(true) };

  completeBtn?.addEventListener('click', async () => {
    await flushWatch(true);
    completeLesson(course, lesson).catch((e) => {
      toast(e.message, true);
      const note = document.getElementById('gateNote');
      if (note) { note.textContent = e.message; note.classList.add('err'); }
    });
  });
  document.getElementById('nextBtn')?.addEventListener('click', () => {
    const idx = course.lessons.findIndex((l) => l.id === lesson.id);
    const next = course.lessons[idx + 1];
    location.hash = next ? `#/course/${course.id}/lesson/${next.id}` : `#/course/${course.id}`;
  });

  updateMeter();
}

function renderQuizLesson(pane, course, lesson, lp) {
  pane.innerHTML = `
    ${lessonHeader(lesson)}
    <div class="lesson-content">${lesson.html}</div>
    ${lp.completed ? `<div class="quiz-result pass">✓ Exam passed with ${lp.quizScore}%. Your license is recorded.</div>` : ''}
    <form id="quizForm">
      ${lesson.questions.map((q, i) => `
        <div class="quiz-q">
          <h3>${i + 1}. ${esc(q.prompt)}</h3>
          ${q.options.map((opt, oi) => `
            <label class="quiz-opt">
              <input type="radio" name="${q.id}" value="${oi}" required />
              <span>${esc(opt)}</span>
            </label>`).join('')}
        </div>`).join('')}
      <div id="quizResult"></div>
      <div class="lesson-actions">
        <button class="btn btn-accent btn-lg" type="submit">Submit exam</button>
        <span class="gate-note">Pass mark: ${lesson.passPercent}%</span>
      </div>
    </form>`;

  document.getElementById('quizForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const answers = Object.fromEntries(new FormData(e.target).entries());
    try {
      const r = await api(`/api/courses/${course.id}/lessons/${lesson.id}/quiz`, { method: 'POST', body: { answers } });
      if (r.passed && r.courseCompleted) return showCourseComplete(course, r.certId, r.score);
      const box = document.getElementById('quizResult');
      box.innerHTML = r.passed
        ? `<div class="quiz-result pass">✓ You passed with ${r.score}% (${r.correct}/${r.total} correct).</div>`
        : `<div class="quiz-result fail">✗ You scored ${r.score}% (${r.correct}/${r.total} correct). You need ${r.passPercent}% — review the lessons and try again.</div>`;
      box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (err) { toast(err.message, true); }
  });
}

async function showCourseComplete(course, certId, score) {
  await refreshMe(); // pick up the new notification badge
  app.innerHTML = `
    <div class="complete-hero">
      <div class="big">🏆</div>
      <h1>Congratulations!</h1>
      <p>You have completed <strong>${esc(course.title)}</strong>${score != null ? ` with a final exam score of <strong>${score}%</strong>` : ''}.</p>
      <div>
        <span class="notice-sent">📨 A completion notice has been sent to you and to NCYSA</span>
      </div>
      <p style="margin-top:14px">
        <a class="btn btn-primary btn-lg" href="#/cert/${certId}">View your certificate</a>
        <a class="btn btn-ghost btn-lg" href="#/courses" style="margin-left:10px">Back to courses</a>
      </p>
    </div>`;
}

async function viewCertificate(certId) {
  const c = await api(`/api/certificate/${certId}`);
  const date = new Date(c.completedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  app.innerHTML = `
    <div class="certificate">
      ${logoImg('cert-logo')}
      <div class="org">North Carolina Youth Soccer Association</div>
      <h1>Certificate of Completion</h1>
      <p>This certifies that</p>
      <div class="learner-name">${esc(c.learner)}</div>
      <p>has successfully completed</p>
      <div class="course-name">${esc(c.course)}</div>
      <div class="cert-meta">Completed ${date} · Certificate ID ${esc(c.certId)}</div>
      <div class="seal">🏅</div>
    </div>
    <p style="text-align:center; margin-bottom:48px">
      <button class="btn btn-primary" onclick="window.print()">Print certificate</button>
      <a class="btn btn-ghost" href="#/courses" style="margin-left:10px">Back to courses</a>
    </p>`;
}

async function viewNotifications() {
  const { notifications } = await api('/api/notifications');
  app.innerHTML = `
    <div class="notif-list">
      <h2 style="margin-bottom:18px">Your notifications</h2>
      ${notifications.length ? notifications.map((n) => `
        <div class="notif ${n.read ? '' : 'unread'}">
          <h3>${esc(n.title)}</h3>
          <time>${new Date(n.createdAt).toLocaleString()}</time>
          <p>${esc(n.body)}</p>
        </div>`).join('') : '<p class="empty">No notifications yet — finish a course to get your first one!</p>'}
    </div>`;
  if (notifications.some((n) => !n.read)) {
    await api('/api/notifications/read', { method: 'POST' });
    await refreshMe();
  }
}

async function viewAdmin() {
  const d = await api('/api/admin/overview');
  app.innerHTML = `
    <div class="admin-wrap">
      <h1>NCYSA Education Dashboard</h1>
      <p class="lead" style="color:var(--ink-soft)">${d.learnerCount} registered learner${d.learnerCount === 1 ? '' : 's'} ·
        ${d.completions.length} course completion${d.completions.length === 1 ? '' : 's'}</p>
      <div class="admin-grid">
        <div class="admin-card">
          <h2>🏅 Course completions (license records)</h2>
          ${d.completions.length ? `
            <table class="admin-table">
              <tr><th>Learner</th><th>Email</th><th>Course</th><th>Completed</th><th>Certificate</th></tr>
              ${d.completions.map((c) => `
                <tr><td>${esc(c.learner)}</td><td>${esc(c.email)}</td><td>${esc(c.course)}</td>
                    <td>${new Date(c.completedAt).toLocaleString()}</td><td>${esc(c.certId)}</td></tr>`).join('')}
            </table>` : '<p class="empty">No completions yet.</p>'}
        </div>
        <div class="admin-card">
          <h2>🔔 NCYSA notifications</h2>
          ${d.ncysaNotifications.length ? d.ncysaNotifications.map((n) => `
            <div class="notif"><h3>${esc(n.title)}</h3>
              <time>${new Date(n.createdAt).toLocaleString()}</time><p>${esc(n.body)}</p></div>`).join('')
            : '<p class="empty">No notifications yet.</p>'}
        </div>
        <div class="admin-card">
          <h2>📨 Email outbox</h2>
          <p class="empty" style="margin-bottom:12px">Every notification email the platform has generated.
            Configure <code>NOTIFY_WEBHOOK_URL</code> or SMTP to deliver these externally.</p>
          ${d.outbox.length ? d.outbox.map((m) => `
            <div class="mail">
              <div class="mail-head"><strong>To:</strong> ${esc(m.to)} · <strong>Sent:</strong> ${new Date(m.createdAt).toLocaleString()} · <strong>Status:</strong> ${esc(m.status)}</div>
              <div><strong>${esc(m.subject)}</strong></div>
              <pre>${esc(m.body)}</pre>
            </div>`).join('') : '<p class="empty">Outbox is empty.</p>'}
        </div>
      </div>
    </div>`;
}

// ---------- router ----------

const routes = [
  { re: /^#?\/?$/, fn: viewHome },
  { re: /^#\/courses$/, fn: viewCatalog },
  { re: /^#\/login$/, fn: viewLogin },
  { re: /^#\/register$/, fn: viewRegister },
  { re: /^#\/course\/([\w-]+)$/, fn: (m) => viewCourse(m[1]) },
  { re: /^#\/course\/([\w-]+)\/lesson\/([\w-]+)$/, fn: (m) => viewCourse(m[1], m[2]) },
  { re: /^#\/cert\/([\w-]+)$/, fn: (m) => viewCertificate(m[1]) },
  { re: /^#\/notifications$/, fn: viewNotifications },
  { re: /^#\/admin$/, fn: viewAdmin },
];

async function route() {
  if (videoTracker) { videoTracker.flush(); videoTracker = null; }
  const hash = location.hash || '#/';
  for (const r of routes) {
    const m = hash.match(r.re);
    if (m) {
      try { await r.fn(m); } catch (e) {
        if (e.status === 401) { location.hash = '#/login'; return; }
        app.innerHTML = `<div class="section"><div class="card"><h2>Something went wrong</h2><p class="sub">${esc(e.message)}</p></div></div>`;
      }
      window.scrollTo(0, 0);
      return;
    }
  }
  location.hash = '#/';
}

window.addEventListener('hashchange', route);
(async function init() {
  await refreshMe();
  await route();
})();
