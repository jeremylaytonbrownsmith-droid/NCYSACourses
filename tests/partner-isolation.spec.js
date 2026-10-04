// Org-scoped partner admin — the isolation guarantees. A `partner` account bound
// to one org (OMG) must ONLY ever see/manage its own org's data, never NCYSA/NCSRA.
// Super-admin keeps full access. These are the security regression tests.
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

test('partner login resolves to the partner role bound to its org', async ({ playwright }) => {
  const c = await ctx(playwright, PARTNER);
  const me = await (await c.get('/api/me')).json();
  expect(me.user.role).toBe('partner');
  expect(me.user.orgId).toBe('omg');
});

test('partner course list and overview are limited to its org', async ({ playwright }) => {
  const admin = await ctx(playwright, ADMIN);
  const partner = await ctx(playwright, PARTNER);
  const stamp = Date.now();
  // One NCYSA course, one OMG course.
  const nc = (await (await admin.post('/api/admin/courses', { data: { title: `Iso NCYSA ${stamp}`, audience: 'coaches' } })).json()).course;
  const omg = (await (await admin.post('/api/admin/courses', { data: { title: `Iso OMG ${stamp}`, audience: 'referees', orgId: 'omg' } })).json()).course;
  expect(nc.orgId).not.toBe('omg');
  expect(omg.orgId).toBe('omg');

  // The partner's designer list (/api/courses) must exclude the NCYSA course.
  const list = (await (await partner.get('/api/courses')).json()).courses.map((c) => c.id);
  expect(list).toContain(omg.id);
  expect(list).not.toContain(nc.id);

  // The partner's overview courses are OMG-only.
  const ov = await (await partner.get('/api/admin/overview')).json();
  const ovIds = (ov.courses || []).map((c) => c.id);
  expect(ovIds).toContain(omg.id);
  expect(ovIds).not.toContain(nc.id);
  expect((ov.courses || []).every((c) => c.orgId === 'omg')).toBe(true);
});

test('partner cannot read or mutate another org\'s course (fails closed = 404)', async ({ playwright }) => {
  const admin = await ctx(playwright, ADMIN);
  const partner = await ctx(playwright, PARTNER);
  const nc = (await (await admin.post('/api/admin/courses', { data: { title: `Iso NC guard ${Date.now()}`, audience: 'coaches' } })).json()).course;

  expect((await partner.get(`/api/admin/courses/${nc.id}`)).status()).toBe(404);          // read
  expect((await partner.put(`/api/admin/courses/${nc.id}`, { data: { title: 'hacked' } })).status()).toBe(404); // edit
  expect((await partner.post(`/api/admin/courses/${nc.id}/publish`, { data: { published: true } })).status()).toBe(404); // publish
  expect((await partner.post(`/api/admin/courses/${nc.id}/lessons`, { data: { type: 'text', title: 'x', html: '<p>x</p>' } })).status()).toBe(404); // add lesson
  expect((await partner.delete(`/api/admin/courses/${nc.id}`)).status()).toBe(404);         // delete
  expect((await partner.get(`/api/admin/courses/${nc.id}/export?format=web`)).status()).toBe(404); // export

  // The NCYSA course is untouched.
  const after = (await (await admin.get(`/api/admin/courses/${nc.id}`)).json()).course;
  expect(after.title).not.toBe('hacked');
});

test('a course a partner creates is forced into its own org', async ({ playwright }) => {
  const partner = await ctx(playwright, PARTNER);
  // Even if the partner asks for NCYSA, the server forces its org.
  const c = (await (await partner.post('/api/admin/courses', { data: { title: `Partner made ${Date.now()}`, audience: 'coaches', orgId: 'ncysa' } })).json()).course;
  expect(c.orgId).toBe('omg');
});

test('partner is blocked from raw SCORM package management (fail closed)', async ({ playwright }) => {
  const partner = await ctx(playwright, PARTNER);
  expect((await partner.get('/api/admin/scorm/storage')).status()).toBe(403);
  expect((await partner.post('/api/admin/scorm/cleanup', { data: {} })).status()).toBe(403);
});

test('super-admin still sees every org (not scoped)', async ({ playwright }) => {
  const admin = await ctx(playwright, ADMIN);
  const ov = await (await admin.get('/api/admin/overview')).json();
  const orgs = new Set((ov.courses || []).map((c) => c.orgId));
  // The seeded platform has both NCYSA and OMG courses; admin sees both.
  expect(orgs.has('omg')).toBe(true);
  expect([...orgs].some((o) => o !== 'omg')).toBe(true);
});
