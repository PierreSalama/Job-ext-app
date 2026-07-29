// Chunk A1 — session bridge (source side): extract Dad's LinkedIn session cookies from a
// Firefox cookies.sqlite so the server laptop can assume the same logged-in session.
// Builds a synthetic moz_cookies DB (real Firefox schema subset) and asserts extraction,
// filtering, sameSite mapping, and the "incomplete session" guards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const bridge = require(path.join(here, '..', 'app', 'src', 'session-bridge.js'));
const { Database } = require(path.join(here, '..', 'app', 'node_modules', 'node-sqlite3-wasm'));

// Build a Firefox-shaped cookies.sqlite at `file` from {name,value,host,path,expiry,isSecure,isHttpOnly,sameSite} rows.
function makeCookieDb(file, rows) {
  const db = new Database(file);
  db.run(`CREATE TABLE moz_cookies (
    id INTEGER PRIMARY KEY, originAttributes TEXT DEFAULT '', name TEXT, value TEXT,
    host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER,
    isSecure INTEGER, isHttpOnly INTEGER, inBrowserElement INTEGER DEFAULT 0,
    sameSite INTEGER DEFAULT 0, rawSameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 0)`);
  let id = 1;
  for (const r of rows) {
    db.run('INSERT INTO moz_cookies (id,name,value,host,path,expiry,isSecure,isHttpOnly,sameSite) VALUES (?,?,?,?,?,?,?,?,?)',
      [id++, r.name, r.value, r.host, r.path || '/', r.expiry || 0, r.isSecure ? 1 : 0, r.isHttpOnly ? 1 : 0, r.sameSite || 0]);
  }
  db.close();
}

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-sb-')); });
test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('extracts a complete LinkedIn session and drops noise', () => {
  const db = path.join(dir, 'complete.sqlite');
  makeCookieDb(db, [
    { name: 'li_at', value: 'AQEDAT-token', host: '.www.linkedin.com', path: '/', expiry: 1900000000, isSecure: 1, isHttpOnly: 1, sameSite: 0 },
    { name: 'JSESSIONID', value: 'ajax:123', host: '.www.linkedin.com', path: '/', isSecure: 1, isHttpOnly: 0, sameSite: 1 },
    { name: 'bcookie', value: 'v=2&abc', host: '.linkedin.com', path: '/', isSecure: 1, isHttpOnly: 0, sameSite: 2 },
    { name: 'lidc', value: 'b=OB', host: '.linkedin.com', path: '/', isSecure: 1 },
    // noise that must be excluded:
    { name: 'sessionid', value: 'nope', host: '.facebook.com', path: '/', isSecure: 1 },        // wrong site
    { name: '__random_ad', value: 'x', host: '.linkedin.com', path: '/', isSecure: 1 },          // not a session cookie
  ]);
  const r = bridge.extractLinkedInSession({ dbPath: db });
  assert.equal(r.ok, true, r.error);
  const byName = Object.fromEntries(r.cookies.map((c) => [c.name, c]));
  assert.ok(byName.li_at && byName.JSESSIONID && byName.bcookie && byName.lidc, 'kept the session cookies');
  assert.ok(!byName.sessionid, 'dropped the non-LinkedIn cookie');
  assert.ok(!byName.__random_ad, 'dropped the non-session LinkedIn cookie');
  assert.equal(r.count, 4);
  // CDP shape + sameSite mapping (0→None, 1→Lax, 2→Strict)
  assert.equal(byName.li_at.domain, '.www.linkedin.com');
  assert.equal(byName.li_at.httpOnly, true);
  assert.equal(byName.li_at.secure, true);
  assert.equal(byName.li_at.expires, 1900000000);
  assert.equal(byName.li_at.sameSite, 'None');
  assert.equal(byName.JSESSIONID.sameSite, 'Lax');
  assert.equal(byName.bcookie.sameSite, 'Strict');
});

test('incomplete session (no li_at) is rejected with a helpful error', () => {
  const db = path.join(dir, 'incomplete.sqlite');
  makeCookieDb(db, [
    { name: 'JSESSIONID', value: 'ajax:123', host: '.www.linkedin.com', path: '/', isSecure: 1 },
    { name: 'bcookie', value: 'v=2', host: '.linkedin.com', path: '/', isSecure: 1 },
  ]);
  const r = bridge.extractLinkedInSession({ dbPath: db });
  assert.equal(r.ok, false);
  assert.match(r.error, /incomplete|li_at/i);
  assert.deepEqual(r.cookies, []);
});

test('no LinkedIn cookies at all → clear "not logged in" error', () => {
  const db = path.join(dir, 'none.sqlite');
  makeCookieDb(db, [{ name: 'sb', value: '1', host: '.google.com', path: '/', isSecure: 1 }]);
  const r = bridge.extractLinkedInSession({ dbPath: db });
  assert.equal(r.ok, false);
  assert.match(r.error, /no LinkedIn cookies/i);
});

test('host matcher only accepts real linkedin.com hosts', () => {
  assert.equal(bridge.isLinkedInHost('.www.linkedin.com'), true);
  assert.equal(bridge.isLinkedInHost('linkedin.com'), true);
  assert.equal(bridge.isLinkedInHost('careers.linkedin.com'), true);
  assert.equal(bridge.isLinkedInHost('linkedin.com.evil.com'), false);
  assert.equal(bridge.isLinkedInHost('notlinkedin.com'), false);
  assert.equal(bridge.isLinkedInHost(''), false);
});

test('picks the default-release profile over others', () => {
  const root = path.join(dir, 'Profiles');
  fs.mkdirSync(path.join(root, 'aaaa.dev-edition'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bbbb.default-release'), { recursive: true });
  // dev-edition has an INCOMPLETE session; default-release has the real one.
  makeCookieDb(path.join(root, 'aaaa.dev-edition', 'cookies.sqlite'), [
    { name: 'JSESSIONID', value: 'x', host: '.www.linkedin.com', path: '/', isSecure: 1 },
  ]);
  makeCookieDb(path.join(root, 'bbbb.default-release', 'cookies.sqlite'), [
    { name: 'li_at', value: 'real', host: '.www.linkedin.com', path: '/', isSecure: 1, isHttpOnly: 1 },
    { name: 'JSESSIONID', value: 'ajax:9', host: '.www.linkedin.com', path: '/', isSecure: 1 },
  ]);
  const profs = bridge.findFirefoxProfiles(root);
  assert.match(profs[0], /default-release/, 'default-release is ranked first');
  const r = bridge.extractLinkedInSession({ profilesRoot: root });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.cookies.find((c) => c.name === 'li_at').value, 'real');
});
