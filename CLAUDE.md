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

## Architecture map — the whole project, start to finish

A Node/Express server + a vanilla-JS single-page app. No build step; the browser
loads `app.js`/`styles.css` directly. Key files:

- **`server.js`** — the Express app: auth (cookie sessions), per-domain org
  routing, serves the SPA shell (`sendIndexHtml`, which injects per-domain
  `<title>`/OG meta **and** cache-busts `app.js`/`styles.css`/`graphics.js` with
  `?v=<newest-mtime>`), static files, all `/api/...` routes (courses, lessons,
  learner progress, the SCORM runtime callback, the admin dashboard, the AI
  builder, image library, partner integration), and seeds the code-managed
  courses (e.g. `setupOmgCardMechanics`). `/health` reports persistence
  durability.
- **`public/app.js`** — the entire SPA (hash-routed, vanilla JS): landing/login,
  course list, and the players — `renderModuleLesson()` (interactive module +
  progress rail), `renderScormLesson()` (uploaded SCORM/Evolve/Captivate in an
  iframe, with the active-time heartbeat + resume), plus reading/video/quiz
  renderers, the **admin Dashboard**, the **AI Studio** (build + Edit-with-AI),
  and the **Course Designer**.
- **`public/styles.css`** — all styling (the module player, banner, hero, dashboard).
- **`public/graphics.js`** — `GMR_PHOTOS` (real photos in `media/signals/*`) and
  `GMR_GRAPHICS` (inline SVG diagrams); a block's `graphic` key resolves here.
- **`lib/store.js`** — the data layer (see **Data & persistence** below).
- **`lib/moduledoc.js`** — `normalizeModuleDoc()` gatekeeper for module JSON.
- **`lib/aicourse.js`** — the AI course builder + the format spec in prompt form.
- **`lib/integration.js`** — partner/SCORM export + score mapping.
- **`public/samples/*.module.json`** — code-managed course content (synced on deploy).
- **`scripts/check-modules.js`** — `npm run check:modules` audit (run before shipping).

## Data & persistence (important — this is where "lost progress" lives)

`lib/store.js` keeps the whole database in memory (`db`: users, courses,
progress, sessions, certs/enrollments). Reads are synchronous; `save()` writes:

- **Firestore** when `FIREBASE_SERVICE_ACCOUNT` is set — per-record write-through,
  **durable** (survives restarts/redeploys). This is what the live site uses.
- **Local `data/db.json`** otherwise — fine for dev, but **ephemeral on Render**
  (wiped on sleep/redeploy). `status.durable` is false in this case.

**`GET /health`** → `{ ok, durable, backend, uptimeSeconds }`. `durable:true` +
`backend:"firestore"` = progress is safe. The sandbox can't reach the live site,
so ask the user to open `getmatchready.app/health` to check. (Confirmed durable +
firestore as of this writing.)

## Learner progress, completion & gates

Progress is per **user + course + lesson** (`getProgress` / `upsertProgress`),
saved with `save()`. Lessons **unlock sequentially** — a lesson is locked until
the previous one is complete (`lessonState`). Course completion issues a
certificate (`maybeCompleteCourse`) and may fire a partner return URL.

- **Reading/video** (`POST /complete`): video has a watch-seconds gate.
- **Quiz** (`POST /quiz`): graded; pass ≥ `passPercent`.
- **SCORM/Evolve modules** (`POST /scorm`): the in-page `window.API` relays
  `cmi` status/location/`suspend_data`; **active time accrues via a 5s heartbeat
  that only counts while the tab is visible** (the anti-skip gate), and
  `suspend_data`/`location` let a learner **resume where they left off**.
  Completes when enough active time **and** the package reports done (or
  `completeOnTime`). **We removed the old "away too long" auto-reset** that wiped
  progress when a tab sat hidden >3 min — a break or overnight gap no longer
  loses a learner's place. An explicit `{reset:true}` (admin "start over") remains.
  Stored `suspend_data` is capped at `SCORM_SUSPEND_MAX` (64000, the SCORM 2004
  limit) in `server.js` — a bigger package's resume blob used to be truncated to
  4096 and bounce the learner back a module.
- **Reset-alert safety net** (SCORM `/scorm` handler): if a learner's resume
  state silently collapses — they had a real `suspend_data` blob (≥32 chars) or a
  saved `location`, and a heartbeat leaves them with neither while the module is
  still unfinished — we `notifyInApp({audience:'ncysa', kind:'alert'})` and email
  `SUPPORT_EMAIL` if set. `kind:'alert'` notifications render in their own
  **⚠️ Alerts** section on the dashboard (red, split out so they don't drown in
  the routine course-completion stream under **NCYSA notifications**). Fires
  once per regression (state is empty afterward). The explicit admin
  `{reset:true}` path returns before this, so a deliberate "start over" never
  alerts. This is a monitor to catch new/unknown causes before a learner emails —
  not a fix for a cause we know. Covered by `tests/reset-alert.spec.js` (run a
  single spec with `npx playwright test tests/<name>.spec.js --trace off`).
  **Blind spot:** only packages that write `suspend_data`/`location` are watched —
  Mentor+ and the SCORM recert modules are; the Evolve Mentor course sends
  neither, so a lost place there is invisible to this alert.
- **Does an HTML-package module save the learner's place? Depends on the package,
  and the player decides from EVIDENCE** (`persistence` in `renderScormLesson`:
  `unknown` → `saves` or `nosave`). **Mentor+** (US Soccer's "U.S. Refereeing Way"
  presenter package: `js/scorm.js` + `js/state.js` + `js/app.js`) finds our
  `window.API` up the parent chain, writes a slide bookmark
  (`cmi.core.lesson_location` = `item-N`) and a JSON resume blob
  (`cmi.suspend_data`, ≤4096 chars) on every slide, and on boot restores from that
  blob BEFORE its own localStorage — so it **resumes on any device, signed in**.
  Verified end to end with the package's real bridge (first visit → save →
  heartbeats don't wipe it → reload resumes → a new browser resumes). The old "I
  lost my spot" emails were our since-removed 3-minute away-reset wiping that blob,
  not the package. The **Evolve Mentor** course (uploaded with `htmlPackage:false`,
  detected by its `.ev-*` outline) truly keeps its place in memory only. Rules:
  `saves` (a bookmark/suspend write seen, or one already on record) → the 📘 guide
  + hint say "your place is saved", no banner, no leave/back guards; `nosave`
  (Evolve outline, or a plain page that never touched the API after 90 s active)
  → ⚠️ "finish in one sitting" banner + guards + the guide says so; `unknown` →
  say nothing about saving. **Never hard-code a saved / not-saved claim** in the
  guide (`#mgSave`/`#mgSaveEnd`), hint (`#scormSaved`) or banner — it must come
  from `persistence`. An admin's custom `lesson.startGuide` has none of those
  spans, so check its wording by hand. Covered by `tests/html-resume.spec.js`.
  The guide also tells learners about the package's **Presentation Mode (F key)**
  for a clean single-screen view. **Evolve web exports are their own upload
  kind** (`isEvolvePackage` in `server.js`: launch page mounts `#ev-root`, or
  `course.json` + `manifest.json` + `assets/main.min.js` beside it → upload
  `kind:'evolve'`), so the Designer never sets `htmlPackage` on a Mentor lesson —
  that flag is for presenter-style packages (Mentor+) and would put the Mentor+
  📘 guide and the manual "mark it complete" fallback (a skip hole) on an Evolve
  module. A Mentor lesson saved with the flag before this existed is corrected on
  read (`withEvolveFlag` in `publicCourse` + the admin course GET). Covered by
  `tests/evolve-package.spec.js`. **Shrinking an Evolve package's assets** (the
  Mentor Foundations export shipped at 353 MB: six 6016-px photos at 10–43 MB
  and a 185 MB MP4) is a plain file swap inside the zip — `sips -Z 1920` on the
  images, `avconvert --preset PresetAppleM4V720pHD` on the video, same
  filenames, course.json untouched (its `.jws.json` signature stays valid) — then
  re-upload to the same lesson; progress is per lesson id. Module 1 went 353 →
  96 MB that way. Evolve's "remember progress" is OFF in these exports
  (`config.publish.useLocalStorage:false`); only US Soccer can flip that.
  **Lightbox rescue:** Evolve's "click to enlarge" images (6 in Mentor module 1)
  open a `position:fixed` overlay INSIDE the frame, whose close ✕ is at the
  frame's top edge — which slides UNDER the sticky `.topnav` once the learner has
  scrolled, so they saw a full-screen picture with no way out and pressed Back →
  "leave?" → restart (the frame can't scroll above the window; the header is
  what covers it). The
  player watches the same-origin frame DOM (`watchOverlays` in
  `renderScormLesson`): a viewport-covering fixed overlay scrolls the frame top
  into view, and while one is open browser Back closes it (`onPopGuard` →
  `closeOverlay`) instead of offering to leave. Generic, no Evolve selectors.
  Covered by `tests/lightbox-guard.spec.js`. **The course's "Start
  Here" text (`course.instructions`, the Designer's Start Here box) renders as the
  FIRST line inside that 📘 guide** (`#mgIntro`, above the steps and outside the
  part the Hide button collapses) for HTML-package lessons — e.g. the Mentor /
  Mentor+ eligibility note. `viewCourse` suppresses the separate Start Here box
  there so it isn't shown twice; every other lesson type keeps the box above the
  player. Admins edit the text in the Designer, never in code.
- **Interactive module** lessons: `renderModuleLesson` tracks per-page element
  completion against each page's `completionRequires`; the rings fill as you go.

## Admin dashboard (`requireDashboard` / `requireEditor` / `requireAdmin`)

In the SPA: learner progress by course, live presence, **reset a learner's
module**, and **mark a module complete for a learner** (how you credit someone
like Jay for modules they already finished — no backend work). Plus course CRUD,
the AI builder, and export to SCORM / web page.

**Layout gotcha (phones):** the cards below the KPI row live in `.admin-grid`, a
single-column CSS grid that **must stay `grid-template-columns: minmax(0, 1fr)`**
with `min-width: 0` on its cards. All cards share that one track; an implicit
`auto` track grows to the widest card's minimum content, so one card with a
wide row made EVERY card (collapsed ones too) 405px on a 390px phone and the
page scrolled sideways. The wide row was a `<select>` — a select sizes itself to
its **longest option** (a course title), so `.filter-bar input/select` carry
`max-width: 100%; min-width: 0`; keep that on any new select in a card. To check
any dashboard layout change at phone width,
render it headless and measure `scrollWidth` vs `innerWidth` (the dashboard
needs an admin login — log in via `/api/login` and copy the cookie into the
browser context) rather than eyeballing a screenshot.

## Deploy flow

- Merging to `main` auto-deploys to Render (~1 min; free tier may 502 briefly on
  first hit — that's a cold start, not a failure).
- The sandbox **cannot reach getmatchready.app** (network policy), so Claude
  can't curl-verify a live deploy — say so rather than claiming it's up.
- Develop on the designated feature branch; if its PR already merged, restart the
  branch from `origin/main` for follow-up work.
- **CI gate:** `.github/workflows/test.yml` runs `npm run check:modules` + the full
  Playwright suite on every PR into `main` and every push to `main`. It is only a
  *hard* gate once branch protection is on (GitHub → Settings → Branches → rule
  for `main` → "Require status checks to pass" → `test`); until then a red check
  can still be merged past. Run the whole suite locally with `npm test` (~3.5 min,
  163 tests) or one file with `npx playwright test tests/<name>.spec.js --trace off`.
  **One Playwright run at a time** — the config starts its own server on port 3100
  and refuses to reuse one. When a test goes red, check first whether the test is
  stale (a deliberate product change) before touching the product: the first
  dry-run found 5 red tests and none was a bug. **Running the suite rewrites
  `screenshots/*.png`** (the e2e journey captures them) — `git checkout --
  screenshots/` before committing, and always `git add` named files, never `-A`.
  **Test gotcha — registering through the UI:** after clicking "Create account",
  wait for the nav greeting (`expect(page.locator('.topnav')).toContainText('Hi,
  <First>')`) BEFORE calling the API or navigating. The `/api/register` response
  sets the cookie, but the SPA sets `me.user` one more round trip later; navigate
  earlier and `viewCourse` bounces to `#/register`, which shows up as a flaky
  120s timeout on a slow CI runner. The never-flaky tests already do this.
- **Hosting:** the `ncysa-learn` Render web service runs on the **Standard compute
  plan** (1 CPU / 2 GB, always-on — Render renamed "Instance Type" to "Compute
  Plan"; it's under the service's MANAGE → Compute). Its primary domain is
  `ncysalearn.app`; `getmatchready.app` is the product/OMG host. Because the
  instance never sleeps, the old `keepalive.yml` cron (a 10-minute ping to wake
  a Free instance) was deleted — don't re-add it. A slow first load is NOT the
  instance sleeping; look for the real cause. The Render *workspace* plan
  (Hobby/Pro) is separate from the compute plan and doesn't affect uptime.
- **One domain per org — links must respect it.** `getmatchready.app` IS OMG's
  site; NCYSA/NCSRA is `ncysalearn.app` (`DOMAIN_ORG` in `app.js`). Every
  learner-facing link the server mints — the Designer's **demo/launch link** and
  **reminder emails** — goes through `publicBaseForOrg(org, …)` in
  `lib/integration.js`: NC → `ncysalearn.app`, OMG → `getmatchready.app`,
  overridable with `PUBLIC_URL_NCYSA` / `PUBLIC_URL_OMG`; with no `PUBLIC_URL` at
  all (dev, tests) links stay on the request host. It used to use `PUBLIC_URL` for
  every course, so an NCSRA demo link opened on OMG's domain under an OMG header.
  The **header brand follows the course's own record** (`coBrandName` /
  `coLogoUrl` / `orgId`), fetched per course when it isn't in the public list — so
  a **draft** previewed via a demo link is branded correctly too. Only with no
  course in view does the header fall back to the domain's org (OMG on
  getmatchready.app) or plain NCYSA. Covered by `tests/launch-domain.spec.js`.
  After this change, **re-mint** any demo link made earlier — old ones still
  point at the product domain. **The Render hostname redirects.** The service
  also answers on `ncysa-learn.onrender.com`; a page opened there loads every
  file (videos included) from onrender.com, which a school network's Microsoft
  filter blocked while allowing `ncysalearn.app`. A middleware near the top of
  `server.js` 301-redirects GET/HEAD page loads on any `*.onrender.com` host to
  `ORG_FRONT_DOORS.ncysa` (override `PUBLIC_URL_NCYSA`), keeping the path; the
  browser carries the `#/route`. Exempt: `/health` (Render's check), `/api/`,
  `/launch`, `/scorm/`. Covered by `tests/canonical-host.spec.js`. Hand out only
  `ncysalearn.app` / `getmatchready.app` links; never the onrender one.

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

**Referee-portal sections.** `#/referees` groups referee-audience courses into
fixed-order sections — **Referees · Mentors · Assignors** — each with a subtitle
and count (`groupedCourseGrid` / `trackOf` in `app.js`). A course's section is its
explicit `track` (the Designer's **Section** dropdown; stored only as
`referee|mentor|assignor`, empty = auto) or, by default, inferred from the title
("Mentor" → Mentors, "Assignor" → Assignors, else Referees) — so existing courses
needed no edits. Inside a section, first-time courses come before recertification
(title/badge matching "recert"); otherwise the Designer's up/down order holds.
Headings appear only when a portal has **more than one** section, so OMG's
single-track portal keeps its plain grid. Covered by `tests/portal-sections.spec.js`.
Keep card **badges** consistent by hand: "First-time" / "Recertification".

## Working style for this user

Short, concise, plain answers. Do the work; don't over-explain or present long
option menus. Be honest about limits (what the sandbox can/can't reach, what
needs their browser login). Don't invent facts.

**Drafting emails:** keep them **short and concise** — a few tight lines, not a
long message. (The user often handles these quickly between school duties.)

**Keep this file current:** when the project grows or a fact here changes (a new
feature, a fixed bug, a changed standard), update `CLAUDE.md` in the same change
so the next session starts with an accurate map. This file is the project's
living summary — checked every session.
