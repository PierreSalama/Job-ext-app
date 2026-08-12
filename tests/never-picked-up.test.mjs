// "timed out / interrupted" was the dominant failure on the laptop — and two thirds of it was not
// a timeout at all.
//
// Forensics on the live DB, 2026-08-12, over every task carrying that error:
//   127  transcript < 200 chars  -> the executor NEVER STARTED
//    36  transcript > 2k chars   -> a real flow that stalled
//    22  short                   -> started, died early
//
// A sample transcript, in full:
//   [{"note":"scheduled (mode=auto)"},
//    {"note":"self-heal retry after transient_page (environmental — no attempt charged)"},
//    {"note":"scheduled (mode=auto)"}]
//
// No navigation, no fill, no click. The task was claimed, marked 'scheduled', and reaped 2 minutes
// later because the applier's Chrome had not got to it yet. Recording that as FAILED is wrong
// twice: it blames a perfectly good posting, and it hides the real signal — dispatches being
// claimed faster than they can be executed — inside a generic timeout bucket.
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
const src = fs.readFileSync(path.join(here, '..', 'app', 'src', 'db.js'), 'utf8');

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-nps-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

let n = 0;
function scheduledTask() {
  const job = db.upsertJob({ title: `Role ${++n}`, company: `Co${n}`, source: 'linkedin', status: 'started', jobUrl: `https://x/j/${n}` }).job;
  const t = db.queueAdd(job.id, { mode: 'auto' });
  db.queuePatch(t.id, { state: 'scheduled', transcriptAppend: { note: 'scheduled (mode=auto)' } });
  return t.id;
}

test('a claim the executor never touched goes back to QUEUED, not failed', () => {
  const id = scheduledTask();
  db.reconcileStaleRunning({ olderThanMinutes: -1, scheduledOlderThanMinutes: -1 });
  const t = db.queueGet(id);
  assert.equal(t.state, 'queued', 'it was never attempted, so it is not a failure');
  assert.equal(t.lastError, null, 'and it carries no error to slander the posting with');
});

test('it costs no attempt — nothing happened to charge for', () => {
  const id = scheduledTask();
  const before = db.queueGet(id).attempts;
  db.reconcileStaleRunning({ olderThanMinutes: -1, scheduledOlderThanMinutes: -1 });
  assert.equal(db.queueGet(id).attempts, before);
});

test('a task that DID run and stalled is still marked failed', () => {
  const id = scheduledTask();
  // Real executor activity — this is a genuine stall, and must keep its old behaviour.
  db.queuePatch(id, { state: 'running', transcriptAppend: { note: 'opened apply page' } });
  db.queuePatch(id, { transcriptAppend: { note: 'filled 6 fields' } });
  db.reconcileStaleRunning({ olderThanMinutes: -1, scheduledOlderThanMinutes: -1 });
  const t = db.queueGet(id);
  assert.equal(t.state, 'failed');
  assert.match(String(t.lastError), /timed out \/ interrupted/);
});

test('the self-heal note alone does not count as activity', () => {
  // The live sample contained exactly this: two "scheduled" notes and one self-heal note. If the
  // self-heal note counted as real activity, the 127 would still be misfiled as failures.
  const id = scheduledTask();
  db.queuePatch(id, { transcriptAppend: { note: 'self-heal retry after transient_page (environmental — no attempt charged)' } });
  db.queuePatch(id, { state: 'scheduled', transcriptAppend: { note: 'scheduled (mode=auto)' } });
  db.reconcileStaleRunning({ olderThanMinutes: -1, scheduledOlderThanMinutes: -1 });
  assert.equal(db.queueGet(id).state, 'queued');
});

test('a task that clicked the final submit is STILL routed to awaiting_review', () => {
  // The duplicate-application guard outranks everything here: re-applying to a job Pierre may have
  // already applied to is worse for him than a missed application.
  const id = scheduledTask();
  db.queuePatch(id, { state: 'running', transcriptAppend: { note: 'chose "Submit application" isFinalSubmit(true)' } });
  db.reconcileStaleRunning({ olderThanMinutes: -1, scheduledOlderThanMinutes: -1 });
  const t = db.queueGet(id);
  assert.notEqual(t.state, 'queued', 'it must never be silently re-queued for a second application');
});

test('a fresh claim is left alone — only STALE ones are reconciled', () => {
  const id = scheduledTask();
  db.reconcileStaleRunning({ olderThanMinutes: 8, scheduledOlderThanMinutes: 5 });
  assert.equal(db.queueGet(id).state, 'scheduled', 'the executor is still within its window to start');
});

test('the 2-minute claim window is DELIBERATELY unchanged', () => {
  // Widening it was the obvious move, and it is wrong. That window exists to free the serial worker
  // slot fast — the pump counts 'scheduled' as busy — on live evidence of ~9 stranded claims/hour
  // (see stranded-claim-window.test.mjs). Waiting 5 minutes would block the single slot for 5
  // minutes. The bug was never the TIMING; it was recording a never-started claim as a FAILURE,
  // and fixing the outcome works at any window.
  assert.match(src, /scheduledOlderThanMinutes = 2/, 'the prior decision stands');
});

test('the forensics that justify this are recorded', () => {
  const fn = src.slice(src.indexOf('function reconcileStaleRunning('), src.indexOf('function reclaimDeadParks'));
  assert.match(fn, /127 of 185|127 had/, 'the measurement, so the next person does not re-derive it');
  assert.match(fn, /never (ran|started)/i);
});
