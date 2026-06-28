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

test('effectiveFreshTier: brand-new combo starts at the 72h floor (newest-first)', () => {
  // No stored tier yet (never scanned) → 72h regardless of lastNew.
  assert.equal(discovery.effectiveFreshTier(null, 0), discovery.FRESH_BASE_SEC);
  assert.equal(discovery.effectiveFreshTier('', 0), discovery.FRESH_BASE_SEC);
  assert.equal(discovery.effectiveFreshTier(undefined, Date.now()), discovery.FRESH_BASE_SEC);
});

test('effectiveFreshTier: a SATURATED combo (no NEW accept in >6h) jumps straight to the 30d window', () => {
  const now = 1_000_000_000_000;
  // stored at 7d but last new accept was 7h ago → saturated → widest (30d), not a slow climb.
  assert.equal(discovery.effectiveFreshTier(604800, now - 7 * 3600 * 1000, now), discovery.FRESH_WIDEST_SEC);
  // scanned before but NEVER produced a new accept (lastNew=0) → saturated → widest.
  assert.equal(discovery.effectiveFreshTier(259200, 0, now), discovery.FRESH_WIDEST_SEC);
});

test('effectiveFreshTier: a recently-productive combo keeps its climbed tier (climb preserved)', () => {
  const now = 1_000_000_000_000;
  // last new accept 1h ago → not saturated → use the stored tier as-is.
  assert.equal(discovery.effectiveFreshTier(604800, now - 1 * 3600 * 1000, now), 604800);
  assert.equal(discovery.effectiveFreshTier(259200, now - 60 * 1000, now), 259200);
});

test('selectBoards keeps LinkedIn + Indeed when easyApplyOnly is ON, drops pure aggregators', () => {
  const all = ['linkedin', 'indeed', 'glassdoor', 'zip_recruiter', 'google'];
  // easyApplyOnly ON → LinkedIn (Easy Apply) + Indeed (Indeed-Apply → smartapply); aggregators dropped.
  assert.deepEqual(discovery.selectBoards(all, true), ['linkedin', 'indeed']);
  // easyApplyOnly OFF → behaviour unchanged (all boards kept, order preserved).
  assert.deepEqual(discovery.selectBoards(all, false), all);
  // ON, Indeed configured → Indeed kept (no LinkedIn needed).
  assert.deepEqual(discovery.selectBoards(['indeed', 'glassdoor'], true), ['indeed']);
  // ON, only aggregators → empty (caller treats this as "no easy-apply boards").
  assert.deepEqual(discovery.selectBoards(['glassdoor', 'google'], true), []);
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

test('freshness ramp: a SATURATED combo widens 72h→7d→14d→30d, then resets when it finds new jobs', async () => {
  // The overnight starvation (3 applies / 7h): the jobspy path was pinned at a static 72h, so a
  // saturated combo (LinkedIn "frontend developer") returned only duplicates forever (accepted=0).
  // Now a dry scan widens the window one tier; a fresh scan resets it to the 72h floor.
  db.patchSettings({ autoApply: {
    enabled: true, easyApplyOnly: false, keywords: ['frontend developer'], boards: ['linkedin'],
    locations: ['toronto'], country: 'Canada',
    discovery: { enabled: true, intervalMinutes: 5, refillBelow: 9999, perRunLimit: 10 },
  } });
  db.kvSet('discoveryPlannerIndex', 0); db.kvSet('discoveryBoardIndex', 0);
  const TK = 'freshTier:linkedin|frontend developer|toronto';
  const LK = 'freshLastNew:linkedin|frontend developer|toronto';
  db.kvSet(TK, 259200);            // start at the 72h floor
  db.kvSet(LK, Date.now());        // RECENTLY productive → climb step-by-step (not the saturation jump)
  const hoursSeen = [];
  let dry = true;   // simulate a saturated combo: 0 new ingested
  const svc = discovery.createDiscoveryService({
    runner: async (args) => { hoursSeen.push(args.hours_old); return { ok: true, jobs: [{ site: 'linkedin', title: 'Dev', company: 'Acme', job_url: 'https://www.linkedin.com/jobs/view/' + hoursSeen.length }] }; },
    ingestJobs: async () => ({ enqueued: dry ? 0 : 1, duplicates: dry ? 1 : 0, rejected: 0 }),
  });
  const tick = () => svc.runTick({ force: true });   // force bypasses the interval throttle
  // While the combo was recently productive (freshLastNew < 6h), a dry scan climbs ONE tier per tick.
  await tick(); assert.equal(hoursSeen.at(-1), 72, 'starts at the 72h floor');
  await tick(); assert.equal(hoursSeen.at(-1), 168, 'dry → widens to 7d');
  await tick(); assert.equal(hoursSeen.at(-1), 336, 'dry → widens to 14d');
  await tick(); assert.equal(hoursSeen.at(-1), 720, 'dry → widens to 30d');
  await tick(); assert.equal(hoursSeen.at(-1), 720, 'capped at 30d');
  dry = false;                 // the combo now surfaces fresh jobs
  await tick();                // this scan ingests new → resets the tier to the floor + stamps freshLastNew
  await tick(); assert.equal(hoursSeen.at(-1), 72, 'resets to 72h after finding fresh jobs');
  // SATURATED (no NEW accept in > 6h): even sitting at the 72h floor, the combo jumps STRAIGHT to the
  // 30d window on its next visit — it no longer takes ~4 dry visits / ~16h to reach the aged inventory.
  dry = true;
  db.kvSet(TK, 259200);
  db.kvSet(LK, Date.now() - 7 * 3600 * 1000);
  await tick(); assert.equal(hoursSeen.at(-1), 720, 'saturated (>6h since a new accept) → jumps straight to 30d');
});

test('runTick self-throttles to the configured interval (anti subprocess-storm)', async () => {
  // The idle-watchdog pokes runTick every few seconds whenever the queue is drained; without a
  // time gate that spawns a JobSpy subprocess each time and pins the CPU (the live freeze: 791
  // discovery batches in 25 min). The gate must let the FIRST run through, throttle rapid repeats,
  // and let a forced/manual run bypass.
  db.patchSettings({ autoApply: {
    enabled: true, easyApplyOnly: false, keywords: ['developer'], boards: ['indeed'],
    locations: ['Toronto'], country: 'Canada',
    discovery: { enabled: true, intervalMinutes: 5, refillBelow: 3, perRunLimit: 10 },
  } });
  let runs = 0;
  const svc = discovery.createDiscoveryService({
    runner: async () => { runs++; return { ok: true, jobs: [] }; },
    ingestJobs: async () => ({ enqueued: 0, duplicates: 0, rejected: 0 }),
  });
  const first = await svc.runTick();
  assert.equal(first.ok, true, 'first tick runs');
  const second = await svc.runTick();
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'throttled', 'a second tick within the interval is throttled');
  const forced = await svc.runTick({ force: true });
  assert.equal(forced.ok, true, 'a forced/manual run bypasses the throttle');
  assert.ok(runs >= 2, 'only the non-throttled runs scraped');
});
