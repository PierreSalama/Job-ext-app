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
const server = require(path.join(here, '..', 'app', 'src', 'server.js'));

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-policy-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

function addTask({ source = 'linkedin', url, state = 'queued', lastError = '', pendingQuestions = null }) {
  const job = db.upsertJob({ externalId: url, title: 'Developer ' + url, company: 'Acme', source, status: 'started', jobUrl: url }).job;
  const task = db.queueAdd(job.id, { mode: 'auto' });
  db.queuePatch(task.id, { state, lastError, pendingQuestions });
  return { job, task: db.queueList({}).find((t) => t.id === task.id) };
}

test('jobFit excludeKeywords: whole-word for single tokens, substring for phrases, title-only', () => {
  const aa = { seniorityMax: 'any', excludeKeywords: ['sales', 'senior', 'lead', 'account executive', 'business development'] };
  // Sales/seniority roles whose TITLE carries the word → rejected.
  assert.equal(server.jobFit({ title: 'Sales Representative' }, aa).ok, false);
  assert.equal(server.jobFit({ title: 'Senior Software Engineer' }, aa).ok, false);
  assert.equal(server.jobFit({ title: 'Account Executive' }, aa).ok, false);          // phrase substring
  assert.equal(server.jobFit({ title: 'Business Development Manager' }, aa).ok, false); // phrase substring
  // Whole-word must NOT false-positive on a legit eng title that merely CONTAINS the token.
  assert.equal(server.jobFit({ title: 'Salesforce Developer' }, aa).ok, true);   // 'sales' ⊄ whole-word in 'salesforce'
  assert.equal(server.jobFit({ title: 'Leadership Tooling Engineer' }, aa).ok, true); // 'lead' ⊄ 'leadership'
  assert.equal(server.jobFit({ title: 'Software Engineer' }, aa).ok, true);
  // Description never triggers exclusion (title-only) — a JD that says "report to a Senior Manager"
  // must NOT be excluded by the 'senior'/'manager' keywords.
  assert.equal(server.jobFit({ title: 'Backend Developer', description: 'You will report to a Senior Manager and lead nothing.' }, aa).ok, true);
});

test('classifyQueueFailure maps failures to retry/user/inspect policy', () => {
  assert.equal(db.classifyQueueFailure({ state: 'failed', last_error: 'Easy-Apply form did not hydrate — will retry' }).action, 'retry');
  assert.equal(db.classifyQueueFailure({ state: 'parked', pending_questions: JSON.stringify([{ question: 'Salary?', reason: 'missing answer' }]) }).action, 'user');
  assert.equal(db.classifyQueueFailure({ state: 'skipped', last_error: 'external — apply on the company site (not auto-applicable)' }).action, 'inspect');
  assert.equal(db.classifyQueueFailure({ state: 'skipped', last_error: 'site sign-in required before applying — skipped' }).action, 'user');
  assert.equal(db.classifyQueueFailure({ state: 'failed', last_error: 'Postuler sur le site de l’employeur; Easy-Apply form did not hydrate' }).action, 'inspect');
  assert.equal(db.classifyQueueFailure({ state: 'failed', _src: 'glassdoor', last_error: 'Easy-Apply form did not hydrate — will retry' }).action, 'inspect');
  // Loosened termination (regression fix): a first-attempt hydration miss on a throttled/
  // occluded tab and an un-attached external handoff are RETRIABLE transient failures, not
  // terminal external skips. Their lastError is kept free of external/company-site words.
  assert.equal(db.classifyQueueFailure({ state: 'failed', last_error: 'apply form did not hydrate on a throttled/occluded tab — will retry' }).action, 'retry');
  assert.equal(db.classifyQueueFailure({ state: 'failed', last_error: 'apply handoff did not attach — page did not change; will retry' }).action, 'retry');
  // Account-walled ATS + un-groundable external sites are TERMINAL — never re-dispatched (they'd
  // burn the retry cap on a job that can't be auto-submitted). Even when the text contains a
  // transient word like "stuck", the account/external check runs FIRST.
  assert.equal(db.classifyQueueFailure({ state: 'failed', last_error: 'Workday account required — sign in once and I will continue' }).action, 'user');
  assert.equal(db.classifyQueueFailure({ state: 'failed', last_error: 'iCIMS account/login required' }).action, 'user');
  assert.notEqual(db.classifyQueueFailure({ state: 'failed', last_error: 'no Easy Apply opener and no drivable form appeared (visible tab)' }).action, 'retry');
  assert.equal(db.classifyQueueFailure({ state: 'failed', last_error: "couldn't drive the company application site — needs you (stuck on a step)" }).action, 'inspect');
  // Chrome tab / MV3 worker teardown races are recoverable → retry (not a dead unknown_failure).
  assert.equal(db.classifyQueueFailure({ state: 'failed', last_error: 'No tab with id: 2145395281.' }).action, 'retry');
  assert.equal(db.classifyQueueFailure({ state: 'failed', last_error: 'Could not establish connection. Receiving end does not exist.' }).action, 'retry');
  // Site bot-gate (Cloudflare / CAPTCHA / verify wall, or host-cooldown park) is its OWN
  // category — distinct from a benign sign-in/captcha `site_gate` and from our-flow failures.
  assert.equal(db.classifyQueueFailure({ state: 'skipped', last_error: 'bot challenge (cloudflare) — needs human verification', park_reason: 'bot_challenge' }).failureClass, 'bot_challenge');
  assert.equal(db.classifyQueueFailure({ state: 'skipped', last_error: 'host under bot-challenge cooldown — site is serving a verification wall; will not retry this run' }).failureClass, 'bot_challenge');
  // ...and is NOT swallowed by the generic site_gate "human" matcher.
  assert.notEqual(db.classifyQueueFailure({ state: 'skipped', last_error: 'bot challenge (captcha) — needs human verification', park_reason: 'bot_challenge' }).failureClass, 'site_gate');
  const repeated = { state: 'failed', last_error: 'page stopped advancing', transcript: JSON.stringify([
    { kind: 'recovery', fingerprint: 'linkedin|step2|next|abc' },
    { kind: 'recovery', fingerprint: 'linkedin|step2|next|abc' },
  ]) };
  assert.equal(db.classifyQueueFailure(repeated).failureClass, 'repeated_failure');
  assert.equal(db.classifyQueueFailure(repeated).action, 'inspect');
});

test('classification exposes the retry gate used by stale retry', () => {
  const transient = addTask({ url: 'https://linkedin.com/jobs/view/transient', state: 'failed', lastError: 'Easy-Apply form did not hydrate — will retry' }).task;
  const external = addTask({ url: 'https://example.com/external', state: 'failed', lastError: 'external — apply on the company site (not auto-applicable)' }).task;
  assert.equal(db.classifyQueueFailure(db.queueList({}).find((t) => t.id === transient.id)).action, 'retry');
  assert.notEqual(db.classifyQueueFailure(db.queueList({}).find((t) => t.id === external.id)).action, 'retry');
});

test('FIX 5(b): easyApplyIngestEligible drops non-LinkedIn postings only when easyApplyOnly is ON', () => {
  // easyApplyOnly OFF → everything is eligible (behaviour unchanged).
  for (const src of ['linkedin', 'indeed', 'glassdoor', 'ziprecruiter', 'google', 'workday', '']) {
    assert.equal(server.easyApplyIngestEligible(src, false), true, `OFF should keep ${src || '(empty)'}`);
  }
  // easyApplyOnly ON → non-LinkedIn boards are always dropped (no real Easy-Apply concept).
  for (const src of ['indeed', 'glassdoor', 'ziprecruiter', 'google', 'workday', '', null, undefined]) {
    assert.equal(server.easyApplyIngestEligible(src, true), false, `ON should drop ${src || '(empty)'}`);
  }
});

test('ANTI-STARVATION: easyApplyOnly KEEPS all LinkedIn ingest (no capability gate); executor fast-skips externals', () => {
  // Discovery is JobSpy-only: every LinkedIn job is stamped applyCapability:'unknown'
  // (discovery/index.js) and the f_AL extension path that would stamp 'easy-apply' is NOT
  // running, and there is no apply_capability column to persist it. A capability gate here
  // would therefore drop EVERY LinkedIn job → empty queue → strictly worse than the flood.
  // So EA-only KEEPS LinkedIn regardless of capability; the EXECUTOR fast-skips a posting
  // that turns out external (detectLinkedInExternalPosting, ~35ms, terminal-skip).
  assert.equal(server.easyApplyIngestEligible('linkedin', true), true, 'bare LinkedIn must be kept (queue stays fed)');
  assert.equal(server.easyApplyIngestEligible('linkedin', true, { source: 'linkedin', applyCapability: 'unknown' }), true);
  assert.equal(server.easyApplyIngestEligible('linkedin', true, { source: 'linkedin', applyCapability: 'external' }), true);
  assert.equal(server.easyApplyIngestEligible('linkedin', true, { source: 'linkedin', applyCapability: 'easy-apply' }), true);
  assert.equal(server.easyApplyIngestEligible('LinkedIn', true), true, 'case-insensitive source');
  // Source can come from the record alone (browser-fallback / ingest-endpoint path).
  assert.equal(server.easyApplyIngestEligible(null, true, { source: 'linkedin' }), true);
  // Non-LinkedIn boards stay dropped under EA-only (no Easy-Apply concept there).
  assert.equal(server.easyApplyIngestEligible('indeed', true, { applyCapability: 'easy-apply' }), false, 'non-LinkedIn dropped even if mislabeled');
  // easyApplyOnly OFF → everything kept.
  assert.equal(server.easyApplyIngestEligible('linkedin', false, { source: 'linkedin', applyCapability: 'unknown' }), true);
  assert.equal(server.easyApplyIngestEligible('indeed', false), true);
});

test('queueActiveSiteKeys reports scheduled/running site keys for worker spreading', () => {
  addTask({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/123', state: 'running' });
  addTask({ source: 'indeed', url: 'https://ca.indeed.com/viewjob?jk=abc', state: 'scheduled' });
  const keys = db.queueActiveSiteKeys().map((x) => x.siteKey);
  assert.ok(keys.some((k) => /linkedin\.com|linkedin/.test(k)), 'LinkedIn active site is visible');
  assert.ok(keys.some((k) => /indeed\.com|indeed/.test(k)), 'Indeed active site is visible');
});

test('queueNext re-applies jobFit at dispatch — an excluded-company job queued earlier is purged, not dispatched', async () => {
  db.patchSettings({ autoApply: {
    enabled: true, runAnytime: true, windowStart: '', windowEnd: '',
    maxPerDay: 999, maxPerHour: 999, dailyCap: 0, minGapMinutes: 0, maxGapMinutes: 0,
    concurrency: 1, easyApplyOnly: false, keywords: ['developer'],
    excludeKeywords: [], excludeCompanies: ['qualis solutions'], excludeLocations: [],
  } });
  const job = db.upsertJob({ externalId: 'qn1', title: 'Developer', company: 'Qualis Solutions, LLC', source: 'linkedin', status: 'started', jobUrl: 'https://www.linkedin.com/jobs/view/qn1' }).job;
  db.queueAdd(job.id, { mode: 'auto' });
  await server.queueNext();
  const t = db.queueList({}).find((x) => x.jobId === job.id);
  assert.equal(t.state, 'skipped', 'excluded-company job is skipped at dispatch, not applied to');
  assert.match(t.lastError || '', /filtered: excluded company/i);
});

// Clean every in-flight (scheduled/running) task to 'skipped' so the per-site counter starts at 0
// (skipped does NOT count as a submit, so it won't trip the easy-apply cooldown).
function clearInFlight() {
  for (const st of ['scheduled', 'running']) for (const t of db.queueList({ state: st })) db.queuePatch(t.id, { state: 'skipped', lastError: 'test cleanup' });
}

test('queueNext PER-SITE CAP dispatches in PARALLEL — the boolean-guard serialization fix', async () => {
  clearInFlight();
  db.patchSettings({ autoApply: {
    enabled: true, runAnytime: true, windowStart: '', windowEnd: '',
    maxPerDay: 999, maxPerHour: 999, dailyCap: 0, minGapMinutes: 0, maxGapMinutes: 0,
    concurrency: 2, perSiteConcurrency: 2, parallelApplySafe: true, easyApplyOnly: false, seniorityMax: 'any',
    keywords: ['developer'], excludeKeywords: [], excludeCompanies: [], excludeLocations: [],
  } });
  for (let i = 0; i < 3; i++) addTask({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/par' + i, state: 'queued' });
  const r1 = await server.queueNext();
  assert.ok(r1.task, 'first LinkedIn apply dispatched');
  // The OLD boolean activeSiteKeys guard returned {task:null, reason:'site-busy'} here — all
  // LinkedIn jobs share siteKey 'ats:linkedin'. The per-site COUNT cap (2) must now let a SECOND
  // dispatch through, which is the entire point: concurrency=3 finally engages.
  const r2 = await server.queueNext();
  assert.ok(r2.task, 'second LinkedIn apply dispatched IN PARALLEL (was serial-of-1 before)');
  assert.notEqual(r1.task.id, r2.task.id, 'two DISTINCT applies in flight at once');
  // Third hits the per-site cap → site-busy (anti-flood on one site is preserved, not removed).
  const r3 = await server.queueNext();
  assert.equal(r3.task, null, 'third is held — per-site cap of 2 reached');
  assert.equal(r3.reason, 'site-busy', 'the cap surfaces as site-busy');
});

test('queueNext perSiteConcurrency=1 still serializes a single site (different sites would parallelize)', async () => {
  clearInFlight();
  db.patchSettings({ autoApply: {
    enabled: true, runAnytime: true, windowStart: '', windowEnd: '',
    maxPerDay: 999, maxPerHour: 999, dailyCap: 0, minGapMinutes: 0, maxGapMinutes: 0,
    concurrency: 3, perSiteConcurrency: 1, parallelApplySafe: true, easyApplyOnly: false, seniorityMax: 'any',
    keywords: ['developer'], excludeKeywords: [], excludeCompanies: [], excludeLocations: [],
  } });
  for (let i = 0; i < 2; i++) addTask({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/ser' + i, state: 'queued' });
  const a = await server.queueNext();
  assert.ok(a.task, 'first dispatched');
  const b = await server.queueNext();
  assert.equal(b.task, null, 'second held at perSiteConcurrency=1');
  assert.equal(b.reason, 'site-busy', 'one LinkedIn apply at a time when per-site cap is 1');
});

test('SAFETY KILL-SWITCH: parallelApplySafe OFF forces SERIAL even at stored concurrency=3 (freeze fix)', async () => {
  clearInFlight();
  // Stored concurrency:3 + perSiteConcurrency:3, but parallelApplySafe is NOT set (default OFF).
  // The server MUST force the EFFECTIVE concurrency to 1 — the structural guarantee against the
  // multi-window foreground freeze: with the switch off, the per-site parallel dispatch path is
  // never entered, so >1 apply window can never be opened. minGap:0 so the serial gap clock
  // doesn't interfere with this single-dispatch check.
  db.patchSettings({ autoApply: {
    enabled: true, runAnytime: true, windowStart: '', windowEnd: '',
    maxPerDay: 999, maxPerHour: 999, dailyCap: 0, minGapMinutes: 0, maxGapMinutes: 0,
    concurrency: 3, perSiteConcurrency: 3, parallelApplySafe: false, easyApplyOnly: false, seniorityMax: 'any',
    keywords: ['developer'], excludeKeywords: [], excludeCompanies: [], excludeLocations: [],
  } });
  for (let i = 0; i < 3; i++) addTask({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/safe' + i, state: 'queued' });
  const r1 = await server.queueNext();
  // The decisive, pollution-proof assertion: stored 3 is reported back as effective 1, in EVERY
  // queueNext branch. (With the switch ON this is 3 — see the next test.) This guarantees the
  // per-site parallel dispatch path (gated on concurrency>1) is never entered.
  assert.equal(r1.concurrency, 1, 'kill-switch forces effective concurrency to 1 despite stored 3');
});

test('SAFETY KILL-SWITCH: parallelApplySafe ON restores the stored concurrency (3)', async () => {
  clearInFlight();
  db.patchSettings({ autoApply: {
    enabled: true, runAnytime: true, windowStart: '', windowEnd: '',
    maxPerDay: 999, maxPerHour: 999, dailyCap: 0, minGapMinutes: 0, maxGapMinutes: 0,
    concurrency: 3, perSiteConcurrency: 3, parallelApplySafe: true, easyApplyOnly: false, seniorityMax: 'any',
    keywords: ['developer'], excludeKeywords: [], excludeCompanies: [], excludeLocations: [],
  } });
  addTask({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/on0', state: 'queued' });
  const r = await server.queueNext();
  assert.equal(r.concurrency, 3, 'with the switch ON, the stored concurrency takes effect again');
});
