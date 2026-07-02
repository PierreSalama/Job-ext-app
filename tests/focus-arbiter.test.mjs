import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusArbiterDecision, FRONT_MIN_INTERVAL_MS } from '../extension/lib/focus-arbiter.js';

// The war-breaker guarantee: parallel apply windows can never both be granted the
// foreground within the min interval. This is the property that stops the freeze.

test('first request from a fresh state is granted', () => {
  const d = focusArbiterDecision({ heldWin: null, heldAt: 0 }, 10, 1000);
  assert.equal(d.grant, true);
  assert.equal(d.state.heldWin, 10);
  assert.equal(d.state.heldAt, 1000);
});

test('a DIFFERENT window competing within the interval is REFUSED (the war-breaker)', () => {
  let s = focusArbiterDecision({ heldWin: null, heldAt: 0 }, 10, 1000).state; // win 10 fronted @1000
  // win 20 asks 500ms later — well inside FRONT_MIN_INTERVAL_MS → refused, state unchanged
  const d = focusArbiterDecision(s, 20, 1500);
  assert.equal(d.grant, false);
  assert.equal(d.alreadyFront, false);
  assert.equal(d.state.heldWin, 10, 'held window is NOT stolen');
});

test('N windows hammering simultaneously → at most ONE is ever fronted per interval', () => {
  let s = { heldWin: null, heldAt: 0 };
  const now = 5000;
  let grants = 0;
  // 6 parallel windows all request front at the same instant
  for (const win of [1, 2, 3, 4, 5, 6]) {
    const d = focusArbiterDecision(s, win, now);
    s = d.state;
    if (d.grant) grants++;
  }
  assert.equal(grants, 1, 'exactly one window wins the foreground; the rest are dropped');
  assert.equal(s.heldWin, 1, 'the first requester holds it');
});

test('re-front of the ALREADY-held window inside the hold window is a no-op (no yank)', () => {
  let s = focusArbiterDecision({ heldWin: null, heldAt: 0 }, 10, 1000).state;
  const d = focusArbiterDecision(s, 10, 3000); // same window, 2s later, inside FRONT_HOLD_MS
  assert.equal(d.grant, false);
  assert.equal(d.alreadyFront, true, 'reported already-front → caller does nothing');
});

test('a window CAN take over once the interval has elapsed', () => {
  let s = focusArbiterDecision({ heldWin: null, heldAt: 0 }, 10, 1000).state;
  const d = focusArbiterDecision(s, 20, 1000 + FRONT_MIN_INTERVAL_MS + 1);
  assert.equal(d.grant, true, 'after the interval a different window may front');
  assert.equal(d.state.heldWin, 20);
});

test('force=true (human-challenge alert) always grants, even mid-interval', () => {
  let s = focusArbiterDecision({ heldWin: null, heldAt: 0 }, 10, 1000).state;
  const d = focusArbiterDecision(s, 99, 1200, { force: true });
  assert.equal(d.grant, true);
  assert.equal(d.state.heldWin, 99);
});
