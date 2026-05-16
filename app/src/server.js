// JAT v10 desktop companion — HTTP server.
// Routes:
//   GET    /health              → liveness probe + version
//   GET    /jobs                → list, optional ?status, ?source, ?limit
//   GET    /jobs/:id            → single job
//   POST   /jobs                → upsert by dedup (returns { job, action, statusChanged })
//   PATCH  /jobs/:id            → manual edit (status transitions, notes, etc.)
//   DELETE /jobs/:id            → remove
//   GET    /events?jobId=...    → list events for a job
//   POST   /events              → append event
//   GET    /stats               → { total, thisWeek, byStatus }
//
// Permissive CORS so the extension can fetch from chrome-extension:// origin
// without preflight surprises. Bound to 127.0.0.1 only — not reachable from
// other machines on the LAN.

const http = require('http');
const url = require('url');

let server = null;

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function startServer(port, { getVersion, db }) {
  return new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      const parsed = url.parse(req.url, true);
      const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
      const m = (re) => pathname.match(re);

      try {
        // ---- health ----
        if (req.method === 'GET' && pathname === '/health') {
          return sendJson(res, 200, { ok: true, version: getVersion(), ts: Date.now() });
        }

        // ---- jobs ----
        if (req.method === 'GET' && pathname === '/jobs') {
          const items = db.listJobs({
            status: parsed.query.status,
            source: parsed.query.source,
            limit: parsed.query.limit ? Number(parsed.query.limit) : undefined,
          });
          return sendJson(res, 200, { ok: true, items });
        }
        let jm;
        if (req.method === 'GET' && (jm = m(/^\/jobs\/([^\/]+)$/))) {
          const job = db.getJob(jm[1]);
          if (!job) return sendJson(res, 404, { ok: false, error: 'not found' });
          return sendJson(res, 200, { ok: true, job });
        }
        if (req.method === 'POST' && pathname === '/jobs') {
          const body = await readJson(req);
          const result = db.upsertJob(body);
          // Auto-record a status event when status changes (created counts as a change)
          if (result.statusChanged) {
            db.recordEvent({
              jobId: result.job.id,
              type: result.action === 'created' ? 'created' : 'status_changed',
              source: body._source || 'extension',
              summary: result.action === 'created'
                ? `Captured as ${result.job.status}`
                : `${result.previousStatus} → ${result.job.status}`,
              data: { from: result.previousStatus, to: result.job.status },
            });
          }
          return sendJson(res, 200, { ok: true, ...result });
        }
        if (req.method === 'PATCH' && (jm = m(/^\/jobs\/([^\/]+)$/))) {
          const body = await readJson(req);
          const result = db.patchJob(jm[1], body);
          if (!result) return sendJson(res, 404, { ok: false, error: 'not found' });
          if (result.statusChanged) {
            db.recordEvent({
              jobId: result.job.id,
              type: 'status_changed',
              source: body._source || 'manual',
              summary: `${result.previousStatus} → ${result.job.status}`,
              data: { from: result.previousStatus, to: result.job.status },
            });
          }
          return sendJson(res, 200, { ok: true, ...result });
        }
        if (req.method === 'DELETE' && (jm = m(/^\/jobs\/([^\/]+)$/))) {
          db.deleteJob(jm[1]);
          return sendJson(res, 200, { ok: true });
        }

        // ---- events ----
        if (req.method === 'GET' && pathname === '/events') {
          if (!parsed.query.jobId) return sendJson(res, 400, { ok: false, error: 'jobId required' });
          const items = db.listEvents(parsed.query.jobId, parsed.query.limit ? Number(parsed.query.limit) : undefined);
          return sendJson(res, 200, { ok: true, items });
        }
        if (req.method === 'POST' && pathname === '/events') {
          const body = await readJson(req);
          if (!body.jobId || !body.type) return sendJson(res, 400, { ok: false, error: 'jobId + type required' });
          const ev = db.recordEvent(body);
          return sendJson(res, 200, { ok: true, event: ev });
        }

        // ---- stats ----
        if (req.method === 'GET' && pathname === '/stats') {
          return sendJson(res, 200, { ok: true, ...db.stats() });
        }

        return sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (e) {
        console.error('[jat10:server]', req.method, pathname, e);
        return sendJson(res, 500, { ok: false, error: String(e.message || e) });
      }
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function stopServer() {
  if (server) { try { server.close(); } catch {} server = null; }
}

module.exports = { startServer, stopServer };
