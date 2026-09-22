// The site is an installable PWA: a per-domain web app manifest, square icons,
// and a network-only service worker (no offline caching, so it can never serve
// stale/broken code). These assert the install surface exists and is coherent —
// without changing any app behavior.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';

test('serves a valid web app manifest with the required install fields', async ({ request }) => {
  const res = await request.get(`${BASE}/manifest.webmanifest`);
  expect(res.ok()).toBeTruthy();
  expect((res.headers()['content-type'] || '')).toContain('manifest');
  const m = await res.json();
  expect(m.name).toBeTruthy();
  expect(m.start_url).toBe('/');
  expect(m.display).toBe('standalone');
  // Installability needs a 192 and a 512 icon, plus a maskable one for Android.
  const sizes = (m.icons || []).map((i) => i.sizes);
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
  expect((m.icons || []).some((i) => (i.purpose || '').includes('maskable'))).toBeTruthy();
  // Every icon actually exists and is a PNG.
  for (const icon of m.icons) {
    const img = await request.get(`${BASE}${icon.src}`);
    expect(img.ok()).toBeTruthy();
    expect((img.headers()['content-type'] || '')).toContain('image/png');
  }
});

test('the service worker is served and is network-only (no cache API writes)', async ({ request }) => {
  const res = await request.get(`${BASE}/sw.js`);
  expect(res.ok()).toBeTruthy();
  const body = await res.text();
  expect(body).toContain("addEventListener('fetch'");
  // It must never populate a cache (that's the whole point — no stale code).
  expect(body).not.toContain('cache.put');
  expect(body).not.toContain('cache.add');
  expect(body).not.toContain('caches.open');
});

test('index.html links the manifest and registers the service worker', async ({ request }) => {
  const html = await (await request.get(`${BASE}/`)).text();
  expect(html).toContain('rel="manifest"');
  expect(html).toContain('apple-touch-icon');
  expect(html).toContain("serviceWorker.register('/sw.js')");
});
