// Unit tests for the integration isolation primitives (no server needed):
// the SSRF guard on callback URLs, per-org secret selection, and the unsafe
// claim decode used by /launch to pick the right verify secret.
const { test, expect } = require('@playwright/test');
const intg = require('../lib/integration');

test('allowedCallbackUrl fails closed on internal / private / metadata hosts', () => {
  // These must never be accepted (SSRF).
  for (const bad of [
    'http://169.254.169.254/latest/meta-data/',  // cloud metadata
    'https://10.0.0.5/hook',
    'https://192.168.1.10/hook',
    'https://172.16.5.4/hook',
    'https://[fd00::1]/hook',
    'http://example.com/hook',                   // plain http (non-loopback)
    'ftp://example.com/hook',
    'not-a-url',
  ]) {
    expect(intg.allowedCallbackUrl(bad)).toBeNull();
  }
  // A normal public HTTPS endpoint is allowed (no allow-list set in tests).
  expect(intg.allowedCallbackUrl('https://partner.example.com/hook')).toBe('https://partner.example.com/hook');
});

test('isInternalHost catches the ranges that matter', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', '169.254.169.254', '::1', 'fd12::1']) {
    expect(intg.isInternalHost(h)).toBe(true);
  }
  for (const h of ['example.com', '8.8.8.8', 'partner.example.org', '172.15.0.1', '172.32.0.1']) {
    expect(intg.isInternalHost(h)).toBe(false);
  }
});

test('secretForOrg uses a per-org secret when set, else the global secret', () => {
  const prevGlobal = process.env.INTEGRATION_SECRET;
  const prevOmg = process.env.INTEGRATION_SECRET_OMG;
  try {
    process.env.INTEGRATION_SECRET = 'global-secret';
    delete process.env.INTEGRATION_SECRET_OMG;
    expect(intg.secretForOrg('omg')).toBe('global-secret');   // falls back
    expect(intg.secretForOrg('ncysa')).toBe('global-secret');
    process.env.INTEGRATION_SECRET_OMG = 'omg-only-secret';
    expect(intg.secretForOrg('omg')).toBe('omg-only-secret'); // per-org wins
    expect(intg.secretForOrg('ncysa')).toBe('global-secret'); // other orgs unaffected
  } finally {
    if (prevGlobal === undefined) delete process.env.INTEGRATION_SECRET; else process.env.INTEGRATION_SECRET = prevGlobal;
    if (prevOmg === undefined) delete process.env.INTEGRATION_SECRET_OMG; else process.env.INTEGRATION_SECRET_OMG = prevOmg;
  }
});

test('a token signed for one org does NOT verify under another org\'s secret', () => {
  const omg = 'omg-secret-xyz';
  const ncysa = 'ncysa-secret-abc';
  const token = intg.signToken({ refId: 'R1', moduleId: 'c1', org: 'omg' }, omg, 300);
  // Reading the moduleId without verifying is fine…
  expect(intg.decodeClaims(token).moduleId).toBe('c1');
  // …verifying under the right secret works…
  expect(intg.verifyToken(token, omg).refId).toBe('R1');
  // …but under a different org's secret it is rejected (cross-tenant launch blocked).
  expect(() => intg.verifyToken(token, ncysa)).toThrow();
});
