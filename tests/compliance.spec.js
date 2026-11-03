// Deadline / compliance engine: the pure rules, then the full flow — a course
// with a deadline dates each enrollment, the dashboard shows the state, overdue
// learners get a reminder, and the sweep never emails the same person twice.
const { test, expect } = require('@playwright/test');
const { complianceOf, computeDueAt, dueReminders, clampDueDays } = require('../lib/compliance');

const DAY = 86400000;
const BASE = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };
const iso = (ms) => new Date(ms).toISOString();

test('complianceOf derives the right state', () => {
  const now = Date.UTC(2026, 0, 15);
  expect(complianceOf({ completedAt: iso(now) }, now).state).toBe('completed');
  expect(complianceOf({}, now).state).toBe('none');
  expect(complianceOf({ dueAt: iso(now - 2 * DAY) }, now).state).toBe('overdue');
  expect(complianceOf({ dueAt: iso(now + 2 * DAY) }, now).state).toBe('duesoon');
  expect(complianceOf({ dueAt: iso(now + 20 * DAY) }, now).state).toBe('ontrack');
  expect(complianceOf({ completedAt: iso(now), dueAt: iso(now + DAY) }, now).onTime).toBe(true);
  expect(complianceOf({ completedAt: iso(now), dueAt: iso(now - DAY) }, now).onTime).toBe(false);
  expect(clampDueDays(10)).toBe(10);
  expect(clampDueDays(-4)).toBe(0);
  expect(clampDueDays(9999)).toBe(365);
  expect(computeDueAt(iso(now), 7)).toBe(iso(now + 7 * DAY));
  expect(computeDueAt(iso(now), 0)).toBe(null);
});

test('dueReminders fires once for due-soon and weekly for overdue', () => {
  const now = Date.UTC(2026, 0, 15);
  expect(dueReminders({ dueAt: iso(now + 2 * DAY) }, now)).toContain('duesoon');
  expect(dueReminders({ dueAt: iso(now + 2 * DAY), reminders: { duesoon: iso(now) } }, now)).not.toContain('duesoon');
  expect(dueReminders({ dueAt: iso(now - 2 * DAY) }, now)).toContain('overdue');
  expect(dueReminders({ dueAt: iso(now - 2 * DAY), reminders: { overdue: iso(now - 2 * DAY) } }, now)).not.toContain('overdue');
  expect(dueReminders({ dueAt: iso(now - 2 * DAY), reminders: { overdue: iso(now - 8 * DAY) } }, now)).toContain('overdue');
  expect(dueReminders({ dueAt: iso(now - 2 * DAY), completedAt: iso(now) }, now)).toEqual([]);
});

test('course deadline dates enrollments, surfaces compliance, and nudges overdue learners', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  const stamp = Date.now();

  const course = (await (await api.post('/api/admin/courses', { data: { title: `Deadline ${stamp}`, audience: 'coaches', dueDays: 7 } })).json()).course;
  expect(course.dueDays).toBe(7);
  await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'text', title: 'M', html: '<p>x</p>' } });
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });

  const learner = await playwright.request.newContext({ baseURL: BASE });
  const reg = await (await learner.post('/api/register', { data: { firstName: 'Due', lastName: 'Soon', email: `due+${stamp}@example.com` } })).json();
  const userId = reg.user.id;
  await learner.post(`/api/courses/${course.id}/enroll`);

  // Enrolling dates the learner; the dashboard shows a live compliance state.
  let rec = (await (await api.get('/api/admin/overview')).json()).enrollments.find((e) => e.userId === userId);
  expect(rec.dueAt).toBeTruthy();
  expect(['ontrack', 'duesoon']).toContain(rec.dueState);

  // Admin pushes the deadline into the past → overdue.
  const due = await (await api.post('/api/admin/enrollments/due', { data: { userId, courseId: course.id, dueAt: iso(Date.now() - 2 * DAY) } })).json();
  expect(due.dueState).toBe('overdue');

  // The sweep sends one overdue reminder; a second sweep sends nothing (deduped).
  const run1 = await (await api.post('/api/admin/reminders/run', { data: {} })).json();
  expect(run1.sent).toBeGreaterThanOrEqual(1);
  const run2 = await (await api.post('/api/admin/reminders/run', { data: {} })).json();
  expect(run2.sent).toBe(0);

  // A manual nudge still works, and clearing the deadline removes it.
  const rem = await (await api.post('/api/admin/enrollments/remind', { data: { userId, courseId: course.id } })).json();
  expect(rem.ok).toBe(true);
  expect(rem.kind).toBe('overdue');
  const cleared = await (await api.post('/api/admin/enrollments/due', { data: { userId, courseId: course.id, clear: true } })).json();
  expect(cleared.dueAt).toBe(null);
  expect(cleared.dueState).toBe('none');
});
