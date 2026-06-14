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
  db.queuePatch(task.id, { state, applyRoute, lastError });
  return task;
}

test('migration v7: apply_route column exists and queuePatch persists it', () => {
  const t = queueJob({ source: 'linkedin', url: 'https://x/1', state: 'done', applyRoute: 'easy-apply' });
  const got = db.queueList({}).find((x) => x.id === t.id);
  assert.equal(got.applyRoute, 'easy-apply');
});

test('a routeless patch preserves the prior route (COALESCE)', () => {
  const t = queueJob({ source: 'linkedin', url: 'https://x/2', state: 'running', applyRoute: 'easy-apply' });
  db.queuePatch(t.id, { state: 'done' });   // no applyRoute in this patch
  const got = db.queueList({}).find((x) => x.id === t.id);
  assert.equal(got.applyRoute, 'easy-apply', 'route survives a later state-only patch');
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
    db.queuePatch(db.queueAdd(j.id, { mode: 'auto' }).id, { state });
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
