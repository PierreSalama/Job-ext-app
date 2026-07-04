'use strict';

// JAT v11 — Direct-ATS JSON board discovery.
//
// ROOT CAUSE this file fixes: discovery/index.js SUPPORTED only knows
// linkedin/indeed/glassdoor/google/zip_recruiter, so it never queries the public,
// unauthenticated JSON board APIs that Greenhouse/Lever/Ashby expose. Those three ATS
// adapters are proven high-conversion in the harness but sat STARVED (0 done / ~4 jobs
// each all-time) because nothing ever discovered jobs hosted on them. This module scans
// a curated + DB-harvested list of company board tokens directly against each ATS's own
// JSON endpoint (no scraping, no rate-limit-prone search UI) and feeds the results through
// the SAME shared intake path (ingestDiscoveredJobs) as every other discovery provider.
//
// Endpoints (public, no API key):
//   Greenhouse  GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
//   Lever       GET https://api.lever.co/v0/postings/{company}?mode=json
//   Ashby       GET https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true

const seedCompanies = require('./ats-seed-companies.json');

let log;
try { log = require('../logger').scope('ats-boards'); }
catch { log = { info: () => {}, warn: () => {}, error: () => {} }; }

const DESCRIPTION_MAX = 16000;
const ROTATION_KV_KEY = 'atsBoardsTokenIndex';
const COOLDOWN_MS = 30 * 60 * 1000;      // 30 min cooldown for a token that 429/403'd
const SPACING_MS = 2000;                  // ~2s between sequential fetches (be a good citizen)
const TOKENS_PER_TICK = 10;               // round-robin N tokens per tick
const MIN_TICK_INTERVAL_MS = 55000;       // self-throttle: never scan more than ~once/min no matter how often poked

function text(v) { return v == null ? '' : String(v).trim(); }

// ---- per-ATS fetchers -------------------------------------------------------
// Each returns an array of RAW records from the API. Never throws: a non-200 response
// or a network failure resolves to [] so a single bad token can't crash the tick.

function greenhouseUrl(token) { return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`; }
function leverUrl(company) { return `https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`; }
function ashbyUrl(token) { return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`; }

async function fetchGreenhouse(token, fetchFn = fetch) {
  const t = text(token);
  if (!t) return [];
  try {
    const res = await fetchFn(greenhouseUrl(t));
    if (!res || !res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.jobs) ? data.jobs : [];
  } catch (e) {
    log.warn(`fetchGreenhouse(${t}) failed:`, e?.message || e);
    return [];
  }
}

async function fetchLever(company, fetchFn = fetch) {
  const c = text(company);
  if (!c) return [];
  try {
    const res = await fetchFn(leverUrl(c));
    if (!res || !res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    log.warn(`fetchLever(${c}) failed:`, e?.message || e);
    return [];
  }
}

async function fetchAshby(token, fetchFn = fetch) {
  const t = text(token);
  if (!t) return [];
  try {
    const res = await fetchFn(ashbyUrl(t));
    if (!res || !res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.jobs) ? data.jobs : [];
  } catch (e) {
    log.warn(`fetchAshby(${t}) failed:`, e?.message || e);
    return [];
  }
}

// Status-aware probe used ONLY by the service layer (scanToken) so a 429/403 can trigger
// a per-token cooldown. The public fetchGreenhouse/fetchLever/fetchAshby exports above
// intentionally collapse non-200 to [] per their documented contract (tolerate errors,
// never throw) — this wrapper recovers the HTTP status without changing that contract.
async function probeStatus(ats, token, fetchFn) {
  const url = ats === 'greenhouse' ? greenhouseUrl(token) : ats === 'lever' ? leverUrl(token) : ashbyUrl(token);
  try {
    const res = await fetchFn(url);
    return { ok: !!(res && res.ok), status: res ? res.status : 0, res };
  } catch (e) {
    return { ok: false, status: 0, error: e };
  }
}

// ---- normalization ----------------------------------------------------------
// Maps ONE raw record from any of the three ATS APIs to the shared job shape consumed
// by db.upsertJob / ingestDiscoveredJobs (see server.js ingestDiscoveredJobs + the
// discovery/index.js normalizeJobSpyRecord sibling for the contract this mirrors).

function stripHtml(html) {
  return text(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const REMOTE_RX = /\bremote\b|\bwork from home\b|\bwfh\b|\banywhere\b/i;

// Positive role filter for board-API supply (see the call site in scanToken). A keyword is a
// phrase the user wants in the title (e.g. "software engineer", "full stack"); a title matches
// if it contains any one of them (case-insensitive). Empty target list = no filtering (keep all),
// so this never surprises a user who hasn't set keywords.
function titleMatchesKeywords(title, keywords) {
  const list = (keywords || []).map((k) => text(k).trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  const t = text(title).toLowerCase();
  return list.some((k) => t.includes(k));
}

// Positive LOCATION gate for board-API supply. This is the location-analogue of
// titleMatchesKeywords and exists for the SAME reason: JobSpy's LinkedIn/Indeed search is already
// location-scoped by the user's query, but a direct-ATS board returns EVERY role at the company —
// worldwide. Without this, a Canada-based user's queue floods with San Francisco / Bengaluru /
// London / EMEA postings they can't take (confirmed via a live yield probe: ~400 "applyable" jobs
// from the first 2 ticks, nearly all overseas). jobFit only EXCLUDES locations, never REQUIRES one,
// so the positive match has to live here.
//
// A job is eligible if EITHER:
//   • its location text contains one of the user's target terms (their `locations` list + `country`,
//     e.g. "toronto"/"ontario"/"canada" matches "Toronto, ON, Canada" or "Remote - Canada"); OR
//   • it's a remote role with NO country lock — strip the remote/hybrid words and generic
//     region words (north america / americas) and if nothing meaningful remains it's a plainly
//     generic remote posting (plausibly Canada-eligible). A remote role whose location still names
//     a foreign place ("United States - Remote", "EMEA") leaves a residual → NOT eligible.
// Empty target list = keep all (never surprises a user who set no location preference).
function locationEligible(job, locations, country) {
  const terms = [...(locations || []), country].map((x) => text(x).trim().toLowerCase()).filter(Boolean);
  if (!terms.length) return true;
  const loc = text(job && job.location).toLowerCase();
  if (terms.some((t) => loc.includes(t))) return true;
  if (job && job.remote) {
    const residual = loc
      .replace(/\b(remote|work from home|wfh|anywhere|worldwide|global|distributed|hybrid|on-?site|in office)\b/g, ' ')
      .replace(/\b(north america|americas|n\.?a\.?)\b/g, ' ')
      .replace(/[^a-z]+/g, ' ')
      .trim();
    if (!residual) return true;   // generic remote, no foreign country named
  }
  return false;
}

function normalizeAtsRecord(raw = {}, ats, token) {
  const a = text(ats).toLowerCase();
  const tok = text(token);
  if (!raw || typeof raw !== 'object') return null;

  if (a === 'greenhouse') {
    const id = raw.id != null ? String(raw.id) : '';
    const jobUrl = text(raw.absolute_url);
    const title = text(raw.title);
    if (!id || !jobUrl || !title) return null;
    const location = text(raw.location?.name);
    const description = stripHtml(raw.content).slice(0, DESCRIPTION_MAX);
    return {
      title,
      company: tok,
      location,
      jobUrl,
      source: 'greenhouse',
      description,
      postedAt: text(raw.updated_at) || null,
      remote: REMOTE_RX.test(location) || REMOTE_RX.test(title),
      employmentType: null,
      externalId: `greenhouse:${id}`,
      applyCapability: 'easy-apply',
    };
  }

  if (a === 'lever') {
    const id = text(raw.id);
    const jobUrl = text(raw.hostedUrl) || text(raw.applyUrl);
    const title = text(raw.text);
    if (!id || !jobUrl || !title) return null;
    const location = text(raw.categories?.location);
    const description = stripHtml(raw.descriptionPlain || raw.description).slice(0, DESCRIPTION_MAX);
    const postedAt = Number.isFinite(Number(raw.createdAt)) ? new Date(Number(raw.createdAt)).toISOString() : null;
    return {
      title,
      company: tok,
      location,
      jobUrl,
      source: 'lever',
      description,
      postedAt,
      remote: REMOTE_RX.test(location) || REMOTE_RX.test(title),
      employmentType: text(raw.categories?.commitment) || null,
      externalId: `lever:${id}`,
      applyCapability: 'easy-apply',
    };
  }

  if (a === 'ashby') {
    const id = text(raw.id);
    const jobUrl = text(raw.jobUrl) || text(raw.applyUrl);
    const title = text(raw.title);
    if (!id || !jobUrl || !title) return null;
    const location = text(raw.location);
    const description = stripHtml(raw.descriptionPlain || raw.description).slice(0, DESCRIPTION_MAX);
    return {
      title,
      company: tok,
      location,
      jobUrl,
      source: 'ashby',
      description,
      postedAt: text(raw.publishedAt) || null,
      remote: raw.isRemote === true || REMOTE_RX.test(location) || REMOTE_RX.test(title),
      employmentType: text(raw.employmentType) || null,
      externalId: `ashby:${id}`,
      applyCapability: 'easy-apply',
    };
  }

  return null;
}

// ---- DB token harvest ---------------------------------------------------------
// Grows the scan list organically: any Greenhouse/Lever/Ashby URL already seen in the
// jobs table (e.g. surfaced via LinkedIn/Indeed board results, or manually added) is
// parsed with db.classifyAts and folded into the rotation, deduped by ats+companyKey.
//
// db.js does not export a raw SQL escape hatch (`all`/`get` are internal-only), so this
// filters via the public db.listJobs({}) — the equivalent of
// `SELECT DISTINCT job_url FROM jobs WHERE job_url LIKE '%greenhouse.io%' OR ...` — by
// scanning each job's jobUrl through db.classifyAts and keeping only greenhouse/lever/ashby
// hosts with a derivable companyKey.

const ATS_HOST_RX = /(greenhouse\.io|lever\.co|ashbyhq\.com)/i;

function harvestTokensFromDb(db) {
  if (!db || typeof db.classifyAts !== 'function') return [];
  let rows = [];
  try {
    // Prefer the narrow id+job_url scan (only ATS-hosted rows, no description, no annotateAutoApply);
    // fall back to listJobs for older db shapes / test doubles.
    rows = typeof db.jobUrlsForAtsHarvest === 'function'
      ? (db.jobUrlsForAtsHarvest() || [])
      : (typeof db.listJobs === 'function' ? (db.listJobs({}) || []) : []);
  } catch (e) {
    log.warn('harvestTokensFromDb query failed:', e?.message || e);
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const url = r?.jobUrl || r?.job_url;
    if (!url || !ATS_HOST_RX.test(url)) continue;
    let cls;
    try { cls = db.classifyAts(url); } catch { continue; }
    if (!cls || !cls.ats || !cls.companyKey) continue;
    if (!['greenhouse', 'lever', 'ashby'].includes(cls.ats)) continue;
    const key = `${cls.ats}:${cls.companyKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ats: cls.ats, companyKey: cls.companyKey });
  }
  return out;
}

// ---- service ------------------------------------------------------------------

function tokenKey(entry) {
  const c = entry.ats === 'lever' ? entry.company : entry.token;
  return `${entry.ats}:${text(c || entry.companyKey)}`;
}

function mergeTokenLists(seed, harvested) {
  const seen = new Set();
  const out = [];
  for (const s of Array.isArray(seed) ? seed : []) {
    const c = s.ats === 'lever' ? (s.company || s.token) : (s.token || s.company);
    if (!s?.ats || !c) continue;
    const key = `${s.ats}:${text(c).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ats: s.ats, token: text(c) });
  }
  for (const h of Array.isArray(harvested) ? harvested : []) {
    if (!h?.ats || !h?.companyKey) continue;
    const key = `${h.ats}:${text(h.companyKey).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ats: h.ats, token: text(h.companyKey) });
  }
  return out;
}

function createAtsBoardsService({ ingestJobs, broadcast = () => {}, db, fetchFn = fetch, logger = log, spacingMs = SPACING_MS } = {}) {
  let timer = null, warmup = null, running = false, stopped = false, lastTickAt = 0;

  async function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function isCoolingDown(key) {
    if (!db || typeof db.kvGet !== 'function') return false;
    const until = Number(db.kvGet(`atsBoardsCooldown:${key}`)) || 0;
    return until > Date.now();
  }

  function setCooldown(key) {
    if (!db || typeof db.kvSet !== 'function') return;
    try { db.kvSet(`atsBoardsCooldown:${key}`, Date.now() + COOLDOWN_MS); } catch {}
  }

  function isRateLimitedError(err) {
    const s = text(err?.message || err).toLowerCase();
    return /\b429\b|\b403\b|rate.?limit|forbidden/.test(s);
  }

  async function scanToken(entry) {
    const { ats, token } = entry;
    const key = tokenKey({ ats, token });
    if (isCoolingDown(key)) {
      logger.info(`skip ${key}: cooling down`);
      return { ats, token, status: 'cooldown', found: 0, accepted: 0 };
    }

    let batch = null;
    const hasBatchApi = db && typeof db.discoveryBatchStart === 'function' && typeof db.discoveryBatchComplete === 'function';
    if (hasBatchApi) {
      try {
        batch = db.discoveryBatchStart({ provider: `${ats}-api`, source: ats, keyword: token, location: '' });
        broadcast('discovery.updated', { batch });
      } catch (e) {
        logger.warn(`discoveryBatchStart failed for ${key}:`, e?.message || e);
        batch = null;
      }
    }

    try {
      const probe = await probeStatus(ats, token, fetchFn);
      if (probe.status === 429 || probe.status === 403) {
        setCooldown(key);
        if (batch) {
          try {
            const done = db.discoveryBatchComplete(batch.id, {
              status: 'rate_limited', error: `HTTP ${probe.status}`, diagnostics: { engine: `${ats}-api`, token },
            });
            broadcast('discovery.updated', { batch: done });
          } catch {}
        }
        return { ats, token, status: 'rate_limited', found: 0, accepted: 0 };
      }
      if (probe.error) throw probe.error;

      let raw = [];
      if (probe.ok && probe.res) {
        try {
          const data = await probe.res.json();
          raw = ats === 'greenhouse' || ats === 'ashby' ? (Array.isArray(data?.jobs) ? data.jobs : []) : (Array.isArray(data) ? data : []);
        } catch (e) {
          logger.warn(`parse failed for ${key}:`, e?.message || e);
          raw = [];
        }
      }

      // POSITIVE keyword gate. Unlike JobSpy (whose search QUERY already constrains results to
      // the user's keywords), a direct-ATS board returns EVERY role at the company — so without
      // this, Stripe's ~490 postings (sales/marketing/finance/…) would all flood the queue. Keep
      // only titles matching a target keyword. jobFit() downstream still applies seniority/exclude
      // rules; this adds the positive role match that the board APIs lack. Empty list = keep all.
      // POSITIVE location gate (same rationale as the keyword gate: board APIs return roles
      // worldwide with no location scoping). Keep only Canada-local or generic-remote postings so
      // the queue isn't flooded with un-actionable overseas jobs. Empty targets = keep all.
      let targetKeywords = [], targetLocations = [], targetCountry = '';
      try {
        const aa = db.getSettings().autoApply || {};
        targetKeywords = aa.keywords || [];
        targetLocations = aa.locations || [];
        targetCountry = aa.country || '';
      } catch { /* keep all */ }
      const jobs = (Array.isArray(raw) ? raw : [])
        .map((r) => normalizeAtsRecord(r, ats, token))
        .filter(Boolean)
        .filter((j) => titleMatchesKeywords(j.title, targetKeywords))
        .filter((j) => locationEligible(j, targetLocations, targetCountry));

      let intake = { enqueued: 0, duplicates: 0, rejected: 0 };
      if (jobs.length && typeof ingestJobs === 'function') {
        intake = await ingestJobs(ats, jobs, { provider: `${ats}-api`, batchId: batch?.id || null }) || intake;
      }

      if (batch) {
        try {
          const done = db.discoveryBatchComplete(batch.id, {
            status: jobs.length ? 'ok' : 'empty',
            found: jobs.length, accepted: intake.enqueued || 0,
            duplicates: intake.duplicates || 0, rejected: intake.rejected || 0,
            diagnostics: { engine: `${ats}-api`, token },
          });
          broadcast('discovery.updated', { batch: done });
        } catch (e) { logger.warn(`discoveryBatchComplete failed for ${key}:`, e?.message || e); }
      }

      return { ats, token, status: 'ok', found: jobs.length, accepted: intake.enqueued || 0 };
    } catch (e) {
      logger.warn(`scanToken(${key}) failed:`, e?.message || e);
      if (isRateLimitedError(e)) setCooldown(key);
      if (batch) {
        try {
          const done = db.discoveryBatchComplete(batch.id, {
            status: isRateLimitedError(e) ? 'rate_limited' : 'failed',
            error: text(e?.message || e), diagnostics: { engine: `${ats}-api`, token },
          });
          broadcast('discovery.updated', { batch: done });
        } catch {}
      }
      return { ats, token, status: 'error', error: text(e?.message || e), found: 0, accepted: 0 };
    }
  }

  async function runTick({ force = false } = {}) {
    if (running) return { ok: false, reason: 'already-running' };
    // SELF-GATE on enablement (mirrors discovery/index.js runTick). This is what lets main.js
    // start() us UNCONDITIONALLY at boot: while auto-apply is off we just no-op. Without it, the
    // periodic timer only ever started if auto-apply was ALREADY enabled at launch — but the real
    // usage is launch-with-it-off then toggle-on in the dashboard, so this feed NEVER ran once
    // (0 '%-api' batches / 0 atsBoards rotation-kv all-time) and Greenhouse/Lever/Ashby stayed
    // starved. A forced/manual run bypasses the gate.
    let aa = {};
    try { aa = db.getSettings().autoApply || {}; } catch {}
    if (!force && (!aa.enabled || aa.discovery?.enabled === false || aa.discovery?.atsBoardsEnabled === false)) {
      return { ok: false, reason: 'disabled' };
    }
    // SELF-THROTTLE: the idle-watchdog (main.js) and the 60s timer can both poke us within the same
    // minute — never scan more than ~once/interval no matter how often called. Forced runs bypass.
    if (!force && (Date.now() - lastTickAt) < MIN_TICK_INTERVAL_MS) return { ok: false, reason: 'throttled' };
    lastTickAt = Date.now();
    running = true;
    try {
      const harvested = harvestTokensFromDb(db);
      const merged = mergeTokenLists(seedCompanies, harvested);
      if (!merged.length) return { ok: false, reason: 'no-tokens' };

      const startIdx = (db && typeof db.kvGet === 'function') ? (Number(db.kvGet(ROTATION_KV_KEY)) || 0) : 0;
      const n = Math.min(TOKENS_PER_TICK, merged.length);
      const batch = [];
      for (let i = 0; i < n; i++) batch.push(merged[(startIdx + i) % merged.length]);
      const nextIdx = (startIdx + n) % merged.length;
      if (db && typeof db.kvSet === 'function') { try { db.kvSet(ROTATION_KV_KEY, nextIdx); } catch {} }

      const results = [];
      for (let i = 0; i < batch.length; i++) {
        if (stopped) break;
        // Per-token guard: a single failing token must never crash the tick or the loop.
        try { results.push(await scanToken(batch[i])); }
        catch (e) { logger.warn('scanToken threw unexpectedly:', e?.message || e); results.push({ ...batch[i], status: 'error', error: text(e?.message || e) }); }
        if (i < batch.length - 1 && !stopped) await sleep(spacingMs);
      }

      const totalFound = results.reduce((s, r) => s + (r.found || 0), 0);
      const totalAccepted = results.reduce((s, r) => s + (r.accepted || 0), 0);
      logger.info(`ats-boards tick: scanned ${results.length} tokens, found ${totalFound}, accepted ${totalAccepted}`);
      return { ok: true, scanned: results.length, found: totalFound, accepted: totalAccepted, results };
    } finally {
      running = false;
    }
  }

  function start({ intervalMs = 300000, warmupMs = 20000 } = {}) {
    stop();
    stopped = false;
    warmup = setTimeout(() => runTick().catch((e) => logger.warn('warmup failed', e?.message || e)), warmupMs);
    timer = setInterval(() => runTick().catch((e) => logger.warn('tick failed', e?.message || e)), intervalMs);
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    if (warmup) clearTimeout(warmup);
    timer = null; warmup = null;
  }

  return { start, stop, runTick, isRunning: () => running };
}

module.exports = {
  fetchGreenhouse,
  fetchLever,
  fetchAshby,
  normalizeAtsRecord,
  titleMatchesKeywords,
  locationEligible,
  harvestTokensFromDb,
  createAtsBoardsService,
  mergeTokenLists,
};
