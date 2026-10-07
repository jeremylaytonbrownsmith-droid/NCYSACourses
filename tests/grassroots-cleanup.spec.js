// Grassroots demo course cleanup: the unrelated sample video lesson is removed,
// every text lesson has a 15-second reading gate, and the final exam has 5
// questions. Applied by the one-time fixGrassrootsCourse() migration at boot.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };

test('the Grassroots course has no video lesson, 15s reading gates, and a 5-question exam', async ({ playwright }) => {
  const c = await playwright.request.newContext({ baseURL: BASE });
  expect((await c.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  const res = await c.get('/api/admin/courses/grassroots-coaching-license');
  expect(res.ok()).toBeTruthy();
  const course = (await res.json()).course;

  // No video lesson remains.
  expect((course.lessons || []).some((l) => l.type === 'video')).toBe(false);

  // Every reading lesson holds the learner for 15 seconds.
  const text = course.lessons.filter((l) => l.type === 'text');
  expect(text.length).toBeGreaterThan(0);
  expect(text.every((l) => l.minSeconds === 15)).toBe(true);

  // The final exam exists with 5 questions.
  const quiz = course.lessons.find((l) => l.type === 'quiz');
  expect(quiz).toBeTruthy();
  expect(quiz.questions.length).toBe(5);
});
