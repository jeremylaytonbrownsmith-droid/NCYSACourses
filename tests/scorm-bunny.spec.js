// When a module's video has been offloaded to Bunny, its local copy is deleted.
// If the package later loses its .cdn marker (e.g. the app's disk is reset on a
// redeploy while the video lives safely in Bunny), the player still asks us for
// the local file. Rather than 404 a video that exists in Bunny, the server
// redirects the request to the Bunny CDN copy — so playback keeps working with
// no re-upload. These tests boot a Bunny-configured server on its own port.
const { test, expect } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = 3199;
const CDN_HOST = 'ncysa-modules.b-cdn.net';
let proc, tmp;

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET' }, (res) => {
      res.resume(); // drain
      resolve({ status: res.statusCode, location: res.headers.location || '' });
    });
    req.on('error', reject);
    req.end();
  });
}

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-'));
  const scormDir = path.join(tmp, 'scorm');
  // A package on disk WITHOUT its video (offloaded to Bunny), with an image present.
  fs.mkdirSync(path.join(scormDir, 'vidpkg', 'media'), { recursive: true });
  fs.writeFileSync(path.join(scormDir, 'vidpkg', 'manifest.js'), 'var ITEMS=["i","v"];var TITLES=["A","B"];');
  fs.writeFileSync(path.join(scormDir, 'vidpkg', 'media', 'item-001.jpg'), 'IMG');
  // note: media/item-002.mp4 intentionally absent (it's in Bunny)

  proc = spawn('node', ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      DATA_DIR: path.join(tmp, 'data'),
      SCORM_DIR: scormDir,
      PORT: String(PORT),
      BUNNY_STORAGE_ZONE: 'ncysa-modules',
      BUNNY_STORAGE_HOST: 'ny.storage.bunnycdn.com',
      BUNNY_STORAGE_KEY: 'test-key',
      BUNNY_CDN_HOST: CDN_HOST,
    },
    stdio: 'ignore',
  });
  // Wait for it to accept connections.
  const deadline = Date.now() + 30000;
  for (;;) {
    try { await get('/api/courses'); break; } catch (e) {
      if (Date.now() > deadline) throw new Error('bunny test server did not start');
      await new Promise((r) => setTimeout(r, 300));
    }
  }
});

test.afterAll(async () => {
  if (proc) proc.kill('SIGKILL');
  if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
});

test('a missing video redirects to the Bunny CDN copy', async () => {
  const r = await get('/scorm/vidpkg/media/item-002.mp4');
  expect(r.status).toBe(302);
  expect(r.location).toBe(`https://${CDN_HOST}/vidpkg/media/item-002.mp4`);
});

test('a present local file is served directly (no redirect)', async () => {
  const r = await get('/scorm/vidpkg/media/item-001.jpg');
  expect(r.status).toBe(200);
});

test('a missing NON-video file does not redirect to Bunny (404)', async () => {
  const r = await get('/scorm/vidpkg/media/item-003.jpg');
  expect(r.status).toBe(404);
  expect(r.location).toBe('');
});
