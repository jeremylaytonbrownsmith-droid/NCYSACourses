// A SCORM module runs in the browser, discovers the portal's window.API, and
// reports completion — which completes the course and mints the certificate.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3100';

test('scorm module completion through the browser', async ({ page, playwright }) => {
  // --- Editor builds a single-module SCORM course (its own cookie jar) -------
  const api = await playwright.request.newContext({ baseURL: BASE });
  let r = await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  expect(r.ok()).toBeTruthy();
  r = await api.post('/api/admin/courses', { data: { title: 'Browser SCORM Recert', audience: 'referees', badge: 'Recertification' } });
  const courseId = (await r.json()).course.id;
  // minMinutes: 0 turns the anti-skip time gate off for this completion test.
  r = await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'scorm', title: 'Module 1', packageId: 'test-module', minMinutes: 0 } });
  const lessonId = (await r.json()).lesson.id;
  await api.post(`/api/admin/courses/${courseId}/publish`, { data: { published: true } });

  // --- Referee registers in the browser -------------------------------------
  await page.goto('/#/register');
  await page.fill('#firstName', 'Bro');
  await page.fill('#lastName', 'Wser');
  await page.fill('#email', 'bro.wser@example.com');
  await page.click('button:has-text("Create account")');
  await expect(page.locator('.topnav')).toContainText('Hi, Bro');

  // Enroll (as the logged-in learner — page.request shares the page's cookies)
  await page.request.post(`${BASE}/api/courses/${courseId}/enroll`);

  // --- Open the module and click through the SCORM package ------------------
  await page.goto(`/#/course/${courseId}/lesson/${lessonId}`);
  const frame = page.frameLocator('#scormFrame');
  await expect(frame.locator('#count')).toContainText('Slide 1 of 3');
  await frame.locator('#next').click();
  await expect(frame.locator('#count')).toContainText('Slide 2 of 3');
  // Clicking to the final slide reports "completed" to window.API → relayed to
  // the server → this single-module course completes and the completion screen
  // replaces the page (so we assert that outcome, not the transient last slide).
  await frame.locator('#next').click();
  await expect(page.locator('.complete-hero h1')).toContainText('Congratulations', { timeout: 15000 });
  await page.click('text=View your certificate');
  await expect(page.locator('.certificate .learner-name')).toContainText('Bro Wser');
});

test('scorm time gate holds completion until the minimum time is met', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  let r = await api.post('/api/admin/courses', { data: { title: 'Gated SCORM Recert', audience: 'referees' } });
  const courseId = (await r.json()).course.id;
  // 0.5 minutes = 30 seconds minimum (above the 15s per-heartbeat cap, so no
  // single call can satisfy it).
  r = await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'scorm', title: 'Gated Module', packageId: 'test-module', minMinutes: 0.5 } });
  const lessonId = (await r.json()).lesson.id;
  await api.post(`/api/admin/courses/${courseId}/publish`, { data: { published: true } });

  // Learner registers + enrolls (separate cookie jar).
  const learner = await playwright.request.newContext({ baseURL: BASE });
  await learner.post('/api/register', { data: { firstName: 'Gate', lastName: 'Test', email: 'gate.test@example.com' } });
  await learner.post(`/api/courses/${courseId}/enroll`);

  const post = (body) => learner.post(`/api/courses/${courseId}/lessons/${lessonId}/scorm`, { data: body }).then((x) => x.json());

  // Reaching the end immediately must NOT complete — the time gate isn't met.
  let res = await post({ status: 'completed', activeDelta: 0 });
  expect(res.reachedEnd).toBe(true);
  expect(res.completed).toBe(false);
  expect(res.remaining).toBeGreaterThan(0);

  // A single forged huge delta is capped, so it still can't jump the gate.
  res = await post({ status: 'completed', activeDelta: 9999 });
  expect(res.completed).toBe(false);
  expect(res.activeSeconds).toBeLessThanOrEqual(15); // one step cap

  // Accrue enough real-time credit across heartbeats → now it completes.
  for (let i = 0; i < 5 && !res.completed; i++) res = await post({ status: 'completed', activeDelta: 15 });
  expect(res.completed).toBe(true);
  expect(res.courseCompleted).toBe(true);
  expect(res.certId).toBeTruthy();
});

test('CDN video shim is injected only for packages marked CDN-backed', async ({ request }) => {
  // The webServer serves packages from .test-data/scorm (shared filesystem).
  const dir = path.join(__dirname, '..', '.test-data', 'scorm');
  fs.mkdirSync(path.join(dir, 'cdn-yes'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'cdn-no'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'cdn-yes', 'index.html'), '<!doctype html><head></head><body>m</body>');
  fs.writeFileSync(path.join(dir, 'cdn-yes', '.cdn'), 'https://ncysa-modules.b-cdn.net/cdn-yes/');
  fs.writeFileSync(path.join(dir, 'cdn-no', 'index.html'), '<!doctype html><head></head><body>m</body>');

  const yes = await (await request.get(`${BASE}/scorm/cdn-yes/index.html`)).text();
  expect(yes).toContain('HTMLMediaElement');                     // shim present
  expect(yes).toContain('ncysa-modules.b-cdn.net/cdn-yes');      // points at the CDN base

  const no = await (await request.get(`${BASE}/scorm/cdn-no/index.html`)).text();
  expect(no).not.toContain('HTMLMediaElement');                  // no shim without the marker
});
