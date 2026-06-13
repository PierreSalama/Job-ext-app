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
const { extractText } = require('./ai/extract');
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
function withinWindow(settings) {
  const [sh, sm] = String(settings.windowStart || '00:00').split(':').map(Number);
  const [eh, em] = String(settings.windowEnd || '23:59').split(':').map(Number);
  const nowD = new Date();
  const mins = nowD.getHours() * 60 + nowD.getMinutes();
  return mins >= sh * 60 + (sm || 0) && mins <= eh * 60 + (em || 0);
}

// Decide whether a task may run now. Returns { task, context } or { wait }.
async function queueNext() {
  const s = db.getSettings().autoApply;
  if (!s.enabled) return { task: null, reason: 'disabled' };
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

  const queued = db.queueList({ state: 'queued' });
  if (!queued.length) return { task: null, reason: 'empty' };
  const task = queued[queued.length - 1]; // oldest (list is DESC)

  const job = db.getJob(task.jobId);
  if (!job || !job.jobUrl) {
    db.queuePatch(task.id, { state: 'failed', lastError: 'job missing or has no URL' });
    return { task: null, reason: 'bad-task' };
  }

  const profile = db.profileForSource(job.source);
  const resume = db.defaultDocument('resume');
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
      resume: resume ? {
        id: resume.id, name: resume.name, mime: resume.mime,
      } : null,
      aiConfidenceMin: s.aiAnswerConfidenceMin,
    },
  };
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

  // ---- documents ----
  if (req.method === 'GET' && pathname === '/documents') {
    return sendJson(res, 200, { ok: true, items: db.listDocuments() });
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

  // ---- auto-apply queue ----
  if (req.method === 'GET' && pathname === '/queue') {
    return sendJson(res, 200, { ok: true, items: db.queueList({ state: parsed.searchParams.get('state') || undefined }) });
  }
  if (req.method === 'GET' && pathname === '/queue/next') {
    return sendJson(res, 200, { ok: true, ...(await queueNext()) });
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
    if (opts.notify && ['awaiting_review', 'awaiting_input', 'done', 'failed'].includes(task.state)) {
      opts.notify('autoApply', task);
    }
    return sendJson(res, 200, { ok: true, task });
  }
  if (req.method === 'DELETE' && (jm = m(/^\/queue\/([^/]+)$/))) {
    const okDel = db.queueDelete(jm[1]);
    broadcast('queue.updated', { taskId: jm[1], state: 'deleted' });
    return sendJson(res, okDel ? 200 : 404, { ok: okDel });
  }

  // ---- AI ----
  if (req.method === 'GET' && pathname === '/ai/status') {
    return sendJson(res, 200, { ok: true, ...(await provider.statusAll(parsed.searchParams.get('force') === '1')) });
  }
  if (req.method === 'GET' && pathname === '/ai/usage') {
    return sendJson(res, 200, { ok: true, usage: db.aiUsage(), recent: db.aiLogList(50) });
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
    return sendJson(res, 200, { ok: true, result: r.json, provider: r.provider });
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

module.exports = { startServer, stopServer, broadcast, getToken };
