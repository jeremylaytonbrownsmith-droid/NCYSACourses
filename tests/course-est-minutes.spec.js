// The catalog's "~X min" is computed from real lesson time gates, so it can't
// understate the course (the hand-typed estMinutes is only used if it's higher).
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const DESIGNER = { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' };

test('catalog estMinutes reflects the real module times, not a too-low stored value', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: DESIGNER })).ok()).toBeTruthy();
  const stamp = Date.now();
  // New course defaults estMinutes to 30.
  const course = (await (await api.post('/api/admin/courses', { data: { title: `Timed Course ${stamp}`, audience: 'referees' } })).json()).course;
  // Four reading lessons, each gated at 600s (10 min) → 40 min of real content,
  // which is MORE than the stored 30-minute default.
  for (const n of [1, 2, 3, 4]) {
    await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'text', title: `L${n}`, html: '<p>x</p>', minSeconds: 600 } });
  }
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });

  const catalog = await (await api.get('/api/courses?org=ncysa')).json();
  const shown = catalog.courses.find((c) => c.id === course.id);
  expect(shown).toBeTruthy();
  expect(shown.estMinutes).toBe(40); // computed from the 4×10-min gates, not the 30-min default
});
