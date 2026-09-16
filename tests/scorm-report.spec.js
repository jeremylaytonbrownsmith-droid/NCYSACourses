// SCORM outcome reporting: the completion webhook and reconciliation API must
// carry the real SCORM status (completed / passed / failed / incomplete) and the
// score (absolute with a scale, or percentage-style), and the webhook must fire
// on ANY terminal status — not only on completion. A local receiver on the port
// the test server is configured to call (see playwright.config.js) captures the
// outbound webhooks.
const { test, expect } = require('@playwright/test');
const http = require('http');
const { signToken } = require('../lib/integration');

const BASE = 'http://localhost:3100';
const SECRET = 'test-secret-123';
const API_KEY = 'test-api-key-456';
const HOOK_PORT = 3131; // must match INTEGRATION_WEBHOOK_URL in playwright.config.js
const HOOK2_PORT = 3132; // a per-launch (per-state) endpoint, set via the token's callbackUrl

function receiver(store) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try { store.push({ sig: req.headers['x-getmatchready-signature'], payload: JSON.parse(body) }); } catch (_) {}
      res.writeHead(200); res.end('ok');
    });
  });
}

let server, server2, received = [], received2 = [];
test.beforeAll(async () => {
  server = receiver(received);
  server2 = receiver(received2);
  await new Promise((r) => server.listen(HOOK_PORT, '127.0.0.1', r));
  await new Promise((r) => server2.listen(HOOK2_PORT, '127.0.0.1', r));
});
test.afterAll(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => server2.close(r));
});

async function waitForHook(refId, arr = received, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = arr.find((h) => h.payload && h.payload.refId === refId);
    if (hit) return hit.payload;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no webhook received for ${refId}`);
}

let courseId, lessonId;
test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  courseId = (await (await api.post('/api/admin/courses', { data: { title: 'Outcome Module', audience: 'referees' } })).json()).course.id;
  lessonId = (await (await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'scorm', title: 'M1', packageId: 'test-module', minMinutes: 0 } })).json()).lesson.id;
  await api.post(`/api/admin/courses/${courseId}/publish`, { data: { published: true } });
});

// Launch a partner referee and return a request context carrying their session.
async function launch(playwright, refId, email, extra = {}) {
  const token = signToken({ refId, name: refId, email, moduleId: courseId, org: 'NC', returnUrl: 'https://oms.example.com/back', ...extra }, SECRET, 300);
  const ctx = await playwright.request.newContext({ baseURL: BASE });
  const res = await ctx.get(`/launch?token=${token}`, { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  return ctx;
}
const postScorm = (ctx, body) => ctx.post(`/api/courses/${courseId}/lessons/${lessonId}/scorm`, { data: body });
const recon = (ctx, refId) => ctx.get(`/api/v1/completions?refId=${refId}`, { headers: { Authorization: `Bearer ${API_KEY}` } });

test('passed with an absolute score reports passed + a normalized percentage', async ({ playwright }) => {
  const ctx = await launch(playwright, 'OMS-PASS', 'pass@example.com');
  await postScorm(ctx, { status: 'passed', scoreRaw: 8, scoreMin: 0, scoreMax: 10 });
  const hook = await waitForHook('OMS-PASS');
  expect(hook.event).toBe('module.passed');
  expect(hook.status).toBe('passed');
  expect(hook.score).toEqual({ raw: 8, min: 0, max: 10, percent: 80 });
  expect(hook.certificateId).toBeTruthy();

  const row = (await (await recon(ctx, 'OMS-PASS')).json()).find((r) => r.moduleId === courseId);
  expect(row.status).toBe('passed');
  expect(row.score.percent).toBe(80);
});

test('a failed attempt reports failed and still reaches the partner (no completion)', async ({ playwright }) => {
  const ctx = await launch(playwright, 'OMS-FAIL', 'fail@example.com');
  // Percentage-style score with no reported scale → percent stays null (no guessing).
  await postScorm(ctx, { status: 'failed', scoreRaw: 40 });
  const hook = await waitForHook('OMS-FAIL');
  expect(hook.event).toBe('module.failed');
  expect(hook.status).toBe('failed');
  expect(hook.score).toEqual({ raw: 40, min: null, max: null, percent: null });
  expect(hook.certificateId).toBeNull(); // failing does not mint a certificate

  const row = (await (await recon(ctx, 'OMS-FAIL')).json()).find((r) => r.moduleId === courseId);
  expect(row.status).toBe('failed');
  expect(row.score.raw).toBe(40);
  expect(row.score.percent).toBeNull();
});

test('an incomplete finish (Captivate failed-test case) reports incomplete', async ({ playwright }) => {
  const ctx = await launch(playwright, 'OMS-INC', 'inc@example.com');
  await postScorm(ctx, { status: 'incomplete', finished: true });
  const hook = await waitForHook('OMS-INC');
  expect(hook.event).toBe('module.incomplete');
  expect(hook.status).toBe('incomplete');

  const row = (await (await recon(ctx, 'OMS-INC')).json()).find((r) => r.moduleId === courseId);
  expect(row.status).toBe('incomplete');
});

test('a plain completed (no score) reports completed with a null score', async ({ playwright }) => {
  const ctx = await launch(playwright, 'OMS-DONE', 'done@example.com');
  await postScorm(ctx, { status: 'completed' });
  const hook = await waitForHook('OMS-DONE');
  expect(hook.event).toBe('module.completed');
  expect(hook.status).toBe('completed');
  expect(hook.score).toBeNull();

  const row = (await (await recon(ctx, 'OMS-DONE')).json()).find((r) => r.moduleId === courseId);
  expect(row.status).toBe('completed');
  expect(row.score).toBeNull();
});

test('partner-webhook deliveries are logged for the admin dashboard', async ({ playwright }) => {
  const ctx = await launch(playwright, 'OMS-LOG', 'log@example.com');
  await postScorm(ctx, { status: 'passed', scoreRaw: 7, scoreMin: 0, scoreMax: 10 });
  const admin = await playwright.request.newContext({ baseURL: BASE });
  await admin.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  const entryOf = async () => {
    const overview = await (await admin.get('/api/admin/overview')).json();
    return (overview.partnerWebhooks || []).find((w) => w.refId === 'OMS-LOG');
  };
  await expect.poll(async () => (await entryOf())?.ok, { timeout: 6000 }).toBe(true); // delivered (200)
  const entry = await entryOf();
  expect(entry.status).toBe('passed');
  expect(entry.httpStatus).toBe(200);
  expect(entry.url).toContain('3131'); // the global receiver
});

test('a per-launch callbackUrl routes the completion to that endpoint, not the global one', async ({ playwright }) => {
  const ctx = await launch(playwright, 'OMS-CB', 'cb@example.com', { callbackUrl: `http://127.0.0.1:${HOOK2_PORT}/state-nc` });
  await postScorm(ctx, { status: 'passed', scoreRaw: 9, scoreMin: 0, scoreMax: 10 });
  // It arrives at the per-launch endpoint...
  const hook = await waitForHook('OMS-CB', received2);
  expect(hook.event).toBe('module.passed');
  expect(hook.status).toBe('passed');
  // ...and not at the global one.
  expect(received.find((h) => h.payload && h.payload.refId === 'OMS-CB')).toBeFalsy();
});
