// One machine's ledger is not the whole story.
//
// Found the first time AI Apply ran for real on the server laptop. The laptop and the PC keep
// separate databases and neither can see the other, so every one of the 56 applications made by
// hand from the PC was invisible to the laptop. `check_duplicate` would have answered "fresh" for
// employers Pierre had already applied to, and in one case interviewed with. A duplicate
// application to a real employer cannot be taken back, which puts this in the same class as the
// CAPTCHA rule: the check has to fail closed, not fail quiet.
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
const { makeJatTools, sweepPeers } = require(path.join(root, 'app/src/ai/tools/jat.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-xnode-'));
db.open(dir);
process.on('exit', () => {
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
});

// A peer that has applied to Zip, exactly as the PC had when the laptop had not.
const PC = {
  nodes: async () => [{ name: 'the PC', baseUrl: 'http://pc', token: 't' }],
  engaged: async (_n, { company }) => (/zip/i.test(company || '')
    ? [{ company: 'Zip', title: 'Software Engineer, Backend', status: 'submitted', matchedOn: 'slug', slug: 'zip' }]
    : []),
};
const NOBODY = { nodes: async () => [], engaged: async () => [] };
const OFFLINE = {
  nodes: async () => [{ name: 'the PC', baseUrl: 'http://pc', token: 't' }],
  engaged: async () => { throw new Error('ECONNREFUSED'); },
};

const ask = async (peers, args) => {
  const t = makeJatTools({ peers }).tools.find((x) => x.name === 'check_duplicate');
  return t.run(args);
};

const ZIP = { url: 'https://jobs.ashbyhq.com/zip/abc', company: 'Zip', title: 'Software Engineer, Backend' };

test('an application made on the OTHER machine is a duplicate here', async () => {
  const said = await ask(PC, ZIP);
  assert.match(said, /DUPLICATE/);
  assert.match(said, /the PC/, 'it must say which machine, or he cannot check it himself');
  assert.match(said, /submitted/);
  assert.match(said, /Do not apply again/);
});

test('an unreachable peer is NOT a clean bill of health', async () => {
  // The whole failure mode in one test: silence from a peer must never read as "nothing there".
  const said = await ask(OFFLINE, ZIP);
  assert.doesNotMatch(said, /^fresh/);
  assert.match(said, /NOT FULLY CHECKED/);
  assert.match(said, /the PC/);
  assert.match(said, /ECONNREFUSED/);
  assert.match(said, /Ask the human/);
});

test('with every machine checked and nothing found, fresh says so plainly', async () => {
  const said = await ask(PC, { url: 'https://jobs.lever.co/nowhere/1', company: 'Nowhere Inc', title: 'Dev' });
  assert.match(said, /^fresh/);
  assert.match(said, /on any machine/);
});

test('no peers configured still works, and does not claim more than it checked', async () => {
  const said = await ask(NOBODY, { url: 'https://jobs.lever.co/nowhere/1', company: 'Nowhere Inc', title: 'Dev' });
  assert.match(said, /^fresh/);
});

test('this machine wins early: a local hit never waits on the network', async () => {
  db.upsertJob({ company: 'Localcorp', title: 'Developer', status: 'submitted', jobUrl: 'https://jobs.lever.co/localcorp/9' });
  let asked = false;
  const spy = { nodes: async () => { asked = true; return []; }, engaged: async () => [] };
  const said = await ask(spy, { url: 'https://jobs.lever.co/localcorp/9', company: 'Localcorp', title: 'Developer' });
  assert.match(said, /DUPLICATE/);
  assert.match(said, /this machine/);
  assert.equal(asked, false, 'no reason to ask anyone else once it is already known');
});

test('the same role on another machine is reported ahead of a different one', async () => {
  const many = {
    nodes: async () => [{ name: 'the PC' }],
    engaged: async () => [
      { company: 'Zip', title: 'Data Scientist', status: 'ghosted' },
      { company: 'Zip', title: 'Software Engineer, Backend', status: 'submitted' },
    ],
  };
  const said = await ask(many, ZIP);
  assert.match(said, /Software Engineer, Backend/);
  assert.match(said, /the same role/);
});

test('one peer failing does not hide a duplicate found on another', async () => {
  const mixed = {
    nodes: async () => [{ name: 'the dead one' }, { name: 'the PC' }],
    engaged: async (n) => {
      if (n.name === 'the dead one') throw new Error('timeout');
      return [{ company: 'Zip', title: 'Software Engineer, Backend', status: 'submitted' }];
    },
  };
  assert.match(await ask(mixed, ZIP), /DUPLICATE/);
});

test('a broken node list is reported, not swallowed', async () => {
  const bad = { nodes: async () => { throw new Error('settings unreadable'); }, engaged: async () => [] };
  const r = await sweepPeers(bad, { company: 'Zip' });
  assert.equal(r.unreachable.length, 1);
  assert.match(r.unreachable[0].why, /settings unreadable/);
});

test('the peer-facing endpoint exists and is read-only', () => {
  const src = fs.readFileSync(path.join(root, 'app/src/server.js'), 'utf8');
  // Asking another machine what it knows must never be able to change what it knows.
  assert.match(src, /req\.method === 'GET' && pathname === '\/ai-apply\/engaged'/);
  const route = src.slice(src.indexOf("pathname === '/ai-apply/engaged'"));
  const body = route.slice(0, route.indexOf('\n  }'));
  for (const w of ['upsertJob', 'aiBlockCreate', 'INSERT', 'UPDATE', 'DELETE']) {
    assert.equal(body.includes(w), false, `the engaged endpoint must not ${w}`);
  }
});

test('a peer on an older build is asked a question it CAN answer', async () => {
  // /ai-apply/engaged does not exist before this change. During the update window the fallback has
  // to work, or the laptop reports every PC application as unreachable and nothing can be applied to.
  const runner = fs.readFileSync(path.join(root, 'app/src/ai/apply-runner.js'), 'utf8');
  assert.match(runner, /e\.status !== 404/, 'only a missing route may fall back');
  assert.match(runner, /\/jobs\?q=/, 'the fallback uses the search every build has');
  assert.match(runner, /hand-applied/, 'and it must honour the hand-applied tag too');
});
