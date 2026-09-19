// Partner integration: signed launch token in, signed completion webhook out.
const { test, expect } = require('@playwright/test');
process.env.INTEGRATION_SECRET = 'test-secret-123'; // must match the webServer (playwright.config.js)
const crypto = require('crypto');
const http = require('http');
const { signToken, verifyToken, sendCompletionWebhook, mapScormStatus, scoreObject, allowedCallbackUrl } = require('../lib/integration');

const BASE = 'http://localhost:3100';
const SECRET = 'test-secret-123';
const API_KEY = 'test-api-key-456'; // reconciliation key, separate from the HMAC secret

test('SCORM status maps to the terminal set; unknowns are non-terminal', () => {
  expect(mapScormStatus('completed')).toBe('completed');
  expect(mapScormStatus('passed')).toBe('passed');
  expect(mapScormStatus('failed')).toBe('failed');
  expect(mapScormStatus('incomplete')).toBe('incomplete');
  expect(mapScormStatus('PASSED')).toBe('passed');       // case-insensitive
  expect(mapScormStatus('browsed')).toBeNull();          // non-terminal
  expect(mapScormStatus('not attempted')).toBeNull();
  expect(mapScormStatus('')).toBeNull();
});

test('score object: raw vs scaled pass through so a partner can tell which was reported', () => {
  // Raw score with a reported scale → normalized percentage; scaled stays null (raw mode).
  expect(scoreObject({ raw: 8, min: 0, max: 10 })).toEqual({ raw: 8, min: 0, max: 10, scaled: null, percent: 80 });
  expect(scoreObject({ raw: 45, min: 10, max: 60 })).toEqual({ raw: 45, min: 10, max: 60, scaled: null, percent: 70 });
  // Raw value with no reported scale → percent stays null (no guessing).
  expect(scoreObject({ raw: 82 })).toEqual({ raw: 82, min: null, max: null, scaled: null, percent: null });
  // Scaled (SCORM 2004 percentage mode) → percent derived from scaled, raw null.
  expect(scoreObject({ scaled: 0.82 })).toEqual({ raw: null, min: null, max: null, scaled: 0.82, percent: 82 });
  // If both are reported, both pass through and percent follows the scaled value.
  expect(scoreObject({ raw: 9, min: 0, max: 10, scaled: 0.9 })).toEqual({ raw: 9, min: 0, max: 10, scaled: 0.9, percent: 90 });
  // No score reported at all → null (not 0).
  expect(scoreObject(null)).toBeNull();
  expect(scoreObject({})).toBeNull();
});

test('per-launch callback URL: https required, loopback http allowed, allow-list enforced', () => {
  delete process.env.INTEGRATION_CALLBACK_ALLOWED_HOSTS;
  // With no allow-list: any https URL is accepted; http is rejected except loopback.
  expect(allowedCallbackUrl('https://nc.oms.example.com/hook')).toBe('https://nc.oms.example.com/hook');
  expect(allowedCallbackUrl('http://evil.example.com/hook')).toBeNull();       // http, not loopback
  expect(allowedCallbackUrl('http://127.0.0.1:3132/hook')).toBe('http://127.0.0.1:3132/hook'); // loopback ok
  expect(allowedCallbackUrl('not-a-url')).toBeNull();
  expect(allowedCallbackUrl('')).toBeNull();
  expect(allowedCallbackUrl(undefined)).toBeNull();
  // With an allow-list: only matching host suffixes pass.
  process.env.INTEGRATION_CALLBACK_ALLOWED_HOSTS = 'oms.example.com';
  expect(allowedCallbackUrl('https://nc.oms.example.com/hook')).toBe('https://nc.oms.example.com/hook');
  expect(allowedCallbackUrl('https://oms.example.com/hook')).toBe('https://oms.example.com/hook');
  expect(allowedCallbackUrl('https://somewhere-else.com/hook')).toBeNull();
  delete process.env.INTEGRATION_CALLBACK_ALLOWED_HOSTS;
});

test('launch token signs and verifies; tampering and expiry are rejected', async () => {
  const tok = signToken({ refId: 'OMS-1', email: 'a@b.com', moduleId: 'x' }, SECRET, 60);
  expect(verifyToken(tok, SECRET).refId).toBe('OMS-1');
  expect(() => verifyToken(tok + 'x', SECRET)).toThrow();       // tampered signature
  expect(() => verifyToken(tok, 'wrong-secret')).toThrow();     // wrong secret
  expect(() => verifyToken(signToken({ refId: 'z' }, SECRET, -10), SECRET)).toThrow(); // expired
});

test('completion webhook is POSTed with a valid HMAC signature', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { received.push({ sig: req.headers['x-getmatchready-signature'], body }); res.writeHead(200); res.end('ok'); });
  });
  await new Promise((r) => server.listen(0, r));
  process.env.INTEGRATION_WEBHOOK_URL = `http://127.0.0.1:${server.address().port}/hook`;
  try {
    const result = await sendCompletionWebhook({ event: 'module.completed', refId: 'OMS-42', moduleId: 'demo' });
    expect(result.sent).toBe(true);
    expect(received).toHaveLength(1);
    const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(received[0].body).digest('hex');
    expect(received[0].sig).toBe(expected);
    expect(JSON.parse(received[0].body).refId).toBe('OMS-42');
  } finally {
    delete process.env.INTEGRATION_WEBHOOK_URL;
    server.close();
  }
});

test('the bundled short OMG webhook-test course is available to launch', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  const token = signToken({ refId: 'OMS-WT', email: 'wt@example.com', name: 'WT', moduleId: 'omg-webhook-test' }, SECRET, 300);
  const res = await api.get(`/launch?token=${token}`, { maxRedirects: 0 });
  expect(res.status()).toBe(302); // 302 = launched (course exists); a 404 would mean the migration did not create it
});

test('a 5xx from the partner endpoint is reported as retries-exhausted with the status', async () => {
  const server = http.createServer((req, res) => { res.writeHead(500); res.end('boom'); });
  await new Promise((r) => server.listen(0, r));
  try {
    const result = await sendCompletionWebhook({ event: 'module.completed' }, `http://127.0.0.1:${server.address().port}/hook`);
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('retries-exhausted');
    expect(result.status).toBe(500); // the partner's endpoint is up but erroring on the payload
  } finally {
    server.close();
  }
});

test('a signed launch link signs the referee in and enrolls them', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  const courseId = (await (await api.post('/api/admin/courses', { data: { title: 'Launch Target', audience: 'referees' } })).json()).course.id;
  await api.post(`/api/admin/courses/${courseId}/publish`, { data: { published: true } });

  const token = signToken({ refId: 'OMS-778', name: 'Ref Launch', email: 'ref.launch@example.com', moduleId: courseId, org: 'NC' }, SECRET, 300);

  const ctx = await playwright.request.newContext({ baseURL: BASE });
  const res = await ctx.get(`/launch?token=${token}`, { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers()['location']).toContain(`/#/course/${courseId}`);

  // The launch set a session cookie → the referee is signed in, no password.
  const me = await (await ctx.get('/api/me')).json();
  expect(me.user.email).toBe('ref.launch@example.com');
  expect(me.user.role).toBe('learner');

  // …and enrolled in the target module.
  const courses = (await (await ctx.get('/api/courses?org=ncysa')).json()).courses;
  expect(courses.find((c) => c.id === courseId).enrolled).toBe(true);
});

test('an invalid launch token is refused', async ({ request }) => {
  const res = await request.get('/launch?token=not-a-real-token', { maxRedirects: 0 });
  expect(res.status()).toBe(400);
});

test('the reconciliation API returns a referee\'s enrollments (bearer-authenticated)', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  const courseId = (await (await api.post('/api/admin/courses', { data: { title: 'Recon Target', audience: 'referees' } })).json()).course.id;
  await api.post(`/api/admin/courses/${courseId}/publish`, { data: { published: true } });
  const token = signToken({ refId: 'OMS-RC-1', name: 'Recon Ref', email: 'recon@example.com', moduleId: courseId, org: 'NC' }, SECRET, 300);
  const ctx = await playwright.request.newContext({ baseURL: BASE });
  await ctx.get(`/launch?token=${token}`, { maxRedirects: 0 });

  // Missing/incorrect key is refused — and the HMAC secret is NOT the API key.
  expect((await ctx.get('/api/v1/completions?refId=OMS-RC-1')).status()).toBe(401);
  expect((await ctx.get('/api/v1/completions?refId=OMS-RC-1', { headers: { Authorization: 'Bearer wrong' } })).status()).toBe(401);
  expect((await ctx.get('/api/v1/completions?refId=OMS-RC-1', { headers: { Authorization: `Bearer ${SECRET}` } })).status()).toBe(401);

  // The separate per-tenant API key returns the referee's enrollment (in-progress until completed).
  const ok = await ctx.get('/api/v1/completions?refId=OMS-RC-1', { headers: { Authorization: `Bearer ${API_KEY}` } });
  expect(ok.status()).toBe(200);
  const rows = await ok.json();
  const row = rows.find((r) => r.moduleId === courseId);
  expect(row).toBeTruthy();
  expect(row.status).toBe('in-progress');
  expect(row.org).toBe('NC'); // the launch token's org is returned for reconciliation
  expect(row.score).toBeNull(); // no score reported yet

  // Optional moduleId filter: narrow to a single module instead of the whole array.
  const one = await (await ctx.get(`/api/v1/completions?refId=OMS-RC-1&moduleId=${courseId}`, { headers: { Authorization: `Bearer ${API_KEY}` } })).json();
  expect(one).toHaveLength(1);
  expect(one[0].moduleId).toBe(courseId);
  // Lowercase spelling also works; a non-matching module returns an empty array.
  const oneLc = await (await ctx.get(`/api/v1/completions?refId=OMS-RC-1&moduleid=${courseId}`, { headers: { Authorization: `Bearer ${API_KEY}` } })).json();
  expect(oneLc).toHaveLength(1);
  const none = await (await ctx.get('/api/v1/completions?refId=OMS-RC-1&moduleId=does-not-exist', { headers: { Authorization: `Bearer ${API_KEY}` } })).json();
  expect(none).toHaveLength(0);
});
