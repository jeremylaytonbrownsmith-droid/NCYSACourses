// Learner detail drawer: clicking a learner in the dashboard opens a panel with
// their full history and per-course actions (view/verify certificate, reset).
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };

test('clicking a learner opens a detail drawer with their course + certificate actions', async ({ page, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  const stamp = Date.now();
  const course = (await (await api.post('/api/admin/courses', { data: { title: `Drawer Course ${stamp}`, audience: 'coaches' } })).json()).course;
  await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'text', title: 'Read', html: '<p>hi</p>' } });
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });
  const lessonId = (await (await api.get(`/api/admin/courses/${course.id}`)).json()).course.lessons[0].id;

  const email = `drawer+${stamp}@example.com`;
  const learner = await playwright.request.newContext({ baseURL: BASE });
  await learner.post('/api/register', { data: { firstName: 'Drawer', lastName: 'Person', email } });
  await learner.post(`/api/courses/${course.id}/enroll`);
  const done = await (await learner.post(`/api/courses/${course.id}/lessons/${lessonId}/complete`, { data: {} })).json();
  expect(done.certId).toBeTruthy();

  // Admin signs in through the UI and opens the dashboard.
  await page.goto('/#/staff', { waitUntil: 'networkidle' });
  await page.fill('input[name=email]', ADMIN.email);
  await page.fill('input[name=password]', ADMIN.password);
  await page.click('button[type=submit]');
  await page.waitForTimeout(1200);
  await page.goto('/#/admin');
  await expect(page.locator('#fltSearch')).toBeVisible();
  await page.fill('#fltSearch', email); // narrow to just this learner

  const link = page.locator('.learner-link', { hasText: 'Drawer Person' });
  await expect(link).toBeVisible();
  await link.evaluate((el) => el.click()); // dispatch a real DOM click on the located element

  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('Drawer Person');
  await expect(drawer).toContainText(`Drawer Course ${stamp}`);
  await expect(drawer.locator('a:has-text("View certificate")')).toBeVisible();
  await expect(drawer.locator('.dr-copy')).toBeVisible();

  // Close it.
  await page.click('#drawerClose');
  await expect(page.locator('.drawer')).toHaveCount(0);
});
