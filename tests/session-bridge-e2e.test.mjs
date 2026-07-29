// Chunk A1 capstone — the WHOLE session bridge end-to-end:
//   fixture Firefox cookies.sqlite  →  GET /session/linkedin (real server)  →  pull  →
//   CDP inject into REAL headless Chrome  →  verify Dad's li_at is live in that browser.
// If Dad's Firefox → the laptop's Chrome carries this exact path, LinkedIn sees a logged-in Dad.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));
const server = require(path.join(here, '..', 'app', 'src', 'server.js'));
const bridge = require(path.join(here, '..', 'app', 'src', 'session-bridge.js'));
const cdp = require(path.join(here, '..', 'app', 'src', 'cdp-inject.js'));
const { Database } = require(path.join(here, '..', 'app', 'node_modules', 'node-sqlite3-wasm'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function findChrome() {
  return [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  ].find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}
function makeCookieDb(file, rows) {
  const d = new Database(file);
  d.run('CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER DEFAULT 0)');
  let id = 1;
  for (const r of rows) d.run('INSERT INTO moz_cookies (id,name,value,host,path,expiry,isSecure,isHttpOnly,sameSite) VALUES (?,?,?,?,?,?,?,?,?)',
    [id++, r.name, r.value, r.host, r.path || '/', r.expiry || 0, r.isSecure ? 1 : 0, r.isHttpOnly ? 1 : 0, r.sameSite || 0]);
  d.close();
}

test('full bridge: Dad\'s Firefox session → server → pull → injected & live in real Chrome', async (t) => {
  const chrome = findChrome();
  if (!chrome) { t.skip('Chrome not installed'); return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-e2e-'));
  const ffRoot = path.join(dir, 'Profiles');
  fs.mkdirSync(path.join(ffRoot, 'p.default-release'), { recursive: true });
  const LI_AT = 'AQEDAT_DADS_UNIQUE_TOKEN_9f3a';
  makeCookieDb(path.join(ffRoot, 'p.default-release', 'cookies.sqlite'), [
    { name: 'li_at', value: LI_AT, host: '.www.linkedin.com', path: '/', isSecure: 1, isHttpOnly: 1, expiry: 1900000000, sameSite: 0 },
    { name: 'JSESSIONID', value: 'ajax:dad', host: '.www.linkedin.com', path: '/', isSecure: 1, sameSite: 1 },
    { name: 'bcookie', value: 'v=2&dad', host: '.linkedin.com', path: '/', isSecure: 1, sameSite: 2 },
  ]);

  db.open(dir);
  const srv = await server.startServer(0, { userDataDir: dir });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const token = server.getToken();

  const proc = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(dir, 'chrome')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });

  try {
    // 1. enable the bridge on the "source" node
    await (await fetch(base + '/session/bridge', { method: 'POST', headers: { 'X-JAT-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, firefoxProfilesRoot: ffRoot }) })).json();

    // 2. laptop pulls Dad's session over the API
    const pulled = await bridge.fetchRemoteLinkedInSession({ baseUrl: base, token });
    assert.equal(pulled.ok, true, pulled.error);
    assert.ok(pulled.cookies.some((c) => c.name === 'li_at' && c.value === LI_AT), 'pulled the real li_at');

    // 3. wait for Chrome's CDP, inject the pulled session
    const portFile = path.join(dir, 'chrome', 'DevToolsActivePort');
    let port = null;
    for (let i = 0; i < 60 && port == null; i++) { await sleep(250); try { port = parseInt(String(fs.readFileSync(portFile, 'utf8')).split('\n')[0].trim(), 10) || null; } catch {} }
    assert.ok(port, 'Chrome CDP up');

    const inj = await cdp.injectLinkedInCookies({ port, cookies: pulled.cookies });
    assert.equal(inj.ok, true, 'li_at verified live in Chrome after the full pipeline');
    assert.ok(inj.linkedInCookies.includes('li_at'));

    // 4. independent re-read: the value in Chrome equals the value from Dad's Firefox
    const ver = await cdp.cdpHttp('127.0.0.1', port, '/json/version');
    const c = await cdp.openCdp(ver.webSocketDebuggerUrl);
    try {
      const got = await c.send('Storage.getCookies', {});
      const liat = (got.cookies || []).find((x) => x.name === 'li_at');
      assert.equal(liat.value, LI_AT, 'the exact session token crossed the whole bridge intact');
    } finally { c.close(); }
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    try { server.stopServer(); } catch {}
    try { db.close(); } catch {}
    await sleep(300);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
