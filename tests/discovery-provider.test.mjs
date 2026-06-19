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
