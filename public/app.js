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

// Professional inline SVG role icons (crisp, theme-agnostic on their navy badge).
const ICON_COACH = `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
  <rect x="19" y="5" width="10" height="6" rx="2" fill="#fff"/>
  <path d="M17 8 H12 a3 3 0 0 0-3 3 V40 a3 3 0 0 0 3 3 H36 a3 3 0 0 0 3-3 V11 a3 3 0 0 0-3-3 H31" stroke="#fff" stroke-width="2.6" fill="none" stroke-linejoin="round"/>
  <path d="M15 33 C19 23 29 29 31 17" stroke="#edc32c" stroke-width="2.4" stroke-dasharray="3.5 3.2" fill="none" stroke-linecap="round"/>
  <circle cx="15" cy="33" r="2.8" fill="#edc32c"/>
  <path d="M31 17 l-4 2.5 M31 17 l1.5 4.2" stroke="#edc32c" stroke-width="2.4" stroke-linecap="round"/>
</svg>`;
const ICON_REFEREE = `<svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
  <rect x="10" y="12" width="16" height="24" rx="2.6" fill="#edc32c" transform="rotate(-11 18 24)"/>
  <rect x="22" y="14" width="16" height="24" rx="2.6" fill="#d8332f" transform="rotate(10 30 26)"/>
</svg>`;

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
      <span>NCYSA Learn<span class="sub">Education &amp; Training Platform</span></span>
    </a>
    <span class="spacer"></span>
    <a class="navlink nav-courses" href="#/courses">Courses</a>
    <a class="navlink nav-help" href="#/help">Help</a>
    ${user ? `
      ${user.role === 'admin' ? '<a class="navlink nav-dashboard" href="#/admin">NCYSA Dashboard</a><a class="navlink nav-training" href="#/staff-training">Staff Training</a>' : ''}
      ${user.role === 'editor' ? '<a class="navlink nav-dashboard" href="#/admin/courses">Course Designer</a>' : ''}
      <button class="bell" id="bellBtn" title="Notifications" aria-label="Notifications${me.unread ? ` (${me.unread} unread)` : ''}">🔔${me.unread ? `<span class="dot">${me.unread}</span>` : ''}</button>
      <span class="navlink greeting" style="cursor:default">Hi, ${esc(user.name.split(' ')[0])}</span>
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

// Course audience helpers: staff-only trainings don't show in the coach catalog.
const isCoachCourse = (c) => !c.audience || c.audience === 'everyone' || c.audience === 'coaches';
const isStaffCourse = (c) => c.audience === 'staff' || c.audience === 'everyone';

// Where each role lands after signing in.
const roleHome = (role) => role === 'admin' ? '#/admin' : role === 'editor' ? '#/admin/courses' : '#/courses';

async function viewHome() {
  const { courses } = await api('/api/courses');
  const resume = me?.user ? courses.find((c) => c.enrolled && !c.completedAt) : null;
  app.innerHTML = `
    ${resume ? `
    <section class="resume-strip">
      <div class="resume-inner">
        <div class="resume-text">
          <span class="resume-kicker">Welcome back, ${esc(me.user.name.split(' ')[0])}</span>
          <span class="resume-title">Pick up where you left off — ${esc(resume.title)}</span>
          <div class="resume-track"><div class="resume-fill" style="width:${resume.percent}%"></div></div>
          <span class="resume-meta">${resume.percent}% complete</span>
        </div>
        <a class="btn btn-accent btn-lg resume-btn" href="#/course/${resume.id}">Resume where you left off →</a>
      </div>
    </section>` : ''}
    <section class="hero">
      ${logoImg('hero-logo')}
      <h1>Coaching education, built by NCYSA for North Carolina soccer.</h1>
      <p>Take your required licenses and professional development courses online —
         self-paced, with your progress tracked automatically by NCYSA.</p>
      <div class="cta-row">
        ${me?.user
          ? `<a class="btn btn-accent btn-lg" href="#/courses">Browse courses</a>`
          : `<a class="btn btn-accent btn-lg" href="#/register">Create free account</a>
             <a class="btn btn-ghost btn-lg" href="#/login">Sign in</a>`}
      </div>
    </section>
    <div class="feature-strip">
      <div class="feature"><div class="fi">📚</div><h3>Self-paced lessons</h3><p>Reading, video, and exams that unlock in order — no skipping ahead.</p></div>
      <div class="feature"><div class="fi">🎬</div><h3>Verified video watching</h3><p>Video lessons track real watch time, so completed licenses reflect genuine training.</p></div>
      <div class="feature"><div class="fi">🏅</div><h3>Instant certificates</h3><p>Finish a course and your certificate is issued on the spot.</p></div>
      <div class="feature"><div class="fi">📨</div><h3>NCYSA notified automatically</h3><p>Completions are reported to NCYSA and emailed to you instantly.</p></div>
    </div>
    <section class="section">
      <h2>Which brings you here?</h2>
      <p class="lead">NCYSA education for every role in the game — choose your path.</p>
      <div class="role-split">
        <a class="role-card" href="#/courses">
          <div class="role-icon">${ICON_COACH}</div>
          <h3>Coaches go here</h3>
          <p>Grassroots licenses and coaching development — including the course below.</p>
          <span class="role-go">View coach courses →</span>
        </a>
        <a class="role-card" href="#/referees">
          <div class="role-icon">${ICON_REFEREE}</div>
          <h3>Referees go here</h3>
          <p>Certification and Laws of the Game training for match officials.</p>
          <span class="role-go">View referee courses →</span>
        </a>
      </div>
    </section>
    <section class="section" id="coach-courses">
      <h2>Coach courses</h2>
      <p class="lead">Official NCYSA coaching education courses.</p>
      <div class="course-grid">${courses.filter(isCoachCourse).map(courseCard).join('')}</div>
    </section>
    <footer class="footer">© ${new Date().getFullYear()} North Carolina Youth Soccer Association · NCYSA Learn</footer>`;
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
      <div class="course-grid">${courses.filter(isCoachCourse).map(courseCard).join('')}</div>
    </section>`;
  bindCourseCards();
}

// Staff training area: staff sign in and take their own required trainings.
async function viewStaffTraining() {
  if (!me?.user || me.user.role !== 'admin') { location.hash = '#/staff'; return; }
  const { courses } = await api('/api/courses');
  const staffCourses = courses.filter(isStaffCourse);
  app.innerHTML = `
    <section class="section">
      <a class="back-link" href="#/admin">← Dashboard</a>
      <h2>Staff Training</h2>
      <p class="lead">Required and optional trainings for NCYSA staff, board members, and office
        volunteers. Complete a training to earn your certificate — your completion is recorded
        automatically, just like a coach's.</p>
      ${staffCourses.length
        ? `<div class="course-grid">${staffCourses.map(courseCard).join('')}</div>`
        : '<p class="empty">No staff trainings yet. Add one from “Manage courses” and set its audience to Staff.</p>'}
    </section>`;
  bindCourseCards();
}

function authForm({ title, sub, fields, submitLabel, alt, note, onSubmit }) {
  app.innerHTML = `
    <div class="auth-wrap"><div class="card">
      <h2>${title}</h2><p class="sub">${sub}</p>
      <form id="authForm">
        ${fields.map((f) => `
          <div class="field">
            <label for="${f.name}">${f.label}</label>
            <input id="${f.name}" name="${f.name}" type="${f.type}" required autocomplete="${f.auto || 'off'}"${f.placeholder ? ` placeholder="${f.placeholder}"` : ''} />
          </div>`).join('')}
        <div class="form-error" id="formError"></div>
        <button class="btn btn-primary btn-lg" style="width:100%" type="submit">${submitLabel}</button>
      </form>
      ${note ? `<p class="auth-note">${note}</p>` : ''}
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
    sub: 'Enter your email to continue — no password needed.',
    fields: [
      { name: 'email', label: 'Email', type: 'email', auto: 'email' },
    ],
    submitLabel: 'Continue',
    note: '🔒 No password required. Your email is only used to save your progress — nothing is sent anywhere.',
    alt: 'New to NCYSA Learn? <a href="#/register">Create a free account</a><br /><a href="#/staff" class="staff-link">NCYSA staff sign-in →</a>',
    onSubmit: async (v) => {
      try {
        const r = await api('/api/login', { method: 'POST', body: v });
        await refreshMe();
        const dest = afterAuthHash; afterAuthHash = null;
        location.hash = dest || roleHome(r.user.role);
      } catch (err) {
        // Production: a staff email needs a password — send them to staff sign-in.
        if (err.data && err.data.needsPassword) { location.hash = '#/staff'; return; }
        throw err;
      }
    },
  });
}

function viewStaffLogin() {
  authForm({
    title: 'NCYSA staff sign-in',
    sub: 'Authorized staff only — access to the education dashboard and completion records.',
    fields: [
      { name: 'email', label: 'Staff email', type: 'email', auto: 'email' },
      { name: 'password', label: 'Staff password', type: 'password', auto: 'current-password' },
    ],
    submitLabel: 'Sign in',
    note: '🔒 The dashboard and learner completion data are restricted to NCYSA staff with a valid password.',
    alt: 'Not staff? <a href="#/login">Learner sign-in</a>',
    onSubmit: async (v) => {
      const r = await api('/api/login', { method: 'POST', body: v });
      await refreshMe();
      location.hash = roleHome(r.user.role);
    },
  });
}

function viewRegister() {
  authForm({
    title: 'Create your free account',
    sub: 'Just your name and email — no password to set up.',
    fields: [
      { name: 'firstName', label: 'First name', type: 'text', auto: 'given-name' },
      { name: 'lastName', label: 'Last name', type: 'text', auto: 'family-name' },
      { name: 'email', label: 'Email', type: 'email', auto: 'email', placeholder: 'you@example.com' },
    ],
    submitLabel: 'Create account',
    note: '🔒 No password required. Your email is only used to save your progress and issue your certificate — nothing is sent anywhere.',
    alt: 'Already have an account? <a href="#/login">Sign in</a>',
    onSubmit: async (v) => {
      await api('/api/register', { method: 'POST', body: v });
      await refreshMe();
      const dest = afterAuthHash; afterAuthHash = null;
      location.hash = dest || '#/courses';
    },
  });
}

function viewReferees() {
  app.innerHTML = `
    <section class="section">
      <a class="back-link" href="#/">← Back to home</a>
      <div class="role-hero">
        <div class="role-icon big">${ICON_REFEREE}</div>
        <h2>Referee education</h2>
        <p class="lead">Certification and Laws of the Game training for NC match officials.</p>
      </div>
      <div class="card notice-card">
        <h3>Referee courses are coming soon to NCYSA Learn</h3>
        <p>We're building the same guided, trackable experience for referees that coaches get here —
        entry-level certification, rules refreshers, and recertification. In the meantime, these
        official resources will get you started:</p>
        <ul class="resource-links">
          <li><a href="https://www.ncsoccer.org/" target="_blank" rel="noopener">NCYSA — Referee registration &amp; clinics</a></li>
          <li><a href="https://www.ussoccer.com/referee-program" target="_blank" rel="noopener">U.S. Soccer Referee Program</a></li>
          <li><a href="https://learningcenter.ussoccer.com/" target="_blank" rel="noopener">U.S. Soccer Learning Center — referee courses</a></li>
          <li><a href="https://www.theifab.com/laws-of-the-game-documents/" target="_blank" rel="noopener">IFAB — Laws of the Game</a></li>
        </ul>
        <p style="margin-top:14px">Want to be notified when referee courses launch?
        <a href="#/register">Create a free account</a> and we'll have your profile ready.</p>
      </div>
    </section>`;
}

// ---------- course player ----------

let afterAuthHash = null; // where to land after sign-in (e.g. a shared course link)
async function viewCourse(courseId, lessonId) {
  if (!me?.user) { afterAuthHash = location.hash; location.hash = '#/register'; return; }
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
          ${course.coBrandName ? `<div class="cobrand">
            ${course.coLogoUrl ? `<img class="cobrand-logo" src="${esc(course.coLogoUrl)}" alt="${esc(course.coBrandName)}" />` : ''}
            <span class="cobrand-name">${esc(course.coBrandName)}</span>
          </div>` : ''}
          <h2>${esc(course.title)}</h2>
          <div class="prog-label">${progress.completedLessons} of ${progress.totalLessons} lessons complete · ${progress.percent}%</div>
          <div class="progress-track"><div class="progress-fill" style="width:${progress.percent}%"></div></div>
        </div>
        <div class="curriculum-lessons">
        ${course.lessons.map((l, i) => {
          const st = progress.lessons.find((p) => p.id === l.id);
          const cls = ['lesson-item', l.id === lesson.id ? 'active' : '', st.unlocked ? '' : 'locked'].join(' ');
          const icon = st.completed ? '<span class="stat done">✓</span>' : st.unlocked ? `<span class="stat">${i + 1}</span>` : '<span class="stat">🔒</span>';
          return `<button class="${cls}" data-lesson="${l.id}" data-unlocked="${st.unlocked}">
            ${icon}
            <span class="l-title">${esc(l.title)}<span class="l-type">${typeLabel[l.type] || l.type}</span></span>
          </button>`;
        }).join('')}
        </div>
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

function lessonHeader(lesson, course) {
  const typeLabel = { text: 'Reading', video: 'Video lesson', quiz: 'Final exam' };
  const logo = course && course.coLogoUrl
    ? `<img class="lesson-cobrand-logo" src="${esc(course.coLogoUrl)}" alt="${esc(course.coBrandName || '')}" />`
    : '';
  return `<div class="lesson-kind-row"><div class="lesson-kind">${typeLabel[lesson.type]}</div>${logo}</div><h1>${esc(lesson.title)}</h1>`;
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
    ${lessonHeader(lesson, course)}
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
  // Requirement adapts to the video's real length once the player reports it
  // (see the loadedmetadata handler); this is just the pre-load fallback.
  let required = lesson.minWatchSeconds || Math.max(1, Math.floor((lesson.durationSeconds || 60) * 0.97));
  pane.innerHTML = `
    ${lessonHeader(lesson, course)}
    <div class="lesson-content">${lesson.html}</div>
    <div class="video-shell">
      <video id="lessonVideo" preload="metadata" playsinline aria-label="Lesson video: ${esc(lesson.title)}">
        ${lesson.videoUrl ? `<source src="${lesson.videoUrl}" type="video/mp4" />` : ''}
        ${lesson.videoUrlWebm ? `<source src="${lesson.videoUrlWebm}" type="video/webm" />` : ''}
      </video>
      <div class="v-controls">
        <button id="playBtn" title="Play / pause" aria-label="Play or pause the video">▶</button>
        <div class="v-track"><div class="v-fill" id="vFill"></div></div>
        <span class="v-time" id="vTime">0:00 / ${fmtTime(lesson.durationSeconds)}</span>
        <button id="muteBtn" title="Mute / unmute" aria-label="Mute or unmute">🔊</button>
      </div>
    </div>
    <div class="watch-meter">
      <span>Watch requirement:</span>
      <div class="progress-track"><div class="progress-fill" id="watchFill" style="width:0%"></div></div>
      <span id="watchLabel">0s / ${required}s</span>
    </div>
    <p class="no-skip-tip" id="noSkipTip">⏩ Fast-forwarding is disabled — you must watch the video to the end before you can continue.</p>
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
        method: 'POST',
        body: { position, duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : undefined },
      });
      serverWatched = r.watchedSeconds;
      if (r.required) required = r.required; // server confirms the real requirement
      lastReported = position;
      if (r.satisfied) satisfied = true;
    } catch { /* keep lastReported; retry on next flush */ }
    sending = false;
    updateMeter();
  }

  // Once the browser knows the real video length, gate on 97% of it — so a
  // designer never has to enter an exact duration and no learner is stranded.
  video.addEventListener('loadedmetadata', () => {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      required = Math.max(1, Math.floor(video.duration * 0.97));
      const vt = document.getElementById('vTime');
      if (vt) vt.textContent = `0:00 / ${fmtTime(video.duration)}`;
      updateMeter();
    }
  });

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
    ${lessonHeader(lesson, course)}
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
  const redirect = /^https?:\/\//i.test(course.completionRedirectUrl || '') ? course.completionRedirectUrl : null;
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
        ${redirect
          ? `<a class="btn btn-accent btn-lg" href="${esc(redirect)}" style="margin-left:10px">Continue →</a>`
          : `<a class="btn btn-ghost btn-lg" href="#/courses" style="margin-left:10px">Back to courses</a>`}
      </p>
      ${redirect ? `<p class="empty" id="redirectNote" style="margin-top:12px">Taking you back to NCSRA in <span id="rdCount">10</span> seconds… <a href="#/courses" id="rdStay">stay here</a></p>` : ''}
    </div>`;
  if (redirect) {
    let n = 10, cancelled = false;
    const cancel = () => { cancelled = true; window.removeEventListener('hashchange', cancel); };
    window.addEventListener('hashchange', cancel); // viewing the cert / staying cancels it
    document.getElementById('rdStay').addEventListener('click', cancel);
    const tick = () => {
      if (cancelled) return;
      n -= 1;
      const el = document.getElementById('rdCount');
      if (el) el.textContent = n;
      if (n <= 0) { window.location.href = redirect; return; }
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 1000);
  }
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
      <button class="btn btn-primary" id="dlPdfBtn">⬇ Download PDF</button>
      <button class="btn btn-ghost" id="printBtn" style="margin-left:10px">Print</button>
      <a class="btn btn-ghost" href="#/courses" style="margin-left:10px">Back to courses</a>
    </p>`;
  document.getElementById('printBtn').addEventListener('click', () => window.print());
  document.getElementById('dlPdfBtn').addEventListener('click', () => downloadCertificatePdf(c, date));
}

// ---- Client-side PDF certificate (no external library) --------------------
// Draws the certificate on a canvas, then embeds it as a JPEG in a minimal
// hand-built PDF and triggers a download. Fully self-contained (CSP-safe).
async function downloadCertificatePdf(c, dateStr) {
  const W = 1100, H = 800;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Background + gold double border
  ctx.fillStyle = '#fffdf6'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#edc32c'; ctx.lineWidth = 6; ctx.strokeRect(28, 28, W - 56, H - 56);
  ctx.lineWidth = 2; ctx.strokeRect(40, 40, W - 80, H - 80);

  const center = (t, y, font, color, spacing) => {
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = 'center';
    if (spacing) {
      ctx.save(); let total = 0; const chars = t.split('');
      const widths = chars.map((ch) => ctx.measureText(ch).width + spacing);
      total = widths.reduce((a, b) => a + b, 0) - spacing;
      let x = W / 2 - total / 2; ctx.textAlign = 'left';
      chars.forEach((ch, i) => { ctx.fillText(ch, x, y); x += widths[i]; });
      ctx.restore();
    } else ctx.fillText(t, W / 2, y);
  };

  // Logo (same-origin data-URI/PNG → canvas stays untainted). Fall back silently.
  try {
    const img = await new Promise((res, rej) => {
      const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = LOGO_SOURCES[0];
    });
    const lw = 150, lh = lw * (img.height / img.width || 1.2);
    ctx.drawImage(img, W / 2 - lw / 2, 70, lw, lh);
  } catch { /* no logo, text-only certificate */ }

  center('NORTH CAROLINA YOUTH SOCCER ASSOCIATION', 265, '600 15px Arial', '#6b645e', 3);
  center('Certificate of Completion', 320, '800 40px Georgia, serif', '#10045a');
  center('This certifies that', 385, '400 20px Arial', '#3d3833');
  center(c.learner, 445, 'italic 700 46px Georgia, serif', '#1d1a18');
  center('has successfully completed', 500, '400 20px Arial', '#3d3833');

  // Course name (shrink to fit)
  let cf = 30; ctx.font = `700 ${cf}px Arial`;
  while (ctx.measureText(c.course).width > W - 200 && cf > 16) { cf -= 1; ctx.font = `700 ${cf}px Arial`; }
  center(c.course, 555, `700 ${cf}px Arial`, '#10045a');

  center(`Completed ${dateStr}  ·  Certificate ID ${c.certId}`, 620, '400 17px Arial', '#6b645e');
  center('🏅', 690, '48px Arial', '#000');

  // Canvas → JPEG → minimal PDF
  const jpeg = canvas.toDataURL('image/jpeg', 0.92);
  const bytes = atobToBytes(jpeg.split(',')[1]);
  const pdf = jpegToPdf(bytes, W, H);
  const blob = new Blob([pdf], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `NCYSA-Certificate-${c.learner.replace(/[^a-z0-9]+/gi, '-')}.pdf`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function atobToBytes(b64) {
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// Build a one-page PDF that displays a single full-page JPEG image.
function jpegToPdf(jpegBytes, wpx, hpx) {
  // Letter landscape points; fit the image to the page preserving aspect.
  const pw = 792, ph = 612;
  const scale = Math.min(pw / wpx, ph / hpx);
  const iw = wpx * scale, ih = hpx * scale;
  const ox = (pw - iw) / 2, oy = (ph - ih) / 2;

  const enc = (s) => Array.from(s, (ch) => ch.charCodeAt(0));
  const parts = []; const offsets = []; let len = 0;
  const push = (bytesOrStr) => {
    const b = typeof bytesOrStr === 'string' ? enc(bytesOrStr) : bytesOrStr;
    parts.push(b); len += b.length;
  };
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); push(body); push('\nendobj\n'); };

  push('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  // image object with the raw JPEG stream
  offsets[4] = len;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${wpx} /Height ${hpx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
  push(jpegBytes);
  push('\nendstream\nendobj\n');
  const content = `q ${iw.toFixed(2)} 0 0 ${ih.toFixed(2)} ${ox.toFixed(2)} ${oy.toFixed(2)} cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);

  const xrefStart = len;
  push('xref\n0 6\n0000000000 65535 f \n');
  for (let i = 1; i <= 5; i++) push(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  const out = new Uint8Array(len); let p = 0;
  for (const b of parts) { out.set(b, p); p += b.length; }
  return out;
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
  if (me?.user?.role === 'editor') { location.hash = '#/admin/courses'; return; } // designers have no dashboard
  const d = await api('/api/admin/overview');
  app.innerHTML = `
    <div class="admin-wrap">
      <div class="admin-head">
        <h1>NCYSA Education Dashboard</h1>
        <div class="admin-head-actions">
          <a class="btn btn-ghost" href="#/staff-training">🎓 Staff Training</a>
          <a class="btn btn-primary" href="#/admin/courses">✏️ Manage courses</a>
        </div>
      </div>
      <p class="lead" style="color:var(--ink-soft)">${d.learnerCount} registered learner${d.learnerCount === 1 ? '' : 's'} ·
        ${d.completions.length} course completion${d.completions.length === 1 ? '' : 's'}</p>
      <div class="admin-grid">
        <div class="admin-card">
          <div class="card-head">
            <h2>🏅 Course completions (license records)</h2>
            <button class="btn btn-primary btn-sm" id="exportCsvBtn">⬇ Export CSV</button>
          </div>
          <div class="filter-bar">
            <input id="fltSearch" placeholder="Search name or email…" />
            <select id="fltCourse">
              <option value="">All courses</option>
              ${[...new Set(d.completions.map((c) => c.course).filter(Boolean))].map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
            </select>
            <label class="date-flt">From <input id="fltFrom" type="date" /></label>
            <label class="date-flt">To <input id="fltTo" type="date" /></label>
          </div>
          <div id="completionsTable"></div>
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
            A status ending in <code>-delivered</code> means it was sent for real; <code>outbox-only</code>
            means email delivery isn't configured yet.</p>
          <div class="test-email">
            <input id="testEmailTo" type="email" placeholder="you@example.com" aria-label="Test email recipient" />
            <button class="btn btn-primary btn-sm" id="testEmailBtn">Send test email</button>
            <span id="testEmailResult" class="test-email-result" role="status" aria-live="polite"></span>
          </div>
          ${d.outbox.length ? d.outbox.map((m) => `
            <div class="mail">
              <div class="mail-head"><strong>To:</strong> ${esc(m.to)} · <strong>Sent:</strong> ${new Date(m.createdAt).toLocaleString()} · <strong>Status:</strong> ${esc(m.status)}</div>
              <div><strong>${esc(m.subject)}</strong></div>
              <pre>${esc(m.body)}</pre>
            </div>`).join('') : '<p class="empty">Outbox is empty.</p>'}
        </div>
      </div>
    </div>`;

  // ---- completions: search, filter, and CSV export ----
  const rows = d.completions;
  const els = {
    search: document.getElementById('fltSearch'),
    course: document.getElementById('fltCourse'),
    from: document.getElementById('fltFrom'),
    to: document.getElementById('fltTo'),
    table: document.getElementById('completionsTable'),
  };
  function filtered() {
    const q = els.search.value.trim().toLowerCase();
    const course = els.course.value;
    const from = els.from.value ? new Date(els.from.value + 'T00:00:00') : null;
    const to = els.to.value ? new Date(els.to.value + 'T23:59:59') : null;
    return rows.filter((c) => {
      if (q && !((c.learner || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q))) return false;
      if (course && c.course !== course) return false;
      const when = new Date(c.completedAt);
      if (from && when < from) return false;
      if (to && when > to) return false;
      return true;
    });
  }
  function renderTable() {
    const list = filtered();
    els.table.innerHTML = list.length ? `
      <table class="admin-table">
        <tr><th>Learner</th><th>Email</th><th>Course</th><th>Completed</th><th>Certificate</th></tr>
        ${list.map((c) => `<tr><td>${esc(c.learner)}</td><td>${esc(c.email)}</td><td>${esc(c.course)}</td>
          <td>${new Date(c.completedAt).toLocaleString()}</td><td>${esc(c.certId)}</td></tr>`).join('')}
      </table>
      <p class="filter-count">${list.length} of ${rows.length} completion${rows.length === 1 ? '' : 's'}</p>`
      : '<p class="empty">No completions match these filters.</p>';
  }
  if (els.table) {
    ['input', 'change'].forEach((ev) => {
      els.search.addEventListener(ev, renderTable); els.course.addEventListener(ev, renderTable);
      els.from.addEventListener(ev, renderTable); els.to.addEventListener(ev, renderTable);
    });
    renderTable();
    document.getElementById('exportCsvBtn').addEventListener('click', () => {
      const list = filtered();
      const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = [['Last Name', 'First Name', 'Full Name', 'Email', 'Course', 'Completed', 'Certificate ID'].join(',')]
        .concat(list.map((c) => [c.lastName || '', c.firstName || '', c.learner, c.email, c.course, new Date(c.completedAt).toISOString(), c.certId].map(cell).join(',')))
        .join('\r\n');
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ncysa-completions-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
  }

  // ---- test email: verify delivery is configured ----
  const teBtn = document.getElementById('testEmailBtn');
  if (teBtn) {
    const teTo = document.getElementById('testEmailTo');
    const teResult = document.getElementById('testEmailResult');
    teTo.value = me?.user?.email || '';
    teBtn.addEventListener('click', async () => {
      teResult.textContent = 'Sending…'; teResult.className = 'test-email-result';
      teBtn.disabled = true;
      try {
        const r = await api('/api/admin/test-email', { method: 'POST', body: { to: teTo.value } });
        if (r.delivered) {
          teResult.textContent = `✓ Delivered to ${r.to} — check the inbox.`;
          teResult.className = 'test-email-result ok';
        } else if (r.status === 'outbox-only') {
          teResult.textContent = '⚠ Not sent: email delivery isn’t configured yet (set SMTP in Render).';
          teResult.className = 'test-email-result warn';
        } else {
          teResult.textContent = `✗ Delivery failed: ${r.status}`;
          teResult.className = 'test-email-result err';
        }
      } catch (e) {
        teResult.textContent = '✗ ' + e.message;
        teResult.className = 'test-email-result err';
      } finally { teBtn.disabled = false; }
    });
  }
}

// ---------- admin course editor ----------

async function viewCourseAdmin(flash) {
  if (!me?.user || !['admin', 'editor'].includes(me.user.role)) { location.hash = '#/staff'; return; }
  const isAdmin = me.user.role === 'admin';
  const { courses } = await api('/api/courses');
  const full = await Promise.all(courses.map((c) => api(`/api/admin/courses/${c.id}`).then((r) => r.course).catch(() => null)));
  const list = full.filter(Boolean);

  const typeLabel = { text: '📖 Reading', video: '🎬 Video', quiz: '📝 Exam' };
  app.innerHTML = `
    <div class="admin-wrap">
      <div class="admin-head">
        <div>
          <a class="back-link" href="${isAdmin ? '#/admin' : '#/'}">← ${isAdmin ? 'Dashboard' : 'Home'}</a>
          <h1>${isAdmin ? 'Manage courses' : 'Course Designer'}</h1>
          ${isAdmin ? '' : '<p class="lead" style="color:var(--ink-soft);margin:0">Build and edit courses for coaches, referees, staff, or everyone.</p>'}
        </div>
        <button class="btn btn-accent" id="newCourseBtn">＋ New course</button>
      </div>
      <div id="editorMsg" class="editor-msg"></div>
      <div id="newCoursePanel"></div>
      <div class="course-admin-list">
        ${list.map((c) => `
          <div class="admin-card course-admin" data-course="${c.id}">
            <div class="course-admin-head">
              <div>
                <span class="badge-inline">${esc(c.badge)}</span>
                ${c.published === false ? '<span class="pill-draft">● Draft — hidden</span>' : '<span class="pill-live">● Live</span>'}
                <h2>${esc(c.title)}</h2>
                <p class="meta">${c.lessons.length} lesson${c.lessons.length === 1 ? '' : 's'} · ${esc(c.tagline || '')}</p>
              </div>
              <div class="course-admin-actions">
                <button class="btn ${c.published === false ? 'btn-accent' : 'btn-ghost'} btn-sm pub-toggle" data-course="${c.id}" data-pub="${c.published === false ? '0' : '1'}">${c.published === false ? '🚀 Publish' : 'Unpublish'}</button>
                <button class="btn btn-ghost btn-sm edit-course" data-course="${c.id}">Edit details</button>
                <button class="btn btn-accent btn-sm add-lesson" data-course="${c.id}">＋ Add lesson</button>
              </div>
            </div>
            <ol class="admin-lessons">
              ${c.lessons.map((l, li) => `
                <li>
                  <span>${typeLabel[l.type] || l.type} — <strong>${esc(l.title)}</strong></span>
                  <span class="admin-lesson-actions">
                    <button class="linkbtn move-lesson" data-course="${c.id}" data-lesson="${l.id}" data-dir="up" title="Move up" ${li === 0 ? 'disabled' : ''}>↑</button>
                    <button class="linkbtn move-lesson" data-course="${c.id}" data-lesson="${l.id}" data-dir="down" title="Move down" ${li === c.lessons.length - 1 ? 'disabled' : ''}>↓</button>
                    <button class="linkbtn edit-lesson" data-course="${c.id}" data-lesson="${l.id}">Edit</button>
                    <button class="linkbtn danger del-lesson" data-course="${c.id}" data-lesson="${l.id}">Delete</button>
                  </span>
                </li>`).join('') || '<li class="empty">No lessons yet — click “Add lesson”.</li>'}
            </ol>
            <div class="panel-slot" data-course="${c.id}"></div>
          </div>`).join('')}
      </div>
    </div>`;

  const msg = (t, err) => { const e = document.getElementById('editorMsg'); e.textContent = t; e.className = 'editor-msg' + (err ? ' err' : ' ok'); };
  if (typeof flash === 'string' && flash) msg(flash); // survive re-render after a save

  document.getElementById('newCourseBtn').addEventListener('click', () => {
    document.getElementById('newCoursePanel').innerHTML = courseForm();
    bindCourseForm(null);
  });
  document.querySelectorAll('.edit-course').forEach((b) => b.addEventListener('click', () => {
    const c = list.find((x) => x.id === b.dataset.course);
    document.querySelector(`.panel-slot[data-course="${c.id}"]`).innerHTML = courseForm(c);
    bindCourseForm(c);
  }));
  document.querySelectorAll('.add-lesson').forEach((b) => b.addEventListener('click', () => {
    document.querySelector(`.panel-slot[data-course="${b.dataset.course}"]`).innerHTML = lessonForm(b.dataset.course, null);
    bindLessonForm(b.dataset.course, null);
  }));
  document.querySelectorAll('.edit-lesson').forEach((b) => b.addEventListener('click', () => {
    const c = list.find((x) => x.id === b.dataset.course);
    const l = c.lessons.find((x) => x.id === b.dataset.lesson);
    document.querySelector(`.panel-slot[data-course="${c.id}"]`).innerHTML = lessonForm(c.id, l);
    bindLessonForm(c.id, l);
  }));
  document.querySelectorAll('.del-lesson').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/admin/courses/${b.dataset.course}/lessons/${b.dataset.lesson}`, { method: 'DELETE' });
    viewCourseAdmin('Lesson deleted.');
  }));
  document.querySelectorAll('.move-lesson').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/admin/courses/${b.dataset.course}/lessons/${b.dataset.lesson}/move`, { method: 'POST', body: { dir: b.dataset.dir } });
    viewCourseAdmin('Lesson order updated.');
  }));
  document.querySelectorAll('.pub-toggle').forEach((b) => b.addEventListener('click', async () => {
    const makePublic = b.dataset.pub !== '1';
    await api(`/api/admin/courses/${b.dataset.course}/publish`, { method: 'POST', body: { published: makePublic } });
    viewCourseAdmin(makePublic ? 'Course published — learners can see it now.' : 'Course unpublished — hidden from learners.');
  }));

  function courseForm(c) {
    return `<form class="editor-form" id="courseForm">
      <h3>${c ? 'Edit course details' : 'New course'}</h3>
      <label>Title<input name="title" value="${c ? esc(c.title) : ''}" required /></label>
      <label>Tagline<input name="tagline" value="${c ? esc(c.tagline || '') : ''}" /></label>
      <label>Description<textarea name="description" rows="2">${c ? esc(c.description || '') : ''}</textarea></label>
      <div class="form-row">
        <label>Badge<input name="badge" value="${c ? esc(c.badge) : 'Course'}" /></label>
        <label>Est. minutes<input name="estMinutes" type="number" value="${c ? c.estMinutes : 30}" /></label>
      </div>
      <label>Audience
        <select name="audience">
          ${[['everyone', 'Everyone (coaches & staff)'], ['coaches', 'Coaches only'], ['referees', 'Referees only'], ['staff', 'Staff training']]
            .map(([v, t]) => `<option value="${v}" ${(c ? (c.audience || 'everyone') : 'everyone') === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </label>
      <label>When finished, send learners to (optional web address)
        <input name="completionRedirectUrl" type="url" value="${c ? esc(c.completionRedirectUrl || '') : ''}" placeholder="https://www.ncsra.org/referees" />
      </label>
      <div class="form-actions"><button class="btn btn-accent" type="submit">${c ? 'Save' : 'Create course'}</button></div>
      ${c ? '' : '<p class="form-hint">New courses start as a private <strong>Draft</strong>. Add your lessons, then click <strong>Publish</strong> when it’s ready for members.</p>'}
    </form>`;
  }
  function bindCourseForm(c) {
    document.getElementById('courseForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target).entries());
      try {
        if (c) await api(`/api/admin/courses/${c.id}`, { method: 'PUT', body: v });
        else await api('/api/admin/courses', { method: 'POST', body: v });
        viewCourseAdmin(c ? 'Course updated.' : 'Course created.');
      } catch (err) { msg(err.message, true); }
    });
  }

  function lessonForm(courseId, l) {
    const t = l ? l.type : 'text';
    return `<form class="editor-form" id="lessonForm" data-course="${courseId}">
      <h3>${l ? 'Edit lesson' : 'Add lesson'}</h3>
      <label>Lesson type
        <select name="type" id="lessonType" ${l ? 'disabled' : ''}>
          <option value="text" ${t === 'text' ? 'selected' : ''}>Reading</option>
          <option value="video" ${t === 'video' ? 'selected' : ''}>Video</option>
          <option value="quiz" ${t === 'quiz' ? 'selected' : ''}>Exam / quiz</option>
        </select>
      </label>
      <label>Title<input name="title" value="${l ? esc(l.title) : ''}" required /></label>
      <div id="typeFields"></div>
      <div class="form-actions"><button class="btn btn-accent" type="submit">${l ? 'Save lesson' : 'Add lesson'}</button></div>
    </form>`;
  }
  function typeFields(type, l) {
    if (type === 'video') return `
      ${richTextField('html', 'Intro text (optional — shows above)', l ? l.html : '', 90)}
      <label>Video URL (MP4)<input name="videoUrl" value="${l ? esc(l.videoUrl || '') : ''}" placeholder="https://…/video.mp4" /></label>
      <label>Video URL (WebM, optional — improves playback compatibility)<input name="videoUrlWebm" value="${l ? esc(l.videoUrlWebm || '') : ''}" placeholder="https://…/video.webm" /></label>
      <div class="form-row">
        <label>Duration (seconds)<input name="durationSeconds" type="number" value="${l ? l.durationSeconds : 60}" /></label>
        <label>Must-watch (seconds)<input name="minWatchSeconds" type="number" value="${l ? l.minWatchSeconds : ''}" placeholder="auto = duration − 2" /></label>
      </div>`;
    if (type === 'quiz') {
      const qs = l ? l.questions : [{ prompt: '', options: ['', ''], answer: 0 }];
      return `${richTextField('html', 'Intro text (optional — shows above)', l ? l.html : '', 90)}
        <label>Pass mark (%)<input name="passPercent" type="number" value="${l ? l.passPercent : 80}" /></label>
        <div id="quizQs">${qs.map((q, i) => quizQ(q, i)).join('')}</div>
        <button type="button" class="btn btn-ghost btn-sm" id="addQ">＋ Add question</button>`;
    }
    return richTextField('html', 'Lesson content', l ? l.html : '', 240);
  }
  function quizQ(q, i) {
    return `<div class="quiz-edit" data-qi="${i}">
      <label>Question ${i + 1}<input name="q_prompt_${i}" value="${esc(q.prompt || '')}" /></label>
      ${[0, 1, 2, 3].map((oi) => `<label class="opt-row"><input type="radio" name="q_answer_${i}" value="${oi}" ${Number(q.answer) === oi ? 'checked' : ''} /> <input name="q_opt_${i}_${oi}" value="${esc((q.options || [])[oi] || '')}" placeholder="Option ${oi + 1}" /></label>`).join('')}
    </div>`;
  }
  function bindLessonForm(courseId, l) {
    const form = document.getElementById('lessonForm');
    const sel = document.getElementById('lessonType');
    const render = () => {
      document.getElementById('typeFields').innerHTML = typeFields(sel.value, l);
      initRichText(document.getElementById('typeFields'));
      const addQ = document.getElementById('addQ');
      if (addQ) addQ.addEventListener('click', () => {
        const qs = document.getElementById('quizQs');
        qs.insertAdjacentHTML('beforeend', quizQ({ prompt: '', options: ['', ''], answer: 0 }, qs.children.length));
      });
    };
    sel.addEventListener('change', render);
    render();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      // Make sure the visual editor's latest HTML is captured before submit.
      form.querySelectorAll('.rte').forEach((rte) => {
        const a = rte.querySelector('.rte-area'), o = rte.querySelector('.rte-html');
        if (a && o) o.value = a.innerHTML;
      });
      const fd = new FormData(form);
      const type = l ? l.type : fd.get('type');
      const payload = { type, title: fd.get('title'), html: fd.get('html') || '' };
      if (type === 'video') { payload.videoUrl = fd.get('videoUrl'); payload.videoUrlWebm = fd.get('videoUrlWebm') || undefined; payload.durationSeconds = fd.get('durationSeconds'); payload.minWatchSeconds = fd.get('minWatchSeconds'); }
      if (type === 'quiz') {
        payload.passPercent = fd.get('passPercent');
        const qEls = form.querySelectorAll('.quiz-edit');
        payload.questions = Array.from(qEls).map((el) => {
          const i = el.dataset.qi;
          return {
            prompt: fd.get(`q_prompt_${i}`),
            answer: fd.get(`q_answer_${i}`),
            options: [0, 1, 2, 3].map((oi) => fd.get(`q_opt_${i}_${oi}`)).filter((x) => x && x.trim()),
          };
        });
      }
      try {
        if (l) await api(`/api/admin/courses/${courseId}/lessons/${l.id}`, { method: 'PUT', body: payload });
        else await api(`/api/admin/courses/${courseId}/lessons`, { method: 'POST', body: payload });
        viewCourseAdmin('Lesson saved.');
      } catch (err) { msg(err.message, true); }
    });
  }
}

// ---------- rich-text editor (visual formatting, no HTML needed) ----------
// A dependency-free WYSIWYG field for lesson content. Course designers click
// buttons (Bold, Heading, bullets, links…) instead of writing HTML. The visible
// editor mirrors the learner's reading styles, and its HTML is kept in a hidden
// <textarea name="..."> so the existing form submit (FormData) is unchanged.
function richTextField(name, labelText, html, minHeight) {
  const min = minHeight || 200;
  return `<div class="rte-field">
    <span class="rte-label">${labelText}</span>
    <div class="rte">
      <div class="rte-toolbar" role="toolbar" aria-label="Text formatting">
        <button type="button" class="rte-btn" data-cmd="bold" title="Bold"><b>B</b></button>
        <button type="button" class="rte-btn" data-cmd="italic" title="Italic"><i>I</i></button>
        <span class="rte-sep"></span>
        <button type="button" class="rte-btn" data-block="h2" title="Big heading">Heading</button>
        <button type="button" class="rte-btn" data-block="h3" title="Small heading">Subheading</button>
        <button type="button" class="rte-btn" data-block="p" title="Normal paragraph text">Normal</button>
        <span class="rte-sep"></span>
        <button type="button" class="rte-btn" data-cmd="insertUnorderedList" title="Bulleted list">• Bullets</button>
        <button type="button" class="rte-btn" data-cmd="insertOrderedList" title="Numbered list">1. Numbered</button>
        <button type="button" class="rte-btn" data-block="blockquote" title="Quote / callout">❝ Quote</button>
        <span class="rte-sep"></span>
        <button type="button" class="rte-btn" data-cmd="justifyLeft" title="Align left">↤ Left</button>
        <button type="button" class="rte-btn" data-cmd="justifyCenter" title="Center">↔ Center</button>
        <span class="rte-sep"></span>
        <button type="button" class="rte-btn" data-img="1" title="Insert an image by link">🖼 Image</button>
        <button type="button" class="rte-btn" data-hr="1" title="Divider line">— Divider</button>
        <span class="rte-sep"></span>
        <button type="button" class="rte-btn" data-link="1" title="Add a link">🔗 Link</button>
        <button type="button" class="rte-btn" data-cmd="removeFormat" title="Clear formatting">✕ Clear</button>
      </div>
      <div class="rte-area lesson-content" contenteditable="true" data-placeholder="Type the lesson here. Use the buttons above to add headings, bullet points, and links."
           style="min-height:${min}px">${html || ''}</div>
      <textarea name="${name}" class="rte-html" hidden>${esc(html || '')}</textarea>
    </div>
  </div>`;
}

function initRichText(root) {
  (root || document).querySelectorAll('.rte').forEach((rte) => {
    if (rte.dataset.ready) return;
    rte.dataset.ready = '1';
    const area = rte.querySelector('.rte-area');
    const out = rte.querySelector('.rte-html');
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { /* ignore */ }
    // Normalize only the SAVED html (on a clone, so the live cursor is untouched):
    // browsers sometimes wrap lists/headings in a stray <p>, and leave empty <p>s.
    const sync = () => {
      const tmp = area.cloneNode(true);
      tmp.querySelectorAll('p > ul, p > ol, p > blockquote, p > h2, p > h3').forEach((el) => {
        if (el.parentElement.children.length === 1) el.parentElement.replaceWith(el);
      });
      tmp.querySelectorAll('p').forEach((p) => { if (!p.textContent.trim() && !p.querySelector('img,br')) p.remove(); });
      out.value = tmp.innerHTML;
    };
    area.addEventListener('input', sync);
    area.addEventListener('blur', sync);
    rte.querySelectorAll('.rte-btn').forEach((b) => {
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the text selection
      b.addEventListener('click', () => {
        area.focus();
        try {
          if (b.dataset.cmd) document.execCommand(b.dataset.cmd, false, null);
          else if (b.dataset.block) document.execCommand('formatBlock', false, '<' + b.dataset.block + '>');
          else if (b.dataset.link) {
            const url = prompt('Link address (e.g. https://ncysa.org):');
            if (url) document.execCommand('createLink', false, url.trim());
          } else if (b.dataset.img) {
            const url = prompt('Image link — paste the web address of an image (e.g. from your website’s media library, ending in .jpg or .png):');
            if (url) {
              const alt = (prompt('Briefly describe the image (helps accessibility). Optional:') || '');
              const q = (s) => s.replace(/"/g, '&quot;').replace(/</g, '&lt;');
              document.execCommand('insertHTML', false, `<img src="${q(url.trim())}" alt="${q(alt)}">`);
            }
          } else if (b.dataset.hr) {
            document.execCommand('insertHTML', false, '<hr>');
          }
        } catch (e) { /* ignore unsupported command */ }
        sync();
      });
    });
    sync();
  });
}

// ---------- help / knowledge base ----------

// Knowledge Base articles shown to learners taking courses. Rendered as an
// accessible accordion (<details>). Keep the language plain and reassuring.
const KB_LEARNER = [
  {
    q: 'How do I sign up and start a course?',
    a: `<p>Click <strong>Get started</strong> (or <strong>Sign in</strong>) at the top and create a free
        account with your name and email — no password needed. Then open <strong>Courses</strong>,
        pick one, and click <strong>Enroll</strong> to begin. Your spot is saved to your email.</p>`,
  },
  {
    q: 'Why can’t I open a later lesson yet?',
    a: `<p>Lessons unlock <strong>in order</strong> — each one opens only after you finish the one
        before it. This makes sure everyone covers the material in sequence. Finish the current
        lesson and the next will unlock automatically.</p>`,
  },
  {
    q: 'The video jumped back / I can’t skip ahead — is it broken?',
    a: `<p>No, that’s on purpose. Video lessons track your <strong>real watch time</strong>, so
        fast-forwarding snaps back and you need to watch nearly the whole clip before you can
        continue. Just let it play — the “Continue” button unlocks when you’ve watched enough.</p>`,
  },
  {
    q: 'How does the exam / quiz work?',
    a: `<p>Answer the questions and submit. It’s <strong>graded instantly</strong>, and you need to
        reach the pass mark shown on the exam (often 80%). Didn’t pass? No problem —
        you get <strong>unlimited retakes</strong>. Review the lesson and try again.</p>`,
  },
  {
    q: 'When do I get my certificate?',
    a: `<p>The moment you complete a course, your <strong>certificate is issued automatically</strong>
        with a unique ID, and NCYSA is notified of your completion. You’ll see a link to view and
        print it, and you can find it again from your course list any time.</p>`,
  },
  {
    q: 'Can I stop and come back later?',
    a: `<p>Yes. Your progress saves as you go. When you return and sign in with the same email,
        you’ll see a <strong>“Resume where you left off”</strong> button that drops you right back in.</p>`,
  },
  {
    q: 'The site was slow to load the first time.',
    a: `<p>On the very first visit after a quiet period, the site can take up to <strong>~50 seconds</strong>
        to wake up, then it’s fast. Give it a moment and refresh if needed — nothing is wrong.</p>`,
  },
  {
    q: 'What do you do with my email?',
    a: `<p>It’s only used to <strong>save your progress</strong> and send your completion certificate.
        No password is required and nothing is shared elsewhere.</p>`,
  },
  {
    q: 'I’m stuck or something looks wrong.',
    a: `<p>Try refreshing the page first. If it persists, contact your NCYSA administrator with the
        course name and what you were doing — they can look into it.</p>`,
  },
];

function kbAccordion(items) {
  return `<div class="kb-list">${items.map((it) => `
    <details class="kb-item">
      <summary>${it.q}</summary>
      <div class="kb-body">${it.a}</div>
    </details>`).join('')}</div>`;
}

function viewHelp() {
  const role = me?.user?.role;
  const isDesigner = role === 'editor' || role === 'admin';
  app.innerHTML = `
    <section class="section">
      <a class="back-link" href="${role ? roleHome(role) : '#/'}">← Back</a>
      <h2>Help &amp; Knowledge Base</h2>
      <p class="lead">Answers to common questions about taking courses on NCYSA Learn.
        Can’t find what you need? Reach out to your NCYSA administrator.</p>

      <h3 class="kb-heading">📘 Knowledge Base articles — for learners</h3>
      ${kbAccordion(KB_LEARNER)}

      ${isDesigner ? `
        <h3 class="kb-heading">🛠️ Course designer resources</h3>
        <div class="card kb-resources">
          <p>Building courses? These guides walk you through everything — signing in, creating a
            course, and adding reading, video, and quiz lessons.</p>
          <p class="kb-downloads">
            <a class="btn btn-primary" href="/docs/NCYSA_Getting_Started.pdf" target="_blank" rel="noopener">📄 Getting Started guide (PDF)</a>
            <a class="btn btn-ghost" href="/docs/NCYSA_Knowledge_Desk.pdf" target="_blank" rel="noopener">📚 Knowledge Desk reference (PDF)</a>
          </p>
          <ul class="kb-reminders">
            <li><strong>New courses start as a private Draft.</strong> Members can’t see a course until you click <strong>🚀 Publish</strong> on it. Build it, add your lessons, then publish when it’s ready. (Look for the <strong>Draft</strong> / <strong>● Live</strong> badge next to each course.) You can Unpublish any time to hide it again.</li>
            <li><strong>Everything auto-saves</strong> as you type — there’s no separate “save the course” step.</li>
            <li><strong>Formatting is button-based — no code needed.</strong> In a Reading lesson, select your text and use the toolbar: <strong>Heading</strong>, <strong>Bold</strong>, <strong>• Bullets</strong>, <strong>Quote</strong>, alignment, and more. What you see in the editor is what learners see.</li>
            <li><strong>Add a picture:</strong> click <strong>🖼 Image</strong> and paste the image’s web link (e.g. from your WordPress media library), then add a short description. Pictures automatically fit phones and desktops.</li>
            <li><strong>Reorder lessons</strong> with the <strong>↑ ↓</strong> arrows next to each lesson — no need to delete and re-add.</li>
            <li><strong>Graded quizzes:</strong> use the built-in quiz builder — it grades automatically and issues the certificate. A Google Form/JotForm can be embedded in a Reading lesson for surveys, but the app can’t grade or track those.</li>
            <li><strong>Videos:</strong> paste a link (WordPress media library for now; shared Dropbox later).</li>
            <li><strong>Share a course:</strong> publish it, then open it and copy the web address from your browser’s address bar — that’s the learner link.</li>
          </ul>
        </div>` : ''}
    </section>`;
}

// ---------- router ----------

const routes = [
  { re: /^#?\/?$/, fn: viewHome },
  { re: /^#\/courses$/, fn: viewCatalog },
  { re: /^#\/referees$/, fn: viewReferees },
  { re: /^#\/login$/, fn: viewLogin },
  { re: /^#\/staff$/, fn: viewStaffLogin },
  { re: /^#\/register$/, fn: viewRegister },
  { re: /^#\/course\/([\w-]+)$/, fn: (m) => viewCourse(m[1]) },
  { re: /^#\/course\/([\w-]+)\/lesson\/([\w-]+)$/, fn: (m) => viewCourse(m[1], m[2]) },
  { re: /^#\/cert\/([\w-]+)$/, fn: (m) => viewCertificate(m[1]) },
  { re: /^#\/notifications$/, fn: viewNotifications },
  { re: /^#\/admin$/, fn: viewAdmin },
  { re: /^#\/admin\/courses$/, fn: viewCourseAdmin },
  { re: /^#\/staff-training$/, fn: viewStaffTraining },
  { re: /^#\/help$/, fn: viewHelp },
];

function startLoading() {
  const bar = document.getElementById('loadbar');
  if (bar) { bar.classList.add('active'); bar.style.width = '45%'; requestAnimationFrame(() => (bar.style.width = '75%')); }
  // Show a spinner only if the view is slow to load (avoids flicker on instant/local data).
  return setTimeout(() => { app.innerHTML = '<div class="loading-state" role="status" aria-live="polite"><div class="spinner"></div><span>Loading…</span></div>'; }, 200);
}
function stopLoading(spinnerTimer) {
  clearTimeout(spinnerTimer);
  const bar = document.getElementById('loadbar');
  if (bar) { bar.style.width = '100%'; setTimeout(() => { bar.classList.remove('active'); bar.style.width = '0'; }, 250); }
}

async function route() {
  if (videoTracker) { videoTracker.flush(); videoTracker = null; }
  const hash = location.hash || '#/';
  for (const r of routes) {
    const m = hash.match(r.re);
    if (m) {
      const spinnerTimer = startLoading();
      try { await r.fn(m); } catch (e) {
        if (e.status === 401) { stopLoading(spinnerTimer); location.hash = '#/login'; return; }
        app.innerHTML = `<div class="section"><div class="card"><h2>Something went wrong</h2><p class="sub">${esc(e.message)}</p></div></div>`;
      }
      stopLoading(spinnerTimer);
      window.scrollTo(0, 0);
      return;
    }
  }
  location.hash = '#/';
}

window.addEventListener('hashchange', route);
(async function init() {
  // Accessibility + loading chrome (added once, works in product and demo builds).
  if (!document.getElementById('loadbar')) {
    const bar = document.createElement('div'); bar.id = 'loadbar'; document.body.appendChild(bar);
    const skip = document.createElement('a'); skip.href = '#main'; skip.className = 'skip-link'; skip.textContent = 'Skip to content';
    document.body.insertBefore(skip, document.body.firstChild);
    app.id = 'app'; app.setAttribute('tabindex', '-1');
    if (!app.getAttribute('id')) app.id = 'app';
    app.setAttribute('role', 'main');
    const anchor = document.createElement('span'); anchor.id = 'main'; app.parentNode.insertBefore(anchor, app);
  }
  await refreshMe();
  await route();
})();
