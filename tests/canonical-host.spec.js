// The service also answers on Render's own hostname (ncysa-learn.onrender.com).
// A page opened there loads every file — videos included — from onrender.com,
// which a school network's Microsoft filter blocked while allowing
// ncysalearn.app. So page loads on any *.onrender.com host are permanently
// redirected to the NCYSA front door; health, the API, partner launch links and
// package files are left alone.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const RENDER = { host: 'ncysa-learn.onrender.com' };

test('a page load on the onrender host is permanently redirected to ncysalearn.app, keeping the path', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE, maxRedirects: 0 });
  const home = await api.get('/', { headers: RENDER });
  expect(home.status()).toBe(301);
  expect(home.headers()['location']).toBe('https://ncysalearn.app/');
  const deep = await api.get('/some/page?x=1', { headers: RENDER });
  expect(deep.status()).toBe(301);
  expect(deep.headers()['location']).toBe('https://ncysalearn.app/some/page?x=1');
  const asset = await api.get('/app.js', { headers: RENDER });
  expect(asset.status()).toBe(301);                       // the shell's assets go too
});

test('health, the API, launch links and package files are NOT redirected on the onrender host', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE, maxRedirects: 0 });
  expect((await api.get('/health', { headers: RENDER })).status()).toBe(200);          // Render's own check
  expect((await api.get('/api/courses', { headers: RENDER })).status()).toBe(200);     // JSON API
  const launch = await api.get('/launch?token=nope', { headers: RENDER });
  expect(launch.status()).not.toBe(301);                                                // handled, not bounced
  const pkg = await api.get('/scorm/no-such-package/index.html', { headers: RENDER });
  expect(pkg.status()).not.toBe(301);                                                   // package files served (or 404) in place
  // A POST is never redirected (a 301 would turn it into a GET).
  const post = await api.post('/api/login', { headers: RENDER, data: { email: 'x@example.com', password: 'nope' } });
  expect(post.status()).not.toBe(301);
});

test('the custom domains are untouched', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE, maxRedirects: 0 });
  expect((await api.get('/', { headers: { host: 'ncysalearn.app' } })).status()).toBe(200);
  expect((await api.get('/', { headers: { host: 'getmatchready.app' } })).status()).toBe(200);
  expect((await api.get('/')).status()).toBe(200);                                       // localhost / tests
});
