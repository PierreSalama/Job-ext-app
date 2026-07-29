// Chunk A2a — session-sync orchestrator: pull Dad's session + inject into his Chrome, on a
// refresh loop. Deterministic tests use injected deps; one integration test runs the real
// pull (mock source server) + real headless Chrome injection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createSessionSync } = require(path.join(here, '..', 'app', 'src', 'session-sync.js'));
const cdp = require(path.join(here, '..', 'app', 'src', 'cdp-inject.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const okSession = { ok: true, count: 3, capturedAt: '2026-07-29T00:00:00Z', cookies: [{ name: 'li_at', value: 'T', domain: '.linkedin.com' }] };

test('syncOnce happy path (injected deps): pull → inject → ok', async () => {
  let injected = null;
  const s = createSessionSync({
    source: { baseUrl: 'http://x', token: 't' }, cdpPort: 9999,
    deps: { pull: async () => okSession, inject: async (c) => { injected = c; return { ok: true, hasLiAt: true }; } },
  });
  const r = await s.syncOnce();
  assert.equal(r.ok, true);
  assert.equal(r.cookies, 3);
  assert.equal(injected.length, 1, 'passed the pulled cookies to the injector');
  assert.equal(s.status().last.ok, true);
});

test('pull failure is reported as phase=pull and never reaches inject', async () => {
  let injectCalled = false;
  const s = createSessionSync({
    source: { baseUrl: 'http://x', token: 't' }, cdpPort: 9999,
    deps: { pull: async () => ({ ok: false, error: 'disabled' }), inject: async () => { injectCalled = true; return { ok: true }; } },
  });
  const r = await s.syncOnce();
  assert.equal(r.ok, false); assert.equal(r.phase, 'pull'); assert.match(r.error, /disabled/);
  assert.equal(injectCalled, false, 'must not inject when the pull failed');
});

test('inject failure is reported as phase=inject', async () => {
  const s = createSessionSync({
    source: { baseUrl: 'http://x', token: 't' }, cdpPort: 9999,
    deps: { pull: async () => okSession, inject: async () => ({ ok: false, error: 'CDP unreachable' }) },
  });
  const r = await s.syncOnce();
  assert.equal(r.ok, false); assert.equal(r.phase, 'inject'); assert.match(r.error, /CDP/);
});

test('missing config fails safe (phase=config)', async () => {
  assert.equal((await createSessionSync({ cdpPort: 1 }).syncOnce()).phase, 'config');       // no source
  assert.equal((await createSessionSync({ source: { baseUrl: 'http://x' } }).syncOnce()).phase, 'config'); // no cdpPort
});

test('start() fires an immediate sync then stop() halts the loop', async () => {
  let calls = 0;
  const s = createSessionSync({
    source: { baseUrl: 'http://x', token: 't' }, cdpPort: 9999, intervalMs: 40,
    deps: { pull: async () => okSession, inject: async () => ({ ok: true, hasLiAt: true }) },
  });
  s.start();
  await sleep(140);
  s.stop();
  const after = calls;
  assert.ok(s.status().last && s.status().last.ok, 'ran at least once');
  // no further growth after stop
  const seen = s.status().last.at;
  await sleep(120);
  assert.equal(s.status().last.at, seen, 'no syncs after stop()');
});

// ---- integration: real pull (mock source) + real headless Chrome injection ----
function findChrome() {
  return ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')].find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

test('integration: real source pull + real Chrome injection via the orchestrator', async (t) => {
  const chrome = findChrome();
  if (!chrome) { t.skip('Chrome not installed'); return; }

  const LI_AT = 'AQEDAT_SYNC_TOKEN_7c';
  const source = http.createServer((req, res) => {
    if (req.url === '/session/linkedin') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, count: 2, capturedAt: 'now', cookies: [
      { name: 'li_at', value: LI_AT, domain: '.www.linkedin.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' },
      { name: 'JSESSIONID', value: 'ajax:z', domain: '.www.linkedin.com', path: '/', secure: true, sameSite: 'Lax' }] })); }
    else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise((r) => source.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${source.address().port}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-sync-chrome-'));
  const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--disable-gpu', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });
  try {
    let port = null;
    for (let i = 0; i < 60 && port == null; i++) { await sleep(250); try { port = parseInt(String(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim(), 10) || null; } catch {} }
    assert.ok(port, 'Chrome CDP up');

    const sync = createSessionSync({ source: { baseUrl: base, token: 't' }, cdpPort: port });
    const r = await sync.syncOnce();
    assert.equal(r.ok, true, 'orchestrated pull+inject succeeded');
    // confirm the token is live in Chrome
    const ver = await cdp.cdpHttp('127.0.0.1', port, '/json/version');
    const c = await cdp.openCdp(ver.webSocketDebuggerUrl);
    try {
      const got = await c.send('Storage.getCookies', {});
      assert.equal((got.cookies || []).find((x) => x.name === 'li_at').value, LI_AT);
    } finally { c.close(); }
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    try { source.close(); } catch {}
    await sleep(300);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
