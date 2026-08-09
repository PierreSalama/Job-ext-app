// A launch that dies before the executor starts must say why, and release its claim.
//
// The pump claims a task (GET /queue/next marks it 'scheduled'), then calls launchOne(). That call
// was `.catch(() => {})` — so anything thrown between the claim and the executor starting vanished,
// and the task sat claimed until reconcileStaleRunning reclaimed it and stamped
// "timed out / interrupted — will retry".
//
// That label is why this looked like a timeout for three rounds. It is not: the executor never ran.
// Measured on the laptop 2026-08-09, ~10-15/hour, every one with entries=1 and executorStarted=0.
// Two fixes aimed at plausible causes (a send() ceiling, then skipping walled hosts at claim time)
// did not move the rate — because nothing recorded WHY the launch died. Guessing a third time would
// have been the wrong move; instrumenting it is the right one.
//
// Note launchOne's first statement — acquiring the apply window — sits OUTSIDE its own try block,
// so a window/tab failure lands in exactly this handler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bg = fs.readFileSync(path.join(here, '..', 'extension', 'background.js'), 'utf8');
const handler = bg.slice(bg.indexOf('launchOne(r.task, r.context)'), bg.indexOf('.finally(() => { activeCount'));

test('the launch failure is no longer swallowed', () => {
  // Check the FIRST catch attached to launchOne, ignoring comments — the inner catch on the release
  // PATCH is legitimately empty (the reconciler is its backstop), and the comment quotes the old
  // code verbatim, so a blunt doesNotMatch over the whole block gives a false failure.
  const code = handler.replace(/\/\/[^\n]*\n/g, '');
  const firstCatch = code.slice(code.indexOf('.catch('), code.indexOf('.catch(') + 14);
  assert.equal(firstCatch.startsWith('.catch((e) =>'), true,
    `regression: launchOne's catch must receive the error, got "${firstCatch}"`);
});

test('the real error text is recorded, not a generic label', () => {
  assert.match(handler, /\(e && e\.message\) \|\| e \|\| 'unknown'/, 'must extract the message');
  assert.match(handler, /launch failed before the executor started: \$\{msg\}/,
    'the reason must name the actual failure so the next occurrence is diagnosable');
});

test('the claim is released immediately rather than waiting for the reclaim', () => {
  assert.match(handler, /api\.call\('PATCH', '\/queue\/'/, 'must hand the task back');
  assert.match(handler, /state: 'queued'/,
    'the job was never attempted — it must stay retriable, and queued charges no attempt');
});

test('it does NOT mark the task failed, which would charge an attempt', () => {
  assert.doesNotMatch(handler, /state: 'failed'/,
    'a launch that never started is not an attempt at the job; charging one would retire it early');
});

test('the transcript carries the reason too', () => {
  assert.match(handler, /transcriptAppend/, 'the per-task trail is where this gets diagnosed');
  assert.match(handler, /returned to the queue/, 'the trail must say what happened to it');
});

test('the failure is logged where the SW console will show it', () => {
  assert.match(handler, /console\.warn/, 'silent recovery would leave the rate unexplained again');
  assert.match(handler, /task \$\{r\.task\.id\}/, 'the log must identify which task');
});

test('the slot is still freed exactly once', () => {
  const full = bg.slice(bg.indexOf('launchOne(r.task, r.context)'));
  const fin = full.slice(0, full.indexOf('\n      // Small stagger'));
  assert.match(fin, /\.finally\(\(\) => \{ activeCount = Math\.max\(0, activeCount - 1\); schedulePump\(\); \}\)/,
    'the finally must remain — a catch that returned early would leak the worker slot');
});
