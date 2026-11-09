#!/usr/bin/env node
/**
 * check-modules — a reusable "final pass" for interactive course modules.
 *
 * Validates every public/samples/*.module.json against normalizeModuleDoc and
 * the house standard (the gotchas in CLAUDE.md), so a course can't ship with a
 * page that never completes, an empty exam, a malformed branching/flow block,
 * etc. ERRORS fail the check (exit 1); WARNINGS are advisory (exit 0).
 *
 *   node scripts/check-modules.js            # check all sample modules
 *   node scripts/check-modules.js path.json  # check specific file(s)
 *
 * Run it before deploying a course edit, or wire it into CI.
 */
const fs = require('fs');
const path = require('path');
const { normalizeModuleDoc, enforceInfoSession } = require('../lib/moduledoc');

const INTERACTIVE = new Set(['carousel', 'accordion', 'flashcards', 'tabs', 'reflection', 'checklist', 'knowledgeCheck', 'videoDecision', 'imageSelect', 'branching', 'assessment', 'scenario', 'gate']);
const VISUAL = new Set([...INTERACTIVE, 'image', 'table', 'compare', 'flow', 'callout']);

function auditDoc(rawDoc) {
  const errors = [];
  const warnings = [];
  const hasAssessment = (rawDoc.pages || []).some((p) => (p.blocks || []).some((b) => b.type === 'assessment'));
  const tent = !hasAssessment;
  let doc = normalizeModuleDoc(rawDoc);
  if (tent) doc = enforceInfoSession(doc);

  if (!doc.pages.length) { errors.push('module has no pages after normalize (unknown block types/fields may have been dropped)'); return { errors, warnings, tent, pages: 0 }; }

  doc.pages.forEach((p, i) => {
    const where = p.id || `page ${i + 1}`;
    if (!p.title) warnings.push(`${where}: missing a title`);
    const ids = new Set((p.blocks || []).filter((b) => b.id).map((b) => b.id));
    // ERROR: a completionRequires id with no matching block → page can never complete.
    (p.completionRequires || []).forEach((id) => { if (!ids.has(id)) errors.push(`${where}: completionRequires "${id}" has no matching block on this page (page can never complete → no certificate)`); });

    (p.blocks || []).forEach((b) => {
      if (b.type === 'assessment') {
        const ok = Array.isArray(b.items) && b.items.length && b.items.every((it) => it.prompt && Array.isArray(it.options) && it.options.length >= 2 && Number.isInteger(it.correct) && it.correct >= 0 && it.correct < it.options.length);
        if (!ok) errors.push(`${where}: assessment has no real items (needs prompt/options/correct index) → empty exam, no certificate`);
      }
      if (b.type === 'branching') {
        const strArr = (a) => a == null || (Array.isArray(a) && a.every((s) => typeof s === 'string'));
        if (!strArr(b.setup)) errors.push(`${where}: branching.setup must be a string array`);
        if (!strArr(b.close)) errors.push(`${where}: branching.close must be a string array`);
      }
      if (b.type === 'flow') {
        const nodes = b.nodes || [];
        const kinds = nodes.map((n) => n.kind);
        if (!kinds.includes('start')) warnings.push(`${where}: flow has no "start" node (standard: one start → decisions/outcomes → one end)`);
        if (!kinds.includes('end')) warnings.push(`${where}: flow has no "end" node`);
        if (nodes.length < 4 || nodes.length > 7) warnings.push(`${where}: flow has ${nodes.length} nodes (standard: 4–7 so it stays readable)`);
        nodes.filter((n) => n.kind === 'decision').forEach((n, di) => {
          if (!Array.isArray(n.branches) || n.branches.length !== 2) warnings.push(`${where}: flow decision ${di + 1} should have exactly 2 branches (standard)`);
        });
      }
    });

    // Advisory: a standard content page should carry an interactive/visual block.
    if (p.layout !== 'cover' && i !== doc.pages.length - 1) {
      const hasVisual = (p.blocks || []).some((b) => VISUAL.has(b.type) || b.graphic || b.imageUrl);
      if (!hasVisual) warnings.push(`${where}: a content page with no interactive/visual block (house standard: most content pages carry one)`);
    }
  });

  // Cover page.
  const cover = doc.pages[0];
  if (!cover || cover.layout !== 'cover') warnings.push('first page should have "layout":"cover"');
  else if (!(cover.blocks || []).some((b) => b.type === 'gate')) warnings.push('cover page should end with a {"type":"gate"} start button');

  // Tent Talk: ends with an ack checklist.
  if (tent) {
    const last = doc.pages[doc.pages.length - 1];
    const hasAck = (last.blocks || []).some((b) => b.type === 'checklist' && b.id === 'ack');
    if (!hasAck) warnings.push('Tent Talk: the last page should end with a {"type":"checklist","id":"ack",...} and completionRequires ["ack"]');
  }

  return { errors, warnings, tent, pages: doc.pages.length };
}

function main() {
  const args = process.argv.slice(2);
  let files = args.length ? args : null;
  if (!files) {
    const dir = path.join(__dirname, '..', 'public', 'samples');
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.module.json')).map((f) => path.join(dir, f));
  }
  let anyError = false;
  console.log(`Checking ${files.length} module${files.length === 1 ? '' : 's'}…\n`);
  for (const file of files) {
    const name = path.basename(file);
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { console.log(`✗ ${name}\n   ERROR: invalid JSON — ${e.message}\n`); anyError = true; continue; }
    const { errors, warnings, tent, pages } = auditDoc(raw);
    const tag = tent ? 'Tent Talk' : 'Full lesson';
    if (errors.length) anyError = true;
    const mark = errors.length ? '✗' : '✓';
    console.log(`${mark} ${name}  (${tag}, ${pages} pages)`);
    errors.forEach((e) => console.log(`   ERROR:   ${e}`));
    warnings.forEach((w) => console.log(`   warning: ${w}`));
    if (!errors.length && !warnings.length) console.log('   clean — no issues');
    console.log('');
  }
  if (anyError) { console.log('FAILED — fix the ERRORS above before shipping.'); process.exit(1); }
  console.log('PASSED — no blocking issues.');
}

main();
