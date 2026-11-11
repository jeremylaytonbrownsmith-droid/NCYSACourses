// The referee portal groups its courses into fixed-order sections — Referees,
// Mentors, Assignors — inferred from each title unless the Designer sets an
// explicit "Section". Inside a section, first-time courses come before
// recertification. A portal with only one section keeps the plain grid.
const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };

async function makeCourse(api, title, extra = {}) {
  const course = (await (await api.post('/api/admin/courses', { data: { title, audience: 'referees', ...extra } })).json()).course;
  await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'text', title: 'Read', html: '<p>x</p>' } });
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });
  return course;
}

test('track is stored only when valid, cleared by empty, and exposed on the public list', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  const c = await makeCourse(api, `Track Course ${Date.now()}`);
  const get = async () => (await (await api.get(`/api/admin/courses/${c.id}`)).json()).course;
  expect((await get()).track).toBeUndefined();                      // default: auto
  await api.put(`/api/admin/courses/${c.id}`, { data: { track: 'Assignor' } });
  expect((await get()).track).toBe('assignor');                      // case-insensitive, known value
  await api.put(`/api/admin/courses/${c.id}`, { data: { track: 'bogus' } });
  expect((await get()).track).toBe('assignor');                      // unknown value ignored
  const pub = (await (await api.get('/api/courses')).json()).courses.find((x) => x.id === c.id);
  expect(pub.track).toBe('assignor');                                // public list carries it
  await api.put(`/api/admin/courses/${c.id}`, { data: { track: '' } });
  expect((await get()).track).toBeUndefined();                       // empty clears back to auto
});

test('the referee portal shows Referees, Mentors and Assignors sections, first-time before recert', async ({ page, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  const s = Date.now();
  // Inferred from titles — no Section set on any of these.
  const refRecert = await makeCourse(api, `Zed Referee Recertification ${s}`);
  const refNew = await makeCourse(api, `Zed Referee First-Time ${s}`);
  const mentor = await makeCourse(api, `Zed Mentor Development ${s}`);
  const asgRecert = await makeCourse(api, `Zed Assignor Recertification ${s}`);
  const asgNew = await makeCourse(api, `Zed First-Time Assignor ${s}`);
  // An explicit Section wins over the title: this "Referee" title is filed under Mentors.
  const forced = await makeCourse(api, `Zed Referee Coaching ${s}`, { track: 'mentor' });

  const ctx = await page.context();
  await ctx.addCookies((await api.storageState()).cookies);
  await page.goto('/#/referees');
  await expect(page.locator('.portal-group')).toHaveCount(3);
  await expect(page.locator('.portal-group-head h3')).toHaveText(['Referees', 'Mentors', 'Assignors']);

  const inSection = (track, id) => page.locator(`.portal-group[data-track="${track}"] .enroll-btn[data-course="${id}"]`);
  await expect(inSection('referee', refRecert.id)).toHaveCount(1);
  await expect(inSection('referee', refNew.id)).toHaveCount(1);
  await expect(inSection('mentor', mentor.id)).toHaveCount(1);
  await expect(inSection('mentor', forced.id)).toHaveCount(1);     // explicit track beat the title
  await expect(inSection('assignor', asgRecert.id)).toHaveCount(1);
  await expect(inSection('assignor', asgNew.id)).toHaveCount(1);

  // First-time before recertification within a section.
  const asgOrder = await page.locator('.portal-group[data-track="assignor"] .enroll-btn').evaluateAll((els) => els.map((e) => e.dataset.course));
  expect(asgOrder.indexOf(asgNew.id)).toBeLessThan(asgOrder.indexOf(asgRecert.id));
  const refOrder = await page.locator('.portal-group[data-track="referee"] .enroll-btn').evaluateAll((els) => els.map((e) => e.dataset.course));
  expect(refOrder.indexOf(refNew.id)).toBeLessThan(refOrder.indexOf(refRecert.id));
});

test('a portal with a single section keeps the plain grid (no section headings)', async ({ page, playwright }) => {
  // OMG's portal: every course there is a referee-track course.
  await page.goto('/#/org/omg/referees');
  await expect(page.locator('.role-hero')).toHaveCount(1);                 // portal rendered
  await expect(page.locator('.portal-group')).toHaveCount(0);               // no section headings
  expect(await page.locator('.course-grid').count()).toBeLessThanOrEqual(1); // at most one plain grid
});
