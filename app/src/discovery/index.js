'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { scope } = require('../logger');

const log = scope('discovery');
const SUPPORTED = new Set(['linkedin', 'indeed', 'glassdoor', 'google', 'zip_recruiter']);
const FALLBACK_STATUSES = new Set(['blocked', 'rate_limited', 'parser_drift', 'timeout', 'unavailable', 'failed']);
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
  return list.filter((b) => b === 'linkedin');
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

  async function searchBoard({ source, keyword, location, limit, hoursOld = 72, force = false, country = 'Canada', remote = false }) {
    // location is ALWAYS a geography. Never let it be empty — fall back to the country so
    // a LinkedIn scrape (which has no country param) is still geo-clamped. Work-mode is a
    // separate boolean (`remote`), never smuggled in as the location string.
    const geo = text(location) || text(country) || 'Canada';
    const batch = db.discoveryBatchStart({ provider: 'jobspy', source, keyword, location: geo });
    broadcast('discovery.updated', { batch });
    try {
      const result = await runner({ source, keyword, location: geo, limit, hours_old: hoursOld, country: text(country) || 'Canada', remote: !!remote }, 90000);
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
    if (!force && db.queueList({ state: 'queued' }).length >= (aa.discovery?.refillBelow || 3)) return { ok: false, reason: 'queue-full' };
    const idx = Number(db.kvGet('discoveryPlannerIndex')) || 0;
    const query = planner(settings, idx);
    if (!query) return { ok: false, reason: 'no-keywords' };
    db.kvSet('discoveryPlannerIndex', query.nextIndex);
    let boards = (aa.boards || ['linkedin', 'indeed']).map((b) => text(b).toLowerCase().replace(/\s+/g, '_')).filter((b) => SUPPORTED.has(b));
    if (!boards.length) return { ok: false, reason: 'no-supported-boards' };
    // Fix 5(a): in Easy-Apply-only mode, only LinkedIn can yield real Easy-Apply jobs
    // (its search adds f_AL=true). Non-LinkedIn boards have no Easy-Apply concept, so
    // discovering from them just floods the queue with external postings that get skipped.
    if (aa.easyApplyOnly !== false) {
      const easyBoards = selectBoards(boards, true);
      if (easyBoards.length) boards = easyBoards;
      else return { ok: false, reason: 'no-easy-apply-boards' };
    }
    const boardIndex = Number(db.kvGet('discoveryBoardIndex')) || 0;
    const selectedBoards = [];
    for (let i = 0; i < Math.min(3, boards.length); i++) selectedBoards.push(boards[(boardIndex + i) % boards.length]);
    db.kvSet('discoveryBoardIndex', (boardIndex + selectedBoards.length) % boards.length);
    // Country-clamp every source; pass work-mode through as a boolean (never as location).
    const country = text(aa.country) || 'Canada';
    const remote = Array.isArray(aa.workModes) && aa.workModes.includes('remote');
    lastTickAt = Date.now();   // stamp only once we actually proceed to scrape (gates the next call)
    running = true;
    try {
      const results = await Promise.all(selectedBoards.map((source) => searchBoard({
        source, keyword: query.keyword, location: query.location, country, remote,
        limit: Math.max(10, Math.min(50, Number(aa.discovery?.perRunLimit) || 25)), force,
      })));
      db.kvSet('discoveryStatus', { provider: 'jobspy', query, results, at: new Date().toISOString() });
      return { ok: true, query, results };
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

module.exports = { normalizeJobSpyRecord, classifyProviderError, planner, selectBoards, defaultRunner, runWithCandidates, workerCandidates, createDiscoveryService };
