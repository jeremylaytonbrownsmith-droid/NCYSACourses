// Notification engine.
//
// Every notification is delivered on two rails:
//   1. In-app: stored in db.notifications and surfaced in the UI
//      (learner bell + NCYSA admin dashboard).
//   2. Email: written to db.outbox AND sent for real when a mail sender is
//      configured, so the platform works out of the box with zero paid services
//      and upgrades to real email by setting environment variables.
//
// Real delivery — the app tries these in order; the first one configured wins:
//   A) SMTP (recommended): set SMTP_HOST, SMTP_USER, SMTP_PASS
//      (optional SMTP_PORT [default 587], SMTP_FROM [default SMTP_USER]).
//      Works with Google Workspace/Gmail app passwords, SendGrid, Mailgun,
//      Outlook, or any SMTP provider. Emails send from your own address.
//   B) NOTIFY_WEBHOOK_URL: each email is POSTed as JSON to this URL
//      (works with Zapier/Make/Slack incoming webhooks).
//   If neither is set, the email is still recorded in the outbox (visible on
//   the NCYSA dashboard) but not delivered — status "outbox-only".
//
//   NCYSA_NOTIFY_EMAIL  – where NCYSA completion notices go
//                         (default: education@ncysa.org placeholder)
//   PUBLIC_URL / APP_URL – the app's public address, used to build the
//                          certificate link included in the learner's email.

const { load, save, id } = require('./store');

const NCYSA_EMAIL = process.env.NCYSA_NOTIFY_EMAIL || 'education@ncysa.org';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Lazy SMTP transport — created once, only when SMTP env vars are present.
let _transport = null;
let _transportTried = false;
function smtpTransport() {
  if (_transportTried) return _transport;
  _transportTried = true;
  const { SMTP_HOST, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  try {
    const nodemailer = require('nodemailer');
    const port = Number(process.env.SMTP_PORT) || 587;
    _transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port,
      secure: port === 465, // 465 = implicit TLS; 587 = STARTTLS
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    console.log('[notifier] SMTP email delivery enabled via ' + SMTP_HOST + '.');
  } catch (e) {
    console.warn('[notifier] SMTP setup failed (' + e.message + '); email stays outbox-only.');
    _transport = null;
  }
  return _transport;
}

async function deliverExternal(mail) {
  // A) real SMTP send
  const tx = smtpTransport();
  if (tx) {
    try {
      const from = process.env.SMTP_FROM || process.env.SMTP_USER;
      await tx.sendMail({
        from: `NCYSA Learn <${from}>`,
        to: mail.to,
        subject: mail.subject,
        text: mail.body,
        html: mail.html || undefined,
      });
      return 'smtp-delivered';
    } catch (e) {
      return 'smtp-error:' + e.message;
    }
  }
  // B) webhook fallback
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

function sendEmail({ to, subject, body, html }) {
  const db = load();
  const mail = { id: id('mail'), to, subject, body, html: html || null, createdAt: new Date().toISOString(), status: 'recorded' };
  db.outbox.push(mail);
  save();
  // External delivery is best-effort and non-blocking: the completion (and its
  // outbox record) never fails or waits on a slow/broken webhook. The status is
  // updated in place once delivery resolves.
  deliverExternal(mail)
    .then((status) => { mail.status = status; save(); })
    .catch((e) => { mail.status = 'webhook-error:' + e.message; save(); });
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

  // Public certificate link (view / print / download). Uses the app's public
  // address if configured; otherwise the email points to the site generally.
  // RENDER_EXTERNAL_URL is set automatically by Render, so the link works with
  // no extra config; PUBLIC_URL/APP_URL let you override (e.g. a custom domain).
  const base = (process.env.PUBLIC_URL || process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  const certLink = base ? `${base}/#/cert/${certId}` : null;

  // 1) Learner
  notifyInApp({
    audience: 'user',
    userId: user.id,
    title: `🎉 You completed ${course.title}!`,
    body: `Congratulations, ${user.name}! Your certificate (${certId}) is ready.${scoreLine}`,
  });
  const certTextLine = certLink
    ? `View, print, or download your certificate here:\n${certLink}\n`
    : `Sign in to NCYSA Learn and open the course to view, print, or download your certificate.\n`;
  const certHtmlBtn = certLink
    ? `<p style="margin:24px 0"><a href="${certLink}" style="background:#10045a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-family:Arial,sans-serif;font-weight:bold;display:inline-block">View your certificate</a></p><p style="font-family:Arial,sans-serif;color:#6b645e;font-size:13px">Or paste this link into your browser:<br>${certLink}</p>`
    : `<p style="font-family:Arial,sans-serif">Sign in to NCYSA Learn and open the course to view, print, or download your certificate.</p>`;
  await sendEmail({
    to: user.email,
    subject: `Your NCYSA certificate — ${course.title}`,
    body:
      `Hi ${user.name},\n\nCongratulations! You have successfully completed "${course.title}" on ${when}.` +
      `${scoreLine}\n\nCertificate ID: ${certId}\n\n${certTextLine}\n— NCYSA Learn`,
    html:
      `<div style="font-family:Arial,sans-serif;color:#1d1a18;line-height:1.6;max-width:560px">` +
      `<h2 style="color:#10045a;margin:0 0 8px">Congratulations, ${escapeHtml(user.name)}!</h2>` +
      `<p style="margin:0 0 4px">You have successfully completed:</p>` +
      `<p style="font-size:18px;font-weight:bold;color:#10045a;margin:0 0 12px">${escapeHtml(course.title)}</p>` +
      `<p style="color:#3d3833;margin:0">Completed ${when}.${scoreLine}</p>` +
      `<p style="color:#6b645e;font-size:13px;margin:6px 0 0">Certificate ID: ${certId}</p>` +
      certHtmlBtn +
      `<p style="color:#6b645e;font-size:13px;margin-top:24px">North Carolina Youth Soccer Association · NCYSA Learn</p></div>`,
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
