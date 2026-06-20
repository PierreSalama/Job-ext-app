// EXTERNAL-HANDOFF REGRESSION — the duplicate-page-action breaker must RESET across a real
// navigation. When an external "Apply on company site (opens in new tab)" actually navigates
// IN-TAB to the company ATS, the company landing page commonly has its OWN "Apply"-labelled
// button. The breaker keys on host+path+label, and was armed on the ORIGIN (LinkedIn) page; if
// it isn't cleared across the navigation, the first (legitimate, different-page) click is
// mistaken for a repeat and the run is killed ("same page-level action repeated — stopping…").
//
// These pin the two pure decisions behind the fix (replay.js) and assert the executor wires
// them in (URL tracking + reset on nav + honest external-child diagnostics).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pageActionUrlKey, shouldResetPageActionBreaker } from '../extension/content/replay.js';

// ---- pageActionUrlKey: host+path identity (query/hash/trailing-slash/www are render noise) ----
test('pageActionUrlKey normalizes www, trailing slash, query, and hash', () => {
  assert.equal(pageActionUrlKey('https://www.linkedin.com/jobs/view/123/'), 'linkedin.com/jobs/view/123');
  assert.equal(pageActionUrlKey('https://linkedin.com/jobs/view/123?refId=abc'), 'linkedin.com/jobs/view/123');
  assert.equal(pageActionUrlKey('https://linkedin.com/jobs/view/123#section'), 'linkedin.com/jobs/view/123');
});

test('pageActionUrlKey: a different host or path yields a different key', () => {
  const li = pageActionUrlKey('https://www.linkedin.com/jobs/view/123');
  assert.notEqual(li, pageActionUrlKey('https://jobs.acme.com/apply/123'));   // host changed
  assert.notEqual(li, pageActionUrlKey('https://www.linkedin.com/jobs/view/999'));  // path changed
});

test('pageActionUrlKey: same page with only query/hash differences compares EQUAL', () => {
  // Within-page protection must survive query-string re-renders (the genuine opener loop).
  assert.equal(
    pageActionUrlKey('https://jobs.acme.com/apply?step=1'),
    pageActionUrlKey('https://jobs.acme.com/apply?step=1&t=999'),
  );
});

test('pageActionUrlKey: non-absolute input degrades to a stable normalized string', () => {
  assert.equal(pageActionUrlKey('about:blank'), pageActionUrlKey('about:blank'));
  assert.equal(pageActionUrlKey(''), '');
});

// ---- shouldResetPageActionBreaker: reset iff armed AND the page identity changed ----
test('RESET when an armed breaker sees the page navigated to a different host (in-tab handoff)', () => {
  // This is the exact failing scenario: opener armed on LinkedIn, page navigated in-tab to the
  // company ATS. The company "Apply" click must NOT be treated as a repeat.
  assert.equal(shouldResetPageActionBreaker({
    lastActionUrl: 'https://www.linkedin.com/jobs/view/123',
    currentUrl: 'https://jobs.acme.com/apply/123',
    hasPending: true,
  }), true);
});

test('NO reset within the same page — the genuine "opener does not transfer" loop is still caught', () => {
  assert.equal(shouldResetPageActionBreaker({
    lastActionUrl: 'https://jobs.acme.com/apply/123',
    currentUrl: 'https://jobs.acme.com/apply/123',
    hasPending: true,
  }), false);
  // …even when only the query string changed (same page re-rendering, not a navigation).
  assert.equal(shouldResetPageActionBreaker({
    lastActionUrl: 'https://jobs.acme.com/apply/123?step=1',
    currentUrl: 'https://jobs.acme.com/apply/123?step=2',
    hasPending: true,
  }), false);
});

test('NO reset when nothing is armed (hasPending=false) — never resets blind', () => {
  assert.equal(shouldResetPageActionBreaker({
    lastActionUrl: 'https://a.com/x', currentUrl: 'https://b.com/y', hasPending: false,
  }), false);
});

test('NO reset when armed without a recorded URL (lastActionUrl null) — never resets blind', () => {
  assert.equal(shouldResetPageActionBreaker({
    lastActionUrl: null, currentUrl: 'https://b.com/y', hasPending: true,
  }), false);
});

test('missing args default to NO reset (never reset blindly)', () => {
  assert.equal(shouldResetPageActionBreaker(), false);
  assert.equal(shouldResetPageActionBreaker({}), false);
});

// ---- executor wiring: the source must use the helpers and arm the URL alongside the breaker ----
const SRC = fs.readFileSync(new URL('../extension/content/executor.js', import.meta.url), 'utf8');

test('executor imports and calls shouldResetPageActionBreaker before the duplicate-action check', () => {
  assert.match(SRC, /shouldResetPageActionBreaker/);
  const resetIdx = SRC.indexOf('shouldResetPageActionBreaker({ lastActionUrl: lastPageActionUrl');
  const breakerIdx = SRC.indexOf('pageAction === lastPageAction');
  assert.ok(resetIdx > 0, 'breaker-reset call present');
  assert.ok(breakerIdx > 0, 'duplicate-action breaker present');
  assert.ok(resetIdx < breakerIdx, 'reset must run BEFORE the duplicate-action comparison');
});

test('executor records lastPageActionUrl whenever it arms lastPageAction', () => {
  // The breaker and its URL must be set together, or the reset has no anchor to compare against.
  assert.match(SRC, /lastPageAction = pageAction; lastPageActionUrl = location\.href/);
});

test('external-child terminal states carry an honest diagnostic (never silent / never "without a diagnostic")', () => {
  // No external terminal path may emit the literal synthetic phrase…
  assert.ok(!/external executor failed without a diagnostic/.test(SRC),
    'the synthetic "…without a diagnostic" string must not appear on the external-child path');
  // …and the failed/skipped child states must set a concrete needs-you reason at the source.
  assert.match(SRC, /handoff failed\) — needs you/);
  assert.match(SRC, /handoff returned skipped\) — needs you/);
});
