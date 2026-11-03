// Deadline / compliance engine — the "check" side of the platform.
//
// A course can carry a deadline (dueDays = days to finish from enrollment). Each
// enrollment then gets a dueAt. From that we derive a compliance state the
// dashboard shows, and decide which reminder emails are due — so an official who
// hasn't finished in time is nudged automatically, and anyone overdue surfaces
// before it becomes a problem. Completion itself (the "check-off" + webhook back
// to the partner's system) is handled where a course completes; this module only
// tracks it against the deadline.
//
// Pure functions, no I/O, so the rules are unit-testable on their own.

const DAY_MS = 86400000;
const DUESOON_DAYS = 3;        // "due soon" window before the deadline
const OVERDUE_RESEND_DAYS = 7; // re-nudge an overdue learner at most this often

function clampDueDays(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 0; // 0 = no deadline
  return Math.min(365, n);
}

// The deadline for an enrollment given the course's dueDays, as an ISO string
// (or null when the course has no deadline / the start time is unknown).
function computeDueAt(startedAtIso, dueDays) {
  const days = clampDueDays(dueDays);
  if (!days || !startedAtIso) return null;
  const start = new Date(startedAtIso).getTime();
  if (!Number.isFinite(start)) return null;
  return new Date(start + days * DAY_MS).toISOString();
}

// Compliance state for one enrollment. `days` is whole days until the deadline
// (negative when overdue); null when completed or there is no deadline.
//   completed | overdue | duesoon | ontrack | none
function complianceOf(enr, now = Date.now()) {
  const dueAt = (enr && enr.dueAt) || null;
  if (enr && enr.completedAt) {
    const onTime = !dueAt || new Date(enr.completedAt).getTime() <= new Date(dueAt).getTime();
    return { state: 'completed', dueAt, days: null, onTime };
  }
  if (!dueAt) return { state: 'none', dueAt: null, days: null };
  const ms = new Date(dueAt).getTime() - now;
  const days = Math.ceil(ms / DAY_MS);
  if (ms < 0) return { state: 'overdue', dueAt, days };     // days <= 0
  if (days <= DUESOON_DAYS) return { state: 'duesoon', dueAt, days };
  return { state: 'ontrack', dueAt, days };
}

// Which reminder kinds should go out for this enrollment right now, given what
// has already been sent (enr.reminders = { duesoon: iso, overdue: iso }). Returns
// a subset of ['duesoon','overdue']. Dedup rules keep it from spamming: the
// due-soon nudge sends once; the overdue nudge repeats at most weekly.
function dueReminders(enr, now = Date.now()) {
  if (!enr || enr.completedAt || !enr.dueAt) return [];
  const c = complianceOf(enr, now);
  const sent = enr.reminders || {};
  const out = [];
  if (c.state === 'duesoon' && !sent.duesoon) out.push('duesoon');
  if (c.state === 'overdue') {
    const last = sent.overdue ? new Date(sent.overdue).getTime() : 0;
    if (now - last >= OVERDUE_RESEND_DAYS * DAY_MS) out.push('overdue');
  }
  return out;
}

module.exports = {
  DAY_MS, DUESOON_DAYS, OVERDUE_RESEND_DAYS,
  clampDueDays, computeDueAt, complianceOf, dueReminders,
};
