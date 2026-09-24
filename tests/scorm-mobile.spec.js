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

// Build a package with arbitrary files (used by the slide-hiding tests, which
// need a real manifest.js + media on disk). Always includes a valid SCORM
// imsmanifest.xml so the upload endpoint accepts it.
function filesZip(files) {
  const zip = new AdmZip();
  zip.addFile('imsmanifest.xml', Buffer.from(`<?xml version="1.0"?>
<manifest identifier="M" version="1.2"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <organizations default="O"><organization identifier="O"><title>M</title></organization></organizations>
  <resources><resource identifier="R" type="webcontent" adlcp:scormtype="sco" href="index.html"><file href="index.html"/></resource></resources>
</manifest>`, 'utf8'));
  for (const [p, body] of Object.entries(files)) zip.addFile(p, Buffer.from(body, 'utf8'));
  return zip.toBuffer();
}

async function uploadFiles(api, files, name) {
  const up = await api.post(`/api/admin/scorm?name=${name}`, {
    headers: { 'content-type': 'application/zip' }, data: filesZip(files),
  });
  return (await up.json()).packageId;
}

// A faithful slideshow package: manifest.js globals + media/item-00N files whose
// bytes identify the original slide, so a remap is provable.
const SLIDESHOW_FILES = {
  'index.html': '<!doctype html><html><body><div id="viewer"><span id="counter">1 / 4</span><button id="nextBtn">Next</button></div><script src="manifest.js"></script></body></html>',
  'manifest.js': 'var ITEMS=["i","i","i","v"];var TITLES=["Facilitator Guidance","Intro Two","Real Content","The Video"];var FPS=[0,0,0,30];',
  'media/item-001.jpg': 'ORIGINAL-1',
  'media/item-002.jpg': 'ORIGINAL-2',
  'media/item-003.jpg': 'ORIGINAL-3',
  'media/item-004.mp4': 'ORIGINAL-4',
};

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
  // Register + enroll through the shared cookie jar, then confirm the session is
  // live before navigating (avoids a race where the cookie is not yet applied and
  // the lesson route bounces to home).
  await page.request.post(`${BASE}/api/register`, { data: { firstName: 'FS', lastName: 'Test', email: `fs${Date.now()}@example.com` } });
  await page.request.post(`${BASE}/api/courses/${courseId}/enroll`);
  await expect.poll(async () => {
    const me = await (await page.request.get(`${BASE}/api/me`)).json();
    return me.user ? me.user.role : null;
  }, { timeout: 8000 }).not.toBeNull();
  const fsBtn = page.locator('#scormFsBtn');
  let opened = false;
  for (let i = 0; i < 3 && !opened; i++) {
    await page.goto(`${BASE}/#/course/${courseId}/lesson/${lessonId}`, { waitUntil: 'load' });
    await page.reload({ waitUntil: 'load' });
    opened = await fsBtn.waitFor({ state: 'visible', timeout: 7000 }).then(() => true).catch(() => false);
  }
  expect(opened).toBe(true);
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

// A faithful mini-player: same element ids and slide-change contract as our real
// slideshow player (counter "X / N", #viewer.has-video for video slides), so the
// injected per-slide gate hooks into it exactly as it would the real thing.
const MINI_PLAYER = `<!doctype html><html><head><title>Mini</title></head><body>
  <div id="viewer" class="viewer">
    <img id="slide"><video id="video" style="display:none"></video>
    <div id="toolbar" class="toolbar">
      <button id="menuBtn">menu</button>
      <button id="prevBtn">Prev</button>
      <span id="counter">1 / 3</span>
      <button id="nextBtn">Next</button>
    </div>
  </div>
  <script>
    var cur=0,TOTAL=3,VID=1;
    var counter=document.getElementById('counter'),viewer=document.getElementById('viewer'),nextBtn=document.getElementById('nextBtn'),prevBtn=document.getElementById('prevBtn');
    function render(){counter.textContent=(cur+1)+' / '+TOTAL;if(cur===VID)viewer.classList.add('has-video');else viewer.classList.remove('has-video');prevBtn.disabled=(cur===0);nextBtn.disabled=(cur===TOTAL-1);}
    function next(){if(cur<TOTAL-1){cur++;render();}}
    function prev(){if(cur>0){cur--;render();}}
    nextBtn.addEventListener('click',next);prevBtn.addEventListener('click',prev);
    document.addEventListener('keydown',function(e){if(e.key==='PageDown'||e.key==='ArrowRight')next();if(e.key==='PageUp'||e.key==='ArrowLeft')prev();});
    render();
  <\/script>
</body></html>`;

test('the per-slide review gate is injected into our player, not third-party packages', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  const pkg = await upload(api, MINI_PLAYER, 'GatePkg');
  const served = await (await api.get(`/scorm/${pkg}/index.html`)).text();
  expect(served).toContain('GMR per-slide review gate');
  const other = await upload(api, OTHER_HTML, 'GateOtherPkg');
  const servedOther = await (await api.get(`/scorm/${other}/index.html`)).text();
  expect(servedOther).not.toContain('GMR per-slide review gate');
});

test('the per-slide time is taken from the module’s "Time on each slide" setting', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });

  // A module set to 45s per slide bakes 45 (and 60 for video) into the gate.
  const pkg45 = await upload(api, MINI_PLAYER, 'Gate45');
  const c1 = (await (await api.post('/api/admin/courses', { data: { title: 'Gate 45', audience: 'coaches' } })).json()).course.id;
  await api.post(`/api/admin/courses/${c1}/lessons`, { data: { type: 'scorm', title: 'M', packageId: pkg45, slideGateSeconds: 45 } });
  const served45 = await (await api.get(`/scorm/${pkg45}/index.html`)).text();
  expect(served45).toContain('GMR per-slide review gate');
  expect(served45).toContain('window.GMR_GATE_SLIDE||45');
  expect(served45).toContain('window.GMR_GATE_VIDEO||60');

  // A module set to Off (0) gets no gate injected at all.
  const pkgOff = await upload(api, MINI_PLAYER, 'GateOff');
  const c2 = (await (await api.post('/api/admin/courses', { data: { title: 'Gate Off', audience: 'coaches' } })).json()).course.id;
  await api.post(`/api/admin/courses/${c2}/lessons`, { data: { type: 'scorm', title: 'M', packageId: pkgOff, slideGateSeconds: 0 } });
  const servedOff = await (await api.get(`/scorm/${pkgOff}/index.html`)).text();
  expect(servedOff).not.toContain('GMR per-slide review gate');
});

test('a quick Module-minutes save keeps the module’s slide timer', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  const pkg = await upload(api, MINI_PLAYER, 'GateKeep');
  const courseId = (await (await api.post('/api/admin/courses', { data: { title: 'Keep', audience: 'coaches' } })).json()).course.id;
  const lessonId = (await (await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'scorm', title: 'M', packageId: pkg, slideGateSeconds: 90 } })).json()).lesson.id;
  // A partial save that only sends minMinutes must not reset the slide timer.
  await api.put(`/api/admin/courses/${courseId}/lessons/${lessonId}`, { data: { type: 'scorm', title: 'M', packageId: pkg, launchFile: 'index.html', minMinutes: 5 } });
  const served = await (await api.get(`/scorm/${pkg}/index.html`)).text();
  expect(served).toContain('window.GMR_GATE_SLIDE||90');
});

test('Next is held per slide (30s / 60s video), keyboard blocked, no re-gate on revisit', async ({ playwright, browser }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  const pkg = await upload(api, MINI_PLAYER, 'GateBehave');

  const ctx = await browser.newContext();
  // Shorten the gate for the test: 1s per slide, 2s on video.
  await ctx.addInitScript(() => { window.GMR_GATE_SLIDE = 1; window.GMR_GATE_VIDEO = 2; });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/scorm/${pkg}/index.html`);

  const next = page.locator('#nextBtn');
  // Slide 1: gated -> disabled with countdown, then enabled after ~1s.
  await expect(next).toBeDisabled();
  await expect(page.locator('#counter')).toHaveText('1 / 3');
  await expect(next).toBeEnabled({ timeout: 4000 });

  // Keyboard "next" is blocked while a fresh slide is gated.
  await next.click(); // -> slide 2 (video), re-gated
  await expect(page.locator('#counter')).toHaveText('2 / 3');
  await expect(next).toBeDisabled();
  await page.keyboard.press('PageDown');            // should be blocked while gated
  await expect(page.locator('#counter')).toHaveText('2 / 3');
  // Video slide waits longer (2s here); it eventually unlocks.
  await expect(next).toBeEnabled({ timeout: 5000 });

  // Go back to slide 1 (already waited) -> Next is immediately available, no re-wait.
  await page.locator('#prevBtn').click();
  await expect(page.locator('#counter')).toHaveText('1 / 3');
  await expect(next).toBeEnabled();
  await ctx.close();
});

test('slide inventory lists every slide with its title and type', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  const pkg = await uploadFiles(api, SLIDESHOW_FILES, 'SlidesInv');
  const inv = await (await api.get(`/api/admin/scorm/${pkg}/slides`)).json();
  expect(inv.slideshow).toBe(true);
  expect(inv.count).toBe(4);
  expect(inv.slides.map((s) => s.title)).toEqual(['Facilitator Guidance', 'Intro Two', 'Real Content', 'The Video']);
  expect(inv.slides[3].type).toBe('video');
  expect(inv.slides[0].thumb).toContain('/rawmedia/media/item-001.jpg');

  // A third-party package (no manifest.js) reports slideshow:false.
  const other = await upload(api, OTHER_HTML, 'SlidesInvOther');
  const invOther = await (await api.get(`/api/admin/scorm/${other}/slides`)).json();
  expect(invOther.slideshow).toBe(false);
});

test('hiding slides trims the served manifest and remaps media to the originals', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  const pkg = await uploadFiles(api, SLIDESHOW_FILES, 'SlidesHide');
  const courseId = (await (await api.post('/api/admin/courses', { data: { title: 'Hide', audience: 'coaches' } })).json()).course.id;
  await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'scorm', title: 'M', packageId: pkg, hiddenSlides: [1, 2] } });

  // manifest.js now describes only the two visible slides, in order.
  const man = await (await api.get(`/scorm/${pkg}/manifest.js`)).text();
  expect(man).toContain('var ITEMS=["i","v"]');
  expect(man).toContain('var TITLES=["Real Content","The Video"]');
  expect(man).toContain('var FPS=[0,30]');

  // The player asks for item-001/002 (positional in the trimmed deck); it must
  // receive the ORIGINAL slide 3 and 4 bytes.
  expect(await (await api.get(`/scorm/${pkg}/media/item-001.jpg`)).text()).toBe('ORIGINAL-3');
  expect(await (await api.get(`/scorm/${pkg}/media/item-002.mp4`)).text()).toBe('ORIGINAL-4');

  // The admin raw route always shows the true originals (ignores hiding).
  expect(await (await api.get(`/api/admin/scorm/${pkg}/rawmedia/media/item-001.jpg`)).text()).toBe('ORIGINAL-1');
});

test('a module with no hidden slides is served completely untouched', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  const pkg = await uploadFiles(api, SLIDESHOW_FILES, 'SlidesNone');
  const man = await (await api.get(`/scorm/${pkg}/manifest.js`)).text();
  expect(man).toContain('var ITEMS=["i","i","i","v"]');
  expect(await (await api.get(`/scorm/${pkg}/media/item-001.jpg`)).text()).toBe('ORIGINAL-1');
});

test('a partial (minutes-only) save keeps the hidden slides', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  const pkg = await uploadFiles(api, SLIDESHOW_FILES, 'SlidesKeep');
  const courseId = (await (await api.post('/api/admin/courses', { data: { title: 'HideKeep', audience: 'coaches' } })).json()).course.id;
  const lessonId = (await (await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'scorm', title: 'M', packageId: pkg, hiddenSlides: [1, 2, 3] } })).json()).lesson.id;
  await api.put(`/api/admin/courses/${courseId}/lessons/${lessonId}`, { data: { type: 'scorm', title: 'M', packageId: pkg, launchFile: 'index.html', minMinutes: 3 } });
  const man = await (await api.get(`/scorm/${pkg}/manifest.js`)).text();
  expect(man).toContain('var ITEMS=["v"]'); // only slide 4 remains
});
