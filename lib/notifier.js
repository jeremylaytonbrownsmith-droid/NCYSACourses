// Notification engine.
//
// Every notification is delivered on two rails:
//   1. In-app: stored in db.notifications and surfaced in the UI
//      (learner bell + NCYSA admin dashboard).
//   2. Email: written to db.outbox. If SMTP_* / NOTIFY_WEBHOOK_URL env vars
//      are configured the outbox entry is also delivered externally, so the
//      platform works out of the box with zero paid services and upgrades to
//      real email by setting environment variables.
//
//   NCYSA_NOTIFY_EMAIL  – where NCYSA completion notices go
//                         (default: education@ncysa.org placeholder)
//   NOTIFY_WEBHOOK_URL  – optional; each email is POSTed as JSON to this URL
//                         (works with Zapier/Make/Slack incoming webhooks)

const { load, save, id } = require('./store');

const NCYSA_EMAIL = process.env.NCYSA_NOTIFY_EMAIL || 'education@ncysa.org';

async function deliverExternal(mail) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return 'outbox-only';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mail),
    });
    return res.ok ? 'webhook-delivered' : `webhook-failed:${res.status}`;
  } catch (e) {
    return 'webhook-error:' + e.message;
  }
}

async function sendEmail({ to, subject, body }) {
  const db = load();
  const mail = { id: id('mail'), to, subject, body, createdAt: new Date().toISOString() };
  mail.status = await deliverExternal(mail);
  db.outbox.push(mail);
  save();
  return mail;
}

function notifyInApp({ audience, userId, title, body }) {
  const db = load();
  const n = {
    id: id('ntf'),
    audience, // 'user' | 'ncysa'
    userId: userId || null,
    title,
    body,
    createdAt: new Date().toISOString(),
    read: false,
  };
  db.notifications.push(n);
  save();
  return n;
}

// Fired once when a learner completes a course.
async function onCourseCompleted({ user, course, certId, score }) {
  const when = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const scoreLine = score != null ? ` Final exam score: ${score}%.` : '';

  // 1) Learner
  notifyInApp({
    audience: 'user',
    userId: user.id,
    title: `🎉 You completed ${course.title}!`,
    body: `Congratulations, ${user.name}! Your certificate (${certId}) is ready.${scoreLine}`,
  });
  await sendEmail({
    to: user.email,
    subject: `Congratulations — you completed ${course.title}`,
    body:
      `Hi ${user.name},\n\nYou have successfully completed "${course.title}" on ${when}.` +
      `${scoreLine}\n\nYour certificate ID is ${certId}. You can view and print your certificate ` +
      `from your dashboard.\n\nGood luck this season, Coach!\n— NCYSA Learn`,
  });

  // 2) NCYSA
  notifyInApp({
    audience: 'ncysa',
    title: `Course completion: ${course.title}`,
    body: `${user.name} (${user.email}) completed the course on ${when}. Certificate ${certId}.${scoreLine}`,
  });
  await sendEmail({
    to: NCYSA_EMAIL,
    subject: `[NCYSA Learn] ${user.name} completed ${course.title}`,
    body:
      `Completion record\n=================\nLearner: ${user.name}\nEmail: ${user.email}\n` +
      `Course: ${course.title}\nCompleted: ${when}\nCertificate: ${certId}${scoreLine ? '\n' + scoreLine.trim() : ''}\n\n` +
      `This learner's coaching license can now be recorded.`,
  });
}

module.exports = { onCourseCompleted, notifyInApp, sendEmail, NCYSA_EMAIL };
