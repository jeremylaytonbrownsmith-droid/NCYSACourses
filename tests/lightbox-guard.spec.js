// Evolve's "click to enlarge" opens a fixed overlay INSIDE the module frame, so
// its close ✕ sits at the top of the frame — scrolled off screen whenever the
// learner is partway down the page. They see a full-screen picture with no way
// out and press browser Back, which on a module that keeps no saved place meant
// starting over (reported on Mentor module 1, "The Coaching Pathway"). The
// player now brings the frame top into view when an overlay opens, and Back
// closes the overlay instead of offering to leave.
const { test, expect } = require('@playwright/test');
const AdmZip = require('adm-zip');

const BASE = 'http://localhost:3100';
const DESIGNER = { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' };

// An Evolve-shaped module: #ev-root + a course outline (so the player detects
// Evolve and arms the leave guard), an image partway down that opens a fixed
// overlay with a Close button, like Evolve's lightbox.
function evolveZip() {
  const html = `<!DOCTYPE html><html><head><title>1 - Mentor Foundations</title>
<style>body{margin:0;font-family:sans-serif}.ev-lightbox{position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:flex-start;justify-content:flex-end}.ev-lightbox button{margin:12px;font-size:20px}</style></head>
<body><div id="ev-root">
  <nav><div class="ev-course-outline-page-item">Welcome, Mentor</div><div class="ev-course-outline-page-item">The Coaching Pathway</div></nav>
  <div style="height:380px"></div>
  <h1>The Coaching Pathway</h1>
  <img id="pathway" alt="Mentor → Mentor+ → Referee Coach → National Referee Coach" width="300" height="120" style="background:#cfd8e3;display:block">
  <div style="height:1400px"></div>
</div>
<script>
  document.getElementById('pathway').addEventListener('click', function () {
    var lb = document.createElement('div'); lb.className = 'ev-lightbox'; lb.setAttribute('role', 'dialog');
    var x = document.createElement('button'); x.setAttribute('aria-label', 'Close'); x.textContent = '✕';
    x.addEventListener('click', function () { lb.remove(); });
    lb.appendChild(x); document.body.appendChild(lb);
  });
</script><script type="module" src="assets/main.min.js"></script></body></html>`;
  const zip = new AdmZip();
  zip.addFile('index.html', Buffer.from(html, 'utf8'));
  zip.addFile('course.json', Buffer.from('{"config":{"publish":{"type":"web","useLocalStorage":false}}}', 'utf8'));
  zip.addFile('manifest.json', Buffer.from('{"assets":[],"version":1}', 'utf8'));
  zip.addFile('assets/main.min.js', Buffer.from('// evolve runtime stand-in', 'utf8'));
  return zip.toBuffer();
}

test('an enlarged image brings the frame top into view, and Back closes it instead of leaving the module', async ({ page, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: DESIGNER })).ok()).toBeTruthy();
  const up = await (await api.post(`/api/admin/scorm?name=Lightbox${Date.now()}`, { headers: { 'content-type': 'application/zip' }, data: evolveZip() })).json();
  expect(up.kind).toBe('evolve');
  const course = (await (await api.post('/api/admin/courses', { data: { title: `Mentor Lightbox ${Date.now()}`, audience: 'referees' } })).json()).course;
  await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'scorm', title: 'Mentor Foundations', packageId: up.packageId, launchFile: up.launchFile, minMinutes: 0 } });
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });
  const lessonId = (await (await api.get(`/api/admin/courses/${course.id}`)).json()).course.lessons[0].id;
  const learner = await playwright.request.newContext({ baseURL: BASE });
  await learner.post('/api/register', { data: { firstName: 'Jay', lastName: 'Tester', email: `jay+${Date.now()}@example.com` } });
  await learner.post(`/api/courses/${course.id}/enroll`);
  await page.context().addCookies((await learner.storageState()).cookies);

  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  await page.goto(`/#/course/${course.id}/lesson/${lessonId}`);
  const frame = page.frameLocator('#scormFrame');
  await expect(frame.locator('#pathway')).toBeVisible();
  await expect(page.locator('#evoWarn')).toBeVisible({ timeout: 10000 });   // Evolve detected → leave guard armed

  // Learner scrolled down the page: the frame's top edge (where the lightbox's ✕
  // lives) slides UNDER the sticky site header, so the ✕ is covered.
  const frameTop = () => page.evaluate(() => document.getElementById('scormFrame').getBoundingClientRect().top);
  const navH = await page.evaluate(() => document.querySelector('.topnav').offsetHeight);
  expect(navH).toBeGreaterThan(40);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  expect(await frameTop()).toBeLessThan(navH);

  await frame.locator('#pathway').click();
  await expect(frame.locator('.ev-lightbox')).toBeVisible();
  await expect.poll(frameTop, { timeout: 5000 }).toBeGreaterThanOrEqual(navH); // ✕ out from under the header

  // Back closes the picture — no "leave this module?" prompt, still on the lesson.
  await page.evaluate(() => history.back());
  await expect(frame.locator('.ev-lightbox')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(dialogs).toEqual([]);
  await expect(page.locator('#scormFrame')).toBeVisible();
  expect(page.url()).toContain(`/lesson/${lessonId}`);

  // With nothing open, Back still asks before leaving (the existing guard), and
  // declining keeps the module exactly where it was.
  await page.evaluate(() => history.back());
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toContain('Leave this module');
  await expect(page.locator('#scormFrame')).toBeVisible();
  await expect(frame.locator('#pathway')).toBeVisible();
});
