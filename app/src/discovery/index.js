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
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}

async function defaultRunner(request, timeoutMs = 90000) {
  let last = null;
  for (const candidate of workerCandidates()) {
    try { return await runProcess(candidate, request, timeoutMs); }
    catch (e) { last = e; if (!/enoent|not found/i.test(text(e?.message))) throw e; }
  }
  throw last || new Error('JobSpy worker unavailable');
}

function createDiscoveryService({ ingestJobs, broadcast = () => {}, runner = defaultRunner } = {}) {
  let timer = null, warmup = null, running = false, stopped = false;

  async function searchBoard({ source, keyword, location, limit, hoursOld = 72, force = false }) {
    const batch = db.discoveryBatchStart({ provider: 'jobspy', source, keyword, location });
    broadcast('discovery.updated', { batch });
    try {
      const result = await runner({ source, keyword, location, limit, hours_old: hoursOld, country: 'Canada' }, 90000);
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
    if (!force && db.queueList({ state: 'queued' }).length >= (aa.discovery?.refillBelow || 3)) return { ok: false, reason: 'queue-full' };
    const idx = Number(db.kvGet('discoveryPlannerIndex')) || 0;
    const query = planner(settings, idx);
    if (!query) return { ok: false, reason: 'no-keywords' };
    db.kvSet('discoveryPlannerIndex', query.nextIndex);
    const boards = (aa.boards || ['linkedin', 'indeed']).map((b) => text(b).toLowerCase().replace(/\s+/g, '_')).filter((b) => SUPPORTED.has(b));
    if (!boards.length) return { ok: false, reason: 'no-supported-boards' };
    const boardIndex = Number(db.kvGet('discoveryBoardIndex')) || 0;
    const selectedBoards = [];
    for (let i = 0; i < Math.min(3, boards.length); i++) selectedBoards.push(boards[(boardIndex + i) % boards.length]);
    db.kvSet('discoveryBoardIndex', (boardIndex + selectedBoards.length) % boards.length);
    running = true;
    try {
      const results = await Promise.all(selectedBoards.map((source) => searchBoard({
        source, keyword: query.keyword, location: query.location,
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

module.exports = { normalizeJobSpyRecord, classifyProviderError, planner, defaultRunner, createDiscoveryService };
