// Fix 3 — auto-ASSISTED vs pure MANUAL lineage on a harvested capture.
// When an application is finished/assisted by the user but an AUTO auto-apply task
// (mode='auto') exists for that job, the harvested answers are tagged lineage
// 'auto-assisted' (the auto run set it up, a human stepped in). With NO auto task the
// capture is pure 'manual'. Runs against a temp DB.
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
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-lineage-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

// Read the most-recent lineage source recorded for a harvested question.
function lineageSourceFor(profileId, question) {
  const rows = db.qaList(profileId, 500);
  const norm = db.normalizeQuestion(question);
  const row = rows.find((r) => r.question_norm === norm);
  assert.ok(row, `qa row for "${question}" exists`);
  const lineage = JSON.parse(row.answer_lineage || '[]');
  assert.ok(lineage.length, 'lineage trail is non-empty');
  return lineage[lineage.length - 1].source;
}

test("harvest tags 'auto-assisted' when an AUTO task exists for the job", () => {
  const job = db.upsertJob({
    externalId: 'lin-auto-1', title: 'Engineer', company: 'Acme',
    source: 'linkedin', status: 'started', jobUrl: 'https://x/auto-1',
  }, { skipHarvest: true }).job;
  // An AUTO auto-apply task ran for this job (it can have ended any way).
  const task = db.queueAdd(job.id, { mode: 'auto' });
  db.queuePatch(task.id, { state: 'failed', lastError: 'apply timed out' });
  const pid = db.resolveProfileId('linkedin');

  const n = db.harvestAnswersToProfile(
    { 'years_of_experience': '5' },
    { profileId: pid, jobId: job.id, source: 'linkedin', status: 'submitted' });
  assert.ok(n >= 1, 'harvested at least one field');
  assert.equal(lineageSourceFor(pid, 'Years Of Experience'), 'auto-assisted');
});

test("harvest tags pure 'manual' when NO auto task exists for the job", () => {
  const job = db.upsertJob({
    externalId: 'lin-manual-1', title: 'Engineer', company: 'Beta',
    source: 'linkedin', status: 'started', jobUrl: 'https://x/manual-1',
  }, { skipHarvest: true }).job;
  // No auto_apply_task at all for this job → pure manual.
  const pid = db.resolveProfileId('linkedin');

  const n = db.harvestAnswersToProfile(
    { 'preferred_start_date': 'Immediately' },
    { profileId: pid, jobId: job.id, source: 'linkedin', status: 'submitted' });
  assert.ok(n >= 1, 'harvested at least one field');
  assert.equal(lineageSourceFor(pid, 'Preferred Start Date'), 'manual');
});

test("a SUPERVISED/REVIEW task does NOT make it auto-assisted (only mode='auto' does)", () => {
  const job = db.upsertJob({
    externalId: 'lin-sup-1', title: 'Engineer', company: 'Gamma',
    source: 'linkedin', status: 'started', jobUrl: 'https://x/sup-1',
  }, { skipHarvest: true }).job;
  const task = db.queueAdd(job.id, { mode: 'supervised' });
  db.queuePatch(task.id, { state: 'awaiting_review' });
  const pid = db.resolveProfileId('linkedin');

  const n = db.harvestAnswersToProfile(
    { 'work_authorization': 'Yes' },
    { profileId: pid, jobId: job.id, source: 'linkedin', status: 'submitted' });
  assert.ok(n >= 1, 'harvested at least one field');
  assert.equal(lineageSourceFor(pid, 'Work Authorization'), 'manual');
});
