// Reading-time gate on plain text lessons: the Course Designer now exposes a
// "Minimum reading time (seconds)" field, and the AI builder's lessonMinSeconds
// applies one to every generated reading lesson. Both save `minSeconds` on the
// text lesson, which the player uses to hold the Complete button.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };

async function admin(playwright) {
  const c = await playwright.request.newContext({ baseURL: BASE });
  expect((await c.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  return c;
}

test('a text lesson saves and updates its minimum reading time', async ({ playwright }) => {
  const a = await admin(playwright);
  const course = (await (await a.post('/api/admin/courses', { data: { title: `ReadGate ${Date.now()}`, audience: 'coaches' } })).json()).course;
  // Create with a 30s gate (what the Course Designer field sends).
  await a.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'text', title: 'Reading', html: '<p>Read me</p>', minSeconds: 30 } });
  let lesson = (await (await a.get(`/api/admin/courses/${course.id}`)).json()).course.lessons[0];
  expect(lesson.type).toBe('text');
  expect(lesson.minSeconds).toBe(30);

  // Editing it (PUT) updates the gate, including turning it off with 0.
  await a.put(`/api/admin/courses/${course.id}/lessons/${lesson.id}`, { data: { type: 'text', title: 'Reading', html: '<p>Read me</p>', minSeconds: 0 } });
  lesson = (await (await a.get(`/api/admin/courses/${course.id}`)).json()).course.lessons[0];
  expect(lesson.minSeconds).toBe(0);
});

test('the AI builder applies lessonMinSeconds to its reading lessons', async ({ playwright }) => {
  // Pure-path check via normalizeDraft (no AI call): lessonMinSeconds flows onto
  // every generated reading lesson.
  const { normalizeDraft } = require('../lib/aicourse');
  const draft = normalizeDraft(
    { title: 'T', lessons: [{ title: 'L1', html: '<p>a</p>' }, { title: 'L2', html: '<p>b</p>' }], quiz: { questions: [{ prompt: 'q', options: ['a', 'b'], answer: 0 }] } },
    { lessonMinSeconds: 45 }
  );
  const reading = draft.lessons.filter((l) => l.type === 'text');
  expect(reading.length).toBeGreaterThan(0);
  expect(reading.every((l) => l.minSeconds === 45)).toBe(true);
});
