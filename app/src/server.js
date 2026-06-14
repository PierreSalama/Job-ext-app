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

let server = null;
let sseClients = new Set();
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
  return 2;
}
const SENIORITY_CAP = { any: 99, senior: 3, mid: 2, entry: 1 };
function jobFit(title, aa) {
  const cap = SENIORITY_CAP[aa && aa.seniorityMax] ?? 99;
  if (jobLevel(title) > cap) return { ok: false, reason: `above your level cap (${aa.seniorityMax})` };
  const t = String(title || '').toLowerCase();
  for (const kw of (aa && aa.excludeKeywords) || []) {
    const k = String(kw || '').trim().toLowerCase();
    if (k && t.includes(k)) return { ok: false, reason: `excluded keyword "${k}"` };
  }
  return { ok: true };
}

function withinWindow(settings) {
  if (settings.runAnytime !== false) return true;                  // 24/7 (default) — ignore the window
  if (!settings.windowStart || !settings.windowEnd) return true;   // no window = any time
  const [sh, sm] = String(settings.windowStart).split(':').map(Number);
  const [eh, em] = String(settings.windowEnd).split(':').map(Number);
  const nowD = new Date();
  const mins = nowD.getHours() * 60 + nowD.getMinutes();
  return mins >= sh * 60 + (sm || 0) && mins <= eh * 60 + (em || 0);
}

// Decide whether a task may run now. Returns { task, context } or { wait }.
// force=true (the dashboard "Test: apply now" button) skips the window/cap/gap
// pacing so the user can shake it out immediately — but still needs enabled.
async function queueNext(force = false) {
  const s = db.getSettings().autoApply;
  if (!s.enabled) return { task: null, reason: 'disabled' };
  if (!force) {
    if (!withinWindow(s)) return { task: null, reason: 'outside-window' };
    const stats = db.queueRunStats();
    if (stats.doneDay >= s.maxPerDay) return { task: null, reason: 'daily-cap' };
    if (stats.doneHour >= s.maxPerHour) return { task: null, reason: 'hourly-cap' };
    if (stats.lastRun) {
      const gapMin = s.minGapMinutes + Math.random() * Math.max(0, s.maxGapMinutes - s.minGapMinutes);
      const eligibleAt = new Date(stats.lastRun).getTime() + gapMin * 60000;
      if (Date.now() < eligibleAt) {
        return { task: null, reason: 'gap', nextEligibleAt: new Date(eligibleAt).toISOString() };
      }
    }
  }

  const queued = db.queueList({ state: 'queued' });
  if (!queued.length) return { task: null, reason: 'empty' };
  const task = queued[queued.length - 1]; // oldest (list is DESC)

  const job = db.getJob(task.jobId);
  if (!job || !job.jobUrl) {
    db.queuePatch(task.id, { state: 'failed', lastError: 'job missing or has no URL' });
    return { task: null, reason: 'bad-task' };
  }

  // Honour the explicit picks from the Auto-apply page; fall back to the
  // source-matched profile, then to one DERIVED from learned answers (so it
  // works even with no saved profile), then the active résumé.
  const profile = (s.profileId && db.listProfiles().find((p) => p.id === s.profileId))
    || db.profileForSource(job.source) || db.deriveProfileFromLearned();
  const resume = (s.resumeDocId && db.getDocument(s.resumeDocId, { withText: true })) || db.defaultDocument('resume');
  const harvested = db.profileFieldList().filter((f) => f.value);
  const siteCfg = s.sites?.[String(job.source || '').toLowerCase()] || {};
  const mode = siteCfg.mode || task.mode || s.mode;

  db.queuePatch(task.id, {
    state: 'scheduled',
    scheduledAt: new Date().toISOString(),
    transcriptAppend: { note: `scheduled (mode=${mode})` },
  });
  broadcast('queue.updated', { taskId: task.id, state: 'scheduled' });

  return {
    task: { ...task, mode },
    context: {
      job,
      profile: profile || null,
      harvested,
      resume: resume ? {
        id: resume.id, name: resume.name, mime: resume.mime,
      } : null,
      aiConfidenceMin: s.aiAnswerConfidenceMin,
      // Fit filters the executor re-checks against the live job page (a manually
      // queued job can bypass the discovery gate; and only the page has the
      // "needs N years" requirement text).
      fit: { experienceYears: s.experienceYears || 0, seniorityMax: s.seniorityMax || 'any', excludeKeywords: s.excludeKeywords || [] },
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

// High-precision deterministic resume fields — merged with the AI parse so the
// import still fills the obvious things (contacts, links) even when AI is slow,
// unavailable, or returns little.
function deterministicResumeFields(text) {
  const t = String(text || '');
  const out = {};
  const email = t.match(/[\w.+-]+@[\w-]+\.[\w.-]+\.?\w+/);
  if (email) out.email = email[0].replace(/\.$/, '');
  const phone = t.match(/(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/);
  if (phone) out.phone = phone[0].trim();
  const li = t.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/[\w\-/%]+/i);
  if (li) out.linkedinUrl = li[0];
  const gh = t.match(/(?:https?:\/\/)?(?:www\.)?github\.com\/[\w\-/%]+/i);
  if (gh) out.githubUrl = gh[0];
  const site = t.match(/https?:\/\/(?!.*(?:linkedin|github)\.com)[\w.-]+\.[a-z]{2,}(?:\/[\w\-/%.#?=&]*)?/i);
  if (site) out.portfolioUrl = site[0];
  return out;
}

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
    const body = await readJson(req);
    const info = { client: String(body.client || 'unknown').slice(0, 60), origin: req.headers.origin || '' };
    const allowed = await opts.confirmPair(info);
    if (!allowed) return sendJson(res, 403, { ok: false, error: 'pairing rejected' });
    log.info('paired client', info);
    return sendJson(res, 200, { ok: true, token: getToken() });
  }

  // ---- everything else requires the token ----
  if (!authed(req, parsed)) {
    return sendJson(res, 401, { ok: false, error: 'unauthorized', pairHint: 'POST /pair' });
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
        limit: parsed.searchParams.get('limit') || undefined,
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

  // ---- settings ----
  if (req.method === 'GET' && pathname === '/settings') {
    return sendJson(res, 200, { ok: true, settings: db.getSettings() });
  }
  if (req.method === 'PATCH' && pathname === '/settings') {
    const body = await readJson(req);
    // Stamp/clear the "running for" timer on the auto-apply on→off transition.
    if (body.autoApply && typeof body.autoApply.enabled === 'boolean') {
      const wasOn = !!db.getSettings().autoApply.enabled;
      if (body.autoApply.enabled && !wasOn) body.autoApply.startedAt = new Date().toISOString();
      else if (!body.autoApply.enabled) body.autoApply.startedAt = '';
    }
    const settings = db.patchSettings(body);
    broadcast('settings.updated', {});
    return sendJson(res, 200, { ok: true, settings });
  }

  // ---- qa ----
  if (req.method === 'GET' && pathname === '/qa') {
    return sendJson(res, 200, { ok: true, items: db.qaList(Number(parsed.searchParams.get('limit')) || 500) });
  }
  if (req.method === 'POST' && pathname === '/qa') {
    const body = await readJson(req);
    if (!body.question || body.answer == null) return sendJson(res, 400, { ok: false, error: 'question + answer required' });
    return sendJson(res, 200, { ok: true, item: db.qaRecord(body) });
  }
  if (req.method === 'POST' && pathname === '/qa/lookup') {
    const body = await readJson(req);
    return sendJson(res, 200, { ok: true, match: db.qaLookup(body.question || '') });
  }
  if (req.method === 'DELETE' && (jm = m(/^\/qa\/([^/]+)$/))) {
    return sendJson(res, db.qaDelete(jm[1]) ? 200 : 404, { ok: true });
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
    return sendJson(res, 200, { ok: true, items: db.profileFieldList() });
  }
  if (req.method === 'POST' && pathname === '/profile-fields') {
    const body = await readJson(req);
    if (!body.question) return sendJson(res, 400, { ok: false, error: 'question required' });
    // A manual add/edit from the dashboard is authoritative → high confidence + locked.
    const item = db.profileFieldUpsert({ ...body, confidence: 1, fromUser: true });
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
  // Build the profile store from EVERY past application's answers.
  if (req.method === 'POST' && pathname === '/profile-fields/backfill') {
    const r = db.backfillProfileFromJobs();
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
    const task = db.queueAdd(body.jobId, { mode: body.mode });
    if (!task) return sendJson(res, 404, { ok: false, error: 'job not found' });
    broadcast('queue.updated', { taskId: task.id, state: task.state });
    return sendJson(res, 200, { ok: true, task });
  }
  if (req.method === 'PATCH' && (jm = m(/^\/queue\/([^/]+)$/))) {
    const body = await readJson(req);
    const task = db.queuePatch(jm[1], body);
    if (!task) return sendJson(res, 404, { ok: false, error: 'not found' });
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
    const s = db.getSettings().autoApply;
    let enqueued = 0, filtered = 0;
    for (const jd of jobs.slice(0, 50)) {
      if (!jd || !jd.jobUrl) continue;
      // Relevance gate — don't even queue roles above the user's level / excluded.
      const fit = jobFit(jd.title, s);
      if (!fit.ok) { filtered++; continue; }
      const r = db.transaction(() => {
        const up = db.upsertJob({
          externalId: jd.externalId, source: body.source || jd.source || null,
          title: jd.title, company: jd.company, location: jd.location,
          jobUrl: jd.jobUrl, status: 'started', tags: ['auto-apply'],
        });
        if (up.action === 'created') {
          db.recordEvent({ jobId: up.job.id, type: 'created', source: 'auto-apply', summary: 'Discovered via auto-apply', data: {} });
        }
        return { job: up.job, task: db.queueAdd(up.job.id, { mode: s.mode }) };
      });
      if (r.task) enqueued++;
    }
    broadcast('queue.updated', { action: 'discover' });
    broadcast('jobs.updated', { action: 'discover' });
    return sendJson(res, 200, { ok: true, enqueued, filtered });
  }
  // The deduped list of questions parked jobs are waiting on (the intake form).
  if (req.method === 'GET' && pathname === '/queue/parked') {
    return sendJson(res, 200, { ok: true, items: db.queueParkedQuestions() });
  }
  // Auto-apply outcome history (the "submissions data" view): ?days=N[&state=]
  if (req.method === 'GET' && pathname === '/auto-apply/history') {
    const days = Number(parsed.searchParams.get('days')) || 7;
    const state = parsed.searchParams.get('state') || undefined;
    return sendJson(res, 200, { ok: true, ...db.queueHistory({ days, state }) });
  }
  // User answers the parked questions → saved to the profile (locked) → parked
  // jobs whose questions are now all answerable flip back to 'queued'.
  if (req.method === 'POST' && pathname === '/auto-apply/intake') {
    const body = await readJson(req);
    const answers = Array.isArray(body.answers) ? body.answers : [];
    let saved = 0;
    for (const a of answers) {
      if (!a || !a.question || a.value == null || String(a.value).trim() === '') continue;
      if (db.profileFieldUpsert({ question: a.question, value: a.value, fieldType: a.fieldType, fromUser: true, confidence: 1 })) saved++;
    }
    const requeued = db.queueRetryParked();
    broadcast('profileFields.updated', {});
    broadcast('queue.updated', { action: 'intake' });
    return sendJson(res, 200, { ok: true, saved, requeued });
  }
  // Discovery telemetry — the extension SW reports what each search saw so the
  // dashboard can show it (found N, enqueued N, any note) and we can tune.
  if (req.method === 'GET' && pathname === '/auto-apply/discovery-status') {
    return sendJson(res, 200, { ok: true, status: db.kvGet('discoveryStatus') || null });
  }
  if (req.method === 'POST' && pathname === '/auto-apply/discovery-status') {
    const body = await readJson(req);
    db.kvSet('discoveryStatus', { ...body, at: new Date().toISOString() });
    broadcast('queue.updated', { action: 'discovery-status' });
    return sendJson(res, 200, { ok: true });
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
    return sendJson(res, 200, { ok: true, ...(await localsetup.detect(db.getSettings().ai.local)) });
  }
  if (req.method === 'POST' && pathname === '/ai/local/setup') {
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
    const r = await provider.run(prompts.coverLetter({ ...ctx, tone: ctx.body.tone }));
    return sendJson(res, 200, { ok: true, text: r.text, provider: r.provider });
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
    const qaHistory = db.qaList(12);
    const r = await provider.run(prompts.answerQuestion({
      question: body.question, fieldType: body.fieldType, options: body.options,
      job, profile, qaHistory, resumeText: resume?.textContent || '',
    }));
    return sendJson(res, 200, { ok: true, result: r.json, provider: r.provider });
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
    const r = await provider.run(prompts.resumeParse({ resumeText: doc.textContent }));
    // Merge: AI result wins where it has a value; deterministic extraction fills
    // the gaps so contacts/links always come through.
    const result = { ...(r.json || {}) };
    const det = deterministicResumeFields(doc.textContent);
    for (const [k, val] of Object.entries(det)) if (!result[k]) result[k] = val;
    return sendJson(res, 200, { ok: true, result, provider: r.provider });
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

  // ---- data ----
  if (req.method === 'GET' && pathname === '/export') {
    return sendJson(res, 200, { ok: true, data: db.exportAll() });
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
      // DNS-rebinding guard
      if (!HOST_RX.test(req.headers.host || '')) {
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
        const status = e.status || 500;
        log.error(req.method, parsed.pathname, e);
        if (!res.headersSent) {
          sendJson(res, status, { ok: false, error: status === 500 ? 'internal error' : String(e.message || e) });
        }
      }
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function stopServer() {
  for (const c of sseClients) { try { c.end(); } catch {} }
  sseClients.clear();
  if (server) { try { server.close(); } catch {} server = null; }
}

module.exports = { startServer, stopServer, broadcast, getToken, rescanAllFolders, startFolderWatchers };
