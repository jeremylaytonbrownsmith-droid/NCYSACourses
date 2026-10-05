// Auth hardening: reserved staff emails can't be self-registered (privilege-
// escalation squatting), login failures are generic (no account enumeration),
// the staff access-code endpoint is rate-limited, and real logins still work.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };

test('a seeded staff email cannot be self-registered as a learner', async ({ playwright }) => {
  const c = await playwright.request.newContext({ baseURL: BASE });
  const res = await c.post('/api/register', { data: { firstName: 'Imp', lastName: 'Oster', email: 'admin@ncysa.org' } });
  expect(res.status()).toBe(403);
  const body = await res.json();
  expect(body.needsPassword).toBe(true);
});

test('login failures are generic (no account enumeration)', async ({ playwright }) => {
  const c = await playwright.request.newContext({ baseURL: BASE });
  const noUser = await c.post('/api/login', { data: { email: `nobody+${Date.now()}@example.com`, password: 'x' } });
  const wrongPw = await c.post('/api/login', { data: { email: ADMIN.email, password: 'definitely-wrong' } });
  expect(noUser.status()).toBe(401);
  expect(wrongPw.status()).toBe(401);
  // Same message for "no such account" and "wrong password" — can't tell them apart.
  expect((await noUser.json()).error).toBe((await wrongPw.json()).error);
});

test('staff access-code endpoint is rate-limited', async ({ playwright }) => {
  const c = await playwright.request.newContext({ baseURL: BASE });
  let got429 = false;
  for (let i = 0; i < 14; i++) {
    const r = await c.post('/api/staff-access', { data: { code: 'wrong-code' } });
    if (r.status() === 429) { got429 = true; break; }
    else expect(r.status()).toBe(403);
  }
  expect(got429).toBe(true);
});

test('a real admin login + a normal learner registration still work', async ({ playwright }) => {
  const admin = await playwright.request.newContext({ baseURL: BASE });
  const a = await admin.post('/api/login', { data: ADMIN });
  expect(a.ok()).toBeTruthy();
  expect((await a.json()).user.role).toBe('admin');
  const me = await (await admin.get('/api/me')).json();
  expect(me.user.role).toBe('admin'); // session (new {userId,exp} shape) resolves

  const learner = await playwright.request.newContext({ baseURL: BASE });
  const reg = await learner.post('/api/register', { data: { firstName: 'Reg', lastName: 'Ular', email: `learner+${Date.now()}@example.com` } });
  expect(reg.ok()).toBeTruthy();
  expect((await reg.json()).user.role).toBe('learner');
});
