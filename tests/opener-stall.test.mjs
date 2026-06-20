// F2 REGRESSION (apply-window hydration) — unit tests for the two pure decisions that
// guard the fix:
//   1. shouldFrontOnOpenerStall — front+retry the apply window when the Easy-Apply opener
//      was clicked but the modal never mounted, BEFORE letting the duplicate-opener breaker
//      fail the task (the keystone of the 0-submission regression).
//   2. the concurrency DEFAULT is 1 (serial) — only one apply window can be foreground/
//      un-throttled at a time, so parallel windows are throttled and don't hydrate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldFrontOnOpenerStall } from '../extension/content/lib/opener-stall.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { DEFAULTS } = require(path.join(here, '..', 'app', 'src', 'config.js'));

// A clicked opener that produced NO page change AND NO mounted modal, on the in-page
// (LinkedIn) Easy-Apply route, with no fronted retry spent yet → FRONT + RETRY.
test('opener clicked, no mount, not yet fronted → front + retry', () => {
  const d = shouldFrontOnOpenerStall({
    haveForm: false, isExternalClick: false, changed: false,
    modalMounted: false, alreadyFronted: false,
  });
  assert.equal(d.front, true);
});

test('a second stall after the fronted retry is spent → do NOT front again (defer to breaker)', () => {
  const d = shouldFrontOnOpenerStall({
    haveForm: false, isExternalClick: false, changed: false,
    modalMounted: false, alreadyFronted: true,
  });
  assert.equal(d.front, false);
  assert.equal(d.reason, 'already-fronted-retry-spent');
});

test('the modal DID mount → no front (we have a form to drive)', () => {
  const d = shouldFrontOnOpenerStall({
    haveForm: false, isExternalClick: false, changed: false,
    modalMounted: true, alreadyFronted: false,
  });
  assert.equal(d.front, false);
});

test('the page changed after the click → no front (real progress / navigation)', () => {
  const d = shouldFrontOnOpenerStall({
    haveForm: false, isExternalClick: false, changed: true,
    modalMounted: false, alreadyFronted: false,
  });
  assert.equal(d.front, false);
});

test('a form is already open → no front (this is an in-form advance, not an opener)', () => {
  const d = shouldFrontOnOpenerStall({
    haveForm: true, isExternalClick: false, changed: false,
    modalMounted: false, alreadyFronted: false,
  });
  assert.equal(d.front, false);
});

test('external/company-site CTA → no front (it has its own handoff + no-progress cap)', () => {
  const d = shouldFrontOnOpenerStall({
    haveForm: false, isExternalClick: true, changed: false,
    modalMounted: false, alreadyFronted: false,
  });
  assert.equal(d.front, false);
  assert.equal(d.reason, 'external-route-has-own-cap');
});

test('missing args are treated as the no-front default (never front blindly)', () => {
  assert.equal(shouldFrontOnOpenerStall().front, false);
  assert.equal(shouldFrontOnOpenerStall({}).front, false);
});

// F2: concurrency MUST default to 1. Parallel apply windows are all throttled except the one
// foreground window, so >1 near-zeroes hydration. The 1..8 range stays valid (advanced users
// can opt in with the strengthened warning), but the out-of-the-box value is serial.
test('autoApply.concurrency default is 1 (serial — the only fully-hydrating setting)', () => {
  assert.equal(DEFAULTS.autoApply.concurrency, 1);
});
