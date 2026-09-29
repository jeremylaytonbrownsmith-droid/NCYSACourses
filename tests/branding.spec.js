// The SPA ships one index.html, so link previews (iMessage/social) must be set
// server-side per domain: GetMatchReady on the product/OMG domain, NCYSA Learn
// on the NCYSA site. Scrapers don't run our JS, so this is done at serve time.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';

test('the product/OMG domain serves GetMatchReady title + preview (never NCYSA)', async ({ request }) => {
  const html = await (await request.get(`${BASE}/`, { headers: { host: 'getmatchready.app' } })).text();
  expect(html).toMatch(/<title>GetMatchReady/i);
  expect(html).not.toMatch(/<title>[^<]*NCYSA/i);
  expect(html).toContain('property="og:site_name" content="GetMatchReady"');
  expect(html).toContain('property="og:title" content="GetMatchReady');
  expect(html).toContain('property="og:image" content="http://getmatchready.app/media/getmatchready-og.png"');
  expect(html).toContain('name="twitter:card" content="summary_large_image"');
});

test('the NCYSA site serves NCYSA Learn title + preview', async ({ request }) => {
  const html = await (await request.get(`${BASE}/`, { headers: { host: 'ncysalearn.app' } })).text();
  expect(html).toMatch(/<title>NCYSA Learn/i);
  expect(html).toContain('property="og:site_name" content="NCYSA Learn"');
  expect(html).toContain('/icons/ncysa-512.png');
});

test('a deep SPA path also gets the per-domain preview', async ({ request }) => {
  const html = await (await request.get(`${BASE}/anything/here`, { headers: { host: 'getmatchready.app' } })).text();
  expect(html).toMatch(/<title>GetMatchReady/i);
});
