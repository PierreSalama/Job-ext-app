// P7 (Apprenticeship Engine) — Strict Relevance + Punishment Gate + unified rankJob.
// Drives the REAL db paths (db.punish / punishCompanyCascade / isPunished / rankJob /
// geoPenalty) on a temp DB. createRequire harness mirrored from reward-match.test.mjs.
//
// Covers, per the P7 charter:
//   • punishing a COMPANY cascade-skips its QUEUED tasks AND isPunished(job)=true for that
//     company while active; a job at a DIFFERENT company is unaffected.
//   • a high-reward (ats,company) job (seeded application_outcomes) OUTRANKS a fit-equal job
//     at a cold company.
//   • an unauthorized-region ON-SITE job ranks BELOW an equivalent remote/authorized job;
//     fabrication never happens — NO authorization on file → NO penalty (not a guess).
//   • punishment DECAY: a punishment with a PAST decay_at no longer counts (eligibility
//     restored); a PERMANENT (decayDays null/0) punishment stays active.
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
const { Database } = require(path.join(here, '..', 'app', 'node_modules', 'node-sqlite3-wasm'));

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-rank-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

// Force a punishment's decay_at to a date in the PAST so we can exercise true expiry (the
// db.punish API only ever writes future/permanent decay). Uses a short-lived second handle to
// the same file — db.js holds no transaction open between our synchronous test calls.
function expirePunishment(id) {
  const h = new Database(path.join(dir, 'jat.db'));
  try { h.run('UPDATE punishments SET decay_at = ? WHERE id = ?', [new Date(Date.now() - 86400e3).toISOString(), id]); }
  finally { h.close(); }
}

// Create a job (manual = bypass dedup) and return it. Default status 'started' so it is a live
// (un-applied) candidate the queue/discovery would consider.
function mkJob({ title = 'Software Engineer', company, jobUrl, location = '', workMode = '', status = 'started', description = '' }) {
  const { job } = db.upsertJob({ title, company, jobUrl, location, workMode, status, description, source: 'greenhouse' }, { manual: true });
  return job;
}
// Queue a job (force so it is enqueued even though a prior task may exist).
function queue(jobId) { return db.queueAdd(jobId, { mode: 'auto', force: true }); }
function taskState(taskId) { return db.queueList({}).find((t) => t.id === taskId)?.state; }

test('punish company → cascade-skips its QUEUED tasks + isPunished(job)=true; other company untouched', () => {
  const pid = db.ensureDefaultProfileId();
  const punA = mkJob({ company: 'BadCorp', jobUrl: 'https://boards.greenhouse.io/badcorp/jobs/1' });
  const punA2 = mkJob({ company: 'BadCorp', jobUrl: 'https://boards.greenhouse.io/badcorp/jobs/2' });
  const otherB = mkJob({ company: 'GoodCorp', jobUrl: 'https://boards.greenhouse.io/goodcorp/jobs/9' });
  const tA = queue(punA.id), tA2 = queue(punA2.id), tB = queue(otherB.id);
  assert.equal(taskState(tA.id), 'queued');
  assert.equal(taskState(tB.id), 'queued');

  const p = db.punish({ profileId: pid, kind: 'company', pattern: 'BadCorp' });
  assert.ok(p && p.id, 'punishment row created');
  const cascaded = db.punishCompanyCascade(pid, 'BadCorp');
  assert.equal(cascaded, 2, 'both BadCorp queued tasks cascade-skipped');

  assert.equal(taskState(tA.id), 'skipped', 'BadCorp task #1 skipped');
  assert.equal(taskState(tA2.id), 'skipped', 'BadCorp task #2 skipped');
  assert.equal(taskState(tB.id), 'queued', 'GoodCorp task NOT skipped');

  assert.equal(db.isPunished(punA, pid), true, 'BadCorp job is punished while active');
  assert.equal(db.isPunished(otherB, pid), false, 'GoodCorp job is NOT punished');
  // rankJob excludes a punished job (strongly negative) vs a positive-ish cold job.
  assert.ok(db.rankJob(punA, pid) < 0, 'punished job ranks negative (excluded)');
  assert.ok(db.rankJob(otherB, pid) >= 0, 'un-punished job ranks non-negative');

  db.unpunish(p.id);   // clean up so later tests aren't affected
  assert.equal(db.isPunished(punA, pid), false, 'unpunish restores eligibility');
});

test('a high-reward (ats,company) job outranks a fit-equal cold-company job', () => {
  const pid = db.ensureDefaultProfileId();
  // Give the profile skills so fit.js produces a non-zero, equal base for both jobs.
  db.saveProfile({ id: pid, name: 'Main', isDefault: true, sourceAssignments: [], data: { skills: ['python', 'django', 'sql'] } });
  const desc = 'We need python django sql experience for this backend role.';
  const hot = mkJob({ title: 'Backend Engineer', company: 'HotCo', jobUrl: 'https://boards.greenhouse.io/hotco/jobs/1', description: desc });
  const cold = mkJob({ title: 'Backend Engineer', company: 'ColdCo', jobUrl: 'https://boards.greenhouse.io/coldco/jobs/1', description: desc });

  // Seed a POSITIVE interview-reply outcome for HotCo (its company_key track record).
  const out = db.recordOutcome({ jobId: hot.id, profileId: pid, reward: 0.9, rewardKind: 'email_reply' });
  assert.ok(out && out.id, 'outcome ledger row written for HotCo');

  const rHot = db.rankJob(hot, pid);
  const rCold = db.rankJob(cold, pid);
  assert.ok(rHot > rCold, `HotCo (${rHot.toFixed(4)}) outranks fit-equal ColdCo (${rCold.toFixed(4)})`);
  // The bonus is bounded (≤ ~0.3 over the base), so reward can't dominate fit.
  assert.ok(rHot - rCold <= 0.31, 'reward bonus stays bounded (≤ ~0.3)');
});

test('unauthorized-region on-site job ranks below remote/authorized — and absent auth never fabricates a penalty', () => {
  const pid = db.ensureDefaultProfileId();
  // TRUTHFUL authorization on file: the user is authorized for Canada only.
  db.saveProfile({ id: pid, name: 'Main', isDefault: true, sourceAssignments: [], data: { skills: ['python'], workAuthRegions: ['Canada'] } });

  const desc = 'python backend role.';
  const remoteOk = mkJob({ title: 'Backend Engineer', company: 'RemCo', jobUrl: 'https://boards.greenhouse.io/remco/jobs/1', workMode: 'Remote', location: 'Anywhere', description: desc });
  const onsiteUnauth = mkJob({ title: 'Backend Engineer', company: 'UsCo', jobUrl: 'https://boards.greenhouse.io/usco/jobs/1', workMode: 'On-site', location: 'Austin, Texas, United States', description: desc });

  // geoPenalty: remote+authorized → 0; on-site in an unauthorized region → > 0.
  assert.equal(db.geoPenalty(remoteOk, pid), 0, 'remote + authorized → no geo penalty');
  assert.ok(db.geoPenalty(onsiteUnauth, pid) > 0, 'on-site in unauthorized region → geo penalty');
  assert.ok(db.rankJob(remoteOk, pid) > db.rankJob(onsiteUnauth, pid), 'remote/authorized outranks unauthorized on-site');

  // FABRICATION RAIL: a DIFFERENT profile with NO authorization on file → geoPenalty must be 0
  // for the SAME on-site job (we never guess authorization the user hasn't stated).
  const blankProfile = db.saveProfile({ name: 'NoAuth', isDefault: false, sourceAssignments: [], data: { skills: ['python'] } });
  assert.equal(db.geoPenalty(onsiteUnauth, blankProfile.id), 0, 'no authorization on file → NO penalty (never fabricated)');
});

test('punishment DECAY: a past decay_at no longer counts (eligibility restored)', () => {
  const pid = db.ensureDefaultProfileId();
  const job = mkJob({ title: 'QA Tester', company: 'DecayCo', jobUrl: 'https://boards.greenhouse.io/decayco/jobs/1' });

  // Fresh company punishment with a future (default) decay → ACTIVE now.
  const p = db.punish({ profileId: pid, kind: 'company', pattern: 'DecayCo' });
  assert.equal(db.isPunished(job, pid), true, 'fresh punishment is active');
  assert.ok(db.listPunishments(pid).some((x) => x.id === p.id), 'active list includes it while in the future');
  assert.ok(db.punishmentPenalty(job, pid) === 1, 'penalty 1.0 while active');

  // Fast-forward its decay_at into the PAST → it must STOP counting.
  expirePunishment(p.id);
  assert.equal(db.isPunished(job, pid), false, 'expired punishment no longer counts (eligibility restored)');
  assert.equal(db.punishmentPenalty(job, pid), 0, 'expired punishment → penalty 0');
  assert.ok(!db.listPunishments(pid).some((x) => x.id === p.id), 'expired punishment is filtered out of the active list');
  // A different active punishment is unaffected by the expired one.
  const jt = db.punish({ profileId: pid, kind: 'job_type', pattern: 'QA Tester' });
  assert.equal(db.isPunished(job, pid), true, 'a separate active job_type punishment still applies');
  db.unpunish(jt.id);
  db.unpunish(p.id);
});

test('permanent punishment (decayDays null/0) stays active', () => {
  const pid = db.ensureDefaultProfileId();
  const job = mkJob({ title: 'Sales Rep', company: 'PermCo', jobUrl: 'https://boards.greenhouse.io/permco/jobs/1' });

  const perm0 = db.punish({ profileId: pid, kind: 'company', pattern: 'PermCo', decayDays: 0 });
  assert.equal(perm0.decayAt, null, 'decayDays 0 → permanent (decay_at NULL)');
  assert.equal(db.isPunished(job, pid), true, 'permanent (decayDays 0) punishment is active');
  const list = db.listPunishments(pid);
  assert.ok(list.some((x) => x.id === perm0.id && x.decayAt === null), 'permanent punishment is in the active list with null decay');
  db.unpunish(perm0.id);

  const permNull = db.punish({ profileId: pid, kind: 'job', pattern: job.id, decayDays: null });
  assert.equal(permNull.decayAt, null, 'decayDays null → permanent');
  assert.equal(db.isPunished(job, pid), true, 'permanent job-id punishment is active');
  db.unpunish(permNull.id);
});
