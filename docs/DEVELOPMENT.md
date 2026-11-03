# Development & deploy workflow

This repo uses a **`main` + pull-request** workflow. `main` is the trunk and the
only branch anything is deployed from. Nothing lands on `main` directly — every
change arrives through a reviewed pull request.

## The loop

1. **Branch off `main`.** Use a short, descriptive, prefixed name:
   - `feature/…` — new capability (e.g. `feature/tent-talk-export`)
   - `fix/…` — bug fix (e.g. `fix/module-progress-circle`)
   - `docs/…` — docs only (e.g. `docs/dev-workflow`)
   - `chore/…` — tooling, deps, cleanup

   ```bash
   git fetch origin
   git checkout -b feature/my-change origin/main
   ```

2. **Commit** in small, self-describing steps. First line ≤ ~72 chars, imperative
   ("Add…", "Fix…"), a blank line, then the why.

3. **Push** the branch and open a PR into `main`:

   ```bash
   git push -u origin feature/my-change
   ```

4. **Run the tests** before asking for review — the PR should be green:

   ```bash
   npm test          # Playwright suite (serves the app on :3100)
   ```

5. **Review, then merge** into `main`. Prefer **Squash and merge** so `main`
   stays one clean commit per change. Delete the branch after merge.

6. **Deploy** happens from `main` (see below).

## Deploying

The app is a Node/Express server (`server.js`) that serves the SPA in `public/`.
Persistence is Firestore in production (local JSON file in dev — see `lib/store.js`).

- The host (e.g. Render) should be configured to build & deploy the **`main`**
  branch. On each merge to `main` it redeploys.
- First boot after a deploy runs the seeds/migrations in `server.js` (guarded by
  flags in the store, so they run once and never duplicate). New example courses
  — like the OMG **Card Mechanics** module — appear automatically on that first
  boot.
- Data durability requires `FIREBASE_SERVICE_ACCOUNT` (or a persistent
  `DATA_DIR`); the server logs a loud warning at boot if storage is not durable.

## Required one-time GitHub settings

These are repository-settings changes that must be made in the GitHub UI
(Settings → …), because automated tooling is not permitted to change repo
settings:

1. **Default branch → `main`** (Settings → General → Default branch).
2. **Protect `main`** (Settings → Branches → Add rule for `main`):
   - Require a pull request before merging.
   - Require status checks to pass (select the test workflow once it has run).
   - (Optional) Require the branch to be up to date before merging.

## Tests

`npm test` runs the Playwright suite against a local server on port 3100. Keep it
green; add a test with any behavior change. The module format has dedicated specs
(`tests/module-lesson.spec.js`, `tests/ai-module.spec.js`).
