// Auto-apply self-healing loop — park → intake → retry, against a real DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-aatest-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('migration v4 + park → intake → retry self-heals', () => {
  const job = db.upsertJob({ title: 'Dev', company: 'Acme', source: 'linkedin', status: 'started', jobUrl: 'https://x/p1' }).job;
  const task = db.queueAdd(job.id, { mode: 'review' });
  assert.equal(task.state, 'queued');

  db.queuePatch(task.id, { state: 'parked', parkReason: 'needs 2', pendingQuestions: [
    { question: 'How many years of Kubernetes?', fieldType: 'text', reason: 'no confident answer' },
    { question: 'Are you willing to relocate?', fieldType: 'radio', options: ['Yes', 'No'], reason: 'no confident answer' },
  ] });
  assert.equal(db.queueParkedQuestions().length, 2, 'both questions outstanding');

  // Answer ONE → still parked (one missing). Use the real intake path (saveIntakeAnswer
  // routes the answer into the memory of each profile whose parked task asked it).
  db.saveIntakeAnswer({ question: 'How many years of Kubernetes?', value: '3' });
  assert.equal(db.queueRetryParked(), 0, 'not requeued while a question is still missing');
  assert.equal(db.queueParkedQuestions().length, 1);

  // Answer BOTH → requeued
  db.saveIntakeAnswer({ question: 'Are you willing to relocate?', value: 'Yes' });
  assert.equal(db.queueRetryParked(), 1, 'requeued once all answered');
  assert.equal(db.queueList({ state: 'queued' }).length, 1);
  assert.equal(db.queueParkedQuestions().length, 0, 'no outstanding questions');
});

test('parked tasks never consume the daily cap', () => {
  const before = db.queueRunStats().doneDay;
  const job = db.upsertJob({ title: 'X', company: 'Y', source: 'indeed', status: 'started', jobUrl: 'https://x/p2' }).job;
  const t = db.queueAdd(job.id, { mode: 'review' });
  db.queuePatch(t.id, { state: 'parked', pendingQuestions: [{ question: 'A unique unanswered question?', reason: 'x' }] });
  assert.equal(db.queueRunStats().doneDay, before, 'a parked job must not count toward the cap');
});

test('upsertJob merges tags — discovery never drops a job\'s existing tags', () => {
  db.upsertJob({ title: 'T', company: 'C', source: 'linkedin', status: 'started', jobUrl: 'https://x/tags', tags: ['favorite'] });
  const b = db.upsertJob({ title: 'T', company: 'C', source: 'linkedin', status: 'started', jobUrl: 'https://x/tags', tags: ['auto-apply'] }).job;
  assert.ok(b.tags.includes('favorite') && b.tags.includes('auto-apply'), 'both tags retained after re-discovery');
});

test('discovery dedups: re-queueing the same job is a no-op while in flight', () => {
  const job = db.upsertJob({ title: 'Z', company: 'W', source: 'linkedin', status: 'started', jobUrl: 'https://x/p3' }).job;
  const t1 = db.queueAdd(job.id, { mode: 'review' });
  const t2 = db.queueAdd(job.id, { mode: 'review' });   // discovery path → honest no-op
  assert.ok(t1 && t1.id, 'first add queues the job');
  assert.equal(t2, null, 're-discovering an in-flight job creates no second task (and is not counted as enqueued)');
  assert.equal(db.queueList({ state: 'queued' }).filter((t) => t.jobId === job.id).length, 1, 'queued exactly once');
});

test('a transient failure misfiled as awaiting_input never permanently blocks re-queue', () => {
  // This is the starvation bug that zeroed out submissions: a "did not open" task was
  // parked as awaiting_input with NO pending questions, and the OLD dedup treated it as
  // an in-flight dup forever — so discovery could never re-queue the job.
  const job = db.upsertJob({ title: 'Q', company: 'V', source: 'linkedin', status: 'started', jobUrl: 'https://x/p4' }).job;
  const t = db.queueAdd(job.id, { mode: 'auto' });
  const guarded = db.queuePatch(t.id, { state: 'awaiting_input', lastError: 'application did not open (not Easy-Apply / verification)' });

  // The storage boundary now prevents the dead wait-state immediately.
  assert.equal(guarded.state, 'failed', 'empty awaiting_input is converted to failed immediately');
  db.reclaimDeadParks();
  assert.equal(db.queueList({ state: 'awaiting_input' }).filter((x) => x.jobId === job.id).length, 0, 'no longer awaiting_input');

  // A GENUINE intake (real pending questions) must NOT be reclaimed.
  const g = db.upsertJob({ title: 'G', company: 'V', source: 'linkedin', status: 'started', jobUrl: 'https://x/p5' }).job;
  const gt = db.queueAdd(g.id, { mode: 'auto' });
  db.queuePatch(gt.id, { state: 'awaiting_input', pendingQuestions: [{ question: 'Salary expectation?', reason: 'x' }] });
  const reclaimed = db.reclaimDeadParks();
  assert.equal(db.queueList({ state: 'awaiting_input' }).filter((x) => x.jobId === g.id).length, 1, 'genuine intake is preserved');
  assert.ok(reclaimed === 0, 'a task with real questions is not reclaimed');
});
