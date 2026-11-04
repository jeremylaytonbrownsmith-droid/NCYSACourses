// Records a staff member creates by previewing a course are labeled (name +
// "Staff preview" flag) instead of showing up blank next to real referees.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };

test('staff-preview enrollments are labeled, real learners are not', async ({ playwright }) => {
  const admin = await playwright.request.newContext({ baseURL: BASE });
  expect((await admin.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  const stamp = Date.now();

  const course = (await (await admin.post('/api/admin/courses', { data: { title: `Preview ${stamp}`, audience: 'referees' } })).json()).course;
  await admin.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'text', title: 'L', html: '<p>x</p>' } });
  await admin.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });

  // Staff previews the course (auto-enroll, same as opening it).
  await admin.post(`/api/courses/${course.id}/enroll`);

  // A real learner enrolls.
  const learner = await playwright.request.newContext({ baseURL: BASE });
  await learner.post('/api/register', { data: { firstName: 'Real', lastName: 'Learner', email: `real+${stamp}@example.com` } });
  await learner.post(`/api/courses/${course.id}/enroll`);

  const overview = await (await admin.get('/api/admin/overview')).json();
  const rows = overview.enrollments.filter((r) => r.courseId === course.id);
  const staffRow = rows.find((r) => r.staffPreview);
  const learnerRow = rows.find((r) => !r.staffPreview);

  expect(staffRow).toBeTruthy();
  expect(staffRow.learner).toBeTruthy();       // never blank
  expect(learnerRow).toBeTruthy();
  expect(learnerRow.staffPreview).toBe(false);
  expect(learnerRow.learner).toBe('Real Learner');
});
