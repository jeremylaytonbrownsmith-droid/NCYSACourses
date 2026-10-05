// Certificate upgrade: the right entity's logo on every cert (never the NCYSA
// fallback), a public verify page + JSON, and a QR/verify URL in the payload.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };

async function admin(playwright) {
  const c = await playwright.request.newContext({ baseURL: BASE });
  expect((await c.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  return c;
}

// Build a course (no coLogoUrl, so the server must resolve the correct entity
// logo), complete it as a fresh learner, and return the minted certId + payload.
async function earnCert(playwright, { audience, orgId }) {
  const a = await admin(playwright);
  const stamp = Date.now() + Math.floor(Math.random() * 1e6);
  const course = (await (await a.post('/api/admin/courses', { data: { title: `Cert ${audience}-${orgId || 'def'} ${stamp}`, audience, ...(orgId ? { orgId } : {}) } })).json()).course;
  await a.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'text', title: 'Read', html: '<p>hello</p>' } });
  await a.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });
  const full = (await (await a.get(`/api/admin/courses/${course.id}`)).json()).course;
  const lessonId = full.lessons[0].id;

  const learner = await playwright.request.newContext({ baseURL: BASE });
  await learner.post('/api/register', { data: { firstName: 'Cert', lastName: 'Tester', email: `cert+${stamp}@example.com` } });
  await learner.post(`/api/courses/${course.id}/enroll`);
  const done = await (await learner.post(`/api/courses/${course.id}/lessons/${lessonId}/complete`, { data: {} })).json();
  expect(done.courseCompleted).toBeTruthy();
  expect(done.certId).toBeTruthy();
  const cert = await (await learner.get(`/api/certificate/${done.certId}`)).json();
  return { certId: done.certId, cert, learner };
}

test('certificate carries the correct entity logo + a verify URL and QR', async ({ playwright }) => {
  const ref = await earnCert(playwright, { audience: 'referees' });     // NCSRA
  expect(ref.cert.logoUrl).toBe('/media/ncsra-logo.png');
  expect(ref.cert.org).toContain('Referee');
  expect(ref.cert.verifyUrl).toContain(`/verify/${ref.certId}`);
  expect(ref.cert.qrDataUrl).toMatch(/^data:image\/png;base64,/);

  const coach = await earnCert(playwright, { audience: 'coaches' });    // NCYSA
  expect(coach.cert.logoUrl).toBe('/media/ncysa-logo.png');

  const omg = await earnCert(playwright, { audience: 'referees', orgId: 'omg' }); // OMG
  expect(omg.cert.logoUrl).toBe('/media/omg-logo.png');
  expect(omg.cert.org).toContain('Officials Management');
});

test('public verify endpoints confirm a real cert and reject a bogus one', async ({ playwright }) => {
  const { certId, cert } = await earnCert(playwright, { audience: 'referees' });
  const pub = await playwright.request.newContext({ baseURL: BASE });

  const okJson = await (await pub.get(`/api/verify/${certId}`)).json();
  expect(okJson.valid).toBe(true);
  expect(okJson.certId).toBe(certId);

  const okPage = await pub.get(`/verify/${certId}`);
  expect(okPage.ok()).toBeTruthy();
  const html = await okPage.text();
  expect(html).toContain('Valid certificate');
  expect(html).toContain('Cert Tester');

  const bad = await pub.get('/api/verify/NOPE-123');
  expect(bad.status()).toBe(404);
  const badPage = await pub.get('/verify/NOPE-123');
  expect(badPage.ok()).toBeTruthy(); // page renders…
  expect(await badPage.text()).toContain('not found'); // …with a not-found state
});
