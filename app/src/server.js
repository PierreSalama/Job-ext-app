// Local sync HTTP server on :7733.
//
// Two surfaces:
//   1. REST  — for the Chrome extension to push/pull and for ad-hoc curl/test.
//   2. /rpc  — single JSON envelope { type, data } used by the desktop UI's
//              window.jat5.api(). Mirrors the extension's chrome.runtime.sendMessage
//              dispatcher so app.js works unchanged.
//
// Stack: Node built-in http only (no Express dep) per the spec.
// Concurrency: better-sqlite3 is synchronous, so we just call it inline.
// AI: 'ai-call' / 'ai-status' are forwarded to Ollama directly via fetch.

const http = require('http');
const url = require('url');
const crypto = require('crypto');

const PORT = 7733;
// Read the actual app version from package.json so /health and /version
// always report what the user actually has installed.
let VERSION = '8.0.0';
try { VERSION = require('../package.json').version; } catch {}

// ---------- Minimal WebSocket implementation ----------
// We only need short text frames (<= 65535 bytes — covers JSON event payloads).
// Implements just enough of RFC 6455 to send/receive single-frame text messages.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const wsClients = new Set();

function wsAcceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function wsEncodeText(str) {
  const payload = Buffer.from(String(str), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text frame
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    // 64-bit length — high 32 bits zero
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

function wsDecodeFrame(buf) {
  // Returns { opcode, payload, total } or null if incomplete
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) === 0x80;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    // Truncate to lower 32 bits — we don't accept frames > 4GB anyway
    len = buf.readUInt32BE(6);
    offset = 10;
  }
  let mask;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.slice(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  let payload = buf.slice(offset, offset + len);
  if (masked) {
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
    payload = out;
  }
  return { opcode, payload, total: offset + len };
}

function wsBroadcast(obj) {
  const frame = wsEncodeText(JSON.stringify(obj));
  for (const sock of wsClients) {
    try { sock.write(frame); } catch {}
  }
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  const accept = wsAcceptKey(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  wsClients.add(socket);
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const frame = wsDecodeFrame(buffer);
      if (!frame) break;
      buffer = buffer.slice(frame.total);
      if (frame.opcode === 0x8) { // close
        try { socket.end(); } catch {}
        wsClients.delete(socket);
        return;
      } else if (frame.opcode === 0x9) { // ping → pong
        const pong = Buffer.from([0x8a, 0]);
        try { socket.write(pong); } catch {}
      }
      // Ignore inbound text frames — extension only listens, not talks here
    }
  });
  const cleanup = () => { wsClients.delete(socket); };
  socket.on('end', cleanup);
  socket.on('close', cleanup);
  socket.on('error', cleanup);
  // Send hello so the extension knows the channel is live
  try { socket.write(wsEncodeText(JSON.stringify({ type: 'hello', version: VERSION }))); } catch {}
}

// ---------- Shared status logic (mirrors lib/schema.js) ----------
const STATUSES = [
  'started', 'submitted', 'received', 'reviewing', 'recruiter_replied',
  'interview', 'assessment', 'offer', 'rejected', 'withdrawn', 'archived'
];
const STATUS_PRIORITY = Object.fromEntries(STATUSES.map((s, i) => [s, i + 1]));
function normalizeStatus(s) {
  const v = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return STATUSES.includes(v) ? v : 'started';
}

// ---------- HTTP helpers ----------
function setCors(res) {
  // Allow the extension's chrome-extension://<id> origin and dev tools.
  // Browsers don't accept wildcard subdomains for chrome-extension, so we just
  // echo back what the request sends.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function send(res, status, body, extraHeaders = {}) {
  setCors(res);
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  if (body == null) { res.statusCode = status; res.end(); return; }
  if (Buffer.isBuffer(body)) { res.statusCode = status; res.end(body); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = status;
  res.end(JSON.stringify(body));
}
function readJson(req, limitBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > limitBytes) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) return resolve(null);
      try { resolve(JSON.parse(buf.toString('utf8'))); }
      catch (e) { reject(new Error('Invalid JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

// ---------- AI passthrough (simple Ollama call) ----------
// The desktop main process can talk straight to localhost:11434 — no
// extension-style header rewriting needed. We expose just enough surface
// for the UI's coverLetter / summarize / score / etc. features.
async function aiStatus(settings) {
  const baseUrl = settings.ollamaUrl || 'http://localhost:11434';
  try {
    const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return { provider: 'none', available: false, reason: `Ollama HTTP ${r.status}` };
    const data = await r.json();
    const models = (data.models || []).map((m) => m.name);
    const want = settings.ollamaModel || 'gemma4:e4b';
    const has = models.includes(want);
    return {
      provider: 'ollama',
      available: has,
      model: has ? want : (models[0] || ''),
      models,
      reason: has ? '' : `Model "${want}" not pulled. Available: ${models.join(', ') || '(none)'}`
    };
  } catch (e) {
    return { provider: 'none', available: false, reason: `Ollama unreachable at ${baseUrl}: ${e.message}` };
  }
}

async function ollamaChat(settings, prompt, { format } = {}) {
  const baseUrl = settings.ollamaUrl || 'http://localhost:11434';
  const model = settings.ollamaModel || 'gemma4:e4b';
  const body = {
    model, prompt, stream: false,
    options: { temperature: 0.4 }
  };
  if (format === 'json') body.format = 'json';
  const r = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(135000)
  });
  if (!r.ok) throw new Error(`Ollama HTTP ${r.status}`);
  const data = await r.json();
  return data.response || '';
}

async function aiCall(data, settings) {
  // Minimal prompt templates — enough to wire up the UI. Falls back to the
  // model with a free-form prompt for less common features.
  const f = data.feature;
  const job = data.job || {};
  const profile = data.profile || {};
  const summary = (j) => `Title: ${j.title || ''}\nCompany: ${j.company || ''}\nLocation: ${j.location || ''}\nDescription: ${(j.description || '').slice(0, 4000)}`;
  switch (f) {
    case 'summarize': {
      const text = await ollamaChat(settings, `Summarize this job in 3 short bullets and list 3 key skills required. Use plain text.\n\n${summary(job)}`);
      return { text };
    }
    case 'score': {
      const text = await ollamaChat(settings,
        `On a scale of 0-100, how well does this candidate match this job? Respond with JSON {"score": N, "reasons": ["..."], "gaps": ["..."]}.\n\nCandidate: ${JSON.stringify(profile).slice(0, 2000)}\n\nJob:\n${summary(job)}`,
        { format: 'json' });
      try { return JSON.parse(text); } catch { return { score: 0, reasons: [], gaps: [], raw: text }; }
    }
    case 'coverLetter': {
      const text = await ollamaChat(settings,
        `Write a concise, professional cover letter (200-300 words) for this candidate applying to the job below. No greeting placeholders — use "${profile.firstName || 'the candidate'} ${profile.lastName || ''}" directly.\n\nCandidate: ${JSON.stringify(profile).slice(0, 2000)}\n\nJob:\n${summary(job)}`);
      return { text };
    }
    case 'skills': {
      const text = await ollamaChat(settings,
        `Extract a JSON array of skill names (strings) required by this job. Output ONLY a JSON array.\n\n${summary(job)}`,
        { format: 'json' });
      try {
        const parsed = JSON.parse(text);
        return { skills: Array.isArray(parsed) ? parsed : (parsed.skills || []) };
      } catch { return { skills: [], raw: text }; }
    }
    case 'questions': {
      const text = await ollamaChat(settings,
        `Generate 8 likely interview questions for this job. Output as a JSON array of strings.\n\n${summary(job)}`,
        { format: 'json' });
      try {
        const parsed = JSON.parse(text);
        return { questions: Array.isArray(parsed) ? parsed : (parsed.questions || []) };
      } catch { return { questions: [], raw: text }; }
    }
    case 'followup': {
      const text = await ollamaChat(settings,
        `Write a polite follow-up email (under 120 words) for this application. Sign as "${profile.firstName || ''} ${profile.lastName || ''}".\n\nJob:\n${summary(job)}`);
      return { text };
    }
    case 'insights': {
      const jobs = data.jobs || [];
      const text = await ollamaChat(settings,
        `Given these ${jobs.length} job applications, write 3-5 short insights about the user's job-search patterns.\n\n${JSON.stringify(jobs.slice(0, 30).map((j) => ({ title: j.title, company: j.company, status: j.status })))}`);
      return { text };
    }
    case 'recommend': {
      const jobs = data.jobs || [];
      const text = await ollamaChat(settings,
        `Based on this user's recent applications and profile, suggest 8 search queries (string array) for finding similar jobs. Output ONLY a JSON array of strings.\n\nApplications: ${JSON.stringify(jobs.slice(0, 20).map((j) => ({ title: j.title, company: j.company })))}\n\nProfile skills: ${JSON.stringify(profile.skills || [])}`,
        { format: 'json' });
      try {
        const parsed = JSON.parse(text);
        return { queries: Array.isArray(parsed) ? parsed : (parsed.queries || []) };
      } catch { return { queries: [], raw: text }; }
    }
    default: {
      // Best-effort generic prompt
      const text = await ollamaChat(settings, `AI feature "${f}" with payload:\n${JSON.stringify(data).slice(0, 4000)}`);
      return { text };
    }
  }
}

// ---------- /rpc dispatcher (mirrors background.js) ----------
// Broadcasts an event to all WebSocket clients AND the local Electron renderer.
let _localBroadcast = null;
function setLocalBroadcast(fn) { _localBroadcast = fn; }
// v8.0.5: bridge from server.js (HTTP) into main.js (electron-updater). main.js
// installs the actual handlers when it boots so this stays decoupled.
let _updateBridge = null;
function setUpdateBridge(fns) { _updateBridge = fns || null; }
function broadcastSync(name, data) {
  const msg = { type: 'event', name, data };
  wsBroadcast(msg);
  if (_localBroadcast) {
    try { _localBroadcast({ type: 'jat-event', name, data }); } catch {}
  }
}

async function dispatchRpc(db, msg) {
  const { type, data = {} } = msg || {};
  switch (type) {
    case 'capture': {
      const settings = db.getSettings();
      const result = db.upsertJob(data, { statusPriority: STATUS_PRIORITY, normalizeStatus });
      // Auto follow-up date if applied
      if (result.job?.applied && !result.job.followUpDueAt) {
        const days = settings.defaultFollowUpDays || 10;
        const due = new Date(Date.now() + days * 86400000).toISOString();
        const j = db.patchJobShallow(result.job.id, { followUpDueAt: due });
        result.job = j;
      }
      broadcastSync(result.action === 'created' ? 'job.created' : 'job.updated', { job: result.job });
      return { ok: true, action: result.action, job: result.job };
    }
    case 'list-jobs':       return { ok: true, items: db.listJobs() };
    case 'get-job':         return { ok: true, job: db.getJob(data.id) };
    case 'patch-job': {
      const j = db.patchJobShallow(data.id, data.patch || {});
      if (j) broadcastSync('job.updated', { job: j });
      return { ok: !!j, job: j };
    }
    case 'delete-job':      db.deleteJob(data.id); broadcastSync('job.deleted', { id: data.id }); return { ok: true };
    case 'status-summary':  return { ok: true, summary: db.statusSummary() };

    case 'get-settings':    return { ok: true, settings: db.getSettings() };
    case 'patch-settings':  {
      const settings = db.patchSettings(data || {});
      broadcastSync('settings.updated', { settings });
      return { ok: true, settings };
    }

    // Icon bundles aren't meaningful in the desktop window (no toolbar action).
    // Accept the call so the UI doesn't error out, but no-op.
    case 'set-icon-bundle': return { ok: true };

    case 'get-profile':     return { ok: true, profile: db.getProfile() };
    case 'patch-profile':   {
      const profile = db.patchProfile(data || {});
      broadcastSync('profile.updated', { profile });
      return { ok: true, profile };
    }

    case 'list-documents':  return { ok: true, items: db.listDocuments() };
    case 'add-document':    return { ok: true, doc: db.addDocument(data) };
    case 'patch-document':  return { ok: true, doc: db.patchDocument(data.id, data.patch || {}) };
    case 'delete-document': db.deleteDocument(data.id); return { ok: true };

    case 'list-notifications': return { ok: true, items: db.listNotifications() };

    case 'record-answer':   return { ok: true, entry: db.recordAnswer(data || {}) };
    case 'lookup-answer':   return { ok: true, answer: db.lookupAnswer(data?.question || '') };
    case 'list-answers':    return { ok: true, items: db.listAnswers() };
    case 'delete-answer':   db.deleteAnswer(data.key); return { ok: true };

    case 'list-recommendations': return { ok: true, items: db.listRecommendations() };
    case 'persist-recommendations': {
      const queries = Array.isArray(data?.queries) ? data.queries : [];
      const items = queries.map((q) => ({
        query: q,
        urls: [
          { label: 'LinkedIn', url: `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(q)}` },
          { label: 'Indeed',   url: `https://www.indeed.com/jobs?q=${encodeURIComponent(q)}` }
        ]
      }));
      db.saveRecommendations(items);
      return { ok: true, items };
    }

    case 'list-logs': return { ok: true, items: db.listLogs(data?.limit || 200) };
    case 'log':       db.appendLog(data?.level || 'info', data?.ctx || 'unknown', data?.message || '', data?.data); return { ok: true };

    case 'open-app':  return { ok: true }; // already in the app
    case 'ai-status': return { ok: true, status: await aiStatus(db.getSettings()) };
    case 'ai-call': {
      try {
        const result = await aiCall(data, db.getSettings());
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    }
    default: return { ok: false, error: `Unknown type: ${type}` };
  }
}

// ---------- Server ----------
function startServer(db) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { send(res, 204, null); return; }
    const u = url.parse(req.url, true);
    const p = u.pathname;
    try {
      // Health
      if (p === '/health' && req.method === 'GET') return send(res, 200, { ok: true, version: VERSION, ws: true });

      // v8.0.5: explicit version endpoint for the extension's update probe
      if (p === '/version' && req.method === 'GET') {
        return send(res, 200, { ok: true, version: VERSION });
      }

      // v8.0.5: extension-triggered desktop-app update.
      // GET  /app-update/status      -> { current, latest?, available? }
      // POST /app-update/check       -> kicks off electron-updater check
      // POST /app-update/install     -> quits and installs the staged update
      if (p === '/app-update/status' && req.method === 'GET') {
        if (!_updateBridge?.status) return send(res, 200, { ok: true, current: VERSION, available: false });
        try { return send(res, 200, { ok: true, ...(await _updateBridge.status()) }); }
        catch (e) { return send(res, 500, { ok: false, error: String(e?.message || e) }); }
      }
      if (p === '/app-update/check' && req.method === 'POST') {
        if (!_updateBridge?.check) return send(res, 503, { ok: false, error: 'updater not available' });
        try { return send(res, 200, { ok: true, ...(await _updateBridge.check()) }); }
        catch (e) { return send(res, 500, { ok: false, error: String(e?.message || e) }); }
      }
      if (p === '/app-update/install' && req.method === 'POST') {
        if (!_updateBridge?.install) return send(res, 503, { ok: false, error: 'updater not available' });
        try { _updateBridge.install(); return send(res, 200, { ok: true, quitting: true }); }
        catch (e) { return send(res, 500, { ok: false, error: String(e?.message || e) }); }
      }

      // Pairing endpoint — extension POSTs a token to authorize itself.
      // Token is stored in app's settings store; subsequent requests include it.
      if (p === '/pair' && req.method === 'POST') {
        try {
          const body = await readJson(req);
          if (!body?.token) return send(res, 400, { ok: false, error: 'token required' });
          // Read existing paired list (if any) and add
          let paired = [];
          try { paired = JSON.parse(db.getSetting?.('pairedExtensions') || '[]'); } catch {}
          paired = paired.filter((p) => p.extensionId !== body.extensionId);
          paired.push({
            token: body.token,
            extensionId: body.extensionId || '',
            name: body.name || 'Extension',
            pairedAt: new Date().toISOString()
          });
          if (typeof db.setSetting === 'function') db.setSetting('pairedExtensions', JSON.stringify(paired));
          return send(res, 200, { ok: true, paired: paired.length });
        } catch (e) {
          return send(res, 500, { ok: false, error: String(e.message || e) });
        }
      }

      // Full snapshot for initial sync
      if (p === '/api/snapshot' && req.method === 'GET') {
        return send(res, 200, db.exportSnapshot());
      }

      // Sync event push from extension — apply locally and broadcast
      if (p === '/sync/event' && req.method === 'POST') {
        const body = await readJson(req);
        const ev = body || {};
        // First-time extension contact: flip a flag so the extension-promo
        // banner stops showing in the desktop app
        try {
          const s = db.getSettings();
          if (!s.extensionEverConnected) {
            db.patchSettings({ extensionEverConnected: true, extensionFirstSeenAt: new Date().toISOString() });
            broadcastSync('settings.updated', { settings: db.getSettings() });
          }
        } catch {}
        try {
          applySyncEvent(db, ev);
        } catch (e) {
          return send(res, 200, { ok: false, error: String(e.message || e) });
        }
        // Re-broadcast to other clients (excluding ourselves is impossible to
        // discriminate here — last-write-wins on the receiver side avoids loops)
        broadcastSync(ev.name, ev.data);
        return send(res, 200, { ok: true });
      }

      // RPC bridge — used by the desktop UI's window.jat5.api()
      if (p === '/rpc' && req.method === 'POST') {
        const body = await readJson(req);
        const out = await dispatchRpc(db, body);
        return send(res, 200, out);
      }

      // ----- Jobs -----
      if (p === '/jobs' && req.method === 'GET')  return send(res, 200, { items: db.listJobs() });
      if (p === '/jobs' && req.method === 'POST') {
        const body = await readJson(req);
        const result = db.upsertJob(body || {}, { statusPriority: STATUS_PRIORITY, normalizeStatus });
        return send(res, 200, result);
      }
      let m = p.match(/^\/jobs\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (req.method === 'GET')    return send(res, 200, { job: db.getJob(id) });
        if (req.method === 'PATCH')  { const body = await readJson(req); return send(res, 200, { job: db.patchJobShallow(id, body || {}) }); }
        if (req.method === 'DELETE') { db.deleteJob(id); return send(res, 200, { ok: true }); }
      }

      // ----- Profile (default) -----
      if (p === '/profile' && req.method === 'GET')   return send(res, 200, { profile: db.getProfile() });
      if (p === '/profile' && req.method === 'PATCH') { const body = await readJson(req); return send(res, 200, { profile: db.patchProfile(body || {}) }); }

      // ----- Profiles (named, multi) -----
      if (p === '/profiles' && req.method === 'GET')  return send(res, 200, { items: db.listProfiles() });
      if (p === '/profiles' && req.method === 'POST') { const body = await readJson(req); return send(res, 200, { profile: db.createProfile(body || {}) }); }
      m = p.match(/^\/profiles\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (req.method === 'PATCH')  { const body = await readJson(req); return send(res, 200, { profile: db.patchProfileById(id, body || {}) }); }
        if (req.method === 'DELETE') { return send(res, 200, { ok: db.deleteProfile(id) }); }
      }

      // ----- QA -----
      if (p === '/qa' && req.method === 'GET')  return send(res, 200, { items: db.listAnswers() });
      if (p === '/qa' && req.method === 'POST') { const body = await readJson(req); return send(res, 200, { entry: db.recordAnswer(body || {}) }); }
      m = p.match(/^\/qa\/([^/]+)$/);
      if (m && req.method === 'DELETE') { db.deleteAnswer(decodeURIComponent(m[1])); return send(res, 200, { ok: true }); }

      // ----- Documents -----
      if (p === '/documents' && req.method === 'GET')  return send(res, 200, { items: db.listDocuments().map((d) => ({ ...d, data: undefined })) });
      if (p === '/documents' && req.method === 'POST') {
        // We accept JSON with { name, mimeType, sizeBytes, type, base64 } —
        // real multipart parsing would need an extra dep we're avoiding.
        const body = await readJson(req);
        if (!body) return send(res, 400, { error: 'No body' });
        const buffer = body.base64 ? Buffer.from(body.base64, 'base64')
                     : body.buffer ? body.buffer
                     : null;
        const doc = db.addDocument({ ...body, buffer });
        return send(res, 200, { doc: { ...doc, data: undefined } });
      }
      m = p.match(/^\/documents\/([^/]+)\/file$/);
      if (m && req.method === 'GET') {
        const got = db.getDocumentBlob(decodeURIComponent(m[1]));
        if (!got || !got.buffer) return send(res, 404, { error: 'Not found' });
        return send(res, 200, got.buffer, {
          'Content-Type': got.meta.mimeType || 'application/octet-stream',
          'Content-Disposition': `inline; filename="${(got.meta.originalFilename || got.meta.name || 'file').replace(/"/g, '')}"`
        });
      }

      // ----- Settings -----
      if (p === '/settings' && req.method === 'GET')   return send(res, 200, { settings: db.getSettings() });
      if (p === '/settings' && req.method === 'PATCH') { const body = await readJson(req); return send(res, 200, { settings: db.patchSettings(body || {}) }); }

      // ----- Sync with extension -----
      if (p === '/sync/pull-from-extension' && req.method === 'POST') {
        // Extension pushes its full IDB snapshot; we merge it.
        const body = await readJson(req);
        const r = db.importSnapshot(body || {});
        return send(res, 200, r);
      }
      if (p === '/sync/push-to-extension' && req.method === 'POST') {
        // Extension asks for our merged state.
        return send(res, 200, db.exportSnapshot());
      }

      send(res, 404, { error: 'Not found', path: p });
    } catch (e) {
      send(res, 500, { error: String(e.message || e) });
    }
  });
  server.on('upgrade', (req, socket) => {
    const u = url.parse(req.url, true);
    if (u.pathname === '/ws') {
      handleUpgrade(req, socket);
    } else {
      socket.destroy();
    }
  });
  server.listen(PORT, '127.0.0.1');
  return server;
}

// Apply a sync event coming in from a remote (extension) client. Last-write-
// wins by updatedAt — if our local copy is newer, skip.
function applySyncEvent(db, ev) {
  const { name, data } = ev || {};
  if (!name) return;
  const newer = (incoming) => {
    if (!incoming?.id || !incoming?.updatedAt) return true;
    let cur = null;
    try {
      if (name.startsWith('job.')) cur = db.getJob(incoming.id);
    } catch {}
    if (!cur || !cur.updatedAt) return true;
    return new Date(incoming.updatedAt).getTime() >= new Date(cur.updatedAt).getTime();
  };
  switch (name) {
    case 'job.created':
    case 'job.updated': {
      const j = data?.job;
      if (j && newer(j)) {
        db.upsertJob(j, { statusPriority: STATUS_PRIORITY, normalizeStatus });
      }
      return;
    }
    case 'job.deleted':
      if (data?.id) db.deleteJob(data.id);
      return;
    case 'settings.updated':
      if (data?.settings) db.patchSettings(data.settings);
      return;
    case 'profile.updated':
      if (data?.profile) db.patchProfile(data.profile);
      return;
    default:
      // Unknown event — ignore (keeps forward compat with new event names)
      return;
  }
}

module.exports = { startServer, PORT, VERSION, setLocalBroadcast, setUpdateBridge };
