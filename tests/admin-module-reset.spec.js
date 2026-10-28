// Admin single-module reset: an admin can clear one module for a learner so they
// retake just that module, without wiping the whole course. If the course was
// complete, resetting a module un-completes it and invalidates the certificate.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };

test('admin can reset a single module without wiping the course', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  const stamp = Date.now();

  // A 3-module course.
  const course = (await (await api.post('/api/admin/courses', { data: { title: `Reset Course ${stamp}`, audience: 'coaches' } })).json()).course;
  for (const n of [1, 2, 3]) {
    await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'text', title: `Module ${n}`, html: '<p>x</p>' } });
  }
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });
  const lessons = (await (await api.get(`/api/admin/courses/${course.id}`)).json()).course.lessons;
  expect(lessons.length).toBe(3);

  // A learner completes all three → course complete, certificate issued.
  const email = `reset+${stamp}@example.com`;
  const learner = await playwright.request.newContext({ baseURL: BASE });
  const reg = await (await learner.post('/api/register', { data: { firstName: 'Reset', lastName: 'Tester', email } })).json();
  const userId = reg.user.id;
  await learner.post(`/api/courses/${course.id}/enroll`);
  let lastCert = null;
  for (const l of lessons) {
    const r = await (await learner.post(`/api/courses/${course.id}/lessons/${l.id}/complete`, { data: {} })).json();
    if (r.certId) lastCert = r.certId;
  }
  expect(lastCert).toBeTruthy();
  // The certificate verifies as valid while the course is complete.
  expect((await (await api.get(`/api/verify/${lastCert}`)).json()).valid).toBe(true);

  // Admin lists this learner's modules — all three show completed.
  let mods = (await (await api.get(`/api/admin/learner-modules?userId=${userId}&courseId=${course.id}`)).json()).modules;
  expect(mods.map((m) => m.status)).toEqual(['completed', 'completed', 'completed']);

  // Reset only the middle module.
  const resetRes = await (await api.post('/api/admin/reset-module', { data: { userId, courseId: course.id, lessonId: lessons[1].id } })).json();
  expect(resetRes.ok).toBe(true);
  expect(resetRes.removed).toBe(1);
  expect(resetRes.certCleared).toBe(true); // course was complete, so completion+cert cleared

  // Module 2 is now reset; modules 1 and 3 are untouched.
  mods = (await (await api.get(`/api/admin/learner-modules?userId=${userId}&courseId=${course.id}`)).json()).modules;
  expect(mods.map((m) => m.status)).toEqual(['completed', 'not started', 'completed']);

  // The certificate no longer validates (completion was cleared).
  const verifyAfter = await api.get(`/api/verify/${lastCert}`);
  const verifyBody = verifyAfter.ok() ? await verifyAfter.json() : { valid: false };
  expect(verifyBody.valid).toBeFalsy();

  // The learner can retake just module 2 and complete the course again.
  const redo = await (await learner.post(`/api/courses/${course.id}/lessons/${lessons[1].id}/complete`, { data: {} })).json();
  expect(redo.certId).toBeTruthy();
});

test('the learner drawer shows a "Reset a module…" control that lists modules', async ({ page, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  const stamp = Date.now();
  const course = (await (await api.post('/api/admin/courses', { data: { title: `Drawer Reset ${stamp}`, audience: 'coaches' } })).json()).course;
  await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'text', title: 'Only Module', html: '<p>x</p>' } });
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });
  const lessonId = (await (await api.get(`/api/admin/courses/${course.id}`)).json()).course.lessons[0].id;

  const email = `drawerreset+${stamp}@example.com`;
  const learner = await playwright.request.newContext({ baseURL: BASE });
  await learner.post('/api/register', { data: { firstName: 'Drawer', lastName: 'Reset', email } });
  await learner.post(`/api/courses/${course.id}/enroll`);
  await learner.post(`/api/courses/${course.id}/lessons/${lessonId}/complete`, { data: {} });

  await page.goto('/#/staff', { waitUntil: 'networkidle' });
  await page.fill('input[name=email]', ADMIN.email);
  await page.fill('input[name=password]', ADMIN.password);
  await page.click('button[type=submit]');
  await page.waitForTimeout(1200);
  await page.goto('/#/admin');
  await expect(page.locator('#fltSearch')).toBeVisible();
  await page.fill('#fltSearch', email);
  const link = page.locator('.learner-link', { hasText: 'Drawer Reset' });
  await expect(link).toBeVisible();
  await link.evaluate((el) => el.click());

  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible();
  await drawer.locator('.dr-modules').click();
  await expect(drawer.locator('.dr-mod-t')).toContainText('Only Module');

  // Accept the confirm dialog, then reset the module from the UI.
  page.on('dialog', (d) => d.accept());
  await drawer.locator('.dr-mod-reset').click();
  await expect(drawer.locator('.dr-mod-ns')).toContainText('not started');
});

test('reset-module validates input and scope', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  // Missing fields → 400.
  expect((await api.post('/api/admin/reset-module', { data: { userId: 'x' } })).status()).toBe(400);
  // Unknown course → 404.
  expect((await api.post('/api/admin/reset-module', { data: { userId: 'x', courseId: 'nope', lessonId: 'y' } })).status()).toBe(404);
});

test('admin can mark a module complete for a learner, issuing the certificate', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  const stamp = Date.now();
  const course = (await (await api.post('/api/admin/courses', { data: { title: `Credit ${stamp}`, audience: 'coaches' } })).json()).course;
  await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'text', title: 'Only Module', html: '<p>x</p>' } });
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });
  const lessonId = (await (await api.get(`/api/admin/courses/${course.id}`)).json()).course.lessons[0].id;

  const learner = await playwright.request.newContext({ baseURL: BASE });
  await learner.post('/api/register', { data: { firstName: 'Credit', lastName: 'Me', email: `credit+${stamp}@example.com` } });
  const me = await (await learner.get('/api/me')).json();
  const userId = me.user.id;
  await learner.post(`/api/courses/${course.id}/enroll`);

  // Not played through — admin credits it. It's the only module, so the course
  // completes and a certificate is issued.
  const r = await (await api.post('/api/admin/complete-module', { data: { userId, courseId: course.id, lessonId } })).json();
  expect(r.completed).toBe(true);
  expect(r.courseCompleted).toBe(true);
  expect(r.certId).toBeTruthy();
});
