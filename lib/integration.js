// Partner integration (e.g. OMS): a signed launch token in, a signed completion
// webhook out. This is the *interface* only — the SCORM player, resume logic,
// video handling, and completion tracking all stay server-side. A partner never
// receives any of that; they open a signed URL and receive a signed callback.
//
// Config (environment):
//   INTEGRATION_SECRET       shared secret — verifies launch tokens AND signs
//                            outbound webhooks (HMAC-SHA256).
//   INTEGRATION_WEBHOOK_URL  where completion callbacks are POSTed (optional;
//                            without it, completions are simply not pushed).
//
// The launch token is a standard JWT (HS256), so a partner can mint it with any
// off-the-shelf JWT library on their side (.NET included).

const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj) { return b64url(Buffer.from(JSON.stringify(obj))); }
function fromB64url(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

function integrationSecret() { return process.env.INTEGRATION_SECRET || ''; }
function integrationEnabled() { return !!integrationSecret(); }

// Mint a launch token (used by the admin "test link" tool, and mirrors exactly
// what a partner would generate on their side).
function signToken(payload, secret = integrationSecret(), expiresInSec = 3600) {
  if (!secret) throw new Error('INTEGRATION_SECRET is not set');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { iat: now, exp: now + expiresInSec, ...payload };
  const data = b64urlJson(header) + '.' + b64urlJson(body);
  const sig = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  return data + '.' + sig;
}

// Verify a launch token; throws on a bad signature or expiry. Returns claims.
function verifyToken(token, secret = integrationSecret()) {
  if (!secret) throw new Error('INTEGRATION_SECRET is not set');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const data = parts[0] + '.' + parts[1];
  const expected = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  const a = Buffer.from(parts[2]); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('bad signature');
  const claims = JSON.parse(fromB64url(parts[1]).toString('utf8'));
  if (claims.exp && Math.floor(Date.now() / 1000) > claims.exp) throw new Error('token expired');
  return claims;
}

// Validate an optional per-launch callback URL (carried in the launch token, so
// only a holder of the shared secret can set it). Must be HTTPS, except loopback
// which may be HTTP for local testing. If INTEGRATION_CALLBACK_ALLOWED_HOSTS is
// set (comma-separated host suffixes), the URL host must match one of them, so a
// callback can never be pointed outside the partner's own domains. Returns the
// normalized URL when allowed, otherwise null (fall back to the global webhook).
// Reject hosts that resolve to the local machine or a private network — a
// per-launch callback must never be usable to probe internal services (SSRF).
// Loopback is allowed only outside production (local testing).
function isInternalHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') return true;
  // IPv4 literal → check private/loopback/link-local ranges.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return true;             // loopback / private / this-host
    if (a === 192 && b === 168) return true;                       // private
    if (a === 172 && b >= 16 && b <= 31) return true;              // private
    if (a === 169 && b === 254) return true;                       // link-local (incl. cloud metadata 169.254.169.254)
    if (a >= 224) return true;                                     // multicast / reserved
  }
  // IPv6 unique-local / link-local.
  if (h.startsWith('fd') || h.startsWith('fc') || h.startsWith('fe80') || h === '::' ) return true;
  return false;
}

function allowedCallbackUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  const host = u.hostname.toLowerCase();
  const prod = process.env.NODE_ENV === 'production';
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  // HTTPS required; HTTP only for loopback and only off-production (local tests).
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback && !prod)) return null;
  // Fail closed on internal/private targets (SSRF), always.
  if (isInternalHost(host) && !(loopback && !prod)) return null;
  const list = (process.env.INTEGRATION_CALLBACK_ALLOWED_HOSTS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.length && !list.some((suf) => host === suf || host.endsWith('.' + suf))) return null;
  return u.toString();
}

// POST a signed completion callback to the partner. Best-effort with retries so
// a brief outage on their side never loses a completion; never throws. `url`
// defaults to the global INTEGRATION_WEBHOOK_URL, but a per-launch callback URL
// (from the launch token) overrides it so each partner tenant (e.g. an OMS
// state) can receive completions at its own endpoint.
async function sendCompletionWebhook(payload, url = process.env.INTEGRATION_WEBHOOK_URL) {
  const secret = integrationSecret();
  if (!url || !secret) return { sent: false, reason: 'not-configured' };
  const body = JSON.stringify(payload);
  const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  const meta = { signature, body, url }; // returned so callers can surface exactly what was sent (debugging)
  let lastStatus = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-GetMatchReady-Signature': signature },
        body,
      });
      lastStatus = res.status;
      if (res.ok) return { sent: true, status: res.status, ...meta };
      if (res.status < 500) return { sent: false, status: res.status, ...meta }; // client error — don't retry
    } catch (e) {
      if (attempt === 3) return { sent: false, error: e.message, ...meta };
    }
    await new Promise((r) => setTimeout(r, attempt * 1000));
  }
  // Every attempt got a 5xx (the partner's endpoint is up but erroring on the payload).
  return { sent: false, reason: 'retries-exhausted', status: lastStatus, ...meta };
}

// The reconciliation (pull) API authenticates with a per-tenant API key that is
// SEPARATE from the HMAC shared secret used to sign launch tokens and webhooks.
// Falls back to the shared secret when no distinct key is configured, so the
// endpoint keeps working until a separate key is issued.
function integrationApiKey() { return process.env.INTEGRATION_API_KEY || integrationSecret(); }

// ---- per-org isolation (opt-in, backward-compatible) ----------------------
// Each org CAN have its own launch-signing secret and pull-API key:
//   INTEGRATION_SECRET_<ORG>   e.g. INTEGRATION_SECRET_OMG
//   INTEGRATION_API_KEY_<ORG>  e.g. INTEGRATION_API_KEY_OMG
// When set, a partner holding the OMG secret/key can ONLY mint launch tokens for,
// and read completions of, OMG courses — never NCYSA/NCSRA. When unset, both fall
// back to the single global secret/key, so existing single-tenant setups (and the
// test suite) behave exactly as before.
function orgEnvSuffix(org) { return String(org || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, ''); }
function secretForOrg(org) { return process.env['INTEGRATION_SECRET_' + orgEnvSuffix(org)] || integrationSecret(); }
function apiKeyForOrg(org) { return process.env['INTEGRATION_API_KEY_' + orgEnvSuffix(org)] || null; }

// Decode a token's claims WITHOUT verifying the signature — used only to read the
// moduleId so the caller can pick the right per-org secret to verify against.
// Never trust the result until verifyToken() succeeds with that secret.
function decodeClaims(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  return JSON.parse(fromB64url(parts[1]).toString('utf8'));
}

// Map a raw SCORM 1.2 cmi.core.lesson_status to the terminal set we report.
// Returns null for non-terminal / unknown values (browsed, not attempted, …).
function mapScormStatus(s) {
  switch (String(s || '').toLowerCase().trim()) {
    case 'passed': return 'passed';
    case 'failed': return 'failed';
    case 'completed': return 'completed';
    case 'incomplete': return 'incomplete';
    default: return null;
  }
}

// Build the score object for a webhook / reconciliation payload from a SCORM
// score { raw, min, max }. Never guesses the scale: `percent` is null unless the
// package actually reported both min and max (with max > min). If no raw score
// was reported at all, the whole score is null (not 0).
function scoreObject(score) {
  if (!score) return null;
  const num = (v) => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);
  const raw = num(score.raw), min = num(score.min), max = num(score.max), scaled = num(score.scaled);
  // Nothing usable reported at all → null (not 0).
  if (raw == null && scaled == null) return null;
  // `scaled` (SCORM 2004 cmi.score.scaled, 0..1) means the content reported a
  // percentage; `raw` with `min`/`max` means it reported a raw score. Content
  // like Captivate reports one OR the other, never both, so we pass through
  // exactly what came in — that's how a partner tells which to use (raw scores
  // can be accumulated across lessons; a percentage cannot). `percent` is a
  // derived convenience: from `scaled` when present, else from raw + min/max.
  let percent = null;
  if (scaled != null) percent = Math.round(scaled * 100);
  else if (min != null && max != null && max > min) percent = Math.round(((raw - min) / (max - min)) * 100);
  return { raw, min, max, scaled, percent };
}

module.exports = {
  signToken, verifyToken, sendCompletionWebhook, integrationEnabled, integrationSecret,
  integrationApiKey, mapScormStatus, scoreObject, allowedCallbackUrl,
  secretForOrg, apiKeyForOrg, decodeClaims, isInternalHost,
};
