// Chunk A1b — session-bridge transport. Exercises the REAL server route
// (GET /session/linkedin + POST /session/bridge gate) against a fixture Firefox profile,
// and the pull client's error paths against a mock server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));
const server = require(path.join(here, '..', 'app', 'src', 'server.js'));
const bridge = require(path.join(here, '..', 'app', 'src', 'session-bridge.js'));
const { Database } = require(path.join(here, '..', 'app', 'node_modules', 'node-sqlite3-wasm'));

function makeCookieDb(file, rows) {
  const d = new Database(file);
  d.run(`CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, name TEXT, value TEXT, host TEXT, path TEXT,
    expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER DEFAULT 0)`);
  let id = 1;
  for (const r of rows) d.run('INSERT INTO moz_cookies (id,name,value,host,path,expiry,isSecure,isHttpOnly,sameSite) VALUES (?,?,?,?,?,?,?,?,?)',
    [id++, r.name, r.value, r.host, r.path || '/', r.expiry || 0, r.isSecure ? 1 : 0, r.isHttpOnly ? 1 : 0, r.sameSite || 0]);
  d.close();
}

let dir, srv, base, token, ffRoot;
test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-sbt-'));
  db.open(dir);
  // fixture Firefox profile with a complete LinkedIn session
  ffRoot = path.join(dir, 'Profiles');
  fs.mkdirSync(path.join(ffRoot, 'xx.default-release'), { recursive: true });
  makeCookieDb(path.join(ffRoot, 'xx.default-release', 'cookies.sqlite'), [
    { name: 'li_at', value: 'REAL_TOKEN', host: '.www.linkedin.com', path: '/', isSecure: 1, isHttpOnly: 1, expiry: 1900000000 },
    { name: 'JSESSIONID', value: 'ajax:7', host: '.www.linkedin.com', path: '/', isSecure: 1, sameSite: 1 },
  ]);
  srv = await server.startServer(0, { userDataDir: dir });
  base = `http://127.0.0.1:${srv.address().port}`;
  token = server.getToken();
});
test.after(() => { try { server.stopServer(); } catch {} try { db.close(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('GET /session/linkedin is 403 until the bridge is enabled', async () => {
  const r = await bridge.fetchRemoteLinkedInSession({ baseUrl: base, token });
  assert.equal(r.ok, false);
  assert.match(r.error, /disabled/i);
});

test('enabling the bridge then pulling returns Dad\'s live session', async () => {
  const res = await fetch(base + '/session/bridge', {
    method: 'POST', headers: { 'X-JAT-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, firefoxProfilesRoot: ffRoot }),
  });
  assert.equal((await res.json()).enabled, true);

  const r = await bridge.fetchRemoteLinkedInSession({ baseUrl: base, token });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.cookies.some((c) => c.name === 'li_at' && c.value === 'REAL_TOKEN'), 'carries the real li_at');
  assert.ok(r.cookies.some((c) => c.name === 'JSESSIONID'));
  // the wire response must NOT leak the local profile file path
  assert.equal(r.source, undefined);
});

test('wrong/missing token is rejected (401)', async () => {
  const r = await bridge.fetchRemoteLinkedInSession({ baseUrl: base, token: 'nope' });
  assert.equal(r.ok, false);
});

// ---- pull-client error paths against a controlled mock server ----
function mockServer(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}

test('pull: disabled node (403) → ok:false with reason', async () => {
  const { s, url } = await mockServer((req, res) => { res.writeHead(403); res.end(JSON.stringify({ ok: false, error: 'session bridge is disabled on this node' })); });
  const r = await bridge.fetchRemoteLinkedInSession({ baseUrl: url, token: 't' });
  s.close();
  assert.equal(r.ok, false); assert.match(r.error, /disabled/i); assert.equal(r.status, 403);
});

test('pull: 200 but missing li_at → rejected (never inject junk)', async () => {
  const { s, url } = await mockServer((req, res) => { res.writeHead(200); res.end(JSON.stringify({ ok: true, cookies: [{ name: 'JSESSIONID', value: 'x' }] })); });
  const r = await bridge.fetchRemoteLinkedInSession({ baseUrl: url, token: 't' });
  s.close();
  assert.equal(r.ok, false); assert.match(r.error, /li_at/);
});

test('pull: bad JSON → ok:false, no throw', async () => {
  const { s, url } = await mockServer((req, res) => { res.writeHead(200); res.end('<html>not json</html>'); });
  const r = await bridge.fetchRemoteLinkedInSession({ baseUrl: url, token: 't' });
  s.close();
  assert.equal(r.ok, false);
});

test('pull: connection refused → ok:false, no throw', async () => {
  const r = await bridge.fetchRemoteLinkedInSession({ baseUrl: 'http://127.0.0.1:1/', token: 't', timeoutMs: 1500 });
  assert.equal(r.ok, false);
});
