// Reset-alert safety net: when a learner's SCORM resume state silently collapses
// (they had real suspend_data / a location, and a heartbeat leaves them with
// neither while the module is still unfinished), staff get a kind:'alert'
// notification — surfaced on the dashboard's own ⚠️ Alerts section, NOT buried
// in the course-completion stream. It fires once per regression, never on a
// deliberate admin "start over" ({reset:true}), and never on a healthy heartbeat.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };
const REAL_SUSPEND = 'A'.repeat(72); // a meaningful resume blob (>= the 32-char floor)

test('a silent progress regression raises exactly one staff alert, split from completions', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  const stamp = Date.now();

  // A one-module SCORM course (no time gate; status stays incomplete throughout).
  const course = (await (await api.post('/api/admin/courses', { data: { title: `Reset Alert Course ${stamp}`, audience: 'referees' } })).json()).course;
  const lessonId = (await (await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'scorm', title: 'Module 4', packageId: 'test-module', minMinutes: 0 } })).json()).lesson.id;
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });

  // Learner registers + enrolls (separate cookie jar).
  const learner = await playwright.request.newContext({ baseURL: BASE });
  const email = `resetalert+${stamp}@example.com`;
  await learner.post('/api/register', { data: { firstName: 'Pat', lastName: 'Learner', email } });
  await learner.post(`/api/courses/${course.id}/enroll`);
  const post = (body) => learner.post(`/api/courses/${course.id}/lessons/${lessonId}/scorm`, { data: body }).then((x) => x.json());

  const alertsFor = async () => {
    const o = await (await api.get('/api/admin/overview')).json();
    const mine = (n) => String(n.body || '').includes(course.title);
    return { alerts: (o.ncysaAlerts || []).filter(mine), notifs: (o.ncysaNotifications || []).filter(mine) };
  };

  // 1) Healthy heartbeats with real resume data → no alert.
  let r = await post({ status: 'incomplete', location: 'slide42', suspendData: REAL_SUSPEND, activeDelta: 5 });
  expect(r.completed).toBe(false);
  r = await post({ status: 'incomplete', location: 'slide43', suspendData: 'B'.repeat(80), activeDelta: 5 });
  expect(r.completed).toBe(false);
  let got = await alertsFor();
  expect(got.alerts.length).toBe(0);

  // 2) The regression: resume blob AND location wiped while still unfinished → ONE alert.
  r = await post({ status: 'incomplete', location: '', suspendData: '', activeDelta: 5 });
  expect(r.completed).toBe(false);
  got = await alertsFor();
  expect(got.alerts.length).toBe(1);
  expect(got.alerts[0].kind).toBe('alert');
  expect(got.alerts[0].title).toBe('Possible progress reset');
  expect(got.alerts[0].body).toContain('Pat Learner');
  expect(got.alerts[0].body).toContain('Module 4');
  // Split correctly: the alert is NOT in the routine completion stream.
  expect(got.notifs.some((n) => n.title === 'Possible progress reset')).toBe(false);

  // 3) Fires once: a further empty heartbeat from the now-empty state adds nothing.
  await post({ status: 'incomplete', location: '', suspendData: '', activeDelta: 5 });
  got = await alertsFor();
  expect(got.alerts.length).toBe(1);

  // 4) A deliberate "start over" never alerts, even from real progress.
  r = await post({ status: 'incomplete', location: 'slide50', suspendData: 'C'.repeat(64), activeDelta: 5 });
  expect(r.completed).toBe(false);
  r = await post({ reset: true });
  expect(r.reset).toBe(true);
  got = await alertsFor();
  expect(got.alerts.length).toBe(1); // unchanged
});
