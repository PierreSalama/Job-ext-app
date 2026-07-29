// Chunk A2b — boot-wiring: applyFromSettings() starts/stops the session-sync loop from the
// sessionSync settings block, and the /session/sync* endpoints drive it. No network/Chrome —
// the sync engine is exercised with injected deps; endpoints are tested against a real server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));
const server = require(path.join(here, '..', 'app', 'src', 'server.js'));
const sessionSync = require(path.join(here, '..', 'app', 'src', 'session-sync.js'));

const deps = { pull: async () => ({ ok: true, count: 1, cookies: [{ name: 'li_at', value: 'x', domain: '.linkedin.com' }] }), inject: async () => ({ ok: true, hasLiAt: true }) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('applyFromSettings: disabled → not started', () => {
  const r = sessionSync.applyFromSettings({ sessionSync: { enabled: false } }, { deps });
  assert.equal(r.started, false);
  assert.equal(sessionSync.active(), null);
});

test('applyFromSettings: enabled but incomplete → not started', () => {
  const r = sessionSync.applyFromSettings({ sessionSync: { enabled: true, sourceBaseUrl: '', cdpPort: 0 } }, { deps });
  assert.equal(r.started, false);
  assert.match(r.reason, /incomplete/);
});

test('applyFromSettings: enabled + full config → starts and syncs', async () => {
  const r = sessionSync.applyFromSettings({ sessionSync: { enabled: true, sourceBaseUrl: 'http://src', sourceToken: 't', cdpPort: 9222, intervalMinutes: 60 } }, { deps });
  assert.equal(r.started, true);
  assert.ok(sessionSync.active());
  await sleep(60);
  assert.equal(sessionSync.status().last.ok, true, 'ran an immediate sync via injected deps');
  // re-applying disabled tears it down
  sessionSync.applyFromSettings({ sessionSync: { enabled: false } }, { deps });
  assert.equal(sessionSync.active(), null);
});

// ---- endpoints against a real server ----
let dir, srv, base, token;
test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-syncboot-'));
  db.open(dir);
  srv = await server.startServer(0, { userDataDir: dir });
  base = `http://127.0.0.1:${srv.address().port}`;
  token = server.getToken();
});
test.after(() => { try { sessionSync.active()?.stop(); } catch {} try { server.stopServer(); } catch {} try { db.close(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
const H = () => ({ 'X-JAT-Token': token, 'Content-Type': 'application/json' });

test('GET /session/sync reports not-running initially', async () => {
  const j = await (await fetch(base + '/session/sync', { headers: H() })).json();
  assert.equal(j.ok, true);
  assert.equal(j.running, false);
});

test('POST /session/sync/now → 409 when sync is not enabled', async () => {
  const res = await fetch(base + '/session/sync/now', { method: 'POST', headers: H() });
  assert.equal(res.status, 409);
});

test('POST /session/sync/config persists the block (enabled:false path, no network)', async () => {
  const res = await fetch(base + '/session/sync/config', { method: 'POST', headers: H(), body: JSON.stringify({ enabled: false, sourceBaseUrl: 'http://100.105.39.32:7744', cdpPort: 9333, intervalMinutes: 20 }) });
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.applied.started, false, 'disabled config does not start the loop');
  // config landed in settings
  const s = db.getSettings().sessionSync;
  assert.equal(s.sourceBaseUrl, 'http://100.105.39.32:7744');
  assert.equal(s.cdpPort, 9333);
});
