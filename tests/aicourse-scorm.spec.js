// AI course generation (server-side, one API key) + portable SCORM 1.2 export.
// The AI path's pure helpers are unit-tested directly (no network); the HTTP
// endpoints are tested against the running server; the exporter is checked by
// unzipping the real package the endpoint returns.
const { test, expect } = require('@playwright/test');
const AdmZip = require('adm-zip');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeDraft, sanitizeHtml } = require('../lib/aicourse');

const BASE = 'http://localhost:3100';
const DESIGNER = { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' };

test('normalizeDraft turns raw AI output into valid text lessons + a graded quiz', () => {
  const draft = normalizeDraft({
    title: 'Throw-In Basics',
    tagline: 'Quick guide',
    lessons: [
      { title: 'Rules', html: '<h3>Rules</h3><p>Two hands.</p><div class="callout">Both feet down.</div>' },
      { title: 'Timing', html: '<p>Five seconds.</p>' },
    ],
    quiz: [
      { prompt: 'How many hands?', options: ['One', 'Two'], answerIndex: 1 },
      { prompt: 'Seconds allowed?', options: ['3', '5', '10'], answerIndex: 1 },
    ],
  }, { passPercent: 75 });
  expect(draft.title).toBe('Throw-In Basics');
  // 2 reading lessons + 1 quiz lesson
  expect(draft.lessons.length).toBe(3);
  expect(draft.lessons[0].type).toBe('text');
  expect(draft.lessons[0].html).toContain('class="callout"');
  const quiz = draft.lessons[2];
  expect(quiz.type).toBe('quiz');
  expect(quiz.passPercent).toBe(75);
  expect(quiz.questions.length).toBe(2);
  expect(quiz.questions[0].answer).toBe(1);
});

test('sanitizeHtml strips scripts/handlers but keeps the documented safe tags', () => {
  const dirty = '<p onclick="x()">Hi <strong>there</strong></p><script>alert(1)</script><iframe src="evil"></iframe><div class="callout">note</div>';
  const clean = sanitizeHtml(dirty);
  expect(clean).not.toMatch(/script|iframe|onclick/i);
  expect(clean).toContain('<strong>');
  expect(clean).toContain('class="callout"');
});

test('AI status + build are gated on a configured key (no key → clear 400, never a crash)', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: DESIGNER });
  const status = await (await api.get('/api/admin/ai/status')).json();
  expect(typeof status.enabled).toBe('boolean');
  if (!status.enabled) {
    const res = await api.post('/api/admin/courses/ai-build', { data: { topic: 'Offside basics' } });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toMatch(/ANTHROPIC_API_KEY|not configured/i);
  }
});

test('a course exports as a valid SCORM 1.2 package (manifest + player + graded quiz)', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: DESIGNER });
  const courseId = (await (await api.post('/api/admin/courses', { data: { title: 'Export Me Course', audience: 'referees' } })).json()).course.id;
  await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'text', title: 'Reading', html: '<h3>Welcome</h3><p>Study this.</p>' } });
  await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'quiz', title: 'Check', passPercent: 80, questions: [{ prompt: 'Sky color?', options: ['Green', 'Blue'], answer: 1 }] } });

  const res = await api.get(`/api/admin/courses/${courseId}/export/scorm`);
  expect(res.ok()).toBeTruthy();
  expect(res.headers()['content-type']).toContain('zip');
  const zip = new AdmZip(await res.body());
  const names = zip.getEntries().map((e) => e.entryName);
  expect(names).toContain('imsmanifest.xml');
  expect(names).toContain('index.html');
  expect(names).toContain('runtime.js');

  const manifest = zip.readAsText('imsmanifest.xml');
  expect(manifest).toContain('<schemaversion>1.2</schemaversion>');
  expect(manifest).toContain('adlcp:scormtype="sco"');
  expect(manifest).toContain('href="index.html"');

  const index = zip.readAsText('index.html');
  expect(index).toContain('runtime.js');
  expect(index).toContain('window.LMS');  // the player talks to one adapter interface
  expect(index).toContain('Sky color?');  // the quiz travels in the package

  const rt = zip.readAsText('runtime.js');
  expect(rt).toMatch(/LMSInitialize/);     // SCORM 1.2 runtime
  expect(rt).toMatch(/LMSFinish/);
  expect(rt).toMatch(/cmi\.core\.lesson_status/);
});

test('a course exports as SCORM 2004 (2004 manifest + API_1484_11 runtime)', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: DESIGNER });
  const courseId = (await (await api.post('/api/admin/courses', { data: { title: 'Export 2004', audience: 'referees' } })).json()).course.id;
  await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'text', title: 'Reading', html: '<p>Study.</p>' } });

  const res = await api.get(`/api/admin/courses/${courseId}/export?format=scorm2004`);
  expect(res.ok()).toBeTruthy();
  const zip = new AdmZip(await res.body());
  const names = zip.getEntries().map((e) => e.entryName);
  expect(names).toContain('imsmanifest.xml');
  const manifest = zip.readAsText('imsmanifest.xml');
  expect(manifest).toContain('2004');
  expect(manifest).toContain('adlcp:scormType="sco"');   // note the 2004 capital T
  const rt = zip.readAsText('runtime.js');
  expect(rt).toMatch(/API_1484_11/);
  expect(rt).toMatch(/cmi\.completion_status/);
});

test('a course exports as a standalone Web page (no LMS, no manifest)', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: DESIGNER });
  const courseId = (await (await api.post('/api/admin/courses', { data: { title: 'Export Web', audience: 'referees' } })).json()).course.id;
  await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'text', title: 'Reading', html: '<p>Open me in any browser.</p>' } });

  const res = await api.get(`/api/admin/courses/${courseId}/export?format=web`);
  expect(res.ok()).toBeTruthy();
  const zip = new AdmZip(await res.body());
  const names = zip.getEntries().map((e) => e.entryName);
  expect(names).toContain('index.html');
  expect(names).toContain('runtime.js');
  expect(names).not.toContain('imsmanifest.xml');        // no LMS wrapper
  const rt = zip.readAsText('runtime.js');
  expect(rt).toMatch(/localStorage/);                    // progress kept in the browser
  expect(rt).not.toMatch(/LMSInitialize|API_1484_11/);   // no LMS calls at all
});

test('the exported Web page actually runs standalone (file://) and completes with no LMS', async ({ page, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: DESIGNER });
  const courseId = (await (await api.post('/api/admin/courses', { data: { title: 'Standalone Run', audience: 'referees' } })).json()).course.id;
  await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'text', title: 'Read', html: '<p>Learn this.</p>' } });
  await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'quiz', title: 'Check', passPercent: 50, questions: [{ prompt: 'Sky color?', options: ['Green', 'Blue'], answer: 1 }] } });

  const res = await api.get(`/api/admin/courses/${courseId}/export?format=web`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmrweb-'));
  new AdmZip(await res.body()).extractAllTo(dir, true);

  // Open the unzipped page directly from disk — no server, no LMS.
  await page.goto('file://' + path.join(dir, 'index.html'));
  await expect(page.locator('.lesson.active h2')).toHaveText('Read');
  await page.click('#next');                                   // → quiz section
  await expect(page.locator('.lesson.active h2')).toHaveText('Check');
  await page.check('input[name="q0"][value="1"]');             // correct answer
  await page.click('#next');                                   // Submit answers → grades
  await expect(page.locator('.quizresult')).toContainText('Passed');
  await page.click('#next');                                   // Finish
  await expect(page.locator('#next')).toHaveText('Completed ✓');
});

test('the Course Designer Export panel opens and downloads a package through the UI', async ({ page, context, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: DESIGNER });
  const courseId = (await (await api.post('/api/admin/courses', { data: { title: 'UI Export Course', audience: 'referees' } })).json()).course.id;
  await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'text', title: 'Reading', html: '<p>Hi.</p>' } });
  // Authenticate the browser by carrying the designer's session cookie into it.
  await context.addCookies((await api.storageState()).cookies);

  await page.goto('/#/admin/courses');
  const card = page.locator(`.course-admin[data-course="${courseId}"]`);
  await expect(card).toBeVisible();
  await card.locator('.publish-course').click();
  const panel = card.locator('.publish-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.pp-card')).toHaveCount(4); // SCORM 1.2, 2004, Web, Hosted link

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    panel.locator('.pp-export[data-format="web"]').click(),
  ]);
  expect(download.suggestedFilename()).toContain('web');
  await expect(panel.locator('.pp-status')).toContainText('downloaded');
});

test('the Build-with-AI panel renders the modern studio UI', async ({ page, context, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: DESIGNER });
  await context.addCookies((await api.storageState()).cookies);
  await page.goto('/#/admin/courses');
  await page.click('#aiBuildBtn');
  await expect(page.locator('.ai-studio .ai-hero h3')).toHaveText('Build a course with AI');
  await expect(page.locator('#aiBuildForm textarea[name="sourceText"]')).toBeVisible();
  await expect(page.locator('#aiBuildSubmit')).toBeVisible();
});

test('exporting a course with image slides bundles the images into the package', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: DESIGNER });
  const courseId = (await (await api.post('/api/admin/courses', { data: { title: 'Slides Export', audience: 'referees' } })).json()).course.id;
  // Reference a real public asset so the exporter can bundle it.
  await api.post(`/api/admin/courses/${courseId}/lessons`, { data: {
    type: 'slides', title: 'Deck', slideSeconds: 0,
    slides: [{ img: '/media/law-changes/slide-1.jpeg', alt: 'One' }],
  } });
  const res = await api.get(`/api/admin/courses/${courseId}/export/scorm`);
  expect(res.ok()).toBeTruthy();
  const zip = new AdmZip(await res.body());
  const names = zip.getEntries().map((e) => e.entryName);
  const asset = names.find((n) => n.startsWith('assets/'));
  expect(asset).toBeTruthy();                 // the slide image was bundled
  const index = zip.readAsText('index.html');
  expect(index).toContain(asset);             // and the player points at the bundled copy
});
