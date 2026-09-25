// The AI lane always showed 0 credited: ai_runs.job_id was read everywhere and written nowhere.
// log_application (the confirmed-submission tool) now links the calling run to the job row.
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
const { makeJatTools } = require_(path.join(here, '..', 'app', 'src', 'ai', 'tools', 'jat.js'));

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-runlink-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('log_application credits the run, and performance shows withJob + agent', async () => {
  const runId = db.aiRunCreate({ goal: 'apply to Acme' });
  const tools = makeJatTools({ getRunId: () => runId }).tools;
  const log = tools.find((t) => t.name === 'log_application');
  const args = { company: 'Acme Robotics', title: 'Software Engineer', url: 'https://boards.greenhouse.io/acme/jobs/123' };
  assert.equal(log.guard(args), null);
  const out = await log.run(args);
  assert.match(out, /logged/);
  const row = db.aiRunGet(runId);
  const jobId = row.jobId || row.job_id;
  assert.ok(jobId, 'the run must now point at the job');
  assert.equal(db.getJob(jobId).status, 'submitted');
  db.aiRunFinish(runId, { status: 'done', summary: 'submitted' });
  const perf = db.aiPerformance({ days: 1 });
  assert.ok(perf.runs.withJob >= 1);
  assert.ok(perf.submittedBy.agent >= 1, 'the AI lane is credited');
  // Re-running the linker never re-points an already linked run.
  const other = db.upsertJob({ company: 'Other', title: 'Dev', status: 'submitted', submittedAt: new Date().toISOString(), tags: ['AI-APPLY'] }, { source: 'manual', manual: true });
  db.aiRunLinkJob(runId, (other.job || other).id);
  assert.equal(db.aiRunGet(runId).jobId || db.aiRunGet(runId).job_id, jobId);
  // The false-submit reconciler leaves it alone.
  db.reconcileFalseSubmits();
  assert.equal(db.getJob(jobId).status, 'submitted');
});

test('backfill links a done run to the single AI-logged job in its window, never an ambiguous one', () => {
  // An earlier unclaimed AI-logged job from the first test's "Other" row makes this ambiguous.
  const r0 = db.aiRunCreate({ goal: 'g0' });
  const r1 = db.aiRunCreate({ goal: 'g1' });
  const j = db.upsertJob({ company: 'Backfill Co', title: 'Engineer', status: 'submitted', submittedAt: new Date().toISOString(), tags: ['AI-APPLY'] }, { source: 'manual', manual: true });
  db.aiRunFinish(r0, { status: 'done', summary: 'ok' });
  db.aiRunFinish(r1, { status: 'done', summary: 'ok' });
  assert.equal(db.aiRunsBackfillJobLinks(), 0, 'two unclaimed candidates in the window is ambiguous: no guess');
  const otherRow = db.listJobs({ q: 'Other', limit: 5 })[0];
  assert.ok(otherRow, 'the unclaimed job exists');
  db.aiRunLinkJob(r0, otherRow.id);            // claim it, removing the ambiguity
  const n = db.aiRunsBackfillJobLinks();
  assert.ok(n >= 1);
  assert.equal(db.aiRunGet(r1).jobId || db.aiRunGet(r1).job_id, (j.job || j).id);
  assert.equal(db.aiRunsBackfillJobLinks(), 0, 'idempotent');
});
