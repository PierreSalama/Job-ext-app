// /queue/next must not walk the WHOLE queue before answering.
//
// Live failure this guards (laptop, 2026-08-18): the claim loop evaluated every queued task —
// db.getJob + db.isPunished + jobFit each, then db.rankJob per candidate. At 321 queued that is
// ~1000 SQL reads per pump. The endpoint stopped answering entirely: of 419 /queue/next requests,
// 415 got NO response and the 2 that did took 3.9–5.2s. The pump asked once a minute and never
// received a task while 312 LinkedIn jobs sat queued, and 44 tasks stranded in-flight because the
// server claimed them and the pump never got the reply. Budget (28/40), the signed-out latch (0),
// the Easy-Apply cooldown (expired) and the host breaker (no skipHosts sent) were ALL clear — the
// slow scan was the stall.
//
// Rule: collect a bounded window of candidates and rank those, rather than the entire queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = fs.readFileSync(path.join(here, '..', 'app', 'src', 'server.js'), 'utf8');

test('a scan bound exists and scales with concurrency', () => {
  assert.match(server, /const SCAN_TARGET = Math\.max\(25, concurrency \* 8\);/,
    'queueNext must bound how many candidates it collects');
});

test('the loop stops once the window is full', () => {
  assert.match(server, /if \(candidates\.length >= SCAN_TARGET\) break;/,
    'the candidate loop must break when the window is full');
});

test('the break comes AFTER the push, so the window is actually filled', () => {
  const push = server.indexOf('candidates.push({ t, j, order: i })');
  const brk = server.indexOf('if (candidates.length >= SCAN_TARGET) break;');
  assert.ok(push > -1 && brk > -1, 'both the push and the break must exist');
  assert.ok(brk > push, 'breaking before the push would drop a dispatchable job');
});

test('the break can never fire on an empty candidate list', () => {
  // The deferral returns below the loop (easyapply-cooldown / signed-out / host-cooldown / gap /
  // site-busy) are all gated on `!candidates.length`. Their meaning only stays correct if we never
  // stop scanning before finding at least one candidate — otherwise a full queue could report
  // "empty" simply because we gave up early. SCAN_TARGET >= 25 guarantees that structurally.
  assert.match(server, /Math\.max\(25,/, 'the bound must have a non-zero floor');
});

test('every eligibility gate still runs on each scanned task', () => {
  // The bound limits HOW MANY tasks are examined, never WHICH checks each one gets. If the break
  // were hoisted above the gates, unfit or budget-blocked jobs could be dispatched — the exact
  // class of bug the governor exists to prevent.
  const loopStart = server.indexOf('for (let i = queued.length - 1; i >= 0; i--)');
  const brk = server.indexOf('if (candidates.length >= SCAN_TARGET) break;');
  assert.ok(loopStart > -1 && brk > loopStart, 'the break must live inside the candidate loop');
  const body = server.slice(loopStart, brk);
  for (const gate of ['easyApplyEligible', 'signedOutEligible', 'skipHosts', 'safetyGateFor', 'jobFit']) {
    assert.ok(body.includes(gate), `${gate} must still be evaluated before a task can be collected`);
  }
});

test('scanning stays oldest-first so a bounded window cannot starve old jobs', () => {
  // The window is the OLDEST N dispatchable jobs, not an arbitrary slice: the loop counts down from
  // the end of a DESC list. Were it newest-first, a queue that refills faster than it drains would
  // leave the backlog permanently unreachable.
  assert.match(server, /for \(let i = queued\.length - 1; i >= 0; i--\)/,
    'the candidate loop must iterate oldest-first');
  assert.match(server, /candidates\.sort\(\(a, b\) => \(b\.rank - a\.rank\) \|\| \(a\.order - b\.order\)\)/,
    'ties must still break oldest-first within the window');
});
