// Secrets-at-rest + data-wipe behavior (db layer). Runs without Electron, so the
// secretstore degrades to identity (plaintext) — we test the LOGIC (round-trip,
// preserve-on-blank, kv encryption path, wipe), not the cipher itself.
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
const secrets = require(path.join(here, '..', 'app', 'src', 'secretstore.js'));

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-sec-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('secretstore is a safe no-op without a keychain', () => {
  assert.equal(secrets.available(), false);
  assert.equal(secrets.seal('sk-abc'), 'sk-abc');
  assert.equal(secrets.open('sk-abc'), 'sk-abc');
  assert.equal(secrets.isSealed('sk-abc'), false);
  assert.equal(secrets.isSealed(secrets.PREFIX + 'x'), true);
});

test('API key round-trips through settings', () => {
  db.patchSettings({ ai: { claude: { apiKey: 'sk-secret-1' } } });
  assert.equal(db.getSettings().ai.claude.apiKey, 'sk-secret-1');
});

test('blank secret PRESERVES the stored key (a redacted UI can never erase it)', () => {
  db.patchSettings({ ai: { claude: { apiKey: '   ' } } });           // blank/whitespace
  assert.equal(db.getSettings().ai.claude.apiKey, 'sk-secret-1', 'kept the existing key');
  db.patchSettings({ ai: { claude: { model: 'claude-x' } } });       // unrelated field changes
  assert.equal(db.getSettings().ai.claude.apiKey, 'sk-secret-1', 'key still preserved');
  assert.equal(db.getSettings().ai.claude.model, 'claude-x');
});

test('non-blank secret overwrites', () => {
  db.patchSettings({ ai: { claude: { apiKey: 'sk-secret-2' } } });
  assert.equal(db.getSettings().ai.claude.apiKey, 'sk-secret-2');
});

test('secret kv keys round-trip (IMAP app passwords)', () => {
  db.kvSet('emailAccounts', [{ id: 'a', email: 'x@y.z', password: 'app-pass-123' }]);
  assert.equal(db.kvGet('emailAccounts')[0].password, 'app-pass-123');
});

test('wipeAllData clears user data + disconnects accounts, keeps the app usable', () => {
  db.upsertJob({ title: 'Dev', company: 'Acme', source: 'linkedin', status: 'started', jobUrl: 'https://x/wipe1' });
  db.kvSet('gmailTokens', { refresh_token: 'r' });
  assert.ok(db.listJobs().length >= 1);

  const r = db.wipeAllData();
  assert.equal(r.ok, true);
  assert.equal(db.listJobs().length, 0, 'jobs cleared');
  assert.equal(db.kvGet('gmailTokens'), null, 'gmail disconnected');
  assert.equal(db.kvGet('emailAccounts'), null, 'email disconnected');
  assert.equal(db.getSettings().ai.claude.apiKey, '', 'API key cleared');
  assert.equal(typeof db.getSettings().server.port, 'number', 'app prefs survive');
});
