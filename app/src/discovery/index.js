'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { scope } = require('../logger');

const log = scope('discovery');
const SUPPORTED = new Set(['linkedin', 'indeed', 'glassdoor', 'google', 'zip_recruiter']);
const FALLBACK_STATUSES = new Set(['blocked', 'rate_limited', 'parser_drift', 'timeout', 'unavailable', 'failed']);

// ---- App-side freshness ramp (mirrors the WIDE tiers of extension/lib/freshness.js — see
// freshness-ramp.test.mjs). ROOT CAUSE of the overnight starvation (3 applies / 7h): the jobspy
// discovery path was pinned at a STATIC 72h window, so a SATURATED (board|keyword|location) combo
// — e.g. LinkedIn "frontend developer", every fresh posting already applied to — returned only
// duplicates FOREVER (accepted=0) and the queue starved. The tested freshness ramp was never wired
// into this path. Now each combo starts at the 72h floor and WIDENS one tier (7d → 14d → 30d) every
// time its scan ingests 0 NEW jobs, resetting to 72h the instant it finds fresh ones — newest-first,
// but a saturated niche keeps refilling from older not-yet-seen postings instead of grinding to zero.
const FRESH_BASE_SEC = 259200;                                 // 72h floor (the prior static behavior)
const FRESH_WIDE_TIERS = [259200, 604800, 1209600, 2592000];  // 72h → 7d → 14d → 30d
const FRESH_WIDEST_SEC = FRESH_WIDE_TIERS[FRESH_WIDE_TIERS.length - 1];   // 30d
const SATURATION_WINDOW_MS = 6 * 3600 * 1000;                 // no NEW accept in 6h ⇒ saturated
function widerFreshTier(sec) {
  const i = FRESH_WIDE_TIERS.indexOf(Number(sec));
  if (i === -1) return FRESH_BASE_SEC;
  return FRESH_WIDE_TIERS[Math.min(i + 1, FRESH_WIDE_TIERS.length - 1)];
}
// The EFFECTIVE scan window for a combo this tick. The stored tier still climbs one step per dry
// scan, but climbing 72h→30d takes 4 dry visits and — with one combo scanned per tick across
// hundreds of combos — that's ~16h of wall-clock before a saturated combo ever scans the 30d
// window where aged-but-unseen jobs live (the live "accepted:0 forever" symptom). So: a BRAND-NEW
// combo (no stored tier) starts at the 72h floor (newest-first); a SATURATED combo (scanned before
// but no NEW accept in >6h) jumps STRAIGHT to the 30d window on its NEXT visit; a recently-
// productive combo keeps its climbed tier. `nowMs` is injectable for tests.
function effectiveFreshTier(storedSec, lastNewAtMs, nowMs = Date.now()) {
  if (storedSec == null || storedSec === '') return FRESH_BASE_SEC;            // never scanned → newest-first
  if (!lastNewAtMs || (nowMs - Number(lastNewAtMs)) > SATURATION_WINDOW_MS) return FRESH_WIDEST_SEC; // saturated → widest
  return Number(storedSec) || FRESH_BASE_SEC;                                  // recently productive → keep climbing
}

// ---- Saturation de-prioritization (planner reordering, NOT a request-volume change). ROOT CAUSE:
// the planner round-robins every keyword×location combo with equal weight, so a combo that's been
// fully mined (widest 30d tier + no new accept in the saturation window — see effectiveFreshTier)
// gets scanned on the SAME cadence as a combo that's still yielding fresh jobs. That wastes ticks
// re-hitting dead ground instead of concentrating effort on combos still producing. A combo is
// "fully saturated" once it has climbed to the widest freshness tier for EVERY board it would be
// scanned on AND none of those boards found a new job within the saturation window. Once saturated,
// only let it through the planner every SKIP_EVERY_N-th time it comes up (deterministic, per-combo
// counter in kv) — total request volume across all combos is unchanged over a long run (it's still
// visited, just less often), only the ORDER/FREQUENCY shifts toward productive combos.
const SKIP_EVERY_N = 4;   // a saturated combo is scanned on 1-in-4 visits instead of every visit

function isComboSaturated(getTierAndLastNew, boards, keyword, location, nowMs = Date.now()) {
  const list = (Array.isArray(boards) ? boards : []).filter(Boolean);
  if (!list.length) return false;
  return list.every((source) => {
    const { storedSec, lastNewAtMs } = getTierAndLastNew(source, keyword, location) || {};
    return effectiveFreshTier(storedSec, lastNewAtMs, nowMs) === FRESH_WIDEST_SEC;
  });
}

// Pure decision (exported for tests): given the combo's current visit counter, should this tick
// SKIP a saturated combo (down-weight) or let it through? Non-saturated combos are never skipped.
// `counter` is the number of times this combo has been offered by the planner since it last ran;
// callers persist it in kv keyed per-combo and reset it to 0 whenever the combo is actually run.
function shouldSkipSaturatedCombo(saturated, counter) {
  if (!saturated) return false;
  return ((Number(counter) || 0) + 1) < SKIP_EVERY_N;
}
const activeChildren = new Set();

function text(v) { return v == null ? '' : String(v).trim(); }
function first(...xs) { return xs.map(text).find(Boolean) || ''; }

function normalizeJobSpyRecord(raw = {}, requestedSource = '') {
  const source = first(raw.site, raw.source, requestedSource).toLowerCase().replace(/\s+/g, '_');
  // Keep the board URL when available so the logged-in Chrome session can verify
  // Easy Apply versus external routing. The direct employer URL is useful metadata,
  // but bypassing the board would incorrectly turn every Indeed/LinkedIn candidate
  // into an external route before verification.
  const jobUrl = first(raw.job_url, raw.job_url_direct, raw.url);
  if (!jobUrl || !/^https?:\/\//i.test(jobUrl)) return null;
  const title = first(raw.title, raw.job_title);
  if (!title) return null;
  const minAmount = Number(raw.min_amount);
  const maxAmount = Number(raw.max_amount);
  return {
    title,
    company: first(raw.company, raw.company_name, 'Unknown company'),
    location: first(raw.location, raw.city, raw.state),
    jobUrl,
    source: source === 'zip_recruiter' ? 'ziprecruiter' : source,
    description: text(raw.description).slice(0, 30000),
    postedAt: first(raw.date_posted, raw.posted_at) || null,
    salary: Number.isFinite(minAmount) || Number.isFinite(maxAmount)
      ? { min: Number.isFinite(minAmount) ? minAmount : null, max: Number.isFinite(maxAmount) ? maxAmount : null, interval: first(raw.interval) || null }
      : null,
    remote: raw.is_remote === true,
    employmentType: first(raw.job_type) || null,
    applyCapability: 'unknown', // JobSpy's LinkedIn Easy Apply flag is not reliable.
    discoveryProvider: 'jobspy',
    directJobUrl: first(raw.job_url_direct) || null,
  };
}

function classifyProviderError(error) {
  const s = text(error).toLowerCase();
  if (/timed?\s*out|timeout/.test(s)) return 'timeout';
  if (/429|rate.?limit|too many requests/.test(s)) return 'rate_limited';
  if (/403|blocked|captcha|access denied|forbidden/.test(s)) return 'blocked';
  if (/selector|parse|schema|column|attribute|none.?type/.test(s)) return 'parser_drift';
  if (/enoent|not found|no module named|cannot find|worker unavailable/.test(s)) return 'unavailable';
  return 'failed';
}

// Pure board selection respecting easyApplyOnly (exported for tests). When
// easyApplyOnly is ON, NON-LinkedIn boards (Indeed/Glassdoor/Google/ZipRecruiter)
// have no real "Easy Apply" concept — feeding their results floods the queue with
// external postings that the runner then skips. So drop every non-LinkedIn board.
// When easyApplyOnly is OFF, behavior is unchanged (all configured boards kept).
// (LinkedIn search already pins f_AL=true via buildSearchUrl/easyApplyOnly, so its
// results are genuinely Easy-Apply.)
function selectBoards(boards, easyApplyOnly) {
  const list = (Array.isArray(boards) ? boards : []).filter(Boolean);
  if (!easyApplyOnly) return list;
  // Easy-Apply-only mode keeps the boards that HAVE an in-board (no-company-site) apply: LinkedIn
  // (Easy Apply) AND Indeed (Indeed-Apply → smartapply, now drivable in-tab even in easyApplyOnly —
  // see route.js indeed_native). Pure aggregators with no native apply (Glassdoor/Google/Zip) stay
  // dropped. Without Indeed here, turning on easyApplyOnly silently starved the whole Indeed stream.
  return list.filter((b) => b === 'linkedin' || b === 'indeed');
}

function planner(settings, index = 0) {
  const aa = settings?.autoApply || settings || {};
  const keywords = (aa.keywords || []).map(text).filter(Boolean);
  const locations = (aa.locations || []).map(text).filter(Boolean);
  if (!keywords.length) return null;
  const locs = locations.length ? locations : [''];
  const total = keywords.length * locs.length;
  const slot = ((Number(index) || 0) % total + total) % total;
  return { keyword: keywords[Math.floor(slot / locs.length)], location: locs[slot % locs.length], nextIndex: (slot + 1) % total };
}

function workerCandidates() {
  const out = [];
  if (process.env.JAT_JOBSPY_WORKER) out.push({ command: process.env.JAT_JOBSPY_WORKER, args: [] });
  const packaged = path.join(process.resourcesPath || '', 'discovery', process.platform === 'win32' ? 'jat-discovery.exe' : 'jat-discovery');
  if (process.resourcesPath && fs.existsSync(packaged)) out.push({ command: packaged, args: [] });
  const script = path.join(__dirname, 'jobspy_worker.py');
  out.push({ command: process.platform === 'win32' ? 'py' : 'python3', args: process.platform === 'win32' ? ['-3', script] : [script] });
  out.push({ command: 'python', args: [script] });
  return out;
}

function runProcess(candidate, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false, stdout = '', stderr = '';
    const child = spawn(candidate.command, candidate.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    activeChildren.add(child);
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(reject, new Error(`JobSpy timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.on('error', (e) => finish(reject, e));
    // When spawn fails (e.g. 'py'/'python' not on PATH — Dad's machine), Node emits an async 'error'
    // on the stdin stream too; with no listener that surfaces as an UNCAUGHT exception (the documented
    // 'spawn … ENOENT' crash class). Route it through finish() instead, and guard the write so a broken
    // pipe can't throw synchronously. The candidate fall-through still works: child.on('error') fires
    // first with a 'spawn … ENOENT' message that WORKER_NONVIABLE_RX matches, so the next launcher is tried.
    child.stdin.on('error', (e) => finish(reject, e));
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('close', (code) => {
      activeChildren.delete(child);
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      let result = null;
      for (let i = lines.length - 1; i >= 0; i--) { try { result = JSON.parse(lines[i]); break; } catch {} }
      if (result?.ok) finish(resolve, result);
      else finish(reject, new Error(result?.error || stderr.trim() || `JobSpy worker exited ${code}`));
    });
    try { child.stdin.end(JSON.stringify(request) + '\n'); } catch (e) { finish(reject, e); }
  });
}

// A candidate is "non-viable" — try the NEXT one — when the launcher couldn't run
// (enoent) OR it ran but lacks the jobspy module / produced no usable JSON. The
// `py -3` launcher exists on Windows but its interpreter often has no jobspy, so it
// exits non-zero with an ImportError ("No module named jobspy") rather than enoent.
// Treating only enoent as fall-through made that throw and discovery silently
// produced zero jobs instead of trying `python`/`python3`. Real provider failures
// (rate-limit, captcha, network) must still surface, so only the launcher-not-viable
// signatures fall through.
const WORKER_NONVIABLE_RX = /enoent|not found|no module named|cannot find module|modulenotfounderror|importerror|is not recognized|no such file|cannot run program|worker exited|spawn .* failed/i;

// Pure candidate-walk (exported for tests): try each launcher in order; fall through to
// the next ONLY when the current one is non-viable (couldn't launch / lacks jobspy).
// Any other error is a genuine provider failure and propagates so the typed classifier
// can queue a fallback. `runProcessFn` is injected so this is testable without spawning.
async function runWithCandidates(candidates, runProcessFn, request, timeoutMs = 90000) {
  let last = null;
  for (let i = 0; i < candidates.length; i++) {
    try { return await runProcessFn(candidates[i], request, timeoutMs); }
    catch (e) {
      last = e;
      const moreCandidates = i < candidates.length - 1;
      if (moreCandidates && WORKER_NONVIABLE_RX.test(text(e?.message))) continue;
      throw e;
    }
  }
  throw last || new Error('JobSpy worker unavailable');
}

async function defaultRunner(request, timeoutMs = 90000) {
  return runWithCandidates(workerCandidates(), runProcess, request, timeoutMs);
}

function createDiscoveryService({ ingestJobs, broadcast = () => {}, runner = defaultRunner } = {}) {
  let timer = null, warmup = null, running = false, stopped = false;
  let lastTickAt = 0;   // self-throttle gate (see runTick) — prevents the idle-watchdog storm

  async function searchBoard({ source, keyword, location, limit, hoursOld = 72, force = false, country = 'Canada', remote = false, easyApply = false, distance = 0 }) {
    // location is ALWAYS a geography. Never let it be empty — fall back to the country so
    // a LinkedIn scrape (which has no country param) is still geo-clamped. Work-mode is a
    // separate boolean (`remote`), never smuggled in as the location string.
    const geo = text(location) || text(country) || 'Canada';
    const batch = db.discoveryBatchStart({ provider: 'jobspy', source, keyword, location: geo });
    broadcast('discovery.updated', { batch });
    try {
      const result = await runner({ source, keyword, location: geo, limit, hours_old: hoursOld, country: text(country) || 'Canada', remote: !!remote, easy_apply: !!easyApply, distance: Number(distance) || 0 }, 90000);
      if (stopped) return batch;
      const jobs = (result.jobs || []).map((j) => normalizeJobSpyRecord(j, source)).filter(Boolean);
      const intake = await ingestJobs(source, jobs, { provider: 'jobspy', batchId: batch.id, force });
      const status = jobs.length ? 'ok' : 'empty';
      const done = db.discoveryBatchComplete(batch.id, {
        status, found: jobs.length, accepted: intake.enqueued || 0, duplicates: intake.duplicates || 0,
        rejected: intake.rejected || 0, diagnostics: { engine: 'python-jobspy', normalized: jobs.length },
      });
      broadcast('discovery.updated', { batch: done });
      return done;
    } catch (e) {
      if (stopped) return batch;
      const status = classifyProviderError(e?.message || e);
      const done = db.discoveryBatchComplete(batch.id, { status, error: text(e?.message || e), diagnostics: { engine: 'python-jobspy' } });
      if (FALLBACK_STATUSES.has(status) && ['linkedin', 'indeed', 'glassdoor'].includes(source)) {
        db.discoveryFallbackQueue({ batchId: batch.id, source, keyword, location, reason: `${status}: ${done.error || ''}` });
      }
      broadcast('discovery.updated', { batch: done, fallbackQueued: FALLBACK_STATUSES.has(status) });
      return done;
    }
  }

  async function runTick({ force = false } = {}) {
    if (running) return { ok: false, reason: 'already-running' };
    const settings = db.getSettings();
    const aa = settings.autoApply || {};
    if (!force && (!aa.enabled || !aa.discovery?.enabled)) return { ok: false, reason: 'disabled' };
    // SELF-THROTTLE (anti subprocess-storm): the idle-watchdog (main.js) pokes runTick every few
    // seconds whenever the queue is drained — and fast-failing applies keep it drained. Without a
    // time gate that spawns a JobSpy subprocess (×up to 3 boards) every few seconds, pinning the
    // CPU and freezing the machine. Never scrape more than once per the configured interval
    // (floor 60s), no matter how often we're called. A manual/forced run bypasses this.
    const ivMs = Math.max(1, Number(aa.discovery?.intervalMinutes) || 1) * 60000;
    if (!force && (Date.now() - lastTickAt) < ivMs) return { ok: false, reason: 'throttled' };
    // SOURCE-AWARE refill gate. jobspy discovers linkedin/indeed; the direct-ATS board feed
    // (ats-boards.js — greenhouse/lever/ashby) fills the SAME queue from a SEPARATE provider. Gate
    // jobspy on the queued depth of NON-ATS jobs only — otherwise a backlog of slow ATS jobs keeps
    // the total queue ≥ refillBelow and STARVES fresh LinkedIn discovery (the high-volume Easy-Apply
    // source). Confirmed root cause of a 24h-run collapse: jobspy ran only 3× in 24h (9–11h gaps)
    // while the queue sat full of ATS jobs, so LinkedIn dribbled ~2/hr instead of its ~30/hr.
    if (!force) {
      const ATS_FEED_SOURCES = new Set(['greenhouse', 'lever', 'ashby']);
      const jobspyQueued = db.queueList({ state: 'queued' })
        .filter((t) => !ATS_FEED_SOURCES.has(String((t.job && t.job.source) || '').toLowerCase())).length;
      if (jobspyQueued >= (aa.discovery?.refillBelow || 3)) return { ok: false, reason: 'queue-full' };
    }
    // Board selection happens BEFORE combo selection: which boards a combo would scan on is needed
    // to test that combo for saturation (see isComboSaturated below), and board choice never depends
    // on which combo is picked.
    let boards = (aa.boards || ['linkedin', 'indeed']).map((b) => text(b).toLowerCase().replace(/\s+/g, '_')).filter((b) => SUPPORTED.has(b));
    if (!boards.length) return { ok: false, reason: 'no-supported-boards' };
    // Fix 5(a): in Easy-Apply-only mode, only LinkedIn can yield real Easy-Apply jobs
    // (its search adds f_AL=true). Non-LinkedIn boards have no Easy-Apply concept, so
    // discovering from them just floods the queue with external postings that get skipped.
    // COOLDOWN FALLBACK: when LinkedIn Easy-Apply is cooled down (daily cap hit), relax easyApplyOnly
    // so discovery also pulls external/ATS boards — the node keeps applying (external applies don't
    // count against LinkedIn's cap) instead of idling until the cooldown lifts. Reverts automatically.
    const effEasyApplyOnly = aa.easyApplyOnly !== false && !db.easyApplyCooledDown();
    if (effEasyApplyOnly) {
      const easyBoards = selectBoards(boards, true);
      if (easyBoards.length) boards = easyBoards;
      else return { ok: false, reason: 'no-easy-apply-boards' };
    }
    const boardIndex = Number(db.kvGet('discoveryBoardIndex')) || 0;
    const selectedBoards = [];
    for (let i = 0; i < Math.min(3, boards.length); i++) selectedBoards.push(boards[(boardIndex + i) % boards.length]);
    db.kvSet('discoveryBoardIndex', (boardIndex + selectedBoards.length) % boards.length);
    // WIDEN: scan a BATCH of consecutive planner combos per tick (default 1, cap 5) so the full
    // keyword×location space (hundreds of combos) is swept in a fraction of the wall-clock instead
    // of one combo per interval. Combos run SEQUENTIALLY below, so at most selectedBoards.length
    // subprocesses are ever live at once — the anti-subprocess-storm invariant is preserved.
    //
    // SATURATION SKIP: while walking the planner, a combo that's fully saturated on every board in
    // selectedBoards (see isComboSaturated) is offered but usually DOWN-WEIGHTED — its per-combo
    // visit counter (kv) increments and the planner moves on to the next combo instead, UNLESS the
    // counter says this is its 1-in-SKIP_EVERY_N turn, in which case it's let through like normal
    // and its counter resets. This is pure reordering: a skipped combo's planner index still
    // advances (so it isn't stuck), and it still gets scanned eventually — just less often — so
    // total request volume over a long run is unchanged while effort concentrates on combos still
    // yielding new jobs. Bounded by a generous walk cap so an all-saturated combo space can't spin.
    const combosPerTick = Math.max(1, Math.min(5, Number(aa.discovery?.combosPerTick) || 1));
    const getTierAndLastNew = (source, keyword, location) => ({
      storedSec: db.kvGet(`freshTier:${source}|${keyword}|${location}`),
      lastNewAtMs: Number(db.kvGet(`freshLastNew:${source}|${keyword}|${location}`)) || 0,
    });
    let plannerIdx = Number(db.kvGet('discoveryPlannerIndex')) || 0;
    const combos = [];
    const seenCombo = new Set();
    const maxWalk = Math.max(combosPerTick, Math.min(200, combosPerTick * SKIP_EVERY_N * 2));
    // Fallback if EVERY combo in the space is saturated and none is on its Nth turn this cycle
    // (rare — normally at least one combo hits its turn well before a full wrap): rather than
    // starving discovery entirely, fall back to the single most-skipped (longest overdue) combo
    // seen during the walk so a full cycle of down-weighting still guarantees forward progress.
    let staleFallback = null, staleFallbackCounter = -1;
    for (let walk = 0; walk < maxWalk && combos.length < combosPerTick; walk++) {
      const q = planner(settings, plannerIdx);
      if (!q) break;
      const key = `${q.keyword}|${q.location}`;
      if (seenCombo.has(key)) break;   // wrapped a full cycle of the combo space — don't rescan
      seenCombo.add(key);
      plannerIdx = q.nextIndex;
      const skipKey = `discoverySkipCount:${key}`;
      const saturated = isComboSaturated(getTierAndLastNew, selectedBoards, q.keyword, q.location);
      const counter = Number(db.kvGet(skipKey)) || 0;
      if (shouldSkipSaturatedCombo(saturated, counter)) {
        db.kvSet(skipKey, counter + 1);
        if (counter > staleFallbackCounter) { staleFallback = q; staleFallbackCounter = counter; }
        continue;   // down-weighted this cycle — planner index already advanced past it
      }
      if (saturated) db.kvSet(skipKey, 0);   // let through on its 1-in-N turn — reset the counter
      combos.push(q);
    }
    if (!combos.length && staleFallback) {
      db.kvSet(`discoverySkipCount:${staleFallback.keyword}|${staleFallback.location}`, 0);
      combos.push(staleFallback);
    }
    if (!combos.length) return { ok: false, reason: 'no-keywords' };
    db.kvSet('discoveryPlannerIndex', plannerIdx);
    const query = combos[0];
    // Country-clamp every source; pass work-mode through as a boolean (never as location).
    const country = text(aa.country) || 'Canada';
    const remote = Array.isArray(aa.workModes) && aa.workModes.includes('remote');
    lastTickAt = Date.now();   // stamp only once we actually proceed to scrape (gates the next call)
    running = true;
    try {
      const scanCombo = async (query) => Promise.all(selectedBoards.map(async (source) => {
        // Per-combo freshness tier: a saturated combo widens its window so it keeps surfacing
        // older, not-yet-seen postings instead of re-finding the same duplicates at a fixed 72h.
        const tierKey = `freshTier:${source}|${query.keyword}|${query.location}`;
        const lastNewKey = `freshLastNew:${source}|${query.keyword}|${query.location}`;
        const stored = db.kvGet(tierKey);                       // null = never scanned
        const lastNew = Number(db.kvGet(lastNewKey)) || 0;      // ms of the last NEW-accept
        const tierSec = effectiveFreshTier(stored, lastNew);   // jump saturated combos straight to 30d
        // Under easyApplyOnly, ask JobSpy for ONLY board-hosted (Indeed-Apply / LinkedIn Easy-Apply)
        // jobs — the ones we can actually auto-submit — instead of the freshness window. This drops
        // the ~30% external company-site bounces that were the biggest source of wasted attempts.
        const easyApply = effEasyApplyOnly && (source === 'indeed' || source === 'linkedin');
        const done = await searchBoard({
          source, keyword: query.keyword, location: query.location, country, remote,
          limit: Math.max(10, Math.min(50, Number(aa.discovery?.perRunLimit) || 25)), force,
          hoursOld: Math.round(tierSec / 3600), easyApply,
          distance: Math.max(0, Math.min(100, Number(aa.discovery?.distanceMiles) || 0)),
        });
        // Ramp AFTER the scan: found NEW (accepted>0) → reset to the 72h floor (re-hammer fresh) AND
        // stamp freshLastNew=now so saturation is measured from real yield; a DRY scan (0 new on an
        // ok/empty result — NOT a provider error) → widen the STORED tier one step (cap 30d).
        try {
          const acc = Number(done?.accepted) || 0;   // discoveryBatchGet maps accepted_count → accepted
          const errored = done?.status && !['ok', 'empty'].includes(done.status);
          if (!errored) {
            db.kvSet(tierKey, acc > 0 ? FRESH_BASE_SEC : widerFreshTier(Number(stored) || FRESH_BASE_SEC));
            if (acc > 0) db.kvSet(lastNewKey, Date.now());
          }
        } catch {}
        return done;
      }));
      // Sequential over combos: bounds live subprocesses to selectedBoards.length (anti-storm),
      // and each combo's per-board freshness ramp still runs inside scanCombo.
      const batch = [];
      for (const q of combos) batch.push({ query: q, results: await scanCombo(q) });
      const first = batch[0] || { query, results: [] };
      db.kvSet('discoveryStatus', { provider: 'jobspy', query: first.query, results: first.results, combos: batch.map((b) => b.query), at: new Date().toISOString() });
      return { ok: true, query: first.query, results: first.results, combos: batch, combosScanned: batch.length };
    } finally { running = false; }
  }

  function start({ intervalMs = 60000, warmupMs = 12000 } = {}) {
    stop();
    stopped = false;
    warmup = setTimeout(() => runTick().catch((e) => log.warn('warmup failed', e.message)), warmupMs);
    timer = setInterval(() => runTick().catch((e) => log.warn('tick failed', e.message)), intervalMs);
  }
  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    if (warmup) clearTimeout(warmup);
    timer = null; warmup = null;
    for (const child of activeChildren) { try { child.kill(); } catch {} }
  }
  return { runTick, searchBoard, start, stop, isRunning: () => running };
}

module.exports = {
  normalizeJobSpyRecord, classifyProviderError, planner, selectBoards, defaultRunner, runWithCandidates,
  workerCandidates, createDiscoveryService, effectiveFreshTier, widerFreshTier, FRESH_BASE_SEC, FRESH_WIDEST_SEC,
  isComboSaturated, shouldSkipSaturatedCombo, SKIP_EVERY_N,
};
