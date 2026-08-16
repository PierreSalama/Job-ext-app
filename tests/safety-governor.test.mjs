// The brake that did not exist on 2026-08-10, when LinkedIn restricted Pierre's account for
// "an unusually high volume of LinkedIn profile data".
//
// From this machine's own discovery_batches on the worst day:
//     2026-08-08  linkedin  runs=281  found=8627
// ...and the laptop ran the same settings against the same account in parallel. Meanwhile every
// cap in the system counted APPLIES (~40/day, at LinkedIn's own ceiling) and reported all clear.
//
// These tests pin the four independent brakes and, more importantly, the two design decisions that
// are easy to "simplify" away later: applies and searches share ONE budget, and only one node may
// touch a platform at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const safety = require(path.join(here, '..', 'app', 'src', 'safety.js'));
const { DEFAULTS } = require(path.join(here, '..', 'app', 'src', 'config.js'));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');

const AT = (hhmm) => new Date(`2026-08-15T${hhmm}:00`);          // local time, mid-afternoon default
const NOON = AT('12:00');
const ZERO = { search: { day: 0, hour: 0 }, apply: { day: 0, hour: 0 } };

function cfg(over = {}) {
  return {
    enabled: true,
    platforms: {
      linkedin: {
        role: 'primary',
        searchesPerDay: 24, searchesPerHour: 3, minSearchGapMinutes: 20,
        appliesPerDay: 15, appliesPerHour: 4, minApplyGapMinutes: 4,
        quietStart: '23:00', quietEnd: '07:00', jitterPct: 0.4,
        ...over,
      },
    },
  };
}

// ---- brake 1: role (the actual fix for "two PCs on one account") -------------------------------

test('a node that does not own the platform is refused, whatever its budget says', () => {
  const s = cfg({ role: 'none', searchesPerDay: 9999, appliesPerDay: 9999 });
  for (const kind of ['search', 'apply']) {
    const d = safety.decideTouch({ safety: s, platform: 'linkedin', kind, counts: ZERO, now: NOON });
    assert.equal(d.ok, false);
    assert.equal(d.reason, 'not-this-node',
      'the second machine must refuse LOCALLY — no cross-node coordination exists to catch it later');
  }
});

test('the refusal backs off for a full day, so a non-owning node cannot spin', () => {
  const d = safety.decideTouch({ safety: cfg({ role: 'none' }), platform: 'linkedin', kind: 'search', counts: ZERO, now: NOON });
  assert.equal(d.retryAfterMs, safety.DAY_MS, 'only a human changing the role changes this answer');
});

// ---- brake 2: one budget covering BOTH kinds ---------------------------------------------------

test('searches are budgeted at all — the counter that was missing', () => {
  const counts = { search: { day: 24, hour: 0 }, apply: { day: 0, hour: 0 } };
  const d = safety.decideTouch({ safety: cfg(), platform: 'linkedin', kind: 'search', counts, now: NOON });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'daily-budget');
  assert.equal(d.used, 24);
});

test('a spent SEARCH budget does not block applies, and vice versa', () => {
  // They share the governor, not the counter. Conflating them would mean one exhausted lane
  // silently killed the other — the real limits are per-kind and behave differently.
  const searchSpent = { search: { day: 24, hour: 3 }, apply: { day: 0, hour: 0 } };
  assert.equal(safety.decideTouch({ safety: cfg(), platform: 'linkedin', kind: 'apply', counts: searchSpent, now: NOON }).ok, true);
  const applySpent = { search: { day: 0, hour: 0 }, apply: { day: 15, hour: 4 } };
  assert.equal(safety.decideTouch({ safety: cfg(), platform: 'linkedin', kind: 'search', counts: applySpent, now: NOON }).ok, true);
});

test('the hourly ceiling binds before the daily one', () => {
  const counts = { search: { day: 0, hour: 0 }, apply: { day: 5, hour: 4 } };
  const d = safety.decideTouch({ safety: cfg(), platform: 'linkedin', kind: 'apply', counts, now: NOON });
  assert.equal(d.reason, 'hourly-budget');
});

test('a zero budget means unlimited for that kind ONLY when explicitly set to 0', () => {
  const s = cfg({ appliesPerDay: 0, appliesPerHour: 0, minApplyGapMinutes: 0 });
  const counts = { search: { day: 0, hour: 0 }, apply: { day: 9999, hour: 9999 } };
  assert.equal(safety.decideTouch({ safety: s, platform: 'linkedin', kind: 'apply', counts, now: NOON }).ok, true);
});

// ---- brake 3: jittered gap ---------------------------------------------------------------------

test('a touch inside the minimum gap is deferred by exactly the remaining time', () => {
  const now = NOON;
  const lastTouchAt = now.getTime() - 60 * 1000;                 // 1 min ago, gap is 20
  const d = safety.decideTouch({
    safety: cfg(), platform: 'linkedin', kind: 'search', counts: ZERO,
    lastTouchAt, requiredGapMs: 20 * 60000, now,
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'min-gap');
  assert.equal(d.retryAfterMs, 19 * 60000);
});

test('jitter only ever slows us down — never below the configured floor', () => {
  const base = 20;
  assert.equal(safety.jitteredGapMs(base, 0.4, () => 0), 20 * 60000, 'rng=0 gives exactly the floor');
  assert.equal(safety.jitteredGapMs(base, 0.4, () => 1), 28 * 60000, 'rng=1 gives floor × 1.4');
  for (const r of [0, 0.13, 0.5, 0.87, 1]) {
    const g = safety.jitteredGapMs(base, 0.4, () => r);
    assert.ok(g >= 20 * 60000 && g <= 28 * 60000, `gap ${g} stayed inside [floor, floor×1.4]`);
  }
});

test('a negative or absurd jitter cannot produce a gap shorter than the floor', () => {
  assert.equal(safety.jitteredGapMs(20, -5, () => 1), 20 * 60000);
  assert.ok(safety.jitteredGapMs(20, 99, () => 1) <= 20 * 60000 * 3, 'jitter is clamped, not unbounded');
});

// ---- brake 4: quiet hours ----------------------------------------------------------------------

test('nothing is touched during quiet hours', () => {
  const d = safety.decideTouch({ safety: cfg(), platform: 'linkedin', kind: 'search', counts: ZERO, now: AT('03:00') });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'quiet-hours', 'a steady scrape rate at 3am is itself the signature');
});

test('the quiet window wraps midnight correctly at both edges', () => {
  const s = cfg();
  const quiet = (hhmm) => safety.decideTouch({ safety: s, platform: 'linkedin', kind: 'search', counts: ZERO, now: AT(hhmm) }).reason === 'quiet-hours';
  assert.equal(quiet('22:59'), false, 'just before it starts');
  assert.equal(quiet('23:00'), true, 'inclusive at the start');
  assert.equal(quiet('23:59'), true);
  assert.equal(quiet('00:30'), true, 'after midnight is still the same window');
  assert.equal(quiet('06:59'), true);
  assert.equal(quiet('07:00'), false, 'exclusive at the end');
});

test('quiet hours back off until the window actually ends, not for a token minute', () => {
  const d = safety.decideTouch({ safety: cfg(), platform: 'linkedin', kind: 'search', counts: ZERO, now: AT('23:30') });
  assert.equal(Math.round(d.retryAfterMs / 60000), 7 * 60 + 30, 'sleeps 7h30m through to 07:00');
});

test('an empty quiet window disables quiet hours rather than blocking forever', () => {
  const s = cfg({ quietStart: '00:00', quietEnd: '00:00' });
  assert.equal(safety.decideTouch({ safety: s, platform: 'linkedin', kind: 'search', counts: ZERO, now: AT('03:00') }).ok, true);
});

// ---- fail-safe defaults ------------------------------------------------------------------------

test('an unconfigured platform defaults to NOT TOUCHING IT', () => {
  const d = safety.decideTouch({ safety: { enabled: true, platforms: {} }, platform: 'linkedin', kind: 'search', counts: ZERO, now: NOON });
  assert.equal(d.ok, false, 'a missing budget must never read as an unlimited one');
  assert.equal(safety.PLATFORM_FALLBACK.role, 'none');
});

test('but apply dispatch treats unconfigured platforms as ungoverned, so external ATS keeps flowing', () => {
  // Greenhouse/Lever/Ashby/company career pages are individual employers, not a platform metering
  // us. Blocking them would kill the entire safe lane we rely on while LinkedIn is throttled.
  const d = safety.decideTouch({ safety: cfg(), platform: 'greenhouse', kind: 'apply', requireConfig: true, counts: ZERO, now: NOON });
  assert.equal(d.ok, true);
  assert.equal(d.reason, 'ungoverned-platform');
});

test('requireConfig does NOT weaken a platform that IS configured', () => {
  const s = cfg({ role: 'none' });
  const d = safety.decideTouch({ safety: s, platform: 'linkedin', kind: 'apply', requireConfig: true, counts: ZERO, now: NOON });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'not-this-node');
});

test('the master switch is opt-OUT and audible', () => {
  const d = safety.decideTouch({ safety: { enabled: false }, platform: 'linkedin', kind: 'search', counts: ZERO, now: NOON });
  assert.equal(d.ok, true);
  assert.equal(d.reason, 'safety-disabled', 'turning the governor off must be visible in the decision, not silent');
});

// ---- shipped defaults --------------------------------------------------------------------------

test('shipped defaults are conservative, and no node owns LinkedIn out of the box', () => {
  const s = DEFAULTS.autoApply.safety;
  assert.equal(s.enabled, true);
  const li = s.platforms.linkedin;
  assert.equal(li.role, 'none', 'a fresh install must not start touching LinkedIn until a human says which node owns it');
  assert.ok(li.searchesPerDay <= 30, `searchesPerDay ${li.searchesPerDay} must be far below the 281/day that got the account restricted`);
  assert.ok(li.appliesPerDay <= 20, `appliesPerDay ${li.appliesPerDay} must sit well under LinkedIn's own ~40/day ceiling`);
  assert.ok(li.minSearchGapMinutes >= 10);
  assert.ok(li.jitterPct > 0, 'a fixed interval is an automation signature');
  for (const [name, p] of Object.entries(s.platforms)) {
    assert.equal(p.role, 'none', `${name} must ship unowned`);
    assert.ok(safety.parseHHMM(p.quietStart) != null && safety.parseHHMM(p.quietEnd) != null, `${name} has valid quiet hours`);
  }
});

test('every scraper board the discovery engine supports has a budget entry', () => {
  // A board in SUPPORTED with no entry would fail safe (blocked) — correct, but invisibly so.
  const disc = read('app', 'src', 'discovery', 'index.js');
  const m = /const SUPPORTED = new Set\(\[([^\]]+)\]\)/.exec(disc);
  assert.ok(m, 'found the SUPPORTED board list');
  const boards = m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
  for (const b of boards) {
    assert.ok(DEFAULTS.autoApply.safety.platforms[b], `${b} is scraped by discovery but has no safety budget`);
  }
});

// ---- wiring: the gate must be where the traffic actually is ------------------------------------

test('discovery asks the governor per OUTBOUND SEARCH, not once per tick', () => {
  // One tick fans out over combosPerTick × selectedBoards — up to 15 searches. A per-tick gate
  // would undercount the real request volume by that factor, which is how 281/day went unnoticed.
  const disc = read('app', 'src', 'discovery', 'index.js');
  const scan = disc.slice(disc.indexOf('const scanCombo ='), disc.indexOf('// Sequential over combos'));
  assert.match(scan, /safety\.decideTouch/, 'the gate lives inside the per-source lambda');
  assert.match(scan, /kind: 'search'/);
  assert.match(scan, /db\.recordPlatformTouch\(source, 'search'\)/, 'and the touch is recorded there too');
  const iGate = scan.indexOf('safety.decideTouch');
  const iSearch = scan.indexOf('await searchBoard(');
  assert.ok(iGate > -1 && iGate < iSearch, 'asked BEFORE the request goes out');
});

test('the apply gate is not bypassable by force', () => {
  // `force` exists for "run one now" from the dashboard. The account does not care who pressed it.
  const server = read('app', 'src', 'server.js');
  const block = server.slice(server.indexOf('const safetyGate = safetyGateFor(platform);'));
  const body = block.slice(0, block.indexOf('const siteKey ='));
  assert.doesNotMatch(body, /!force/, 'no force escape hatch on the account budget');
  const gate = server.slice(server.indexOf('const safetyGateFor = (platform) =>'));
  assert.match(gate.slice(0, gate.indexOf('};')), /requireConfig: true/);
});

test('the apply budget is spent when a browser session STARTS, not merely on claim', () => {
  // Still not at submit time — a failed or parked apply really did cost the platform a session of
  // page loads, and counting only submissions is why a day of failures looked free while LinkedIn
  // saw a flood. But charging on CLAIM was wrong in the other direction: a claim does not always
  // open a browser. Live 2026-08-14, LinkedIn tasks were claimed every ~10 min for 6+ hours with the
  // executor NEVER launching (no "executor started in tab", attempts=0); the watchdog recycled them
  // and every recycle charged again — 30/30 applies recorded against ZERO applications, which then
  // hard-blocked the platform on traffic that never happened.
  //
  // 'running' is the honest line: the executor PATCHes it only once its tab is open.
  const server = read('app', 'src', 'server.js');

  // The claim site must NOT charge.
  const claim = server.indexOf("broadcast('queue.updated', { taskId: task.id, state: 'scheduled' })");
  assert.ok(claim > -1);
  assert.doesNotMatch(server.slice(claim, claim + 900), /db\.recordPlatformTouch\([^)]*'apply'\)/,
    'claiming a task must not spend budget — it may never open a browser');

  // The running transition must charge, and only on the transition.
  const patch = server.indexOf("if (req.method === 'PATCH' && (jm = m(/^\\/queue\\/([^/]+)$/)))");
  assert.ok(patch > -1);
  const body = server.slice(patch, patch + 1400);
  assert.match(body, /body\.state === 'running' && !wasRunning/,
    'charge on the transition only, so repeated progress reports cannot double-charge');
  assert.match(body, /db\.recordPlatformTouch\(src, 'apply'\)/);
  // rowToTask exposes jobId, not a nested job: reading task.job.source would be undefined and the
  // governor would silently stop protecting the account.
  assert.match(body, /db\.getJob\(task\.jobId\)/,
    'resolve the job explicitly — task.job does not exist on a patched task');
});

test('a safety deferral is reported as its own reason, with a real backoff', () => {
  const server = read('app', 'src', 'server.js');
  const block = server.slice(server.indexOf('if (!candidates.length && safetyDeferred)'));
  const body = block.slice(0, block.indexOf("if (!candidates.length && easyApplyDeferred)"));
  assert.match(body, /reason: `safety-\$\{safetyDeferred\.reason\}`/, 'never collapsed into the generic empty/gap');
  assert.match(body, /retryAfterMs: safetyDeferred\.retryAfterMs/, 'so the pump sleeps for hours instead of re-asking');
});

test('the extension\'s OWN browser search lane needs a permit before it opens a tab', () => {
  // discoverTick runs on every pump tick and its own comment calls itself "primary supply". It
  // opens a real LinkedIn search in the logged-in session and never touched the app at all, so no
  // app-side gate could see it. Of the three LinkedIn lanes this is the most attributable one.
  const bg = read('extension', 'background.js');
  const fn = bg.slice(bg.indexOf('async function discoverTick('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  const iPermit = body.indexOf('/auto-apply/search-permit');
  const iTab = body.indexOf('createAaTab(url');
  assert.ok(iPermit > -1, 'discoverTick asks for a permit');
  assert.ok(iTab > -1 && iPermit < iTab, 'the permit is asked BEFORE the search tab is opened');
  const permitBlock = body.slice(iPermit, iTab);
  assert.match(permitBlock, /permit\.allowed === false/);
  assert.doesNotMatch(permitBlock, /force/, 'a manual discover is still a request LinkedIn counts');
});

test('the permit endpoint spends the budget at grant time', () => {
  const server = read('app', 'src', 'server.js');
  const block = server.slice(server.indexOf("pathname === '/auto-apply/search-permit'"));
  const body = block.slice(0, block.indexOf("pathname === '/auto-apply/discovery-fallback/next'"));
  assert.match(body, /if \(gate\.ok\) db\.recordPlatformTouch\(source, 'search'\)/,
    'granting is the commitment — by the time we would hear back, the request has happened');
  assert.match(body, /allowed: !!gate\.ok/);
});

test('the browser-fallback search lane is governed too', () => {
  // The forgotten second lane: when JobSpy is rate-limited or blocked on LinkedIn, the extension
  // opens a REAL search in Pierre's logged-in browser — retrying harder, and more attributably,
  // at the exact moment the platform started pushing back. It counted nowhere.
  const server = read('app', 'src', 'server.js');
  const block = server.slice(server.indexOf("pathname === '/auto-apply/discovery-fallback/next'"));
  const body = block.slice(0, block.indexOf('if (req.method === \'POST\''));
  assert.match(body, /safety\.decideTouch/);
  assert.match(body, /kind: 'search'/);
  assert.match(body, /db\.recordPlatformTouch\(request\.source, 'search'\)/);
  assert.match(body, /request: null, deferred: gate/, 'a refusal hands back no work, and says why');
});

test('the safety deferral outranks the other deferral reasons', () => {
  const server = read('app', 'src', 'server.js');
  const iSafety = server.indexOf('if (!candidates.length && safetyDeferred)');
  for (const other of ['easyApplyDeferred', 'signedOutDeferred', 'hostDeferred', 'siteGapDeferred']) {
    const i = server.indexOf(`if (!candidates.length && ${other})`);
    assert.ok(iSafety > -1 && iSafety < i, `safety must be reported before ${other}`);
  }
});
