// Escalating anti-skip ("fly-through") gate. If a learner reaches the end of a
// module in under half its expected length, the module is reset and its required
// minimum time climbs on a ladder: 2 min, then 6 min, then 10 min (capped). A
// module with no expected length set is never flagged, and a learner who spends
// real time in the module completes normally. Flagged learners surface in the
// admin overview so staff can see who is racing through.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';

async function makeCourse(api, { title, expectedMinutes }) {
  const courseId = (await (await api.post('/api/admin/courses', { data: { title, audience: 'referees' } })).json()).course.id;
  const lessonBody = { type: 'scorm', title: 'Module 1', packageId: 'test-module', minMinutes: 0 };
  if (expectedMinutes != null) lessonBody.expectedMinutes = expectedMinutes;
  const lessonId = (await (await api.post(`/api/admin/courses/${courseId}/lessons`, { data: lessonBody })).json()).lesson.id;
  await api.post(`/api/admin/courses/${courseId}/publish`, { data: { published: true } });
  return { courseId, lessonId };
}

test('the fly-through gate escalates the required time on each fly-through', async ({ playwright }) => {
  const admin = await playwright.request.newContext({ baseURL: BASE });
  await admin.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  // expected = 0.5 min (30s) → fly-through threshold is 15s. Reaching the end at
  // 0s active is well under it, so each completion attempt trips the gate.
  const { courseId, lessonId } = await makeCourse(admin, { title: 'Fly-Through Recert', expectedMinutes: 0.5 });

  const learner = await playwright.request.newContext({ baseURL: BASE });
  await learner.post('/api/register', { data: { firstName: 'Flew', lastName: 'Through', email: 'flew.through@example.com' } });
  await learner.post(`/api/courses/${courseId}/enroll`);
  const post = (body) => learner.post(`/api/courses/${courseId}/lessons/${lessonId}/scorm`, { data: body }).then((x) => x.json());

  // First fly-through: reach the end instantly → flagged, minimum climbs to 2 min.
  let res = await post({ status: 'completed', activeDelta: 0 });
  expect(res.flaggedFlyThrough).toBe(true);
  expect(res.completed).toBe(false);
  expect(res.flyThroughCount).toBe(1);
  expect(res.requiredMinutes).toBe(2);
  expect(res.reset).toBe(true);

  // Second fly-through: minimum climbs to 6 min.
  res = await post({ status: 'completed', activeDelta: 0 });
  expect(res.flaggedFlyThrough).toBe(true);
  expect(res.flyThroughCount).toBe(2);
  expect(res.requiredMinutes).toBe(6);

  // Third fly-through: minimum climbs to 10 min.
  res = await post({ status: 'completed', activeDelta: 0 });
  expect(res.flyThroughCount).toBe(3);
  expect(res.requiredMinutes).toBe(10);

  // Fourth and beyond: the ladder caps at 10 min (count keeps rising).
  res = await post({ status: 'completed', activeDelta: 0 });
  expect(res.flyThroughCount).toBe(4);
  expect(res.requiredMinutes).toBe(10);

  // The admin overview surfaces this learner as flagged for flying through.
  const overview = await (await admin.get('/api/admin/overview')).json();
  const row = (overview.flyThroughs || []).find((f) => f.email === 'flew.through@example.com');
  expect(row).toBeTruthy();
  expect(row.flyThroughCount).toBe(4);
  expect(row.requiredMinutes).toBe(10);
  expect(row.module).toBe('Module 1');
  expect(row.course).toBe('Fly-Through Recert');
});

test('a module with no expected length is never flagged as a fly-through', async ({ playwright }) => {
  const admin = await playwright.request.newContext({ baseURL: BASE });
  await admin.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  // No expectedMinutes → fly-through detection is off (e.g. a short intro module).
  const { courseId, lessonId } = await makeCourse(admin, { title: 'No-Expected Recert' });

  const learner = await playwright.request.newContext({ baseURL: BASE });
  await learner.post('/api/register', { data: { firstName: 'Fast', lastName: 'Intro', email: 'fast.intro@example.com' } });
  await learner.post(`/api/courses/${courseId}/enroll`);

  // Reaching the end instantly completes it — nothing to fly through.
  const res = await learner.post(`/api/courses/${courseId}/lessons/${lessonId}/scorm`, { data: { status: 'completed', activeDelta: 0 } }).then((x) => x.json());
  expect(res.flaggedFlyThrough).toBe(false);
  expect(res.completed).toBe(true);
  expect(res.flyThroughCount).toBe(0);
});

test('a learner who spends real time in the module is not flagged', async ({ playwright }) => {
  const admin = await playwright.request.newContext({ baseURL: BASE });
  await admin.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  // expected = 0.5 min (30s) → threshold 15s. Accrue 30s of real time before
  // reaching the end, so it is above the threshold and must not be flagged.
  const { courseId, lessonId } = await makeCourse(admin, { title: 'Genuine Recert', expectedMinutes: 0.5 });

  const learner = await playwright.request.newContext({ baseURL: BASE });
  await learner.post('/api/register', { data: { firstName: 'Real', lastName: 'Learner', email: 'real.learner@example.com' } });
  await learner.post(`/api/courses/${courseId}/enroll`);
  const post = (body) => learner.post(`/api/courses/${courseId}/lessons/${lessonId}/scorm`, { data: body }).then((x) => x.json());

  // Spend time in the module (still in progress), then reach the end.
  await post({ status: 'incomplete', activeDelta: 15 });
  const res = await post({ status: 'completed', activeDelta: 15 });
  expect(res.flaggedFlyThrough).toBe(false);
  expect(res.completed).toBe(true);
  expect(res.flyThroughCount).toBe(0);
});
