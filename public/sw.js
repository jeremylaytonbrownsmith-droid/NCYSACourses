// GetMatchReady / NCYSA Learn — PWA service worker.
//
// This exists ONLY so the site qualifies as an installable app (the "Install
// app" button on desktop/Android). It deliberately does NO offline caching and
// does NOT intercept any request: the `fetch` handler is a no-op, so every
// request goes straight to the network exactly as if there were no service
// worker at all. That means there is zero risk of it serving stale or broken
// cached code, and it cannot affect the partner integration, launches, uploads,
// or webhooks — those all run server-side and are untouched.
//
// The app shell (HTML/JS/CSS) is already sent with `Cache-Control: no-cache` by
// the server, so a new deploy is always picked up on the next load.

self.addEventListener('install', () => {
  // Activate this version immediately instead of waiting for old tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Take control of open pages right away, and proactively clear any caches a
  // previous version might have created (there are none today, but this keeps
  // the worker guaranteed cache-free even after future edits).
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (_) { /* caches API unavailable — nothing to clean */ }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', () => {
  // No-op passthrough. Present so the browser considers the app installable, but
  // it never calls respondWith(), so the network handles every request natively.
  return;
});
