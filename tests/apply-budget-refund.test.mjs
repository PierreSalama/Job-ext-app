// The non-attempt refund: a dispatch that was never offered an application form must not eat the
// apply budget. Every string below is a REAL last_error taken from pierre-laptop's own
// auto_apply_tasks table on 2026-08-21 — the classifier is calibrated on live data, not guesses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isNonAttemptSkip, NON_ATTEMPT_SKIP_RX } = require('../app/src/apply-outcome.js');

// Skips where we opened the page, learned there was nothing to drive, and left.
const REFUND = [
  'external posting — no Easy Apply on this job (skipped, easy-apply-only)',
  'no Easy Apply on this posting — apply is on the company site (not auto-applicable)',
  'needs ~8 yrs experience (you set 3)',
  'needs ~16 yrs experience (you set 3)',
  'application form is embedded from job-boards.greenhouse.io — open that page directly to apply',
  'filtered: outside Canada (United States)',
  'filtered: off-target: title matches none of your keywords',
  'excluded keyword "intern"',
  'already applied',
  'punished',
  'Glassdoor is skipped in Easy-Apply-only mode (no reliable Easy Apply badge)',
  'job missing or has no URL',
];

// Sessions that really happened. Every one of these must STAY charged — under-counting the
// account's real footprint is what caused the 2026-08-10 LinkedIn restriction.
const CHARGED = [
  'no Easy Apply opener and no drivable form appeared (visible tab) — inspect',
  'CAPTCHA gate — not auto-solvable by policy, retired rather than parked forever',
  'host verification wall did not lift within 24h — retired so it stops holding a queue slot',
  'site sign-in gate untouched for 7d — retired (the posting is stale by now)',
  'smartapply step did not advance — module stuck (Continue never enabled); will retry',
  'timed out / interrupted — will retry',
  'apply handoff did not attach — page did not change; will retry',
  'repeated page-level action did not transfer: Easy Apply to this job',
  'stuck on a step (page stopped advancing) — will retry',
  'Workday account required — sign in once and I will continue',
  'no advance button found — will retry',
  'needs 1 answer(s)',
];

test('every live non-attempt reason is refunded', () => {
  for (const r of REFUND) assert.equal(isNonAttemptSkip('skipped', r), true, r);
});

test('every live real-session reason stays charged', () => {
  for (const r of CHARGED) assert.equal(isNonAttemptSkip('skipped', r), false, r);
});

test('"no Easy Apply OPENER" is not confused with "no Easy Apply ON THIS job"', () => {
  // The one genuine collision in the live data: both start "no Easy Apply". The first drove the
  // page and found nothing; the second never had anything to drive.
  assert.equal(NON_ATTEMPT_SKIP_RX.test('no Easy Apply opener and no drivable form appeared'), false);
  assert.equal(NON_ATTEMPT_SKIP_RX.test('no Easy Apply on this posting'), true);
});

test('only a terminal skip qualifies — a park, failure or submission is a real session', () => {
  const reason = 'external posting — no Easy Apply on this job (skipped, easy-apply-only)';
  assert.equal(isNonAttemptSkip('skipped', reason), true);
  for (const st of ['parked', 'failed', 'done', 'verified_done', 'awaiting_review', 'running', 'queued', '']) {
    assert.equal(isNonAttemptSkip(st, reason), false, st);
  }
});

test('an empty or missing error never refunds', () => {
  for (const v of [undefined, null, '', 'something we have never seen before']) {
    assert.equal(isNonAttemptSkip('skipped', v), false, String(v));
  }
});
