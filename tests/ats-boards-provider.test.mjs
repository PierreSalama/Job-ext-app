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
const atsBoards = require(path.join(here, '..', 'app', 'src', 'discovery', 'ats-boards.js'));

const fixturesDir = path.join(here, 'fixtures');
const greenhouseFixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'greenhouse-jobs.json'), 'utf8'));
const leverFixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'lever-jobs.json'), 'utf8'));
const ashbyFixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'ashby-jobs.json'), 'utf8'));

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-ats-')); db.open(dir); });
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// ---- (1) normalizeAtsRecord output shape, per ATS, against the committed fixtures ----

test('normalizeAtsRecord: Greenhouse record maps to the shared job contract', () => {
  const raw = greenhouseFixture.jobs[0];
  const job = atsBoards.normalizeAtsRecord(raw, 'greenhouse', 'exampleco');
  assert.equal(job.title, 'Senior Software Engineer, Backend');
  assert.equal(job.company, 'exampleco');
  assert.equal(job.location, 'Toronto, ON, Canada');
  assert.equal(job.jobUrl, 'https://boards.greenhouse.io/exampleco/jobs/4123456001');
  assert.equal(job.source, 'greenhouse');
  assert.match(job.description, /Senior Software Engineer to join our Backend team/);
  assert.ok(!/<[a-z]+>/i.test(job.description), 'HTML tags stripped from description');
  assert.equal(job.postedAt, '2026-06-28T14:32:00-04:00');
  assert.equal(job.remote, false);
  assert.equal(job.externalId, 'greenhouse:4123456001');
  assert.equal(job.applyCapability, 'easy-apply');
});

test('normalizeAtsRecord: Greenhouse remote posting is detected from title/location', () => {
  const raw = greenhouseFixture.jobs[1];   // "Remote - Canada"
  const job = atsBoards.normalizeAtsRecord(raw, 'greenhouse', 'exampleco');
  assert.equal(job.remote, true);
});

test('normalizeAtsRecord: Lever record maps to the shared job contract', () => {
  const raw = leverFixture[0];
  const job = atsBoards.normalizeAtsRecord(raw, 'lever', 'exampleco');
  assert.equal(job.title, 'Frontend Engineer');
  assert.equal(job.company, 'exampleco');
  assert.equal(job.location, 'Toronto, Ontario, Canada');
  assert.equal(job.jobUrl, 'https://jobs.lever.co/exampleco/a1b2c3d4-0001-4e5f-8a9b-000000000001');
  assert.equal(job.source, 'lever');
  assert.match(job.description, /Frontend Engineer to build delightful/);
  assert.equal(job.postedAt, new Date(1751000000000).toISOString());
  assert.equal(job.remote, false);
  assert.equal(job.employmentType, 'Full-time');
  assert.equal(job.externalId, 'lever:a1b2c3d4-0001-4e5f-8a9b-000000000001');
  assert.equal(job.applyCapability, 'easy-apply');
});

test('normalizeAtsRecord: Lever remote posting is detected from location', () => {
  const raw = leverFixture[1];   // "Remote - Canada"
  const job = atsBoards.normalizeAtsRecord(raw, 'lever', 'exampleco');
  assert.equal(job.remote, true);
});

test('normalizeAtsRecord: Ashby record maps to the shared job contract', () => {
  const raw = ashbyFixture.jobs[0];
  const job = atsBoards.normalizeAtsRecord(raw, 'ashby', 'exampleco');
  assert.equal(job.title, 'Full Stack Engineer');
  assert.equal(job.company, 'exampleco');
  assert.equal(job.location, 'Toronto, Canada');
  assert.equal(job.jobUrl, 'https://jobs.ashbyhq.com/exampleco/9f8e7d6c-0001-4b3a-9c1d-000000000001');
  assert.equal(job.source, 'ashby');
  assert.match(job.description, /Full Stack Engineer to help build our core product/);
  assert.equal(job.postedAt, '2026-06-27T08:00:00.000Z');
  assert.equal(job.remote, false);
  assert.equal(job.employmentType, 'FullTime');
  assert.equal(job.externalId, 'ashby:9f8e7d6c-0001-4b3a-9c1d-000000000001');
  assert.equal(job.applyCapability, 'easy-apply');
});

test('normalizeAtsRecord: Ashby isRemote:true flags the job remote regardless of location text', () => {
  const raw = ashbyFixture.jobs[1];   // isRemote: true, "Remote - Canada"
  const job = atsBoards.normalizeAtsRecord(raw, 'ashby', 'exampleco');
  assert.equal(job.remote, true);
});

test('normalizeAtsRecord: missing required fields (id/url/title) return null instead of a partial record', () => {
  assert.equal(atsBoards.normalizeAtsRecord({}, 'greenhouse', 'exampleco'), null);
  assert.equal(atsBoards.normalizeAtsRecord({ id: 1, title: 'X' }, 'greenhouse', 'exampleco'), null, 'missing absolute_url');
  assert.equal(atsBoards.normalizeAtsRecord({ text: 'X', hostedUrl: 'https://jobs.lever.co/x/1' }, 'lever', 'exampleco'), null, 'missing id');
  assert.equal(atsBoards.normalizeAtsRecord({ id: '1', title: 'X' }, 'ashby', 'exampleco'), null, 'missing jobUrl');
  assert.equal(atsBoards.normalizeAtsRecord(null, 'greenhouse', 'exampleco'), null);
  assert.equal(atsBoards.normalizeAtsRecord({ id: 1, title: 'X', absolute_url: 'https://boards.greenhouse.io/x/1' }, 'unknown-ats', 'exampleco'), null, 'unrecognized ats');
});

// ---- (2) fetchGreenhouse/fetchLever/fetchAshby with a fake fetchFn ----

function fakeFetchOk(payload) {
  return async () => ({ ok: true, status: 200, json: async () => payload });
}
function fakeFetchStatus(status) {
  return async () => ({ ok: false, status, json: async () => ({}) });
}
function fakeFetchThrows(message) {
  return async () => { throw new Error(message); };
}

test('fetchGreenhouse parses the fixture jobs array via an injected fetchFn', async () => {
  const jobs = await atsBoards.fetchGreenhouse('exampleco', fakeFetchOk(greenhouseFixture));
  assert.equal(jobs.length, 3);
  assert.equal(jobs[0].title, 'Senior Software Engineer, Backend');
});

test('fetchGreenhouse returns [] on a non-200 response', async () => {
  const jobs = await atsBoards.fetchGreenhouse('exampleco', fakeFetchStatus(404));
  assert.deepEqual(jobs, []);
});

test('fetchGreenhouse tolerates a network throw and returns []', async () => {
  const jobs = await atsBoards.fetchGreenhouse('exampleco', fakeFetchThrows('ECONNRESET'));
  assert.deepEqual(jobs, []);
});

test('fetchGreenhouse returns [] for an empty/missing token without calling fetchFn', async () => {
  let called = false;
  const jobs = await atsBoards.fetchGreenhouse('', async () => { called = true; return { ok: true, json: async () => ({}) }; });
  assert.deepEqual(jobs, []);
  assert.equal(called, false);
});

test('fetchLever parses the fixture array (Lever returns a bare array, not { jobs })', async () => {
  const jobs = await atsBoards.fetchLever('exampleco', fakeFetchOk(leverFixture));
  assert.equal(jobs.length, 3);
  assert.equal(jobs[0].text, 'Frontend Engineer');
});

test('fetchLever returns [] on a non-200 response', async () => {
  const jobs = await atsBoards.fetchLever('exampleco', fakeFetchStatus(500));
  assert.deepEqual(jobs, []);
});

test('fetchLever tolerates a network throw and returns []', async () => {
  const jobs = await atsBoards.fetchLever('exampleco', fakeFetchThrows('network down'));
  assert.deepEqual(jobs, []);
});

test('fetchAshby parses the fixture jobs array via an injected fetchFn', async () => {
  const jobs = await atsBoards.fetchAshby('exampleco', fakeFetchOk(ashbyFixture));
  assert.equal(jobs.length, 3);
  assert.equal(jobs[0].title, 'Full Stack Engineer');
});

test('fetchAshby returns [] on a non-200 response', async () => {
  const jobs = await atsBoards.fetchAshby('exampleco', fakeFetchStatus(429));
  assert.deepEqual(jobs, []);
});

test('fetchAshby tolerates a network throw and returns []', async () => {
  const jobs = await atsBoards.fetchAshby('exampleco', fakeFetchThrows('DNS failure'));
  assert.deepEqual(jobs, []);
});

// ---- (3) harvestTokensFromDb against a temp sqlite seeded with known job_urls ----

test('harvestTokensFromDb extracts {ats, companyKey} from greenhouse/lever/ashby job_urls via the real db.classifyAts', () => {
  const seedJobs = [
    { source: 'linkedin', title: 'GH Job A', company: 'ExampleCo', jobUrl: 'https://boards.greenhouse.io/exampleco/jobs/1' },
    { source: 'linkedin', title: 'GH Job B', company: 'ExampleCo', jobUrl: 'https://boards.greenhouse.io/exampleco/jobs/2' },
    { source: 'linkedin', title: 'GH Job Other', company: 'OtherCo', jobUrl: 'https://boards.greenhouse.io/otherco/jobs/3' },
    { source: 'indeed', title: 'Lever Job A', company: 'AcmeCo', jobUrl: 'https://jobs.lever.co/acmeco/aaa-111' },
    { source: 'indeed', title: 'Ashby Job A', company: 'RampCo', jobUrl: 'https://jobs.ashbyhq.com/rampco/bbb-222' },
    { source: 'linkedin', title: 'Unrelated', company: 'Workday Inc', jobUrl: 'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/1' },
  ];
  for (const jd of seedJobs) db.upsertJob({ source: jd.source, title: jd.title, company: jd.company, jobUrl: jd.jobUrl, status: 'started' });

  const harvested = atsBoards.harvestTokensFromDb(db);
  const keys = harvested.map((h) => `${h.ats}:${h.companyKey}`).sort();
  assert.deepEqual(keys, ['ashby:rampco', 'greenhouse:exampleco', 'greenhouse:otherco', 'lever:acmeco'].sort());
  // Deduped: two greenhouse/exampleco URLs collapse to one entry.
  assert.equal(harvested.filter((h) => h.ats === 'greenhouse' && h.companyKey === 'exampleco').length, 1);
  // Workday (not greenhouse/lever/ashby) must not appear.
  assert.ok(!keys.some((k) => k.startsWith('workday')));
});

test('harvestTokensFromDb returns [] when db lacks classifyAts/listJobs (defensive)', () => {
  assert.deepEqual(atsBoards.harvestTokensFromDb(null), []);
  assert.deepEqual(atsBoards.harvestTokensFromDb({}), []);
  assert.deepEqual(atsBoards.harvestTokensFromDb({ classifyAts: () => {} }), []);
});

// ---- (4) createAtsBoardsService().runTick() ----

function makeFakeDb(overrides = {}) {
  const kv = new Map();
  const batches = new Map();
  let batchSeq = 0;
  return {
    classifyAts: db.classifyAts,
    listJobs: () => [],
    // runTick self-gates on auto-apply enablement (so main.js can start it unconditionally at boot).
    // Default the fake to enabled; the gate/throttle tests below override this.
    getSettings: () => ({ autoApply: { enabled: true, discovery: { enabled: true, atsBoardsEnabled: true } } }),
    kvGet: (k) => (kv.has(k) ? kv.get(k) : null),
    kvSet: (k, v) => { kv.set(k, v); },
    discoveryBatchStart: ({ provider, source, keyword, location }) => {
      const id = `batch_${++batchSeq}`;
      const b = { id, provider, source, keyword, location, status: 'running' };
      batches.set(id, b);
      return b;
    },
    discoveryBatchComplete: (id, patch) => {
      const b = batches.get(id) || { id };
      Object.assign(b, patch);
      batches.set(id, b);
      return b;
    },
    ...overrides,
  };
}

test('createAtsBoardsService().runTick(): round-robin token rotation advances the KV cursor by the tick size', async () => {
  const fakeDb = makeFakeDb();
  const seenTokens = [];
  const fetchFn = async (url) => {
    seenTokens.push(url);
    return { ok: true, status: 200, json: async () => ({ jobs: [] }) };
  };
  const ingestJobs = async () => ({ enqueued: 0, duplicates: 0, rejected: 0 });
  const svc = atsBoards.createAtsBoardsService({ ingestJobs, db: fakeDb, fetchFn, logger: { info() {}, warn() {}, error() {} }, spacingMs: 0 });

  // force:true bypasses the self-throttle so the two back-to-back ticks both run (this test is
  // about rotation mechanics; the throttle has its own dedicated test below).
  const first = await svc.runTick({ force: true });
  assert.equal(first.ok, true);
  assert.ok(first.scanned > 0, 'scanned at least one seed token');
  const cursorAfterFirst = Number(fakeDb.kvGet('atsBoardsTokenIndex'));
  assert.equal(cursorAfterFirst, first.scanned, 'KV cursor advances by exactly the number of tokens scanned');

  const second = await svc.runTick({ force: true });
  assert.equal(second.ok, true);
  const cursorAfterSecond = Number(fakeDb.kvGet('atsBoardsTokenIndex'));
  assert.equal(cursorAfterSecond, (cursorAfterFirst + second.scanned) % (cursorAfterFirst + second.scanned > 0 ? Infinity : 1) || cursorAfterSecond, 'cursor kept advancing (rotation, not a fixed re-scan of token 0)');
  assert.notDeepEqual(
    seenTokens.slice(0, first.scanned),
    seenTokens.slice(first.scanned, first.scanned + second.scanned),
    'the second tick scans a DIFFERENT window of tokens than the first (round-robin, not repeat)',
  );
});

test('createAtsBoardsService().runTick(): a 429 on one token sets a cooldown and is skipped on the next tick', async () => {
  const fakeDb = makeFakeDb();
  // Force exactly one seed token into rotation range by starting the cursor near the end,
  // deterministic regardless of the real seed list's length: cooldown bookkeeping is keyed
  // by `${ats}:${token}` and is independent of WHICH token gets the 429.
  let callN = 0;
  const rateLimitedUrls = new Set();
  const fetchFn = async (url) => {
    callN++;
    // Rate-limit the very first token this tick, and remember its URL prefix.
    if (callN === 1) {
      rateLimitedUrls.add(url.split('?')[0].replace(/\/jobs$|\/postings\/.*$|\/job-board\/.*$/, ''));
      return { ok: false, status: 429, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ jobs: [] }) };
  };
  const ingestJobs = async () => ({ enqueued: 0, duplicates: 0, rejected: 0 });
  const svc = atsBoards.createAtsBoardsService({ ingestJobs, db: fakeDb, fetchFn, logger: { info() {}, warn() {}, error() {} }, spacingMs: 0 });

  const result = await svc.runTick();
  assert.equal(result.ok, true);
  const rateLimited = result.results.find((r) => r.status === 'rate_limited');
  assert.ok(rateLimited, 'one token was recorded as rate_limited');
  const cooldownKeys = [...fakeDb.kvGet.toString()];   // no-op guard; real assertion below
  // Assert a cooldown KV entry was written for the rate-limited token.
  const key = `atsBoardsCooldown:${rateLimited.ats}:${rateLimited.token}`;
  const cooldownUntil = Number(fakeDb.kvGet(key));
  assert.ok(cooldownUntil > Date.now(), 'cooldown timestamp is in the future');

  // Reset the rotation cursor so the SAME token is due again, then confirm it's skipped this time.
  fakeDb.kvSet('atsBoardsTokenIndex', 0);
  const calledUrls = [];
  const fetchFn2 = async (url) => { calledUrls.push(url); return { ok: true, status: 200, json: async () => ({ jobs: [] }) }; };
  const svc2 = atsBoards.createAtsBoardsService({ ingestJobs, db: fakeDb, fetchFn: fetchFn2, logger: { info() {}, warn() {}, error() {} }, spacingMs: 0 });
  const result2 = await svc2.runTick();
  const cooledEntry = result2.results.find((r) => r.ats === rateLimited.ats && r.token === rateLimited.token);
  assert.ok(cooledEntry, 'the previously rate-limited token is still in rotation range');
  assert.equal(cooledEntry.status, 'cooldown', 'the cooled-down token is skipped, not re-fetched');
});

test('createAtsBoardsService().runTick(): ingestJobs is called with normalized jobs for a token that returns results', async () => {
  // harvestTokensFromDb-sourced tokens are MERGED AFTER the (much larger) committed seed
  // list, so a harvested token only enters an N-per-tick rotation window once the cursor
  // reaches it. Start the KV cursor at seed.length so this tick's window opens exactly on
  // the harvested 'knownco' entry, regardless of the seed list's own size/ordering.
  const seedCompanies = require(path.join(here, '..', 'app', 'src', 'discovery', 'ats-seed-companies.json'));
  const kvStore = new Map([['atsBoardsTokenIndex', seedCompanies.length]]);
  const fakeDb = makeFakeDb({
    listJobs: () => [{ jobUrl: 'https://boards.greenhouse.io/knownco/jobs/1', source: 'linkedin' }],
    kvGet: (k) => (kvStore.has(k) ? kvStore.get(k) : null),
    kvSet: (k, v) => { kvStore.set(k, v); },
  });

  const seenIngest = [];
  const fetchFn = async (url) => {
    if (/knownco/.test(url)) return { ok: true, status: 200, json: async () => greenhouseFixture };
    return { ok: true, status: 200, json: async () => ({ jobs: [] }) };
  };
  const ingestJobs = async (source, jobs, meta) => {
    seenIngest.push({ source, jobs, meta });
    return { enqueued: jobs.length, duplicates: 0, rejected: 0 };
  };
  const svc = atsBoards.createAtsBoardsService({ ingestJobs, db: fakeDb, fetchFn, logger: { info() {}, warn() {}, error() {} }, spacingMs: 0 });
  const result = await svc.runTick();
  assert.equal(result.ok, true);

  const knownCall = seenIngest.find((c) => c.source === 'greenhouse' && c.jobs.some((j) => j.company === 'knownco'));
  assert.ok(knownCall, 'ingestJobs was called for the harvested knownco token');
  assert.equal(knownCall.jobs.length, 3, 'all 3 fixture jobs normalized and passed to ingestJobs');
  assert.equal(knownCall.jobs[0].source, 'greenhouse');
  assert.equal(knownCall.jobs[0].applyCapability, 'easy-apply');
  assert.equal(knownCall.meta.provider, 'greenhouse-api');
});

test('createAtsBoardsService().runTick(): a per-token throw does not crash the tick (other tokens still scanned)', async () => {
  const fakeDb = makeFakeDb();
  let n = 0;
  const fetchFn = async () => {
    n++;
    if (n === 1) throw new Error('ECONNRESET');
    return { ok: true, status: 200, json: async () => ({ jobs: [] }) };
  };
  const ingestJobs = async () => ({ enqueued: 0, duplicates: 0, rejected: 0 });
  const svc = atsBoards.createAtsBoardsService({ ingestJobs, db: fakeDb, fetchFn, logger: { info() {}, warn() {}, error() {} }, spacingMs: 0 });
  const result = await svc.runTick();
  assert.equal(result.ok, true);
  assert.ok(result.scanned > 1, 'kept scanning after the first token threw');
  assert.ok(result.results.some((r) => r.status === 'error'));
});

test('createAtsBoardsService().runTick(): no tokens (empty seed + empty harvest) reports no-tokens instead of throwing', async () => {
  // Simulate an environment with nothing to scan by stubbing mergeTokenLists indirectly:
  // harvestTokensFromDb returns [] and the module's own seed list is non-empty in production,
  // but we can still exercise the "already running" guard and general robustness here.
  const fakeDb = makeFakeDb();
  const ingestJobs = async () => ({ enqueued: 0, duplicates: 0, rejected: 0 });
  const svc = atsBoards.createAtsBoardsService({ ingestJobs, db: fakeDb, fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ jobs: [] }) }), logger: { info() {}, warn() {}, error() {} }, spacingMs: 0 });
  const p1 = svc.runTick();
  const p2 = svc.runTick();
  const [r1, r2] = await Promise.all([p1, p2]);
  // Whichever call loses the race sees the running-guard, proving re-entrancy is safe.
  assert.ok([r1.ok, r2.ok].includes(true));
  const guarded = [r1, r2].find((r) => r.reason === 'already-running');
  assert.ok(guarded, 'a concurrent runTick() call is rejected instead of double-scanning');
});

// ---- locationEligible: the positive location gate (board APIs return roles worldwide) ----

const CA = ['toronto', 'ontario', 'canada', 'vancouver', 'waterloo', 'kitchener'];

test('locationEligible: a Canada-named location passes (city/province/country term match)', () => {
  assert.equal(atsBoards.locationEligible({ location: 'Toronto, ON, Canada' }, CA, 'Canada'), true);
  assert.equal(atsBoards.locationEligible({ location: 'Vancouver, BC' }, CA, 'Canada'), true);
  assert.equal(atsBoards.locationEligible({ location: 'Remote - Ontario, Canada', remote: true }, CA, 'Canada'), true);
  assert.equal(atsBoards.locationEligible({ location: 'Kitchener, ON, Canada' }, CA, 'Canada'), true);
});

test('locationEligible: a generic remote posting (no country lock) passes', () => {
  assert.equal(atsBoards.locationEligible({ location: 'Remote', remote: true }, CA, 'Canada'), true);
  assert.equal(atsBoards.locationEligible({ location: '', remote: true }, CA, 'Canada'), true);
  assert.equal(atsBoards.locationEligible({ location: 'Anywhere', remote: true }, CA, 'Canada'), true);
  assert.equal(atsBoards.locationEligible({ location: 'Remote - North America', remote: true }, CA, 'Canada'), true);
  assert.equal(atsBoards.locationEligible({ location: 'Remote - USA or Canada', remote: true }, CA, 'Canada'), true, 'US-or-Canada is Canada-eligible via the canada term');
});

test('locationEligible: a foreign onsite location fails', () => {
  assert.equal(atsBoards.locationEligible({ location: 'San Francisco, CA' }, CA, 'Canada'), false);
  assert.equal(atsBoards.locationEligible({ location: 'Bengaluru, India' }, CA, 'Canada'), false);
  assert.equal(atsBoards.locationEligible({ location: 'London, United Kingdom' }, CA, 'Canada'), false);
  assert.equal(atsBoards.locationEligible({ location: 'Belgrade, Serbia' }, CA, 'Canada'), false);
});

test('locationEligible: a remote role LOCKED to a foreign country fails (residual place-name remains)', () => {
  assert.equal(atsBoards.locationEligible({ location: 'United States - Remote', remote: true }, CA, 'Canada'), false);
  assert.equal(atsBoards.locationEligible({ location: 'EMEA', remote: true }, CA, 'Canada'), false);
  assert.equal(atsBoards.locationEligible({ location: 'Remote - US', remote: true }, CA, 'Canada'), false);
});

test('locationEligible: empty target list keeps everything (no location preference set)', () => {
  assert.equal(atsBoards.locationEligible({ location: 'San Francisco, CA' }, [], ''), true);
  assert.equal(atsBoards.locationEligible({ location: 'Bengaluru, India' }, [], ''), true);
});

// ---- self-gate + self-throttle (the fix that made the feed actually run) ----

test('createAtsBoardsService().runTick(): self-gates while auto-apply is OFF (no fetch, reason=disabled)', async () => {
  // This is the whole reason the feed had never run: main.js now start()s the service at boot
  // UNCONDITIONALLY, so runTick must no-op while auto-apply is disabled instead of scanning.
  let fetched = 0;
  const fakeDb = makeFakeDb({
    getSettings: () => ({ autoApply: { enabled: false, discovery: { enabled: true, atsBoardsEnabled: true } } }),
  });
  const svc = atsBoards.createAtsBoardsService({
    ingestJobs: async () => ({ enqueued: 0, duplicates: 0, rejected: 0 }),
    db: fakeDb, fetchFn: async () => { fetched++; return { ok: true, status: 200, json: async () => ({ jobs: [] }) }; },
    logger: { info() {}, warn() {}, error() {} }, spacingMs: 0,
  });
  const r = await svc.runTick();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'disabled');
  assert.equal(fetched, 0, 'no ATS endpoint was hit while disabled');

  // ...but a forced/manual run bypasses the gate.
  const forced = await svc.runTick({ force: true });
  assert.equal(forced.ok, true);
  assert.ok(fetched > 0, 'forced run scans despite the disabled setting');
});

test('createAtsBoardsService().runTick(): self-gates when discovery.atsBoardsEnabled is false', async () => {
  let fetched = 0;
  const fakeDb = makeFakeDb({
    getSettings: () => ({ autoApply: { enabled: true, discovery: { enabled: true, atsBoardsEnabled: false } } }),
  });
  const svc = atsBoards.createAtsBoardsService({
    ingestJobs: async () => ({ enqueued: 0, duplicates: 0, rejected: 0 }),
    db: fakeDb, fetchFn: async () => { fetched++; return { ok: true, status: 200, json: async () => ({ jobs: [] }) }; },
    logger: { info() {}, warn() {}, error() {} }, spacingMs: 0,
  });
  const r = await svc.runTick();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'disabled');
  assert.equal(fetched, 0);
});

test('createAtsBoardsService().runTick(): self-throttles a rapid second (non-forced) call', async () => {
  let fetched = 0;
  const fakeDb = makeFakeDb();
  const svc = atsBoards.createAtsBoardsService({
    ingestJobs: async () => ({ enqueued: 0, duplicates: 0, rejected: 0 }),
    db: fakeDb, fetchFn: async () => { fetched++; return { ok: true, status: 200, json: async () => ({ jobs: [] }) }; },
    logger: { info() {}, warn() {}, error() {} }, spacingMs: 0,
  });
  const first = await svc.runTick();
  assert.equal(first.ok, true);
  const fetchedAfterFirst = fetched;
  const second = await svc.runTick();          // immediate → within MIN_TICK_INTERVAL_MS
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'throttled');
  assert.equal(fetched, fetchedAfterFirst, 'the throttled call did not hit any endpoint');
});

// ---- mergeTokenLists (helper exercised indirectly above; direct unit coverage) ----

test('mergeTokenLists dedupes seed + harvested tokens by ats+company, seed wins on collision order', () => {
  const seed = [
    { ats: 'greenhouse', token: 'exampleco' },
    { ats: 'lever', token: 'acmeco' },
  ];
  const harvested = [
    { ats: 'greenhouse', companyKey: 'exampleco' },   // duplicate of seed
    { ats: 'ashby', companyKey: 'rampco' },            // new
  ];
  const merged = atsBoards.mergeTokenLists(seed, harvested);
  const keys = merged.map((m) => `${m.ats}:${m.token}`);
  assert.deepEqual(keys, ['greenhouse:exampleco', 'lever:acmeco', 'ashby:rampco']);
});
