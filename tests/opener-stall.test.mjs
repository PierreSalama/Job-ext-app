// F2 REGRESSION (apply-window hydration) — unit tests for the two pure decisions that
// guard the fix:
//   1. shouldFrontOnOpenerStall — front+retry the apply window when the Easy-Apply opener
//      was clicked but the modal never mounted, BEFORE letting the duplicate-opener breaker
//      fail the task (the keystone of the 0-submission regression).
//   2. the concurrency DEFAULT is 3 (parallel) — direct live observation disproved the
//      occlusion theory: apply forms work on hidden/unfocused tabs, so parallel windows are
//      safe; the only throttled case (a /apply/ page still LOADING in a backgrounded window)
//      is mitigated by front-on-load (Fix 3). The 1..8 range stays valid (server clamps 1..3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldFrontOnOpenerStall, classifyNoChangeRoute } from '../extension/content/lib/opener-stall.js';

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

// concurrency defaults back to 1 (SERIAL) for RELIABILITY over throughput. The NEW full-page
// Easy Apply NAVIGATES to a /apply/ page that must LOAD; a backgrounded/occluded parallel
// window gets Chrome-throttled and times out ("did not hydrate on a throttled/occluded tab").
// Serial keeps the single apply window foreground so /apply/ reliably loads. The value stays
// within the 1..8 range (the server clamps the effective pool to 3) and >1 keeps the
// throttle/ban-risk confirm warning in the dashboard.
test('autoApply.concurrency default is 1 (serial — reliable full-page /apply/ load)', () => {
  assert.equal(DEFAULTS.autoApply.concurrency, 1);
  // still inside the supported range
  assert.ok(DEFAULTS.autoApply.concurrency >= 1 && DEFAULTS.autoApply.concurrency <= 8);
});

// ---- FIX 2: opening-vs-mid-flow routing for the "page did not change" path ----------
// LIVE BUG (Open Systems): a mid-flow "Review" that didn't advance (a form was already open
// this run) wrongly took the OPENER-STALL front path, consumed the one fronted retry, then
// failed "duplicate opener blocked" BEFORE the advance-blocked answer-rescan could run.
// classifyNoChangeRoute routes the no-change click so opener-stall fires ONLY in the opening
// case, and a mid-flow advance goes straight to the answer-rescan.
test('mid-flow advance (form already open) → answer-rescan, NOT opener-stall', () => {
  const d = classifyNoChangeRoute({ haveForm: true, everHadForm: true, isExternalClick: false });
  assert.equal(d.route, 'answer-rescan');
});

test('mid-flow with a momentary dialog drop (haveForm false but everHadForm true) → still answer-rescan', () => {
  // The React transition after a Review click can briefly drop the dialog. everHadForm keeps
  // it routed as mid-flow so the click is never mis-handled as a fresh opener.
  const d = classifyNoChangeRoute({ haveForm: false, everHadForm: true, isExternalClick: false });
  assert.equal(d.route, 'answer-rescan');
  assert.equal(d.reason, 'mid-flow-advance');
});

test('opening click (no form ever opened this run) → opener-stall', () => {
  const d = classifyNoChangeRoute({ haveForm: false, everHadForm: false, isExternalClick: false });
  assert.equal(d.route, 'opener-stall');
});

test('external click → external route (its own handoff + no-progress cap own it)', () => {
  const d = classifyNoChangeRoute({ haveForm: false, everHadForm: false, isExternalClick: true });
  assert.equal(d.route, 'external');
});

test('classifyNoChangeRoute: missing args default to the opening case (never a blind rescan)', () => {
  assert.equal(classifyNoChangeRoute().route, 'opener-stall');
  assert.equal(classifyNoChangeRoute({}).route, 'opener-stall');
});
