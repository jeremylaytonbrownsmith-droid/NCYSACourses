// getmatchready.module/v1 — the block-based interactive module format.
//
// A module is authored as a JSON document (pasted in the Course Designer, or
// emitted by the AI course builder) and rendered by a generic block player
// (renderModuleLesson in public/app.js). This file is the server-side gatekeeper:
// normalizeModuleDoc takes whatever was submitted and returns a clean, size-capped
// document with only known block types and known fields, every text value coerced
// to a plain string. The player escapes every string at render time, so nothing
// here is treated as HTML — this normalizer is about structure and limits, not
// sanitizing markup.
//
// It accepts either the canonical nested shape ({ version, module:{…}, pages:[…] })
// or a flat shape ({ title, course, pages:[…] }) and always returns the flat
// internal shape the player reads:
//   { version, title, course, estimatedMinutes, passMarkPercent, objectives:[], pages:[] }

'use strict';

const CAP = {
  pages: 60,
  blocksPerPage: 50,
  str: 6000,
  shortStr: 400,
  arr: 60,
  options: 10,
  tableCols: 8,
  tableRows: 60,
  objectives: 20,
};

const VERSION = 'getmatchready.module/v1';

function s(v, max) {
  if (v == null) return '';
  let str = typeof v === 'string' ? v : String(v);
  const lim = max || CAP.str;
  if (str.length > lim) str = str.slice(0, lim);
  return str;
}
function sArr(v, maxItems, maxLen) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, maxItems || CAP.arr).map((x) => s(x, maxLen || CAP.str)).filter((x) => x !== '');
}
function bool(v) { return v === true || v === 'true' || v === 1; }
function int(v, min, max, dflt) {
  let n = Math.round(Number(v));
  if (!Number.isFinite(n)) n = dflt == null ? 0 : dflt;
  if (min != null) n = Math.max(min, n);
  if (max != null) n = Math.min(max, n);
  return n;
}
// A safe id/slug used to tie completionRequires to a block.
function id(v) {
  const str = s(v, 80).toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return str || null;
}

// Each block type knows how to clean itself. Unknown types are dropped.
const BLOCKS = {
  narration: (b) => ({ type: 'narration', durationSeconds: int(b.durationSeconds, 0, 3600, 0), transcript: s(b.transcript) }),
  prose: (b) => ({ type: 'prose', emphasis: bool(b.emphasis), lead: bool(b.lead), body: sArr(b.body, CAP.arr) }),
  list: (b) => ({ type: 'list', ordered: bool(b.ordered), heading: s(b.heading, CAP.shortStr), items: sArr(b.items, CAP.arr) }),
  callout: (b) => ({ type: 'callout', heading: s(b.heading, CAP.shortStr), body: sArr(b.body, CAP.arr) }),
  table: (b) => ({
    type: 'table', title: s(b.title, CAP.shortStr),
    columns: sArr(b.columns, CAP.tableCols, CAP.shortStr),
    rows: (Array.isArray(b.rows) ? b.rows : []).slice(0, CAP.tableRows).map((r) => sArr(r, CAP.tableCols, CAP.str)),
  }),
  compare: (b) => ({
    type: 'compare', id: id(b.id), title: s(b.title, CAP.shortStr),
    cards: (Array.isArray(b.cards) ? b.cards : []).slice(0, CAP.arr).map((c) => ({ title: s(c.title, CAP.shortStr), sanction: s(c.sanction, CAP.shortStr), body: s(c.body) })),
  }),
  carousel: (b) => ({
    type: 'carousel', id: id(b.id), title: s(b.title, CAP.shortStr),
    slides: (Array.isArray(b.slides) ? b.slides : []).slice(0, CAP.arr).map((sl) => ({ title: s(sl.title, CAP.shortStr), imageBrief: s(sl.imageBrief, CAP.shortStr), body: s(sl.body) })),
  }),
  accordion: (b) => ({
    type: 'accordion', id: id(b.id), title: s(b.title, CAP.shortStr),
    items: (Array.isArray(b.items) ? b.items : []).slice(0, CAP.arr).map((it) => ({
      label: s(it.label, CAP.shortStr), heading: s(it.heading, CAP.shortStr), intro: s(it.intro), body: s(it.body), bullets: sArr(it.bullets, CAP.arr),
    })),
  }),
  scenario: (b) => ({ type: 'scenario', id: id(b.id), imageBrief: s(b.imageBrief, CAP.shortStr), lines: sArr(b.lines, CAP.arr) }),
  reflection: (b) => ({ type: 'reflection', id: id(b.id), prompt: s(b.prompt), followUp: s(b.followUp) }),
  checklist: (b) => ({ type: 'checklist', id: id(b.id), items: sArr(b.items, CAP.arr) }),
  knowledgeCheck: (b) => ({
    type: 'knowledgeCheck', id: id(b.id), gateRevealBehindSubmit: b.gateRevealBehindSubmit === false ? false : true,
    prompt: s(b.prompt), options: cleanOpts(b.options), correctOptionId: id(b.correctOptionId),
    correctFeedback: s(b.correctFeedback, CAP.shortStr), incorrectFeedback: s(b.incorrectFeedback, CAP.shortStr),
    lessonHeading: s(b.lessonHeading, CAP.shortStr), lesson: s(b.lesson),
  }),
  videoDecision: (b) => ({
    type: 'videoDecision', id: id(b.id), clipBrief: s(b.clipBrief), prompt: s(b.prompt),
    options: cleanOpts(b.options), correctOptionId: id(b.correctOptionId),
    correctFeedback: s(b.correctFeedback, CAP.shortStr), incorrectFeedback: s(b.incorrectFeedback, CAP.shortStr), lesson: s(b.lesson),
  }),
  imageSelect: (b) => ({
    type: 'imageSelect', id: id(b.id), prompt: s(b.prompt),
    options: (Array.isArray(b.options) ? b.options : []).slice(0, CAP.options).map((o, i) => ({
      id: id(o.id) || 'o' + (i + 1), imageBrief: s(o.imageBrief, CAP.shortStr), optionFallbackText: s(o.optionFallbackText || o.imageBrief, CAP.shortStr),
      correct: bool(o.correct), feedback: s(o.feedback),
    })),
  }),
  flow: (b) => ({
    type: 'flow', id: id(b.id),
    nodes: (Array.isArray(b.nodes) ? b.nodes : []).slice(0, CAP.arr).map((n) => ({
      kind: ['start', 'decision', 'outcome', 'end'].includes(n.kind) ? n.kind : 'outcome', text: s(n.text),
      branches: (Array.isArray(n.branches) ? n.branches : []).slice(0, CAP.options).map((br) => ({ answer: s(br.answer, CAP.shortStr), to: s(br.to) })),
      exceptions: sArr(n.exceptions, CAP.arr),
    })),
  }),
  branching: (b) => ({
    type: 'branching', id: id(b.id), setup: sArr(b.setup, CAP.arr),
    decisions: (Array.isArray(b.decisions) ? b.decisions : []).slice(0, CAP.arr).map((d) => ({
      prompt: s(d.prompt),
      options: (Array.isArray(d.options) ? d.options : []).slice(0, CAP.options).map((o, i) => ({ id: id(o.id) || 'o' + (i + 1), text: s(o.text), correct: bool(o.correct), feedback: s(o.feedback) })),
    })),
    close: sArr(b.close, CAP.arr),
  }),
  summary: (b) => ({ type: 'summary', heading: s(b.heading, CAP.shortStr), intro: s(b.intro), items: sArr(b.items, CAP.arr) }),
  assessment: (b) => ({
    type: 'assessment', id: id(b.id), passMarkPercent: int(b.passMarkPercent, 0, 100, 80),
    items: (Array.isArray(b.items) ? b.items : []).slice(0, CAP.arr).map((it) => ({
      prompt: s(it.prompt), options: sArr(it.options, CAP.options, CAP.shortStr), correct: int(it.correct, 0, CAP.options - 1, 0),
    })).filter((it) => it.prompt && it.options.length >= 2),
  }),
  gate: (b) => ({ type: 'gate', label: s(b.label, CAP.shortStr) || 'Start' }),
};

function cleanOpts(arr) {
  return (Array.isArray(arr) ? arr : []).slice(0, CAP.options).map((o, i) => ({ id: id(o.id) || 'o' + (i + 1), text: s(o.text) })).filter((o) => o.text);
}

// Which block types count as "interactive" (can appear in completionRequires).
const INTERACTIVE = new Set(['carousel', 'accordion', 'reflection', 'checklist', 'knowledgeCheck', 'videoDecision', 'imageSelect', 'branching', 'assessment']);

function normalizeBlock(raw) {
  if (!raw || typeof raw !== 'object' || !BLOCKS[raw.type]) return null;
  const out = BLOCKS[raw.type](raw);
  return out;
}

function normalizePage(raw, pi) {
  if (!raw || typeof raw !== 'object') return null;
  const blocks = (Array.isArray(raw.blocks) ? raw.blocks : []).slice(0, CAP.blocksPerPage).map(normalizeBlock).filter(Boolean);
  if (!blocks.length) return null;
  // Only keep required ids that (a) belong to a real interactive block on this page.
  const haveIds = new Set(blocks.filter((b) => b.id && INTERACTIVE.has(b.type)).map((b) => b.id));
  const req = (Array.isArray(raw.completionRequires) ? raw.completionRequires : []).map(id).filter((x) => x && haveIds.has(x));
  return {
    id: id(raw.id) || 'p' + pi,
    title: s(raw.title, CAP.shortStr),
    layout: raw.layout === 'cover' ? 'cover' : 'standard',
    completionRequires: [...new Set(req)],
    blocks,
  };
}

// Accepts the nested v1 shape or a flat shape; always returns the flat internal
// form the player consumes. Returns a doc with pages:[] (never throws); callers
// reject a doc whose pages array is empty.
function normalizeModuleDoc(raw) {
  let doc = raw;
  if (typeof raw === 'string') { try { doc = JSON.parse(raw); } catch (e) { return { version: VERSION, title: '', course: '', estimatedMinutes: 0, passMarkPercent: 80, objectives: [], pages: [] }; } }
  if (!doc || typeof doc !== 'object') doc = {};
  const meta = (doc.module && typeof doc.module === 'object') ? doc.module : doc;
  const pagesRaw = Array.isArray(doc.pages) ? doc.pages : (Array.isArray(meta.pages) ? meta.pages : []);
  const pages = pagesRaw.slice(0, CAP.pages).map(normalizePage).filter(Boolean);
  return {
    version: VERSION,
    title: s(meta.title, CAP.shortStr),
    course: s(meta.course, CAP.shortStr),
    estimatedMinutes: int(meta.estimatedMinutes, 0, 1000, 0),
    passMarkPercent: int(meta.passMarkPercent, 0, 100, 80),
    objectives: sArr(meta.objectives, CAP.objectives),
    pages,
  };
}

module.exports = { normalizeModuleDoc, VERSION, BLOCK_TYPES: Object.keys(BLOCKS), INTERACTIVE_TYPES: [...INTERACTIVE] };
