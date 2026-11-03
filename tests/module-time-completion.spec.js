// Time-based completion fallback: a SCORM module an admin flags as "complete on
// time" finishes once the learner meets the dwell time, even if the package never
// reports "completed" (for content whose own completion signal is broken). Without
// the flag, meeting the time is NOT enough — the package must report completed.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const DESIGNER = { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' };

test('a flagged module completes on dwell time without a "completed" signal', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: DESIGNER })).ok()).toBeTruthy();
  const stamp = Date.now();

  const course = (await (await api.post('/api/admin/courses', { data: { title: `TimeComplete ${stamp}`, audience: 'referees' } })).json()).course;
  const lesson = (await (await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'scorm', title: 'Flaky Module', packageId: 'test-module', minSeconds: 20 } })).json()).lesson;
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });

  const learner = await playwright.request.newContext({ baseURL: BASE });
  await learner.post('/api/register', { data: { firstName: 'Tim', lastName: 'Eout', email: `tc+${stamp}@example.com` } });
  await learner.post(`/api/courses/${course.id}/enroll`);

  // Three heartbeats (15s cap each) → 45s active, status always "incomplete".
  let last;
  for (let i = 0; i < 3; i++) {
    last = await (await learner.post(`/api/courses/${course.id}/lessons/${lesson.id}/scorm`, { data: { activeDelta: 15, status: 'incomplete' } })).json();
  }
  // Time is met, but the package never reported done → still not complete.
  expect(last.reachedEnd).toBe(false);
  expect(last.completed).toBe(false);

  // Admin flags the module as complete-on-time.
  const toggled = await (await api.post(`/api/admin/courses/${course.id}/lessons/${lesson.id}/complete-on-time`, { data: { on: true } })).json();
  expect(toggled.completeOnTime).toBe(true);

  // Next heartbeat (still "incomplete") now completes it — and the single-lesson
  // course finishes.
  const done = await (await learner.post(`/api/courses/${course.id}/lessons/${lesson.id}/scorm`, { data: { activeDelta: 15, status: 'incomplete' } })).json();
  expect(done.completed).toBe(true);
  expect(done.courseCompleted).toBe(true);

  // Turning it back off is clean (doesn't un-complete an already-finished record).
  const off = await (await api.post(`/api/admin/courses/${course.id}/lessons/${lesson.id}/complete-on-time`, { data: { on: false } })).json();
  expect(off.completeOnTime).toBe(false);
});
