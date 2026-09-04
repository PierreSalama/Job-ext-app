// Nothing was watching whether the machine could still think.
//
// AI Apply went onto the server laptop and could not take a step: both CLIs installed, neither
// signed in, and the Codex token expired five weeks earlier. The `auth_lapsed` alert existed all
// along, complete with copy and a dashboard label. It simply had no source. These tests hold the
// source in place, and hold the line between "work has stopped" and "a fallback is covering".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const db = require(path.join(root, 'app/src/db.js'));
const { makeProviderHealth, signedOut } = require(path.join(root, 'app/src/ai/provider-health.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-provhealth-'));
db.open(dir);
process.on('exit', () => {
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
});

// Exactly the shape the laptop returned on the day this was found.
const LAPTOP = {
  canAnswer: false,
  chatgpt: { available: false, subscription: { available: false, needsLogin: true, expiredAt: 1785566232000, reason: 'the Codex CLI token expired' } },
  claude: { available: false, subscription: { available: false, needsLogin: true, reason: 'installed but signed out' } },
};
const HEALTHY = {
  canAnswer: true,
  chatgpt: { available: true, subscription: { available: true } },
  claude: { available: true, subscription: { available: true } },
};
const COVERED = {
  canAnswer: true,
  chatgpt: { available: false, subscription: { available: false, needsLogin: true, reason: 'the Codex CLI token expired' } },
  claude: { available: true, subscription: { available: true } },
};

const clean = () => { for (const b of db.aiBlockList({ status: 'open', limit: 500 })) db.aiBlockDismiss(b.id); };
const watcher = (status) => makeProviderHealth({ db, machine: 'the laptop', statusAll: async () => status });

test('the real laptop state raises an ALERT, because nothing can answer', async () => {
  clean();
  const r = await watcher(LAPTOP).check();
  assert.equal(r.raised.length, 2, 'both signed-out providers are reported');
  for (const b of r.raised) {
    assert.equal(b.kind, 'auth_lapsed');
    assert.equal(b.urgency, 'alert', 'work has stopped, so this wakes him');
    assert.match(b.question, /the laptop/, 'it must say WHICH machine');
  }
  assert.match(r.raised.map((b) => b.detail).join(' '), /codex login/);
  assert.match(r.raised.map((b) => b.detail).join(' '), /claude auth login/);
});

test('the expiry DATE is on the block, not just the fact', async () => {
  clean();
  const r = await watcher(LAPTOP).check();
  const codexBlock = r.raised.find((b) => /codex login/.test(b.detail));
  assert.match(codexBlock.detail, /2026-08-01/, 'five weeks of silence is the story');
});

test('a fallback quietly covering is a QUEUE item, not an alarm', async () => {
  clean();
  const r = await watcher(COVERED).check();
  assert.equal(r.raised.length, 1);
  assert.equal(r.raised[0].urgency, 'queue', 'work continues, so it must not wake him');
  assert.match(r.raised[0].question, /fallback is doing the work/);
});

test('a healthy machine says nothing at all', async () => {
  clean();
  const r = await watcher(HEALTHY).check();
  assert.deepEqual(r.raised, []);
  assert.deepEqual(r.cleared, []);
});

test('checking twice does not report the same thing twice', async () => {
  clean();
  const w = watcher(LAPTOP);
  await w.check();
  const second = await w.check();
  assert.deepEqual(second.raised, [], 'an open block is not re-raised');
  assert.equal(db.aiBlockList({ status: 'open' }).filter((b) => b.kind === 'auth_lapsed').length, 2);
});

test('signing back in clears the block without a human tidying up', async () => {
  clean();
  await watcher(LAPTOP).check();
  const r = await watcher(HEALTHY).check();
  assert.equal(r.cleared.length, 2);
  assert.equal(db.aiBlockList({ status: 'open' }).filter((b) => b.kind === 'auth_lapsed').length, 0);
});

test('one provider recovering clears only its own block', async () => {
  clean();
  await watcher(LAPTOP).check();
  const r = await watcher(COVERED).check();
  assert.equal(r.cleared.length, 1, 'Claude came back');
  const left = db.aiBlockList({ status: 'open' }).filter((b) => b.kind === 'auth_lapsed');
  assert.equal(left.length, 1);
  assert.match(left[0].detail, /codex login/);
});

test('a missing API key is NOT reported as a lapsed sign-in', () => {
  // It is a settings question. Calling it a sign-in problem sends him to the wrong screen.
  assert.equal(signedOut({ claude: { available: false, subscription: { available: false, reason: 'no API key set' } } }, 'claude'), null);
});

test('a provider working by API key is never nagged about its CLI', () => {
  assert.equal(signedOut({ claude: { available: true, subscription: { available: false, needsLogin: true } } }, 'claude'), null);
});

test('a status probe that throws does not take the app down', async () => {
  clean();
  const w = makeProviderHealth({ db, machine: 'x', statusAll: async () => { throw new Error('offline'); } });
  const r = await w.check();
  assert.deepEqual(r.raised, []);
});

test('AI turned off deliberately is not an outage', async () => {
  clean();
  const r = await watcher({ disabled: true, canAnswer: false }).check();
  assert.deepEqual(r.raised, []);
});

test('blocks from another machine are left alone', async () => {
  // Two nodes write into their own databases, but a restored backup or a future sync must not have
  // one machine dismissing the other machine's sign-in problem.
  clean();
  await watcher(LAPTOP).check();
  const other = makeProviderHealth({ db, machine: 'the PC', statusAll: async () => HEALTHY });
  const r = await other.check();
  assert.deepEqual(r.cleared, [], 'the PC must not clear the laptop blocks');
  assert.equal(db.aiBlockList({ status: 'open' }).filter((b) => b.kind === 'auth_lapsed').length, 2);
});

test('the watcher is actually STARTED by the app', () => {
  // The whole reason this module exists is that `auth_lapsed` was fully built and never wired to
  // anything. A watcher that no one starts is the same bug wearing a different hat.
  const main = fs.readFileSync(path.join(root, 'app/src/main.js'), 'utf8');
  assert.match(main, /startProviderHealth\(\)/, 'it must be called, not just defined');
  const boot = main.slice(main.indexOf('startAlertWatcher();'), main.indexOf('startAlertWatcher();') + 400);
  assert.match(boot, /startProviderHealth\(\)/, 'and started at boot, next to the alert watcher');
});

test('the alert bridge knows what to say about a lapsed sign-in', () => {
  // The block is only useful if the notification that carries it reads like an instruction.
  const { describe } = require(path.join(root, 'app/src/ai/alerts.js'));
  const said = describe({ kind: 'auth_lapsed', question: 'x' }, 'the laptop');
  assert.match(said.title, /Sign-in expired/);
  assert.match(said.title, /the laptop/);
  assert.match(said.body, /auth login/);
});
