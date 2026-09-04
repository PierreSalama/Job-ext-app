// AI Apply chunk 9 — the desktop alert bridge.
//
// A CAPTCHA on the server laptop is worth nothing if Pierre is at his desk and never hears about
// it. These tests run entirely offline: the peer reader is injected, so "the laptop" is a function.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const db = require(path.join(root, 'app', 'src', 'db.js'));
const alerts = require(path.join(root, 'app', 'src', 'ai', 'alerts.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-alerts-'));
db.open(dir);
process.on('exit', () => {
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
});

const block = (over = {}) => ({
  id: 'blk_' + Math.random().toString(16).slice(2), status: 'open', urgency: 'alert',
  kind: 'captcha', question: 'Human check', company: 'Hamilton ETFs', title: 'Full Stack Developer',
  ...over,
});

function watcher(opts = {}) {
  const got = [];
  const w = alerts.makeAlertWatcher({
    db,
    fetchPeer: async () => [],
    nodes: () => [],
    onAlert: (a) => got.push(a),
    ...opts,
  });
  w._forget();
  return { w, got };
}

// ---------------------------------------------------------------------------
// what gets announced
// ---------------------------------------------------------------------------
test('an alert-urgency block on THIS machine is announced', async () => {
  const b = db.aiBlockCreate({ kind: 'captcha', question: 'Human check on Hamilton ETFs', company: 'Hamilton ETFs' });
  const { w, got } = watcher();
  await w.tick();
  assert.ok(got.some((a) => a.block.id === b.id), 'a stopped run must reach him');
});

test('a queued question is NOT announced — it waits on the page', async () => {
  db.aiBlockCreate({ kind: 'needs_answer', question: 'How many years of Kubernetes?' });
  const { w, got } = watcher();
  await w.tick();
  assert.equal(got.some((a) => a.block.kind === 'needs_answer'), false,
    'interrupting him for something that can wait is how alerts get ignored');
});

test('a peer node is polled, and its blocks are announced by NAME', async () => {
  const laptop = block({ kind: 'account', company: 'Clio', title: 'Software Developer' });
  const { w, got } = watcher({
    nodes: () => [{ name: 'Server laptop', baseUrl: 'http://100.104.86.34:7744', token: 't' }],
    fetchPeer: async (n) => (n.name === 'Server laptop' ? [laptop] : []),
  });
  await w.tick();
  const a = got.find((x) => x.block.id === laptop.id);
  assert.ok(a, 'the laptop is where the agent actually runs');
  assert.match(a.title, /Server laptop/, 'he must know WHICH machine to walk to');
  assert.match(a.body, /Clio/);
  assert.match(a.body, /Create the account once/, 'and what to actually do');
});

test('each alert is announced exactly once, even across a restart', async () => {
  const b = block();
  // Count only THIS block: the shared database also holds alerts created by earlier tests, and
  // this assertion is about repeat-announcement, not about how many others happen to be open.
  const mine = (list) => list.filter((a) => a.block.id === b.id).length;

  const first = watcher({ nodes: () => [{ name: 'L', baseUrl: 'x', token: 't' }], fetchPeer: async () => [b] });
  await first.w.tick();
  assert.equal(mine(first.got), 1);
  await first.w.tick();
  assert.equal(mine(first.got), 1, 'the same block must not be announced twice');

  // A brand-new watcher, as after an app restart, reading the same remembered ids.
  const got2 = [];
  const second = alerts.makeAlertWatcher({
    db, nodes: () => [{ name: 'L', baseUrl: 'x', token: 't' }],
    fetchPeer: async () => [b], onAlert: (a) => got2.push(a),
  });
  await second.tick();
  assert.equal(got2.filter((a) => a.block.id === b.id).length, 0,
    'restarting must not re-announce a block already delivered');
});

test('a peer that is asleep is skipped quietly, and the local ones still get through', async () => {
  const b = db.aiBlockCreate({ kind: 'password', question: 'A password is needed here' });
  const { w, got } = watcher({
    nodes: () => [{ name: 'Dead laptop', baseUrl: 'x', token: 't' }],
    fetchPeer: async () => { throw new Error('ECONNREFUSED'); },
  });
  const delivered = await w.tick();
  assert.ok(delivered.length >= 1, 'an unreachable peer must not stop the whole pass');
  assert.ok(got.some((a) => a.block.id === b.id));
});

test('overlapping ticks do not stack up on a slow peer', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const { w } = watcher({
    nodes: () => [{ name: 'Slow', baseUrl: 'x', token: 't' }],
    fetchPeer: async () => {
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 40));
      concurrent--;
      return [];
    },
  });
  await Promise.all([w.tick(), w.tick(), w.tick()]);
  assert.equal(maxConcurrent, 1, 'a slow node must not cause overlapping polls');
});

// ---------------------------------------------------------------------------
// the message itself
// ---------------------------------------------------------------------------
test('the message names the machine, the employer and the action', () => {
  const d = alerts.describe(block({ kind: 'captcha', company: 'Hamilton ETFs', title: 'Full Stack Developer' }), 'Server laptop');
  assert.match(d.title, /Human check/);
  assert.match(d.title, /Server laptop/);
  assert.match(d.body, /Hamilton ETFs — Full Stack Developer/);
  assert.match(d.body, /Tick the human check/);
});

test('every alert kind has a concrete instruction', () => {
  for (const kind of ['captcha', 'account', 'password', 'auth_lapsed']) {
    const d = alerts.describe(block({ kind }), 'Server laptop');
    assert.ok(d.body.length > 10, `${kind} has no usable body`);
    assert.ok(!/undefined/.test(d.title + d.body), `${kind} renders undefined`);
  }
});

test('a body stays short enough for an OS notification', () => {
  const d = alerts.describe(block({ company: 'x'.repeat(300), title: 'y'.repeat(300) }), 'Server laptop');
  assert.ok(d.body.length <= 240);
});

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
const mainJs = fs.readFileSync(path.join(root, 'app', 'src', 'main.js'), 'utf8');

test('the watcher is started with the server and raises a REAL OS notification', () => {
  assert.match(mainJs, /startAlertWatcher\(\)/, 'it must actually be started');
  const block2 = mainJs.slice(mainJs.indexOf('function startAlertWatcher'));
  assert.match(block2, /nativeNotify\(title, body\)/,
    'an in-app toast alone is invisible behind a full-screen game');
  assert.match(block2, /X-JAT-Token/, 'peers are authed');
  assert.match(block2, /db\.getSettings\(\)\.nodes/, 'peers come from his configured nodes');
});
