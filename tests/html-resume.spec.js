// Does an HTML-package module save the learner's place? The player decides from
// EVIDENCE, never a hard-coded claim. A package that writes a bookmark / suspend
// blob through our SCORM API (US Soccer's Mentor+ does, on every slide) resumes
// where the learner left off — on any device — and the 📘 guide + hint say so,
// with no "finish in one sitting" banner. A plain page that never touches the
// API keeps its place (if at all) in memory only, so after 90s of use it gets
// the banner, the leave guards and the one-sitting wording.
const { test, expect } = require('@playwright/test');
const AdmZip = require('adm-zip');

const BASE = 'http://localhost:3100';
const DESIGNER = { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' };

// Mirrors the Mentor+ bridge (its js/scorm.js + the state.js/app.js boot): find
// window.API up the parent chain, Initialize, restore from cmi.suspend_data FIRST,
// and save a bookmark + suspend blob through LMSSetValue/LMSCommit on navigation.
const BRIDGE = `(function () {
  function findAPI(w) { var t = 0; while (w && t < 12) { if (w.API) return w.API; if (w.parent && w.parent !== w) { w = w.parent; t++; continue; } break; } return null; }
  var api = findAPI(window), out = document.getElementById('out');
  if (!api) { out.textContent = 'NO-API'; return; }
  api.LMSInitialize('');
  if (String(api.LMSGetValue('cmi.core.lesson_status')) === 'not attempted') { api.LMSSetValue('cmi.core.lesson_status', 'incomplete'); api.LMSCommit(''); }
  var sd = String(api.LMSGetValue('cmi.suspend_data') || '');
  out.textContent = sd ? 'RESUMED:' + JSON.parse(sd).i + ':' + api.LMSGetValue('cmi.core.lesson_location') : 'FRESH';
  document.getElementById('go').addEventListener('click', function () {
    api.LMSSetValue('cmi.core.lesson_location', 'item-57');
    api.LMSSetValue('cmi.suspend_data', JSON.stringify({ v: 2, i: 56, c: 'review', p: 'slide' }));
    api.LMSCommit('');
    out.textContent = 'SAVED';
  });
})();`;

function pkg({ bridge }) {
  const zip = new AdmZip();
  zip.addFile('index.html', Buffer.from(`<!doctype html><title>Mod</title><body><p id="out">loading</p><button id="go">next</button>${bridge ? '<script src="js/bridge.js"></script>' : ''}</body>`, 'utf8'));
  if (bridge) zip.addFile('js/bridge.js', Buffer.from(BRIDGE, 'utf8'));
  return zip.toBuffer();
}

async function setup(playwright, { bridge }) {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: DESIGNER })).ok()).toBeTruthy();
  const up = await (await api.post(`/api/admin/scorm?name=Resume${Date.now()}`, { headers: { 'content-type': 'application/zip' }, data: pkg({ bridge }) })).json();
  expect(up.kind).toBe('html');
  const course = (await (await api.post('/api/admin/courses', { data: { title: `Resume ${bridge ? 'Saves' : 'Plain'} ${Date.now()}`, audience: 'referees' } })).json()).course;
  await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'scorm', title: 'Module', packageId: up.packageId, launchFile: up.launchFile, htmlPackage: true, minMinutes: 0 } });
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });
  const lessonId = (await (await api.get(`/api/admin/courses/${course.id}`)).json()).course.lessons[0].id;
  const learner = await playwright.request.newContext({ baseURL: BASE });
  await learner.post('/api/register', { data: { firstName: 'Resume', lastName: 'Learner', email: `resume+${Date.now()}@example.com` } });
  await learner.post(`/api/courses/${course.id}/enroll`);
  const state = async () => (await (await learner.get(`/api/courses/${course.id}`)).json()).progress.lessons[0].scorm;
  return { api, learner, course, lessonId, state, cookies: (await learner.storageState()).cookies, url: `/#/course/${course.id}/lesson/${lessonId}` };
}

test('a package that bookmarks through the LMS resumes on reload and on another device, and the wording says so', async ({ page, browser, playwright }) => {
  const s = await setup(playwright, { bridge: true });
  await page.context().addCookies(s.cookies);
  page.on('dialog', (d) => d.accept());
  await page.goto(s.url);
  const out = page.frameLocator('#scormFrame').locator('#out');
  await expect(out).toHaveText('FRESH');
  // Nothing is known yet → no scare banner, and no "saved" promise either.
  await expect(page.locator('#evoWarn')).toHaveCount(0);
  await expect(page.locator('#mgSave')).toHaveText('');
  await expect(page.locator('#scormSaved')).toHaveText('');

  await page.frameLocator('#scormFrame').locator('#go').click();
  await expect(out).toHaveText('SAVED');
  // The bookmark write is the evidence: wording flips to "saved", still no banner.
  await expect(page.locator('#mgSave')).toContainText('Your place is saved');
  await expect(page.locator('#scormSaved')).toContainText('saved');
  await expect(page.locator('#evoWarn')).toHaveCount(0);
  await expect.poll(async () => (await s.state()).location).toBe('item-57');
  expect((await s.state()).suspendData).toContain('"i":56');

  await page.reload();
  await expect(out).toHaveText('RESUMED:56:item-57');                    // restored from our record
  await expect(page.locator('#mgSave')).toContainText('Your place is saved'); // known up front this time
  await expect(page.locator('#evoWarn')).toHaveCount(0);

  const other = await browser.newContext();                                // "another device": no localStorage
  await other.addCookies(s.cookies);
  const p2 = await other.newPage();
  await p2.goto(BASE + s.url);
  await expect(p2.frameLocator('#scormFrame').locator('#out')).toHaveText('RESUMED:56:item-57');
  await other.close();
  expect((await s.state()).suspendData).toContain('"i":56');              // heartbeats never wiped it
});

test('a plain page that never touches the LMS gets the one-sitting warning and guards after 90s of use', async ({ page, playwright }) => {
  const s = await setup(playwright, { bridge: false });
  await page.context().addCookies(s.cookies);
  await page.goto(s.url);
  await expect(page.frameLocator('#scormFrame').locator('#out')).toHaveText('loading');
  await expect(page.locator('#evoWarn')).toHaveCount(0);                  // not assumed up front
  await expect(page.locator('#mgSave')).toHaveText('');
  // Accrue 90s of module time server-side (what the heartbeat would do over 90
  // real seconds); the next heartbeat's response carries it back to the player.
  for (let i = 0; i < 18; i++) await s.learner.post(`/api/courses/${s.course.id}/lessons/${s.lessonId}/scorm`, { data: { activeDelta: 5 } });
  await expect(page.locator('#evoWarn')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#evoWarn')).toContainText('Finish this module in one sitting');
  await expect(page.locator('#mgSave')).toContainText('does not save your place');
  await expect(page.locator('#mgSaveEnd')).toContainText('start this module over');
  await expect(page.locator('#scormSaved')).toHaveText('');
});
