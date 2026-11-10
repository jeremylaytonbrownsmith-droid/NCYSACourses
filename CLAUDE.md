# GetMatchReady — project memory & course-building playbook

This file is loaded automatically at the start of every Claude session on this
repo. It exists so Claude (and new teammates like Dick) don't have to re-explain
how the platform and the course builder work each time.

## What this is

An org-based referee-education platform. One codebase serves multiple
organizations, each with its own branded portal:

- **NCYSA** (`ncysa`) — the default org / North Carolina portal.
- **NCSRA** (`ncsra`) — NC referee association (branding used on referee courses).
- **OMG** (`omg`) — Officials Management Group, reached at **getmatchready.app/omg**.

Org constants live in `server.js` / `public/app.js`: `DEFAULT_ORG`, `ORG_OPTIONS`,
`ORG_NAMES`. A course's `orgId` decides which portal shows it. A `partner` account
is locked to one org (e.g. OMG partner → `omg`).

## Deploy flow

- Merging to `main` auto-deploys to Render (~1 min; free tier may 502 briefly on
  first hit — that's a cold start, not a failure).
- The sandbox **cannot reach getmatchready.app** (network policy), so Claude
  can't curl-verify a live deploy — say so rather than claiming it's up.
- Develop on the designated feature branch; if its PR already merged, restart the
  branch from `origin/main` for follow-up work.

## Interactive course format (`getmatchready.module/v1`)

Courses are authored as a JSON "module doc" (one `module`-type lesson) and played
by a generic block player. Key files:

- `public/app.js` → `renderModuleLesson()` (the player + left progress rail).
- `lib/moduledoc.js` → `normalizeModuleDoc()` (server-side gatekeeper; drops
  unknown block types/fields). **Validate any new course against this.**
- `scripts/check-modules.js` → **run `npm run check:modules` before shipping a
  course edit.** It audits every `public/samples/*.module.json` for the gotchas
  below (orphan `completionRequires`, empty assessment, branching/flow shape) —
  ERRORS block, warnings advise.
- `lib/aicourse.js` → the AI builder + the format spec in prompt form.
- `docs/MODULE-STANDARD.md` → the house standard.

**Block types:** narration, prose, list, callout, table, compare, carousel,
accordion, flashcards (flip), tabs (toggle), scenario, image, reflection,
checklist, knowledgeCheck (gated), videoDecision, imageSelect, flow, branching,
summary, assessment (final exam), gate.

**Gotchas that have bitten us:**
- `assessment` needs real `items` (prompt/options/correct index). A `drawFrom`
  reference list renders an **empty exam** → page never completes → no certificate.
- `branching` `setup`/`close` must be **string arrays**, not `{style, lines}` objects.
- `videoDecision` with no real `clipUrl` falls back to a text question — fine, but
  don't reference "watch the clip". We have **no comparison video** assets.
- Each page's `completionRequires` must list ids of **interactive** blocks on that page.

## Images — use the built-in art (no upload needed)

The app ships referee photos + SVG diagrams in `public/graphics.js`
(`GMR_PHOTOS` → `media/signals/*.png`, and `GMR_GRAPHICS` → inline SVG). A block's
`graphic` key resolves to: uploaded org image (`GMR_LIBRARY`) → preset photo →
preset SVG → text placeholder. **Prefer the built-in keys so illustrations render
with zero upload.**

Built-in **photo** keys: `free-kick`, `card-high`, `card-high-red`, `card-low`,
`card-face`, `card-group`, `confrontation`, `bench`, `flag-up`, `flag-wave`,
`flag-direction`, `flag-down`.
SVG-diagram keys include: `eye-contact`, `challenge-side`, `field-position`,
`whistle`.

The spot-the-error card photos (`card-high`/`card-low`/`card-face`/`card-group`)
were made for exactly that interaction.

**Org image library** (`/api/image-library?org=<org>`) is per-org: OMG images are
separate from NCYSA/NCSRA. Upload via the Course Designer's 🖼 Image library (set
the picker to the org). Keys resolve per the course's `orgId`.

## Progress circles (left rail)

Built into `renderModuleLesson`. Each section's ring **fills by fraction** of its
completed elements and turns **green the moment the page is complete** (current
page included), signalling "click Next". Works automatically for every
module-type course, hand-built or AI-built. (SCORM/Evolve uploads use a different
player with no rail.)

## House course standard (apply EVERY time — the Card Mechanics course is the reference)

Every interactive module — hand-built or AI-built, Tent Talk or Full lesson —
should match this look and feel. Much of it is automatic in the player; the rest
is enforced in the AI prompt (`lib/aicourse.js`) and should be kept there.

**Automatic in the player (`renderModuleLesson` / `styles.css`), applies to any module:**
- A **branded banner** at the top: navy with a geometric texture, org eyebrow +
  lesson title + org crest + full-screen, a red accent stripe from the course's
  brand color (`.gmr-banner`).
- **Display typography**: headings use Archivo (`--font-display`); page shows a
  red **eyebrow → display title → subtitle** lead line.
- **Cool on-brand canvas** (`--gmr-canvas`), white content cards, navy interactive
  panels — never the old warm cream, which clashed with navy/red branding.
- **Progress rings** that fill by fraction and go green when a page is complete
  and STAY green on back-nav (completion is read from what's done, not position).

**Content standard (must be in the data — the AI prompt enforces it):**
- **Cover hero (every course):** the cover page's first block is an `image` with a
  real referee **photo** `graphic` (one of the `COVER_PHOTO_KEYS` in
  `lib/aicourse.js`: `ref-crew`, `ref-coin-toss`, `ref-card-yellow`, …). The player
  renders the cover's lead image as a full-bleed hero — photo background, title +
  meta over a scrim, red stripe (a Captivate title slide). Per-photo focal points
  live in `HERO_FOCAL` in `renderModuleLesson`. Non-refereeing topics omit it.
- **Photos live ONLY in the cover hero.** Content pages carry **no** decorative
  `image`/photo blocks (they read as clutter). Pedagogical SVG diagrams inside
  carousels/scenario/imageSelect are fine.
- Every standard page has a punchy **title (2–5 words) + a one-line subtitle**.
- **Interactive variety like a Captivate/US-Soccer course** — not walls of prose.
  Use a mix across pages: flashcards (flip), tabs (toggle), carousel, **flow**
  (decision flowchart), compare, scenario, accordion, callout. At least one
  flashcards/tabs somewhere; most content pages carry an interactive block.
- Full lessons: a **branching** scenario capstone when there's a judgement call,
  then summary + 8-item assessment (80%). Tent Talks: info blocks only + a final
  checklist `ack`.
- **Two course types only** (AI Studio): **Education Module** (`full`) and **Tent
  Talk** (`tenttalk`). The old reading-+-quiz path is retired from the UI.

**Flowchart standard (the `flow` block — reproduce this shape every time):** one
`start` node (the trigger) → alternate `decision` nodes (a clear either/or or
yes/no question) with the `outcome`(s) they lead to → one `end` node (the final
action). Every decision has exactly **2 branches**; each branch's `answer` is the
short choice and its `to` is a few words naming where it leads (rendered as
"[answer] → where it leads"). Keep it to **4–7 nodes**. Use a flow for a real
judgement call, never to list facts. Locked into `lib/aicourse.js`. The player
renders it as a **centered, compact column** (terminator pills, decision/outcome
cards, arrows down the middle) that reads like a tidy PowerPoint diagram — this is
automatic, so every flow matches without extra authoring.

**Tent Talk = presentation.** An info session (no assessment) gets the
`gmr-present` class; in full screen the left progress rail is hidden, the slide
fills the width, and Back/Next are pinned to the bottom (PowerPoint-style).
Progress rails matter less for a Tent Talk — it's a presentation, not a graded
module. Full lessons (with an exam) keep their rail.

When changing the look or the format, update BOTH the player/CSS AND the AI
prompt + `docs/MODULE-STANDARD.md`, so generated courses stay on standard.

## The live "Card Mechanics" course (code-managed)

- Course id `omg-card-mechanics`, org `omg`, lesson id `card-mechanics-main`.
- Seeded by `setupOmgCardMechanics()` in `server.js` via `ensureCourse(...)`, built
  from `public/samples/card-mechanics.module.json`.
- **Code-managed:** edit the content in that sample file (not the Course Designer —
  Designer edits to it won't survive a deploy). It syncs on each deploy; learner
  progress stays on the fixed lesson id.

## Building a course by hand (Course Designer)

Course Designer → ＋ New course (set **Organization**) → ＋ Add lesson → type
**Interactive module (block JSON)** → paste/validate JSON (**Check JSON**) →
Add lesson → **Publish**. A printable cheat-sheet of this lives with the team.

## Working style for this user

Short, concise, plain answers. Do the work; don't over-explain or present long
option menus. Be honest about limits (what the sandbox can/can't reach, what
needs their browser login). Don't invent facts.
