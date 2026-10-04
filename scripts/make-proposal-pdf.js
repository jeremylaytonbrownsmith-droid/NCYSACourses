// Regenerate the proposal PDF from the live proposal.html so the two never drift.
// Loads the page from disk, reveals the gated content, and prints to PDF with
// backgrounds. Run: node scripts/make-proposal-pdf.js
const path = require('path');
const { chromium } = require('@playwright/test');

(async () => {
  const htmlPath = path.join(__dirname, '..', 'public', 'proposal.html');
  const outPath = path.join(__dirname, '..', 'public', 'downloads', 'GetMatchReady-Proposal.pdf');
  // The env ships a full Chromium (not the headless-shell Playwright defaults to),
  // so point at it explicitly.
  const fs = require('fs');
  const candidates = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ];
  const exe = candidates.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const page = await browser.newPage();
  await page.goto('file://' + htmlPath, { waitUntil: 'networkidle' });
  // Reveal the gated document (skip the access-code screen) and hide the download bar.
  await page.evaluate(() => {
    const g = document.getElementById('gate'); if (g) g.hidden = true;
    const d = document.getElementById('doc'); if (d) d.hidden = false;
    document.querySelectorAll('.dlbar').forEach((e) => e.remove());
  });
  // Force light theme for print legibility, and give web fonts a moment.
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
