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
import { shouldFrontOnOpenerStall, classifyNoChangeRoute, isPostingClosed } from '../extension/content/lib/opener-stall.js';

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

// ---------------------------------------------------------------------------
// CLOSED POSTING (live data, 2026-08-25).
//
// Every LinkedIn failure across three days had one shape: opener found, opener clicked, modal
// never mounted, fronted retry spent, task failed as "repeated page-level action did not
// transfer" — a verdict that says "needs inspection" about a posting where nothing is wrong
// with the code. Fetching six of them showed two were simply closed; LinkedIn leaves the Easy
// Apply button on a closed posting and clicking it does nothing.
// ---------------------------------------------------------------------------
test('a closed posting is recognised from the page\'s own words', () => {
  // LinkedIn's exact wording, and the surrounding text it really appears in.
  assert.equal(isPostingClosed('No longer accepting applications'), true);
  assert.equal(isPostingClosed('Full Stack Engineer\nPaymentus\nNo longer accepting applications\nSee who they hired'), true);
  assert.equal(isPostingClosed('this job is no longer available'), true);
  assert.equal(isPostingClosed('The position has been filled'), true);

  // A live posting must never be read as closed — this is the expensive direction to get wrong,
  // because it would silently skip jobs Pierre can still apply to.
  for (const t of [
    'Be among the first 25 applicants',
    'Easy Apply to this job',
    'We are no longer accepting paper resumes, please apply online',
    'Applications open until December',
    'Accepting applications on a rolling basis',
    '',
  ]) {
    assert.equal(isPostingClosed(t), false, `must not read as closed: ${JSON.stringify(t)}`);
  }
  assert.equal(isPostingClosed(null), false);
  assert.equal(isPostingClosed(undefined), false);
});

test('a closed posting terminates the stall instead of spending a fronted retry', () => {
  const d = shouldFrontOnOpenerStall({
    haveForm: false, isExternalClick: false, changed: false, modalMounted: false,
    alreadyFronted: false, postingClosed: true,
  });
  assert.equal(d.front, false, 'fronting a closed posting cannot help');
  assert.equal(d.terminal, true, 'and it must be terminal, not a retriable failure');
  assert.equal(d.reason, 'posting-closed');
});

test('the closed check is evaluated before every other branch', () => {
  // Whatever else is true, a closed posting is the whole explanation. This guards the ORDER of
  // the checks: if the closed test ever moves below these, each returns its own non-terminal
  // reason and the dead posting goes back to burning a worker slot.
  for (const extra of [
    { haveForm: true },
    { isExternalClick: true },
    { changed: true },
    { modalMounted: true },
    { alreadyFronted: true },
  ]) {
    const d = shouldFrontOnOpenerStall({
      haveForm: false, isExternalClick: false, changed: false, modalMounted: false,
      alreadyFronted: false, postingClosed: true, ...extra,
    });
    assert.equal(d.terminal, true, `closed must win over ${JSON.stringify(extra)}`);
    assert.equal(d.reason, 'posting-closed');
  }
});

test('an OPEN posting behaves exactly as it did before the closed check existed', () => {
  // The regression guard. Every pre-existing decision must be byte-identical when the posting
  // is open, whether the caller passes postingClosed:false or omits it entirely.
  for (const closed of [false, undefined]) {
    assert.deepEqual(
      shouldFrontOnOpenerStall({ haveForm: false, isExternalClick: false, changed: false, modalMounted: false, alreadyFronted: false, postingClosed: closed }),
      { front: true, reason: 'opener-clicked-no-mount-front-and-retry' });
    assert.equal(shouldFrontOnOpenerStall({ haveForm: true, postingClosed: closed }).reason, 'form-already-open');
    assert.equal(shouldFrontOnOpenerStall({ haveForm: false, isExternalClick: true, postingClosed: closed }).reason, 'external-route-has-own-cap');
    assert.equal(shouldFrontOnOpenerStall({ haveForm: false, isExternalClick: false, changed: true, postingClosed: closed }).reason, 'page-changed');
    assert.equal(shouldFrontOnOpenerStall({ haveForm: false, isExternalClick: false, changed: false, modalMounted: true, postingClosed: closed }).reason, 'modal-mounted');
    assert.equal(shouldFrontOnOpenerStall({ haveForm: false, isExternalClick: false, changed: false, modalMounted: false, alreadyFronted: true, postingClosed: closed }).reason, 'already-fronted-retry-spent');
    assert.equal(shouldFrontOnOpenerStall({ postingClosed: closed }).front, false, 'unknown signals still default-deny');
  }
});
