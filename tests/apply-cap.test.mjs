// FIX 1 (throughput, live-observed): cut the hidden-non-hydrating apply hard cap.
// A hidden apply tab that won't hydrate used to burn the FULL 5.5-min cap before failing —
// at concurrency=1 that single stall froze the whole queue. applyHardCapMs() selects a SHORT
// ~90s cap for exactly the hidden-non-hydrating case (the tab asked to be fronted AND has not
// hydrated) so retry-stale re-attempts it later, while keeping the full generous cap for a
// merely-slow VISIBLE tab (which never sends front-until-hydrated).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  applyHardCapMs, APPLY_HARD_CAP_MS, APPLY_HIDDEN_STALL_CAP_MS,
} from '../extension/lib/apply-cap.js';

test('hidden + front-requested + NOT hydrated → SHORT cap (~90s, fast-fail)', () => {
  assert.equal(applyHardCapMs({ frontRequested: true, hydrated: false }), APPLY_HIDDEN_STALL_CAP_MS);
});

test('front-requested but THEN hydrated → full cap (it is making progress)', () => {
  assert.equal(applyHardCapMs({ frontRequested: true, hydrated: true }), APPLY_HARD_CAP_MS);
});

test('visible-but-slow tab (never front-requested) → full cap', () => {
  assert.equal(applyHardCapMs({ frontRequested: false, hydrated: false }), APPLY_HARD_CAP_MS);
  assert.equal(applyHardCapMs({}), APPLY_HARD_CAP_MS);   // missing args default to the full cap
});

test('the caps changed: hidden-stall is much shorter than the full cap (75–90s range)', () => {
  assert.equal(APPLY_HARD_CAP_MS, 330000);              // before: 5.5 min flat for every case
  assert.ok(APPLY_HIDDEN_STALL_CAP_MS >= 75000 && APPLY_HIDDEN_STALL_CAP_MS <= 90000, 'hidden cap in the 75–90s band');
  assert.ok(APPLY_HIDDEN_STALL_CAP_MS < APPLY_HARD_CAP_MS);
});

// The fast-fail must be phrased RETRIABLY (transient) so the server classifier reschedules it
// via retry-stale — the dispatch race rejects with the throttled/occluded "will retry" text
// (classifyQueueFailure → action 'retry'; see autoapply-policy.test.mjs), NOT a terminal
// "timed out" with no retry hint.
test('background.js fails the hidden-stall case RETRIABLY (transient phrasing)', () => {
  const bg = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(bg, /applyHardCapMs\(/, 'dispatch race uses the adaptive cap selector');
  assert.match(bg, /APPLY_HIDDEN_STALL_CAP_MS/, 'dispatch race distinguishes the hidden-stall cap');
  assert.match(bg, /apply form did not hydrate on a throttled\/occluded tab — will retry/, 'retriable phrasing on the short cap');
});
