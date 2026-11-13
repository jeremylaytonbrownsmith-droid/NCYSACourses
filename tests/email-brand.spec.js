// Referee courses on the NC site belong to the North Carolina Soccer Referee
// Association, not NCYSA. Their completion emails — subject, sender name,
// signature and footer — must say NCSRA; coach/staff courses stay NCYSA Learn.
const { test, expect } = require('@playwright/test');
const AdmZip = require('adm-zip');

const BASE = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };
const DESIGNER = { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' };

function zip() {
  const z = new AdmZip();
  z.addFile('index.html', Buffer.from('<!doctype html><title>Mod</title><p>Hi</p>', 'utf8'));
  return z.toBuffer();
}

// A one-module course the learner completes with a single status report.
async function completeCourse(playwright, { title, audience, coBrandName }) {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: DESIGNER })).ok()).toBeTruthy();
  const up = await (await api.post(`/api/admin/scorm?name=Brand${Date.now()}`, { headers: { 'content-type': 'application/zip' }, data: zip() })).json();
  const course = (await (await api.post('/api/admin/courses', { data: { title, audience } })).json()).course;
  if (coBrandName) await api.put(`/api/admin/courses/${course.id}`, { data: { coBrandName } });
  await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'scorm', title: 'Module', packageId: up.packageId, launchFile: up.launchFile, htmlPackage: true, minMinutes: 0 } });
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });
  const lessonId = (await (await api.get(`/api/admin/courses/${course.id}`)).json()).course.lessons[0].id;
  const learner = await playwright.request.newContext({ baseURL: BASE });
  const email = `brand+${audience}+${Date.now()}@example.com`;
  await learner.post('/api/register', { data: { firstName: 'Bea', lastName: 'Brand', email } });
  await learner.post(`/api/courses/${course.id}/enroll`);
  const r = await (await learner.post(`/api/courses/${course.id}/lessons/${lessonId}/scorm`, { data: { status: 'completed' } })).json();
  expect(r.courseCompleted).toBe(true);
  return { email, title };
}

async function outboxFor(playwright, email) {
  const admin = await playwright.request.newContext({ baseURL: BASE });
  expect((await admin.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  const outbox = (await (await admin.get('/api/admin/overview')).json()).outbox;
  return outbox.find((m) => m.to === email);
}

test('a referee course completion is branded NCSRA end to end', async ({ playwright }) => {
  const { email, title } = await completeCourse(playwright, { title: `NCSRA Referee Recertification ${Date.now()}`, audience: 'referees', coBrandName: 'NCSRA' });
  const mail = await outboxFor(playwright, email);
  expect(mail.subject).toBe(`Your NCSRA certificate — ${title}`);
  expect(mail.fromName).toBe('NCSRA Referee Education');
  expect(mail.body).toContain('— NCSRA Referee Education');
  expect(mail.html).toContain('North Carolina Soccer Referee Association · NCSRA Referee Education');
  expect(mail.html).not.toContain('Youth Soccer');
});

test('a coach course completion stays NCYSA Learn', async ({ playwright }) => {
  const { email, title } = await completeCourse(playwright, { title: `Coaching License ${Date.now()}`, audience: 'everyone' });
  const mail = await outboxFor(playwright, email);
  expect(mail.subject).toBe(`Your NCYSA certificate — ${title}`);
  expect(mail.fromName).toBe('NCYSA Learn');
  expect(mail.html).toContain('North Carolina Youth Soccer Association · NCYSA Learn');
});
