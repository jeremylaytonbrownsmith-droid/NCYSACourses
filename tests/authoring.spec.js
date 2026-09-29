// Course Designer authoring: lesson image upload. Images are posted as raw bytes
// with the file's content-type, stored on the uploads disk, and served back.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
// A tiny valid 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');

async function editor(playwright) {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  return api;
}

test('an image upload is rejected without an editor session', async ({ playwright }) => {
  const anon = await playwright.request.newContext({ baseURL: BASE });
  const r = await anon.post('/api/admin/upload-image?name=x', { headers: { 'content-type': 'image/png' }, data: PNG });
  expect([401, 403]).toContain(r.status());
});

test('an editor can upload an image and fetch it back', async ({ playwright }) => {
  const api = await editor(playwright);
  const up = await api.post('/api/admin/upload-image?name=diagram', { headers: { 'content-type': 'image/png' }, data: PNG });
  expect(up.ok()).toBeTruthy();
  const { url } = await up.json();
  expect(url).toMatch(/^\/uploads\/diagram-[0-9a-f]+\.png$/);
  const got = await api.get(url);
  expect(got.ok()).toBeTruthy();
  expect((await got.body()).length).toBe(PNG.length);
});

test('a non-image upload is refused', async ({ playwright }) => {
  const api = await editor(playwright);
  const r = await api.post('/api/admin/upload-image?name=x', { headers: { 'content-type': 'text/plain' }, data: 'not an image' });
  expect(r.status()).toBe(400);
});
