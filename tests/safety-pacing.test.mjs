// The adaptive pace (app/src/safety.js). The live bug this proves fixed: LinkedIn ran
// minApplyGapMinutes=4 under appliesPerHour=4, so it fired four applies in twenty minutes and then
// sat dark for forty, every hour — and spent its 40/day allowance long before the day was over.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const safety = require('../app/src/safety.js');

const MIN = 60000;
// The laptop's real LinkedIn config as of 2026-08-21, with the new ceiling.
const LINKEDIN = {
  role: 'primary', appliesPerDay: 40, appliesPerHour: 4, minApplyGapMinutes: 4,
  searchesPerDay: 24, searchesPerHour: 3, minSearchGapMinutes: 20,
  quietStart: '23:00', quietEnd: '07:00', jitterPct: 0.4, maxGapMinutes: 45,
};
const at = (h, m = 0) => new Date(2026, 7, 21, h, m, 0, 0);
const counts = (applyDay, applyHour = 0) => ({ apply: { day: applyDay, hour: applyHour }, search: { day: 0, hour: 0 } });

test('active window: 23:00-07:00 leaves 16h a day, and the right slice of it remaining', () => {
  assert.equal(safety.activeMsPerDay(LINKEDIN), 16 * 60 * MIN);
  assert.equal(safety.activeMsRemaining(at(7, 0), LINKEDIN), 16 * 60 * MIN);
  assert.equal(safety.activeMsRemaining(at(15, 0), LINKEDIN), 8 * 60 * MIN);
  assert.equal(safety.activeMsRemaining(at(23, 30), LINKEDIN), 0);
});

test('no quiet window configured falls back to the whole rolling day', () => {
  const cfg = { ...LINKEDIN, quietStart: '00:00', quietEnd: '00:00' };
  assert.equal(safety.activeMsPerDay(cfg), safety.DAY_MS);
  assert.equal(safety.activeMsRemaining(at(3, 0), cfg), safety.DAY_MS);
});

test('pace spreads the DAY, not just the hour — 40 applies over 16h is ~24 min apart', () => {
  const ms = safety.paceGapMs({ cfg: LINKEDIN, kind: 'apply', counts: counts(0), now: at(7, 0) });
  assert.equal(Math.round(ms / MIN), 24);
  assert.ok(ms > safety.HOUR_MS / LINKEDIN.appliesPerHour, 'the slower of the two constraints must win');
});

test('pace is self-correcting: a slow morning speeds the rest of the day up', () => {
  const behind = safety.paceGapMs({ cfg: LINKEDIN, kind: 'apply', counts: counts(5), now: at(15, 0) });
  const ahead = safety.paceGapMs({ cfg: LINKEDIN, kind: 'apply', counts: counts(30), now: at(15, 0) });
  assert.ok(behind < ahead, 'being behind must pace faster than being ahead');
  // 35 left over 8 active hours is 13.7 min, but the hourly constraint (60/4 = 15 min) is slower,
  // and the slower one wins — being behind can never make us breach the hourly allowance.
  assert.equal(behind, safety.HOUR_MS / 4);
  assert.equal(ahead, 45 * MIN);
});

test('the ceiling stops a nearly-spent budget from looking dead', () => {
  const ms = safety.paceGapMs({ cfg: LINKEDIN, kind: 'apply', counts: counts(39), now: at(14, 0) });
  assert.equal(ms, 45 * MIN);
});

test('a spent budget paces on the hour only — the daily brake does the refusing', () => {
  const ms = safety.paceGapMs({ cfg: LINKEDIN, kind: 'apply', counts: counts(40), now: at(14, 0) });
  assert.equal(ms, safety.HOUR_MS / 4);
});

test('searches are NOT paced — a discovery sweep is a batch and must stay one', () => {
  // One tick fans combosPerTick combos across every board at once (discovery/index.js scanCombo),
  // asking the governor per outbound search. Pacing there refuses every member of the batch but the
  // first — which is exactly what tests/discovery-provider.test.mjs caught. The search lane is
  // spaced by its own budgets and by discovery.intervalMinutes instead.
  assert.equal(safety.paceGapMs({ cfg: LINKEDIN, kind: 'search', counts: { search: { day: 0, hour: 0 } }, now: at(7, 0) }), 0);
  // ...so a search still falls back to its plain min-gap floor.
  const s = { enabled: true, platforms: { linkedin: LINKEDIN } };
  const now = at(9, 0);
  const d = safety.decideTouch({
    safety: s, platform: 'linkedin', kind: 'search',
    counts: { search: { day: 1, hour: 1 }, apply: { day: 0, hour: 0 } },
    lastTouchAt: now.getTime() - 25 * MIN, now, rng: () => 0.5,
  });
  assert.equal(d.ok, true, '25 min after the last search clears the 20-min floor');
});

test('a zero floor with unbounded budgets means genuinely no throttle (batch-safe)', () => {
  // The shape tests grant themselves for mechanics work: role primary, huge budgets, zero gap.
  const wide = { role: 'primary', searchesPerDay: 1e5, searchesPerHour: 1e5, minSearchGapMinutes: 0,
    appliesPerDay: 1e5, appliesPerHour: 1e5, minApplyGapMinutes: 0, quietStart: '00:00', quietEnd: '00:00', jitterPct: 0.4 };
  const s = { enabled: true, platforms: { indeed: wide } };
  const now = at(12, 0);
  const d = safety.decideTouch({
    safety: s, platform: 'indeed', kind: 'search',
    counts: { search: { day: 3, hour: 3 }, apply: { day: 0, hour: 0 } },
    lastTouchAt: now.getTime() - 1, now,
  });
  assert.equal(d.ok, true, 'back-to-back searches in one sweep must not be refused');
});

test('pace jitter is symmetric — the mean stays on target so the budget still lands', () => {
  const target = 24 * MIN;
  let sum = 0; let min = Infinity; let max = 0;
  for (let i = 0; i < 2000; i++) {
    const v = safety.jitteredPaceMs(target, 4 * MIN, 0.4, () => i / 2000);
    sum += v; min = Math.min(min, v); max = Math.max(max, v);
  }
  assert.ok(Math.abs(sum / 2000 - target) < target * 0.01, `mean ${sum / 2000} should sit on ${target}`);
  assert.ok(min < target && max > target, 'jitter must go both ways, not just slower');
});

test('pace jitter never breaches the hard floor', () => {
  for (let i = 0; i <= 20; i++) {
    assert.ok(safety.jitteredPaceMs(1 * MIN, 4 * MIN, 2, () => i / 20) >= 4 * MIN);
  }
});

test('decideTouch uses the pace, not the bare floor — no more 4-in-20-minutes bursts', () => {
  const s = { enabled: true, platforms: { linkedin: LINKEDIN } };
  const now = at(9, 0);
  const d = safety.decideTouch({
    safety: s, platform: 'linkedin', kind: 'apply', counts: counts(5),
    lastTouchAt: now.getTime() - 6 * MIN, now, rng: () => 0.5,
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'min-gap');
  assert.ok(d.requiredGapMs > 6 * MIN);
  assert.equal(d.floorMs, 4 * MIN);
});

test('decideTouch still allows a touch once the paced gap has elapsed', () => {
  const s = { enabled: true, platforms: { linkedin: LINKEDIN } };
  const now = at(9, 0);
  const d = safety.decideTouch({
    safety: s, platform: 'linkedin', kind: 'apply', counts: counts(5),
    lastTouchAt: now.getTime() - 90 * MIN, now, rng: () => 0.5,
  });
  assert.equal(d.ok, true);
  assert.ok(d.paceMs > 0 && d.gapMs > 0);
});

test('the hard brakes still win over the pace', () => {
  const s = { enabled: true, platforms: { linkedin: LINKEDIN } };
  assert.equal(safety.decideTouch({ safety: s, platform: 'linkedin', kind: 'apply', counts: counts(40), lastTouchAt: 0, now: at(14, 0) }).reason, 'daily-budget');
  assert.equal(safety.decideTouch({ safety: s, platform: 'linkedin', kind: 'apply', counts: counts(0), lastTouchAt: 0, now: at(2, 0) }).reason, 'quiet-hours');
  assert.equal(safety.decideTouch({ safety: { enabled: true, platforms: { linkedin: { ...LINKEDIN, role: 'none' } } }, platform: 'linkedin', kind: 'apply', counts: counts(0), now: at(14, 0) }).reason, 'not-this-node');
});

test('a caller re-asking with its stored requiredGapMs gets a stable answer', () => {
  const s = { enabled: true, platforms: { linkedin: LINKEDIN } };
  const now = at(9, 0);
  const first = safety.decideTouch({ safety: s, platform: 'linkedin', kind: 'apply', counts: counts(5), lastTouchAt: now.getTime() - MIN, now });
  const again = safety.decideTouch({ safety: s, platform: 'linkedin', kind: 'apply', counts: counts(5), lastTouchAt: now.getTime() - MIN, now, requiredGapMs: first.requiredGapMs });
  assert.equal(again.requiredGapMs, first.requiredGapMs);
});

// ---- the two clocks -------------------------------------------------------------------------
// The floor is measured against ALL traffic (refunded page views included); the pace only against
// real applications. Collapsing them onto one clock makes the refund cosmetic — see decideTouch.

test('a refunded page view costs only the FLOOR, not a full paced gap', () => {
  const s = { enabled: true, platforms: { linkedin: LINKEDIN } };
  const now = at(9, 0);
  // Last traffic 5 min ago (an external posting we peeked at and refunded); last real application
  // 40 min ago. Floor (4 min) is satisfied, pace (~24 min) is satisfied → dispatch.
  const d = safety.decideTouch({
    safety: s, platform: 'linkedin', kind: 'apply', counts: counts(5),
    lastTouchAt: now.getTime() - 5 * MIN, lastApplyAt: now.getTime() - 40 * MIN, now, rng: () => 0.5,
  });
  assert.equal(d.ok, true, 'a peek must not burn a whole paced interval of wall-clock');
});

test('the floor still holds against back-to-back page views', () => {
  const s = { enabled: true, platforms: { linkedin: LINKEDIN } };
  const now = at(9, 0);
  const d = safety.decideTouch({
    safety: s, platform: 'linkedin', kind: 'apply', counts: counts(5),
    lastTouchAt: now.getTime() - 60000, lastApplyAt: now.getTime() - 40 * MIN, now, rng: () => 0.5,
  });
  assert.equal(d.ok, false);
  assert.equal(d.against, 'floor', 'one minute after the last page load is too close, refunded or not');
});

test('a REAL application still costs the full paced gap', () => {
  const s = { enabled: true, platforms: { linkedin: LINKEDIN } };
  const now = at(9, 0);
  const d = safety.decideTouch({
    safety: s, platform: 'linkedin', kind: 'apply', counts: counts(5),
    lastTouchAt: now.getTime() - 10 * MIN, lastApplyAt: now.getTime() - 10 * MIN, now, rng: () => 0.5,
  });
  assert.equal(d.ok, false);
  assert.equal(d.against, 'pace', '10 min after a real application is inside the ~24-min pace');
});

test('omitting lastApplyAt reproduces the single-clock behaviour exactly', () => {
  const s = { enabled: true, platforms: { linkedin: LINKEDIN } };
  const now = at(9, 0);
  const d = safety.decideTouch({
    safety: s, platform: 'linkedin', kind: 'apply', counts: counts(5),
    lastTouchAt: now.getTime() - 10 * MIN, now, rng: () => 0.5,
  });
  assert.equal(d.ok, false);
  assert.equal(d.against, 'pace');
});

test('the whole point, as a sequence: peeks are cheap, applications are paced', () => {
  const s = { enabled: true, platforms: { linkedin: LINKEDIN } };
  const t0 = at(9, 0).getTime();
  let lastTouch = t0;          // a real application just happened
  let lastApply = t0;
  let dispatches = 0;
  // Walk forward a minute at a time for two hours. Two out of every three dispatches turn out to be
  // external postings (refunded); the third is a real application.
  for (let m = 1; m <= 120; m++) {
    const now = new Date(t0 + m * MIN);
    const d = safety.decideTouch({
      safety: s, platform: 'linkedin', kind: 'apply', counts: counts(5),
      lastTouchAt: lastTouch, lastApplyAt: lastApply, now, rng: () => 0.5,
    });
    if (!d.ok) continue;
    dispatches++;
    lastTouch = now.getTime();
    if (dispatches % 3 === 0) lastApply = now.getTime();   // every third one really applies
  }
  // Under one clock this could never exceed 2h / 24min = 5 dispatches. With the clocks split, the
  // peeks in between cost only the 4-minute floor, so the budget can actually be spent.
  assert.ok(dispatches > 8, `expected the peeks to be cheap, got ${dispatches} dispatches in 2h`);
  const applications = Math.floor(dispatches / 3);
  assert.ok(applications >= 3, `and real applications still paced, got ${applications}`);
});
