// JAT v10 desktop companion — minimal HTTP server.
// Single route: GET /health → { ok, version, ts }. Permissive CORS so the
// extension SW can fetch it from chrome-extension:// origin without surprises.

const http = require('http');

let server = null;

function startServer(port, getVersion) {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version: getVersion(), ts: Date.now() }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function stopServer() {
  if (server) { try { server.close(); } catch {} server = null; }
}

module.exports = { startServer, stopServer };
