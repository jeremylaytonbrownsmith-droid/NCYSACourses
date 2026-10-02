// A SCORM module runs in the browser, discovers the portal's window.API, and
// reports completion — which completes the course and mints the certificate.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3100';

test('scorm module completion through the browser', async ({ page, playwright }) => {
  // --- Editor builds a single-module SCORM course (its own cookie jar) -------
  const api = await playwright.request.newContext({ baseURL: BASE });
  let r = await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  expect(r.ok()).toBeTruthy();
  r = await api.post('/api/admin/courses', { data: { title: 'Browser SCORM Recert', audience: 'referees', badge: 'Recertification' } });
  const courseId = (await r.json()).course.id;
  // minMinutes: 0 turns the anti-skip time gate off for this completion test.
  r = await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'scorm', title: 'Module 1', packageId: 'test-module', minMinutes: 0 } });
  const lessonId = (await r.json()).lesson.id;
  await api.post(`/api/admin/courses/${courseId}/publish`, { data: { published: true } });

  // --- Referee registers in the browser -------------------------------------
  await page.goto('/#/register');
  await page.fill('#firstName', 'Bro');
  await page.fill('#lastName', 'Wser');
  await page.fill('#email', 'bro.wser@example.com');
  await page.click('button:has-text("Create account")');
  await expect(page.locator('.topnav')).toContainText('Hi, Bro');

  // Enroll (as the logged-in learner — page.request shares the page's cookies)
  await page.request.post(`${BASE}/api/courses/${courseId}/enroll`);

  // --- Open the module and click through the SCORM package ------------------
  await page.goto(`/#/course/${courseId}/lesson/${lessonId}`);
  const frame = page.frameLocator('#scormFrame');
  await expect(frame.locator('#count')).toContainText('Slide 1 of 3');
  await frame.locator('#next').click();
  await expect(frame.locator('#count')).toContainText('Slide 2 of 3');
  // Clicking to the final slide reports "completed" to window.API → relayed to
  // the server → this single-module course completes and the completion screen
  // replaces the page (so we assert that outcome, not the transient last slide).
  await frame.locator('#next').click();
  await expect(page.locator('.complete-hero h1')).toContainText('Congratulations', { timeout: 15000 });
  await page.click('text=View your certificate');
  await expect(page.locator('.certificate .learner-name')).toContainText('Bro Wser');

  // --- Reviewing a COMPLETED module must still connect to the LMS -----------
  // Regression: a completed module used to return before defining window.API,
  // so re-opening it threw the package's "could not connect to the LMS" dialog.
  // Now a read-only API is exposed, so the package loads cleanly on review.
  await page.goto(`/#/course/${courseId}/lesson/${lessonId}`);
  await expect(page.locator('.pill-done')).toContainText('complete'); // shown as done
  // The package loads and restores its saved position via the LMS (no "could
  // not connect" error). It resumes wherever the learner left off, of 3 slides.
  await expect(page.frameLocator('#scormFrame').locator('#count')).toContainText('of 3');
  const apiType = await page.evaluate(() => typeof window.API);
  expect(apiType).toBe('object'); // the LMS API is present for review
  const status = await page.evaluate(() => window.API.LMSGetValue('cmi.core.lesson_status'));
  expect(['completed', 'passed']).toContain(status);
});

test('scorm time gate holds completion until the minimum time is met', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  let r = await api.post('/api/admin/courses', { data: { title: 'Gated SCORM Recert', audience: 'referees' } });
  const courseId = (await r.json()).course.id;
  // 0.5 minutes = 30 seconds minimum (above the 15s per-heartbeat cap, so no
  // single call can satisfy it).
  r = await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'scorm', title: 'Gated Module', packageId: 'test-module', minMinutes: 0.5 } });
  const lessonId = (await r.json()).lesson.id;
  await api.post(`/api/admin/courses/${courseId}/publish`, { data: { published: true } });

  // Learner registers + enrolls (separate cookie jar).
  const learner = await playwright.request.newContext({ baseURL: BASE });
  await learner.post('/api/register', { data: { firstName: 'Gate', lastName: 'Test', email: 'gate.test@example.com' } });
  await learner.post(`/api/courses/${courseId}/enroll`);

  const post = (body) => learner.post(`/api/courses/${courseId}/lessons/${lessonId}/scorm`, { data: body }).then((x) => x.json());

  // Reaching the end immediately must NOT complete — the time gate isn't met.
  let res = await post({ status: 'completed', activeDelta: 0 });
  expect(res.reachedEnd).toBe(true);
  expect(res.completed).toBe(false);
  expect(res.remaining).toBeGreaterThan(0);

  // A single forged huge delta is capped, so it still can't jump the gate.
  res = await post({ status: 'completed', activeDelta: 9999 });
  expect(res.completed).toBe(false);
  expect(res.activeSeconds).toBeLessThanOrEqual(15); // one step cap

  // Accrue enough real-time credit across heartbeats → now it completes.
  for (let i = 0; i < 5 && !res.completed; i++) res = await post({ status: 'completed', activeDelta: 15 });
  expect(res.completed).toBe(true);
  expect(res.courseCompleted).toBe(true);
  expect(res.certId).toBeTruthy();
});

test('CDN video shim is injected for CDN-backed packages (identity map when nothing hidden)', async ({ request }) => {
  // The webServer serves packages from .test-data/scorm (shared filesystem).
  const dir = path.join(__dirname, '..', '.test-data', 'scorm');
  fs.mkdirSync(path.join(dir, 'cdn-yes'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'cdn-no'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'cdn-yes', 'index.html'), '<!doctype html><head></head><body>m</body>');
  fs.writeFileSync(path.join(dir, 'cdn-yes', '.cdn'), 'https://ncysa-modules.b-cdn.net/cdn-yes/');
  fs.writeFileSync(path.join(dir, 'cdn-no', 'index.html'), '<!doctype html><head></head><body>m</body>');

  const yes = await (await request.get(`${BASE}/scorm/cdn-yes/index.html`)).text();
  expect(yes).toContain('HTMLMediaElement');                     // shim present
  expect(yes).toContain('ncysa-modules.b-cdn.net/cdn-yes');      // points at the CDN base
  expect(yes).toContain('M={}');                                 // identity — nothing hidden

  const no = await (await request.get(`${BASE}/scorm/cdn-no/index.html`)).text();
  expect(no).not.toContain('HTMLMediaElement');                  // no shim without the marker
});

test('served SCORM HTML gets the Vimeo/YouTube in-frame embed fix (watch-page link → player overlay)', async ({ request }) => {
  const dir = path.join(__dirname, '..', '.test-data', 'scorm');
  fs.mkdirSync(path.join(dir, 'vimeo-course'), { recursive: true });
  // A Captivate-style page that opens the un-embeddable Vimeo WATCH page in the frame.
  fs.writeFileSync(path.join(dir, 'vimeo-course', 'index.html'),
    '<!doctype html><head></head><body><script>cp.openURL("https://vimeo.com/1200487589?fl=pl","_self")</script></body>');
  const html = await (await request.get(`${BASE}/scorm/vimeo-course/index.html`)).text();
  expect(html).toContain('gmr-vid-ov');                 // the overlay fix is injected
  expect(html).toContain('player.vimeo.com/video/');    // converts watch URL → embeddable player
  expect(html).toContain('youtube.com/embed/');         // handles YouTube too
});

test('served SCORM HTML sends a permissive referrer so Vimeo can verify the embed domain', async ({ request }) => {
  const dir = path.join(__dirname, '..', '.test-data', 'scorm');
  fs.mkdirSync(path.join(dir, 'referrer-course'), { recursive: true });
  // A package that ships a restrictive no-referrer meta (which would hide our domain
  // from Vimeo and trigger its "privacy settings" block).
  fs.writeFileSync(path.join(dir, 'referrer-course', 'index.html'),
    '<!doctype html><html><head><meta name="referrer" content="no-referrer"><title>t</title></head><body>m</body></html>');
  const res = await request.get(`${BASE}/scorm/referrer-course/index.html`);
  const html = await res.text();
  expect(html).toContain('content="no-referrer-when-downgrade"');   // permissive meta injected
  expect(html).not.toMatch(/content=["']no-referrer["']/);          // restrictive meta stripped
  expect((res.headers()['referrer-policy'] || '')).toBe('no-referrer-when-downgrade'); // and the header
});

test('with hidden slides, the CDN shim maps new slide numbers back to the original Bunny files', async ({ request, playwright }) => {
  // A CDN-backed package whose video is the 3rd slide; hide slides 1 and 2, so
  // the player renumbers the video to slide 1 — but Bunny still has item-003.
  const dir = path.join(__dirname, '..', '.test-data', 'scorm');
  fs.mkdirSync(path.join(dir, 'cdn-hide'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'cdn-hide', 'index.html'), '<!doctype html><head></head><body>m</body>');
  fs.writeFileSync(path.join(dir, 'cdn-hide', 'manifest.js'), 'var ITEMS=["i","i","v"];var TITLES=["A","B","V"];');
  fs.writeFileSync(path.join(dir, 'cdn-hide', '.cdn'), 'https://ncysa-modules.b-cdn.net/cdn-hide/');

  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  const courseId = (await (await api.post('/api/admin/courses', { data: { title: 'CDN Hide', audience: 'coaches' } })).json()).course.id;
  await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'scorm', title: 'M', packageId: 'cdn-hide', hiddenSlides: [1, 2] } });

  const html = await (await request.get(`${BASE}/scorm/cdn-hide/index.html`)).text();
  expect(html).toContain('HTMLMediaElement');   // shim present
  expect(html).toContain('"1":3');              // new slide 1 → original file item-003
});

test('peek "files" verdict classifies by real video signals, not incidental token matches', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  const dir = path.join(__dirname, '..', '.test-data', 'scorm');

  // (1) A slides/quiz module with NO real video — but with a `.video` CSS class and
  //     engine code mentioning ".mp4"/"<video>". This is the EXACT false positive the
  //     old verdict hit ("references video — fixable on our side"). It must now read
  //     as "no video found", not a problem on our side.
  fs.mkdirSync(path.join(dir, 'peek-novideo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'peek-novideo', 'index.html'), '<!doctype html><body>quiz</body>');
  fs.writeFileSync(path.join(dir, 'peek-novideo', 'style.css'), '.video{display:none}');
  fs.writeFileSync(path.join(dir, 'peek-novideo', 'engine.js'), 'function play(){/* generic .mp4 <video> handling */}');
  let d = await (await api.get('/api/admin/scorm/peek-novideo/files')).json();
  expect(d.videoStatus.level).toBe('info');        // NOT "fixable on our side"
  expect(d.playerKnowsVideo).toBe(false);
  expect(d.videos.length).toBe(0);
  expect(d.externalEmbeds.length).toBe(0);

  // (2) Already offloaded to the CDN (.cdn marker, local video deleted) → working.
  fs.mkdirSync(path.join(dir, 'peek-cdn'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'peek-cdn', 'index.html'), '<!doctype html><body>m</body>');
  fs.writeFileSync(path.join(dir, 'peek-cdn', '.cdn'), 'https://ncysa-modules.b-cdn.net/peek-cdn/');
  d = await (await api.get('/api/admin/scorm/peek-cdn/files')).json();
  expect(d.videoStatus.level).toBe('ok');
  expect(d.cdnOffloaded).toBe(true);
  expect(d.videoStatus.label).toMatch(/CDN/i);

  // (3) A bundled .mp4 → streams automatically on upload.
  fs.mkdirSync(path.join(dir, 'peek-bundled', 'media'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'peek-bundled', 'index.html'), '<!doctype html><body><video src="media/clip.mp4"></video></body>');
  fs.writeFileSync(path.join(dir, 'peek-bundled', 'media', 'clip.mp4'), 'FAKEMP4DATA');
  d = await (await api.get('/api/admin/scorm/peek-bundled/files')).json();
  expect(d.videoStatus.level).toBe('ok');
  expect(d.videos.length).toBe(1);
  expect(d.videoStatus.label).toMatch(/bundled/i);

  // (4) An external YouTube embed → plays from the source; nothing on our side.
  fs.mkdirSync(path.join(dir, 'peek-embed'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'peek-embed', 'index.html'), '<!doctype html><body><iframe src="https://www.youtube.com/embed/abc123"></iframe></body>');
  d = await (await api.get('/api/admin/scorm/peek-embed/files')).json();
  expect(d.videoStatus.level).toBe('ok');
  expect(d.externalEmbeds.length).toBeGreaterThan(0);
  expect(d.externalEmbeds[0].platform).toBe('YouTube');
  expect(d.videoStatus.label).toMatch(/embed/i);

  // (5) A Captivate-style Vimeo widget reference → detected as Vimeo, with the
  //     domain-whitelist fix surfaced right in the verdict (the real-world case).
  fs.mkdirSync(path.join(dir, 'peek-vimeo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'peek-vimeo', 'index.html'), '<!doctype html><body>captivate</body>');
  fs.writeFileSync(path.join(dir, 'peek-vimeo', 'CPM.js'), 'var cfg={source:"https://player.vimeo.com/video/123456789"};');
  d = await (await api.get('/api/admin/scorm/peek-vimeo/files')).json();
  expect(d.videoStatus.level).toBe('ok');
  expect(d.externalEmbeds.some((e) => e.platform === 'Vimeo')).toBe(true);
  expect(d.videoStatus.label).toMatch(/vimeo/i);
  expect(d.videoStatus.detail).toMatch(/refused to connect|Where can this be embedded/i);
});

test('a video lesson with a Vimeo link renders an inline embedded player (native, no Captivate)', async ({ page, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  const courseId = (await (await api.post('/api/admin/courses', { data: { title: 'Native Vimeo Course', audience: 'referees' } })).json()).course.id;
  const lessonId = (await (await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'video', title: 'Throw-In Clip', videoUrl: 'https://vimeo.com/1200487589', html: '<p>Watch the clip.</p>' } })).json()).lesson.id;
  await api.post(`/api/admin/courses/${courseId}/publish`, { data: { published: true } });

  await page.goto('/#/register');
  await page.fill('#firstName', 'Em'); await page.fill('#lastName', 'Bed');
  await page.fill('#email', `em.bed+${Date.now()}@example.com`);
  await page.click('button:has-text("Create account")');
  await page.request.post(`${BASE}/api/courses/${courseId}/enroll`);

  await page.goto(`/#/course/${courseId}/lesson/${lessonId}`);
  const ifr = page.locator('#embedVideo');
  await expect(ifr).toHaveAttribute('src', /player\.vimeo\.com\/video\/1200487589/); // inline Vimeo player, not a self-hosted <video>
  await expect(page.locator('#lessonVideo')).toHaveCount(0);                          // the MP4 player is not used
});

test('an OMG referee course with no co-logo shows the OMG mark (not NCSRA) in the header and card', async ({ page, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  const courseId = (await (await api.post('/api/admin/courses', { data: { title: 'OMG No-Logo Course', audience: 'referees' } })).json()).course.id;
  // OMG brand name set, but deliberately NO co-logo — the exact "Law Changes" case.
  await api.put(`/api/admin/courses/${courseId}`, { data: { orgId: 'omg', coBrandName: 'OMG Referee Education' } });
  await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'text', title: 'Intro', html: '<p>hi</p>' } });
  await api.post(`/api/admin/courses/${courseId}/publish`, { data: { published: true } });

  await page.goto('/#/org/omg/referees');
  const card = page.locator('.course-card', { hasText: 'OMG No-Logo Course' });
  await expect(card).toBeVisible();
  await expect(card.locator('.thumb-logo')).toHaveAttribute('src', /omg-logo\.png/);      // card falls back to OMG, not NCSRA
  await expect(card.locator('.thumb-logo')).not.toHaveAttribute('src', /ncsra/i);
  await expect(page.locator('.topnav .brandmark')).toHaveAttribute('src', /omg-logo\.png/); // header logo isn't empty/broken
});

test('video wiring check confirms each video actually delivers from the CDN URL the player uses', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  const dir = path.join(__dirname, '..', '.test-data', 'scorm');

  // (A) CDN-backed slideshow whose video (slide 3) IS reachable: point .cdn at this
  //     same test server and place the real media file, so the probe gets a 200/206.
  fs.mkdirSync(path.join(dir, 'wire-ok', 'media'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'wire-ok', 'index.html'), '<!doctype html><head></head><body>m</body>');
  fs.writeFileSync(path.join(dir, 'wire-ok', 'manifest.js'), 'var ITEMS=["i","i","v"];var TITLES=["A","B","V"];');
  fs.writeFileSync(path.join(dir, 'wire-ok', '.cdn'), `${BASE}/scorm/wire-ok/`);
  fs.writeFileSync(path.join(dir, 'wire-ok', 'media', 'item-003.mp4'), 'FAKE-MP4-BYTES');
  let r = await (await api.get('/api/admin/scorm/wire-ok/wiring')).json();
  expect(r.slideshow).toBe(true);
  expect(r.videos.length).toBe(1);
  expect(r.videos[0].slide).toBe(3);
  expect(r.videos[0].url).toContain('/scorm/wire-ok/media/item-003.mp4'); // the exact URL the player requests
  expect(r.videos[0].ok).toBe(true);
  expect(r.brokenCount).toBe(0);
  expect(r.status.level).toBe('ok');

  // (B) Same wiring, but the video file is MISSING from the CDN → player would 404.
  fs.mkdirSync(path.join(dir, 'wire-broken'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'wire-broken', 'index.html'), '<!doctype html><head></head><body>m</body>');
  fs.writeFileSync(path.join(dir, 'wire-broken', 'manifest.js'), 'var ITEMS=["i","v"];var TITLES=["A","V"];');
  fs.writeFileSync(path.join(dir, 'wire-broken', '.cdn'), `${BASE}/scorm/wire-broken/`);
  r = await (await api.get('/api/admin/scorm/wire-broken/wiring')).json();
  expect(r.brokenCount).toBe(1);
  expect(r.videos[0].ok).toBe(false);
  expect(r.status.level).toBe('error');

  // (C) No .cdn marker → nothing to check (not an error).
  fs.mkdirSync(path.join(dir, 'wire-nocdn'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'wire-nocdn', 'index.html'), '<!doctype html><head></head><body>m</body>');
  fs.writeFileSync(path.join(dir, 'wire-nocdn', 'manifest.js'), 'var ITEMS=["i","v"];');
  r = await (await api.get('/api/admin/scorm/wire-nocdn/wiring')).json();
  expect(r.cdn).toBe(false);
  expect(r.status.level).toBe('info');
});
