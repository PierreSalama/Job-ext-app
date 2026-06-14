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

  // Answer ONE → still parked (one missing)
  db.profileFieldUpsert({ question: 'How many years of Kubernetes?', value: '3', fromUser: true, confidence: 1 });
  assert.equal(db.queueRetryParked(), 0, 'not requeued while a question is still missing');
  assert.equal(db.queueParkedQuestions().length, 1);

  // Answer BOTH → requeued
  db.profileFieldUpsert({ question: 'Are you willing to relocate?', value: 'Yes', fromUser: true, confidence: 1 });
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
  const t2 = db.queueAdd(job.id, { mode: 'review' });
  assert.equal(t1.id, t2.id, 'same in-flight job is not double-queued');
});
