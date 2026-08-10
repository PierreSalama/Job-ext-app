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

// The platform safety governor ships with every platform UNOWNED (role 'none') so a fresh install
// never starts scraping LinkedIn on its own — see app/src/safety.js and the 2026-08-10 account
// restriction. These tests exercise discovery/dispatch MECHANICS, not the budget, so give this
// temp node ownership and headroom; safety-governor.test.mjs is what pins the budget behaviour.
function grantSafetyHeadroom() {
  const platforms = {};
  for (const p of ['linkedin', 'indeed', 'glassdoor', 'google', 'zip_recruiter']) {
    platforms[p] = {
      role: 'primary',
      searchesPerDay: 100000, searchesPerHour: 100000, minSearchGapMinutes: 0,
      appliesPerDay: 100000, appliesPerHour: 100000, minApplyGapMinutes: 0,
      quietStart: '00:00', quietEnd: '00:00',
    };
  }
  db.patchSettings({ autoApply: { safety: { enabled: true, platforms } } });
}

test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-disc-')); db.open(dir); grantSafetyHeadroom(); });
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

test('easyApplyOnly: Indeed discovery asks JobSpy for easy_apply=true (applyable-only, no external bounces)', async () => {
  db.patchSettings({ autoApply: {
    enabled: true, easyApplyOnly: true, keywords: ['developer'], boards: ['indeed'],
    locations: ['Toronto'], country: 'Canada',
    discovery: { enabled: true, intervalMinutes: 5, refillBelow: 9999, perRunLimit: 10 },
  } });
  db.kvSet('discoveryPlannerIndex', 0); db.kvSet('discoveryBoardIndex', 0);
  let captured = null;
  const svc = discovery.createDiscoveryService({
    runner: async (args) => { captured = args; return { ok: true, jobs: [] }; },
    ingestJobs: async () => ({ enqueued: 0, duplicates: 0, rejected: 0 }),
  });
  await svc.runTick({ force: true });
  assert.equal(captured?.source, 'indeed');
  assert.equal(captured?.easy_apply, true, 'Indeed under easyApplyOnly requests only board-hosted jobs');
});

test('source-aware refill gate: a queue full of ATS jobs does NOT starve jobspy/LinkedIn discovery', async () => {
  for (const t of db.queueList({})) db.queueDelete(t.id);   // isolate the queue for this test
  db.patchSettings({ autoApply: {
    enabled: true, easyApplyOnly: true, keywords: ['developer'], boards: ['linkedin'],
    locations: ['Toronto'], country: 'Canada',
    discovery: { enabled: true, intervalMinutes: 5, refillBelow: 3, perRunLimit: 10 },
  } });
  db.kvSet('discoveryPlannerIndex', 0); db.kvSet('discoveryBoardIndex', 0);
  // 5 direct-ATS (greenhouse) queued + 1 LinkedIn. Total (6) >= refillBelow(3) would trip the OLD
  // global gate; NON-ATS (1) < 3 must NOT — otherwise ATS supply starves LinkedIn discovery.
  for (let i = 0; i < 5; i++) {
    const up = db.upsertJob({ source: 'greenhouse', title: `GH ${i}`, company: `co${i}`, jobUrl: `https://boards.greenhouse.io/co${i}/jobs/${i}`, status: 'started' });
    db.queueAdd(up.job.id, { mode: 'auto' });
  }
  const lj = db.upsertJob({ source: 'linkedin', title: 'LI dev', company: 'lico', jobUrl: 'https://www.linkedin.com/jobs/view/990001', status: 'started' });
  db.queueAdd(lj.job.id, { mode: 'auto' });

  let ran = false;
  const svc = discovery.createDiscoveryService({
    runner: async () => { ran = true; return { ok: true, jobs: [] }; },
    ingestJobs: async () => ({ enqueued: 0, duplicates: 0, rejected: 0 }),
  });
  const res = await svc.runTick();   // force:false exercises the gate (fresh svc passes the interval throttle)
  assert.notEqual(res.reason, 'queue-full', 'an ATS-only backlog must NOT block jobspy discovery');
  assert.equal(ran, true, 'jobspy discovery ran despite 5 queued ATS jobs (only 1 non-ATS < refillBelow)');
});

test('source-aware refill gate: enough NON-ATS queued still gates jobspy (no needless scraping)', async () => {
  for (const t of db.queueList({})) db.queueDelete(t.id);
  db.patchSettings({ autoApply: {
    enabled: true, easyApplyOnly: true, keywords: ['developer'], boards: ['linkedin'],
    locations: ['Toronto'], country: 'Canada',
    discovery: { enabled: true, intervalMinutes: 5, refillBelow: 3, perRunLimit: 10 },
  } });
  for (let i = 0; i < 4; i++) {
    const up = db.upsertJob({ source: 'linkedin', title: `LI ${i}`, company: `lico${i}`, jobUrl: `https://www.linkedin.com/jobs/view/9910${i}`, status: 'started' });
    db.queueAdd(up.job.id, { mode: 'auto' });
  }
  let ran = false;
  const svc = discovery.createDiscoveryService({
    runner: async () => { ran = true; return { ok: true, jobs: [] }; },
    ingestJobs: async () => ({ enqueued: 0, duplicates: 0, rejected: 0 }),
  });
  const res = await svc.runTick();
  assert.equal(res.reason, 'queue-full', '4 non-ATS queued >= refillBelow(3) still gates jobspy');
  assert.equal(ran, false);
  for (const t of db.queueList({})) db.queueDelete(t.id);   // leave the shared queue empty for later tests
});

test('easyApplyOnly OFF: Indeed discovery does NOT set easy_apply (keeps the freshness window)', async () => {
  db.patchSettings({ autoApply: {
    enabled: true, easyApplyOnly: false, keywords: ['developer'], boards: ['indeed'],
    locations: ['Toronto'], country: 'Canada',
    discovery: { enabled: true, intervalMinutes: 5, refillBelow: 9999, perRunLimit: 10 },
  } });
  db.kvSet('discoveryPlannerIndex', 0); db.kvSet('discoveryBoardIndex', 0);
  let captured = null;
  const svc = discovery.createDiscoveryService({
    runner: async (args) => { captured = args; return { ok: true, jobs: [] }; },
    ingestJobs: async () => ({ enqueued: 0, duplicates: 0, rejected: 0 }),
  });
  await svc.runTick({ force: true });
  assert.equal(captured?.easy_apply, false, 'off → falls back to the freshness window');
});

test('combosPerTick: one tick sweeps a BATCH of distinct combos (widen breadth)', async () => {
  db.patchSettings({ autoApply: {
    enabled: true, easyApplyOnly: false, keywords: ['a dev', 'b dev'], boards: ['indeed'],
    locations: ['toronto', 'ottawa'], country: 'Canada',
    discovery: { enabled: true, intervalMinutes: 5, refillBelow: 9999, perRunLimit: 10, combosPerTick: 3 },
  } });
  db.kvSet('discoveryPlannerIndex', 0); db.kvSet('discoveryBoardIndex', 0);
  const seen = [];
  const svc = discovery.createDiscoveryService({
    runner: async (args) => { seen.push(`${args.keyword}|${args.location}`); return { ok: true, jobs: [] }; },
    ingestJobs: async () => ({ enqueued: 0, duplicates: 0, rejected: 0 }),
  });
  const res = await svc.runTick({ force: true });
  assert.equal(res.combosScanned, 3, 'scanned 3 combos in one tick');
  assert.equal(seen.length, 3, '3 runner calls (1 board × 3 combos)');
  assert.equal(new Set(seen).size, 3, 'all 3 combos distinct');
  assert.equal(Number(db.kvGet('discoveryPlannerIndex')), 3, 'planner advanced by the batch size');
});

test('combosPerTick: stops at a full cycle instead of rescanning the same combos', async () => {
  db.patchSettings({ autoApply: {
    enabled: true, easyApplyOnly: false, keywords: ['solo dev'], boards: ['indeed'],
    locations: ['toronto', 'ottawa'], country: 'Canada',
    discovery: { enabled: true, intervalMinutes: 5, refillBelow: 9999, perRunLimit: 10, combosPerTick: 5 },
  } });
  db.kvSet('discoveryPlannerIndex', 0); db.kvSet('discoveryBoardIndex', 0);
  const seen = [];
  const svc = discovery.createDiscoveryService({
    runner: async (args) => { seen.push(`${args.keyword}|${args.location}`); return { ok: true, jobs: [] }; },
    ingestJobs: async () => ({ enqueued: 0, duplicates: 0, rejected: 0 }),
  });
  const res = await svc.runTick({ force: true });
  assert.equal(res.combosScanned, 2, 'only 2 distinct combos exist → no rescans');
  assert.equal(new Set(seen).size, 2, 'each combo scanned at most once');
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

test('isComboSaturated: true only when EVERY board is at the widest tier and stale', () => {
  const now = 1_000_000_000_000;
  const wide = { storedSec: discovery.FRESH_WIDEST_SEC, lastNewAtMs: now - 7 * 3600 * 1000 };   // saturated
  const fresh = { storedSec: discovery.FRESH_BASE_SEC, lastNewAtMs: now - 60 * 1000 };            // productive
  assert.equal(discovery.isComboSaturated(() => wide, ['linkedin', 'indeed'], 'dev', 'toronto', now), true);
  // One board still productive → combo NOT saturated (any fresh board is reason enough to visit).
  assert.equal(discovery.isComboSaturated((source) => (source === 'indeed' ? fresh : wide), ['linkedin', 'indeed'], 'dev', 'toronto', now), false);
  // No boards → never saturated (defensive; caller always passes selectedBoards).
  assert.equal(discovery.isComboSaturated(() => wide, [], 'dev', 'toronto', now), false);
});

test('shouldSkipSaturatedCombo: never skips a non-saturated combo; skips a saturated one until its 1-in-N turn', () => {
  assert.equal(discovery.shouldSkipSaturatedCombo(false, 0), false);
  assert.equal(discovery.shouldSkipSaturatedCombo(false, 99), false);
  const seen = [];
  for (let counter = 0; counter < discovery.SKIP_EVERY_N + 2; counter++) {
    seen.push(discovery.shouldSkipSaturatedCombo(true, counter));
  }
  // Skipped for the first SKIP_EVERY_N-1 counters, then let through on the Nth (counter+1 === N).
  assert.deepEqual(seen.slice(0, discovery.SKIP_EVERY_N - 1), Array(discovery.SKIP_EVERY_N - 1).fill(true));
  assert.equal(seen[discovery.SKIP_EVERY_N - 1], false, 'lets through on the 1-in-N turn');
});

test('saturation de-prioritization: a fully-saturated (30d + stale) combo is visited far less often than a fresh one over many ticks, with unchanged total request volume', async () => {
  // Two combos, both on the single selected board (indeed). "stale dev|toronto" is seeded already
  // saturated (widest tier, no new accept in >6h) on indeed; "fresh dev|ottawa" is seeded productive
  // (base tier, accepted recently). Run enough ticks to sweep a few full cycles of the 2-combo space
  // and assert the saturated combo is scanned roughly 1-in-N times while the fresh one is scanned
  // essentially every cycle — pure reordering, not a volume cut (every combo is still visited).
  db.patchSettings({ autoApply: {
    enabled: true, easyApplyOnly: false, keywords: ['stale dev', 'fresh dev'], boards: ['indeed'],
    locations: ['toronto', 'ottawa'], country: 'Canada',
    discovery: { enabled: true, intervalMinutes: 5, refillBelow: 9999, perRunLimit: 10, combosPerTick: 1 },
  } });
  db.kvSet('discoveryPlannerIndex', 0);
  db.kvSet('discoveryBoardIndex', 0);
  // planner() pairs keywords[i] with locations[i] in this settings shape (2x2 grid, but we only
  // seed the diagonal combos this test cares about): stale dev|toronto and fresh dev|ottawa.
  db.kvSet('freshTier:indeed|stale dev|toronto', discovery.FRESH_WIDEST_SEC);
  db.kvSet('freshLastNew:indeed|stale dev|toronto', Date.now() - 7 * 3600 * 1000);   // >6h stale → saturated
  db.kvSet('freshTier:indeed|fresh dev|ottawa', discovery.FRESH_BASE_SEC);
  db.kvSet('freshLastNew:indeed|fresh dev|ottawa', Date.now());                        // recent → productive
  // Also seed the off-diagonal combos as saturated so they don't dilute the count (planner rotates
  // over the full keyword×location cross product: stale dev|ottawa and fresh dev|toronto too).
  db.kvSet('freshTier:indeed|stale dev|ottawa', discovery.FRESH_WIDEST_SEC);
  db.kvSet('freshLastNew:indeed|stale dev|ottawa', Date.now() - 7 * 3600 * 1000);
  db.kvSet('freshTier:indeed|fresh dev|toronto', discovery.FRESH_WIDEST_SEC);
  db.kvSet('freshLastNew:indeed|fresh dev|toronto', Date.now() - 7 * 3600 * 1000);
  const scans = { 'stale dev|toronto': 0, 'fresh dev|ottawa': 0 };
  const svc = discovery.createDiscoveryService({
    runner: async (args) => {
      const key = `${args.keyword}|${args.location}`;
      if (key in scans) scans[key]++;
      return { ok: true, jobs: [] };
    },
    ingestJobs: async () => ({ enqueued: 0, duplicates: 0, rejected: 0 }),
  });
  const N_TICKS = discovery.SKIP_EVERY_N * 4;   // several full 1-in-N cycles
  for (let i = 0; i < N_TICKS; i++) {
    const res = await svc.runTick({ force: true });
    assert.equal(res.ok, true, `tick ${i} should find a combo to scan`);
  }
  // The saturated combo must be visited (forward progress guaranteed), but strictly less often
  // than the fresh one, which is offered on every cycle it's the planner's turn.
  assert.ok(scans['stale dev|toronto'] >= 1, 'saturated combo is still eventually visited (not starved)');
  assert.ok(scans['fresh dev|ottawa'] > scans['stale dev|toronto'],
    `fresh combo (${scans['fresh dev|ottawa']}) should be scanned more often than the saturated one (${scans['stale dev|toronto']})`);
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
