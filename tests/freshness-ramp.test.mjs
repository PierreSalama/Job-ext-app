// Newest-first freshness ramp: start at the NARROWEST tier (last 1h) and widen only when
// a (board,keyword,location) scan finds 0 NEW jobs — capping at 7d so the queue stays fed.
// Pure helper in extension/lib/freshness.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FRESHNESS_TIERS, NARROWEST_TIER, WIDEST_TIER, nextFreshnessTier, tierToIndeedDays } from '../extension/lib/freshness.js';

test('the ladder is the documented newest-first set, narrowest→widest', () => {
  assert.deepEqual(FRESHNESS_TIERS, [3600, 7200, 14400, 28800, 86400, 604800]);
  assert.equal(NARROWEST_TIER, 3600);
  assert.equal(WIDEST_TIER, 604800);
});

test('new jobs KEEP the current (narrow) tier — keep hammering fresh', () => {
  assert.equal(nextFreshnessTier(3600, true), 3600);
  assert.equal(nextFreshnessTier(86400, true), 86400);
  assert.equal(nextFreshnessTier(604800, true), 604800);
});

test('a dry scan (0 new) widens to the next tier, one step at a time', () => {
  assert.equal(nextFreshnessTier(3600, false), 7200);
  assert.equal(nextFreshnessTier(7200, false), 14400);
  assert.equal(nextFreshnessTier(14400, false), 28800);
  assert.equal(nextFreshnessTier(28800, false), 86400);
  assert.equal(nextFreshnessTier(86400, false), 604800);
});

test('at the widest tier a dry scan STAYS at 7d (never wider, queue stays fed)', () => {
  assert.equal(nextFreshnessTier(604800, false), 604800);
});

test('an unknown / out-of-ladder current value snaps back to the narrowest', () => {
  assert.equal(nextFreshnessTier(999, false), 3600);
  assert.equal(nextFreshnessTier(undefined, true), 3600);
  assert.equal(nextFreshnessTier(0, false), 3600);
});

test('a full dry ramp climbs 1h→7d then stays', () => {
  let t = NARROWEST_TIER;
  const path = [t];
  for (let i = 0; i < FRESHNESS_TIERS.length + 2; i++) { t = nextFreshnessTier(t, false); path.push(t); }
  // First 5 steps climb the ladder; thereafter it's pinned at the widest.
  assert.deepEqual(path.slice(0, 6), [3600, 7200, 14400, 28800, 86400, 604800]);
  assert.ok(path.slice(6).every((x) => x === 604800), 'pinned at 7d once exhausted');
});

test('Indeed day-mapping clamps sub-day tiers to 1, floors the rest', () => {
  assert.equal(tierToIndeedDays(3600), 1);     // 1h → 1 day (Indeed has no sub-day)
  assert.equal(tierToIndeedDays(28800), 1);    // 8h → 1 day
  assert.equal(tierToIndeedDays(86400), 1);    // exactly 24h → 1 day
  assert.equal(tierToIndeedDays(604800), 7);   // 7d → 7 days
});
