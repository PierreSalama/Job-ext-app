// Daily auto-apply schedule — ON at 04:00, OFF at 10:00, and an override the scheduler never fights.
//
// Pierre's ask, verbatim: "schedule itself to turn on automatically at four AM every single day and
// turns back off at ten AM… and the user can override it easily. Like, me, I can easily turn that
// off and undo it. It's not gonna keep retrying or anything."
//
// The whole design turns on that last sentence. The scheduler acts ONLY on boundary crossings, at
// most once per boundary per day; it never enforces a state continuously. So turning auto-apply off
// at 05:00 sticks — today's ON has already fired, and the next scheduled action is tomorrow's.
// A continuously-enforcing scheduler would switch it back on within a minute, every minute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const { decideSchedule, parseHHMM, inWindow } = require_(path.join(here, '..', 'app', 'src', 'schedule.js'));

const at = (hh, mm, day = 9) => new Date(2026, 7, day, hh, mm, 0);   // local time, Aug 2026
const SCHED = (over = {}) => ({ enabled: true, onAt: '04:00', offAt: '10:00', lastOnDate: '', lastOffDate: '', ...over });

// ---- the happy path ---------------------------------------------------------------------------

test('turns ON at 04:00', () => {
  const v = decideSchedule(SCHED(), at(4, 0));
  assert.equal(v.action, 'on');
  assert.equal(v.lastOnDate, '2026-08-09');
});

test('turns OFF at 10:00', () => {
  const v = decideSchedule(SCHED({ lastOnDate: '2026-08-09' }), at(10, 0));
  assert.equal(v.action, 'off');
  assert.equal(v.lastOffDate, '2026-08-09');
});

test('does nothing at 03:59 — before the window', () => {
  assert.equal(decideSchedule(SCHED(), at(3, 59)).action, null);
});

test('does nothing mid-window once ON has fired', () => {
  const v = decideSchedule(SCHED({ lastOnDate: '2026-08-09' }), at(7, 0));
  assert.equal(v.action, null, 'firing again mid-window is what would fight a manual override');
});

test('does nothing after OFF has fired', () => {
  const s = SCHED({ lastOnDate: '2026-08-09', lastOffDate: '2026-08-09' });
  assert.equal(decideSchedule(s, at(11, 0)).action, null);
  assert.equal(decideSchedule(s, at(23, 59)).action, null);
});

// ---- THE OVERRIDE CASES — the point of the feature ---------------------------------------------

test('OVERRIDE: he turns it off at 05:00 → it stays off all day', () => {
  // ON already fired at 04:00, so the ledger says today is done. He switches auto-apply off.
  // Every subsequent tick until midnight must decide to do nothing.
  const s = SCHED({ lastOnDate: '2026-08-09' });
  for (const [h, m] of [[5, 1], [6, 0], [7, 30], [8, 0], [9, 59]]) {
    assert.equal(decideSchedule(s, at(h, m)).action, null,
      `${h}:${m} must not re-enable — this is the "not gonna keep retrying" requirement`);
  }
});

test('OVERRIDE: disabling the schedule stops it acting at all', () => {
  const s = SCHED({ enabled: false });
  assert.equal(decideSchedule(s, at(4, 0)).action, null);
  assert.equal(decideSchedule(s, at(10, 0)).action, null);
  assert.equal(decideSchedule(s, at(4, 0)).reason, 'schedule-disabled');
});

test('OVERRIDE: he turns it ON early at 02:00 → the 04:00 boundary does not turn it off', () => {
  // The scheduler only ever turns things ON at the start boundary; there is no "enforce off before
  // the window" rule, so an early manual start is left alone until 10:00.
  assert.equal(decideSchedule(SCHED(), at(2, 0)).action, null);
});

test('the next day starts fresh', () => {
  const s = SCHED({ lastOnDate: '2026-08-09', lastOffDate: '2026-08-09' });
  const v = decideSchedule(s, at(4, 0, 10));      // Aug 10
  assert.equal(v.action, 'on');
  assert.equal(v.lastOnDate, '2026-08-10');
});

// ---- catch-up (asleep at 04:00) ----------------------------------------------------------------

test('a machine that wakes at 06:00 inside the window still turns ON', () => {
  const v = decideSchedule(SCHED(), at(6, 0));
  assert.equal(v.action, 'on', 'the PC is asleep at 04:00 most days — without catch-up it would never start');
});

test('a machine that wakes at 11:00 does NOT turn on', () => {
  const v = decideSchedule(SCHED(), at(11, 0));
  assert.notEqual(v.action, 'on', 'booting after the window must never start applying unexpectedly');
});

test('waking at 11:00 with no ON fired still consumes the OFF boundary', () => {
  const v = decideSchedule(SCHED(), at(11, 0));
  assert.equal(v.action, 'off', 'so a node left on overnight is stopped at the right time');
});

test('OFF never fires before the window has started', () => {
  const v = decideSchedule(SCHED(), at(1, 0));
  assert.equal(v.action, null, 'firing OFF at 01:00 would burn today\'s OFF before ON had happened');
});

// ---- wrapping window (overnight) ---------------------------------------------------------------

test('a window that wraps midnight works (22:00 → 06:00)', () => {
  const s = SCHED({ onAt: '22:00', offAt: '06:00' });
  assert.equal(inWindow(23 * 60, 22 * 60, 6 * 60), true, '23:00 is inside');
  assert.equal(inWindow(2 * 60, 22 * 60, 6 * 60), true, '02:00 is inside');
  assert.equal(inWindow(12 * 60, 22 * 60, 6 * 60), false, 'midday is outside');
  assert.equal(decideSchedule(s, at(23, 0)).action, 'on');
  assert.equal(decideSchedule({ ...s, lastOnDate: '2026-08-09' }, at(8, 0)).action, 'off');
});

// ---- malformed input must never crash or misfire -----------------------------------------------

test('bad times disable the schedule instead of behaving as midnight', () => {
  for (const bad of ['', 'nope', '25:00', '04:99', '4', null, undefined, '04:0']) {
    assert.equal(parseHHMM(bad), null, `${JSON.stringify(bad)} must not parse`);
    assert.equal(decideSchedule(SCHED({ onAt: bad }), at(4, 0)).action, null);
  }
});

test('a zero-length window never turns anything on', () => {
  assert.equal(decideSchedule(SCHED({ onAt: '04:00', offAt: '04:00' }), at(4, 0)).action, null);
});

test('a missing schedule object is inert, not a crash', () => {
  assert.equal(decideSchedule(undefined, at(4, 0)).action, null);
  assert.equal(decideSchedule({}, at(4, 0)).action, null);
});

test('valid boundary times parse exactly', () => {
  assert.equal(parseHHMM('04:00'), 240);
  assert.equal(parseHHMM('10:00'), 600);
  assert.equal(parseHHMM('00:00'), 0);
  assert.equal(parseHHMM('23:59'), 1439);
});

// ---- a full simulated day, minute by minute ----------------------------------------------------

test('a whole day: exactly one ON and one OFF, and an override is never undone', () => {
  let s = SCHED();
  let enabled = false;
  let ons = 0, offs = 0;
  for (let m = 0; m < 24 * 60; m++) {
    const v = decideSchedule(s, at(Math.floor(m / 60), m % 60));
    if (v.action === 'on') { enabled = true; ons++; s = { ...s, lastOnDate: v.lastOnDate }; }
    if (v.action === 'off') { enabled = false; offs++; s = { ...s, lastOffDate: v.lastOffDate }; }
    if (m === 5 * 60) enabled = false;              // Pierre overrides at 05:00
  }
  assert.equal(ons, 1, 'exactly one ON in a day');
  assert.equal(offs, 1, 'exactly one OFF in a day');
  assert.equal(enabled, false, 'his 05:00 override survived every one of the remaining ~1140 ticks');
});
