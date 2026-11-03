# TODO — prioritized improvement backlog

The **Nightly Improve** GitHub Action (`.github/workflows/nightly-improve.yml`) reads
this file once a day, takes the **top unchecked item**, implements that one item,
runs the tests, and opens a pull request. One item per run, one change per PR.

## Rules for whoever (or whatever) works this list
- Do the **top unchecked `[ ]` item only**. Don't batch several.
- Keep the change **small and self-contained** — touch only the files the item names.
- **All tests must stay green**: run `npx playwright test` before opening the PR, and add
  a test for the new behavior.
- Don't change branding, pricing, or copy that faces OMG/partners without it being the item.
- When done, check the box (`[x]`) in the PR and write one line under it describing what shipped.

---

## Backlog (top = next)

- [ ] **Record the assessment result when an interactive module is completed.**
  Today a `module` lesson completes with a bare POST; the final assessment's score is lost.
  - Why: staff need to see the actual score/pass on the dashboard and CSV export, like the exam does.
  - Scope: `public/app.js` (`renderModuleLesson` sends `{ assessmentScore, passed }` on the final complete),
    `server.js` (the `/lessons/:id/complete` endpoint stores `moduleScore`/`modulePassed` on the progress record
    and `/api/admin/overview` + the CSV export surface it).
  - Done when: a learner who passes the assessment has the score shown on the records table, and a test asserts it.

- [ ] **Resume an interactive module where the learner left off.**
  Reopening a `module` lesson always starts on page 0.
  - Why: real modules are long; losing your place is a known complaint (John Frey's stuck video).
  - Scope: `server.js` (store the furthest page index on the progress record via the existing complete/scorm-style call,
    or a small `POST /lessons/:id/module-progress`), `public/app.js` (`renderModuleLesson` restores `state.page`/`state.max`).
  - Done when: navigating to page 3, leaving, and returning reopens on page 3; a test covers the round-trip.

- [ ] **Accessibility pass on the interactive module player.**
  - Why: referees use phones and assistive tech; the option rows are `div`s with click handlers only.
  - Scope: `public/app.js` (`renderModuleLesson`) + `public/styles.css` (`.gmr-*`). Make options keyboard-operable
    (role=radio/radiogroup or real buttons, Enter/Space, visible focus), announce feedback with `aria-live`,
    move focus to the page heading on navigation, and honor `prefers-reduced-motion`.
  - Done when: options are reachable and selectable by keyboard, and a test checks the roles/focus.

- [ ] **AI course builder emits `getmatchready.module/v1` interactive modules.**
  - Why: the goal is "AI builder output at Captivate standard" — it should produce block modules the new
    player renders, not just reading/quiz lessons.
  - Scope: `lib/aicourse.js` (extend `COURSE_TOOL`/`generateCourseDraft`/`normalizeDraft` to optionally produce a
    module doc), validated through `lib/moduledoc.js` `normalizeModuleDoc`. Keep the existing text/quiz output working.
  - Done when: a generated course can include a `module` lesson that passes `normalizeModuleDoc` and renders; test added.

- [ ] **Visual block editor for interactive modules (no raw JSON).**
  - Why: staff should author blocks in a form, not hand-edit JSON; JSON stays as the import/export format.
  - Scope: `public/app.js` admin lesson editor — a block list with add / reorder / remove and per-block fields,
    serializing to the same module doc. The textarea remains available as "advanced / paste JSON".
  - Done when: a module can be built end-to-end from the UI without touching JSON; smoke test added.

- [ ] **Per-block uploaded image override + full-res photos.**
  Blocks now show a real studio referee photo when `graphic` matches the photo set (`public/media/signals/`), else the
  SVG diagram, else a captioned frame. Remaining gaps: (a) let a block point at its own uploaded image URL for one-off
  art, and (b) the signal photos are ~200px (fine at display size) — pull full-res from Canva for large retina screens.
  - Scope: `lib/moduledoc.js` whitelists an `image` field; precedence image → photo-set → `graphic` SVG → brief.
    Regenerate/export the `media/signals/*` set at ~1000px.
  - Done when: a block with its own image URL shows it; the set is crisp on retina; test added.

- [ ] **Grow the illustration library and add an in-editor picker.**
  - Scope: add more `public/graphics.js` keys (offside, penalty, throw-in, corner, advantage signal, substitution) and a
    small picker in the module editor so an author can see and choose a graphic by key instead of typing it.
  - Done when: new keys render in both themes and the picker inserts the chosen key; preview checked.

- [ ] **Real video in `videoDecision` blocks.**
  Today it always renders the described-scene fallback.
  - Scope: let the block carry a Vimeo/Bunny URL and play it inline (reuse the slideshow video-gate logic), keeping the
    described-scene fallback when there's no clip or the embed is blocked. `public/app.js` + `lib/moduledoc.js`.
  - Done when: a `videoDecision` with a clip plays it; without one it falls back; test added.

- [ ] **Fix `gateRevealBehindSubmit` in the legacy MOD1 (SCORM) module.**
  - Why: the user flagged that in the old module the answer stays selectable while the lesson payoff is visible.
  - Scope: the legacy module/SCORM player path only — do not touch the new block player, which already does this right.
  - Done when: in MOD1, selecting an answer locks it before the explanation shows; test or documented manual check.

- [ ] **Mobile polish for the module player.**
  - Scope: `public/styles.css` `.gmr-nav` / `.gmr-rail` at phone width — keep the nav usable, the rail legible,
    and nothing overflowing. `public/app.js` only if needed.
  - Done when: the player looks right at ~390px with no horizontal scroll; checked on a small viewport.

- [ ] **Dashboard tile: interactive-module assessment pass rate.**
  - Depends on the first item (scores recorded). Add a KPI/tile summarizing pass rate across module lessons.
  - Scope: `public/app.js` dashboard + `server.js` overview aggregation.
  - Done when: the tile shows a real number and a test covers the aggregation.

---

## Done
- [x] **Wire the block player into the platform as the `module` lesson type.** `lib/moduledoc.js` normalizer,
  `server.js` `buildLesson` + validation, `public/app.js` `renderModuleLesson`, `public/styles.css` `.gmr-*`,
  sample at `public/samples/card-mechanics.module.json`, tests in `tests/module-lesson.spec.js`.
- [x] **OMG demo branding + font.** Solid white GetMatchReady wordmark (no off-brand yellow) and clean Public Sans
  in the standalone demo player.
- [x] **Drawn illustrations.** Shared `public/graphics.js` SVG library (card height, flag angles, field position, free
  kick, confrontation, bench, whistle) replaces the blank "Visual" placeholder; blocks reference one with `graphic`.
- [x] **Step-circle progress.** The module rail is now numbered step circles (done/current/upcoming) with a connector.
- [x] **Real referee photos.** A diverse studio-photo set (`public/media/signals/`, generated via Canva) renders for the
  referee-signal `graphic` keys, with the SVG diagram as automatic fallback. `public/graphics.js` holds the photo manifest.
- [x] **Tent Talk / information-session format.** A module with no assessment reads as an info session (no pass mark,
  completion on read-through + acknowledgment). Shipped the AR-flag-mechanics Tent Talk template and a second
  "Load template" button in the Course Designer.
