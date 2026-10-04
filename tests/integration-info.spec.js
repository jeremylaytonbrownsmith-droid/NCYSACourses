// The Integration kit's read-only info endpoint powers the Course Designer's
// "🔌 Integration" panel. It must describe the contract (paths, signature header,
// webhook/launch fields) WITHOUT ever leaking the shared secret or API key, and
// stay gated to staff.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };
const PARTNER = { email: 'partner@omgtsys.com', password: 'omg-partner-2026' };

async function ctx(playwright, creds) {
  const c = await playwright.request.newContext({ baseURL: BASE });
  const r = await c.post('/api/login', { data: creds });
  expect(r.ok()).toBeTruthy();
  return c;
}

test('integration info describes the contract and leaks no secrets', async ({ playwright }) => {
  const admin = await ctx(playwright, ADMIN);
  const res = await admin.get('/api/admin/integration/info');
  expect(res.ok()).toBeTruthy();
  const info = await res.json();

  expect(info.signatureHeader).toBe('X-GetMatchReady-Signature');
  expect(info.paths.reconcile).toBe('/api/v1/completions');
  expect(info.paths.testWebhook).toBe('/api/v1/test-webhook');
  expect(info.webhookFields).toEqual(expect.arrayContaining(['event', 'refId', 'moduleId', 'status', 'score', 'completedAt', 'certificateId']));
  expect(info.launchClaims).toEqual(expect.arrayContaining(['refId', 'moduleId', 'org']));
  expect(typeof info.enabled).toBe('boolean');

  // Nothing secret may ever appear in this payload.
  const blob = JSON.stringify(info).toLowerCase();
  for (const bad of ['secret', 'api_key', 'apikey', 'bearer ', 'authorization', 'password', 'private']) {
    expect(blob).not.toContain(bad);
  }
});

test('integration info is available to a scoped partner', async ({ playwright }) => {
  const partner = await ctx(playwright, PARTNER);
  const res = await partner.get('/api/admin/integration/info');
  expect(res.ok()).toBeTruthy();
  const info = await res.json();
  expect(info.signatureHeader).toBe('X-GetMatchReady-Signature');
});

test('integration info rejects a learner', async ({ playwright }) => {
  const c = await playwright.request.newContext({ baseURL: BASE });
  const res = await c.get('/api/admin/integration/info');
  expect(res.status()).toBeGreaterThanOrEqual(401);
});

test('the Zite one-pager is served, describes the contract, and leaks no secret', async ({ playwright }) => {
  const c = await playwright.request.newContext({ baseURL: BASE });
  const res = await c.get('/zite');
  expect(res.ok()).toBeTruthy();
  const html = await res.text();
  // It documents the real contract...
  expect(html).toContain('X-GetMatchReady-Signature');
  expect(html).toContain('/launch?token=');
  expect(html).toContain('/api/v1/completions');
  // ...but never the actual secret or API-key VALUES (the test server's are known).
  expect(html).not.toContain('test-secret-123');
  expect(html).not.toContain('test-api-key-456');
});
