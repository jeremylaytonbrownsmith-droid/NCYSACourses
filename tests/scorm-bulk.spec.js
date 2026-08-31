// Bulk SCORM upload: drop several .zip modules at once → one course, one module
// lesson per zip, in filename order — no manual Course Designer steps.
const { test, expect } = require('@playwright/test');
const AdmZip = require('adm-zip');

function scormZip(title) {
  const z = new AdmZip();
  const man = `<?xml version="1.0"?><manifest version="1.2">` +
    `<organizations default="O"><organization identifier="O"><title>${title}</title></organization></organizations>` +
    `<resources><resource type="webcontent" adlcp:scormtype="sco" href="index.html"><file href="index.html"/></resource></resources></manifest>`;
  z.addFile('imsmanifest.xml', Buffer.from(man, 'utf8'));
  z.addFile('index.html', Buffer.from('<!doctype html><title>m</title>module', 'utf8'));
  return z.toBuffer();
}

test('bulk upload builds a course with one module per zip', async ({ page }) => {
  // Sign in as the course designer (cookie is shared with page navigation).
  const login = await page.request.post('/api/login', { data: { email: 'DA@ncsoccer.org', password: 'ncysa-designer-2026' } });
  expect(login.ok()).toBeTruthy();

  await page.goto('/#/admin/courses');
  await page.click('#bulkScormBtn');

  await page.setInputFiles('#bulkFiles', [
    { name: 'Module 02.zip', mimeType: 'application/zip', buffer: scormZip('Recert Module 2') },
    { name: 'Module 01.zip', mimeType: 'application/zip', buffer: scormZip('Recert Module 1') },
    { name: 'Module 03.zip', mimeType: 'application/zip', buffer: scormZip('Recert Module 3') },
  ]);
  // Files are listed in natural filename order regardless of pick order.
  await expect(page.locator('#bulkList li')).toHaveCount(3);
  await expect(page.locator('#bulkList li').first()).toContainText('Module 01.zip');

  await page.click('#bulkStart');
  await expect(page.locator('#bulkLog')).toContainText('Done — 3 of 3', { timeout: 20000 });

  // After the auto-refresh, the new course exists with 3 module lessons in order.
  const card = page.locator('.course-admin', { hasText: 'Regional Referee Recertification' }).first();
  await expect(card).toContainText('3 lessons', { timeout: 10000 });
  await expect(card.locator('.admin-lessons li').first()).toContainText('Recert Module 1');
  await expect(card.locator('.admin-lessons li').nth(2)).toContainText('Recert Module 3');
});
