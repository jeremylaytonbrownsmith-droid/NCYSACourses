// Partner integration: signed launch token in, signed completion webhook out.
const { test, expect } = require('@playwright/test');
process.env.INTEGRATION_SECRET = 'test-secret-123'; // must match the webServer (playwright.config.js)
const crypto = require('crypto');
const http = require('http');
const { signToken, verifyToken, sendCompletionWebhook } = require('../lib/integration');

const BASE = 'http://localhost:3100';
const SECRET = 'test-secret-123';

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

  // Missing/incorrect bearer is refused.
  expect((await ctx.get('/api/v1/completions?refId=OMS-RC-1')).status()).toBe(401);
  expect((await ctx.get('/api/v1/completions?refId=OMS-RC-1', { headers: { Authorization: 'Bearer wrong' } })).status()).toBe(401);

  // Correct bearer returns the referee's enrollment (in-progress until completed).
  const ok = await ctx.get('/api/v1/completions?refId=OMS-RC-1', { headers: { Authorization: `Bearer ${SECRET}` } });
  expect(ok.status()).toBe(200);
  const rows = await ok.json();
  const row = rows.find((r) => r.moduleId === courseId);
  expect(row).toBeTruthy();
  expect(row.status).toBe('in-progress');
});
