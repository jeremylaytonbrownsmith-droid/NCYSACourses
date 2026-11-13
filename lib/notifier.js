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
//   A) HTTPS email API (recommended on hosts that block SMTP, e.g. Render):
//      set BREVO_API_KEY or SENDGRID_API_KEY. Sends over HTTPS (port 443), so
//      it works even where outbound SMTP is blocked. The From address is
//      EMAIL_FROM/SMTP_FROM (verify it as a "single sender" in the provider).
//   B) SMTP: set SMTP_HOST, SMTP_USER, SMTP_PASS (optional SMTP_PORT [587],
//      SMTP_FROM). Works with any SMTP provider on hosts that allow it.
//   C) NOTIFY_WEBHOOK_URL: each email is POSTed as JSON to this URL
//      (works with Zapier/Make/Slack incoming webhooks).
//   If neither is set, the email is still recorded in the outbox (visible on
//   the NCYSA dashboard) but not delivered — status "outbox-only".
//
//   NCYSA_NOTIFY_EMAIL  – where NCYSA completion notices go
//                         (default: education@ncysa.org placeholder)
//   PUBLIC_URL / APP_URL – the app's public address, used to build the
//                          certificate link included in the learner's email.

const { load, save, id } = require('./store');
const { publicBaseForOrg } = require('./integration');

const NCYSA_EMAIL = process.env.NCYSA_NOTIFY_EMAIL || 'education@ncysa.org';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The three voices an email can speak in. `org` picks the public domain the
// logo is served from (publicBaseForOrg), `logo` is the crest in the header.
const BRANDS = {
  ncsra: { short: 'NCSRA Referee Education', long: 'North Carolina Soccer Referee Association', org: 'ncsra', logo: '/media/ncsra-logo.png' },
  ncysa: { short: 'NCYSA Learn', long: 'North Carolina Youth Soccer Association', org: 'ncysa', logo: '/media/ncysa-logo.png' },
  gmr: { short: 'GetMatchReady', long: 'GetMatchReady', org: 'omg', logo: null },
};

// The one branded layout every email uses: crest + organization in a navy
// header with the red accent stripe (the site's banner), a white card for the
// content, and the "long · short" footer. Table-based with inline styles so it
// survives Gmail, Outlook and Apple Mail. `logoUrl` must be absolute.
function emailLayout({ brand, logoUrl, title, lead, contentHtml, note }) {
  const short = escapeHtml(brand.short);
  const long = escapeHtml(brand.long);
  const crest = logoUrl
    ? `<td style="vertical-align:middle;padding-right:14px"><img src="${escapeHtml(logoUrl)}" height="52" alt="${short}" style="display:block;height:52px;width:auto;border:0"></td>`
    : '';
  return (
    `<div style="margin:0;padding:24px 12px;background:#f3f5f9;font-family:Arial,Helvetica,sans-serif;color:#1d1a18">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e3e7ef;border-radius:12px;overflow:hidden">` +
    `<tr><td style="background:#10045a;padding:18px 28px;border-bottom:4px solid #b82f2f">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${crest}` +
    `<td style="vertical-align:middle;color:#ffffff">` +
    `<div style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#c9d0e6;margin:0 0 3px;line-height:1.35">${long}</div>` +
    `<div style="font-size:18px;font-weight:bold;line-height:1.2">${short}</div>` +
    `</td></tr></table></td></tr>` +
    `<tr><td style="padding:28px 28px 8px">` +
    `<h1 style="margin:0 0 8px;font-size:22px;line-height:1.3;color:#10045a">${escapeHtml(title)}</h1>` +
    (lead ? `<p style="margin:0 0 18px;font-size:16px;line-height:1.5;color:#3d3833">${escapeHtml(lead)}</p>` : '') +
    contentHtml +
    (note ? `<p style="margin:18px 0 0;font-size:13px;line-height:1.5;color:#6b645e">${escapeHtml(note)}</p>` : '') +
    `</td></tr>` +
    `<tr><td style="padding:0 28px 22px"></td></tr>` +
    `<tr><td style="padding:14px 28px;background:#f8f9fb;border-top:1px solid #e3e7ef;font-size:12px;line-height:1.5;color:#6b645e">${long} · ${short}</td></tr>` +
    `</table></td></tr></table></div>`
  );
}

// Absolute URL for a brand's crest on its own public domain (ncysalearn.app for
// NC, getmatchready.app for OMG). `requestBase` keeps dev/tests on localhost.
function brandLogoUrl(brand, requestBase) {
  if (!brand.logo) return null;
  if (/^https?:\/\//i.test(brand.logo)) return brand.logo;
  const base = publicBaseForOrg(brand.org, { requestBase });
  return base ? base + brand.logo : null;
}

// The sign-in code email: the code large and alone so it is easy to read and
// copy on a phone, with the expiry and "ignore if it wasn't you" lines under it.
function signinCodeEmail({ code, brand, requestBase }) {
  const c = String(code);
  return {
    fromName: brand.short,
    subject: `${c} is your ${brand.short} sign-in code`,
    body:
      `Your ${brand.short} sign-in code is ${c}\n\nEnter it on the sign-in page. It expires in 10 minutes and works once.\n\n` +
      `If you didn’t ask for a code, you can ignore this email — nobody can sign in without it.\n\n— ${brand.long}`,
    html: emailLayout({
      brand,
      logoUrl: brandLogoUrl(brand, requestBase),
      title: 'Your sign-in code',
      lead: 'Enter this code on the sign-in page to continue.',
      contentHtml:
        `<div style="margin:0 0 14px;padding:18px 16px;background:#f3f5f9;border:1px solid #e3e7ef;border-radius:10px;text-align:center;` +
        `font-family:'Courier New',Courier,monospace;font-size:36px;font-weight:bold;letter-spacing:.3em;color:#10045a">${escapeHtml(c)}</div>` +
        `<p style="margin:0;font-size:14px;line-height:1.5;color:#3d3833">It expires in <strong>10 minutes</strong> and works once.</p>`,
      note: 'If you didn’t ask for a code, you can ignore this email — nobody can sign in without it.',
    }),
  };
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
  const from = process.env.EMAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || NCYSA_EMAIL;

  // A) HTTPS email APIs — these work on hosts (like Render) that block outbound
  // SMTP ports, because they go over normal HTTPS (443). First configured wins.

  // Brevo (https://brevo.com) — free tier, single-sender verification.
  if (process.env.BREVO_API_KEY) {
    try {
      const url = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { email: from, name: mail.fromName || 'NCYSA Learn' },
          to: [{ email: mail.to }],
          subject: mail.subject,
          textContent: mail.body,
          ...(mail.html ? { htmlContent: mail.html } : {}),
        }),
      });
      if (res.ok) return 'brevo-delivered';
      const t = await res.text().catch(() => '');
      return `brevo-failed:${res.status}${t ? ' ' + t.slice(0, 140) : ''}`;
    } catch (e) { return 'brevo-error:' + e.message; }
  }

  // SendGrid (https://sendgrid.com) — free tier, single-sender verification.
  if (process.env.SENDGRID_API_KEY) {
    try {
      const url = process.env.SENDGRID_API_URL || 'https://api.sendgrid.com/v3/mail/send';
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + process.env.SENDGRID_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: mail.to }] }],
          from: { email: from, name: mail.fromName || 'NCYSA Learn' },
          subject: mail.subject,
          content: [
            { type: 'text/plain', value: mail.body },       // plain must come first
            ...(mail.html ? [{ type: 'text/html', value: mail.html }] : []),
          ],
        }),
      });
      if (res.ok || res.status === 202) return 'sendgrid-delivered';
      const t = await res.text().catch(() => '');
      return `sendgrid-failed:${res.status}${t ? ' ' + t.slice(0, 140) : ''}`;
    } catch (e) { return 'sendgrid-error:' + e.message; }
  }

  // B) SMTP (works on hosts that allow outbound SMTP)
  const tx = smtpTransport();
  if (tx) {
    try {
      const from = process.env.SMTP_FROM || process.env.SMTP_USER;
      await tx.sendMail({
        from: `${mail.fromName || 'NCYSA Learn'} <${from}>`,
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

// `fromName` is the display name the recipient sees ("NCSRA Referee Education
// <education@…>"); the address itself is always the configured sender.
function sendEmail({ to, subject, body, html, fromName }) {
  const db = load();
  const mail = { id: id('mail'), to, subject, body, html: html || null, fromName: fromName || null, createdAt: new Date().toISOString(), status: 'recorded' };
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

function notifyInApp({ audience, userId, title, body, kind }) {
  const db = load();
  const n = {
    id: id('ntf'),
    audience, // 'user' | 'ncysa'
    userId: userId || null,
    title,
    body,
    kind: kind || null, // 'alert' = an action-needed alert (e.g. a progress reset), kept out of the routine completion stream
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

  // Org-aware labels so a partner org's completions (e.g. OMG) aren't branded or
  // routed as NCYSA. NCYSA is the default org; anything else uses its own brand.
  const isNcysa = !course.orgId || course.orgId === 'ncysa';
  // Referee courses on the NC site belong to the North Carolina Soccer Referee
  // Association, not NCYSA — brand their emails NCSRA (subject, signature,
  // sender name, footer). A course's own certOrg still wins for the footer.
  const isNcsra = isNcysa && (course.audience === 'referees' || /ncsra/i.test(course.coBrandName || ''));
  const orgLabel = isNcsra ? 'NCSRA' : isNcysa ? 'NCYSA' : String(course.orgId).toUpperCase();
  const brand = isNcsra ? 'NCSRA Referee Education' : isNcysa ? 'NCYSA Learn' : (course.coBrandName || (orgLabel + ' Education'));
  const certAuthority = course.certOrg || (isNcsra ? 'North Carolina Soccer Referee Association' : isNcysa ? 'North Carolina Youth Soccer Association' : orgLabel);
  const orgAudience = isNcysa ? 'ncysa' : course.orgId; // keeps partner orgs out of the NCYSA dashboard
  const orgEmail = process.env[orgLabel + '_NOTIFY_EMAIL'] || (isNcysa ? NCYSA_EMAIL : (process.env.PARTNER_NOTIFY_EMAIL || NCYSA_EMAIL));
  // The email's voice: NCSRA / NCYSA crests, or a partner's own co-logo.
  const voice = isNcsra ? BRANDS.ncsra : isNcysa ? BRANDS.ncysa
    : { short: brand, long: certAuthority, org: course.orgId, logo: course.coLogoUrl || (course.orgId === 'omg' ? '/media/omg-logo.png' : null) };

  // Public certificate link (view / print / download) on the course's own
  // public domain (ncysalearn.app for NC, getmatchready.app for OMG) — the same
  // rule every learner-facing link follows. With no PUBLIC_URL (dev/tests) the
  // email points to the site generally.
  const base = publicBaseForOrg(course.orgId || 'ncysa', { requestBase: process.env.RENDER_EXTERNAL_URL || '' });
  const certLink = base ? `${base}/#/cert/${certId}` : null;
  const logoUrl = brandLogoUrl(voice, base);

  // 1) Learner
  notifyInApp({
    audience: 'user',
    userId: user.id,
    title: `🎉 You completed ${course.title}!`,
    body: `Congratulations, ${user.name}! Your certificate (${certId}) is ready.${scoreLine}`,
  });
  const certTextLine = certLink
    ? `View, print, or download your certificate here:\n${certLink}\n`
    : `Sign in to ${brand} and open the course to view, print, or download your certificate.\n`;
  const certHtmlBtn = certLink
    ? `<p style="margin:22px 0 10px"><a href="${certLink}" style="background:#10045a;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;display:inline-block">View your certificate</a></p><p style="margin:0;color:#6b645e;font-size:13px;line-height:1.5">Or paste this link into your browser:<br>${certLink}</p>`
    : `<p style="margin:18px 0 0;font-size:14px;line-height:1.5">Sign in to ${escapeHtml(brand)} and open the course to view, print, or download your certificate.</p>`;
  await sendEmail({
    to: user.email,
    fromName: brand,
    subject: `Your ${orgLabel} certificate — ${course.title}`,
    body:
      `Hi ${user.name},\n\nCongratulations! You have successfully completed "${course.title}" on ${when}.` +
      `${scoreLine}\n\nCertificate ID: ${certId}\n\n${certTextLine}\n— ${brand}`,
    html: emailLayout({
      brand: { ...voice, long: certAuthority },
      logoUrl,
      title: `Congratulations, ${user.name}!`,
      lead: 'You have successfully completed:',
      contentHtml:
        `<p style="margin:0 0 12px;font-size:18px;font-weight:bold;line-height:1.4;color:#10045a">${escapeHtml(course.title)}</p>` +
        `<p style="margin:0;font-size:14px;line-height:1.5;color:#3d3833">Completed ${escapeHtml(when)}.${escapeHtml(scoreLine)}</p>` +
        `<p style="margin:6px 0 0;font-size:13px;color:#6b645e">Certificate ID: ${escapeHtml(certId)}</p>` +
        certHtmlBtn,
    }),
  });

  // 2) The owning organization (NCYSA by default; a partner org gets its own
  //    dashboard notice and email, kept separate from NCYSA's).
  notifyInApp({
    audience: orgAudience,
    title: `Course completion: ${course.title}`,
    body: `${user.name} (${user.email}) completed the course on ${when}. Certificate ${certId}.${scoreLine}`,
  });
  await sendEmail({
    to: orgEmail,
    fromName: brand,
    subject: `[${brand}] ${user.name} completed ${course.title}`,
    body:
      `Completion record\n=================\nLearner: ${user.name}\nEmail: ${user.email}\n` +
      `Course: ${course.title}\nCompleted: ${when}\nCertificate: ${certId}${scoreLine ? '\n' + scoreLine.trim() : ''}\n\n` +
      `This learner's completion can now be recorded.`,
  });
}

// Who the platform-level test email speaks as. Real notifications are branded
// by their course/portal; the test email has neither, so it follows the address
// it is sent FROM — mail from an @ncsra.org sender signs as the referee
// association, the product domain as GetMatchReady, anything else NCYSA Learn.
function senderBrand() {
  const from = String(process.env.EMAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || NCYSA_EMAIL).trim().toLowerCase();
  const domain = from.split('@')[1] || '';
  const under = (d) => domain === d || domain.endsWith('.' + d);
  if (under('ncsra.org')) return BRANDS.ncsra;
  if (under('getmatchready.app')) return BRANDS.gmr;
  return BRANDS.ncysa;
}

// Send a test email and return the delivery status synchronously, so the admin
// can verify their mail setup (SMTP/webhook) with one click without completing
// a whole course. `requestBase` lets the crest load from the request host when
// no PUBLIC_URL is configured (dev/tests).
async function sendTestEmail(to, { requestBase = '' } = {}) {
  const db = load();
  const b = senderBrand();
  const mail = {
    id: id('mail'), to,
    fromName: b.short,
    subject: `${b.short} — test email`,
    body: `This is a test message from ${b.short}.\n\nIf you received this, email delivery is working correctly.\n\n— ${b.short}`,
    html: emailLayout({
      brand: b,
      logoUrl: brandLogoUrl(b, requestBase),
      title: 'Test email ✓',
      lead: `If you received this, ${b.short} email delivery is working correctly.`,
      contentHtml: `<p style="margin:0;font-size:14px;line-height:1.5;color:#3d3833">Sign-in codes and certificates will arrive looking like this.</p>`,
    }),
    createdAt: new Date().toISOString(), status: 'recorded',
  };
  db.outbox.push(mail);
  save();
  const status = await deliverExternal(mail);
  mail.status = status;
  save();
  return status;
}

// True when at least one real delivery path is configured (an HTTPS email API,
// SMTP, or the webhook fallback). Used by the learner sign-in code flow: with no
// way to deliver a code, production refuses to pretend, and dev/test hands the
// code back in the response instead.
function emailConfigured() {
  return !!(process.env.BREVO_API_KEY || process.env.SENDGRID_API_KEY || process.env.SMTP_HOST || process.env.NOTIFY_WEBHOOK_URL);
}

module.exports = { onCourseCompleted, notifyInApp, sendEmail, sendTestEmail, senderBrand, signinCodeEmail, emailLayout, brandLogoUrl, BRANDS, emailConfigured, NCYSA_EMAIL };
