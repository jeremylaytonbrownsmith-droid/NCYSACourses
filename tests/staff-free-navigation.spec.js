// Staff (admin/editor/partner) can jump to any module in a course without
// completing the gated sequence — for reviewing or testing. A regular learner
// still sees later modules locked until the previous ones are done.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const DESIGNER = { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' };

test('staff see every module unlocked; a learner does not', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: DESIGNER })).ok()).toBeTruthy();
  const stamp = Date.now();

  const course = (await (await api.post('/api/admin/courses', { data: { title: `Nav ${stamp}`, audience: 'referees' } })).json()).course;
  const mk = (t) => api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'scorm', title: t, packageId: 'test-module', minMinutes: 0 } }).then((r) => r.json()).then((j) => j.lesson);
  const l1 = await mk('Module 1'); const l2 = await mk('Module 2'); const l3 = await mk('Module 3');
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });

  // Staff: enroll, then everything is unlocked, and they can hit module 3 directly.
  await api.post(`/api/courses/${course.id}/enroll`);
  const staffView = await (await api.get(`/api/courses/${course.id}`)).json();
  expect(staffView.progress.lessons.map((l) => l.unlocked)).toEqual([true, true, true]);
  const jump = await api.post(`/api/courses/${course.id}/lessons/${l3.id}/scorm`, { data: { activeDelta: 5, status: 'incomplete' } });
  expect(jump.ok()).toBeTruthy(); // not 403 "locked" for staff

  // Learner: only the first module is unlocked.
  const learner = await playwright.request.newContext({ baseURL: BASE });
  await learner.post('/api/register', { data: { firstName: 'Lee', lastName: 'Arner', email: `nav+${stamp}@example.com` } });
  await learner.post(`/api/courses/${course.id}/enroll`);
  const learnerView = await (await learner.get(`/api/courses/${course.id}`)).json();
  expect(learnerView.progress.lessons.map((l) => l.unlocked)).toEqual([true, false, false]);
  const blocked = await learner.post(`/api/courses/${course.id}/lessons/${l3.id}/scorm`, { data: { activeDelta: 5, status: 'incomplete' } });
  expect(blocked.status()).toBe(403);
});
