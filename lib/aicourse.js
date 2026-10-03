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
              description: 'Lesson body as simple HTML. Allowed tags: h3, h4, p, ul, ol, li, strong, em, br, and <div class="callout"> for a highlighted note. No scripts, styles, images, iframes, or external links.',
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
const ALLOWED_TAGS = new Set(['h3', 'h4', 'p', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'br', 'div']);
function sanitizeHtml(html) {
  let s = String(html || '');
  // Drop whole dangerous elements (with their contents).
  s = s.replace(/<(script|style|iframe|object|embed|link|meta)\b[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<(script|style|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, '');
  // Walk every tag; keep only allow-listed ones, and only a safe attribute
  // (class) on <div> so the callout box survives. Everything else is stripped.
  s = s.replace(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g, (m, close, tag, attrs) => {
    const t = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(t)) return '';
    if (close) return `</${t}>`;
    if (t === 'div') {
      const cls = /class\s*=\s*"(.*?)"/i.exec(attrs);
      const safe = cls && /callout/i.test(cls[1]) ? ' class="callout"' : '';
      return `<div${safe}>`;
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
  parts.push(`Create about ${numLessons} reading lesson(s) and exactly ${numQuestions} multiple-choice quiz question(s).`);
  parts.push('Each lesson should be focused and skimmable: short paragraphs, use <ul>/<li> for lists, <strong> for key terms, and a <div class="callout"> for the single most important takeaway. Keep it accurate and concrete.');
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
  "lessons": [ { "title": "string", "html": "lesson body using only these tags: h3, h4, p, ul, ol, li, strong, em, br, and <div class=\\"callout\\">. No scripts, styles, images, iframes, or links." } ],${vids.length ? '\n  "videos": [ { "title": "string", "intro": "1-2 sentence HTML, what to watch for" } ],' : ''}
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
    system: 'You are an expert instructional designer. You write clear, accurate, concise training content and fair multiple-choice assessments. You respond with ONLY a single valid JSON object matching the requested shape — no markdown code fences, no commentary before or after — using only the documented HTML tags in lesson bodies.',
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

module.exports = { aiEnabled, aiModel, generateCourseDraft, normalizeDraft, sanitizeHtml, extractJson, COURSE_TOOL };
