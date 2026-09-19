// SCORM 2004 support: a Captivate/2004 package talks to window.API_1484_11
// (Initialize / SetValue completion_status+success_status / Commit / Terminate),
// not the SCORM 1.2 window.API. This drives the bundled 2004 sample in a real
// browser and asserts the completion webhook fires with the mapped status+score,
// proving the 2004 runtime shim works end to end.
const { test, expect } = require('@playwright/test');
const http = require('http');
const { signToken } = require('../lib/integration');

const BASE = 'http://localhost:3100';
const SECRET = 'test-secret-123';
const HOOK_PORT = 3133; // per-launch callback endpoint for this spec

let server, received = [];
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { try { received.push(JSON.parse(body)); } catch (_) {} res.writeHead(200); res.end('ok'); });
  });
  await new Promise((r) => server.listen(HOOK_PORT, '127.0.0.1', r));
});
test.afterAll(async () => { await new Promise((r) => server.close(r)); });

let courseId, lessonId;
test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  courseId = (await (await api.post('/api/admin/courses', { data: { title: 'SCORM 2004 Module', audience: 'referees' } })).json()).course.id;
  lessonId = (await (await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'scorm', title: 'Welcome Screen', packageId: 'test-2004', minMinutes: 0 } })).json()).lesson.id;
  await api.post(`/api/admin/courses/${courseId}/publish`, { data: { published: true } });
});

test('a SCORM 2004 package reports completion and fires the webhook', async ({ page }) => {
  const token = signToken({
    refId: 'OMS-2004', name: 'Sam Referee', email: 's2004@example.com', moduleId: courseId, org: 'NC',
    callbackUrl: `http://127.0.0.1:${HOOK_PORT}/state-nc`,
  }, SECRET, 300);

  // Launch signs the referee in and lands on the course.
  await page.goto(`${BASE}/launch?token=${token}`);
  // Open the module lesson and drive the embedded 2004 SCO.
  await page.goto(`${BASE}/#/course/${courseId}/lesson/${lessonId}`);
  const frame = page.frameLocator('#scormFrame');
  await expect(frame.locator('#finish')).toBeVisible({ timeout: 15000 });
  await frame.locator('#finish').click();

  // The 2004 completion should reach the per-launch webhook as a passed result.
  await expect.poll(() => received.find((p) => p.refId === 'OMS-2004')?.status, { timeout: 8000 }).toBe('passed');
  const hook = received.find((p) => p.refId === 'OMS-2004');
  expect(hook.event).toBe('module.passed');
  expect(hook.score).toEqual({ raw: 1, min: 0, max: 1, scaled: 1, percent: 100 });
});
