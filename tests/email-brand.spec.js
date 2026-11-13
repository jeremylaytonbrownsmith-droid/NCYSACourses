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

// The dashboard's test email has no course to brand it, so it speaks as the
// address it is sent from. The main test server has no sender configured →
// NCYSA Learn; a server whose SMTP_FROM is on ncsra.org → NCSRA.
async function testEmailOutbox(playwright, base) {
  const admin = await playwright.request.newContext({ baseURL: base });
  expect((await admin.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  const to = `testmail+${Date.now()}@example.com`;
  expect((await admin.post('/api/admin/test-email', { data: { to } })).ok()).toBeTruthy();
  const outbox = (await (await admin.get('/api/admin/overview')).json()).outbox;
  return outbox.find((m) => m.to === to);
}

test('the test email is NCYSA Learn when no sender address is configured', async ({ playwright }) => {
  const mail = await testEmailOutbox(playwright, BASE);
  expect(mail.subject).toBe('NCYSA Learn — test email');
  expect(mail.fromName).toBe('NCYSA Learn');
  expect(mail.html).toContain('North Carolina Youth Soccer Association · NCYSA Learn');
});

test.describe('test email from an @ncsra.org sender (own server)', () => {
  const { spawn } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const PORT = 3111;
  const NBASE = `http://localhost:${PORT}`;
  let proc, tmp;

  test.beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncsra-sender-'));
    const env = { ...process.env, DATA_DIR: path.join(tmp, 'data'), PORT: String(PORT), DISABLE_SCHEDULERS: '1', SMTP_FROM: 'noreply@ncsra.org' };
    delete env.NODE_ENV; delete env.BREVO_API_KEY; delete env.SENDGRID_API_KEY; delete env.SMTP_HOST; delete env.NOTIFY_WEBHOOK_URL; delete env.EMAIL_FROM;
    proc = spawn('node', ['server.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: 'ignore' });
    const deadline = Date.now() + 30000;
    for (;;) {
      try { const r = await fetch(`${NBASE}/api/courses`); if (r.ok) break; } catch (e) { /* not up yet */ }
      if (Date.now() > deadline) throw new Error('ncsra-sender server did not start');
      await new Promise((r) => setTimeout(r, 250));
    }
  });
  test.afterAll(async () => {
    if (proc) proc.kill('SIGKILL');
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  test('is branded NCSRA end to end', async ({ playwright }) => {
    const mail = await testEmailOutbox(playwright, NBASE);
    expect(mail.subject).toBe('NCSRA Referee Education — test email');
    expect(mail.fromName).toBe('NCSRA Referee Education');
    expect(mail.body).toContain('— NCSRA Referee Education');
    expect(mail.html).toContain(`${NBASE}/media/ncsra-logo.png`); // the crest, served from the request host in dev
    expect(mail.html).toContain('North Carolina Soccer Referee Association · NCSRA Referee Education');
    expect(mail.html).not.toContain('Youth Soccer');
  });
});
