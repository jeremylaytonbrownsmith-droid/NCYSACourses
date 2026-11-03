// Interactive block module (getmatchready.module/v1): the normalizer's rules,
// then the full lifecycle — an admin creates a module lesson from authored JSON,
// a learner enrolls and completes it, and a doc with no usable pages is rejected.
const { test, expect } = require('@playwright/test');
const { normalizeModuleDoc, BLOCK_TYPES } = require('../lib/moduledoc');

const BASE = 'http://localhost:3100';
const ADMIN = { email: 'admin@ncysa.org', password: 'ncysa-staff-2026' };

// A small but real module: a cover gate, a gated knowledge check, and a 1-item
// assessment. Nested v1 shape (module{} + pages).
function sampleDoc() {
  return {
    version: 'getmatchready.module/v1',
    module: { title: 'Mini Module', course: 'Test', estimatedMinutes: 5, passMarkPercent: 80, objectives: ['Know a thing'] },
    pages: [
      { id: 'p0', title: 'Start', layout: 'cover', completionRequires: [], blocks: [
        { type: 'narration', durationSeconds: 10, transcript: 'Welcome.' },
        { type: 'prose', body: ['Intro line.'] },
        { type: 'gate', label: 'Start module' },
      ] },
      { id: 'p1', title: 'Check', completionRequires: ['kc1'], blocks: [
        { type: 'knowledgeCheck', id: 'kc1', gateRevealBehindSubmit: true, prompt: 'Pick A', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correctOptionId: 'a', lesson: 'A is right.' },
      ] },
      { id: 'p2', title: 'Done', completionRequires: ['as1'], blocks: [
        { type: 'summary', heading: 'Recap', items: ['A is right'] },
        { type: 'assessment', id: 'as1', passMarkPercent: 80, items: [{ prompt: 'A?', options: ['A', 'B'], correct: 0 }] },
      ] },
    ],
  };
}

test('normalizeModuleDoc keeps known blocks, drops unknown, and filters requires', () => {
  const d = normalizeModuleDoc(sampleDoc());
  expect(d.title).toBe('Mini Module');
  expect(d.pages).toHaveLength(3);
  // gateRevealBehindSubmit defaults on and is preserved
  const kc = d.pages[1].blocks.find((b) => b.type === 'knowledgeCheck');
  expect(kc.gateRevealBehindSubmit).toBe(true);
  expect(kc.correctOptionId).toBe('a');

  // unknown block types are dropped; a page left with no blocks is dropped
  const withJunk = normalizeModuleDoc({ pages: [
    { title: 'A', blocks: [{ type: 'prose', body: ['x'] }, { type: 'bogus', foo: 1 }] },
    { title: 'Empty', blocks: [{ type: 'nope' }] },
  ] });
  expect(withJunk.pages).toHaveLength(1);
  expect(withJunk.pages[0].blocks).toHaveLength(1);

  // completionRequires that name a non-existent / non-interactive block are stripped
  const req = normalizeModuleDoc({ pages: [
    { title: 'A', completionRequires: ['ghost', 'real'], blocks: [{ type: 'reflection', id: 'real', prompt: 'p' }] },
  ] });
  expect(req.pages[0].completionRequires).toEqual(['real']);

  // garbage → zero pages (callers reject these)
  expect(normalizeModuleDoc('nonsense').pages).toHaveLength(0);
  expect(normalizeModuleDoc(null).pages).toHaveLength(0);
  expect(normalizeModuleDoc({ pages: [] }).pages).toHaveLength(0);

  // every documented block type is renderable
  expect(BLOCK_TYPES).toContain('branching');
  expect(BLOCK_TYPES).toContain('videoDecision');
});

test('admin creates a module lesson, learner enrolls and completes it', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  const stamp = Date.now();

  const course = (await (await api.post('/api/admin/courses', { data: { title: `Module course ${stamp}`, audience: 'coaches' } })).json()).course;
  const made = await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'module', title: 'The Module', moduleDoc: sampleDoc() } });
  expect(made.ok()).toBeTruthy();
  const lesson = (await made.json()).lesson;
  expect(lesson.type).toBe('module');
  expect(lesson.moduleDoc.pages).toHaveLength(3);
  await api.post(`/api/admin/courses/${course.id}/publish`, { data: { published: true } });

  const learner = await playwright.request.newContext({ baseURL: BASE });
  await learner.post('/api/register', { data: { firstName: 'Mod', lastName: 'Learner', email: `mod+${stamp}@example.com` } });
  await learner.post(`/api/courses/${course.id}/enroll`);

  // The learner (client-gated, like our slideshow modules) reports completion.
  const done = await learner.post(`/api/courses/${course.id}/lessons/${lesson.id}/complete`);
  expect(done.ok()).toBeTruthy();
  const body = await done.json();
  expect(body.ok).toBe(true);
  // single-lesson course → finishing the module completes the course
  expect(body.courseCompleted).toBe(true);
});

test('a module with no usable pages is rejected', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  expect((await api.post('/api/login', { data: ADMIN })).ok()).toBeTruthy();
  const course = (await (await api.post('/api/admin/courses', { data: { title: `Bad module ${Date.now()}`, audience: 'coaches' } })).json()).course;
  const res = await api.post(`/api/admin/courses/${course.id}/lessons`, { data: { type: 'module', title: 'Empty', moduleDoc: { pages: [{ title: 'x', blocks: [{ type: 'unknownBlock' }] }] } } });
  expect(res.status()).toBe(400);
});
