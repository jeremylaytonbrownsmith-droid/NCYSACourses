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

// POST a signed completion callback to the partner. Best-effort with retries so
// a brief outage on their side never loses a completion; never throws.
async function sendCompletionWebhook(payload) {
  const url = process.env.INTEGRATION_WEBHOOK_URL;
  const secret = integrationSecret();
  if (!url || !secret) return { sent: false, reason: 'not-configured' };
  const body = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-GetMatchReady-Signature': sig },
        body,
      });
      if (res.ok) return { sent: true, status: res.status };
      if (res.status < 500) return { sent: false, status: res.status }; // client error — don't retry
    } catch (e) {
      if (attempt === 3) return { sent: false, error: e.message };
    }
    await new Promise((r) => setTimeout(r, attempt * 1000));
  }
  return { sent: false, reason: 'retries-exhausted' };
}

module.exports = { signToken, verifyToken, sendCompletionWebhook, integrationEnabled, integrationSecret };
