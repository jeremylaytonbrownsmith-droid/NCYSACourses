// Our slideshow player's bottom toolbar pushes the menu (left) and full-screen
// (right) icon buttons to the screen edges, which clips them on a phone. The
// server injects a phone-width layout fix into the player's launch HTML on the
// way out — scoped to our player only, so a third-party package is never touched.
const { test, expect } = require('@playwright/test');
const AdmZip = require('adm-zip');

const BASE = 'http://localhost:3100';

function pkgZip(indexHtml) {
  const zip = new AdmZip();
  zip.addFile('imsmanifest.xml', Buffer.from(`<?xml version="1.0"?>
<manifest identifier="M" version="1.2"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <organizations default="O"><organization identifier="O"><title>M</title></organization></organizations>
  <resources><resource identifier="R" type="webcontent" adlcp:scormtype="sco" href="index.html"><file href="index.html"/></resource></resources>
</manifest>`, 'utf8'));
  zip.addFile('index.html', Buffer.from(indexHtml, 'utf8'));
  return zip.toBuffer();
}

// A minimal stand-in for our real player: the toolbar with the two spacer-pushed
// icon buttons that the fix targets.
const PLAYER_HTML = `<!doctype html><html><head><title>Player</title></head><body>
  <div id="toolbar" class="toolbar">
    <button id="menuBtn" class="btn btn-icon">menu</button>
    <span class="spacer"></span>
    <button id="prevBtn" class="btn">Prev</button>
    <button id="nextBtn" class="btn">Next</button>
    <span class="spacer"></span>
    <button id="fsBtn" class="btn btn-icon">fs</button>
  </div>
</body></html>`;

// A different package that does NOT use our player.
const OTHER_HTML = `<!doctype html><html><head><title>Other</title></head><body><div id="cpDocument">third-party</div></body></html>`;

async function upload(api, html, name) {
  const up = await api.post(`/api/admin/scorm?name=${name}`, {
    headers: { 'content-type': 'application/zip' }, data: pkgZip(html),
  });
  return (await up.json()).packageId;
}

test('the phone toolbar fix is injected into our player launch HTML', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });

  const pkg = await upload(api, PLAYER_HTML, 'PlayerPkg');
  const served = await (await api.get(`/scorm/${pkg}/index.html`)).text();
  expect(served).toContain('gmr-mobile-fix');
  expect(served).toContain('flex-wrap:wrap');
  expect(served).toContain('.spacer{display:none}');
});

test('a third-party package is left untouched (fix not injected)', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });

  const pkg = await upload(api, OTHER_HTML, 'OtherPkg');
  const served = await (await api.get(`/scorm/${pkg}/index.html`)).text();
  expect(served).not.toContain('gmr-mobile-fix');
  expect(served).toContain('third-party'); // served as-is
});

test('Full screen falls back to a CSS fill-screen mode where the fullscreen API is unavailable (iPhone)', async ({ browser, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  const courseId = (await (await api.post('/api/admin/courses', { data: { title: 'FS Mobile', audience: 'coaches' } })).json()).course.id;
  const lessonId = (await (await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'scorm', title: 'M1', packageId: 'test-module', minMinutes: 0 } })).json()).lesson.id;
  await api.post(`/api/admin/courses/${courseId}/publish`, { data: { published: true } });

  // Simulate an iPhone: no fullscreen API, phone viewport.
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => { try { Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => false }); } catch (e) {} });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/`);
  // Register + enroll through the shared cookie jar, then load the lesson fresh.
  await page.request.post(`${BASE}/api/register`, { data: { firstName: 'FS', lastName: 'Test', email: `fs${Date.now()}@example.com` } });
  await page.request.post(`${BASE}/api/courses/${courseId}/enroll`);
  await page.goto(`${BASE}/#/course/${courseId}/lesson/${lessonId}`);
  await page.reload();

  const fsBtn = page.locator('#scormFsBtn');
  await expect(fsBtn).toBeVisible({ timeout: 15000 });
  await fsBtn.click();
  // The module shell expands to cover the viewport, with a Close button.
  const shell = page.locator('.scorm-shell.pseudo-fs');
  await expect(shell).toBeVisible();
  await expect(page.locator('.pseudo-fs-exit')).toBeVisible();
  // It must fill the whole screen — not be trapped to the lesson pane by a
  // transformed ancestor (regression guard for the fadeSlide containing block).
  const box = await shell.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(380);
  expect(box.height).toBeGreaterThanOrEqual(800);
  await page.locator('.pseudo-fs-exit').click();
  await expect(page.locator('.scorm-shell.pseudo-fs')).toHaveCount(0);
  await ctx.close();
});
