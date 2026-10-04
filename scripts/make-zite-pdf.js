// Regenerate the Zite integration one-pager PDF from the live page so the two
// never drift. Run: node scripts/make-zite-pdf.js
const path = require('path');
const fs = require('fs');
const { chromium } = require('@playwright/test');

(async () => {
  const htmlPath = path.join(__dirname, '..', 'public', 'zite-integration.html');
  const outDir = path.join(__dirname, '..', 'public', 'downloads');
  const outPath = path.join(outDir, 'GetMatchReady-Zite-Integration.pdf');
  fs.mkdirSync(outDir, { recursive: true });
  const candidates = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ];
  const exe = candidates.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const page = await browser.newPage();
  await page.goto('file://' + htmlPath, { waitUntil: 'networkidle' });
  await page.evaluate(() => { document.querySelectorAll('.dlbar').forEach((e) => e.remove()); });
  await page.emulateMedia({ colorScheme: 'light' });
  try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch (e) { /* ignore */ }
  await page.waitForTimeout(400);
  await page.pdf({
    path: outPath,
    format: 'Letter',
    printBackground: true,
    margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
  });
  await browser.close();
  console.log('Wrote', outPath);
})().catch((e) => { console.error(e); process.exit(1); });
