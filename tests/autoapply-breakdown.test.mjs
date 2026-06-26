// Auto-apply v11.12.0 backend: the apply_route column (migration v7) + its
// COALESCE-preserving patch, the breakdown aggregation that powers the dashboard
// chart, and start-based pacing (queueRunStats.lastStart). Runs against a temp DB.
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
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-aa-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

function queueJob({ source, url, state, applyRoute, lastError }) {
  // Distinct externalId per job — otherwise upsertJob dedups same-title/company
  // postings into one row (a test-data artifact, not product behaviour).
  const job = db.upsertJob({ externalId: url, title: 'Dev ' + url, company: 'Acme', source, status: 'started', jobUrl: url }).job;
  const task = db.queueAdd(job.id, { mode: 'auto' });
  db.queuePatch(task.id, {
    state, applyRoute, lastError,
    submissionEvidence: state === 'done' ? { type: 'test-confirmation' } : undefined,
    pendingQuestions: state === 'awaiting_input' || state === 'parked' ? [{ question: 'Test input?', reason: lastError || 'test' }] : undefined,
  });
  return task;
}

test('migration v7: apply_route column exists and queuePatch persists it', () => {
  const t = queueJob({ source: 'linkedin', url: 'https://x/1', state: 'done', applyRoute: 'easy-apply' });
  const got = db.queueList({}).find((x) => x.id === t.id);
  assert.equal(got.applyRoute, 'easy-apply');
});

test('a routeless patch preserves the prior route (COALESCE)', () => {
  const t = queueJob({ source: 'linkedin', url: 'https://x/2', state: 'running', applyRoute: 'easy-apply' });
  db.queuePatch(t.id, { state: 'done', submissionEvidence: { type: 'test-confirmation' } });   // no applyRoute in this patch
  const got = db.queueList({}).find((x) => x.id === t.id);
  assert.equal(got.applyRoute, 'easy-apply', 'route survives a later state-only patch');
});

test('stats(): MANUAL = submitted with no auto-apply task; awaiting_review/skipped tasks are AUTO, not manual', () => {
  // The bug: "manual" was submittedTotal − done-tasks, so every auto-apply that ended
  // awaiting_review/skipped/failed (and Gmail captures) was mislabeled "by hand" (~49%). Manual must
  // mean "JAT never ran an auto task for it" — consistent with annotateAutoApply's `via` tagging.
  const before = db.stats();
  // (a) submitted, NO auto task → the only true MANUAL
  db.upsertJob({ externalId: 'man-1', title: 'Hand Dev', company: 'HandCo', source: 'linkedin', status: 'submitted', jobUrl: 'https://x/man-1' });
  // (b) submitted + an awaiting_review auto task (bot filled + clicked submit) → AUTO
  const jb = db.upsertJob({ externalId: 'auto-ar', title: 'AR Dev', company: 'ARCo', source: 'linkedin', status: 'submitted', jobUrl: 'https://x/auto-ar' }).job;
  db.queuePatch(db.queueAdd(jb.id, { mode: 'auto' }).id, { state: 'awaiting_review' });
  // (c) submitted + only a SKIPPED auto task (bot tracked it; submitted via capture) → AUTO, not manual
  const jc = db.upsertJob({ externalId: 'auto-sk', title: 'SK Dev', company: 'SKCo', source: 'linkedin', status: 'submitted', jobUrl: 'https://x/auto-sk' }).job;
  db.queuePatch(db.queueAdd(jc.id, { mode: 'auto' }).id, { state: 'skipped', lastError: 'external' });
  const after = db.stats();
  assert.equal(after.submittedManual - before.submittedManual, 1, 'only the NO-task job is manual');
  assert.equal(after.submittedAuto - before.submittedAuto, 2, 'awaiting_review + skipped-with-task are auto, not manual');
  assert.equal(after.submittedAuto + after.submittedManual, after.submittedTotal, 'auto + manual === total');
});

test('queueBreakdown aggregates by outcome, board, route, and reasons', () => {
  const before = db.queueBreakdown({ days: 30 });
  queueJob({ source: 'linkedin', url: 'https://x/b1', state: 'done', applyRoute: 'easy-apply' });
  queueJob({ source: 'indeed', url: 'https://x/b2', state: 'failed', applyRoute: 'easy-apply', lastError: 'resume attachment failed' });
  queueJob({ source: 'linkedin', url: 'https://x/b3', state: 'awaiting_input', applyRoute: 'external', lastError: 'application did not open (not Easy-Apply / verification)' });
  const bd = db.queueBreakdown({ days: 30 });
  assert.equal(bd.total, before.total + 3, 'total counts every task touched in range');
  assert.ok((bd.byOutcome.submitted || 0) >= 1, 'done → submitted');
  assert.ok((bd.byOutcome.failed || 0) >= 1, 'failed bucket');
  assert.ok((bd.byOutcome.needs_you || 0) >= 1, 'awaiting_input → needs_you');
  assert.ok(bd.byBoard.linkedin && bd.byBoard.indeed, 'split by board');
  assert.ok(bd.byRoute['easy-apply'] && bd.byRoute.external, 'split by route (easy vs external)');
  assert.ok(bd.topReasons.some((r) => /did not open/.test(r.reason)), 'external reason surfaced');
  assert.ok(bd.topReasons.some((r) => /resume attachment/.test(r.reason)), 'fail reason surfaced');
});

test('queueRunStats exposes lastStart (start-based pacing)', () => {
  const job = db.upsertJob({ title: 'Dev', company: 'Acme', source: 'linkedin', status: 'started', jobUrl: 'https://x/ls1' }).job;
  const task = db.queueAdd(job.id, { mode: 'auto' });
  db.queuePatch(task.id, { state: 'scheduled', scheduledAt: new Date().toISOString() });
  const st = db.queueRunStats();
  assert.ok(st.lastStart, 'lastStart is populated from scheduled_at');
});

test('queueLive reports in-flight workers with their current step', () => {
  const j = db.upsertJob({ externalId: 'live1', title: 'Dev live1', company: 'Acme', source: 'linkedin', status: 'started', jobUrl: 'https://x/live1' }).job;
  const t = db.queueAdd(j.id, { mode: 'auto' });
  db.queuePatch(t.id, { state: 'running', scheduledAt: new Date().toISOString(), transcriptAppend: { text: 'filling fields…' } });
  const live = db.queueLive({});
  const mine = live.running.find((w) => w.taskId === t.id);
  assert.ok(mine, 'a running task shows as an active worker');
  assert.equal(mine.step, 'filling fields…', 'current step = last transcript entry');
  assert.ok(live.active >= 1, 'active worker count includes it');
});

test('queueLive session counts: submitted = done ONLY, awaiting_review is separate', () => {
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const mk = (id, state) => {
    const j = db.upsertJob({ externalId: id, title: 'Dev ' + id, company: 'Acme', source: 'indeed', status: 'started', jobUrl: 'https://x/' + id }).job;
    db.queuePatch(db.queueAdd(j.id, { mode: 'auto' }).id, {
      state,
      submissionEvidence: state === 'done' ? { type: 'test-confirmation' } : undefined,
      pendingQuestions: state === 'parked' ? [{ question: 'Test question?', reason: 'test' }] : undefined,
    });
  };
  const before = db.queueLive({ startedAt: since }).session;
  mk('sess-done', 'done');
  mk('sess-rev', 'awaiting_review');
  mk('sess-park', 'parked');
  const after = db.queueLive({ startedAt: since }).session;
  assert.equal(after.submitted, before.submitted + 1, 'only done counts as submitted');
  assert.equal(after.readyForReview, before.readyForReview + 1, 'awaiting_review counted separately, not as submitted');
  assert.equal(after.parked, before.parked + 1, 'parked counted separately');
});

test('queueBreakdown no longer folds awaiting_review into submitted', () => {
  const j = db.upsertJob({ externalId: 'br-rev', title: 'Dev br-rev', company: 'Acme', source: 'linkedin', status: 'started', jobUrl: 'https://x/br-rev' }).job;
  db.queuePatch(db.queueAdd(j.id, { mode: 'auto' }).id, { state: 'awaiting_review', applyRoute: 'easy-apply' });
  const bd = db.queueBreakdown({ days: 30 });
  assert.ok((bd.byOutcome.needs_you || 0) >= 1, 'awaiting_review now maps to needs_you, not submitted');
});

// ---- R3: honest, run-scoped summarizeRun (pure) — one fixture per bucket + both rates ----
test('summarizeRun buckets every category and keeps awaiting_review out of verified', () => {
  // Raw task-row shape (state/last_error/park_reason/pending_questions/transcript) — exactly
  // what classifyQueueFailure reads, so this is a pure unit test with no DB.
  const rows = [
    { state: 'done' },                                                                      // verified_done
    { state: 'done' },                                                                      // verified_done
    { state: 'awaiting_review' },                                                           // awaiting_review (the honest "maybe")
    { state: 'skipped', park_reason: 'bot_challenge', last_error: 'bot challenge (cloudflare) — needs human verification' }, // bot_challenge
    { state: 'skipped', last_error: 'site sign-in required before applying — skipped' },     // site_gate
    { state: 'failed', last_error: 'page stopped advancing — did not change' },              // flow_failed (transient_page)
    { state: 'failed', last_error: 'auto-apply failed without a diagnostic' },               // flow_failed (unknown_failure)
    { state: 'parked', pending_questions: JSON.stringify([{ question: 'Salary?', reason: 'missing answer' }]) }, // needs_you
    { state: 'skipped', last_error: 'external — apply on the company site (not auto-applicable)' }, // skipped (out of scope)
    { state: 'running' },                                                                   // in_flight
  ];
  const { counts, rawRate, supportedRate, drivable } = db.summarizeRun(rows);
  assert.equal(counts.dispatched, 10);
  assert.equal(counts.verified_done, 2);
  assert.equal(counts.awaiting_review, 1, 'awaiting_review is its own bucket, never verified');
  assert.equal(counts.bot_challenge, 1);
  assert.equal(counts.site_gate, 1);
  assert.equal(counts.flow_failed, 2, 'transient + unknown both count as our flow failure');
  assert.equal(counts.needs_you, 1);
  assert.equal(counts.skipped, 1);
  assert.equal(counts.in_flight, 1);
  // Raw verified rate = verified ÷ dispatched (brutally honest) = 2/10.
  assert.equal(rawRate, 0.2);
  // Supported rate = verified ÷ (dispatched − bot − site − skipped − in_flight) = 2/(10−1−1−1−1)=2/6.
  assert.equal(drivable, 6);
  assert.equal(Math.round(supportedRate * 1000), Math.round((2 / 6) * 1000));
});

test('summarizeRun edge cases: zero dispatched and an all-gated run', () => {
  const empty = db.summarizeRun([]);
  assert.equal(empty.counts.dispatched, 0);
  assert.equal(empty.rawRate, 0, 'no divide-by-zero on an empty run');
  assert.equal(empty.supportedRate, 0);
  assert.equal(empty.drivable, 0);
  // All-gated run: every job blocked by the site → drivable is 0, both rates are honestly 0
  // (NOT a misleading 100% or NaN), and none of it reads as our failure.
  const gated = db.summarizeRun([
    { state: 'skipped', park_reason: 'bot_challenge', last_error: 'bot-challenge cooldown — verification wall' },
    { state: 'skipped', last_error: 'captcha — needs you to sign in' },
  ]);
  assert.equal(gated.counts.flow_failed, 0, 'gates are not counted as our failures');
  assert.equal(gated.drivable, 0);
  assert.equal(gated.rawRate, 0);
  assert.equal(gated.supportedRate, 0, 'all-gated run is 0% supported, not NaN/100%');
});

test('queueRunSummary scopes to the run (since) and matches the endpoint shape', () => {
  // Anything before `since` must NOT count toward the current run.
  const old = db.upsertJob({ externalId: 'run-old', title: 'Dev run-old', company: 'Acme', source: 'linkedin', status: 'started', jobUrl: 'https://x/run-old' }).job;
  db.queuePatch(db.queueAdd(old.id, { mode: 'auto' }).id, { state: 'done', submissionEvidence: { type: 'test-confirmation' } });
  const runStart = new Date(Date.now() + 5).toISOString();   // mark the run start AFTER the old task
  const j = db.upsertJob({ externalId: 'run-new', title: 'Dev run-new', company: 'Acme', source: 'linkedin', status: 'started', jobUrl: 'https://x/run-new' }).job;
  db.queuePatch(db.queueAdd(j.id, { mode: 'auto' }).id, { state: 'done', submissionEvidence: { type: 'test-confirmation' } });
  const sum = db.queueRunSummary({ startedAt: runStart });
  // endpoint shape: { since, counts:{…}, rawRate, supportedRate, drivable }
  assert.equal(sum.since, runStart);
  assert.ok(sum.counts && typeof sum.counts.dispatched === 'number', 'has counts.dispatched');
  assert.ok('rawRate' in sum && 'supportedRate' in sum && 'drivable' in sum, 'has both rates + drivable');
  assert.equal(sum.counts.verified_done, 1, 'only the in-run verified submit counts (the older one is out of scope)');
  assert.equal(sum.counts.dispatched, 1, 'run scoping excludes pre-run tasks');
});
