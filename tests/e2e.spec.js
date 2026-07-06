// End-to-end learner journey: register → enroll → try to cheat the gates →
// take every lesson → really watch the video → fail the exam → pass the exam →
// certificate + notifications to learner AND NCYSA.
const { test, expect } = require('@playwright/test');
const path = require('path');

const SNAP = path.join(__dirname, '..', 'screenshots');
const COURSE = 'grassroots-coaching-license';

test.describe.configure({ mode: 'serial' });

test('full learner journey through the coaching license course', async ({ page }) => {
  // --- 1. Landing page ------------------------------------------------------
  await page.goto('/');
  await expect(page.locator('.hero h1')).toContainText('Coaching education');
  await expect(page.locator('.course-card h3')).toContainText('NCYSA Grassroots Soccer Coaching License');
  await page.screenshot({ path: `${SNAP}/01-landing.png`, fullPage: true });

  // --- 1b. Coach/Referee split: referee path leads to its own page ----------
  await expect(page.locator('.role-card', { hasText: 'Coaches go here' })).toBeVisible();
  await page.locator('.role-card', { hasText: 'Referees go here' }).click();
  await expect(page.locator('.notice-card')).toContainText('Referee courses are coming soon');
  await page.click('.back-link');
  await expect(page.locator('.hero h1')).toBeVisible();

  // --- 2. Register (passwordless: name + email only) ------------------------
  await page.click('.topnav a:has-text("Get started")');
  await expect(page.locator('#password')).toHaveCount(0); // no password field
  await page.fill('#name', 'Jordan Ellis');
  await page.fill('#email', 'jordan.ellis@example.com');
  await page.screenshot({ path: `${SNAP}/02-register.png` });
  await page.click('button:has-text("Create account")');
  await expect(page.locator('.topnav')).toContainText('Hi, Jordan');

  // --- 3. Enroll ------------------------------------------------------------
  await page.click('.enroll-btn');
  await expect(page.locator('.curriculum')).toContainText('NCYSA Grassroots Soccer Coaching License');
  await expect(page.locator('.lesson-pane h1')).toContainText('Welcome');
  await page.screenshot({ path: `${SNAP}/03-course-player-lesson1.png`, fullPage: true });

  // --- 4. Locked lessons cannot be opened ------------------------------------
  const lockedExam = page.locator('.lesson-item.locked', { hasText: 'Final Exam' });
  await expect(lockedExam).toBeVisible();
  await lockedExam.click({ force: true });
  await expect(page.locator('#toast')).toContainText('locked');
  await expect(page.locator('.lesson-pane h1')).toContainText('Welcome'); // still on lesson 1
  await page.screenshot({ path: `${SNAP}/04-locked-lesson-blocked.png` });

  // --- 5. Complete the five reading lessons ---------------------------------
  const readings = ['Welcome', 'Role of the Grassroots Coach', 'Player Development',
                    'Player Health', 'Laws of the Game'];
  for (const title of readings) {
    await expect(page.locator('.lesson-pane h1')).toContainText(title.split(' ')[0]);
    await page.click('#completeBtn');
    await page.waitForTimeout(300);
  }

  // --- 6. The video lesson & the 58-of-60-seconds gate -----------------------
  await expect(page.locator('.lesson-pane h1')).toContainText('Training Session in Action');
  const completeBtn = page.locator('#completeBtn');
  await expect(completeBtn).toBeDisabled(); // gate closed before any watching
  await page.screenshot({ path: `${SNAP}/05-video-gate-locked.png`, fullPage: true });

  // Attempt to cheat: seek straight to the end. The player must snap back.
  await page.waitForFunction(() => document.getElementById('lessonVideo').readyState >= 1);
  await page.evaluate(() => { document.getElementById('lessonVideo').currentTime = 55; });
  await expect(page.locator('#toast')).toContainText('Skipping ahead is disabled');
  const posAfterSeek = await page.evaluate(() => document.getElementById('lessonVideo').currentTime);
  expect(posAfterSeek).toBeLessThan(2);
  await page.screenshot({ path: `${SNAP}/06-video-seek-blocked.png` });

  // Watch the video for real. (Test-only: crank playbackRate so 60s of video
  // plays in ~7.5s of wall-clock; watch-time still accrues from real playback.)
  await page.evaluate(() => {
    const v = document.getElementById('lessonVideo');
    v.muted = true;
    v.playbackRate = 8;
  });
  await page.click('#playBtn');
  await expect(page.locator('#watchLabel')).toContainText('Requirement met', { timeout: 90_000 });
  await expect(completeBtn).toBeEnabled();
  await page.screenshot({ path: `${SNAP}/07-video-gate-satisfied.png`, fullPage: true });
  await completeBtn.click();

  // --- 7. Remaining reading lessons (session design + resources) --------------
  await expect(page.locator('.lesson-pane h1')).toContainText('Play–Practice–Play');
  await page.click('#completeBtn');
  await expect(page.locator('.lesson-pane h1')).toContainText('Coaching Resources');
  await expect(page.locator('.lesson-content a', { hasText: 'Learning Center' }).first()).toBeVisible();
  await page.click('#completeBtn');

  // --- 8. Final exam: fail once, then pass ------------------------------------
  await expect(page.locator('.lesson-pane h1')).toContainText('Final Exam');
  // Wrong answers → fail
  for (const q of ['q1', 'q2', 'q3', 'q4', 'q5']) {
    await page.check(`input[name="${q}"][value="3"]`);
  }
  await page.click('button:has-text("Submit exam")');
  await expect(page.locator('.quiz-result.fail')).toContainText('try again');
  await page.screenshot({ path: `${SNAP}/08-exam-failed-retake.png` });

  // Correct answers → pass
  const key = { q1: '1', q2: '2', q3: '0', q4: '1', q5: '2' };
  for (const [q, v] of Object.entries(key)) await page.check(`input[name="${q}"][value="${v}"]`);
  await page.click('button:has-text("Submit exam")');

  // --- 9. Completion: certificate + notifications -----------------------------
  await expect(page.locator('.complete-hero h1')).toContainText('Congratulations');
  await expect(page.locator('.notice-sent')).toContainText('sent to you and to NCYSA');
  await page.screenshot({ path: `${SNAP}/09-course-complete.png`, fullPage: true });

  await page.click('text=View your certificate');
  await expect(page.locator('.certificate .learner-name')).toContainText('Jordan Ellis');
  await expect(page.locator('.certificate')).toContainText('Certificate ID NCYSA-');
  await page.screenshot({ path: `${SNAP}/10-certificate.png`, fullPage: true });

  // Learner's in-app notification (bell shows unread badge)
  await expect(page.locator('.bell .dot')).toHaveText('1');
  await page.click('#bellBtn');
  await expect(page.locator('.notif h3')).toContainText('You completed NCYSA Grassroots Soccer Coaching License');
  await page.screenshot({ path: `${SNAP}/11-learner-notification.png` });

  // --- 10. NCYSA side: dashboard, notification, and both emails ---------------
  await page.click('#logoutBtn');
  await page.click('.topnav a:has-text("Sign in")');
  await page.fill('#email', 'admin@ncysa.org');
  await page.click('button:has-text("Continue")');
  await page.click('text=NCYSA Dashboard');

  await expect(page.locator('.admin-table')).toContainText('Jordan Ellis');
  await expect(page.locator('.admin-card', { hasText: 'NCYSA notifications' }))
    .toContainText('Course completion: NCYSA Grassroots Soccer Coaching License');
  const outbox = page.locator('.admin-card', { hasText: 'Email outbox' });
  await expect(outbox).toContainText('education@ncysa.org');          // notice to NCYSA
  await expect(outbox).toContainText('jordan.ellis@example.com');     // notice to the learner
  await page.screenshot({ path: `${SNAP}/12-ncysa-dashboard.png`, fullPage: true });
});
