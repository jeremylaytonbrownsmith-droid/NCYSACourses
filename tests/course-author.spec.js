// Every course records who designed it (the signed-in editor) at creation, and
// that attribution survives later edits — so staff can see who built each course.
const { test, expect } = require('@playwright/test');
const BASE = 'http://localhost:3100';

test('a new course records its designer, and edits keep it', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });

  const course = (await (await api.post('/api/admin/courses', { data: { title: 'Authored Course', audience: 'referees' } })).json()).course;
  expect(course.createdBy).toBeTruthy();
  expect(course.createdBy.email.toLowerCase()).toBe('da@ncsoccer.org');
  expect(course.createdBy.role).toBe('admin'); // the designer account seeds as staff
  expect(course.createdAt).toBeTruthy();

  // An edit (rename) must not wipe the designer attribution.
  await api.put(`/api/admin/courses/${course.id}`, { data: { title: 'Authored Course (renamed)' } });
  const after = (await (await api.get(`/api/admin/courses/${course.id}`)).json()).course;
  expect(after.title).toBe('Authored Course (renamed)');
  expect(after.createdBy.email.toLowerCase()).toBe('da@ncsoccer.org');
  expect(after.createdAt).toBe(course.createdAt);
});
