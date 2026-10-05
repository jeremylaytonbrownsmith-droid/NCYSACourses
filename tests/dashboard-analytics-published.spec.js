// Dashboard analytics ("At a glance" / By course) summarizes PUBLISHED courses
// only — drafts and unpublished courses shouldn't clutter it.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };

test('analytics By-course shows published courses and drops unpublished ones', async ({ page, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  const stamp = Date.now();
  const title = `Analytics Pub ${stamp}`;
  const course = (await (await api.post('/api/admin/courses', { data: { title, audience: 'coaches' } })).json()).course;
  await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'text', title: 'Read', html: '<p>hi</p>' } });
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });
  const lessonId = (await (await api.get(`/api/admin/courses/${course.id}`)).json()).course.lessons[0].id;

  // A learner completes it, so the course has activity to summarize.
  const learner = await playwright.request.newContext({ baseURL: BASE });
  await learner.post('/api/register', { data: { firstName: 'An', lastName: 'Alytics', email: `an+${stamp}@example.com` } });
  await learner.post(`/api/courses/${course.id}/enroll`);
  await learner.post(`/api/courses/${course.id}/lessons/${lessonId}/complete`, { data: {} });

  // Sign in on the UI and open the dashboard.
  await page.goto('/#/staff', { waitUntil: 'networkidle' });
  await page.fill('input[name=email]', ADMIN.email);
  await page.fill('input[name=password]', ADMIN.password);
  await page.click('button[type=submit]');
  await page.waitForTimeout(1200);
  await page.goto('/#/admin');
  const glance = page.locator('.admin-card', { hasText: 'At a glance' });
  await expect(glance).toBeVisible();
  await expect(glance).toContainText(title); // published → shown in By course

  // Unpublish it, reload — it should drop out of the analytics.
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: false } });
  await page.goto('/#/courses'); // navigate away
  await page.goto('/#/admin');   // and back, forcing a fresh overview load
  await expect(page.locator('.admin-card', { hasText: 'At a glance' })).toBeVisible();
  await expect(page.locator('.admin-card', { hasText: 'At a glance' })).not.toContainText(title);
});
