// AI course generator. Turns a topic (and/or pasted source material) into a
// draft course in OUR lesson model — reading lessons + a graded quiz — exactly
// the shape the Course Designer and the SCORM exporter already understand. The
// draft is created UNPUBLISHED so a human reviews/edits before it goes live.
//
// Design notes:
//   * One server-side API key (ANTHROPIC_API_KEY) covers every user; learners
//     and designers never see or manage a key. Model is overridable via
//     AI_COURSE_MODEL so it can be tuned without a code change.
//   * We force a tool call ("emit_course") so the model returns STRUCTURED JSON
//     against our schema instead of prose we'd have to parse out of markdown.
//   * normalizeDraft() is pure (no network) and is what sanitizes the model's
//     output into safe, valid lessons — so it's unit-testable on its own.
//
// We only generate the content types AI is reliable at today: reading sections
// (rich but simple HTML) and multiple-choice quiz questions. Images and video
// are deliberately left out of generation (a designer adds those after) — see
// the product notes; this keeps v1 solid instead of flaky.

// Base URL is overridable (ANTHROPIC_BASE_URL) for an enterprise proxy/gateway or
// for integration testing against a local mock; defaults to Anthropic's API.
// Resolved per-call so the env can be set after module load.
function anthropicUrl() { return (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '') + '/v1/messages'; }
const ANTHROPIC_VERSION = '2023-06-01';

function aiApiKey() { return process.env.ANTHROPIC_API_KEY || ''; }
function aiEnabled() { return !!aiApiKey(); }
function aiModel() { return process.env.AI_COURSE_MODEL || 'claude-sonnet-5-5'; }

// The structured shape we ask the model to emit. Kept intentionally small: a
// handful of reading lessons, each simple HTML, plus one quiz.
const COURSE_TOOL = {
  name: 'emit_course',
  description: 'Return the finished course as structured data.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A concise course title.' },
      tagline: { type: 'string', description: 'One short sentence shown under the title.' },
      description: { type: 'string', description: 'A 1-2 sentence summary of the course.' },
      lessons: {
        type: 'array',
        description: 'The reading lessons, in order. Each teaches one part of the material.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            html: {
              type: 'string',
              description: 'Lesson body as HTML using ONLY this block kit: <p class="lead"> opening hook; <h3>/<h4> headings; <p>, <ul>/<ol>/<li>, <strong>/<em>; <figure class="ph"><figcaption>Describe the photo that belongs here</figcaption></figure> for a captioned image placeholder the author fills in; <details><summary>Label</summary>…</details> for a tap-to-expand accordion item; <div class="scenario"><h4>…</h4><p>…</p></div> for a story/scenario card; <div class="keypoints"><ul><li>…</li></ul></div> for a key-points panel; <div class="callout"> for the single most important takeaway; <blockquote class="pullquote"> for a short emphatic line. No scripts, styles, <img>, <a>, iframes, or inputs.',
            },
          },
          required: ['title', 'html'],
        },
      },
      quiz: {
        type: 'array',
        description: 'Multiple-choice questions that check the material. Each has exactly one correct option.',
        items: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            options: { type: 'array', items: { type: 'string' }, description: '3-4 answer choices.' },
            answerIndex: { type: 'integer', description: 'Zero-based index of the correct option.' },
          },
          required: ['prompt', 'options', 'answerIndex'],
        },
      },
    },
    required: ['title', 'lessons', 'quiz'],
  },
};

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

// Strip the model's HTML down to the small, safe tag set we document in the
// schema. Anything else (script/style/iframe/on* handlers) is removed — the
// output is rendered in the Course Designer and the exported package, so it must
// never carry active content. This is a allow-list, not a blocklist.
// The "block kit" the AI may use. Richer than plain reading HTML so a generated
// lesson can look like a built module — accordions (<details>, no scripts),
// captioned photo placeholders the author fills in, scenario cards and key-point
// panels — while staying a strict allow-list that never carries active content.
const ALLOWED_TAGS = new Set([
  'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'br',
  'div', 'span', 'section', 'details', 'summary', 'figure', 'figcaption', 'blockquote',
]);
// Only these class names survive (on any allowed tag). Keeps styling to our own
// block components and blocks arbitrary/injected classes.
const ALLOWED_CLASSES = new Set(['callout', 'keypoints', 'scenario', 'lead', 'ph', 'note', 'tip', 'pullquote', 'kicker']);
function sanitizeHtml(html) {
  let s = String(html || '');
  // Drop whole dangerous elements (with their contents), then any void/opening
  // forms of them plus images and links (the AI never supplies real media/URLs —
  // images belong in captioned placeholders the author fills).
  s = s.replace(/<(script|style|iframe|object|embed|link|meta)\b[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<(script|style|iframe|object|embed|link|meta|img|a|input|button|form)\b[^>]*\/?>/gi, '');
  // Walk every remaining tag; keep only allow-listed ones, and only a `class`
  // attribute whose values are in the component allow-list. Everything else goes.
  s = s.replace(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g, (m, close, tag, attrs) => {
    const t = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(t)) return '';
    if (close) return `</${t}>`;
    const clsM = /class\s*=\s*"(.*?)"/i.exec(attrs);
    if (clsM) {
      const keep = clsM[1].split(/\s+/).filter((c) => ALLOWED_CLASSES.has(c));
      if (keep.length) return `<${t} class="${keep.join(' ')}">`;
    }
    return `<${t}>`;
  });
  // Remove any stray event-handler attributes that slipped through on text.
  s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  return s.trim();
}

// Turn the model's raw tool input into a safe, valid course draft in OUR model:
// reading lessons (type 'text') followed by a single quiz lesson. Pure function.
function normalizeDraft(raw, opts = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const passPercent = clampInt(opts.passPercent, 0, 100, 80);
  const maxLessons = clampInt(opts.maxLessons, 1, 20, 12);
  // Optional reading pace applied to every generated reading lesson.
  const lessonMinSeconds = clampInt(opts.lessonMinSeconds, 0, 3600, 0);

  const lessons = (Array.isArray(r.lessons) ? r.lessons : [])
    .slice(0, maxLessons)
    .map((l) => ({ type: 'text', title: String((l && l.title) || 'Lesson').slice(0, 160), html: sanitizeHtml(l && l.html), minSeconds: lessonMinSeconds }))
    .filter((l) => l.html);

  // Video lessons: the author pastes real YouTube/Vimeo links; the AI supplies a
  // title + short "what to watch for" intro for each (in order). We never let the
  // AI invent the link itself — only wrap the human-provided URL.
  const videoUrls = (Array.isArray(opts.videoUrls) ? opts.videoUrls : [])
    .map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u)).slice(0, 10);
  const videoMeta = Array.isArray(r.videos) ? r.videos : [];
  videoUrls.forEach((url, i) => {
    const m = videoMeta[i] || {};
    lessons.push({
      type: 'video',
      title: String(m.title || 'Video lesson').slice(0, 160),
      html: sanitizeHtml(m.intro || '<p>Watch the video, then continue.</p>'),
      videoUrl: url,
    });
  });

  const questions = (Array.isArray(r.quiz) ? r.quiz : [])
    .map((q) => {
      const options = (Array.isArray(q && q.options) ? q.options : []).map((o) => String(o).slice(0, 300)).filter(Boolean).slice(0, 6);
      let answer = clampInt(q && q.answerIndex, 0, Math.max(0, options.length - 1), 0);
      return { prompt: String((q && q.prompt) || '').slice(0, 500), options, answer };
    })
    .filter((q) => q.prompt && q.options.length >= 2);

  if (questions.length) {
    lessons.push({
      type: 'quiz',
      title: 'Quiz',
      html: `<p>Answer the questions below. You need ${passPercent}% to pass.</p>`,
      passPercent,
      questions,
    });
  }

  return {
    title: String(r.title || opts.title || 'Untitled course').slice(0, 160),
    tagline: String(r.tagline || '').slice(0, 300),
    description: String(r.description || '').slice(0, 1000),
    lessons,
  };
}

function buildUserPrompt({ topic, sourceText, numLessons, numQuestions, audience, videoUrls }) {
  const vids = (Array.isArray(videoUrls) ? videoUrls : []).filter(Boolean);
  const parts = [];
  parts.push(`Build a short, practical e-learning course${audience ? ` for ${audience}` : ''}.`);
  if (topic) parts.push(`Topic: ${topic}`);
  parts.push(`Create about ${numLessons} lesson(s) and exactly ${numQuestions} multiple-choice quiz question(s).`);
  parts.push('Write like a produced e-learning module, not a textbook. For EACH lesson, build the body from this block kit so it reads like an interactive course:');
  parts.push([
    '- Open with a short narrative or real-world scenario using <p class="lead"> (a hook — put the learner on the field).',
    '- Add a captioned photo placeholder where a real image belongs: <figure class="ph"><figcaption>a specific description of the photo to add</figcaption></figure>. Use 1-2 per lesson.',
    '- Layer detail with tap-to-expand accordions: <details><summary>Short label</summary><p>…</p></details>. Great for step models, "learn more", or do/don\'t.',
    '- Use <div class="scenario"><h4>Title</h4><p>…</p></div> to pose a situation, and <div class="keypoints"><ul><li>…</li></ul></div> to summarize what to remember.',
    '- End the lesson with <div class="callout"> holding the single most important takeaway.',
    'Keep paragraphs short and concrete, use <strong> for key terms, and write in a confident, practical voice for the audience. Every photo caption must describe a specific, realistic image.',
  ].join('\n'));
  parts.push('Quiz questions must be answerable from the lessons, with one clearly correct option and plausible distractors.');
  if (vids.length) {
    parts.push(`\nThe course also includes ${vids.length} video(s) the author is providing (in this order):`);
    vids.forEach((u, i) => parts.push(`  ${i + 1}. ${u}`));
    parts.push('For EACH video, add an entry to a top-level "videos" array (same order) with a short "title" and an "intro" (1-2 sentences of HTML telling the learner exactly what to watch for). Do NOT include or invent the video URL — only the title and intro. Make at least one quiz question answerable from the video(s).');
  }
  if (sourceText && sourceText.trim()) {
    parts.push('\nBase the course ONLY on the following source material; do not invent facts beyond it:\n"""\n' + sourceText.trim().slice(0, 100000) + '\n"""');
  }
  parts.push('\nReturn ONLY a single JSON object (no markdown fences, no commentary) with exactly this shape:');
  parts.push(`{
  "title": "string",
  "tagline": "string (optional, one short sentence)",
  "description": "string (optional, 1-2 sentences)",
  "lessons": [ { "title": "string", "html": "lesson body using the block kit: <p class=\\"lead\\">, h3/h4, p, ul/ol/li, strong/em, <figure class=\\"ph\\"><figcaption>photo to add</figcaption></figure>, <details><summary>…</summary>…</details>, <div class=\\"scenario\\">, <div class=\\"keypoints\\">, <div class=\\"callout\\">, <blockquote class=\\"pullquote\\">. No scripts, styles, <img>, <a>, iframes, inputs." } ],${vids.length ? '\n  "videos": [ { "title": "string", "intro": "1-2 sentence HTML, what to watch for" } ],' : ''}
  "quiz": [ { "prompt": "string", "options": ["3-4 choices"], "answerIndex": 0 } ]
}`);
  return parts.join('\n');
}

// Pull a JSON object out of a model's text reply: tolerate ```json fences and any
// stray prose by taking the outermost { ... } and parsing it.
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < 0 || end < start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}

// Call the Anthropic Messages API and return a normalized draft. Throws an Error
// with a human-friendly message on any failure (no key, HTTP error, bad output).
// `fetchImpl` is injectable for tests; defaults to global fetch.
async function generateCourseDraft(opts = {}, fetchImpl = (typeof fetch !== 'undefined' ? fetch : null)) {
  if (!aiEnabled()) throw new Error('AI course generation is not configured. Set ANTHROPIC_API_KEY in the environment, then redeploy.');
  if (!fetchImpl) throw new Error('No HTTP client available to reach the AI service.');
  const topic = String(opts.topic || '').trim();
  const sourceText = String(opts.sourceText || '').trim();
  if (!topic && !sourceText) throw new Error('Enter a topic or paste some source material to build from.');

  const numLessons = clampInt(opts.numLessons, 1, 20, 4);
  const numQuestions = clampInt(opts.numQuestions, 1, 25, 5);
  const audience = String(opts.audience || '').trim();
  const videoUrls = (Array.isArray(opts.videoUrls) ? opts.videoUrls : [])
    .map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u)).slice(0, 10);

  // Ask for structured JSON directly in the reply rather than forcing a tool call:
  // some models reject tool_choice: "tool"/"any", so this is the compatible path
  // that works across every Claude model.
  const body = {
    model: aiModel(),
    max_tokens: 8000,
    system: 'You are an expert instructional designer who builds polished, interactive e-learning modules (think Articulate/Captivate quality): narrative hooks, captioned visuals, tap-to-expand accordions, scenarios and key-point panels — not flat text. You write clear, accurate, concrete content in a confident practical voice, and fair multiple-choice assessments. You respond with ONLY a single valid JSON object matching the requested shape — no markdown code fences, no commentary — using only the documented block-kit HTML in lesson bodies.',
    messages: [{ role: 'user', content: buildUserPrompt({ topic, sourceText, numLessons, numQuestions, audience, videoUrls }) }],
  };

  let res;
  try {
    res = await fetchImpl(anthropicUrl(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': aiApiKey(),
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error('Could not reach the AI service: ' + e.message);
  }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j && j.error && j.error.message) || ''; } catch (_) { /* ignore */ }
    throw new Error(`AI service error (${res.status})${detail ? ': ' + detail : ''}.`);
  }
  let data;
  try { data = await res.json(); } catch (e) { throw new Error('AI service returned an unreadable response.'); }
  // The reply's text blocks hold the JSON object we asked for.
  const text = Array.isArray(data.content) ? data.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n') : '';
  const raw = extractJson(text);
  if (!raw) throw new Error('The AI did not return a usable course. Try again or add more detail.');

  const draft = normalizeDraft(raw, { passPercent: opts.passPercent, title: topic, maxLessons: numLessons + 2, lessonMinSeconds: opts.lessonMinSeconds, videoUrls });
  if (!draft.lessons.length) throw new Error('The AI returned an empty course. Try again with a clearer topic or more source material.');
  return draft;
}

// ---------------------------------------------------------------------------
// Interactive block module generation (getmatchready.module/v1)
//
// Two modes, surfaced in the AI Studio as a choice:
//   - "tenttalk": a short information session — a few pages of narration, prose,
//     callouts, a carousel/accordion and a closing acknowledgment checklist.
//     NO knowledge checks and NO assessment. Completion = read through + ack.
//   - "full": a full interactive lesson — more pages, gated knowledge checks and
//     a final scored assessment.
// The model emits a nested { module, pages } doc; the server runs it through
// normalizeModuleDoc (lib/moduledoc) which drops anything malformed, so a slightly
// imperfect reply still renders.

// The referee illustration/photo keys the player can show (used only for soccer
// refereeing topics). The model may put one on a carousel slide, scenario, or
// imageSelect option via `graphic`.
const MODULE_GRAPHIC_KEYS = ['free-kick', 'card-high', 'card-high-red', 'card-low', 'flag-up', 'flag-direction', 'flag-down', 'card-face', 'card-group', 'confrontation', 'bench', 'field-position', 'eye-contact', 'whistle'];

function buildModulePrompt({ topic, sourceText, audience, mode, approxPages, libraryImages }) {
  const tent = mode === 'tenttalk';
  const parts = [];
  parts.push(`Build an interactive ${tent ? 'TENT TALK (a short, ~5-minute tournament-side information session)' : 'FULL interactive lesson'} as a single module in the getmatchready.module/v1 format${audience ? `, for ${audience}` : ''}.`);
  if (topic) parts.push(`Topic: ${topic}`);
  if (sourceText) parts.push(`Base it on this source material (summarize and teach it, do not copy verbatim):\n"""\n${sourceText.slice(0, 12000)}\n"""`);
  parts.push(`\nAim for about ${clampInt(approxPages, 3, 12, tent ? 5 : 8)} pages. The first page has "layout":"cover" and ends with a {"type":"gate","label":"Start"} block.`);
  if (tent) {
    parts.push('This is an INFORMATION SESSION: use only informational blocks (narration, prose, list, callout, carousel, accordion, flashcards, tabs, scenario, flow, image, table, compare, summary). Do NOT include any knowledgeCheck, videoDecision, imageSelect, branching or assessment blocks. The LAST page must end with a {"type":"checklist","id":"ack","heading":"Before you go — I will:","items":["...","...","..."]} and that page\'s "completionRequires" must be ["ack"].');
  } else {
    parts.push('This is a FULL lesson: teach across several pages, put a gated knowledgeCheck on most content pages, and make the LAST page a recap {"type":"summary"} plus a final {"type":"assessment","id":"final","passMarkPercent":80,"items":[{"prompt":"...","options":["a","b","c"],"correct":0}, ...]} with 6-10 items. Each knowledgeCheck has "gateRevealBehindSubmit":true.');
  }
  parts.push(`\nBlock types and their fields:
- narration: {durationSeconds:int, transcript:string, videoUrl?:string}
- prose: {body:[string], emphasis?:bool}
- list: {ordered?:bool, heading?:string, items:[string]}
- callout: {heading:string, body:[string]}
- table: {title?:string, columns:[string], rows:[[string]]}
- compare: {id, title?, cards:[{title, sanction?, body}]}
- carousel: {id, title?, slides:[{title, body, graphic?, imageBrief?}]}
- accordion: {id, title?, items:[{label, body?, bullets?:[string]}]}
- flashcards: {id, title?, instruction?, cards:[{front, back}]} — flip-to-reveal; "front" is a short term/name, "back" its definition
- tabs: {id, title?, instruction?, tabs:[{label, body?, bullets?:[string]}]} — toggle between parallel facets of one idea
- scenario: {id, graphic?, imageBrief?, lines:[string]}
- reflection: {id, prompt, followUp}
- checklist: {id, heading, items:[string]}
- knowledgeCheck: {id, gateRevealBehindSubmit:true, prompt, options:[{id:"a",text}], correctOptionId:"a", correctFeedback, incorrectFeedback, lessonHeading, lesson}
- videoDecision: {id, clipUrl?:string, clipBrief?:string, prompt, options:[{id:"a",text}], correctOptionId:"a", correctFeedback, incorrectFeedback, lesson}
- flow: {id, nodes:[{kind:"start"|"decision"|"outcome"|"end", text, branches?:[{answer, to}], exceptions?:[string]}]} — a decision flowchart for "what do I do when…" judgement logic, rendered as a real top-to-bottom diagram (terminator pills for start/end, cards for decisions/outcomes, each branch shown as "[answer] → where it leads"). STANDARD, follow every time: exactly ONE "start" node (the trigger), then alternate "decision" nodes (each a clear either/or or yes/no question) with the "outcome" node(s) they lead to, and finish with ONE "end" node (the final action). Give every decision exactly 2 branches; each branch's "answer" is the short choice ("Own players" / "At the crew", or "Yes" / "No") and its "to" is a few words naming where that path leads. Keep the whole flow to 4-7 nodes so it stays readable. Use a flow for a genuine judgement call, never to list facts
- branching: {id, setup:[string], decisions:[{prompt, options:[{id:"a", text, correct:bool, feedback}]}], close:[string]} — a run-one-scenario capstone; a wrong option explains and returns to the same decision (FULL lessons only)
- image: {id, graphic?:string, imageBrief?:string, caption?:string} — a standalone picture
- summary: {heading, intro?, items:[string]}
- assessment: {id, passMarkPercent:int, items:[{prompt, options:[string], correct:int}]}
- gate: {label}
Each interactive block (carousel, accordion, flashcards, tabs, reflection, checklist, knowledgeCheck, assessment) needs a short lowercase "id". A page's "completionRequires" lists ONLY the ids of interactive blocks on that same page.`);
  parts.push(`\n"graphic" (optional, soccer refereeing topics only): to show a referee photo, set "graphic" to exactly one of: ${MODULE_GRAPHIC_KEYS.join(', ')}. Omit it for any non-refereeing topic. Always also give an "imageBrief" describing the intended picture.`);
  if (Array.isArray(libraryImages) && libraryImages.length) {
    const list = libraryImages.slice(0, 120).map((im) => `  - ${im.key}: ${im.label || im.key}`).join('\n');
    parts.push(`\nCUSTOM IMAGE LIBRARY — these real images already exist on this platform. When a block (carousel slide, scenario, imageSelect option, or a standalone "image" block) needs a picture that one of these clearly depicts, set that block's "graphic" to the EXACT key below so the real image is shown instead of a placeholder. Use a key ONLY when it genuinely matches the moment; otherwise just write an "imageBrief" describing the picture to add later. Available keys:\n${list}`);
  }
  parts.push(`\nVIDEO rule: only add a video when you have a REAL URL for it. "videoUrl" (narration) and "clipUrl" (videoDecision) must be a full https link to an .mp4 file or a YouTube/Vimeo page. If you do not have a real URL, omit the field entirely and DO NOT write "watch the video" / "in this clip" in any text — teach with prose, a scenario, or a described decision instead. Never invent or guess a video URL.`);
  parts.push(`\nFORMAT STANDARD (follow EVERY time, Tent Talk and Full lesson alike): one idea per section; keep pages short and scannable. Make every course feel interactive and visual, like a polished Captivate/US-Soccer course — NOT page after page of prose. Use a MIX of the blocks across the pages, and put an interactive or visual block on most content pages:
- accordion for optional "expand for detail" content;
- flashcards to flip-reveal a set of terms/definitions (3-6 cards) — include at least one flashcards OR tabs block somewhere in the course;
- tabs to toggle between parallel facets of one idea (2-4 tabs);
- carousel for a short step-by-step sequence;
- flow for decision / "what do I do when…" logic (renders as a real flowchart);
- compare for two-way contrasts (e.g. yellow vs red);
- scenario for a situation to reason about;
- callout for a key rule.
For a FULL lesson, use a branching scenario as the capstone (second-to-last page) when the topic involves a judgement call. Lead a section with its visual or video, then the teaching text. Write in plain, encouraging, second-person coaching language. Headings, the banner and progress UI are styled automatically by the player — focus on strong content and this block variety.`);
  parts.push(`\nTITLES: every "standard" page needs a punchy "title" (2-5 words) AND a one-line "subtitle" (a 6-14 word subhead that frames what the page is about, in the same coaching voice). The subtitle is NOT a repeat of the title — it adds the angle or the "so what". Example: title "When the Card Is Shown", subtitle "The decision is made at once; when you show it depends on what happens next." The cover page needs no subtitle.`);
  parts.push(`\nReturn ONLY one JSON object, no markdown fences, shaped as:
{"module":{"title":string,"course":string,"estimatedMinutes":int,"passMarkPercent":int,"objectives":[string]},"pages":[{"id":string,"title":string,"subtitle":string,"layout":"cover"|"standard","completionRequires":[string],"blocks":[ ... ]}]}`);
  return parts.join('\n');
}

async function callClaudeJson(system, userText, maxTokens, fetchImpl) {
  if (!aiEnabled()) throw new Error('AI generation is not configured. Set ANTHROPIC_API_KEY in the environment, then redeploy.');
  if (!fetchImpl) throw new Error('No HTTP client available to reach the AI service.');
  let res;
  try {
    res = await fetchImpl(anthropicUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': aiApiKey(), 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({ model: aiModel(), max_tokens: maxTokens || 8000, system, messages: [{ role: 'user', content: userText }] }),
    });
  } catch (e) { throw new Error('Could not reach the AI service: ' + e.message); }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j && j.error && j.error.message) || ''; } catch (_) { /* ignore */ }
    throw new Error(`AI service error (${res.status})${detail ? ': ' + detail : ''}.`);
  }
  let data;
  try { data = await res.json(); } catch (e) { throw new Error('AI service returned an unreadable response.'); }
  const text = Array.isArray(data.content) ? data.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n') : '';
  const raw = extractJson(text);
  if (!raw) throw new Error('The AI did not return usable JSON. Try again or add more detail.');
  return raw;
}

// Returns a raw { module, pages } doc for the caller to run through
// normalizeModuleDoc. mode is 'tenttalk' or 'full'.
async function generateModuleDraft(opts = {}, fetchImpl = (typeof fetch !== 'undefined' ? fetch : null)) {
  const topic = String(opts.topic || '').trim();
  const sourceText = String(opts.sourceText || '').trim();
  if (!topic && !sourceText) throw new Error('Enter a topic or paste some source material to build from.');
  const mode = opts.mode === 'tenttalk' ? 'tenttalk' : 'full';
  const audience = String(opts.audience || '').trim();
  const system = 'You are an expert instructional designer building interactive e-learning modules (Articulate/Captivate quality): narrative hooks, carousels, tap-to-expand accordions, scenarios, gated knowledge checks and fair assessments. You respond with ONLY a single valid JSON object in the requested getmatchready.module/v1 shape — no markdown code fences, no commentary.';
  const userText = buildModulePrompt({ topic, sourceText, audience, mode, approxPages: opts.approxPages, libraryImages: Array.isArray(opts.libraryImages) ? opts.libraryImages : [] });
  const raw = await callClaudeJson(system, userText, mode === 'tenttalk' ? 6000 : 9000, fetchImpl);
  return raw;
}

// Edit an EXISTING module doc from a plain-language instruction. Returns a raw
// { module, pages } doc for the caller to run through normalizeModuleDoc (and
// enforceInfoSession for a Tent Talk). Reuses the full format + flowchart
// standard from buildModulePrompt so edits stay on-standard.
async function editModuleDraft(opts = {}, fetchImpl = (typeof fetch !== 'undefined' ? fetch : null)) {
  const instruction = String(opts.instruction || '').trim();
  if (!instruction) throw new Error('Describe the change you want to make.');
  const currentDoc = opts.currentDoc;
  if (!currentDoc || !Array.isArray(currentDoc.pages) || !currentDoc.pages.length) {
    throw new Error('This course has no editable module content.');
  }
  const mode = opts.mode === 'tenttalk' ? 'tenttalk' : 'full';
  const audience = String(opts.audience || '').trim();
  const title = (currentDoc.module && currentDoc.module.title) || currentDoc.title || '';
  const spec = buildModulePrompt({ topic: title, audience, mode, approxPages: currentDoc.pages.length, libraryImages: Array.isArray(opts.libraryImages) ? opts.libraryImages : [] });
  const currentJson = JSON.stringify({ module: currentDoc.module || { title }, pages: currentDoc.pages });
  const system = 'You are an expert instructional designer EDITING an existing interactive e-learning module in the getmatchready.module/v1 format. Apply ONLY the requested change, keep everything else intact, and keep the result on-standard. Respond with ONLY one valid JSON object (the complete updated module) — no markdown code fences, no commentary.';
  const userText = [
    'Here is the CURRENT module (JSON):', currentJson, '',
    'Make this change, and nothing more:', '"""', instruction, '"""', '',
    'Return the COMPLETE updated module in the SAME JSON shape. Keep every page id and all content the change does not touch. Preserve the cover and (for a full lesson) the final assessment unless the change is explicitly about them. Anything you add or rewrite must follow these format rules:', '',
    spec,
  ].join('\n');
  const raw = await callClaudeJson(system, userText, mode === 'tenttalk' ? 8000 : 11000, fetchImpl);
  return raw;
}

module.exports = { aiEnabled, aiModel, generateCourseDraft, generateModuleDraft, editModuleDraft, normalizeDraft, sanitizeHtml, extractJson, COURSE_TOOL, MODULE_GRAPHIC_KEYS };
