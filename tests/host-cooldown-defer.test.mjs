// A transient site condition must never permanently discard a job.
//
// The extension's host circuit breaker stops dispatching into a Cloudflare/verification wall --
// correct -- but it used to do that by PATCHing the task to state 'skipped', which is TERMINAL and
// non-retriable. Live 2026-07-20 Indeed began serving a challenge and the breaker destroyed 40+
// queued jobs in ten minutes, every one with attempts=0 (never attempted), draining the Indeed
// queue from 60 to 16. Same shape as the LinkedIn anchor-opener loss: a temporary condition
// producing permanent data loss.
//
// The Easy-Apply cooldown already models the right behaviour: leave the task QUEUED so it resumes.
// The breaker now does the same, using a FUTURE scheduled_at so queueNext can pass over it rather
// than handing the same row back forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const bg = read('extension', 'background.js');
const server = read('app', 'src', 'server.js');

test('the breaker defers the task instead of terminally skipping it', () => {
  const start = bg.indexOf('HOST CIRCUIT BREAKER');
  const block = bg.slice(start, bg.indexOf('stopping = false', start));
  assert.ok(block.length, 'host circuit breaker dispatch block not found');
  assert.match(block, /state: 'queued'/, 'the task must stay queued so it can run after the wall clears');
  assert.match(block, /scheduledAt: new Date\(gate\.until\)\.toISOString\(\)/,
    'it must be scheduled for when the breaker expires');
  assert.doesNotMatch(block, /state: 'skipped'/,
    "regression: 'skipped' is terminal — a transient wall would permanently discard untried jobs");
});

test('queueNext passes over a task that is not due yet', () => {
  const gstart = server.indexOf('NOT-BEFORE DEFERRAL');
  const gate = server.slice(gstart, server.indexOf('const siteKey', gstart));
  assert.match(gate, /Date\.parse\(t\.scheduledAt\) > Date\.now\(\)/, 'must compare against now');
  // Allows the per-job pass-over diagnostic between the flag and the continue. What matters is that
  // the task is DEFERRED (flag set, loop continues) and never patched to a terminal state — the
  // diagnostic only records why it was passed over.
  assert.match(gate, /hostDeferred = true;[^\n]*continue;/, 'must defer, not dispatch and not skip');
  assert.ok(!/hostDeferred = true;[^\n]*queuePatch/.test(gate), 'deferral must never write a terminal state');
  assert.match(gate, /!force/, 'a forced/manual run must still be able to dispatch');
});

test('the pump is told it is waiting, not out of work', () => {
  assert.match(server, /!candidates\.length && hostDeferred\) return \{ task: null, reason: 'host-cooldown'/,
    'idling for a host wall needs its own reason so it is not read as an empty queue');
});

test('the deferral arithmetic: not-due skipped, due dispatched', () => {
  const due = (scheduledAt, now) => !(scheduledAt && Date.parse(scheduledAt) > now);
  const now = Date.parse('2026-07-20T20:10:00Z');
  assert.equal(due('2026-07-20T20:25:00Z', now), false, 'still walled → deferred');
  assert.equal(due('2026-07-20T20:05:00Z', now), true, 'breaker expired → dispatchable again');
  assert.equal(due(null, now), true, 'a normal queued task is unaffected');
  assert.equal(due('2026-07-20T19:00:00Z', now), true, 'an ordinary past scheduled_at is unaffected');
});
