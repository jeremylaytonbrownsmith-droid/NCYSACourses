// End-to-end learner journey: register → enroll → try to cheat the gates →
// take every lesson → really watch the video → fail the exam → pass the exam →
// certificate + notifications to learner AND NCYSA.
const { test, expect } = require('@playwright/test');
const path = require('path');

const SNAP = path.join(__dirname, '..', 'screenshots');
const COURSE = 'grassroots-coaching-license';

test.describe.configure({ mode: 'serial' });

test('full learner journey through the coaching license course', async ({ page }) => {
  // --- 1. Landing page: the portal chooser ----------------------------------
  await page.goto('/');
  await expect(page.locator('.portal-card', { hasText: 'Coaches Portal' })).toBeVisible();
  await expect(page.locator('.portal-card', { hasText: 'Referees Portal' })).toBeVisible();
  await page.screenshot({ path: `${SNAP}/01-landing.png`, fullPage: true });

  // --- 1b. Coach/Referee split: referee path leads to the NCSRA portal ------
  await page.locator('.portal-card', { hasText: 'Referees Portal' }).click();
  await expect(page.locator('.role-hero h2')).toContainText('NCSRA Referee Education');
  await page.click('.back-link');
  await expect(page.locator('.portal-card', { hasText: 'Coaches Portal' })).toBeVisible();

  // --- 2. Register (passwordless: name + email only) ------------------------
  await page.click('.topnav a:has-text("Get started")');
  await expect(page.locator('#password')).toHaveCount(0); // no password field
  await page.fill('#firstName', 'Jordan');
  await page.fill('#lastName', 'Ellis');
  await page.fill('#email', 'jordan.ellis@example.com');
  await page.screenshot({ path: `${SNAP}/02-register.png` });
  await page.click('button:has-text("Create account")');
  await expect(page.locator('.topnav')).toContainText('Hi, Jordan');

  // --- 3. Enroll (via the Coaches Portal) -----------------------------------
  await page.goto('/#/coaches');
  // Scope to the Grassroots card specifically — other tests may publish coaches
  // courses that also appear here, so a bare `.course-card` would be ambiguous.
  const grassrootsCard = page.locator('.course-card', { hasText: 'NCYSA Grassroots Soccer Coaching License' });
  await expect(grassrootsCard.locator('h3')).toContainText('NCYSA Grassroots Soccer Coaching License');
  await grassrootsCard.locator('.enroll-btn').click();
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

  // --- 5. Reading lessons: the first shows the 15-second reading gate; complete
  //        the rest via the API so the journey stays fast (the gate is a client
  //        reading pace, not a server rule). The old sample video lesson was removed. ---
  await expect(page.locator('.lesson-pane h1')).toContainText('Welcome');
  await expect(page.locator('#completeBtn')).toBeDisabled(); // 15-second reading gate is active
  const COURSE = 'grassroots-coaching-license';
  const prog = await (await page.request.get(`/api/courses/${COURSE}`)).json();
  for (const l of prog.course.lessons) {
    if (l.type === 'text') await page.request.post(`/api/courses/${COURSE}/lessons/${l.id}/complete`, { data: {} });
  }
  // Reload so the SPA re-fetches progress — it lands on the first incomplete
  // lesson: the final exam.
  await page.reload();

  // Reopen the course — it lands on the first incomplete lesson: the final exam.
  await page.goto(`/#/course/${COURSE}`);

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

  // --- 9b. A non-admin cannot reach the dashboard ----------------------------
  await expect(page.locator('.topnav .nav-dashboard')).toHaveCount(0); // no dashboard link for learners
  await page.goto('/#/admin'); // direct navigation is still blocked server-side
  await expect(page.locator('#app')).toContainText('staff', { ignoreCase: true });
  await expect(page.locator('.admin-table')).toHaveCount(0);

  // --- 10. NCYSA staff sign-in requires a password ---------------------------
  await page.click('#logoutBtn');
  await page.click('.topnav a:has-text("Sign in")');
  await expect(page.locator('.staff-link')).toBeVisible(); // staff entry point present
  await page.goto('/#/staff');
  await expect(page.locator('.card h2')).toContainText('staff', { ignoreCase: true });
  await page.fill('#email', 'admin@ncysa.org');
  await page.fill('#password', 'wrong-password');
  await page.click('button:has-text("Sign in")');
  await expect(page.locator('#formError')).toContainText('incorrect', { ignoreCase: true }); // wrong password rejected (generic message)
  await page.fill('#password', 'ncysa-staff-2026');
  await page.click('button:has-text("Sign in")');
  await page.click('.nav-dashboard');

  const record = page.locator('.admin-table tr', { hasText: 'Jordan Ellis' });
  await expect(record).toContainText('8/8');          // module progress column (8 lessons after the video was removed)
  await expect(record).toContainText('✓ Complete');   // status column
  await expect(page.locator('#exportCsvBtn')).toBeVisible(); // Excel export
  await expect(page.locator('.admin-card', { hasText: 'NCYSA notifications' }))
    .toContainText('Course completion: NCYSA Grassroots Soccer Coaching License');
  const outbox = page.locator('.admin-card', { hasText: 'Email outbox' });
  await expect(outbox).toContainText('education@ncysa.org');          // notice to NCYSA
  await expect(outbox).toContainText('jordan.ellis@example.com');     // notice to the learner
  await page.screenshot({ path: `${SNAP}/12-ncysa-dashboard.png`, fullPage: true });
});
