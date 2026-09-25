// "WHAT DID THE AI DO FOR THIS APPLICATION?" — a question that could not be asked.
//
// ai_log recorded every model call (provider, model, kind, ms, ok) and nothing about which
// application it served. So the totals were readable and the individual story was not: you could
// see that 1,784 calls happened and 100% succeeded, but not which questions were answered for the
// job you are looking at, nor which model answered them, nor which ones failed.
//
// The data was always there. The join column was not. Same shape as the ai_runs.job_id gap.
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
const prompts = require(path.join(here, '..', 'app', 'src', 'ai', 'prompts.js'));

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-ailog-'));
  db.open(dir);
  try { return fn(); } finally {
    try { db.close(); } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

test('a call logged against a job is readable back for that job', () => {
  withDb(() => {
    const { job } = db.upsertJob({ title: 'Developer', company: 'Acme', source: 'indeed', jobUrl: 'https://example.com/1' });
    db.aiLog({ jobId: job.id, provider: 'claude-cli', model: 'haiku', kind: 'answer-question', ms: 900, ok: true, promptChars: 400, responseChars: 20 });
    db.aiLog({ jobId: job.id, provider: 'codex', model: 'cli-default', kind: 'answer-question', ms: 300, ok: false, error: 'quota' });

    const rows = db.aiLogForJob(job.id);
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((r) => r.ok).length, 1, 'a failed call must be visible, not swallowed');
    assert.ok(rows.some((r) => r.model === 'haiku'), 'the model is recorded, so tiering is auditable per call');
  });
});

test('calls for OTHER jobs never leak into this one', () => {
  withDb(() => {
    const a = db.upsertJob({ title: 'A', company: 'A Co', source: 'indeed', jobUrl: 'https://example.com/a' }).job;
    const b = db.upsertJob({ title: 'B', company: 'B Co', source: 'indeed', jobUrl: 'https://example.com/b' }).job;
    db.aiLog({ jobId: a.id, provider: 'claude-cli', kind: 'answer-question', ms: 1, ok: true });
    db.aiLog({ jobId: b.id, provider: 'claude-cli', kind: 'answer-question', ms: 1, ok: true });
    db.aiLog({ jobId: b.id, provider: 'claude-cli', kind: 'cover-letter', ms: 1, ok: true });

    assert.equal(db.aiLogForJob(a.id).length, 1);
    assert.equal(db.aiLogForJob(b.id).length, 2);
  });
});

test('a call with no job is still logged, and belongs to no job', () => {
  withDb(() => {
    // Email triage and sandbox runs legitimately have no application behind them. They must not
    // vanish from ai_log, and must not attach themselves to something.
    db.aiLog({ provider: 'claude-cli', kind: 'classify-email', ms: 500, ok: true });
    assert.equal(db.aiLogForJob(null).length, 0);
    assert.equal(db.aiLogForJob('job_nonexistent').length, 0);
    assert.equal(db.aiLogList(50).length, 1, 'it is still in the global log');
  });
});

test('newest first, so the last thing that happened is the first thing read', () => {
  withDb(() => {
    const { job } = db.upsertJob({ title: 'C', company: 'C Co', source: 'indeed', jobUrl: 'https://example.com/c' });
    for (const kind of ['fit-score', 'tailor-resume', 'answer-question']) {
      db.aiLog({ jobId: job.id, provider: 'claude-cli', kind, ms: 1, ok: true });
    }
    const rows = db.aiLogForJob(job.id);
    assert.equal(rows.length, 3);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(String(rows[i - 1].ts) >= String(rows[i].ts), 'must be descending by time');
    }
  });
});

// ---------------------------------------------------------------------------
// the plumbing that makes it happen automatically
// ---------------------------------------------------------------------------
test('every prompt builder that receives a job emits its id', () => {
  // If a builder forgets, its calls silently become unattributable and the per-application view
  // quietly loses a whole category rather than failing loudly.
  const job = { id: 'job_42', title: 'Developer', company: 'Acme', description: 'work', jobUrl: 'https://x' };
  const profile = { fullName: 'Pierre', headline: 'dev', location: 'Toronto' };
  const built = [
    prompts.fitScore({ job, profile, resumeText: 'r' }),
    prompts.coverLetter({ job, profile, resumeText: 'r', tone: 'plain' }),
    prompts.tailorResume({ job, resumeText: 'r', profile }),
    prompts.answerQuestion({ question: 'Years of React?', fieldType: 'text', options: null, job, profile, qaHistory: [], resumeText: 'r' }),
    prompts.summarizeJob({ job }),
  ];
  for (const b of built) {
    assert.equal(b.jobId, 'job_42', `${b.kind} did not carry the job id`);
  }
});

test('the provider accepts jobId and hands it to the log', () => {
  // Asserted against the source: run() destructures it, and every aiLog call site passes it. A
  // call site that forgot would log an unattributed row and nothing would complain.
  const src = fs.readFileSync(path.join(here, '..', 'app', 'src', 'ai', 'provider.js'), 'utf8');
  assert.match(src, /jobId = null/, 'run() must accept jobId');
  const calls = src.match(/db\.aiLog\(\{[^}]*/g) || [];
  assert.ok(calls.length >= 2, 'expected several log call sites');
  for (const c of calls) assert.match(c, /jobId/, `an aiLog call site drops the job link: ${c.slice(0, 60)}`);
});
