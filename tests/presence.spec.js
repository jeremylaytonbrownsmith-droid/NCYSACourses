// Live presence: a learner who is actively in a module/video pings the server,
// and the dashboard shows them as "active now" (the green dot). Presence is
// in-memory only — no DB write — so this just verifies the heartbeat lights a
// learner up in the overview + the lightweight presence poll.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };

test('a learner heartbeat marks them active in the dashboard + presence poll', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  const stamp = Date.now();

  // A one-video course.
  const course = (await (await api.post('/api/admin/courses', { data: { title: `Presence ${stamp}`, audience: 'coaches' } })).json()).course;
  await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'text', title: 'M1', html: '<p>x</p>' } });
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });
  const lessonId = (await (await api.get(`/api/admin/courses/${course.id}`)).json()).course.lessons[0].id;

  // A learner enrolls. Before any activity, they are not "active now".
  const learner = await playwright.request.newContext({ baseURL: BASE });
  const reg = await (await learner.post('/api/register', { data: { firstName: 'Live', lastName: 'Learner', email: `live+${stamp}@example.com` } })).json();
  const userId = reg.user.id;
  await learner.post(`/api/courses/${course.id}/enroll`);

  let rec = (await (await api.get('/api/admin/overview')).json()).enrollments.find((e) => e.userId === userId);
  expect(rec).toBeTruthy();
  expect(rec.activeNow).toBeFalsy();

  // The learner does something in the course (a heartbeat). Now they're active.
  await learner.post(`/api/courses/${course.id}/lessons/${lessonId}/complete`, { data: {} });

  rec = (await (await api.get('/api/admin/overview')).json()).enrollments.find((e) => e.userId === userId);
  expect(rec.activeNow).toBe(true);
  expect(rec.lastActiveSecondsAgo).toBeLessThan(60);

  // The lightweight presence poll reports the same learner as recently active.
  const presence = await (await api.get('/api/admin/presence')).json();
  expect(presence.active[userId]).not.toBeUndefined();
  expect(presence.active[userId]).toBeLessThan(60);
  expect(presence.activeWithinSeconds).toBeGreaterThan(0);
});

test('presence poll requires dashboard access', async ({ playwright }) => {
  const anon = await playwright.request.newContext({ baseURL: BASE });
  expect((await anon.get('/api/admin/presence')).status()).toBe(401);
});
