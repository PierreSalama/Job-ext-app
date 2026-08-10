// Daily auto-apply schedule — PURE decision core (no Electron, no DB), so every rule below is
// node-testable without booting the app.
//
// Pierre's ask: turn auto-apply ON at 04:00 and OFF at 10:00 every day on the PC, and "the user can
// override it easily… it's not gonna keep retrying".
//
// THE DESIGN RULE THAT MAKES OVERRIDE WORK: the scheduler acts only on BOUNDARY CROSSINGS, at most
// once per boundary per day. It never enforces a state continuously. So if he turns auto-apply off
// at 05:00 — inside the ON window — nothing turns it back on; today's ON has already fired and the
// next action is tomorrow's. A continuously-enforcing scheduler would fight him every minute, which
// is exactly what he said he does not want.
//
// Two independent off-switches, both instant:
//   • schedule.enabled = false  → the scheduler stops acting at all
//   • toggling auto-apply itself → respected until the next boundary
//
// Times are LOCAL "HH:MM". Comparing local wall-clock strings means DST shifts need no special
// handling: 04:00 local is 04:00 local on both sides of the change.

// Parse "HH:MM" → minutes since local midnight, or null if malformed. A bad value must disable the
// schedule rather than throw or silently behave as 00:00.
function parseHHMM(s) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(s || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// Local date key (YYYY-MM-DD) — the "once per day" ledger. Local, not UTC, so a 04:00 boundary
// belongs to the day Pierre would call it.
function dateKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function minutesOfDay(d) { return d.getHours() * 60 + d.getMinutes(); }

// Is `now` inside the ON window? Handles a window that wraps midnight (on 22:00 → off 06:00).
function inWindow(nowMin, onMin, offMin) {
  if (onMin === offMin) return false;              // zero-length window: never on
  return onMin < offMin
    ? (nowMin >= onMin && nowMin < offMin)         // same-day window, e.g. 04:00–10:00
    : (nowMin >= onMin || nowMin < offMin);        // wraps midnight, e.g. 22:00–06:00
}

/**
 * Decide what the schedule should do right now.
 *
 * @param {object} schedule  { enabled, onAt, offAt, lastOnDate, lastOffDate }
 * @param {Date}   now
 * @returns {{action:'on'|'off'|null, reason:string, lastOnDate?:string, lastOffDate?:string}}
 *          `action` null means DO NOTHING — which is the answer most of the time, and is what keeps
 *          a manual override from being stomped. When non-null, the caller applies the change and
 *          persists the returned ledger field.
 */
function decideSchedule(schedule, now = new Date()) {
  const s = schedule || {};
  if (!s.enabled) return { action: null, reason: 'schedule-disabled' };

  const onMin = parseHHMM(s.onAt);
  const offMin = parseHHMM(s.offAt);
  if (onMin == null || offMin == null) return { action: null, reason: 'invalid-times' };
  if (onMin === offMin) return { action: null, reason: 'zero-length-window' };

  const today = dateKey(now);
  const nowMin = minutesOfDay(now);
  const isOn = inWindow(nowMin, onMin, offMin);

  // ON — fire once per day, and ALSO catch up: if the machine was asleep at 04:00 and boots at
  // 06:00 we are still inside the window and today's ON has not happened, so fire it now. Outside
  // the window we never fire ON, so booting at 11:00 does not start applying unexpectedly.
  if (isOn && s.lastOnDate !== today) {
    return { action: 'on', reason: 'window-start', lastOnDate: today };
  }

  // OFF — fire once per day, only after the window has actually ended today. `!isOn` alone is not
  // enough: before 04:00 we are also "not in the window", and firing OFF then would burn today's
  // OFF before the ON has even happened.
  if (!isOn && nowMin >= offMin && s.lastOffDate !== today && onMin < offMin) {
    return { action: 'off', reason: 'window-end', lastOffDate: today };
  }
  // Wrapping window (on 22:00 → off 06:00): the window ends in the MORNING, so "past offAt" is only
  // meaningful before the evening start.
  if (!isOn && onMin > offMin && nowMin >= offMin && nowMin < onMin && s.lastOffDate !== today) {
    return { action: 'off', reason: 'window-end', lastOffDate: today };
  }

  return { action: null, reason: isOn ? 'inside-window-already-handled' : 'outside-window-already-handled' };
}

module.exports = { decideSchedule, parseHHMM, dateKey, inWindow, minutesOfDay };
