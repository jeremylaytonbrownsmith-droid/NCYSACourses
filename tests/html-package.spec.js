// HTML "Web" packages (e.g. US Soccer exports that only ship as HTML, not SCORM):
// the uploader accepts a .zip whose root has an index.html (no imsmanifest), and
// the module tracks the same way — time gate + a "mark complete" step — so it gets
// enrollment, time, completion, and a certificate like any other module.
const { test, expect } = require('@playwright/test');
const AdmZip = require('adm-zip');

const BASE = 'http://localhost:3100';
const DESIGNER = { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' };

function htmlZip({ wrap = false } = {}) {
  const zip = new AdmZip();
  const p = (n) => (wrap ? `course_folder/${n}` : n); // optional wrapping folder to strip
  zip.addFile(p('index.html'), Buffer.from('<!doctype html><title>Mentor Foundations</title><p>Hi</p>', 'utf8'));
  zip.addFile(p('assets/app.js'), Buffer.from('// x', 'utf8'));
  return zip.toBuffer();
}

test('an HTML package (no imsmanifest, has index.html) uploads as kind "html"', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: DESIGNER })).ok()).toBeTruthy();
  const res = await api.post(`/api/admin/scorm?name=HtmlMod${Date.now()}`, { headers: { 'content-type': 'application/zip' }, data: htmlZip({ wrap: true }) });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.kind).toBe('html');
  expect(body.launchFile).toBe('index.html'); // wrapper folder stripped
  expect(body.packageId).toBeTruthy();
});

test('a lesson from an HTML package carries the htmlPackage flag and no forced timer', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: DESIGNER })).ok()).toBeTruthy();
  const up = await (await api.post(`/api/admin/scorm?name=Html${Date.now()}`, { headers: { 'content-type': 'application/zip' }, data: htmlZip() })).json();
  const course = (await (await api.post('/api/admin/courses', { data: { title: `HTML Course ${Date.now()}`, audience: 'referees' } })).json()).course;
  // No minMinutes → no time gate; the module gates itself and the learner marks it complete.
  await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'scorm', title: 'Mentor Foundations', packageId: up.packageId, launchFile: up.launchFile, htmlPackage: true } });
  const lesson = (await (await api.get(`/api/admin/courses/${course.id}`)).json()).course.lessons[0];
  expect(lesson.htmlPackage).toBe(true);
  expect(lesson.minSeconds).toBe(0);
});

test('import keeps a media/ folder that sits BESIDE (not under) index.html', async ({ playwright }) => {
  // The US Soccer "Mentor+" bug: a big package unpacks into one wrapper folder,
  // with index.html in app/ and the real videos in a sibling media/ folder. The
  // extractor must strip ONLY the wrapper, never index.html's own folder, or the
  // videos (and their audio) are silently dropped.
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: DESIGNER })).ok()).toBeTruthy();
  const zip = new AdmZip();
  zip.addFile('WRAP/app/index.html', Buffer.from('<!doctype html><title>Mentor+</title><video src="../media/clip.mp4"></video>', 'utf8'));
  zip.addFile('WRAP/app/assets/main.js', Buffer.from('// player', 'utf8'));
  zip.addFile('WRAP/media/clip.mp4', Buffer.from('FAKE-MP4-WITH-AUDIO', 'utf8')); // the sibling video
  const up = await (await api.post(`/api/admin/scorm?name=MentorPlusMedia${Date.now()}`, { headers: { 'content-type': 'application/zip' }, data: zip.toBuffer() })).json();
  expect(up.kind).toBe('html');
  expect(up.launchFile).toBe('app/index.html');            // only WRAP/ stripped, app/ kept
  const vid = await api.get(`/scorm/${up.packageId}/media/clip.mp4`); // the sibling video survived
  expect(vid.status()).toBe(200);
  expect(await vid.text()).toContain('FAKE-MP4-WITH-AUDIO');
});

test('an HTML module completes via the time gate + mark-complete, with a certificate', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: DESIGNER })).ok()).toBeTruthy();
  const up = await (await api.post(`/api/admin/scorm?name=Html${Date.now()}`, { headers: { 'content-type': 'application/zip' }, data: htmlZip() })).json();
  const course = (await (await api.post('/api/admin/courses', { data: { title: `HTML Complete ${Date.now()}`, audience: 'referees' } })).json()).course;
  // minMinutes:0 removes the wait so the test can mark-complete immediately.
  await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'scorm', title: 'Module', packageId: up.packageId, launchFile: up.launchFile, htmlPackage: true, minMinutes: 0 } });
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });
  const lessonId = (await (await api.get(`/api/admin/courses/${course.id}`)).json()).course.lessons[0].id;

  const learner = await playwright.request.newContext({ baseURL: BASE });
  await learner.post('/api/register', { data: { firstName: 'Html', lastName: 'Learner', email: `html+${Date.now()}@example.com` } });
  await learner.post(`/api/courses/${course.id}/enroll`);
  // The player posts status "completed" when the learner clicks Mark complete.
  const r = await (await learner.post(`/api/courses/${course.id}/lessons/${lessonId}/scorm`, { data: { status: 'completed' } })).json();
  expect(r.completed).toBe(true);
  expect(r.courseCompleted).toBe(true);
  expect(r.certId).toBeTruthy();
});
