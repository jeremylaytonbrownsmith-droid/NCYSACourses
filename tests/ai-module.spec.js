// AI module generation: the Tent Talk vs full-lesson modes build the right
// prompt, and the model's reply flows through normalizeModuleDoc into a
// renderable getmatchready.module/v1 doc. Uses a mocked fetch — no real API call.
const { test, expect } = require('@playwright/test');

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-for-unit';
const { generateModuleDraft } = require('../lib/aicourse');
const { normalizeModuleDoc } = require('../lib/moduledoc');

// A fake Claude reply: captures the prompt, returns a canned module JSON.
function mockFetch(moduleDoc, capture) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (capture) capture.prompt = body.messages[0].content;
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(moduleDoc) }] }) };
  };
}

const TENT = {
  module: { title: 'Throw-in Basics', course: 'Tent Talk', estimatedMinutes: 5, objectives: ['Know the restart'] },
  pages: [
    { id: 'p0', title: 'Throw-in Basics', layout: 'cover', completionRequires: [], blocks: [
      { type: 'narration', durationSeconds: 20, transcript: 'Quick reset on throw-ins.' },
      { type: 'prose', body: ['Both feet, behind the line.'] },
      { type: 'gate', label: 'Start' } ] },
    { id: 'p1', title: 'Before you go', completionRequires: ['ack'], blocks: [
      { type: 'summary', heading: 'Recap', items: ['Feet down', 'Over the head'] },
      { type: 'checklist', id: 'ack', heading: 'Before you go — I will:', items: ['Check the feet', 'Watch the line'] } ] },
  ],
};

const FULL = {
  module: { title: 'Offside', course: 'Recert', estimatedMinutes: 20, passMarkPercent: 80, objectives: ['Judge offside'] },
  pages: [
    { id: 'p0', title: 'Offside', layout: 'cover', completionRequires: [], blocks: [{ type: 'prose', body: ['Intro'] }, { type: 'gate', label: 'Start' }] },
    { id: 'p1', title: 'The line', completionRequires: ['kc1'], blocks: [
      { type: 'knowledgeCheck', id: 'kc1', gateRevealBehindSubmit: true, prompt: 'Which line?', options: [{ id: 'a', text: 'Second last' }, { id: 'b', text: 'Last' }], correctOptionId: 'a', lesson: 'Second-last defender.' } ] },
    { id: 'p2', title: 'Done', completionRequires: ['final'], blocks: [
      { type: 'summary', heading: 'Recap', items: ['Second-last'] },
      { type: 'assessment', id: 'final', passMarkPercent: 80, items: [{ prompt: 'Line?', options: ['a', 'b'], correct: 0 }] } ] },
  ],
};

test('tent-talk mode asks for an info session and yields an assessment-free module', async () => {
  const cap = {};
  const raw = await generateModuleDraft({ topic: 'throw-ins', mode: 'tenttalk' }, mockFetch(TENT, cap));
  expect(cap.prompt).toContain('TENT TALK');
  expect(cap.prompt).toContain('INFORMATION SESSION');
  expect(cap.prompt).not.toMatch(/final.*assessment/i);
  const doc = normalizeModuleDoc(raw);
  expect(doc.pages.length).toBe(2);
  expect(doc.pages.some((p) => p.blocks.some((b) => b.type === 'assessment'))).toBe(false);
  // completion still means something: the last page gates on the acknowledgment
  expect(doc.pages[doc.pages.length - 1].completionRequires).toContain('ack');
});

test('full mode asks for knowledge checks + assessment and yields a graded module', async () => {
  const cap = {};
  const raw = await generateModuleDraft({ topic: 'offside', mode: 'full' }, mockFetch(FULL, cap));
  expect(cap.prompt).toContain('FULL interactive lesson');
  expect(cap.prompt).toContain('assessment');
  expect(cap.prompt).toContain('gateRevealBehindSubmit');
  const doc = normalizeModuleDoc(raw);
  const kc = doc.pages[1].blocks.find((b) => b.type === 'knowledgeCheck');
  expect(kc.gateRevealBehindSubmit).toBe(true);
  expect(doc.pages.some((p) => p.blocks.some((b) => b.type === 'assessment'))).toBe(true);
});

test('empty topic and source is rejected before any API call', async () => {
  let called = false;
  await expect(generateModuleDraft({ topic: '', sourceText: '' }, async () => { called = true; return { ok: true, json: async () => ({}) }; }))
    .rejects.toThrow(/topic or paste/i);
  expect(called).toBe(false);
});
