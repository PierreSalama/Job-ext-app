// A job must not lose its attempt budget to failures that say nothing about it.
//
// retryStaleQueue charges an attempt on every retry unless the failure is "environmental", and
// retires a task for good once attempts reaches maxAttempts. Two very common failures were missing
// from that list:
//
//   • "timed out / interrupted — will retry" — written by reconcileStaleRunning when a DISPATCH was
//     stranded (MV3 evicted the service worker before the executor started). The job was never
//     opened, never attempted.
//   • host verification wall / host-cooldown — the SITE is refusing automation. Nothing to do with
//     the posting.
//
// Measured live on the laptop 2026-08-09: 210 tasks failing for these reasons, and 15 already at
// attempts=4 — permanently retired without ever having been applied to. Same class of loss as the
// 2026-07-20 incident that destroyed 40+ never-attempted jobs, just arriving slowly.
//
// The line that must NOT move: "apply timed out after 5.5 min" means the executor really did run
// and burn the budget. That is a genuine attempt and must still be charged, or a job that reliably
// hangs would retry forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const db = fs.readFileSync(path.join(here, '..', 'app', 'src', 'db.js'), 'utf8');
const RX = new RegExp(db.match(/const ENVIRONMENTAL_FAILURE_RX = \/(.+)\/i;/)[1], 'i');

const charges = (lastError) => !RX.test(String(lastError || ''));   // true = an attempt is consumed

test('a stranded dispatch does NOT consume an attempt', () => {
  assert.equal(charges('timed out / interrupted — will retry'), false,
    'the executor never started; the job was not attempted');
});

test('a host verification wall does NOT consume an attempt', () => {
  assert.equal(charges('host indeed.com is serving a verification wall — deferred until 2026-08-09T12:51:50Z (not skipped)'), false);
  assert.equal(charges('host-cooldown'), false);
  assert.equal(charges('host verification wall did not lift within 24h — retired so it stops holding a queue slot'), false);
});

test('a REAL apply that ran and exceeded its budget STILL consumes an attempt', () => {
  assert.equal(charges('apply timed out after 5.5 min — will retry'), true,
    'the executor ran — this is a genuine attempt, or a job that always hangs would retry forever');
});

test('the pre-existing environmental cases are unchanged', () => {
  for (const e of ['tab was occluded', 'renderer throttled', 'form never hydrated',
                   'stuck on a step (page stopped advancing) — will retry', 'tab backgrounded']) {
    assert.equal(charges(e), false, `${e} must stay environmental`);
  }
});

test('genuine, job-specific failures still consume an attempt', () => {
  for (const e of ['no Easy Apply opener and no drivable form appeared (visible tab) — inspect',
                   'needs 3 answer(s)',
                   'resume required — add a résumé to your profile',
                   'no advance button found — will retry']) {
    assert.equal(charges(e), true, `${e} is about THIS job and must be counted`);
  }
});

test('an empty failure reason still charges — we must not silently un-cap everything', () => {
  assert.equal(charges(''), true);
  assert.equal(charges(null), true);
});

// The arithmetic that makes this matter.
test('the live case: 4 stranded dispatches no longer retire a never-attempted job', () => {
  const MAX = 4;
  const run = (failures) => failures.reduce((a, f) => a + (charges(f) ? 1 : 0), 0);
  const stranded = Array(4).fill('timed out / interrupted — will retry');
  assert.equal(run(stranded), 0, 'attempts stay at 0 — the job survives to be tried when things recover');
  assert.ok(run(stranded) < MAX, 'previously this hit the cap and the job was abandoned');

  const realTries = Array(4).fill('no advance button found — will retry');
  assert.equal(run(realTries), MAX, 'four real attempts still retires it — the cap must still work');
});
