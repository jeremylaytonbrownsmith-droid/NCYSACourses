// An Evolve (Intellum) web export — US Soccer's Mentor Foundations modules — is
// its own kind of upload. It never talks to the LMS and is completed by watching
// its course outline, so it must NOT be treated as a presenter-style HTML
// package (Mentor+): no 📘 "Review Independently" guide, no manual "mark it
// complete" fallback (a skip hole on a module that can't self-report). The
// uploader classifies it as kind "evolve", and a lesson that was saved with
// htmlPackage:true before Evolve was recognised is corrected on the way out.
const { test, expect } = require('@playwright/test');
const AdmZip = require('adm-zip');

const BASE = 'http://localhost:3100';
const DESIGNER = { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' };

function evolveZip() {
  const zip = new AdmZip();
  zip.addFile('WRAP/index.html', Buffer.from('<!DOCTYPE html><html><head><title>1 - Mentor Foundations</title><link href="assets/main.css" rel="stylesheet"/></head><body class="h-full"><div id="ev-root"></div><script type="module" src="assets/main.min.js"></script></body></html>', 'utf8'));
  zip.addFile('WRAP/course.json', Buffer.from('{"config":{"publish":{"type":"web","useLocalStorage":false}},"pages":[]}', 'utf8'));
  zip.addFile('WRAP/manifest.json', Buffer.from('{"assets":[],"version":1}', 'utf8'));
  zip.addFile('WRAP/assets/main.min.js', Buffer.from('// evolve runtime', 'utf8'));
  zip.addFile('WRAP/assets/main.css', Buffer.from('body{}', 'utf8'));
  return zip.toBuffer();
}

test('an Evolve web export uploads as kind "evolve" and never carries the htmlPackage flag', async ({ page, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: DESIGNER })).ok()).toBeTruthy();
  const up = await (await api.post(`/api/admin/scorm?name=Evolve${Date.now()}`, { headers: { 'content-type': 'application/zip' }, data: evolveZip() })).json();
  expect(up.kind).toBe('evolve');                     // not "html" — the Designer leaves htmlPackage off
  expect(up.launchFile).toBe('index.html');           // wrapper folder stripped as usual
  expect(up.title).toBe('1 - Mentor Foundations');

  // A lesson saved with htmlPackage:true (an older re-upload) is corrected on read,
  // for the learner's course payload AND the Designer's admin payload.
  const course = (await (await api.post('/api/admin/courses', { data: { title: `Mentor Evolve ${Date.now()}`, audience: 'referees' } })).json()).course;
  await api.put(`/api/admin/courses/${course.id}`, { data: { instructions: '<p>Mentor eligibility note</p>' } });
  await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'scorm', title: 'Mentor Foundations', packageId: up.packageId, launchFile: up.launchFile, htmlPackage: true, minMinutes: 0 } });
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });
  const adminLesson = (await (await api.get(`/api/admin/courses/${course.id}`)).json()).course.lessons[0];
  expect(adminLesson.htmlPackage).toBe(false);

  const learner = await playwright.request.newContext({ baseURL: BASE });
  await learner.post('/api/register', { data: { firstName: 'Evo', lastName: 'Learner', email: `evo+${Date.now()}@example.com` } });
  await learner.post(`/api/courses/${course.id}/enroll`);
  const pub = (await (await learner.get(`/api/courses/${course.id}`)).json()).course.lessons[0];
  expect(pub.htmlPackage).toBe(false);

  // In the player: no Mentor+ guide, no manual mark-complete row; the course's
  // Start Here text stays in its own box above the player.
  await page.context().addCookies((await learner.storageState()).cookies);
  await page.goto(`/#/course/${course.id}/lesson/${adminLesson.id}`);
  await expect(page.locator('#scormFrame')).toBeVisible();
  await expect(page.locator('#moduleGuide')).toHaveCount(0);
  await expect(page.locator('#htmlDoneRow')).toHaveCount(0);
  await expect(page.locator('.course-intro')).toContainText('Mentor eligibility note');
});

test('a plain HTML page (no Evolve signature) is still kind "html"', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: DESIGNER })).ok()).toBeTruthy();
  const zip = new AdmZip();
  zip.addFile('index.html', Buffer.from('<!doctype html><title>Plain</title><p>Hi</p>', 'utf8'));
  zip.addFile('assets/main.min.js', Buffer.from('// not evolve: no ev-root, no course.json', 'utf8'));
  const up = await (await api.post(`/api/admin/scorm?name=Plain${Date.now()}`, { headers: { 'content-type': 'application/zip' }, data: zip.toBuffer() })).json();
  expect(up.kind).toBe('html');
});
