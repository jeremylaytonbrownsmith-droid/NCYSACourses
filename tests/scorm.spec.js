// A SCORM module runs in the browser, discovers the portal's window.API, and
// reports completion — which completes the course and mints the certificate.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';

test('scorm module completion through the browser', async ({ page, playwright }) => {
  // --- Editor builds a single-module SCORM course (its own cookie jar) -------
  const api = await playwright.request.newContext({ baseURL: BASE });
  let r = await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  expect(r.ok()).toBeTruthy();
  r = await api.post('/api/admin/courses', { data: { title: 'Browser SCORM Recert', audience: 'referees', badge: 'Recertification' } });
  const courseId = (await r.json()).course.id;
  r = await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'scorm', title: 'Module 1', packageId: 'test-module' } });
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
