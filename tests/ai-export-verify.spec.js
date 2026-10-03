// End-to-end VERIFICATION that the new AI builder + exporter actually function —
// not just that files exist. The one thing we can't do here is reach the real
// Anthropic API (sandbox blocks egress), so we stand up a LOCAL mock that speaks
// the Messages API and point the real client at it (ANTHROPIC_BASE_URL). Every
// other link in the chain is real: the HTTP client, JSON/tool parsing,
// normalization, course creation, the learner experience, and SCORM reporting.
const { test, expect } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { generateCourseDraft } = require('../lib/aicourse');

const BASE = 'http://localhost:3100';
const DESIGNER = { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' };

// A canned Anthropic Messages response: one tool_use calling emit_course, shaped
// exactly like the real API returns.
function mockEmitCourse() {
  return {
    id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock',
    stop_reason: 'tool_use',
    content: [
      { type: 'tool_use', id: 'tu_1', name: 'emit_course', input: {
        title: 'Throw-In Fundamentals',
        tagline: 'Master the restart',
        description: 'A short course on the Law 15 throw-in.',
        lessons: [
          { title: 'The Basics', html: '<h3>Basics</h3><p>Two hands, over the head.</p><div class="callout">Both feet must stay on the ground.</div>' },
          { title: 'The 5-Second Rule', html: '<p>Take the throw within five seconds of being ready.</p><ul><li>Referee signals the count</li><li>Switch on excessive delay</li></ul>' },
        ],
        quiz: [
          { prompt: 'How many hands on the ball?', options: ['One', 'Two', 'Any'], answerIndex: 1 },
          { prompt: 'Time limit to take the throw?', options: ['3 seconds', '5 seconds', 'No limit'], answerIndex: 1 },
        ],
      } },
    ],
  };
}

// Start a throwaway HTTP server that answers like the Anthropic Messages API.
async function startMockAnthropic(onRequest) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { onRequest && onRequest(req, JSON.parse(body || '{}')); } catch (e) { /* ignore */ }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(mockEmitCourse()));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

test('AI generator: the REAL HTTP client calls the Messages API correctly and returns a valid draft', async () => {
  const seen = {};
  const mock = await startMockAnthropic((req, json) => { seen.headers = req.headers; seen.body = json; });
  const prevKey = process.env.ANTHROPIC_API_KEY, prevUrl = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_API_KEY = 'test-key-123';
  process.env.ANTHROPIC_BASE_URL = mock.url;
  try {
    // Uses the module's real fetch path (no injected client) — exercises prod code.
    const draft = await generateCourseDraft({ topic: 'Throw-ins', numLessons: 2, numQuestions: 2, passPercent: 80 });
    // The request the client actually sent is well-formed for the Anthropic API.
    expect(seen.headers['x-api-key']).toBe('test-key-123');
    expect(seen.headers['anthropic-version']).toBe('2023-06-01');
    expect(seen.body.model).toBeTruthy();
    expect(seen.body.tool_choice).toEqual({ type: 'tool', name: 'emit_course' });
    expect(Array.isArray(seen.body.tools)).toBe(true);
    // The parsed + normalized draft is valid for our course model.
    expect(draft.title).toBe('Throw-In Fundamentals');
    expect(draft.lessons.length).toBe(3); // 2 reading + 1 quiz
    expect(draft.lessons[2].type).toBe('quiz');
    expect(draft.lessons[2].questions.length).toBe(2);
    expect(draft.lessons[2].questions[0].answer).toBe(1);
  } finally {
    await mock.close();
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevUrl === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prevUrl;
  }
});

test('AI generator: a surfaced API error becomes a clean message (not a crash)', async () => {
  const server = http.createServer((req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'invalid x-api-key' } })); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const prevKey = process.env.ANTHROPIC_API_KEY, prevUrl = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_API_KEY = 'bad'; process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  try {
    await expect(generateCourseDraft({ topic: 'x' })).rejects.toThrow(/401|invalid x-api-key/i);
  } finally {
    await new Promise((r) => server.close(r));
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevUrl === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prevUrl;
  }
});

test('AI-built course becomes a real course a learner can take and complete', async ({ page, context, playwright }) => {
  // 1) Generate a draft via the real pipeline (mock model), exactly as the server does.
  const mock = await startMockAnthropic();
  const prevKey = process.env.ANTHROPIC_API_KEY, prevUrl = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_API_KEY = 'test-key'; process.env.ANTHROPIC_BASE_URL = mock.url;
  let draft;
  try { draft = await generateCourseDraft({ topic: 'Throw-ins', numLessons: 2, numQuestions: 2 }); }
  finally {
    await mock.close();
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevUrl === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prevUrl;
  }

  // 2) Create the course from that draft through the SAME admin API the endpoint uses.
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: DESIGNER });
  const courseId = (await (await api.post('/api/admin/courses', { data: { title: draft.title, audience: 'referees' } })).json()).course.id;
  for (const lesson of draft.lessons) {
    const r = await api.post(`/api/admin/courses/${courseId}/lessons`, { data: lesson });
    expect(r.ok()).toBeTruthy();
  }
  await api.post(`/api/admin/courses/${courseId}/publish`, { data: { published: true } });

  // 3) The reading + quiz the AI produced are really there.
  const course = (await (await api.get(`/api/admin/courses/${courseId}`)).json()).course;
  expect(course.lessons.length).toBe(3);
  const quiz = course.lessons.find((l) => l.type === 'quiz');
  expect(quiz.questions.length).toBe(2);

  // 4) A learner enrolls, works through it, passes the quiz, and completes.
  await page.goto('/#/register');
  await page.fill('#firstName', 'AiLearner'); await page.fill('#lastName', 'Test');
  await page.fill('#email', `ai.learner+${Date.now()}@example.com`);
  await page.click('button:has-text("Create account")');
  await page.request.post(`${BASE}/api/courses/${courseId}/enroll`);

  const reading = course.lessons.filter((l) => l.type === 'text');
  expect(reading.length).toBe(2);
  // Work through the reading lessons (each has a "Complete & continue" button).
  for (const l of reading) {
    await page.goto(`/#/course/${courseId}/lesson/${l.id}`);
    await page.click('#completeBtn');
    await expect(page.locator('.pill-done, #completeBtn')).toBeVisible(); // registered
  }
  // Then take the quiz and answer correctly (radios are named by question id).
  await page.goto(`/#/course/${courseId}/lesson/${quiz.id}`);
  for (const q of quiz.questions) {
    await page.check(`input[name="${q.id}"][value="${q.answer}"]`);
  }
  await page.click('button:has-text("Submit exam")');
  // Passing the final lesson with all others done completes the course → completion screen.
  await expect(page.locator('.complete-hero h1, .certificate')).toBeVisible({ timeout: 15000 });
});

// Load an exported package from disk with a recording mock LMS injected, step
// through it, and confirm it actually reports status + score to that LMS.
async function runScormAgainstMockLms(page, context, dir, apiKind) {
  const initScript = apiKind === '2004'
    ? `window.__lms={calls:[],data:{}}; window.API_1484_11={ Initialize:function(){window.__lms.calls.push(['init']);return 'true';}, SetValue:function(k,v){window.__lms.data[k]=v;window.__lms.calls.push(['set',k,v]);return 'true';}, GetValue:function(k){return window.__lms.data[k]||'';}, Commit:function(){return 'true';}, Terminate:function(){window.__lms.calls.push(['finish']);return 'true';}, GetLastError:function(){return '0';}, GetErrorString:function(){return '';}, GetDiagnostic:function(){return '';} };`
    : `window.__lms={calls:[],data:{}}; window.API={ LMSInitialize:function(){window.__lms.calls.push(['init']);return 'true';}, LMSSetValue:function(k,v){window.__lms.data[k]=v;window.__lms.calls.push(['set',k,v]);return 'true';}, LMSGetValue:function(k){return window.__lms.data[k]||'';}, LMSCommit:function(){return 'true';}, LMSFinish:function(){window.__lms.calls.push(['finish']);return 'true';}, LMSGetLastError:function(){return '0';}, LMSGetErrorString:function(){return '';}, LMSGetDiagnostic:function(){return '';} };`;
  await context.addInitScript(initScript);
  await page.goto('file://' + path.join(dir, 'index.html'));
  // Reading section → quiz → answer correct → Submit → Finish.
  await page.click('#next');                                   // to quiz
  await page.check('input[name="q0"][value="1"]');             // correct ('Blue')
  await page.click('#next');                                   // Submit answers
  await expect(page.locator('.quizresult')).toContainText('Passed');
  await page.click('#next');                                   // Finish
  await expect(page.locator('#next')).toHaveText('Completed ✓');
  return page.evaluate(() => window.__lms);
}

test('exported SCORM 1.2 actually reports passed + score to a mock LMS', async ({ page, context, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: DESIGNER });
  const courseId = (await (await api.post('/api/admin/courses', { data: { title: 'Report 12', audience: 'referees' } })).json()).course.id;
  await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'text', title: 'Read', html: '<p>Study.</p>' } });
  await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'quiz', title: 'Q', passPercent: 50, questions: [{ prompt: 'Sky?', options: ['Green', 'Blue'], answer: 1 }] } });
  const res = await api.get(`/api/admin/courses/${courseId}/export?format=scorm12`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorm12-'));
  new AdmZip(await res.body()).extractAllTo(dir, true);

  const lms = await runScormAgainstMockLms(page, context, dir, '12');
  expect(lms.data['cmi.core.lesson_status']).toBe('passed');
  expect(lms.data['cmi.core.score.raw']).toBe('100');
  expect(lms.calls.some((c) => c[0] === 'init')).toBe(true);
  expect(lms.calls.some((c) => c[0] === 'finish')).toBe(true);
});

test('exported SCORM 2004 actually reports completion + success + scaled score to a mock LMS', async ({ page, context, playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: DESIGNER });
  const courseId = (await (await api.post('/api/admin/courses', { data: { title: 'Report 2004', audience: 'referees' } })).json()).course.id;
  await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'text', title: 'Read', html: '<p>Study.</p>' } });
  await api.post(`/api/admin/courses/${courseId}/lessons`, { data: { type: 'quiz', title: 'Q', passPercent: 50, questions: [{ prompt: 'Sky?', options: ['Green', 'Blue'], answer: 1 }] } });
  const res = await api.get(`/api/admin/courses/${courseId}/export?format=scorm2004`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorm2004-'));
  new AdmZip(await res.body()).extractAllTo(dir, true);

  const lms = await runScormAgainstMockLms(page, context, dir, '2004');
  expect(lms.data['cmi.completion_status']).toBe('completed');
  expect(lms.data['cmi.success_status']).toBe('passed');
  expect(lms.data['cmi.score.scaled']).toBe('1');
  expect(lms.calls.some((c) => c[0] === 'finish')).toBe(true);
});
