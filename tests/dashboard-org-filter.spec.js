// The dashboard records view can be filtered by organization, so OMG data is
// viewed separately from NCYSA/NCSRA (the orgs are kept distinct). UI-only filter,
// admin-only view.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };

test('dashboard Organization filter separates OMG records from NCYSA/NCSRA', async ({ page, context, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: ADMIN });
  const stamp = Date.now();
  // An OMG course and an NCYSA course, each with a lesson. Only the OMG course is
  // published — the learner below enrolls in it. The NCYSA course stays unpublished
  // so it doesn't leak onto the public coaches portal (which would collide with the
  // learner-journey test's single-card assumption); it still exists for the filter.
  const omg = (await (await api.post('/api/admin/courses', { data: { title: `OrgFilter OMG ${stamp}`, audience: 'referees', orgId: 'omg' } })).json()).course;
  const ncysa = (await (await api.post('/api/admin/courses', { data: { title: `OrgFilter NCYSA ${stamp}`, audience: 'coaches' } })).json()).course;
  expect(omg.orgId).toBe('omg');
  for (const c of [omg, ncysa]) {
    await api.post(`/api/admin/courses/${c.id}/lessons`, { data: { type: 'text', title: 'Read', html: '<p>hi</p>' } });
  }
  await api.post(`/api/admin/courses/${omg.id}/publish`, { data: { published: true } });

  // A learner enrolls in the OMG course (creates an OMG record).
  const learner = await playwright.request.newContext({ baseURL: BASE });
  const email = `orgflt+${stamp}@example.com`;
  await learner.post('/api/register', { data: { firstName: 'Org', lastName: 'Filter', email } });
  await learner.post(`/api/courses/${omg.id}/enroll`);

  // Open the dashboard as admin.
  await context.addCookies((await api.storageState()).cookies);
  await page.goto('/#/admin');
  await expect(page.locator('#fltOrg')).toBeVisible();

  // The dashboard lockup auto-includes OMG once it has a course (plus NCYSA/NCSRA).
  await expect(page.locator('.brandmarks img[alt="OMG"]')).toBeVisible();
  await expect(page.locator('.brandmarks img[alt="NCYSA"]')).toBeVisible();

  // Narrow to this learner, then flip the Organization filter.
  await page.fill('#fltSearch', email);
  await page.selectOption('#fltOrg', 'OMG');
  await expect(page.locator(`.admin-table td:has-text("${email}")`)).toBeVisible(); // OMG record shows
  await page.selectOption('#fltOrg', 'NCYSA');
  await expect(page.locator(`.admin-table td:has-text("${email}")`)).toHaveCount(0); // hidden under NCYSA
});
