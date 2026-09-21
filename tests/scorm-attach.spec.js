// Reusing an already-uploaded SCORM package: an admin can attach a package that
// is already on the server to a course as a lesson, without re-uploading it.
// This is how a course is rebuilt from modules uploaded earlier (e.g. after the
// course that referenced them was deleted, leaving the packages as orphans).
const { test, expect } = require('@playwright/test');
const AdmZip = require('adm-zip');

const BASE = 'http://localhost:3100';

function scormZip(title = 'Reused Module') {
  const zip = new AdmZip();
  const manifest = `<?xml version="1.0"?>
<manifest identifier="M1" version="1.2"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <organizations default="O1"><organization identifier="O1"><title>${title}</title></organization></organizations>
  <resources>
    <resource identifier="R1" type="webcontent" adlcp:scormtype="sco" href="player.html"><file href="player.html"/></resource>
  </resources>
</manifest>`;
  zip.addFile('imsmanifest.xml', Buffer.from(manifest, 'utf8'));
  zip.addFile('player.html', Buffer.from('<!doctype html><title>SCO</title>', 'utf8'));
  return zip.toBuffer();
}

test('an already-uploaded package can be attached to a course with no re-upload', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });

  // Upload a package once.
  const up = await api.post('/api/admin/scorm?name=Reused', {
    headers: { 'content-type': 'application/zip' }, data: scormZip('Reused Module'),
  });
  const pkg = (await up.json()).packageId;
  expect(pkg).toBeTruthy();

  // Recover its launch file + title from the manifest on disk (no re-upload).
  const launch = await (await api.get(`/api/admin/scorm/${pkg}/launch`)).json();
  expect(launch.packageId).toBe(pkg);
  expect(launch.launchFile).toBe('player.html');   // read from the manifest, not assumed
  expect(launch.title).toBe('Reused Module');

  // Attach that existing package to a new course as a lesson.
  const courseId = (await (await api.post('/api/admin/courses', { data: { title: 'Reuse Target', audience: 'referees' } })).json()).course.id;
  const lesson = (await (await api.post(`/api/admin/courses/${courseId}/lessons`, {
    data: { type: 'scorm', title: launch.title, packageId: launch.packageId, launchFile: launch.launchFile },
  })).json()).lesson;
  expect(lesson.type).toBe('scorm');
  expect(lesson.packageId).toBe(pkg);
  expect(lesson.launchFile).toBe('player.html');

  // The package is now referenced (no longer an orphan), so it survives cleanup.
  const storage = await (await api.get('/api/admin/scorm/storage')).json();
  const row = (storage.packages || []).find((p) => p.packageId === pkg);
  expect(row).toBeTruthy();
  expect(row.referenced).toBe(true);
});

test('the launch endpoint 404s for a package that is not on disk', async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE });
  await api.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  expect((await api.get('/api/admin/scorm/does-not-exist/launch')).status()).toBe(404);
});
