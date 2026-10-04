// Security hardening: lesson HTML is sanitized on save (stored XSS blocked while
// legitimate formatting survives), and scriptable SVG uploads are refused.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };

async function admin(playwright) {
  const c = await playwright.request.newContext({ baseURL: BASE });
  expect((await c.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  return c;
}

test('lesson HTML is sanitized on save — XSS stripped, safe formatting kept', async ({ playwright }) => {
  const c = await admin(playwright);
  const course = (await (await c.post('/api/admin/courses', { data: { title: `XSS ${Date.now()}`, audience: 'coaches' } })).json()).course;
  const evil = '<h2>Title</h2><p>ok <a href="https://x.com">link</a> <strong>bold</strong></p>'
    + '<img src="/uploads/a.png" alt="pic">'
    + '<img src=x onerror=alert(1)>'
    + '<script>alert(2)</script>'
    + '<a href="javascript:alert(3)">evil</a>'
    + '<p onclick="alert(4)">handler</p>';
  await c.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'text', title: 'L', html: evil } });
  const full = (await (await c.get(`/api/admin/courses/${course.id}`)).json()).course;
  const html = full.lessons[0].html;
  // Attacks removed.
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/onerror/i);
  expect(html).not.toMatch(/onclick/i);
  expect(html).not.toMatch(/javascript:/i);
  // Legitimate formatting preserved.
  expect(html).toContain('<h2>Title</h2>');
  expect(html).toContain('href="https://x.com"');
  expect(html).toContain('<strong>bold</strong>');
  expect(html).toContain('src="/uploads/a.png"');
});

test('slide captions are sanitized on save', async ({ playwright }) => {
  const c = await admin(playwright);
  const course = (await (await c.post('/api/admin/courses', { data: { title: `Cap ${Date.now()}`, audience: 'coaches' } })).json()).course;
  await c.post(`/api/admin/courses/${course.id}/lessons`, {
    data: { type: 'slides', title: 'S', slides: [{ img: '/uploads/s1.png', caption: 'hi<img src=x onerror=alert(1)>' }] },
  });
  const full = (await (await c.get(`/api/admin/courses/${course.id}`)).json()).course;
  const cap = full.lessons[0].slides[0].caption;
  expect(cap).not.toMatch(/onerror/i);
});

test('scriptable SVG image upload is refused', async ({ playwright }) => {
  const c = await admin(playwright);
  const res = await c.post('/api/admin/upload-image?name=evil', {
    headers: { 'content-type': 'image/svg+xml' },
    data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
  });
  expect(res.status()).toBe(400);
});

test('a valid PNG upload still works', async ({ playwright }) => {
  const c = await admin(playwright);
  // 1x1 transparent PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const res = await c.post('/api/admin/upload-image?name=ok', { headers: { 'content-type': 'image/png' }, data: png });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(String(body.url || '')).toMatch(/\.png$/);
});
