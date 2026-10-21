// The catalog shows the admin's "Est. minutes" exactly as set — it is never
// overridden by a content estimate (that only fills in when no value is set).
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const DESIGNER = { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' };

test('the admin-set Est. minutes is authoritative, even below the content estimate', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: DESIGNER })).ok()).toBeTruthy();
  const stamp = Date.now();
  const course = (await (await api.post('/api/admin/courses', { data: { title: `Timed Course ${stamp}`, audience: 'referees' } })).json()).course;
  // 40 minutes of gated content...
  for (const n of [1, 2, 3, 4]) {
    await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'text', title: `L${n}`, html: '<p>x</p>', minSeconds: 600 } });
  }
  // ...but the admin says the course really takes 25 minutes.
  await api.put(`/api/admin/courses/${course.id}`, { data: { estMinutes: 25 } });
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });

  const catalog = await (await api.get('/api/courses?org=ncysa')).json();
  const shown = catalog.courses.find((c) => c.id === course.id);
  expect(shown).toBeTruthy();
  expect(shown.estMinutes).toBe(25); // the admin's value wins — not the 40-min content estimate
});
