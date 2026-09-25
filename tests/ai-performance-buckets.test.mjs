// A FAILURE COUNTER THAT COULD NEVER COUNT A FAILURE.
//
// aiPerformance bucketed runs by `status = 'error'`. The agent loop writes exactly three statuses -
// 'done', 'failed' and 'stopped' - and 'error' is written nowhere in the codebase. So the panel
// reported failed:0 no matter what happened, and 'stopped' was not counted at all.
//
// Seen live on the laptop 2026-09-08: total 13, done 8, failed 0, running 2. Eight and two do not
// make thirteen, and the three missing runs were exactly the ones worth looking at. Read left to
// right it said the agent had never failed once, while six rows in the same table said 'failed'.
//
// The arithmetic check below is the real test. A bucket that names a status wrongly is one typo;
// buckets that do not sum to the total are a panel that hides things, which is the failure mode
// this codebase keeps rediscovering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const db = require_(path.join(here, '..', 'app', 'src', 'db.js'));

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-aiperf-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

function finish(goal, status, stopReason) {
  const id = db.aiRunCreate({ goal });
  db.aiRunFinish(id, { status, stopReason, error: status === 'failed' ? 'it broke' : null });
  return id;
}

test('every status the agent actually writes lands in its own bucket', () => {
  finish('a', 'done', 'done');
  finish('b', 'done', 'done');
  finish('c', 'failed', 'crashed');
  finish('d', 'stopped', 'user');
  db.aiRunCreate({ goal: 'e' });          // left running on purpose

  const p = db.aiPerformance({ days: 7 });
  assert.equal(p.runs.total, 5);
  assert.equal(p.runs.done, 2);
  assert.equal(p.runs.failed, 1, "'failed' is the status the agent loop writes, not 'error'");
  assert.equal(p.runs.stopped, 1, "'stopped' was previously not counted anywhere");
  assert.equal(p.runs.running, 1);
});

test('the buckets sum to the total, so nothing can go missing', () => {
  const p = db.aiPerformance({ days: 7 });
  const { total, done, failed, stopped, running, other } = p.runs;
  assert.equal(done + failed + stopped + running + other, total,
    'a run that lands in no bucket is a run the panel is hiding');
});

test('an unrecognised status surfaces as `other` rather than vanishing', () => {
  // Guards the NEXT status somebody adds. Before this, a new status silently reduced the visible
  // counts and nothing anywhere said so.
  const id = db.aiRunCreate({ goal: 'from the future' });
  db.aiRunFinish(id, { status: 'quarantined', stopReason: 'unknown' });

  const p = db.aiPerformance({ days: 7 });
  assert.equal(p.runs.other, 1);
  const { total, done, failed, stopped, running, other } = p.runs;
  assert.equal(done + failed + stopped + running + other, total);
});

test("no status called 'error' is written anywhere, which is why the old bucket was always zero", () => {
  const loop = fs.readFileSync(path.join(here, '..', 'app', 'src', 'ai', 'agent-loop.js'), 'utf8');
  const written = [...loop.matchAll(/status = '([a-z]+)'/g)].map((m) => m[1]);
  assert.ok(written.length > 0, 'expected the agent loop to assign a run status');
  assert.ok(!written.includes('error'), "if 'error' ever becomes a real status, add it to the buckets");
  for (const st of new Set(written)) {
    assert.ok(['done', 'failed', 'stopped'].includes(st), `unbucketed run status: ${st}`);
  }
});

test('the engine attribution admits when it cannot attribute', () => {
  // `agent` joins ai_runs on job_id. That column is read in three places and written by NOBODY:
  // aiRunCreate takes no jobId, applyRunner never sees one, and /ai-apply/start is driven by a
  // free-text goal. So the join matches nothing and `agent` is pinned at 0 whatever the agent does.
  //
  // On the dashboard "extension 56 - agent 0" reads as "the agent achieved nothing this week". The
  // data cannot support that. It fits an agent that submitted plenty whose runs were never linked,
  // and on 2026-09-08 there were 18 runs and 10 completions in exactly that state.
  const id = db.aiRunCreate({ goal: 'apply to something' });
  db.aiRunFinish(id, { status: 'done', stopReason: 'complete' });

  const p = db.aiPerformance({ days: 7 });
  assert.ok(Number.isInteger(p.submittedBy.unlinkedAgentRuns),
    'the attribution must carry how many runs it could not attribute');
  assert.ok(p.submittedBy.unlinkedAgentRuns >= 1,
    'a run created with no job is exactly the case that makes `agent` meaningless');
});

test('nothing writes ai_runs.job_id yet, which is why the caveat has to exist', () => {
  // If someone later threads jobId through aiRunCreate, this test fails and that is correct: the
  // caveat can be reconsidered at the same moment the number starts meaning something.
  const dbSrc = fs.readFileSync(path.join(here, '..', 'app', 'src', 'db.js'), 'utf8');
  const create = dbSrc.slice(dbSrc.indexOf('function aiRunCreate'), dbSrc.indexOf('function aiStepAppend'));
  assert.doesNotMatch(create, /job_id/,
    'aiRunCreate still cannot record a job, so `agent` still cannot be a measurement');
});
