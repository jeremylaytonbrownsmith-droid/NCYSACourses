// A learner reports a problem from inside a course; it's captured with their
// identity + course/module context and shows up on the admin dashboard, where it
// can be resolved and deleted.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };

test('a learner problem report reaches the dashboard and can be resolved/deleted', async ({ playwright }) => {
  const admin = await playwright.request.newContext({ baseURL: BASE });
  expect((await admin.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  const stamp = Date.now();

  const course = (await (await admin.post('/api/admin/courses', { data: { title: `Report ${stamp}`, audience: 'coaches' } })).json()).course;
  const lesson = (await (await admin.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'text', title: 'Lesson A', html: '<p>Hi</p>' } })).json()).lesson;
  await admin.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });

  // Learner files a report.
  const learner = await playwright.request.newContext({ baseURL: BASE });
  await learner.post('/api/register', { data: { firstName: 'Reba', lastName: 'Porter', email: `report+${stamp}@example.com` } });
  await learner.post(`/api/courses/${course.id}/enroll`);
  const sent = await learner.post('/api/problem-report', { data: { courseId: course.id, lessonId: lesson.id, message: 'The audio will not let me finish.', userAgent: 'TestBrowser/1.0' } });
  expect(sent.ok()).toBeTruthy();

  const empty = await learner.post('/api/problem-report', { data: { courseId: course.id, lessonId: lesson.id, message: ' ' } });
  expect(empty.status()).toBe(400);

  // Admin sees it with full context.
  let overview = await (await admin.get('/api/admin/overview')).json();
  const mine = overview.problemReports.find((r) => r.message === 'The audio will not let me finish.');
  expect(mine).toBeTruthy();
  expect(mine.learner).toBe('Reba Porter');
  expect(mine.email).toBe(`report+${stamp}@example.com`);
  expect(mine.course).toBe(`Report ${stamp}`);
  expect(mine.lesson).toBe('Lesson A');
  expect(mine.resolved).toBe(false);

  // Resolve, then delete.
  expect((await (await admin.post(`/api/admin/problem-reports/${mine.id}/resolve`, { data: { resolved: true } })).json()).resolved).toBe(true);
  expect((await admin.delete(`/api/admin/problem-reports/${mine.id}`)).ok()).toBeTruthy();
  overview = await (await admin.get('/api/admin/overview')).json();
  expect(overview.problemReports.find((r) => r.id === mine.id)).toBeFalsy();
});
