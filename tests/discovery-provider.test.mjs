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
const discovery = require(path.join(here, '..', 'app', 'src', 'discovery', 'index.js'));

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-disc-')); db.open(dir); });
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('JobSpy records normalize to the shared job contract without trusting Easy Apply', () => {
  const job = discovery.normalizeJobSpyRecord({
    site: 'linkedin', title: 'Software Engineer', company: 'Acme', location: 'Toronto, ON',
    job_url: 'https://www.linkedin.com/jobs/view/123?trk=x', is_remote: true, easy_apply: true,
  }, 'linkedin');
  assert.equal(job.source, 'linkedin');
  assert.equal(job.applyCapability, 'unknown');
  assert.equal(job.remote, true);
});

test('provider errors are typed for fallback policy', () => {
  assert.equal(discovery.classifyProviderError('HTTP 429 too many requests'), 'rate_limited');
  assert.equal(discovery.classifyProviderError('captcha blocked request'), 'blocked');
  assert.equal(discovery.classifyProviderError('No module named jobspy'), 'unavailable');
  assert.equal(discovery.classifyProviderError('selector parse failed'), 'parser_drift');
});

test('query planner rotates keyword and location profiles deterministically', () => {
  const settings = { autoApply: { keywords: ['developer', 'analyst'], locations: ['Toronto', 'Remote'] } };
  assert.deepEqual(discovery.planner(settings, 0), { keyword: 'developer', location: 'Toronto', nextIndex: 1 });
  assert.deepEqual(discovery.planner(settings, 3), { keyword: 'analyst', location: 'Remote', nextIndex: 0 });
});

test('FIX 5(a): selectBoards drops non-LinkedIn boards when easyApplyOnly is ON', () => {
  const all = ['linkedin', 'indeed', 'glassdoor', 'zip_recruiter', 'google'];
  // easyApplyOnly ON → only LinkedIn (the only board with a real Easy-Apply filter).
  assert.deepEqual(discovery.selectBoards(all, true), ['linkedin']);
  // easyApplyOnly OFF → behaviour unchanged (all boards kept, order preserved).
  assert.deepEqual(discovery.selectBoards(all, false), all);
  // ON but no LinkedIn configured → empty (caller treats this as "no easy-apply boards").
  assert.deepEqual(discovery.selectBoards(['indeed', 'glassdoor'], true), []);
  // Defensive: non-array / falsy input never throws.
  assert.deepEqual(discovery.selectBoards(null, true), []);
  assert.deepEqual(discovery.selectBoards(undefined, false), []);
});

test('discovery batches and browser fallback requests are durable', () => {
  const batch = db.discoveryBatchStart({ provider: 'jobspy', source: 'indeed', keyword: 'dev', location: 'Toronto' });
  db.discoveryBatchComplete(batch.id, { status: 'blocked', error: '403', found: 0 });
  db.discoveryFallbackQueue({ batchId: batch.id, source: 'indeed', keyword: 'dev', location: 'Toronto', reason: 'blocked' });
  const req = db.discoveryFallbackNext();
  assert.equal(req.source, 'indeed');
  db.discoveryFallbackComplete(req.id, { ok: true });
  assert.equal(db.discoveryHealth().pendingFallbacks, 0);
  assert.equal(db.discoveryBatchList({ limit: 1 })[0].status, 'blocked');
});

test('defaultRunner falls through a non-viable launcher (py -3 lacks jobspy) to the next candidate', async () => {
  // Simulate the multi-candidate launcher list by stubbing the per-candidate process.
  // The first launcher (py -3) runs but the interpreter has no jobspy module — it exits
  // non-zero with an ImportError (NOT enoent), which previously THREW and produced zero
  // jobs. The runner must keep going and let `python` succeed.
  const calls = [];
  const fakeRunProcess = async (candidate) => {
    calls.push(candidate.command + ' ' + candidate.args.join(' '));
    if (/\bpy\b/.test(candidate.command) && candidate.args[0] === '-3') {
      throw new Error("ModuleNotFoundError: No module named 'jobspy'");
    }
    return { ok: true, jobs: [{ site: 'linkedin', title: 'Dev', company: 'Acme', job_url: 'https://www.linkedin.com/jobs/view/9' }] };
  };
  const result = await discovery.runWithCandidates(
    [{ command: 'py', args: ['-3', 'jobspy_worker.py'] }, { command: 'python', args: ['jobspy_worker.py'] }],
    fakeRunProcess,
    {},
  );
  assert.equal(result.ok, true);
  assert.equal(result.jobs.length, 1);
  assert.deepEqual(calls, ['py -3 jobspy_worker.py', 'python jobspy_worker.py']);
});

test('defaultRunner surfaces a genuine provider failure (rate limit) instead of masking it', async () => {
  // A real provider error must NOT be swallowed as a launcher fall-through — it has to
  // reach the typed classifier so the browser fallback can be queued.
  const fakeRunProcess = async () => { throw new Error('HTTP 429 too many requests'); };
  await assert.rejects(
    discovery.runWithCandidates(
      [{ command: 'py', args: ['-3', 'w.py'] }, { command: 'python', args: ['w.py'] }],
      fakeRunProcess,
      {},
    ),
    /429/,
  );
});

test('primary success does not enqueue a browser fallback', async () => {
  const seen = [];
  const service = discovery.createDiscoveryService({
    runner: async () => ({ ok: true, jobs: [{ site: 'indeed', title: 'Dev', company: 'Acme', job_url: 'https://ca.indeed.com/viewjob?jk=1' }] }),
    ingestJobs: async (_source, jobs, meta) => { seen.push({ jobs, meta }); return { enqueued: 1, duplicates: 0, rejected: 0 }; },
  });
  const result = await service.searchBoard({ source: 'indeed', keyword: 'dev', location: 'Toronto', limit: 10 });
  assert.equal(result.status, 'ok');
  assert.equal(seen[0].meta.provider, 'jobspy');
  assert.equal(db.discoveryHealth().pendingFallbacks, 0);
});

test('typed provider failure queues one browser fallback, while a healthy empty result does not', async () => {
  const failing = discovery.createDiscoveryService({
    runner: async () => { throw new Error('HTTP 429 too many requests'); },
    ingestJobs: async () => { throw new Error('must not ingest a failed batch'); },
  });
  const failed = await failing.searchBoard({ source: 'linkedin', keyword: 'dev', location: 'Toronto', limit: 10 });
  assert.equal(failed.status, 'rate_limited');
  assert.equal(db.discoveryHealth().pendingFallbacks, 1);
  const fallback = db.discoveryFallbackNext();
  db.discoveryFallbackComplete(fallback.id, { ok: true });

  const empty = discovery.createDiscoveryService({
    runner: async () => ({ ok: true, jobs: [] }),
    ingestJobs: async () => ({ enqueued: 0, duplicates: 0, rejected: 0 }),
  });
  const result = await empty.searchBoard({ source: 'linkedin', keyword: 'dev', location: 'Toronto', limit: 10 });
  assert.equal(result.status, 'empty');
  assert.equal(db.discoveryHealth().pendingFallbacks, 0);
});
