// JAT v11 — HTTP server (REST + SSE) on 127.0.0.1.
//
// Security model (fixes the v10 hole where ANY web page could read/delete the DB):
//  • Every route except GET /health and POST /pair requires the per-install
//    token (header X-JAT-Token, or ?token= for the EventSource /stream route).
//  • Token is generated at first run and stored in the kv table. The Electron
//    renderer receives it via preload IPC; the extension gets it once through
//    the /pair flow, which pops a native consent dialog in the app.
//  • Host header must be localhost/127.0.0.1 (DNS-rebinding guard).
//  • CORS: we echo the Origin and allow X-JAT-Token — actual access control is
//    the token, not CORS. Bodies are capped at 15 MB (base64 document uploads).

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const provider = require('./ai/provider');
const prompts = require('./ai/prompts');
const codexProvider = require('./ai/codex');
const { extractText } = require('./ai/extract');
const hardware = require('./hardware');
const localsetup = require('./localsetup');
const fit = require('./fit');
const { scope } = require('./logger');

const log = scope('server');

const MAX_BODY = 15 * 1024 * 1024;
const HOST_RX = /^(localhost|127\.0\.0\.1)(:\d+)?$/i;
// With LAN remote access ON, also accept PRIVATE-RANGE host headers (the LAN IP another machine
// on the same network dials). Public hostnames stay rejected — the rebinding guard's whole point.
const LAN_HOST_RX = /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?$/;
function hostAllowed(hostHeader) {
  if (HOST_RX.test(hostHeader)) return true;
  try { if (db.getSettings().server.remoteAccess && LAN_HOST_RX.test(hostHeader)) return true; } catch {}
  return false;
}

let server = null;
let sseClients = new Set();
let pairAttempts = new Map();   // origin → { count, firstAt } for the /pair rate-limit
// Recently paired clients (in-memory, newest-first, capped) — lets the setup script confirm the
// Firefox extension actually connected (a moz-extension:// origin shows up here after it loads).
let pairedClients = [];
function recordPairedClient(info) {
  const entry = { client: info.client || '', origin: info.origin || '', at: Date.now() };
  pairedClients = [entry, ...pairedClients.filter((c) => c.origin !== entry.origin)].slice(0, 20);
}
let opts = {};   // { getVersion, userDataDir, confirmPair(info)→Promise<bool>, notify(type,payload) }

// ---------- token ----------
function getToken() {
  let t = db.kvGet('authToken');
  if (!t) {
    t = crypto.randomBytes(32).toString('hex');
    db.kvSet('authToken', t);
  }
  return t;
}

function authed(req, parsed) {
  const header = req.headers['x-jat-token'];
  const q = parsed.searchParams.get('token');
  const token = getToken();
  const candidate = header || q || '';
  return candidate.length === token.length &&
    crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
}

// ---------- helpers ----------
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(data);
}

// Read a raw request body as UTF-8 text, capped at `max` bytes (for the setup-report ingest).
function readBodyText(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error('invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// ---------- SSE ----------
function broadcast(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data || {})}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// A pairing request must come from a browser extension, the desktop renderer, or
// localhost — never a remote web page (blocks the CSRF-from-evil.com vector). An empty
// Origin (some non-browser clients / file:// renderer) is allowed; the user still has to
// confirm the in-app prompt.
function pairOriginAllowed(origin) {
  if (!origin) return true;
  return /^(chrome-extension|moz-extension|chrome|edge|file):\/\//i.test(origin)
    || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

// Secrets never leave the process. db.getSettings() returns DECRYPTED values for internal
// use; these blank them for any client-facing response (GET /settings, GET /export).
function stripSettingSecrets(s) {
  if (s && s.ai && s.ai.claude) s.ai.claude.apiKey = '';
  if (s && s.ai && s.ai.chatgpt) s.ai.chatgpt.apiKey = '';
  if (s && s.gmail) s.gmail.clientSecret = '';
  return s;
}
function publicSettings() {
  const s = JSON.parse(JSON.stringify(db.getSettings()));
  const secretsPresent = {
    claudeKey: !!(s.ai && s.ai.claude && s.ai.claude.apiKey),
    chatgptKey: !!(s.ai && s.ai.chatgpt && s.ai.chatgpt.apiKey),
    gmailSecret: !!(s.gmail && s.gmail.clientSecret),
  };
  return { settings: stripSettingSecrets(s), secretsPresent };
}

// ---------- auto-apply pacing ----------
// Relevance: classify a title's seniority and skip roles above the user's max or
// matching an excluded keyword (so a junior dev doesn't get Senior/Lead/Manager/Game
// roles queued). 1=entry 2=mid 3=senior 4=lead+.
function jobLevel(title) {
  const t = String(title || '').toLowerCase();
  // level 4 = lead/management. "lead" only as a real eng-lead title ("Tech Lead",
  // "Lead Software Engineer") — NOT "Lead Generation" or "...at Principal Co".
  if (/\b(staff|principal|architect|manager|mgr|director|head of|vp|vice president|chief)\b/.test(t)
      || /\b(?:tech|technical|team|engineering|dev|development|squad)\s+lead\b/.test(t)
      || /\blead\s+(?:software|develop|engineer|back|front|full|data|ml|devops|sdet|qa|cloud|platform)/.test(t)) return 4;
  if (/\b(senior|sr\.?|sr)\b/.test(t)) return 3;
  if (/\b(intern(ship)?|co-?op|junior|jr\.?|entry[- ]?level|new ?grad|graduate|apprentice|trainee|student)\b/.test(t)) return 1;
  // UNLABELLED titles ("Software Engineer", "Network Technician") carry no seniority
  // signal — treat them as entry-eligible (1) so a sensible cap (entry/mid) doesn't
  // silently nuke perfectly applyable jobs. Only EXPLICIT senior/lead/staff get capped.
  return 1;
}
const SENIORITY_CAP = { any: 99, senior: 3, mid: 2, entry: 1 };
// Academic/research roles (postdoc, PhD-track, faculty, research fellow) are never a
// fit for a software-dev candidate — they require a doctorate. Skip them outright
// (EN + FR, since LinkedIn QC postings are bilingual) so they never reach apply.
const ACADEMIC_RE = /\b(post-?doc|postdoctoral|post-?doctorale|ph\.?\s?d|doctorate|doctoral|doctorant|research fellow(ship)?|bourse de recherche|bourse postdoctorale|professor|professeur|faculty|tenure[- ]track|lecturer|chercheur|chercheuse|ma[iî]tre de conf)\b/i;
// Token-level keyword matching for the positive relevance gate, tolerant of the synonyms every job
// board uses interchangeably. A strict all-tokens-must-appear rule looked right in tests but
// over-filtered live: Pierre's keyword "frontend developer" missed the posting "Frontend Engineer",
// and "web developer" missed "Web Programmer" — 36 of 75 queued jobs were being dropped, several of
// them real matches. Developer/engineer/programmer are the SAME ROLE NOUN in postings, and
// front end / front-end / frontend are the same word, so normalize both before comparing.
// French forms matter on Canadian boards — a Montreal posting reads "Développeur(euse) Front-End",
// which is the same job as "Frontend Developer" and was being filtered out as off-target.
const ROLE_SYNONYMS = new Map([
  ['engineer', 'developer'], ['programmer', 'developer'], ['dev', 'developer'], ['coder', 'developer'],
  ['developpeur', 'developer'], ['developpeuse', 'developer'], ['programmeur', 'developer'],
  ['ingenieur', 'developer'], ['ingenieure', 'developer'],
  ['gestionnaire', 'manager'], ['chef', 'manager'], ['directeur', 'manager'],
  ['projet', 'project'], ['projets', 'project'],
]);
// Strip accents so "développeur" / "ingénieur" reach the synonym table at all.
const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
function normalizeTitleText(s) {
  return stripAccents(String(s || '')).toLowerCase()
    .replace(/\bfront[\s-]?end\b/g, 'frontend')
    .replace(/\bback[\s-]?end\b/g, 'backend')
    .replace(/\bfull[\s-]?stack\b/g, 'fullstack');
}
const FIT_STOPWORDS = new Set(['and', 'or', 'the', 'a', 'an', 'of', 'for', 'in', 'to', 'with', 'at', 'on', 'sr', 'jr', 'senior', 'junior']);
function fitTokens(s) {
  return normalizeTitleText(s).split(/[^a-z0-9+#]+/)
    .filter((x) => x && !FIT_STOPWORDS.has(x))
    .map((x) => ROLE_SYNONYMS.get(x) || x);
}
// Every significant token of the keyword must appear in the title (order-independent, synonym-aware).
function keywordTokensMatch(keyword, title) {
  const kt = fitTokens(keyword);
  if (!kt.length) return false;
  const tt = new Set(fitTokens(title));
  return kt.every((x) => tt.has(x));
}

function jobFit(jobOrTitle, aa) {
  const job = (jobOrTitle && typeof jobOrTitle === 'object') ? jobOrTitle : { title: jobOrTitle };
  const title = job.title || '';
  const cap = SENIORITY_CAP[aa && aa.seniorityMax] ?? 99;
  if (jobLevel(title) > cap) return { ok: false, reason: `above your level cap (${aa.seniorityMax})` };
  if (ACADEMIC_RE.test(String(title || ''))) return { ok: false, reason: 'academic/research role (postdoc/PhD/faculty) — off-target' };
  const t = String(title || '').toLowerCase();
  for (const kw of (aa && aa.excludeKeywords) || []) {
    const k = String(kw || '').trim().toLowerCase();
    if (!k) continue;
    // Single tokens match WHOLE-WORD so 'sales' no longer nukes 'Salesforce Developer' and
    // 'lead' doesn't hit 'Leadership Program'; multi-word phrases ('account executive') stay
    // plain substrings (already specific enough). Deliberately TITLE-ONLY — matching the
    // description would over-exclude on words like 'senior'/'manager'/'lead' that appear in
    // almost every JD body, silently killing legitimate eng roles.
    const hit = /\s/.test(k)
      ? t.includes(k)
      : new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t);
    if (hit) return { ok: false, reason: `excluded keyword "${k}"` };
  }
  const company = String(job.company || '').toLowerCase();
  for (const kw of (aa && aa.excludeCompanies) || []) {
    const k = String(kw || '').trim().toLowerCase();
    if (k && company.includes(k)) return { ok: false, reason: `excluded company "${k}"` };
  }
  const location = String(job.location || '').toLowerCase();
  for (const kw of (aa && aa.excludeLocations) || []) {
    const k = String(kw || '').trim().toLowerCase();
    if (k && location.includes(k)) return { ok: false, reason: `excluded location "${k}"` };
  }
  // POSITIVE RELEVANCE GATE (opt-in via autoApply.requireKeywordMatch).
  //
  // Everything above is NEGATIVE-only: a posting passes unless it is explicitly banned. Keywords
  // were used solely to BUILD search queries — nothing ever re-checked what came back. So any job
  // the search dragged in that wasn't on an exclude list got applied to. Live 2026-07-25 on Ashraf's
  // machine: 36 of 42 queued jobs were off-field — "Call center agent", "Brand Ambassador",
  // "Emergency Communications Nurse", "iOS Developer", Stripe payments roles — for a telecom /
  // structured-cabling project manager. Banning each bad word is whack-a-mole (a Stripe finance
  // title still slipped through a 80-entry exclude list), so require a POSITIVE match instead.
  //
  // A keyword matches when ALL of its significant tokens appear in the title (order-independent),
  // or, for a single-token keyword, that token appears whole-word. Strict and predictable: to widen
  // the net you add a keyword, rather than guessing which junk word to ban next.
  if (aa && aa.requireKeywordMatch) {
    const kws = (aa.keywords || []).map((k) => String(k || '').trim().toLowerCase()).filter(Boolean);
    if (kws.length) {
      const matched = kws.some((k) => t.includes(k) || keywordTokensMatch(k, t));
      if (!matched) return { ok: false, reason: 'off-target: title matches none of your keywords' };
    }
  }
  return { ok: true };
}

// Fix 5(b) + CONFIRMED ROOT CAUSE: is a discovered posting plausibly Easy-Apply, given
// easyApplyOnly? When easyApplyOnly is OFF this is always true (behaviour unchanged). When ON:
//
//  • NON-LinkedIn boards have no real Easy-Apply concept → drop (unchanged).
//  • LinkedIn is the ONLY board with an Easy-Apply filter, BUT the SOURCE of the LinkedIn
//    result matters. JobSpy CANNOT read LinkedIn's Easy-Apply flag (discovery/index.js sets
//    applyCapability:'unknown'), so it scrapes the UNFILTERED LinkedIn search and ingests
//    ~all results — most EXTERNAL ("Apply ↗" to the company, "Responses managed off
//    LinkedIn"). Those flooded the queue and the executor then burned ~20s/job skipping them.
//    So in Easy-Apply-only mode we ONLY keep LinkedIn results that are KNOWN/likely Easy
//    Apply: applyCapability 'easy-apply' (stamped by the extension's f_AL=true scrape path —
//    see content/discover.js) is kept; 'unknown' or 'external' (the JobSpy LinkedIn flood) is
//    DROPPED at ingest. A record with NO applyCapability at all is treated as 'unknown'.
//
// Pure + exported for tests. Back-compat: callable as (source, easyApplyOnly) — when no job
// record is passed the capability is treated as absent ('unknown'), so a bare LinkedIn call
// with easyApplyOnly ON is now (correctly) rejected unless the record proves Easy Apply.
// `source` falls back to the record's own source so the browser-fallback / ingest-endpoint
// path is covered too.
// ANY new discovery source must be added to this allowlist or it is SILENTLY DROPPED
// under easyApplyOnly (rejected++ in ingestDiscoveredJobs, no error, no log) — this bit
// us once already with Lever/Greenhouse/Ashby (0 done / ~4 jobs each all-time) before
// they were added below.
function easyApplyIngestEligible(source, easyApplyOnly, job = null) {
  if (!easyApplyOnly) return true;
  const src = String(source || (job && job.source) || '').toLowerCase();
  // Easy-Apply-only mode: KEEP LinkedIn AND Indeed (both have a native in-board apply: LinkedIn
  // Easy Apply, Indeed Indeed-Apply → smartapply). DROP pure aggregators (Glassdoor/Google/Zip).
  // We do NOT gate on a capability flag: discovery is JobSpy-only (applyCapability:'unknown'),
  // so a capability gate would drop EVERY job → empty queue → worse than the flood. Instead the
  // EXECUTOR fast-skips a posting that's external/off-board in ~35ms (detectLinkedInExternalPosting
  // for LinkedIn; the Indeed-host external fast-skip for Indeed) and terminal-skips it (non-retriable),
  // so the queue stays fed and the run blazes past externals to the real Easy-Apply/Indeed-Apply jobs.
  //
  // Greenhouse/Lever/Ashby (ats-boards.js) are ALSO genuinely in-board drivable — their postings
  // are fetched directly from the ATS's own JSON API and every result IS the company's own native
  // apply form (no board/aggregator layer to bounce off of), so they belong in the same allowlist.
  return src === 'linkedin' || src === 'indeed' || src === 'greenhouse' || src === 'lever' || src === 'ashby';
}

// One intake path for every discovery provider. JobSpy and the browser fallback
// therefore share relevance, punishment, ranking, dedup and provenance behavior.
function ingestDiscoveredJobs(source, jobs, { providerName = 'browser', batchId = null } = {}) {
  const s = db.getSettings().autoApply;
  const easyApplyOnly = s.easyApplyOnly !== false;
  let enqueued = 0, rejected = 0, punished = 0, duplicates = 0;
  const ranked = [];
  for (const jd of (Array.isArray(jobs) ? jobs : []).slice(0, 100)) {
    if (!jd || !jd.jobUrl) { rejected++; continue; }
    const verdict = jobFit(jd, s);
    if (!verdict.ok) { rejected++; continue; }
    // Fix 5(b) + CONFIRMED ROOT CAUSE: in Easy-Apply-only mode, drop postings that are not
    // known/likely Easy Apply — non-LinkedIn boards AND the JobSpy LinkedIn 'unknown'/'external'
    // flood — so they never dominate the queue (they'd only be skipped at dispatch anyway).
    if (!easyApplyIngestEligible(source || jd.source, easyApplyOnly, jd)) { rejected++; continue; }
    const probe = { id: null, title: jd.title, company: jd.company, jobUrl: jd.jobUrl, location: jd.location, source: source || jd.source || null };
    let isP = false, rank = 0;
    try { const pid = db.resolveProfileId(probe.source); isP = db.isPunished(probe, pid); rank = isP ? -1 : db.rankJob(probe, pid); } catch {}
    if (isP) { punished++; continue; }
    ranked.push({ jd, rank });
  }
  ranked.sort((a, b) => b.rank - a.rank);
  for (const { jd } of ranked) {
    const result = db.transaction(() => {
      const up = db.upsertJob({
        externalId: jd.externalId, source: source || jd.source || null,
        title: jd.title, company: jd.company, location: jd.location,
        jobUrl: jd.jobUrl, description: jd.description || '',
        compensation: jd.salary ? JSON.stringify(jd.salary) : (jd.compensation || ''),
        employmentType: jd.employmentType || '', status: 'started', tags: ['auto-apply'],
      });
      if (up.action === 'created') {
        db.recordEvent({ jobId: up.job.id, type: 'created', source: 'auto-apply', summary: `Discovered via ${providerName}`, data: { provider: providerName, batchId } });
      }
      if (batchId) db.discoveryRecordJob({
        jobId: up.job.id, batchId, provider: providerName, source: source || jd.source || 'unknown',
        rawUrl: jd.jobUrl, applyCapability: jd.applyCapability || 'unknown',
      });
      return { action: up.action, task: db.queueAdd(up.job.id, { mode: s.mode }) };
    });
    if (result.task) enqueued++;
    else duplicates++;
  }
  broadcast('queue.updated', { action: 'discover', provider: providerName, batchId });
  broadcast('jobs.updated', { action: 'discover', provider: providerName, batchId });
  return { enqueued, rejected, punished, duplicates };
}

function withinWindow(settings) {
  if (settings.runAnytime !== false) return true;                  // 24/7 (default) — ignore the window
  if (!settings.windowStart || !settings.windowEnd) return true;   // no window = any time
  const [sh, sm] = String(settings.windowStart).split(':').map(Number);
  const [eh, em] = String(settings.windowEnd).split(':').map(Number);
  if (![sh, eh].every(Number.isFinite)) return true;   // unparseable window → 'any time' (the default), never a silent dead-stop
  const nowD = new Date();
  const mins = nowD.getHours() * 60 + nowD.getMinutes();
  return mins >= sh * 60 + (sm || 0) && mins <= eh * 60 + (em || 0);
}

// Decide whether a task may run now. Returns { task, context } or { wait }.
// force=true (the dashboard "Test: apply now" button) skips the window/cap/gap
// pacing so the user can shake it out immediately — but still needs enabled.
async function queueNext(force = false) {
  // Free any pool slot held by a task stuck 'running'/'scheduled' (SW eviction / hung
  // tab) so a single stall can't freeze the whole pipeline — checked every dispatch tick.
  try { db.reconcileStaleRunning({ olderThanMinutes: 8 }); } catch {}
  const s = db.getSettings().autoApply;
  // The extension now runs each worker in its OWN dedicated window (one active/visible,
  // un-throttled tab per window — see acquireApplyWindow), so parallelism is safe again.
  // Clamp to a sane max of 3 (more windows = more flag risk + machine load).
  const rawConcurrency = Math.max(1, Math.min(5, Number(s.concurrency) || 1));
  // SAFETY KILL-SWITCH (v11.46.0). In live testing, >1 parallel apply WINDOWS fought for the
  // foreground (multiple windows + the front-to-hydrate net each yanking its window to the front)
  // and FROZE the machine / locked mouse input — the user couldn't even Stop it. Until that
  // focus-steal is made safe for >1 window, FORCE SERIAL regardless of the stored concurrency,
  // gated behind an explicit, default-OFF `parallelApplySafe` flag. The user's concurrency setting
  // is preserved (not reset) but stays INERT until parallel is proven safe again. See [freeze RCA].
  const concurrency = s.parallelApplySafe === true ? rawConcurrency : 1;
  // PER-SITE cap: how many applies may run concurrently on ONE siteKey. All LinkedIn jobs
  // share siteKey 'ats:linkedin', so this is the real LinkedIn parallelism. Default 2 (ban-safe);
  // clamped 1..concurrency. This REPLACES the old boolean "one-per-site" guard that collapsed the
  // whole LinkedIn-dominant queue to serial-of-1 even at concurrency=3. (Inert while serial-forced.)
  const perSiteCap = Math.max(1, Math.min(concurrency, Number(s.perSiteConcurrency) || 2));
  if (!s.enabled) return { task: null, reason: 'disabled', concurrency };
  if (!force) {
    if (!withinWindow(s)) return { task: null, reason: 'outside-window', concurrency };
    const stats = db.queueRunStats();
    if (stats.doneDay >= s.maxPerDay) return { task: null, reason: 'daily-cap', concurrency };
    if (stats.doneHour >= s.maxPerHour) return { task: null, reason: 'hourly-cap', concurrency };
    // SOFT DAILY CAP (anti-ban whole-session shaping): once we've DISPATCHED dailyCap
    // applies (submits + attempts) in the rolling 24h, pause until the window rolls — so an
    // aggressive maxPerHour can't drive a marathon session that throttles/bans the account.
    // Configurable; dailyCap<=0 disables it.
    const dailyCap = Number(s.dailyCap) || 0;
    if (dailyCap > 0 && stats.dispatchedDay >= dailyCap) {
      return { task: null, reason: 'daily-soft-cap', dailyCap, dispatchedDay: stats.dispatchedDay, concurrency };
    }
    // Pace launches from when the PREVIOUS application STARTED (not finished) —
    // otherwise a self-driving loop re-arms the gap on every completion and
    // collapses back to one-per-alarm-tick. The job's own runtime usually
    // absorbs the gap, so serial flows continuously; parallel spaces its starts.
    // SERIAL (concurrency<=1): single global start clock, as before. PARALLEL (concurrency>1):
    // skip the global clock here — pacing is done PER SITE in the candidate loop below, so two
    // DIFFERENT sites can start at once and a single site still can't burst.
    if (concurrency <= 1 && stats.lastStart) {
      const baseGap = s.minGapMinutes + Math.random() * Math.max(0, s.maxGapMinutes - s.minGapMinutes);
      const eligibleAt = new Date(stats.lastStart).getTime() + baseGap * 60000;
      if (Date.now() < eligibleAt) {
        return { task: null, reason: 'gap', nextEligibleAt: new Date(eligibleAt).toISOString(), concurrency };
      }
    }
  }

  let queued = db.queueList({ state: 'queued' });
  if (!queued.length && !force) {
    // Self-heal: when the queue drains, pull stale retriable failures back in (20-min
    // cooldown, capped attempts) so the pool keeps working even between discovery
    // combos — the engine no longer sits idle on a transient failure pile.
    if (db.retryStaleQueue({ olderThanMinutes: 20, maxAttempts: 4, limit: 10 })) {
      queued = db.queueList({ state: 'queued' });
    }
  }
  if (!queued.length) return { task: null, reason: 'empty', concurrency };
  // Oldest-first (the list is DESC). Retire dead tasks instead of opening a tab for
  // them: a job can become 'submitted' (passive capture / Gmail / applied-sync /
  // manual apply) or be deleted AFTER it was queued, but the task stays 'queued'.
  // P7: drop PUNISHED jobs (skipped 'punished'), then prefer the highest-rankJob
  // candidate among what's left (reward history ↑, geo/staleness ↓) — ADDITIVE: the
  // existing dead-task retirement + dispatch path is unchanged.
  // A1: when LinkedIn's Easy Apply daily cap is cooled down, PIVOT — don't dispatch
  // LinkedIn Easy-Apply jobs (we'd waste the cooldown), but keep flowing external/
  // company-site jobs. Purely additive: only filters while cooled down. We LEAVE the
  // LinkedIn tasks queued (not failed/skipped) so they resume after the cooldown.
  let cooledDown = false;
  try { cooledDown = db.easyApplyCooledDown(); } catch {}
  let easyApplyDeferred = false;
  let hostDeferred = false;
  let siteDeferred = false;
  let siteGapDeferred = false;
  let siteGapNextAt = null;
  // PER-SITE in-flight COUNT (not a boolean) + per-site last-start clock — drives the cap +
  // pacing below. Recomputed every /queue/next (queueActiveSiteKeys reads scheduled+running, so
  // a freshly-scheduled task is counted, and queueNext returns one task per call → no over-pick).
  const siteKeyCounts = new Map();
  let siteLastStart = {};
  if (!force && concurrency > 1) {
    try { for (const x of db.queueActiveSiteKeys()) { if (x.siteKey) siteKeyCounts.set(x.siteKey, (siteKeyCounts.get(x.siteKey) || 0) + 1); } } catch {}
    try { siteLastStart = db.lastStartBySiteKey({ minutes: 30 }); } catch {}
  }
  const candidates = [];
  for (let i = queued.length - 1; i >= 0; i--) {
    const t = queued[i];
    const j = db.getJob(t.jobId);
    if (!j || !j.jobUrl) { db.queuePatch(t.id, { state: 'failed', lastError: 'job missing or has no URL' }); continue; }
    if (j.status === 'submitted') {
      db.queuePatch(t.id, { state: 'skipped', lastError: 'already applied' });
      broadcast('queue.updated', { taskId: t.id, state: 'skipped' });
      continue;
    }
    if (s.easyApplyOnly !== false && String(j.source || '').toLowerCase() === 'glassdoor') {
      db.queuePatch(t.id, { state: 'skipped', lastError: 'Glassdoor is skipped in Easy-Apply-only mode (no reliable Easy Apply badge)' });
      broadcast('queue.updated', { taskId: t.id, state: 'skipped' });
      continue;
    }
    let punished = false;
    try { punished = db.isPunished(j, db.resolveProfileId(j.source)); } catch {}
    if (punished) {
      db.queuePatch(t.id, { state: 'skipped', lastError: 'punished' });
      broadcast('queue.updated', { taskId: t.id, state: 'skipped' });
      continue;
    }
    // RE-APPLY the relevance gate at dispatch (not just at ingest). excludeCompanies/
    // excludeKeywords/seniority can be edited AFTER a job was queued; without this re-check the
    // old queue keeps dispatching jobs the user just excluded (e.g. ~140 staffing reposters).
    // This makes filter edits retroactive — they purge the standing queue on the next pump.
    const fitNow = jobFit(j, s);
    if (!fitNow.ok) {
      db.queuePatch(t.id, { state: 'skipped', lastError: `filtered: ${fitNow.reason}` });
      broadcast('queue.updated', { taskId: t.id, state: 'skipped' });
      continue;
    }
    if (cooledDown && !db.easyApplyEligible(j)) { easyApplyDeferred = true; continue; }
    // NOT-BEFORE DEFERRAL: a queued task whose scheduled_at is in the FUTURE is waiting out a
    // transient site condition (the extension's host circuit breaker sets this when a host starts
    // serving a Cloudflare/verification wall). Leave it QUEUED and take the next candidate, the
    // same way the Easy-Apply cooldown defers instead of burning the job.
    //
    // Why this exists: the breaker used to PATCH those tasks to state 'skipped', which is terminal
    // and non-retriable. Live 2026-07-20, Indeed began serving a challenge and the breaker
    // destroyed 40+ queued jobs in ten minutes, all with attempts=0 -- never even attempted --
    // draining the Indeed queue from 60 to 16. A transient wall must never permanently discard a
    // job. Normal queued tasks carry a past scheduled_at, so this is a no-op for them.
    if (!force && t.scheduledAt && Date.parse(t.scheduledAt) > Date.now()) { hostDeferred = true; continue; }
    const siteKey = db.taskSiteKey(j);
    if (!force && concurrency > 1 && siteKey) {
      // (1) PER-SITE CAP — never run more than perSiteCap applies on one site at once.
      if ((siteKeyCounts.get(siteKey) || 0) >= perSiteCap) { siteDeferred = true; continue; }
      // (2) PER-SITE GAP — space starts WITHIN a site (anti-throttle/ban) without serializing
      // different sites. gapMin = baseGap/perSiteCap so the site fills to its cap over one window.
      const last = siteLastStart[siteKey];
      if (last) {
        const baseGap = s.minGapMinutes + Math.random() * Math.max(0, s.maxGapMinutes - s.minGapMinutes);
        const eligibleAt = new Date(last).getTime() + (baseGap / perSiteCap) * 60000;
        if (Date.now() < eligibleAt) {
          siteGapDeferred = true;
          if (!siteGapNextAt || eligibleAt < siteGapNextAt) siteGapNextAt = eligibleAt;
          continue;
        }
      }
    }
    candidates.push({ t, j, order: i });   // order = oldest-first index (lower = older)
  }
  // Nothing dispatchable BUT we held back LinkedIn jobs for the cooldown → tell the pump
  // why it's idling (it isn't out of work; it's waiting out the Easy-Apply cap).
  if (!candidates.length && easyApplyDeferred) return { task: null, reason: 'easyapply-cooldown', concurrency };
  // Held back for a host serving a verification wall — idling on purpose, not out of work.
  if (!candidates.length && hostDeferred) return { task: null, reason: 'host-cooldown', concurrency };
  // Per-site gap wins over site-busy as the idle reason so the pump's gapTimer wakes it exactly
  // when the next same-site start becomes eligible (bounded), instead of idling to the next alarm.
  if (!candidates.length && siteGapDeferred) return { task: null, reason: 'gap', nextEligibleAt: new Date(siteGapNextAt).toISOString(), concurrency };
  if (!candidates.length && siteDeferred) return { task: null, reason: 'site-busy', concurrency };
  if (!candidates.length) return { task: null, reason: 'empty', concurrency };
  // Rank candidates: highest rankJob first; ties broken by oldest-first (stable original order).
  for (const c of candidates) { try { c.rank = db.rankJob(c.j, db.resolveProfileId(c.j.source)); } catch { c.rank = 0; } }
  candidates.sort((a, b) => (b.rank - a.rank) || (a.order - b.order));
  let task = candidates[0].t, job = candidates[0].j;
  if (!task) return { task: null, reason: 'empty', concurrency };

  // Honour the explicit picks from the Auto-apply page; fall back to the
  // source-matched profile, then to one DERIVED from learned answers (so it
  // works even with no saved profile), then the active résumé.
  let profile = (s.profileId && db.listProfiles().find((p) => p.id === s.profileId))
    || db.profileForSource(job.source);
  // The REAL profile whose memory this job reads/writes (resolveProfileId never
  // returns 'derived'); the executor scopes its qa lookups + answer-recording to it.
  const profileId = (profile && profile.id && profile.id !== 'derived') ? profile.id : db.resolveProfileId(job.source);
  if (!profile) profile = db.deriveProfileFromLearned(profileId);
  const resume = (s.resumeDocId && db.getDocument(s.resumeDocId, { withText: true })) || db.defaultDocument('resume');
  const harvested = db.profileFieldList(profileId).filter((f) => f.value);
  const siteCfg = s.sites?.[String(job.source || '').toLowerCase()] || {};
  let mode = siteCfg.mode || task.mode || s.mode;

  // "Watch & Teach the next application" armed from the dashboard? Make THIS dispatch run
  // supervised (Step/Run + Fix-this overlay, on-screen) and CLEAR the flag (one-shot). The
  // executor already handles mode === 'supervised'; context.supervised drives the SW's
  // supervised entry path (no 3.5-min hard cap — the human paces it).
  let superviseThis = false;
  try {
    if (db.kvGet('superviseNext')) {
      superviseThis = true;
      mode = 'supervised';
      db.kvSet('superviseNext', null);   // one-shot: consume it
    }
  } catch {}

  // ---- Apprenticeship Engine [P5]: resolve a replay recipe for this (ats, company) ----
  // Classify the live job URL to (ats, companyKey); companyKey falls back to a normalized
  // job.company when the ATS doesn't encode one (linkedin/indeed/direct). resolveRecipe
  // blends the ATS recipe + the company overlay. ALL of this is best-effort: a throw or a
  // missing recipe must NOT block dispatch — the executor's replay path is gated and
  // additive, so an absent/empty recipe simply means it runs today's discover flow.
  let recipe = null, recipeAts = null, recipeCompany = null;
  try {
    const cls = db.classifyAts(job.jobUrl);
    recipeAts = cls.ats || null;
    recipeCompany = cls.companyKey || db.normCompanyKey(job.company) || null;
    if (recipeAts) recipe = db.resolveRecipe(recipeAts, recipeCompany, profileId);
  } catch (e) { log.warn && log.warn('resolveRecipe failed (replay disabled for this task):', e?.message || e); }

  db.queuePatch(task.id, {
    state: 'scheduled',
    handoffToken: null,
    scheduledAt: new Date().toISOString(),
    transcriptAppend: { note: `scheduled (mode=${mode})` },
  });
  broadcast('queue.updated', { taskId: task.id, state: 'scheduled' });

  return {
    task: { ...task, mode },
    concurrency,
    context: {
      job,
      profile: profile || null,
      profileId,
      bringToFront: !!s.bringToFrontToHydrate,   // SW focuses the apply window so an occluded page isn't throttled
      frontToHydrate: s.frontToHydrate !== false,  // reactive front-until-hydrated when the apply tab reports itself occluded (default ON)
      easyApplyOnly: s.easyApplyOnly !== false,
      // One-shot "Watch & Teach the next application" armed from the dashboard → run this
      // dispatch supervised, on-screen (Step/Run + Fix-this). bringToFront so it's visible.
      ...(superviseThis ? { supervised: true, bringToFront: true } : {}),
      harvested,
      // Replay recipe (P5) — gated + additive in the executor; null when none resolves.
      recipe,
      recipeAts,
      recipeCompany,
      resume: resume ? {
        id: resume.id, name: resume.name, mime: resume.mime,
      } : null,
      aiConfidenceMin: s.aiAnswerConfidenceMin,
      // Fit filters the executor re-checks against the live job page (a manually
      // queued job can bypass the discovery gate; and only the page has the
      // "needs N years" requirement text).
      fit: {
        experienceYears: s.experienceYears || 0,
        seniorityMax: s.seniorityMax || 'any',
        excludeKeywords: s.excludeKeywords || [],
        excludeCompanies: s.excludeCompanies || [],
        excludeLocations: s.excludeLocations || [],
        company: job.company || '',
        location: job.location || '',
      },
    },
  };
}

// ============================================================
// Document-folder indexing (read-only crawl of a user-linked directory).
// Smart: classifies each file by its name AND the folders above it, scores how
// likely it's a real/current application document, skips junk, and auto-rescans
// on startup + on filesystem changes (debounced fs.watch).
// ============================================================
const FOLDER_EXT_RX = /\.(pdf|docx?|txt|md|rtf|odt)$/i;
const MAX_INDEX_FILE_BYTES = 15 * 1024 * 1024;
const IGNORE_FILE_RX = /(^~\$|^\.~|\.tmp$|\.bak$|^thumbs\.db$|^desktop\.ini$|\(conflicted copy| - copy|backup of )/i;
const SKIP_DIR_RX = /^(node_modules|\$recycle\.bin|system volume information|\.git|appdata)$/i;
const RESUME_RX = /\b(resumes?|résumés?|cv|cvs|curriculum)\b/i;
const COVER_RX  = /\b(cover\s*letters?|coverletters?|lettres?\s*de\s*motivation|motivation)\b/i;

// Deterministic résumé fields (contacts + links) — pure module, merged with the
// AI parse so the obvious things always come through. See resumefields.js.
const { deterministicResumeFields } = require('./resumefields');

function isUnsafeFolder(p) {
  const r = path.resolve(p);
  if (/^[A-Za-z]:\\?$/.test(r) || r === path.parse(r).root) return true;   // drive/filesystem root
  const lower = r.toLowerCase();
  const banned = [
    'c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata',
    '/system', '/usr', '/bin', '/sbin', '/etc', '/var', '/private',
  ];
  return banned.some((b) => lower === b || lower.startsWith(b + path.sep));
}

// Classify a file from its name + the folder names above it. Returns
// { role, importance } where importance ranks how likely it's a real, current
// application document (drives ordering + which docs surface as candidates).
function classifyDoc(relDir, name, mtimeMs) {
  const fileHay = ' ' + name.toLowerCase() + ' ';
  const dirHay = ' ' + relDir.toLowerCase().replace(/[\\/]+/g, ' ') + ' ';
  let role = 'other', importance = 10;

  if (COVER_RX.test(fileHay)) { role = 'cover_letter'; importance = 60; }
  else if (RESUME_RX.test(fileHay)) { role = 'resume'; importance = 75; }
  // A file living in a "Resumes"/"Cover letters" folder takes that role even if
  // the filename is generic, and gets a confidence boost.
  if (RESUME_RX.test(dirHay)) { if (role === 'other') role = 'resume'; importance += 25; }
  if (COVER_RX.test(dirHay)) { if (role === 'other') role = 'cover_letter'; importance += 22; }

  if (/\b(application|applications|job|jobs|career|careers|postul)/.test(fileHay + dirHay)) importance += 15;
  if (/\b(final|current|latest|master|active|signed|20\d\d)\b/.test(fileHay)) importance += 18;
  if (/\b(old|older|archive|archived|draft|drafts|backup|copy|previous|outdated|sample|example|test)\b/.test(fileHay + dirHay)) importance -= 28;
  if (/\b(template|templates|boilerplate)\b/.test(fileHay + dirHay)) importance -= 8;   // useful but not "current"

  const ageDays = (Date.now() - mtimeMs) / 86400000;
  if (ageDays < 90) importance += 15;
  else if (ageDays < 540) importance += 6;
  else if (ageDays > 1460) importance -= 12;

  return { role, importance: Math.max(0, importance) };
}

// Walk a linked folder, classify + extract text + keywords per supported file,
// upsert into the library (deduped by path; unchanged files skip re-extraction),
// and prune entries whose source file vanished. Returns { indexed, summary }.
async function scanFolder(folder) {
  const s = db.getSettings().documents;
  const maxFiles = s.maxFolderFiles || 2000;
  const maxDepth = s.maxFolderDepth || 6;
  const topN = s.keywordCount || 12;

  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || found.length >= maxFiles) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found.length >= maxFiles) break;
      if (e.name.startsWith('.') || SKIP_DIR_RX.test(e.name)) continue;
      if (e.isSymbolicLink && e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && FOLDER_EXT_RX.test(e.name) && !IGNORE_FILE_RX.test(e.name)) found.push(full);
    }
  };
  walk(folder.path, 0);

  const summary = { resume: 0, cover_letter: 0, other: 0, skipped: 0, total: found.length };
  let indexed = 0, processed = 0;
  for (const full of found) {
    // Yield to the event loop every few files so a big index doesn't starve SSE
    // keep-alives / other REST requests on this single-threaded process.
    if (processed++ % 6 === 0) await new Promise((r) => setImmediate(r));
    let st; try { st = fs.statSync(full); } catch { continue; }
    if (st.size > MAX_INDEX_FILE_BYTES || st.size < 16) { summary.skipped++; continue; }
    const mtime = st.mtime.toISOString();
    const rel = path.relative(folder.path, path.dirname(full));
    let { role, importance } = classifyDoc(rel, path.basename(full), st.mtime.getTime());
    if (folder.roleHint && folder.roleHint !== 'auto') role = folder.roleHint;   // explicit override
    const prev = db.documentByPath(full);
    if (prev && prev.lastModified === mtime && prev.hasText) { summary[role] = (summary[role] || 0) + 1; indexed++; continue; }
    let text = '';
    try { text = await extractText(full, ''); } catch {}
    db.upsertFolderDocument({
      folderId: folder.id, name: path.basename(full), filePath: full, role,
      textContent: text, sizeBytes: st.size, mime: '', lastModified: mtime,
      keywords: db.extractKeywords(text, topN), importance,
    });
    summary[role] = (summary[role] || 0) + 1;
    indexed++;
  }
  summary.removed = db.pruneMissingFolderDocs(folder.id);
  db.folderTouch(folder.id, indexed);
  return { indexed, summary };
}

// ---- auto-index: rescan on startup + a debounced fs.watch per linked folder ----
const folderWatchers = new Map();
const folderRescanTimers = new Map();

async function rescanAllFolders() {
  for (const f of db.folderList()) {
    if (!f.enabled) continue;
    try { await scanFolder(f); broadcast('documents.updated', { folderId: f.id }); }
    catch (e) { log.warn('folder rescan failed', f.path, e.message); }
  }
}

function scheduleFolderRescan(folder) {
  clearTimeout(folderRescanTimers.get(folder.id));
  folderRescanTimers.set(folder.id, setTimeout(async () => {
    try { await scanFolder(db.folderGet(folder.id) || folder); broadcast('documents.updated', { folderId: folder.id }); }
    catch (e) { log.warn('folder auto-rescan failed', e.message); }
  }, 4000));
}

function startFolderWatchers() {
  for (const w of folderWatchers.values()) { try { w.close(); } catch {} }
  folderWatchers.clear();
  for (const f of db.folderList()) {
    if (!f.enabled) continue;
    try {
      const w = fs.watch(f.path, { recursive: true, persistent: false }, () => scheduleFolderRescan(f));
      w.on('error', () => {});
      folderWatchers.set(f.id, w);
    } catch (e) { log.warn('folder watch unavailable', f.path, e.message); }
  }
}

// ============================================================
// Router
// ============================================================
async function handle(req, res, parsed) {
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  const m = (re) => pathname.match(re);
  let jm;

  // ---- unauthenticated ----
  if (req.method === 'GET' && pathname === '/health') {
    return sendJson(res, 200, {
      ok: true, version: opts.getVersion(), ts: Date.now(),
      requiresAuth: true,
    });
  }
  if (req.method === 'POST' && pathname === '/pair') {
    const origin = req.headers.origin || '';
    if (!pairOriginAllowed(origin)) { log.warn('rejected /pair from origin', origin); return sendJson(res, 403, { ok: false, error: 'origin not allowed' }); }
    // per-origin rate-limit: max 5 attempts / 5 min, so a page can't spam consent prompts.
    const now = Date.now();
    for (const [k, v] of pairAttempts) if (now - v.firstAt > 5 * 60000) pairAttempts.delete(k);   // bound the map
    const a = pairAttempts.get(origin) || { count: 0, firstAt: now };
    if (now - a.firstAt > 5 * 60000) { a.count = 0; a.firstAt = now; }
    a.count++; pairAttempts.set(origin, a);
    if (a.count > 5) return sendJson(res, 429, { ok: false, error: 'too many pairing attempts — wait a few minutes' });
    const body = await readJson(req);
    const info = { client: String(body.client || 'unknown').slice(0, 60), origin };
    const allowed = await opts.confirmPair(info);
    if (!allowed) return sendJson(res, 403, { ok: false, error: 'pairing rejected' });
    log.info('paired client', info);
    recordPairedClient(info);   // remembered so setup can verify the extension actually connected
    return sendJson(res, 200, { ok: true, token: getToken() });
  }

  // ---- the dashboard over HTTP (support/debug surface) ----
  // The SAME SPA the Electron window loads: http://127.0.0.1:7744/app/#/settings
  // Served WITHOUT the token gate: these are the same static shell files that ship inside the
  // public extension zip (no data in them); sub-resources (app.js/app.css) load token-less from
  // the HTML. Every DATA route below stays token-gated — the SPA itself carries the token
  // (?token= in the URL) for its API calls. Loopback-only server; serve-the-dir with a
  // confinement guard — never an enumerated whitelist (the v13 blank-dashboard scar).
  if (req.method === 'GET' && (pathname === '/app' || pathname === '/app/' || pathname.startsWith('/app/'))) {
    const fs2 = require('fs');
    const appDir = path.join(__dirname, 'app');
    const rel = pathname.replace(/^\/app\/?/, '') || 'app.html';
    const file = path.normalize(path.join(appDir, rel));
    if (!file.startsWith(appDir)) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
    try {
      const data = fs2.readFileSync(file);
      // no-store: this is a live dev/support surface — a stale cached SPA is worse than a re-download.
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return res.end(data);
    } catch {
      return sendJson(res, 404, { ok: false, error: 'not found' });
    }
  }

  // ---- setup-report INGEST (Pierre's machine receives Dad's setup report over the LAN) ---------
  // Deliberately NOT token-gated: the pushing machine (Dad's setup script) can't know THIS machine's
  // token. Guarded instead by (a) remoteAccess must be ON here, (b) the host guard already limited us
  // to private-range callers, (c) a hard body-size cap, (d) it only ever WRITES a plain-text file into
  // a dedicated setup-reports/ dir — no code path reads it back or executes it. Off by default.
  if (req.method === 'POST' && pathname === '/remote/report') {
    let remoteOn = false;
    try { remoteOn = !!db.getSettings().server.remoteAccess; } catch {}
    if (!remoteOn) return sendJson(res, 403, { ok: false, error: 'remote access is off on this machine' });
    let text = '';
    try { text = await readBodyText(req, 512 * 1024); } catch { return sendJson(res, 413, { ok: false, error: 'too large' }); }
    const fsR = require('fs');
    const dir = path.join(opts.userDataDir, 'setup-reports');
    try { fsR.mkdirSync(dir, { recursive: true }); } catch {}
    const from = String(parsed.searchParams.get('from') || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `setup-${from}-${stamp}.txt`);
    try { fsR.writeFileSync(file, text); } catch (e) { return sendJson(res, 500, { ok: false, error: 'write failed' }); }
    try { if (opts.notify) opts.notify('status', { kind: 'setup-report', from, file }); } catch {}
    log.info('received setup report', { from, bytes: text.length });
    return sendJson(res, 200, { ok: true, saved: path.basename(file) });
  }

  // ---- everything else requires the token ----
  if (!authed(req, parsed)) {
    return sendJson(res, 401, { ok: false, error: 'unauthorized', pairHint: 'POST /pair' });
  }

  // ---- remote intel: network info + logs over the API (the watch-Dad's-machine surface) --------
  // GET /netinfo → the URLs another machine on the LAN can open (Settings shows these).
  if (req.method === 'GET' && pathname === '/netinfo') {
    const os2 = require('os');
    const ips = [];
    try {
      for (const [name, addrs] of Object.entries(os2.networkInterfaces())) {
        for (const a of addrs || []) {
          if (a.family === 'IPv4' && !a.internal) ips.push({ iface: name, ip: a.address });
        }
      }
    } catch {}
    let remoteAccess = false;
    try { remoteAccess = !!db.getSettings().server.remoteAccess; } catch {}
    let port = 7744;
    try { port = db.getSettings().server.port || 7744; } catch {}
    const extensionConnected = pairedClients.some((c) => /^moz-extension:\/\//.test(c.origin) || /^chrome-extension:\/\//.test(c.origin));
    return sendJson(res, 200, { ok: true, hostname: (() => { try { return os2.hostname(); } catch { return ''; } })(), port, remoteAccess, ips, pairedClients, extensionConnected });
  }
  // GET /logs → the app's log files (name/size/mtime, newest first).
  if (req.method === 'GET' && pathname === '/logs') {
    const fsL = require('fs');
    const dir = path.join(opts.userDataDir, 'logs');
    let files = [];
    try {
      files = fsL.readdirSync(dir)
        .map((name) => { const st = fsL.statSync(path.join(dir, name)); return { name, size: st.size, mtime: st.mtimeMs }; })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {}
    return sendJson(res, 200, { ok: true, files });
  }
  // GET /logs/tail?file=<name>&lines=500 → the tail of one log file, as text.
  if (req.method === 'GET' && pathname === '/logs/tail') {
    const fsL = require('fs');
    const dir = path.join(opts.userDataDir, 'logs');
    const name = String(parsed.searchParams.get('file') || '');
    const lines = Math.min(Math.max(parseInt(parsed.searchParams.get('lines') || '500', 10) || 500, 1), 5000);
    const file = path.normalize(path.join(dir, name));
    if (!name || !file.startsWith(dir)) return sendJson(res, 400, { ok: false, error: 'bad file' });
    try {
      const raw = fsL.readFileSync(file, 'utf8');
      const all = raw.split(/\r?\n/);
      const text = all.slice(Math.max(0, all.length - lines)).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(text);
    } catch {
      return sendJson(res, 404, { ok: false, error: 'not found' });
    }
  }

  // ---- SSE stream ----
  if (req.method === 'GET' && pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(':connected\n\n');
    sseClients.add(res);
    const ka = setInterval(() => { try { res.write(':ka\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
    return;
  }

  // ---- jobs ----
  if (req.method === 'GET' && pathname === '/jobs') {
    return sendJson(res, 200, {
      ok: true,
      items: db.listJobs({
        status: parsed.searchParams.get('status') || undefined,
        source: parsed.searchParams.get('source') || undefined,
        needsReview: parsed.searchParams.has('needsReview')
          ? parsed.searchParams.get('needsReview') === '1' : undefined,
        q: parsed.searchParams.get('q') || undefined,
        // Boundary safety cap when the caller omits a limit: keeps a stray no-limit /jobs from
        // materializing every row. Generous (1000) — the UI's largest explicit list fetch is 500,
        // so this never truncates a real view; internal callers (exportAll/backfill) bypass the
        // HTTP layer entirely and stay unbounded. See perf audit (v11.82.0).
        limit: parsed.searchParams.get('limit') || 1000,
        offset: parsed.searchParams.get('offset') || undefined,
      }),
    });
  }
  if (req.method === 'GET' && (jm = m(/^\/jobs\/([^/]+)$/))) {
    const job = db.getJob(jm[1]);
    if (!job) return sendJson(res, 404, { ok: false, error: 'not found' });
    return sendJson(res, 200, { ok: true, job });
  }
  if (req.method === 'POST' && pathname === '/jobs') {
    const body = await readJson(req);
    // Job upsert + its timeline event commit atomically — never a job without
    // its creation/status event, nor an orphan event.
    const result = db.transaction(() => {
      const r = db.upsertJob(body, { manual: !!body._manual });
      if (r.statusChanged || r.action === 'created' || r.action === 'reopened') {
        db.recordEvent({
          jobId: r.job.id,
          type: r.action === 'created' ? 'created'
              : r.action === 'reopened' ? 'reopened' : 'status_changed',
          source: body._source || 'extension',
          summary: r.action === 'created'
            ? `Captured as ${r.job.status}`
            : `${r.previousStatus} → ${r.job.status}`,
          data: { from: r.previousStatus, to: r.job.status },
        });
      }
      return r;
    });
    if (result.statusChanged || result.action === 'created' || result.action === 'reopened') {
      if (opts.notify) opts.notify('status', result);
    }
    broadcast('jobs.updated', { jobId: result.job.id, action: result.action });
    return sendJson(res, 200, { ok: true, ...result });
  }
  if (req.method === 'PATCH' && (jm = m(/^\/jobs\/([^/]+)$/))) {
    const body = await readJson(req);
    const result = db.transaction(() => {
      const r = db.patchJob(jm[1], body);
      if (r && r.statusChanged) {
        db.recordEvent({
          jobId: r.job.id, type: 'status_changed', source: body._source || 'manual',
          summary: `${r.previousStatus} → ${r.job.status}`,
          data: { from: r.previousStatus, to: r.job.status },
        });
      }
      return r;
    });
    if (!result) return sendJson(res, 404, { ok: false, error: 'not found' });
    broadcast('jobs.updated', { jobId: result.job.id, action: 'updated' });
    return sendJson(res, 200, { ok: true, ...result });
  }
  if (req.method === 'DELETE' && (jm = m(/^\/jobs\/([^/]+)$/))) {
    const existed = db.deleteJob(jm[1]);
    if (!existed) return sendJson(res, 404, { ok: false, error: 'not found' });
    broadcast('jobs.updated', { jobId: jm[1], action: 'deleted' });
    return sendJson(res, 200, { ok: true });
  }

  // ---- events ----
  if (req.method === 'GET' && pathname === '/events') {
    const jobId = parsed.searchParams.get('jobId');
    if (!jobId) return sendJson(res, 400, { ok: false, error: 'jobId required' });
    return sendJson(res, 200, { ok: true, items: db.listEvents(jobId, parsed.searchParams.get('limit') || undefined) });
  }
  if (req.method === 'GET' && pathname === '/events/recent') {
    return sendJson(res, 200, { ok: true, items: db.listRecentEvents(parsed.searchParams.get('limit') || 100) });
  }
  if (req.method === 'POST' && pathname === '/events') {
    const body = await readJson(req);
    if (!body.jobId || !body.type) return sendJson(res, 400, { ok: false, error: 'jobId + type required' });
    if (!db.getJob(body.jobId)) return sendJson(res, 404, { ok: false, error: 'job not found' });
    const ev = db.recordEvent(body);
    broadcast('jobs.updated', { jobId: body.jobId, action: 'event' });
    return sendJson(res, 200, { ok: true, event: ev });
  }

  // ---- stats ----
  if (req.method === 'GET' && pathname === '/stats') {
    return sendJson(res, 200, { ok: true, ...db.stats() });
  }
  if (req.method === 'GET' && pathname === '/stats/activity') {
    const days = Number(parsed.searchParams.get('days')) || 14;
    return sendJson(res, 200, { ok: true, days, items: db.activityTrend({ days }) });
  }

  // ---- settings ----
  if (req.method === 'GET' && pathname === '/settings') {
    const { settings, secretsPresent } = publicSettings();
    return sendJson(res, 200, { ok: true, settings, secretsPresent });
  }
  if (req.method === 'PATCH' && pathname === '/settings') {
    const body = await readJson(req);
    // Stamp/clear the "running for" timer on the auto-apply on→off transition.
    if (body.autoApply && typeof body.autoApply.enabled === 'boolean') {
      const wasOn = !!db.getSettings().autoApply.enabled;
      if (body.autoApply.enabled && !wasOn) body.autoApply.startedAt = new Date().toISOString();
      else if (!body.autoApply.enabled) body.autoApply.startedAt = '';
    }
    db.patchSettings(body);
    try { opts.onSettingsChanged?.(body); } catch {}
    broadcast('settings.updated', {});
    const { settings, secretsPresent } = publicSettings();   // never echo decrypted secrets back in the PATCH response
    return sendJson(res, 200, { ok: true, settings, secretsPresent });
  }

  // ---- qa ----
  if (req.method === 'GET' && pathname === '/qa') {
    const pid = parsed.searchParams.get('profileId') || db.ensureDefaultProfileId();
    return sendJson(res, 200, { ok: true, items: db.qaList(pid, Number(parsed.searchParams.get('limit')) || 500) });
  }
  if (req.method === 'POST' && pathname === '/qa') {
    const body = await readJson(req);
    if (!body.question || body.answer == null) return sendJson(res, 400, { ok: false, error: 'question + answer required' });
    return sendJson(res, 200, { ok: true, item: db.qaRecord({ ...body, profileId: body.profileId || db.resolveProfileId(body.source) }) });
  }
  if (req.method === 'POST' && pathname === '/qa/lookup') {
    const body = await readJson(req);
    const pid = body.profileId || db.resolveProfileId(body.source);
    const q = body.question || '';
    // Check the locked profile-fields (the answers the user explicitly gave) in ADDITION to the
    // qa store, so the executor's deterministic ladder reuses saved answers without an AI call.
    // Profile-fields are higher trust (user-locked) → prefer on tie. Normalize their `.value` to
    // the `.answer` shape the executor reads.
    const pf = db.profileFieldLookup(pid, q);
    const qa = db.qaLookup(pid, q);
    const pfn = pf ? { ...pf, answer: pf.value } : null;
    const match = (pfn && qa) ? (pfn.score >= qa.score ? pfn : qa) : (pfn || qa);
    return sendJson(res, 200, { ok: true, match });
  }
  if (req.method === 'DELETE' && (jm = m(/^\/qa\/([^/]+)$/))) {
    return sendJson(res, db.qaDelete(jm[1]) ? 200 : 404, { ok: true });
  }

  // ---- observe (Apprenticeship Engine: always-on nav recorder) [P2] ----
  // The extension POSTs every top-frame navigation here; db.recordNavEvent classifies
  // the (ats, company) and detects board→ATS handoff edges. Defensive: an unknown kind
  // or a bad url never errors (classifyAts is try/catch-wrapped). Profile resolves from
  // the source/company the same way /qa does, so attribution stays per-profile.
  if (req.method === 'POST' && pathname === '/observe') {
    const body = await readJson(req);
    // Teach & Correct T2: a full-fidelity manual-apply demonstration step. Resolve the
    // profile the same way nav does, classify the (ats, company) from the apply URL
    // (companyKey falls back to a normalized body.company), and record it. The credential
    // rail (value/html nulling) is enforced inside db.recordDemonstration. Fully guarded.
    if (body.kind === 'step') {
      try {
        const profileId = body.profileId || db.resolveProfileId(body.company || body.source);
        const cls = db.classifyAts(body.url);
        const companyKey = cls.companyKey || db.normCompanyKey(body.company) || null;
        const demo = db.recordDemonstration({
          profileId, sessionId: body.sessionId, jobId: body.jobId,
          ats: cls.ats, companyKey,
          stepIndex: body.stepIndex, action: body.action, label: body.label, fieldType: body.fieldType,
          selector: body.selector, xpath: body.xpath, attrs: body.attrs, html: body.html,
          value: body.value, screenshotId: body.screenshotId, delayMs: body.delayMs,
          source: body.source || 'manual',
        });
        // T3: when a teach/apply step looks terminal (an advance/submit), fold this
        // session's demonstrations into enriched recipes — best-effort, lazy-required,
        // fully guarded so a distiller hiccup never breaks the observe write.
        const act = String(body.action || '').toLowerCase();
        if (act === 'advance' || act === 'submit') {
          try {
            const { distillDemonstrations } = require('./distiller');
            distillDemonstrations(profileId, { sessionId: body.sessionId, jobId: body.jobId });
          } catch {}
        }
        return sendJson(res, 200, { ok: true, demonstration: { id: demo && demo.id } });
      } catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e) }); }
    }
    if (body.kind && body.kind !== 'nav') return sendJson(res, 400, { ok: false, error: 'unsupported observe kind' });
    const profileId = body.profileId || db.resolveProfileId(body.company || body.source);
    const event = db.recordNavEvent({
      profileId, url: body.url, referrer: body.referrer,
      kind: body.navKind, sessionId: body.sessionId, company: body.company,
    });
    return sendJson(res, 200, { ok: true, event });
  }

  // Teach & Correct T2 — best-effort screenshot for a Teach-Mode step. Accepts the full
  // visible-tab PNG (dataUrl) + the apply-form rect, crops to the form via Electron
  // nativeImage, saves a PNG under userData/teach-shots/, records the teach_screenshot
  // row, and returns its id (the recorder posts the step separately; this only enriches
  // it). EVERYTHING is guarded: no Electron / no permission / crop error → {ok:false} and
  // the step simply has no screenshot.
  if (req.method === 'POST' && pathname === '/observe/screenshot') {
    const body = await readJson(req);
    try {
      if (!body.dataUrl) return sendJson(res, 200, { ok: false, error: 'no dataUrl' });
      let nativeImage;
      try { ({ nativeImage } = require('electron')); } catch { nativeImage = null; }
      if (!nativeImage || !nativeImage.createFromDataURL) return sendJson(res, 200, { ok: false, error: 'no electron' });
      let img = nativeImage.createFromDataURL(body.dataUrl);
      if (!img || img.isEmpty()) return sendJson(res, 200, { ok: false, error: 'empty image' });
      const full = img.getSize();
      const r = body.rect || {};
      // Clamp the crop rect into the captured image bounds (a partially-offscreen form
      // would otherwise throw); skip the crop if the rect is degenerate.
      const x = Math.max(0, Math.min(Math.round(r.x || 0), Math.max(0, full.width - 1)));
      const y = Math.max(0, Math.min(Math.round(r.y || 0), Math.max(0, full.height - 1)));
      const w = Math.max(1, Math.min(Math.round(r.w || full.width), full.width - x));
      const h = Math.max(1, Math.min(Math.round(r.h || full.height), full.height - y));
      let crop = img;
      try { crop = img.crop({ x, y, width: w, height: h }); } catch { crop = img; }
      const png = crop.toPNG();
      const dir = path.join(opts.userDataDir, 'teach-shots');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const id = `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const filePath = path.join(dir, `${id}.png`);
      fs.writeFileSync(filePath, png);
      const size = crop.getSize();
      const profileId = body.profileId || db.resolveProfileId(body.company || body.source);
      const screenshotId = db.recordTeachScreenshot({ profileId, path: filePath, w: size.width, h: size.height, bytes: png.length });
      return sendJson(res, 200, { ok: true, screenshotId });
    } catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e) }); }
  }

  // ---- recipe correction (Apprenticeship Engine: replay divergence feedback) [P5 + T4] ----
  // Two modes (recordRecipeCorrection decides by payload):
  //   • DECAY (P5): the executor POSTs {recipeId, labelPattern} on AUTO-replay divergence
  //     → confidence decays + fail_count++ so the recipe self-corrects toward fall-back.
  //   • AUTHORITATIVE REWRITE (T4 Live Teach & Correct): the supervised-run overlay POSTs a
  //     replacement bundle {labelPattern, selector, xpath, attrs, html, value, fieldType,
  //     action} → the matching step is rewritten (right locator + value) at high confidence.
  // The caller may name the recipe directly (recipeId) OR by {ats, companyKey, profileId}
  // (the overlay knows the ATS/company, not the internal id) — we resolve-or-create it.
  // Token-guarded like every route below /pair.
  if (req.method === 'POST' && pathname === '/recipe/correction') {
    const body = await readJson(req);
    let recipeId = body.recipeId;
    if (!recipeId && body.ats) {
      // Resolve (or create) the recipe by ats/company so a correction can land even when
      // the caller only knows the ATS/company. A named company → company overlay; else the
      // cross-company ATS recipe.
      const pid = body.profileId || undefined;
      const scope = body.companyKey ? 'company' : 'ats';
      let recipe = db.getRecipe(pid, scope, body.ats, body.companyKey || null);
      if (!recipe) recipe = db.upsertRecipe({ profileId: pid, scope, ats: body.ats, companyKey: body.companyKey || null });
      recipeId = recipe && recipe.id;
    }
    if (!recipeId) return sendJson(res, 400, { ok: false, error: 'recipeId or {ats[,companyKey]} required' });
    return sendJson(res, 200, { ok: true, recipe: db.recordRecipeCorrection(recipeId, {
      labelPattern: body.labelPattern,
      selector: body.selector, xpath: body.xpath, attrs: body.attrs, html: body.html,
      value: body.value, fieldType: body.fieldType, action: body.action,
    }) });
  }
  // The replayer POSTs here on a clean mechanical completion of a recipe walk so the
  // recipe's success_count is credited (markRecipeOutcome). Best-effort + token-guarded.
  if (req.method === 'POST' && pathname === '/recipe/outcome') {
    const body = await readJson(req);
    if (!body.recipeId) return sendJson(res, 400, { ok: false, error: 'recipeId required' });
    return sendJson(res, 200, { ok: true, recipe: db.markRecipeOutcome(body.recipeId, { success: body.success !== false }) });
  }

  // ---- Taught Procedures review/audit dashboard [T5] ----
  // GET /recipes?profileId= — every recipe (ats|company) for the profile, each with its
  // ordered steps + per-step needsAttention flag (the full review bundle).
  if (req.method === 'GET' && pathname === '/recipes') {
    const pid = parsed.searchParams.get('profileId') || db.ensureDefaultProfileId();
    return sendJson(res, 200, { ok: true, profileId: pid, recipes: db.listRecipesWithSteps(pid) });
  }
  // PATCH /recipe-step/:id — edit one step (value / label / scope flip / reorder / action).
  // The credential rail (no value on a sensitive label) is enforced inside the db helper.
  if (req.method === 'PATCH' && (jm = m(/^\/recipe-step\/([^/]+)$/))) {
    const body = await readJson(req);
    const step = db.updateRecipeStepFields(jm[1], {
      defaultValue: body.defaultValue, labelPattern: body.labelPattern,
      scope: body.scope, stepIndex: body.stepIndex, action: body.action,
    });
    if (!step) return sendJson(res, 404, { ok: false, error: 'not found' });
    broadcast('recipes.updated', { stepId: jm[1] });
    return sendJson(res, 200, { ok: true, step });
  }
  // DELETE /recipe-step/:id — remove a step (and clean its orphaned screenshot).
  if (req.method === 'DELETE' && (jm = m(/^\/recipe-step\/([^/]+)$/))) {
    const okDel = db.deleteRecipeStep(jm[1]);
    if (okDel) broadcast('recipes.updated', { stepId: jm[1] });
    return sendJson(res, okDel ? 200 : 404, { ok: okDel });
  }
  // GET /teach-shot/:id — serve a teach screenshot PNG so the dashboard can render thumbnails.
  if (req.method === 'GET' && (jm = m(/^\/teach-shot\/([^/]+)$/))) {
    const p = db.getTeachScreenshotPath(jm[1]);
    if (!p) return sendJson(res, 404, { ok: false, error: 'not found' });
    // Defense-in-depth: only ever serve from userData/teach-shots, never an arbitrary path.
    const shotsDir = path.resolve(opts.userDataDir, 'teach-shots');
    const real = path.resolve(p);
    if (real !== shotsDir && !real.startsWith(shotsDir + path.sep)) {
      return sendJson(res, 403, { ok: false, error: 'access denied' });
    }
    try {
      const buf = fs.readFileSync(real);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=60' });
      return res.end(buf);
    } catch { return sendJson(res, 404, { ok: false, error: 'file missing on disk' }); }
  }

  // ---- profiles ----
  if (req.method === 'GET' && pathname === '/profiles') {
    return sendJson(res, 200, { ok: true, items: db.listProfiles() });
  }
  if (req.method === 'GET' && pathname === '/profiles/for-source') {
    return sendJson(res, 200, { ok: true, profile: db.profileForSource(parsed.searchParams.get('source') || '') });
  }
  if (req.method === 'POST' && pathname === '/profiles') {
    const body = await readJson(req);
    return sendJson(res, 200, { ok: true, profile: db.saveProfile(body) });
  }
  if (req.method === 'DELETE' && (jm = m(/^\/profiles\/([^/]+)$/))) {
    return sendJson(res, db.deleteProfile(jm[1]) ? 200 : 404, { ok: true });
  }

  // ---- profile fields (dynamic, auto-harvested) ----
  if (req.method === 'GET' && pathname === '/profile-fields') {
    const pid = parsed.searchParams.get('profileId') || db.ensureDefaultProfileId();
    return sendJson(res, 200, { ok: true, items: db.profileFieldList(pid) });
  }
  if (req.method === 'POST' && pathname === '/profile-fields') {
    const body = await readJson(req);
    if (!body.question) return sendJson(res, 400, { ok: false, error: 'question required' });
    // A manual add/edit from the dashboard is authoritative → high confidence + locked.
    const item = db.profileFieldUpsert({ ...body, profileId: body.profileId || db.ensureDefaultProfileId(), confidence: 1, fromUser: true });
    broadcast('profileFields.updated', {});
    return sendJson(res, 200, { ok: true, item });
  }
  if (req.method === 'PATCH' && (jm = m(/^\/profile-fields\/([^/]+)$/))) {
    const body = await readJson(req);
    const item = db.profileFieldSet(jm[1], body);
    if (!item) return sendJson(res, 404, { ok: false, error: 'not found' });
    broadcast('profileFields.updated', {});
    return sendJson(res, 200, { ok: true, item });
  }
  if (req.method === 'DELETE' && (jm = m(/^\/profile-fields\/([^/]+)$/))) {
    const okDel = db.profileFieldDelete(jm[1]);
    broadcast('profileFields.updated', {});
    return sendJson(res, okDel ? 200 : 404, { ok: okDel });
  }
  // Build a profile's memory from EVERY past application's answers.
  if (req.method === 'POST' && pathname === '/profile-fields/backfill') {
    const body = await readJson(req);
    const r = db.backfillProfileFromJobs(body.profileId || db.ensureDefaultProfileId());
    broadcast('profileFields.updated', {});
    return sendJson(res, 200, { ok: true, ...r });
  }
  // Bridge (memory → profile): structured values derived from a profile's own memory.
  if (req.method === 'GET' && pathname === '/profile/from-memory') {
    const pid = parsed.searchParams.get('profileId') || db.ensureDefaultProfileId();
    return sendJson(res, 200, { ok: true, data: db.memoryToProfileData(pid) });
  }
  // Bridge (profile → memory): push a profile's structured fields into its memory.
  if (req.method === 'POST' && pathname === '/profile/to-memory') {
    const body = await readJson(req);
    const r = db.pushProfileDataToMemory(body.profileId || db.ensureDefaultProfileId(), body.data || {});
    broadcast('profileFields.updated', {});
    return sendJson(res, 200, { ok: true, ...r });
  }

  // Everything the extension needs to pre-fill a new application (gated by the
  // autofill setting — returns disabled:true when off so the client no-ops).
  if (req.method === 'GET' && pathname === '/autofill/bundle') {
    const af = db.getSettings().autofill;
    if (!af.enabled) return sendJson(res, 200, { ok: true, enabled: false });
    const bundle = db.profileAutofillBundle(parsed.searchParams.get('source') || '');
    return sendJson(res, 200, { ok: true, enabled: true, settings: af, ...bundle });
  }

  // ---- documents ----
  if (req.method === 'GET' && pathname === '/documents') {
    return sendJson(res, 200, { ok: true, items: db.listDocuments({
      role: parsed.searchParams.get('role') || undefined,
      source: parsed.searchParams.get('source') || undefined,
      folderId: parsed.searchParams.get('folderId') || undefined,
      q: parsed.searchParams.get('q') || undefined,
    }) });
  }
  if (req.method === 'GET' && (jm = m(/^\/documents\/([^/]+)$/))) {
    const withText = parsed.searchParams.get('text') === '1';
    const doc = db.getDocument(jm[1], { withText });
    if (!doc) return sendJson(res, 404, { ok: false, error: 'not found' });
    if (parsed.searchParams.get('raw') === '1') {
      // Defense-in-depth: never read outside userData/documents even if the
      // stored path was tampered with (local DB edit / corruption recovery).
      const docsDir = path.resolve(opts.userDataDir, 'documents');
      const real = path.resolve(doc.filePath);
      if (real !== docsDir && !real.startsWith(docsDir + path.sep)) {
        return sendJson(res, 403, { ok: false, error: 'access denied' });
      }
      try {
        const buf = fs.readFileSync(real);
        res.writeHead(200, {
          'Content-Type': doc.mime || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(doc.name)}"`,
        });
        return res.end(buf);
      } catch { return sendJson(res, 410, { ok: false, error: 'file missing on disk' }); }
    }
    return sendJson(res, 200, { ok: true, document: doc });
  }
  if (req.method === 'POST' && pathname === '/documents') {
    const body = await readJson(req);
    if (!body.name || !body.dataBase64) return sendJson(res, 400, { ok: false, error: 'name + dataBase64 required' });
    const dir = path.join(opts.userDataDir, 'documents');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const safeName = String(body.name).replace(/[^\w.\- ()]/g, '_').slice(0, 150);
    const filePath = path.join(dir, `${Date.now()}-${safeName}`);
    const buf = Buffer.from(body.dataBase64, 'base64');
    fs.writeFileSync(filePath, buf);
    const text = await extractText(filePath, body.mime || '');
    const doc = db.addDocument({
      name: safeName, role: body.role || 'resume', filePath,
      textContent: text, sizeBytes: buf.length, mime: body.mime || '',
      isDefault: !!body.isDefault,
    });
    broadcast('documents.updated', { id: doc.id });
    return sendJson(res, 200, { ok: true, document: doc, extractedChars: text.length });
  }
  if (req.method === 'PATCH' && (jm = m(/^\/documents\/([^/]+)$/))) {
    const body = await readJson(req);
    const doc = db.patchDocument(jm[1], body);
    if (!doc) return sendJson(res, 404, { ok: false, error: 'not found' });
    broadcast('documents.updated', { id: doc.id });
    return sendJson(res, 200, { ok: true, document: doc });
  }
  if (req.method === 'DELETE' && (jm = m(/^\/documents\/([^/]+)$/))) {
    const okDel = db.deleteDocument(jm[1]);
    broadcast('documents.updated', { id: jm[1] });
    return sendJson(res, okDel ? 200 : 404, { ok: okDel });
  }

  // ---- document folders (link + index a local directory) ----
  if (req.method === 'GET' && pathname === '/document-folders') {
    return sendJson(res, 200, { ok: true, items: db.folderList() });
  }
  if (req.method === 'POST' && pathname === '/document-folders') {
    const body = await readJson(req);
    const dir = String(body.path || '').trim();
    if (!dir) return sendJson(res, 400, { ok: false, error: 'path required' });
    let st; try { st = fs.statSync(dir); } catch { return sendJson(res, 400, { ok: false, error: 'folder not found' }); }
    if (!st.isDirectory()) return sendJson(res, 400, { ok: false, error: 'not a folder' });
    if (isUnsafeFolder(dir)) return sendJson(res, 400, { ok: false, error: 'that folder is not allowed (system directory)' });
    const folder = db.folderAdd({ path: dir, label: body.label, roleHint: body.roleHint });
    const { indexed, summary } = await scanFolder(folder);
    startFolderWatchers();
    broadcast('documents.updated', { folderId: folder.id });
    return sendJson(res, 200, { ok: true, folder: db.folderGet(folder.id), indexed, summary });
  }
  if (req.method === 'POST' && (jm = m(/^\/document-folders\/([^/]+)\/scan$/))) {
    const folder = db.folderGet(jm[1]);
    if (!folder) return sendJson(res, 404, { ok: false, error: 'not found' });
    const { indexed, summary } = await scanFolder(folder);
    broadcast('documents.updated', { folderId: folder.id });
    return sendJson(res, 200, { ok: true, folder: db.folderGet(folder.id), indexed, summary });
  }
  if (req.method === 'DELETE' && (jm = m(/^\/document-folders\/([^/]+)$/))) {
    const okDel = db.folderDelete(jm[1], { pruneDocs: parsed.searchParams.get('prune') === '1' });
    startFolderWatchers();
    broadcast('documents.updated', { folderId: jm[1] });
    return sendJson(res, okDel ? 200 : 404, { ok: okDel });
  }

  // ---- auto-apply queue ----
  if (req.method === 'GET' && pathname === '/queue') {
    return sendJson(res, 200, { ok: true, items: db.queueList({ state: parsed.searchParams.get('state') || undefined }) });
  }
  if (req.method === 'GET' && pathname === '/queue/next') {
    return sendJson(res, 200, { ok: true, ...(await queueNext(parsed.searchParams.get('force') === '1')) });
  }
  if (req.method === 'POST' && pathname === '/queue') {
    const body = await readJson(req);
    if (!body.jobId) return sendJson(res, 400, { ok: false, error: 'jobId required' });
    const task = db.queueAdd(body.jobId, { mode: body.mode, force: true });
    if (!task) return sendJson(res, 404, { ok: false, error: 'job not found' });
    broadcast('queue.updated', { taskId: task.id, state: task.state });
    return sendJson(res, 200, { ok: true, task });
  }
  if (req.method === 'PATCH' && (jm = m(/^\/queue\/([^/]+)$/))) {
    const body = await readJson(req);
    const task = db.queuePatch(jm[1], body);
    if (!task) return sendJson(res, 404, { ok: false, error: 'not found' });
    // LinkedIn Easy Apply daily cap hit (executor reports `easyapply-limit …`): set the
    // cooldown + learn the observed threshold, so queueNext pivots to external jobs.
    if (typeof body.lastError === 'string' && /^easyapply-limit/.test(body.lastError)) {
      try { db.setEasyApplyCooldown(); } catch {}
      broadcast('queue.updated', { action: 'easyapply-limit' });
    }
    broadcast('queue.updated', { taskId: task.id, state: task.state });
    if (opts.notify && ['awaiting_review', 'awaiting_input', 'parked', 'done', 'failed'].includes(task.state)) {
      opts.notify('autoApply', task);
    }
    return sendJson(res, 200, { ok: true, task });
  }
  if (req.method === 'DELETE' && (jm = m(/^\/queue\/([^/]+)$/))) {
    const okDel = db.queueDelete(jm[1]);
    broadcast('queue.updated', { taskId: jm[1], state: 'deleted' });
    return sendJson(res, okDel ? 200 : 404, { ok: okDel });
  }

  // ---- auto-apply: discovery enqueue + self-healing intake ----
  // Driver hands over jobs found via a keyword/Easy-Apply search → upsert each
  // (tagged auto-apply) and enqueue, deduped.
  if (req.method === 'POST' && pathname === '/queue/discover') {
    const body = await readJson(req);
    const jobs = Array.isArray(body.jobs) ? body.jobs : [];
    const result = ingestDiscoveredJobs(body.source, jobs, {
      providerName: body.provider || 'browser', batchId: body.batchId || null,
    });
    return sendJson(res, 200, { ok: true, ...result, filtered: result.rejected });
  }
  // The deduped list of questions parked jobs are waiting on (the intake form).
  if (req.method === 'GET' && pathname === '/queue/parked') {
    return sendJson(res, 200, { ok: true, items: db.queueParkedQuestions() });
  }
  // Single FULL task incl. transcript — the queue list is lean (no transcript blob), so the
  // Transcript panel lazily fetches it here on first open. MUST come AFTER the specific
  // /queue/next + /queue/parked GET routes above so it never shadows them.
  if (req.method === 'GET' && (jm = m(/^\/queue\/([^/]+)$/))) {
    const task = db.queueGet(jm[1]);
    if (!task) return sendJson(res, 404, { ok: false, error: 'not found' });
    return sendJson(res, 200, { ok: true, task });
  }
  // Auto-apply tasks that need the user (parked / needs-input / review) WITH their job +
  // outstanding questions — surfaced in the Applications page to finish in place.
  if (req.method === 'GET' && pathname === '/auto-apply/needs-you') {
    return sendJson(res, 200, { ok: true, items: db.queueNeedsYou() });
  }
  // Auto-apply outcome history (the "submissions data" view): ?days=N[&state=]
  if (req.method === 'GET' && pathname === '/auto-apply/history') {
    const days = Number(parsed.searchParams.get('days')) || 7;
    const state = parsed.searchParams.get('state') || undefined;
    return sendJson(res, 200, { ok: true, ...db.queueHistory({ days, state }) });
  }
  // Aggregated breakdown for the Auto-apply chart (outcome / board / route / reasons): ?days=N
  if (req.method === 'GET' && pathname === '/auto-apply/breakdown') {
    const days = Number(parsed.searchParams.get('days')) || 30;
    // R3: additively attach the honest run-scoped summary (current run, or fall back to the
    // window). Existing fields (total/byOutcome/byBoard/…) are untouched for back-compat.
    const s = db.getSettings().autoApply;
    const runSummary = db.queueRunSummary({ startedAt: s.startedAt || '' });
    return sendJson(res, 200, { ok: true, ...db.queueBreakdown({ days }), runSummary });
  }
  // A1: LinkedIn Easy Apply daily-cap status — cooldown state, when it resumes, the
  // learned per-account threshold, and the rolling 24h submit count, for the dashboard.
  if (req.method === 'GET' && pathname === '/auto-apply/easyapply-status') {
    return sendJson(res, 200, { ok: true, ...db.easyApplyStatus() });
  }
  // LIVE pool snapshot for the "Running now" panel — in-flight workers + their step,
  // queue depth, session tally, and the EFFECTIVE throughput (so a stale-pacing
  // throttle is visible). Polled + refreshed on the queue.updated SSE.
  if (req.method === 'GET' && pathname === '/auto-apply/live') {
    const s = db.getSettings().autoApply;
    // Mirror queueNext's serial kill-switch so the displayed effective rate is honest.
    const concurrency = (s.parallelApplySafe === true) ? Math.max(1, Math.min(5, Number(s.concurrency) || 1)) : 1;   // per-worker windows (see queueNext)
    // Effective parallelism for a single-site (LinkedIn-dominant) queue is bounded by perSiteCap,
    // not raw concurrency — the gap now paces per site at baseGap/perSiteCap. Use it for the rate
    // estimate so the dashboard's "effective per hour" stays honest.
    const perSiteCap = concurrency > 1 ? Math.max(1, Math.min(concurrency, Number(s.perSiteConcurrency) || 2)) : 1;
    // The extension pump gates dispatch on THIS endpoint's active+scheduled counts (its busy-slot
    // signal). Reclaim stranded in-flight rows BEFORE counting — a 'scheduled' task interrupted right
    // after dispatch (MV3 evicted the SW before the executor flipped it to 'running') would otherwise
    // pin the serial slot for 8 min and re-create the ~9-min apply gap. Mirror queueNext's self-heal so
    // the pump never gates on a phantom busy slot. Scheduled rows reclaim fast (2 min); running keeps 8.
    try { db.reconcileStaleRunning({ olderThanMinutes: 8, scheduledOlderThanMinutes: 2 }); } catch {}
    const live = db.queueLive({ startedAt: s.startedAt || '' });
    const stats = db.queueRunStats();
    // R3 — honest, run-scoped breakdown (verified submits vs. site-gates vs. our failures).
    const runSummary = db.queueRunSummary({ startedAt: s.startedAt || '' });
    const maxPerHour = Number(s.maxPerHour) || 0;
    const avgGap = Math.max(0.05, (Number(s.minGapMinutes) + Number(s.maxGapMinutes)) / 2);
    const gapPerHour = Math.round((60 / avgGap) * perSiteCap);   // gap divides by perSiteCap (per-site pacing)
    const effectivePerHour = maxPerHour ? Math.min(maxPerHour, gapPerHour) : gapPerHour;
    const bindingCap = maxPerHour && maxPerHour <= gapPerHour ? 'hourly-cap' : 'gap';
    const dailyCap = Number(s.dailyCap) || 0;
    const softCapReached = dailyCap > 0 && stats.dispatchedDay >= dailyCap;
    let status;
    if (!s.enabled) status = 'off';
    else if (live.active > 0) status = 'running';
    else if (live.queuedDepth === 0 && live.scheduled === 0) status = 'queue-empty';
    else if (softCapReached) status = 'daily-soft-cap';
    else if (maxPerHour && stats.doneHour >= maxPerHour) status = 'hourly-cap';
    else status = 'pacing';
    return sendJson(res, 200, {
      ok: true, enabled: !!s.enabled, startedAt: s.startedAt || '', mode: s.mode || 'auto',
      concurrency, status, ...live,
      runSummary,
      health: db.pipelineHealth(),
      pacing: {
        maxPerHour, maxPerDay: Number(s.maxPerDay) || 0,
        minGapMinutes: Number(s.minGapMinutes) || 0, maxGapMinutes: Number(s.maxGapMinutes) || 0,
        concurrency, effectivePerHour, bindingCap, doneHour: stats.doneHour, doneDay: stats.doneDay,
        dailyCap, dispatchedDay: stats.dispatchedDay, softCapReached,
      },
    });
  }
  // User answers the parked questions → saved to the profile (locked) → parked
  // jobs whose questions are now all answerable flip back to 'queued'.
  if (req.method === 'POST' && pathname === '/auto-apply/intake') {
    const body = await readJson(req);
    const answers = Array.isArray(body.answers) ? body.answers : [];
    let saved = 0;
    for (const a of answers) {
      if (db.saveIntakeAnswer(a)) saved++;   // routes to the memory of each profile that parked it
    }
    const requeued = db.queueRetryParked();
    broadcast('profileFields.updated', {});
    broadcast('queue.updated', { action: 'intake' });
    return sendJson(res, 200, { ok: true, saved, requeued });
  }
  // Discovery telemetry — the extension SW reports what each search saw so the
  // dashboard can show it (found N, enqueued N, any note) and we can tune.
  if (req.method === 'GET' && pathname === '/auto-apply/discovery-status') {
    return sendJson(res, 200, {
      ok: true, status: db.kvGet('discoveryStatus') || null,
      health: db.discoveryHealth(), batches: db.discoveryBatchList({ limit: 30 }),
    });
  }
  if (req.method === 'POST' && pathname === '/auto-apply/discovery-status') {
    const body = await readJson(req);
    db.kvSet('discoveryStatus', { ...body, at: new Date().toISOString() });
    broadcast('queue.updated', { action: 'discovery-status' });
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST' && pathname === '/auto-apply/discover-now') {
    if (!opts.discovery?.runTick) return sendJson(res, 503, { ok: false, error: 'app discovery service unavailable' });
    const result = await opts.discovery.runTick({ force: true });
    return sendJson(res, 200, result);
  }
  // The extension polls this small queue. It only opens a browser search after the
  // primary provider produced a typed failure; normal/empty JobSpy results never cause
  // duplicate browser scans.
  if (req.method === 'GET' && pathname === '/auto-apply/discovery-fallback/next') {
    return sendJson(res, 200, { ok: true, request: db.discoveryFallbackNext() });
  }
  if (req.method === 'POST' && (jm = m(/^\/auto-apply\/discovery-fallback\/([^/]+)\/complete$/))) {
    const body = await readJson(req);
    const fallback = db.discoveryFallbackComplete(jm[1], { ok: body.ok !== false, error: body.error });
    if (!fallback) return sendJson(res, 404, { ok: false, error: 'fallback request not found' });
    const batch = db.discoveryBatchStart({
      provider: 'browser', source: fallback.source, keyword: fallback.keyword,
      location: fallback.location, fallbackOf: fallback.batch_id,
    });
    let intake = { enqueued: 0, rejected: 0, duplicates: 0, punished: 0 };
    const jobs = Array.isArray(body.jobs) ? body.jobs : [];
    if (body.ok !== false) intake = ingestDiscoveredJobs(fallback.source, jobs, { providerName: 'browser', batchId: batch.id });
    const done = db.discoveryBatchComplete(batch.id, {
      status: body.ok === false ? 'failed' : (jobs.length ? 'ok' : 'empty'),
      found: jobs.length, accepted: intake.enqueued, duplicates: intake.duplicates,
      rejected: intake.rejected + intake.punished, error: body.error,
      diagnostics: { fallbackFor: fallback.batch_id },
    });
    broadcast('discovery.updated', { batch: done });
    return sendJson(res, 200, { ok: true, batch: done, ...intake });
  }
  // "Watch & Teach the next application" FROM THE DASHBOARD. The Electron window can't send
  // chrome.runtime messages, so it sets a one-shot kv flag here; queueNext reads + clears it
  // on the very next dispatch and marks that task mode:'supervised' (Step/Run + Fix-this
  // overlay, on-screen). GET peeks the flag (so the button can reflect "armed").
  if (req.method === 'POST' && pathname === '/auto-apply/supervise-next') {
    db.kvSet('superviseNext', { at: new Date().toISOString() });
    broadcast('queue.updated', { action: 'supervise-next-armed' });
    return sendJson(res, 200, { ok: true, armed: true });
  }
  if (req.method === 'GET' && pathname === '/auto-apply/supervise-next') {
    const flag = db.kvGet('superviseNext') || null;
    return sendJson(res, 200, { ok: true, armed: !!flag, at: flag?.at || null });
  }
  // Pool refresh: re-queue stale retriable (failed, transient) tasks when discovery
  // is exhausted, so the workers aren't starved by an empty queue of already-tried jobs.
  if (req.method === 'POST' && pathname === '/auto-apply/retry-stale') {
    const requeued = db.retryStaleQueue({});
    if (requeued) broadcast('queue.updated', { action: 'retry-stale', requeued });
    return sendJson(res, 200, { ok: true, requeued });
  }

  // ---- punishments [P7] — strict relevance: punish a job / job-type / company ----
  // POST /punish {kind, pattern, profileId?, decayDays?} → insert a punishment; when kind is
  // 'company', immediately cascade-skip that company's QUEUED/scheduled tasks so the block
  // takes effect on the live queue. decayDays defaults to a 90-day decay; 0/null = permanent.
  if (req.method === 'POST' && pathname === '/punish') {
    const body = await readJson(req);
    const profileId = body.profileId || db.ensureDefaultProfileId();
    const p = db.punish({ profileId, kind: body.kind, pattern: body.pattern, weight: body.weight, decayDays: body.decayDays });
    if (!p) return sendJson(res, 400, { ok: false, error: 'invalid kind/pattern (kind ∈ job|job_type|company)' });
    let cascaded = 0;
    if (p.kind === 'company') cascaded = db.punishCompanyCascade(profileId, body.pattern);
    broadcast('queue.updated', { action: 'punish', kind: p.kind, cascaded });
    return sendJson(res, 200, { ok: true, punishment: p, cascaded });
  }
  // POST /unpunish {id} → lift a punishment (restores eligibility).
  if (req.method === 'POST' && pathname === '/unpunish') {
    const body = await readJson(req);
    const removed = db.unpunish(body.id);
    if (removed) broadcast('queue.updated', { action: 'unpunish', id: body.id });
    return sendJson(res, removed ? 200 : 404, { ok: removed });
  }
  // GET /punishments[?profileId=] → the ACTIVE punishments (the "punished" dashboard view).
  if (req.method === 'GET' && pathname === '/punishments') {
    const profileId = parsed.searchParams.get('profileId') || db.ensureDefaultProfileId();
    return sendJson(res, 200, { ok: true, items: db.listPunishments(profileId) });
  }

  // ---- AI ----
  if (req.method === 'GET' && pathname === '/ai/status') {
    return sendJson(res, 200, { ok: true, ...(await provider.statusAll(parsed.searchParams.get('force') === '1')) });
  }
  if (req.method === 'GET' && pathname === '/ai/usage') {
    return sendJson(res, 200, { ok: true, usage: db.aiUsage(), recent: db.aiLogList(50) });
  }

  // ---- AI providers: hardware probe, local setup, subscription connect ----
  if (req.method === 'GET' && pathname === '/hardware') {
    return sendJson(res, 200, { ok: true, ...hardware.probe() });
  }
  if (req.method === 'GET' && pathname === '/ai/local/state') {
    return sendJson(res, 200, { ok: true, state: localsetup.getState() });
  }
  if (req.method === 'POST' && pathname === '/ai/local/detect') {
    // Local off → no probing at all (detect() runs where.exe + pings the Ollama port).
    const lcD = db.getSettings().ai.local || {};
    if (!lcD.enabled) return sendJson(res, 200, { ok: true, installed: false, serverUp: false, models: [], localDisabled: true });
    return sendJson(res, 200, { ok: true, ...(await localsetup.detect(lcD)) });
  }
  if (req.method === 'POST' && pathname === '/ai/local/setup') {
    if (db.getSettings().ai.disabled) {
      return sendJson(res, 400, { ok: false, error: 'AI features are turned off on this computer.' });
    }
    // Clicking "Set up local AI" IS the explicit opt-in — flip the master on so the
    // freshly installed Ollama is actually usable (and future boots may maintain it).
    if (!(db.getSettings().ai.local || {}).enabled) db.patchSettings({ ai: { local: { enabled: true } } });
    const body = await readJson(req);
    const lc = db.getSettings().ai.local;
    const rec = hardware.probe().recommend;
    const models = (Array.isArray(body.models) && body.models.length)
      ? body.models
      : [lc.structuredModel || rec.structured, lc.proseModel || rec.prose];
    localsetup.setup({ models, cfg: lc }).catch(() => {});   // background; progress streams over SSE 'ai.local'
    return sendJson(res, 200, { ok: true, state: localsetup.getState() });
  }
  if (req.method === 'POST' && pathname === '/ai/connect/codex') {
    const r = codexProvider.login ? codexProvider.login() : { ok: false, error: 'not supported' };
    return sendJson(res, 200, { ...r, ok: !!r.ok });
  }
  if (req.method === 'POST' && pathname === '/ai/generate') {
    const body = await readJson(req);
    if (!body.prompt) return sendJson(res, 400, { ok: false, error: 'prompt required' });
    const r = await provider.run({
      kind: body.kind || 'raw', prompt: body.prompt, system: body.system,
      schema: body.schema || null, prose: !!body.prose,
      providerOverride: body.provider || null, modelOverride: body.model || null,
    });
    return sendJson(res, 200, { ok: true, ...r });
  }

  // AI feature endpoints — thin wrappers: load context → prompt builder → provider.
  const aiFeature = async (builder, extra = {}) => {
    const body = await readJson(req);
    const job = body.jobId ? db.getJob(body.jobId) : (body.job || {});
    if (body.jobId && !job) { sendJson(res, 404, { ok: false, error: 'job not found' }); return null; }
    const profile = db.profileForSource(job?.source);
    const resume = body.documentId
      ? db.getDocument(body.documentId, { withText: true })
      : db.defaultDocument('resume');
    return { body, job, profile, resumeText: resume?.textContent || '', resume, ...extra };
  };

  if (req.method === 'POST' && pathname === '/ai/fit-score') {
    const ctx = await aiFeature(); if (!ctx) return;
    const p = prompts.fitScore(ctx);
    // Deterministic score is instant + free; AI refines it.
    const deterministic = fit.score(ctx.job, ctx.profile, ctx.resumeText);
    const r = await provider.run(p);
    if (ctx.body.jobId) {
      db.patchJob(ctx.body.jobId, { fitScore: r.json.score, fitData: { ...r.json, deterministic } });
      broadcast('jobs.updated', { jobId: ctx.body.jobId, action: 'updated' });
    }
    return sendJson(res, 200, { ok: true, result: r.json, deterministic, provider: r.provider });
  }
  if (req.method === 'POST' && pathname === '/ai/cover-letter') {
    const ctx = await aiFeature(); if (!ctx) return;
    // Graceful: cover letters are optional — skip cleanly when AI is unavailable.
    try {
      const r = await provider.run(prompts.coverLetter({ ...ctx, tone: ctx.body.tone }));
      return sendJson(res, 200, { ok: true, text: r.text, provider: r.provider });
    } catch (e) {
      return sendJson(res, 200, { ok: true, text: '', aiUnavailable: true, reason: String(e?.message || e) });
    }
  }
  if (req.method === 'POST' && pathname === '/ai/tailor-resume') {
    const ctx = await aiFeature(); if (!ctx) return;
    if (!ctx.resumeText) return sendJson(res, 400, { ok: false, error: 'no resume text on file — upload a resume in Documents' });
    const r = await provider.run(prompts.tailorResume(ctx));
    if (ctx.body.jobId) {
      db.recordEvent({ jobId: ctx.body.jobId, type: 'resume_tailored', source: 'ai', summary: `Tailored from ${ctx.resume?.name || 'resume'}` });
    }
    return sendJson(res, 200, { ok: true, text: r.text, provider: r.provider });
  }
  if (req.method === 'POST' && pathname === '/ai/answer-question') {
    const body = await readJson(req);
    if (!body.question) return sendJson(res, 400, { ok: false, error: 'question required' });
    const job = body.jobId ? db.getJob(body.jobId) : (body.job || {});
    const profile = db.profileForSource(job?.source);
    const resume = db.defaultDocument('resume');
    const qaHistory = db.answerMemory(body.profileId || db.resolveProfileId(job?.source), 16);
    // Graceful: if AI is unavailable, return no answer (the executor parks the question
    // for the user) instead of a 500 — keeps the run clean on Dad's no-AI machine.
    try {
      const r = await provider.run({
        ...prompts.answerQuestion({
          question: body.question, fieldType: body.fieldType, options: body.options,
          job, profile, qaHistory, resumeText: resume?.textContent || '',
        }),
        // Deterministic floor (P4): if every provider is down/weak, the no-model rules
        // still ground location/education/years/relocation/… so the run keeps applying.
        deterministic: { question: body.question, options: body.options, profile, resume: resume?.textContent || '' },
      });
      return sendJson(res, 200, { ok: true, result: r.json, provider: r.provider });
    } catch (e) {
      return sendJson(res, 200, { ok: true, result: null, aiUnavailable: true, reason: String(e?.message || e) });
    }
  }

  // AI RESCUE: the executor calls this when a step BREAKS (no advance control, stuck, a required
  // field it couldn't detect/answer). We inject the candidate profile + resume + learned memory and
  // ask the configured provider (Claude/OpenAI CLI subscription or key, or local) for the exact next
  // UI actions. Graceful: AI down → { result:null, aiUnavailable } so the executor parks cleanly.
  if (req.method === 'POST' && pathname === '/ai/apply-rescue') {
    const body = await readJson(req);
    const ps = body.pageState || {};
    const job = body.jobId ? db.getJob(body.jobId) : (body.job || {});
    const profile = db.profileForSource(job?.source);
    const resume = db.defaultDocument('resume');
    const qaHistory = db.answerMemory(body.profileId || db.resolveProfileId(job?.source), 16);
    try {
      const r = await provider.run(prompts.applyRescue({
        url: ps.url, routeState: ps.routeState, failureReason: ps.failureReason,
        fields: ps.fields, buttons: ps.buttons, pageText: ps.pageText,
        job, profile, qaHistory, resumeText: resume?.textContent || '',
      }));
      return sendJson(res, 200, { ok: true, result: r.json, provider: r.provider });
    } catch (e) {
      return sendJson(res, 200, { ok: true, result: null, aiUnavailable: true, reason: String(e?.message || e) });
    }
  }
  if (req.method === 'POST' && pathname === '/ai/classify-email') {
    const body = await readJson(req);
    const r = await provider.run(prompts.classifyEmail(body));
    return sendJson(res, 200, { ok: true, result: r.json, provider: r.provider });
  }
  if (req.method === 'POST' && pathname === '/ai/summarize') {
    const ctx = await aiFeature(); if (!ctx) return;
    const r = await provider.run(prompts.summarizeJob(ctx));
    return sendJson(res, 200, { ok: true, text: r.text, provider: r.provider });
  }
  if (req.method === 'POST' && pathname === '/ai/follow-up') {
    const ctx = await aiFeature(); if (!ctx) return;
    const daysSince = ctx.job.submittedAt
      ? Math.round((Date.now() - new Date(ctx.job.submittedAt).getTime()) / 86400000) : null;
    const r = await provider.run(prompts.followUp({ ...ctx, daysSince }));
    return sendJson(res, 200, { ok: true, text: r.text, provider: r.provider });
  }
  if (req.method === 'POST' && pathname === '/ai/resume-parse') {
    const body = await readJson(req);
    const doc = body.documentId ? db.getDocument(body.documentId, { withText: true }) : db.defaultDocument('resume');
    if (!doc?.textContent) return sendJson(res, 400, { ok: false, error: 'no extractable text in that document' });
    // GRACEFUL DEGRADATION: deterministic extraction (contacts/links/name) ALWAYS runs,
    // so resume import works even with no AI at all (Dad's case). AI refines it when
    // available; if every provider fails we return the deterministic fields + a flag.
    const det = deterministicResumeFields(doc.textContent);
    let aiJson = null, prov = 'deterministic', aiUnavailable = false;
    try { const r = await provider.run(prompts.resumeParse({ resumeText: doc.textContent })); aiJson = r.json; prov = r.provider; }
    catch (e) { aiUnavailable = true; log.warn && log.warn('resume-parse AI unavailable, deterministic-only:', e?.message || e); }
    const result = { ...(aiJson || {}) };
    for (const [k, val] of Object.entries(det)) if (!result[k]) result[k] = val;
    return sendJson(res, 200, { ok: true, result, provider: prov, aiUnavailable });
  }
  if (req.method === 'POST' && pathname === '/ai/validate-capture') {
    const ctx = await aiFeature(); if (!ctx) return;
    const r = await provider.run(prompts.validateCapture(ctx));
    return sendJson(res, 200, { ok: true, result: r.json, provider: r.provider });
  }

  // ---- gmail ----
  if (pathname === '/gmail/status' && req.method === 'GET') {
    const gmail = require('./gmail');
    return sendJson(res, 200, { ok: true, ...gmail.status() });
  }
  if (pathname === '/gmail/auth-url' && req.method === 'POST') {
    const gmail = require('./gmail');
    const r = await gmail.startAuth();
    return sendJson(res, r.ok ? 200 : 400, r);
  }
  if (pathname === '/gmail/sync' && req.method === 'POST') {
    const gmail = require('./gmail');
    const r = await gmail.syncNow();
    if (r.updated) broadcast('jobs.updated', { action: 'gmail-sync' });
    return sendJson(res, 200, { ok: true, ...r });
  }

  // ---- email integration (multi-provider IMAP + App Password) ----
  if (pathname === '/email/accounts' && req.method === 'GET') {
    const email = require('./email');
    return sendJson(res, 200, { ok: true, accounts: email.listAccounts().map(email.publicAccount), presets: email.presetsPublic(), stats: db.emailStats(), syncing: email.isSyncing() });
  }
  if (pathname === '/email/accounts' && req.method === 'POST') {
    const email = require('./email');
    const b = await readJson(req);
    if (!b.email || !b.password) return sendJson(res, 400, { ok: false, error: 'email and App Password are required' });
    const acct = email.addAccount(b);
    broadcast('settings.updated', {});
    return sendJson(res, 200, { ok: true, account: email.publicAccount(acct) });
  }
  if (pathname === '/email/accounts/test' && req.method === 'POST') {
    const email = require('./email');
    const b = await readJson(req);
    const acct = b.id ? email.getAccount(b.id) : b;     // test stored creds OR the just-typed ones
    if (!acct || !acct.email || !acct.password) return sendJson(res, 400, { ok: false, error: 'email + App Password required to test' });
    return sendJson(res, 200, await email.testConnection(acct));
  }
  if (pathname === '/email/sync' && req.method === 'POST') {
    const email = require('./email');
    const b = await readJson(req);
    const r = await email.syncAll({ accountId: b.accountId });
    broadcast('jobs.updated', { action: 'email-sync' });
    broadcast('emails.updated', {});
    return sendJson(res, 200, r);
  }
  // Re-run classification + matching over the already-stored inbox (one-shot after an upgrade).
  if (pathname === '/emails/reprocess' && req.method === 'POST') {
    const email = require('./email');
    const r = email.reprocessStored();
    broadcast('emails.updated', {});
    broadcast('jobs.updated', { action: 'email-reprocess' });
    return sendJson(res, 200, { ok: true, ...r });
  }
  const emAcct = pathname.match(/^\/email\/accounts\/([^/]+?)(\/enable)?$/);
  if (emAcct && pathname !== '/email/accounts/test') {
    const email = require('./email');
    if (req.method === 'DELETE') { email.removeAccount(emAcct[1]); broadcast('settings.updated', {}); return sendJson(res, 200, { ok: true }); }
    if (req.method === 'POST' && emAcct[2]) { const b = await readJson(req); email.setEnabled(emAcct[1], b.enabled); return sendJson(res, 200, { ok: true }); }
  }
  if (pathname === '/emails' && req.method === 'GET') {
    const jobId = parsed.searchParams.get('jobId');
    if (jobId) return sendJson(res, 200, { ok: true, matched: db.emailsForJob(jobId), suggested: db.emailSuggestionsForJob(jobId) });
    return sendJson(res, 200, { ok: true, emails: db.listEmails({ q: parsed.searchParams.get('q') || '', unmatchedOnly: parsed.searchParams.get('unmatched') === '1' }) });
  }
  if (pathname === '/emails/match' && req.method === 'POST') {
    const b = await readJson(req);
    const r = db.setEmailMatch(b.emailId, { jobId: b.jobId || null, source: b.source, confidence: b.confidence });
    broadcast('emails.updated', {});
    return sendJson(res, r ? 200 : 404, { ok: !!r, email: r });
  }
  // The confirm-this-link inbox (P6): 'suggested' emails with a candidate job, for one-click
  // confirm/dismiss. Confirming heals the link AND trains the matcher AND releases the reward.
  if (pathname === '/emails/needs-confirm' && req.method === 'GET') {
    const pid = parsed.searchParams.get('profileId') || null;
    return sendJson(res, 200, { ok: true, items: db.emailsNeedingConfirm(pid) });
  }
  if (pathname === '/emails/confirm' && req.method === 'POST') {
    const b = await readJson(req);
    const r = db.confirmEmailLink(b.emailId, { jobId: b.jobId || null, confirm: b.confirm === true });
    broadcast('emails.updated', {});
    if (r.ok) broadcast('jobs.updated', { action: 'email-confirm' });
    return sendJson(res, r.ok ? 200 : 400, r);
  }

  // ---- data ----
  if (req.method === 'GET' && pathname === '/export') {
    const data = db.exportAll();
    if (data.settings) stripSettingSecrets(data.settings);   // never export API keys / OAuth secret
    return sendJson(res, 200, { ok: true, data });
  }
  if (req.method === 'POST' && pathname === '/wipe') {
    const body = await readJson(req);
    if (body.confirm !== true) return sendJson(res, 400, { ok: false, error: 'confirm:true required' });
    const r = db.wipeAllData();
    broadcast('jobs.updated', { action: 'wipe' });
    broadcast('emails.updated', {});
    broadcast('settings.updated', {});
    return sendJson(res, 200, { ok: true, ...r });
  }
  if (req.method === 'POST' && pathname === '/import') {
    const body = await readJson(req);
    const r = db.importAll(body.data || body);
    broadcast('jobs.updated', { action: 'import' });
    return sendJson(res, 200, { ok: true, ...r });
  }
  // Bulk-import scraped pre-existing applications (LinkedIn/Indeed "applied jobs").
  if (req.method === 'POST' && pathname === '/import/applications') {
    const body = await readJson(req);
    const r = db.bulkImportApplications(body.jobs || body.items || [], { source: body.source });
    broadcast('jobs.updated', { action: 'import' });
    return sendJson(res, 200, { ok: true, ...r });
  }
  if (req.method === 'POST' && pathname === '/backup') {
    const dest = db.backupNow('manual-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
    return sendJson(res, dest ? 200 : 500, { ok: !!dest, path: dest });
  }

  return sendJson(res, 404, { ok: false, error: 'not found' });
}

// ============================================================
// Lifecycle
// ============================================================
function startServer(port, options) {
  opts = options;
  localsetup.setEmitter((st) => broadcast('ai.local', st));   // stream setup progress to the dashboard
  return new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      // DNS-rebinding guard (private-range hosts allowed only when LAN remote access is ON)
      if (!hostAllowed(req.headers.host || '')) {
        return sendJson(res, 403, { ok: false, error: 'bad host' });
      }
      // CORS: token is the access control; echo origin so extension pages can read.
      const origin = req.headers.origin;
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-JAT-Token');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      const parsed = new URL(req.url, `http://${req.headers.host}`);
      try {
        await handle(req, res, parsed);
      } catch (e) {
        // User-facing conditions surface their real message; only unexpected throws hide behind
        // 'internal error'. AI_DISABLED is the Dad's-laptop master switch; the others are the
        // provider chain's honest "nothing configured / still setting up" states.
        const SURFACED = new Set(['AI_DISABLED', 'NO_PROVIDER', 'AI_SETTING_UP']);
        const status = e.status || (SURFACED.has(e.code) ? 400 : 500);
        log.error(req.method, parsed.pathname, e);
        if (!res.headersSent) {
          sendJson(res, status, { ok: false, code: e.code, error: status === 500 ? 'internal error' : String(e.message || e) });
        }
      }
    });
    server.on('error', reject);
    // Bind loopback-only unless the user opted into LAN remote access (Settings ▸ Remote access).
    // Every data route is token-gated either way; remote just widens WHO can reach the listener.
    let host = '127.0.0.1';
    try { if (db.getSettings().server.remoteAccess) host = '0.0.0.0'; } catch {}
    server.listen(port, host, () => {
      log.info(`listening on ${host}:${port}${host === '0.0.0.0' ? ' (LAN remote access ENABLED)' : ''}`);
      resolve(server);
    });
  });
}

function stopServer() {
  for (const c of sseClients) { try { c.end(); } catch {} }
  sseClients.clear();
  if (server) { try { server.close(); } catch {} server = null; }
}

module.exports = { startServer, stopServer, broadcast, getToken, rescanAllFolders, startFolderWatchers, ingestDiscoveredJobs, jobFit, easyApplyIngestEligible, queueNext, hostAllowed };
