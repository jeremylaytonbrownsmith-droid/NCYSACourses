# Scaling module video to a CDN

**Status:** plan (not yet implemented). Current setup — SCORM packages served
from the Render disk — is fine for launch and early rollout. This is the one
change needed before video streaming to *thousands* of referees.

## The problem
Each SCORM module has an embedded video. Because SCORM plays same-origin, those
videos are currently served **through the Render web service**. At scale, two
things bite:

1. **Bandwidth cost.** Render bills egress at ~**$0.15/GB** after the plan
   allowance. Rough math: 1,000 referees × 8 modules × ~100 MB ≈ **800 GB/mo ≈
   ~$120/mo**, and it grows linearly with referees. Video is ~95% of that bytes.
2. **Delivery quality.** A single Render instance is not a video-optimized,
   globally-cached origin. A real CDN starts faster and streams smoother,
   especially on phones at fields.

## The constraint that shapes the design
SCORM 1.2 finds the LMS by reading `window.parent.API`. The browser only allows
that when the module's **launch HTML is same-origin** with our app. So the
**HTML/JS/CSS shell must stay same-origin** (on Render). Good news: the **video
is just a media file** the HTML points at — cross-origin media loads fine (only
parent-*property* access is blocked). So we can move the heavy part (video) to a
CDN while keeping the tiny shell where it is.

## Recommended approach — hybrid (shell same-origin, video on CDN)
Keep the package shell (HTML/JS/CSS + images) on the Render disk exactly as now.
Move only the large media (the `.mp4`s) to a CDN, and rewrite the package's
references to point at the CDN URL.

**At upload time, extend `POST /api/admin/scorm` to:**
1. Unzip as today.
2. For each large media file (e.g. `*.mp4` over ~2 MB), upload it to the CDN
   (Bunny Storage) via its API and get back the CDN URL.
3. Rewrite references so the shell loads the video from the CDN. In these
   packages the media path is built in `index.html`/`manifest.js` as
   `media/item-NNN.mp4`; simplest is to store a small per-package URL map and
   have a tiny shim rewrite `media/*.mp4` → CDN URL at play time (a few lines
   injected into the served `index.html`), so we never mutate the vendor's JS.
4. Serve everything else same-origin as today.

**Result:** the video bytes leave Render entirely; only the ~KB shell + images
come from us. Render bandwidth drops ~90%+.

## Cost comparison (video delivery)
| | Render egress | Bunny CDN |
|---|---|---|
| Per GB | ~$0.15 | ~$0.005–0.01 |
| 800 GB/mo | ~$120 | **~$4–8** |
| Global caching / video tuning | no | yes |

Storage of the videos on Bunny is ~$0.01/GB/mo (a few cents for 8 modules).

## Alternative (bigger, only if we ever fully leave Render for packages)
Serve the **whole** package from a CDN and replace the `window.parent.API`
discovery with a **postMessage bridge** (a small SCORM API adapter in the
iframe that talks to our parent cross-origin). More robust for a 100%-CDN
setup, but a larger rewrite. Not needed for the hybrid approach above.

## What's required to implement
- A **Bunny account** with a Storage zone + CDN pull zone, and an **API key**
  (stored as a Render env var, never committed).
- ~Half a day to add the upload-time offload + play-time URL shim, plus a
  re-run of the bulk upload so existing modules get their videos moved.
- No learner-facing change; the anti-skip time gate and completion tracking are
  unaffected (they don't touch the video bytes).

## Phasing
- **Now → launch (WRAL 115 + early rollout):** stay on Render Standard + disk.
  Watch the bandwidth number in Render's metrics.
- **Before the statewide push (thousands):** implement the hybrid CDN offload.
  Trigger point: when monthly egress approaches the plan allowance, or the
  referee count crosses a few hundred active per month.
