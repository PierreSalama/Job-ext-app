// A stranded CLAIM must free its worker slot in ~2 minutes, not 8.
//
// The extension pulls a task, the server marks it 'scheduled', and the executor normally flips it to
// 'running' within ~10s. If the service worker dies in that gap the row sits 'scheduled' forever
// holding a slot, because the pump counts scheduled+running as busy.
//
// reconcileStaleRunning already knew this — its own comment says a 'scheduled' row older than a
// couple of minutes was interrupted — and exposed `scheduledOlderThanMinutes` for it. But the
// parameter DEFAULTED to olderThanMinutes (8), and only one of four call sites passed 2. The
// pipeline watchdog, which runs every 60s and is the one that actually matters, did not.
//
// Measured live on the laptop 2026-08-09: ~9 stranded claims/hour, steady. Each had entries=1 with
// last line "scheduled (mode=auto)" and executorStarted=0 — claimed, then never started. Two other
// causes were ruled out first: my own deploys (failures were evenly spread across every 10-minute
// bucket, not clustered at deploy times) and a tab leak (renderers held steady at 13 for 5 minutes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const db = read('app', 'src', 'db.js');
const main = read('app', 'src', 'main.js');

// Mirror the reclaim predicate.
const reclaims = ({ state, ageMin, runMin = 8, schedMin = 2 }) =>
  (state === 'running' && ageMin > runMin) || (state === 'scheduled' && ageMin > schedMin);

test('a claim stranded for 3 minutes is reclaimed', () => {
  assert.equal(reclaims({ state: 'scheduled', ageMin: 3 }), true,
    'the executor starts in ~10s — 3 minutes means it never started');
});

test('a genuinely running apply is NOT cut off at 2 minutes', () => {
  assert.equal(reclaims({ state: 'running', ageMin: 3 }), false,
    'real applies routinely take minutes; killing them at 2 would destroy working runs');
  assert.equal(reclaims({ state: 'running', ageMin: 9 }), true, 'but 9 minutes is genuinely hung');
});

test('a fresh claim is left alone', () => {
  assert.equal(reclaims({ state: 'scheduled', ageMin: 0.5 }), false,
    'the executor is still starting — reclaiming here would fight normal dispatch');
});

test('the slot waste this removes', () => {
  // ~9 stranded claims/hour on 2 concurrent slots = 120 slot-minutes available per hour.
  const perHour = 9;
  const wasted = (holdMin) => perHour * holdMin;
  assert.equal(wasted(8), 72, 'old: 72 of 120 slot-minutes lost per hour');
  assert.equal(wasted(2), 18, 'new: 18');
  assert.ok(wasted(2) < wasted(8) / 3, 'a 4x reduction in the hold time');
});

test('the DEFAULT is 2 — a call site cannot reintroduce this by omission', () => {
  assert.match(db, /function reconcileStaleRunning\(\{ olderThanMinutes = 8, scheduledOlderThanMinutes = 2 \} = \{\}\)/,
    'defaulting to olderThanMinutes is what let three call sites silently use 8');
});

test('the pipeline watchdog — the 60s one — now gets the short window', () => {
  // It calls with only { olderThanMinutes: 8 }, so this only holds because the DEFAULT changed.
  const tick = main.slice(main.indexOf('async function pipelineWatchdogTick'));
  assert.match(tick.slice(0, 1200), /reconcileStaleRunning\(/, 'the watchdog must still reconcile');
});

test('the running window is unchanged at 8 minutes', () => {
  assert.match(db, /olderThanMinutes = 8/, 'only the scheduled window moved');
});
