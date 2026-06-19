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
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-policy-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

function addTask({ source = 'linkedin', url, state = 'queued', lastError = '', pendingQuestions = null }) {
  const job = db.upsertJob({ externalId: url, title: 'Developer ' + url, company: 'Acme', source, status: 'started', jobUrl: url }).job;
  const task = db.queueAdd(job.id, { mode: 'auto' });
  db.queuePatch(task.id, { state, lastError, pendingQuestions });
  return { job, task: db.queueList({}).find((t) => t.id === task.id) };
}

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

test('queueActiveSiteKeys reports scheduled/running site keys for worker spreading', () => {
  addTask({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/123', state: 'running' });
  addTask({ source: 'indeed', url: 'https://ca.indeed.com/viewjob?jk=abc', state: 'scheduled' });
  const keys = db.queueActiveSiteKeys().map((x) => x.siteKey);
  assert.ok(keys.some((k) => /linkedin\.com|linkedin/.test(k)), 'LinkedIn active site is visible');
  assert.ok(keys.some((k) => /indeed\.com|indeed/.test(k)), 'Indeed active site is visible');
});
