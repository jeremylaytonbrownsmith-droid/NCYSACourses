// Partner upload API: a partner (OMS) POSTs a published SCORM .zip as the raw
// request body, authenticated with the per-tenant integration API key, and gets
// back a moduleId it can immediately launch referees into. This closes the loop
// so the partner can AUTOMATE adding new lessons from their own system. The
// uploaded module must land in the partner org (omg), never NCYSA.
const { test, expect } = require('@playwright/test');
const AdmZip = require('adm-zip');
const { signToken } = require('../lib/integration');

const BASE = 'http://localhost:3100';
const SECRET = 'test-secret-123';
const API_KEY = 'test-api-key-456';

// Build a minimal, valid SCORM 1.2 package (.zip) in memory.
function scormZip(title = 'Uploaded Module') {
  const zip = new AdmZip();
  const manifest = `<?xml version="1.0"?>
<manifest identifier="M1" version="1.2"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2">
  <organizations default="O1">
    <organization identifier="O1"><title>${title}</title>
      <item identifier="I1" identifierref="R1"><title>${title}</title></item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="R1" type="webcontent" adlcp:scormtype="sco" href="index.html"
      xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
      <file href="index.html"/>
    </resource>
  </resources>
</manifest>`;
  zip.addFile('imsmanifest.xml', Buffer.from(manifest, 'utf8'));
  zip.addFile('index.html', Buffer.from('<!doctype html><title>SCO</title><p>Hello</p>', 'utf8'));
  return zip.toBuffer();
}

const upload = (api, buf, query = '', headers = {}) =>
  api.post(`/api/v1/scorm${query}`, {
    headers: { 'content-type': 'application/zip', ...headers },
    data: buf,
  });

test('rejects an upload with no / wrong API key', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await upload(api, scormZip())).status()).toBe(401);                                   // no key
  expect((await upload(api, scormZip(), '', { Authorization: 'Bearer nope' })).status()).toBe(401); // wrong key
  // The HMAC secret is NOT the upload key.
  expect((await upload(api, scormZip(), '', { Authorization: `Bearer ${SECRET}` })).status()).toBe(401);
});

test('a keyed upload creates a launchable, published module in the partner org', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  const res = await upload(api, scormZip('Concussion Protocol 2026'),
    '?title=Concussion%20Protocol%202026&minMinutes=0', { Authorization: `Bearer ${API_KEY}` });
  expect(res.status()).toBe(200);
  const j = await res.json();
  expect(j.ok).toBe(true);
  expect(j.moduleId).toBeTruthy();
  expect(j.packageId).toBeTruthy();
  expect(j.launchFile).toBe('index.html');
  expect(j.published).toBe(true);
  expect(j.title).toBe('Concussion Protocol 2026');
  expect(j.launchBase).toMatch(/\/launch$/);

  // The package files are served same-origin under /scorm/<packageId>/.
  const file = await api.get(`/scorm/${j.packageId}/index.html`);
  expect(file.status()).toBe(200);

  // It shows up in the partner (omg) portal...
  const omg = (await (await api.get('/api/courses?org=omg')).json()).courses;
  const mod = omg.find((c) => c.id === j.moduleId);
  expect(mod).toBeTruthy();
  expect(mod.orgId).toBe('omg');
  expect(mod.published).toBe(true);

  // ...and NOT in NCYSA's — the partner key can never publish into NCYSA.
  const ncysa = (await (await api.get('/api/courses?org=ncysa')).json()).courses;
  expect(ncysa.find((c) => c.id === j.moduleId)).toBeFalsy();

  // The returned moduleId is exactly what a launch token references.
  const token = signToken({ refId: 'OMS-UP-1', name: 'Up Ref', email: 'up@example.com', moduleId: j.moduleId, org: 'NC' }, SECRET, 300);
  const ctx = await playwright.request.newContext({ baseURL: BASE });
  const launch = await ctx.get(`/launch?token=${token}`, { maxRedirects: 0 });
  expect(launch.status()).toBe(302);
  expect(launch.headers()['location']).toContain(`/#/course/${j.moduleId}`);
});

test('re-uploading with ?moduleId= replaces the module in place (not a new course)', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  const first = await (await upload(api, scormZip('V1'), '?title=Replaceable', { Authorization: `Bearer ${API_KEY}` })).json();
  const second = await upload(api, scormZip('V2'),
    `?title=Replaceable%20v2&moduleId=${first.moduleId}`, { Authorization: `Bearer ${API_KEY}` });
  expect(second.status()).toBe(200);
  const j = await second.json();
  expect(j.moduleId).toBe(first.moduleId);      // same course id
  expect(j.packageId).not.toBe(first.packageId); // fresh package
  expect(j.title).toBe('Replaceable v2');

  const omg = (await (await api.get('/api/courses?org=omg')).json()).courses;
  const hits = omg.filter((c) => c.id === first.moduleId);
  expect(hits).toHaveLength(1); // updated in place, not duplicated
  expect(hits[0].title).toBe('Replaceable v2');
});

test('?publish=false stages a draft: hidden from the portal, but previewable via launch', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  const j = await (await upload(api, scormZip('Draft Module'),
    '?title=Draft%20Module&publish=false', { Authorization: `Bearer ${API_KEY}` })).json();
  expect(j.ok).toBe(true);
  expect(j.published).toBe(false);
  // A draft does not appear in the public portal listing.
  const omg = (await (await api.get('/api/courses?org=omg')).json()).courses;
  expect(omg.find((c) => c.id === j.moduleId)).toBeFalsy();

  // ...but a referee launched into it (preview/QA) CAN open it — the player load
  // must not 404 just because the module is a draft.
  const token = signToken({ refId: 'OMS-DRAFT', name: 'Draft Ref', email: 'draft@example.com', moduleId: j.moduleId, org: 'NC' }, SECRET, 300);
  const ref = await playwright.request.newContext({ baseURL: BASE });
  expect((await ref.get(`/launch?token=${token}`, { maxRedirects: 0 })).status()).toBe(302);
  const loaded = await ref.get(`/api/courses/${j.moduleId}`);
  expect(loaded.status()).toBe(200); // draft opens for the enrolled/launched referee
  expect((await loaded.json()).course.id).toBe(j.moduleId);
});

test('every upload is written to the admin audit log (org, moduleId, size, time)', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  const j = await (await upload(api, scormZip('Audited Module'),
    '?title=Audited%20Module', { Authorization: `Bearer ${API_KEY}` })).json();
  const admin = await playwright.request.newContext({ baseURL: BASE });
  await admin.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  const overview = await (await admin.get('/api/admin/overview')).json();
  const entry = (overview.partnerUploads || []).find((u) => u.moduleId === j.moduleId);
  expect(entry).toBeTruthy();
  expect(entry.org).toBe('omg');
  expect(entry.bytes).toBeGreaterThan(0);
  expect(entry.title).toBe('Audited Module');
  expect(entry.at).toBeTruthy();
});

test('storage is attributed to the partner org for at-cost billing', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await upload(api, scormZip('Footprint Module'), '?title=Footprint%20Module', { Authorization: `Bearer ${API_KEY}` });
  const admin = await playwright.request.newContext({ baseURL: BASE });
  await admin.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  const storage = await (await admin.get('/api/admin/scorm/storage')).json();
  const omg = (storage.byOrg || []).find((o) => o.org === 'omg');
  expect(omg).toBeTruthy();
  expect(omg.bytes).toBeGreaterThan(0);
  expect(omg.modules).toBeGreaterThan(0);
});

test('a non-SCORM .zip is refused with a clear error', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  const zip = new AdmZip();
  zip.addFile('readme.txt', Buffer.from('not scorm', 'utf8'));
  const res = await upload(api, zip.toBuffer(), '?title=Bad', { Authorization: `Bearer ${API_KEY}` });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toMatch(/imsmanifest/i);
});
