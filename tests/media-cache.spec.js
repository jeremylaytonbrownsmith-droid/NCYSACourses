// Static media (images/video/fonts) is cached in the browser for a week to cut
// repeat-view bandwidth; the app shell (HTML/JS/CSS) stays revalidated so deploys
// are picked up.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';

test('media gets a long cache, the app shell does not', async ({ playwright }) => {
  const c = await playwright.request.newContext({ baseURL: BASE });
  const media = await c.get('/media/getmatchready-mark.svg');
  expect(media.ok()).toBeTruthy();
  expect(String(media.headers()['cache-control'] || '')).toContain('max-age=604800');

  const js = await c.get('/app.js');
  expect(js.ok()).toBeTruthy();
  expect(String(js.headers()['cache-control'] || '')).not.toContain('604800');
});
