// Import-from-link: a package too big to upload from the browser can be pulled
// by the server from a direct download URL, then ingested like any upload.
const { test, expect } = require('@playwright/test');
const AdmZip = require('adm-zip');
const http = require('http');

const BASE = 'http://localhost:3100';
const DESIGNER = { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' };

function htmlZip() {
  const zip = new AdmZip();
  zip.addFile('course/index.html', Buffer.from('<!doctype html><title>Mentor+</title><p>Hi</p>', 'utf8'));
  zip.addFile('course/assets/a.js', Buffer.from('// x', 'utf8'));
  return zip.toBuffer();
}

// Serve the zip over a throwaway local HTTP server so the import endpoint can
// fetch it (the test server runs with ALLOW_PRIVATE_IMPORT=1).
function serveZip(buf) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/zip' }); res.end(buf); });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/pkg.zip` }));
  });
}

test('import-url rejects a non-https / empty link', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: DESIGNER })).ok()).toBeTruthy();
  expect((await api.post('/api/admin/scorm/import-url', { data: {} })).status()).toBe(400);
  expect((await api.post('/api/admin/scorm/import-url', { data: { url: 'ftp://x/y.zip' } })).status()).toBe(400);
});

test('import-url fetches a zip from a link and ingests it as an HTML package', async ({ playwright }) => {
  const { srv, url } = await serveZip(htmlZip());
  try {
    const api = await playwright.request.newContext({ baseURL: BASE });
    expect((await api.post('/api/login', { data: DESIGNER })).ok()).toBeTruthy();
    const res = await api.post('/api/admin/scorm/import-url', { data: { url, name: `MentorPlus${Date.now()}` } });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.kind).toBe('html');          // detected as HTML
    expect(body.launchFile).toBe('index.html'); // wrapper folder stripped
    expect(body.packageId).toBeTruthy();
  } finally { srv.close(); }
});
