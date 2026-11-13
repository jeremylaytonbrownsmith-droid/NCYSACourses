// Verified passwordless sign-in (LEARNER_EMAIL_CODE=on). Learners still never
// set a password; instead the server emails a 6-digit code and the browser that
// asked for it must type it back. The main test server runs with the switch OFF
// (the original "email signs you in" behaviour, which every other spec relies
// on), so the switched-on tests start their own server with the switch ON. With
// no email provider configured and NODE_ENV not "production", the server hands
// the code back in the response (`devCode`) — never on Render, where
// NODE_ENV=production.
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3108;
const BASE = `http://localhost:${PORT}`;
const MAIN = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };

const fresh = (playwright, baseURL = BASE) => playwright.request.newContext({ baseURL });
const me = async (ctx) => (await (await ctx.get('/api/me')).json()).user;

test.describe('switch ON (own server)', () => {
  let proc, tmp;

  test.beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'logincode-'));
    const env = { ...process.env, DATA_DIR: path.join(tmp, 'data'), PORT: String(PORT), DISABLE_SCHEDULERS: '1', LEARNER_EMAIL_CODE: 'on' };
    delete env.NODE_ENV; delete env.BREVO_API_KEY; delete env.SENDGRID_API_KEY; delete env.SMTP_HOST; delete env.NOTIFY_WEBHOOK_URL;
    proc = spawn('node', ['server.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: 'ignore' });
    const deadline = Date.now() + 30000;
    for (;;) {
      try { const r = await fetch(`${BASE}/api/courses`); if (r.ok) break; } catch (e) { /* not up yet */ }
      if (Date.now() > deadline) throw new Error('code-login test server did not start');
      await new Promise((r) => setTimeout(r, 300));
    }
    // While the feature is hard-forced off in server.js (live email delivery is
    // broken), the switched-on flow can't be exercised — skip this group rather
    // than fail, so the forced-off state is visible in the report and nothing is
    // silently passing. The switch-OFF test below still runs.
    const { codeLogin } = await (await fetch(`${BASE}/api/me`)).json();
    if (!codeLogin) test.skip(true, 'LEARNER_EMAIL_CODE is hard-forced off in server.js until live email delivery is repaired');
  });
  test.afterAll(async () => {
    if (proc) proc.kill('SIGKILL');
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  test('creating an account sends a code and opens nothing until the right code comes back from the same browser', async ({ playwright }) => {
    const ctx = await fresh(playwright);
    const email = `codey+${Date.now()}@example.com`;
    const r = await ctx.post('/api/register', { data: { firstName: 'Codey', lastName: 'Ref', email } });
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(body.codeRequired).toBe(true);
    expect(body.user).toBeUndefined();                       // no session handed out
    expect(body.devCode).toMatch(/^\d{6}$/);
    expect(await me(ctx)).toBeNull();

    // Wrong code: counted, generic, still locked out.
    const bad = await ctx.post('/api/login/verify', { data: { code: body.devCode === '000000' ? '111111' : '000000' } });
    expect(bad.status()).toBe(401);
    expect((await bad.json()).triesLeft).toBe(4);
    expect(await me(ctx)).toBeNull();

    // Right code: account created now, session opened, code spent.
    const good = await ctx.post('/api/login/verify', { data: { code: body.devCode } });
    expect(good.ok()).toBeTruthy();
    const u = (await good.json()).user;
    expect(u.email).toBe(email);
    expect(u.name).toBe('Codey Ref');
    expect(u.role).toBe('learner');
    expect((await me(ctx)).id).toBe(u.id);
    const again = await ctx.post('/api/login/verify', { data: { code: body.devCode } });
    expect(again.status()).toBe(410);                        // single use
  });

  test('a code only works from the browser that asked for it', async ({ playwright }) => {
    const a = await fresh(playwright);
    const b = await fresh(playwright);
    const email = `twobrowsers+${Date.now()}@example.com`;
    const { devCode } = await (await a.post('/api/register', { data: { firstName: 'Two', lastName: 'Browsers', email } })).json();
    // Browser B knows the code (shoulder-surfed) but holds no challenge cookie.
    const stolen = await b.post('/api/login/verify', { data: { code: devCode } });
    expect(stolen.status()).toBe(410);
    expect(await me(b)).toBeNull();
    // Browser A is fine.
    expect((await a.post('/api/login/verify', { data: { code: devCode } })).ok()).toBeTruthy();
    expect((await me(a)).email).toBe(email);
  });

  test('five wrong guesses burn the code, and a resend retires the previous one', async ({ playwright }) => {
    const ctx = await fresh(playwright);
    const email = `guesser+${Date.now()}@example.com`;
    const first = await (await ctx.post('/api/register', { data: { firstName: 'Gus', lastName: 'Guesser', email } })).json();
    const wrong = first.devCode === '999999' ? '000000' : '999999';
    for (let i = 1; i <= 4; i++) expect((await ctx.post('/api/login/verify', { data: { code: wrong } })).status()).toBe(401);
    const fifth = await ctx.post('/api/login/verify', { data: { code: wrong } });
    expect(fifth.status()).toBe(410);                                                  // burned
    expect((await ctx.post('/api/login/verify', { data: { code: first.devCode } })).status()).toBe(410); // even the right one
    // Resend from the same browser keeps the sign-up's name; the new code works.
    const second = await (await ctx.post('/api/login/code', { data: { email } })).json();
    expect(second.devCode).toMatch(/^\d{6}$/);
    const ok = await ctx.post('/api/login/verify', { data: { code: second.devCode } });
    expect(ok.ok()).toBeTruthy();
    expect((await ok.json()).user.name).toBe('Gus Guesser');
  });

  test('a returning learner gets a code too and keeps the same account; staff sign-in is untouched', async ({ playwright }) => {
    const a = await fresh(playwright);
    const email = `returning+${Date.now()}@example.com`;
    const r1 = await (await a.post('/api/register', { data: { firstName: 'Ria', lastName: 'Returning', email } })).json();
    const id1 = (await (await a.post('/api/login/verify', { data: { code: r1.devCode } })).json()).user.id;
    // New device, "Welcome back" path: email → code → same account, no duplicate.
    const b = await fresh(playwright);
    const r2 = await (await b.post('/api/login', { data: { email } })).json();
    expect(r2.codeRequired).toBe(true);
    expect(await me(b)).toBeNull();
    const id2 = (await (await b.post('/api/login/verify', { data: { code: r2.devCode } })).json()).user.id;
    expect(id2).toBe(id1);
    // Typing a staff email into learner sign-up/sign-in never sends a code; the password path still works.
    const s = await fresh(playwright);
    const staffTry = await s.post('/api/register', { data: { firstName: 'X', lastName: 'Y', email: ADMIN.email } });
    expect(staffTry.status()).toBe(403);
    expect((await staffTry.json()).needsPassword).toBe(true);
    const staffCode = await s.post('/api/login/code', { data: { email: ADMIN.email } });
    expect(staffCode.status()).toBe(403);
    const staffLogin = await s.post('/api/login', { data: ADMIN });
    expect(staffLogin.ok()).toBeTruthy();
    expect((await staffLogin.json()).user.role).toBe('admin');
    // An unknown email can't be sent a code from the sign-in box (it belongs in Create account).
    const unknown = await s.post('/api/login/code', { data: { email: `nobody+${Date.now()}@example.com` } });
    expect(unknown.status()).toBe(404);
  });

  test('the code email is branded for the portal: NCSRA for referees, NCYSA Learn otherwise', async ({ playwright }) => {
    const ref = await fresh(playwright);
    const refEmail = `refbrand+${Date.now()}@example.com`;
    await ref.post('/api/register', { data: { firstName: 'Ref', lastName: 'Brand', email: refEmail, portal: 'referee' } });
    const coach = await fresh(playwright);
    const coachEmail = `coachbrand+${Date.now()}@example.com`;
    await coach.post('/api/register', { data: { firstName: 'Coach', lastName: 'Brand', email: coachEmail } });
    const admin = await fresh(playwright);
    expect((await admin.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
    const outbox = (await (await admin.get('/api/admin/overview')).json()).outbox;
    const toRef = outbox.find((m) => m.to === refEmail);
    const toCoach = outbox.find((m) => m.to === coachEmail);
    expect(toRef.subject).toMatch(/^\d{6} is your NCSRA Referee Education sign-in code$/);
    expect(toRef.body).toContain('North Carolina Soccer Referee Association');
    expect(toRef.fromName).toBe('NCSRA Referee Education');
    // The HTML version: NCSRA crest in the header, the code large, the footer signed NCSRA.
    const code = toRef.subject.slice(0, 6);
    expect(toRef.html).toContain(`${BASE}/media/ncsra-logo.png`);
    expect(toRef.html).toContain('Your sign-in code');
    expect(toRef.html).toContain(`letter-spacing:.3em;color:#10045a">${code}<`);
    expect(toRef.html).toContain('North Carolina Soccer Referee Association · NCSRA Referee Education');
    expect(toRef.html).not.toContain('Youth Soccer');
    expect(toCoach.subject).toMatch(/^\d{6} is your NCYSA Learn sign-in code$/);
    expect(toCoach.fromName).toBe('NCYSA Learn');
    expect(toCoach.html).toContain(`${BASE}/media/ncysa-logo.png`);
  });

  test('a returning referee learner gets the NCSRA code email even from the plain sign-in page', async ({ playwright }) => {
    // A designer publishes a referee course; the learner signs up (from the
    // referee portal), enrolls, then later signs in from the generic page.
    const designer = await fresh(playwright);
    expect((await designer.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } })).ok()).toBeTruthy();
    const course = (await (await designer.post('/api/admin/courses', { data: { title: `NCSRA Brand Course ${Date.now()}`, audience: 'referees' } })).json()).course;
    await designer.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'quiz', title: 'Check', passPercent: 50, questions: [{ prompt: 'Sky color?', options: ['Green', 'Blue'], answer: 1 }] } });
    await designer.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });

    const email = `returning+${Date.now()}@example.com`;
    const first = await fresh(playwright);
    const reg = await (await first.post('/api/register', { data: { firstName: 'Rae', lastName: 'Returning', email, portal: 'referee' } })).json();
    expect((await first.post('/api/login/verify', { data: { code: reg.devCode } })).ok()).toBeTruthy();
    expect((await first.post(`/api/courses/${course.id}/enroll`)).ok()).toBeTruthy();

    // New browser, plain sign-in page: no portal hint in the request at all.
    const later = await fresh(playwright);
    const r = await (await later.post('/api/login', { data: { email } })).json();
    expect(r.codeRequired).toBe(true);
    const admin = await fresh(playwright);
    expect((await admin.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
    const outbox = (await (await admin.get('/api/admin/overview')).json()).outbox;
    const mail = outbox.filter((m) => m.to === email).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    expect(mail.subject).toMatch(/^\d{6} is your NCSRA Referee Education sign-in code$/);
    expect(mail.fromName).toBe('NCSRA Referee Education');
    expect(mail.html).toContain('/media/ncsra-logo.png');
  });

  test('in the browser: Create account → code screen → signed in, and the session survives a reload', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/#/register`);
    await page.fill('#firstName', 'Casey');
    await page.fill('#lastName', 'Codeflow');
    await page.fill('#email', `casey+${Date.now()}@example.com`);
    await page.click('button:has-text("Create account")');
    await expect(page.locator('.auth-wrap h2')).toHaveText('Check your email');
    await expect(page.locator('.topnav')).not.toContainText('Hi, Casey');          // not in yet
    const code = await page.locator('#devCode').textContent();
    expect(code).toMatch(/^\d{6}$/);
    await page.fill('#code', '123456' === code ? '654321' : '123456');
    await page.click('button:has-text("Sign in")');
    await expect(page.locator('#formError')).toContainText('isn’t right');
    await page.fill('#code', code);
    await page.click('button:has-text("Sign in")');
    await expect(page.locator('.topnav')).toContainText('Hi, Casey');
    await page.reload();
    await expect(page.locator('.topnav')).toContainText('Hi, Casey');              // 30-day session, no code again
    await ctx.close();
  });
});

test.describe('PILOT: a list of emails (own server)', () => {
  const PPORT = 3110;
  const PBASE = `http://localhost:${PPORT}`;
  const PILOT = `pilot+${Date.now()}@example.com`;
  let proc, tmp;

  test.beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'logincode-pilot-'));
    const env = { ...process.env, DATA_DIR: path.join(tmp, 'data'), PORT: String(PPORT), DISABLE_SCHEDULERS: '1', LEARNER_EMAIL_CODE: `${PILOT}, @pilot.test` };
    delete env.NODE_ENV; delete env.BREVO_API_KEY; delete env.SENDGRID_API_KEY; delete env.SMTP_HOST; delete env.NOTIFY_WEBHOOK_URL;
    proc = spawn('node', ['server.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: 'ignore' });
    const deadline = Date.now() + 30000;
    for (;;) {
      try { const r = await fetch(`${PBASE}/api/courses`); if (r.ok) break; } catch (e) { /* not up yet */ }
      if (Date.now() > deadline) throw new Error('pilot test server did not start');
      await new Promise((r) => setTimeout(r, 300));
    }
  });
  test.afterAll(async () => {
    if (proc) proc.kill('SIGKILL');
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  });

  test('only the listed emails and domains get the code; everyone else signs straight in, and the copy stays the old one', async ({ playwright }) => {
    // Not in the pilot: the original behaviour, untouched.
    const pub = await fresh(playwright, PBASE);
    const r = await (await pub.post('/api/register', { data: { firstName: 'Pub', lastName: 'Lic', email: `public+${Date.now()}@example.com` } })).json();
    expect(r.codeRequired).toBeUndefined();
    expect(r.user.name).toBe('Pub Lic');
    expect((await me(pub)).name).toBe('Pub Lic');
    expect((await (await pub.get('/api/me')).json()).codeLogin).toBe(false);   // sign-in copy unchanged for the public
    // In the pilot by exact email: the code flow.
    const pilot = await fresh(playwright, PBASE);
    const p = await (await pilot.post('/api/register', { data: { firstName: 'Pi', lastName: 'Lot', email: PILOT } })).json();
    expect(p.codeRequired).toBe(true);
    expect(await me(pilot)).toBeNull();
    expect((await pilot.post('/api/login/verify', { data: { code: p.devCode } })).ok()).toBeTruthy();
    expect((await me(pilot)).email).toBe(PILOT);
    // In the pilot by domain, case-insensitive.
    const dom = await fresh(playwright, PBASE);
    const d = await (await dom.post('/api/register', { data: { firstName: 'Do', lastName: 'Main', email: `Someone@Pilot.Test` } })).json();
    expect(d.codeRequired).toBe(true);
    // The resend endpoint follows the same rule.
    expect((await pub.post('/api/login/code', { data: { email: `public+${Date.now()}@example.com` } })).status()).toBe(404);
  });
});

test('with the switch OFF (the main test server), sign-up still signs in directly', async ({ playwright }) => {
  const ctx = await fresh(playwright, MAIN);
  const r = await (await ctx.post('/api/register', { data: { firstName: 'Old', lastName: 'Way', email: `oldway+${Date.now()}@example.com` } })).json();
  expect(r.codeRequired).toBeUndefined();
  expect(r.user.name).toBe('Old Way');
  expect((await me(ctx)).name).toBe('Old Way');
  expect((await ctx.post('/api/login/code', { data: { email: r.user.email } })).status()).toBe(404); // endpoint dark
});
