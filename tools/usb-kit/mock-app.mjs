// Mock JAT app for testing Setup-JAT.ps1 without a real install / real Firefox / the live app.
// Implements the endpoints the setup script drives, records what it receives, and (optionally)
// simulates step-3 pairing failing so the step-4 config RETRY is exercised. Writes a JSON result
// file on exit-signal so the test can assert.
//
//   node mock-app.mjs <port> <resultFile> [failFirstNPairs]
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.argv[2] || 7799);
const RESULT = process.argv[3] || 'mock-result.json';
const FAIL_FIRST_PAIRS = Number(process.argv[4] || 0);   // simulate early pair failures (race)

const state = { pairAttempts: 0, configApplied: null, configCount: 0, reportReceived: null, netinfoHits: 0, settings: { ai: {}, autoUpdate: {}, server: {}, autoApply: {} } };
const TOKEN = 'mock-token-abc123';
const save = () => { try { fs.writeFileSync(RESULT, JSON.stringify(state, null, 2)); } catch {} };

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = req.url.split('?')[0];
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'OPTIONS' && url === '/pair') return json(200, { ok: true });
    if (req.method === 'POST' && url === '/pair') {
      state.pairAttempts++;
      // Simulate the race: the first N pair attempts fail (no token), like step 3 did on 2026-07-22.
      if (state.pairAttempts <= FAIL_FIRST_PAIRS) return json(503, { ok: false });
      return json(200, { ok: true, token: TOKEN });
    }
    if (req.method === 'PATCH' && url === '/settings') {
      try {
        const cfg = JSON.parse(body || '{}');
        state.configApplied = cfg;
        state.configCount++;
        state.settings = { ...state.settings, ...cfg };
      } catch {}
      save();
      return json(200, { ok: true });
    }
    if (req.method === 'GET' && url === '/settings') return json(200, { settings: state.settings });
    if (req.method === 'GET' && url === '/netinfo') {
      state.netinfoHits++;
      return json(200, { extensionConnected: true, hostname: 'MOCK-DADPC', ips: [{ iface: 'Ethernet', ip: '192.168.2.125' }] });
    }
    if (req.method === 'POST' && url === '/remote/report') {
      state.reportReceived = body.slice(0, 4000);
      save();
      return json(200, { ok: true, saved: 'mock' });
    }
    json(404, { ok: false });
  });
});

// A second instance (from the step-4 relaunch) will hit EADDRINUSE — just exit, and DO NOT save,
// or it would clobber the serving instance's real result with empty state.
server.on('error', () => { process.exit(1); });
server.listen(PORT, '127.0.0.1', () => { save(); });

// Exit cleanly on signal so repeated Launch-App calls don't stack (the script may relaunch us).
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(); process.exit(0); });
