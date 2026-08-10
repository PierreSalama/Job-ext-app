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

test('the apply budget is spent at CLAIM time, not at submit time', () => {
  // A failed or parked apply still cost the platform a full session of page loads. Counting only
  // submissions is why a day of failures looked free while LinkedIn saw a flood.
  const server = read('app', 'src', 'server.js');
  const i = server.indexOf("broadcast('queue.updated', { taskId: task.id, state: 'scheduled' })");
  assert.ok(i > -1);
  const after = server.slice(i, i + 900);
  assert.match(after, /db\.recordPlatformTouch\(String\(job\.source \|\| ''\)\.toLowerCase\(\), 'apply'\)/);
});

test('a safety deferral is reported as its own reason, with a real backoff', () => {
  const server = read('app', 'src', 'server.js');
  const block = server.slice(server.indexOf('if (!candidates.length && safetyDeferred)'));
  const body = block.slice(0, block.indexOf("if (!candidates.length && easyApplyDeferred)"));
  assert.match(body, /reason: `safety-\$\{safetyDeferred\.reason\}`/, 'never collapsed into the generic empty/gap');
  assert.match(body, /retryAfterMs: safetyDeferred\.retryAfterMs/, 'so the pump sleeps for hours instead of re-asking');
});

test('the safety deferral outranks the other deferral reasons', () => {
  const server = read('app', 'src', 'server.js');
  const iSafety = server.indexOf('if (!candidates.length && safetyDeferred)');
  for (const other of ['easyApplyDeferred', 'signedOutDeferred', 'hostDeferred', 'siteGapDeferred']) {
    const i = server.indexOf(`if (!candidates.length && ${other})`);
    assert.ok(iSafety > -1 && iSafety < i, `safety must be reported before ${other}`);
  }
});
