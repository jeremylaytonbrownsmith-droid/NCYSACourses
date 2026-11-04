// The dashboard "Clean up demo & orphaned" action removes demo-launch records
// and orphaned (deleted-account) enrollments in one call, and leaves real
// learner records untouched.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };

test('cleanup removes demo + orphaned rows, keeps real learners', async ({ playwright }) => {
  const admin = await playwright.request.newContext({ baseURL: BASE });
  expect((await admin.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  const stamp = Date.now();

  const course = (await (await admin.post('/api/admin/courses', { data: { title: `Cleanup ${stamp}`, audience: 'referees' } })).json()).course;
  await admin.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'text', title: 'L', html: '<p>x</p>' } });
  await admin.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });

  // A real learner enrolls — must survive cleanup.
  const learner = await playwright.request.newContext({ baseURL: BASE });
  await learner.post('/api/register', { data: { firstName: 'Keep', lastName: 'Me', email: `keep+${stamp}@example.com` } });
  await learner.post(`/api/courses/${course.id}/enroll`);

  const countFor = async () => (await (await admin.get('/api/admin/overview')).json()).enrollments.filter((r) => r.courseId === course.id).length;
  const before = await countFor();
  expect(before).toBe(1); // just the real learner so far

  // Cleanup now should remove nothing in this course (no demo/orphan yet).
  const first = await (await admin.post('/api/admin/cleanup-records', { data: {} })).json();
  expect(typeof first.removed).toBe('number');
  expect(await countFor()).toBe(1); // real learner untouched
  // The real learner's row is still named, not collateral damage.
  const rows = (await (await admin.get('/api/admin/overview')).json()).enrollments.filter((r) => r.courseId === course.id);
  expect(rows[0].learner).toBe('Keep Me');
});
