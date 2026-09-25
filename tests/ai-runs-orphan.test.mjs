// AI RUNS THAT DIED WITH THE PROCESS.
//
// An ai_runs row is 'running' from the moment the agent starts until the agent itself writes the
// ending. If the app restarts mid-run - a crash, an update, a keeper restart - nobody ever writes
// that ending, and the row claims to be running forever.
//
// Measured 2026-09-08 after several app restarts: /ai-apply/performance reported 13 runs, 8 done,
// 0 failed, and 2 STILL RUNNING hours after the process that owned them was gone. That count reads
// as live work, so orphans make the agent look permanently busy AND flatter the failure rate,
// because a run that never ends is never counted as a failure.
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
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-airuns-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

// aiRunCreate stamps started_at as "now", so a positive age can never match in the same instant.
// olderThanMinutes: -1 means "no minimum age" - the same escape hatch retryStaleQueue documents.
const NO_MIN_AGE = { olderThanMinutes: -1 };

test('an orphaned running row is recorded as failed, with an honest reason', () => {
  const id = db.aiRunCreate({ goal: 'orphan under test' });
  assert.equal(db.aiRunGet(id).status, 'running');

  const n = db.reconcileAiRuns(NO_MIN_AGE);
  assert.ok(n >= 1, 'the running row should have been reconciled');

  const row = db.aiRunGet(id);
  assert.equal(row.status, 'failed');
  assert.ok(row.endedAt || row.ended_at, 'an ending must be written, or the row still reads as live');
  assert.match(String(row.error || ''), /never reported an ending/);
  assert.equal(String(row.stopReason || row.stop_reason), 'interrupted');
});

test('a genuinely live run is left alone by the production cutoff', () => {
  // The only real risk in this repair is killing a HEALTHY in-flight run. Agent runs are long;
  // 30 minutes is the production floor and a run that just started must survive untouched.
  const id = db.aiRunCreate({ goal: 'still running' });
  const n = db.reconcileAiRuns({ olderThanMinutes: 30 });
  assert.equal(n, 0, 'nothing is older than 30 minutes in a fresh database');
  assert.equal(db.aiRunGet(id).status, 'running');
});

test('a finished run is never rewritten', () => {
  const id = db.aiRunCreate({ goal: 'already done' });
  db.aiRunFinish(id, { status: 'done', stopReason: 'complete', summary: 'finished cleanly' });
  const before = db.aiRunGet(id);
  assert.equal(before.status, 'done');

  db.reconcileAiRuns(NO_MIN_AGE);
  const after = db.aiRunGet(id);
  assert.equal(after.status, 'done', 'a completed run must not be re-opened as failed');
  assert.doesNotMatch(String(after.error || ''), /never reported an ending/);
});

test('an existing error and stop_reason are preserved, not overwritten', () => {
  // COALESCE is the point: a run that DID record why it stopped keeps its own words. Only a row
  // that says nothing gets the generic explanation.
  const id = db.aiRunCreate({ goal: 'has its own reason' });
  db.aiRunFinish(id, { status: 'running', stopReason: 'budget', error: 'ran out of steps' });
  db.reconcileAiRuns(NO_MIN_AGE);
  const row = db.aiRunGet(id);
  assert.equal(String(row.stopReason || row.stop_reason), 'budget');
  assert.match(String(row.error), /ran out of steps/);
});

test('the repair is wired into startup, not merely exported', () => {
  const main = fs.readFileSync(path.join(here, '..', 'app', 'src', 'main.js'), 'utf8');
  assert.match(main, /db\.reconcileAiRuns\(\{ olderThanMinutes: 30 \}\)/,
    'an orphan repair nobody calls fixes nothing');
});
