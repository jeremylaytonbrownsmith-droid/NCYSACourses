// Security hardening: baseline response headers, and brute-force protection on
// password (staff/admin) sign-in. These lock in the protections so a future
// change can't quietly remove them.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';

test('baseline security headers are present on responses', async ({ request }) => {
  const res = await request.get(`${BASE}/`);
  const h = res.headers();
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['x-frame-options']).toBe('SAMEORIGIN');
  expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
});

test('quiz answers are never exposed to the learner', async ({ request }) => {
  // The public course view must strip the correct-answer field from quiz items.
  const { courses } = await (await request.get(`${BASE}/api/courses`)).json();
  const quizCourse = courses.find((c) => (c.lessons || []).some((l) => l.type === 'quiz'));
  if (!quizCourse) return; // no quiz course seeded in this run
  const q = quizCourse.lessons.find((l) => l.type === 'quiz');
  for (const item of (q.questions || [])) {
    expect(item).not.toHaveProperty('answer');
  }
});

test('password sign-in locks out after repeated failures (brute-force guard)', async ({ playwright }) => {
  // The brute-force lock is keyed on the ACCOUNT (not the IP), so locking an
  // account out here would break any parallel test that signs in as it. Use the
  // owner account, which no other test uses — its lockout is isolated to this test.
  const api = await playwright.request.newContext({ baseURL: BASE });
  const bad = { email: 'jeremy.layton.brown.smith@gmail.com', password: 'definitely-wrong' };
  let sawLockout = false;
  for (let i = 0; i < 12; i++) {
    const r = await api.post('/api/login', { data: bad });
    if (r.status() === 429) { sawLockout = true; break; }
    expect(r.status()).toBe(401); // until locked, each wrong try is a normal 401
  }
  expect(sawLockout).toBe(true);
});
