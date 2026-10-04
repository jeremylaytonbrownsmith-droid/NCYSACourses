# Org-Scoped Partner Admin — Scope & Plan

> **STATUS: Phase 1 DONE** (backend isolation + security tests). A `partner` role
> (seeded OMG account `partner@omgtsys.com` / `OMG_PARTNER_PASSWORD`, default
> `omg-partner-2026`, env-overridable) sees/manages ONLY its org's courses + its own
> completion records; blocked (fail-closed) from other orgs' courses and from raw SCORM
> package management. Super-admin unchanged. Proven by `tests/partner-isolation.spec.js`
> (6 tests). **Still to do:** Phase 2 (lock the partner's designer/AI-builder UI to its
> org + scoped dashboard polish) and Phase 3 (self-serve API key / launch links / export)
> and package-level SCORM org-tagging (currently partners are blocked from SCORM, not
> scoped).


**Why (from the OMG/OMS call):** Dick wants to run his own side — build courses, see his
completions, manage his learners — and it must plug into his assignment pipeline (Zite).
Today that's impossible safely: **admin is a GLOBAL role.** Any admin/editor login sees
*every* org's data (NCYSA, NCSRA, OMG). Giving a partner a login = a cross-client data breach.

**Strategic value:** this is the change that turns GMR from "a tool Jeremy runs for one client"
into "a multi-tenant platform you can sell to many officials orgs." It's the #1 enabler for the
OMG deal AND for every org after it. It also makes the Zite integration a self-serve, repeatable
onboarding instead of manual work.

**Guiding principle: default-deny.** Scoping is centralized in one helper and applied at every
data endpoint; a forgotten endpoint must fail closed, not leak. Every isolation rule gets a test.

---

## Roles (target)
- `admin` — super-admin (Jeremy). Global. Sees/does everything. **Unchanged.**
- `editor` — designer (Colin). Global course designer. **Unchanged** (or optionally scoped later).
- **`partner` (NEW)** — an org-bound admin/editor. Carries `orgId` (e.g. `omg`). Sees and manages
  ONLY that org's courses, learners, completions, uploads, and integration. Never sees other orgs.
- `learner` — unchanged.

A partner is effectively "editor + dashboard, scoped to one org."

---

## Data-model additions
1. **`user.orgId`** — set for `partner` users (and optionally stamped on learners at registration
   so learner records scope cleanly). Super-admin/editor have no orgId (= global).
2. **SCORM package → orgId** — stamp the owning org on upload (`db` package metadata). Existing
   packages default to `ncysa`. Needed so Module Storage and the peek/wiring tools scope per org.
3. (Enrollments/lessonProgress already scope via `courseId → course.orgId`; no new field needed —
   but add a reusable `courseOrg(courseId)` lookup.)

---

## Core: one scoping helper
```
// null  => global (super-admin / editor): no filtering
// 'omg' => partner: restrict everything to this org
function reqOrgScope(req) {
  return req.user.role === 'partner' ? (req.user.orgId || '__none__') : null;
}
```
Plus a per-course guard for the many `/api/admin/courses/:id/...` endpoints:
```
function requireCourseInScope(req, res, course) {
  const scope = reqOrgScope(req);
  if (scope && (course.orgId || DEFAULT_ORG) !== scope) { res.status(404).json({error:'Not found'}); return false; }
  return true;
}
```

---

## Endpoints to scope (the audit — every one must be covered)
Reads:
- `GET /api/admin/overview` — filter completions/enrollments/outbox/webhooks/uploads/courses to scope.
- `GET /api/admin/courses/:id` — 404 if out of scope.
- `GET /api/admin/scorm/storage` + `/scorm/:pkg/*` (files/slides/wiring/launch/rawmedia) — scope by package org.
- Course list used by the designer (served via overview `courses` or a dedicated list) — scope.

Writes / actions:
- `POST /api/admin/courses` — force new course `orgId = scope` for partners (can't create cross-org).
- `PUT/DELETE /api/admin/courses/:id`, `/publish`, `/move`, `/slug`, lessons add/edit/delete/move,
  `/export`, `/ai-build`, image upload tied to a course — guard with `requireCourseInScope`.
- `POST /api/admin/scorm` (upload) — stamp package org = scope; partner uploads only into their org.
- `DELETE /api/admin/enrollments` — only for learners in the partner's org courses.
- `POST /api/admin/integration/test-link` — only their org's courses (API already org-locks to omg).
- `test-email`, `scorm/cleanup`, `migrate-cdn` — super-admin only (not partners).

**AI build:** partner's generated courses are forced to their org (reuse BRAND_PRESETS, lock org).

---

## UI (public/app.js)
- Partner login → Course Designer shows only their courses; "New course"/AI build force their org
  and hide the org/branding picker (locked to theirs).
- Partner dashboard (if granted): records + completions scoped to their org; reuse the existing
  Organization filter but lock it to their org and hide cross-org options.
- Hide super-admin-only controls (bulk tools, migrate-cdn, other orgs) for partners.

---

## Managing partner accounts
- A super-admin endpoint/screen to create a `partner` user bound to an org (name, email, password,
  orgId). Tie creation to the signing/kill-switch philosophy (`INTEGRATION_PUBLISH_ENABLED`) so a
  partner can't publish live until terms are signed.

---

## Phasing (ship safely, test each phase)
**Phase 1 — foundation + isolation (backend).**
- Add `partner` role + `user.orgId`; package orgId on upload (default ncysa for existing).
- Add `reqOrgScope` + `requireCourseInScope`; apply to ALL endpoints above.
- Seed a test partner account.
- Tests: partner sees only their courses; 404 on another org's course; overview excludes other orgs;
  upload lands in their org; super-admin still sees everything. (Security regression suite.)

**Phase 2 — partner UI.**
- Scoped Course Designer + dashboard; locked org/branding; hidden cross-org controls.

**Phase 3 — self-serve onboarding.**
- Partner can view/rotate their integration API key, generate launch links, and export their
  completions — so wiring Zite is hours, not weeks. (This is the sales accelerator.)

---

## Risks / must-not-break
- **Default-deny or it's a breach.** Centralize scoping; test every data endpoint.
- Super-admin (Jeremy) and editor (Colin) behavior must be **unchanged** — they stay global.
- Existing SCORM packages have no org tag → default them to `ncysa` in a one-time migration flag.
- Keep `INTEGRATION_PUBLISH_ENABLED` as the "can't go live until signed" gate for partners.

## Recommended order of value after this
1. **Partner integration kit** (Phase 3 self-serve + a "test my integration" tool) — makes Zite
   onboarding fast and repeatable; the technical close + the moat.
2. **Partner completion dashboard** feeding their assignment workflow.
3. Per-org CDN usage display (backs the "at cost" billing claim).
