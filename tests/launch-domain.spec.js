// Learner-facing links open on the COURSE'S org domain, and the header brands the
// course from its own record. Both halves of the same bug: an NCSRA course's demo
// link was minted on PUBLIC_URL (getmatchready.app, OMG's domain), and — because
// the course was a draft, absent from the public list the header reads — the brand
// fell back to the host's org, so an NCSRA course opened under "OMG Referee
// Education". Neither the domain nor the draft state may change whose course it is.
const { test, expect } = require('@playwright/test');
const { publicBaseForOrg } = require('../lib/integration');

const BASE = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };

test('publicBaseForOrg: each org gets its own front door in production; dev stays on this host', () => {
  const prod = { PUBLIC_URL: 'https://getmatchready.app/' };
  // Known orgs → their own domains, whatever PUBLIC_URL points at.
  expect(publicBaseForOrg('omg', { env: prod })).toBe('https://getmatchready.app');
  expect(publicBaseForOrg('ncysa', { env: prod })).toBe('https://ncysalearn.app');
  expect(publicBaseForOrg('ncsra', { env: prod })).toBe('https://ncysalearn.app');
  expect(publicBaseForOrg(undefined, { env: prod })).toBe('https://ncysalearn.app'); // no org = the NC default
  // An explicit per-org override wins (same env-name scheme as INTEGRATION_SECRET_<ORG>).
  expect(publicBaseForOrg('ncysa', { env: { ...prod, PUBLIC_URL_NCYSA: 'https://learn.example.org/' } })).toBe('https://learn.example.org');
  expect(publicBaseForOrg('omg', { env: { ...prod, PUBLIC_URL_OMG: 'https://omg.example.org' } })).toBe('https://omg.example.org');
  // An org we have no front door for falls back to the configured product URL.
  expect(publicBaseForOrg('newpartner', { env: prod })).toBe('https://getmatchready.app');
  // Dev / tests: no PUBLIC_URL or APP_URL → the request host, for every org.
  expect(publicBaseForOrg('ncysa', { env: {}, requestBase: 'http://localhost:3100/' })).toBe('http://localhost:3100');
  expect(publicBaseForOrg('omg', { env: {}, requestBase: 'http://localhost:3100' })).toBe('http://localhost:3100');
  expect(publicBaseForOrg('ncysa', { env: { RENDER_EXTERNAL_URL: 'https://x.onrender.com/' } })).toBe('https://x.onrender.com');
});

test("a demo link for a DRAFT co-branded course opens with the course's brand in the header", async ({ page, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  const stamp = Date.now();

  // An NCSRA-branded referee course, deliberately left UNPUBLISHED: previewing a
  // draft through a demo link is exactly how a new course gets checked.
  const course = (await (await api.post('/api/admin/courses', { data: { title: `Assignor Draft ${stamp}`, audience: 'referees' } })).json()).course;
  // Branding is saved on update (the create route takes only title/audience/org),
  // which is exactly what the Designer's form does.
  expect((await api.put(`/api/admin/courses/${course.id}`, { data: { coBrandName: 'NCSRA Referee Education' } })).ok()).toBeTruthy();
  await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'text', title: 'Read', html: '<p>x</p>' } });
  const saved = (await (await api.get(`/api/admin/courses/${course.id}`)).json()).course;
  expect(saved.coBrandName).toBe('NCSRA Referee Education');
  expect(!!saved.published).toBe(false);

  const r = await (await api.post('/api/admin/integration/test-link', { data: { courseId: course.id } })).json();
  expect(r.url).toContain('/launch?token=');
  expect(r.url.startsWith(BASE)).toBe(true); // test env has no PUBLIC_URL → stays on this host

  // Open it as the demo learner. The header must wear the COURSE's brand — not
  // "NCYSA Learn" (the draft isn't in the public list) and never the host's org.
  await page.goto(r.url);
  await expect(page.locator('.topnav .brandname')).toHaveText('NCSRA Referee Education', { timeout: 15000 });
});
