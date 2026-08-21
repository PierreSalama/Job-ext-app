// END TO END, over real HTTP against a real server and a real DB: the executor's own state
// transitions must charge and refund the platform budget correctly.
//
// The live failure this covers: 76 charged dispatches on pierre-laptop produced 12 applications,
// because every LinkedIn job that turned out to be an external posting cost exactly as much
// allowance as one that was actually submitted.
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

let dir, srv, base, token;
test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-refund-e2e-'));
  db.open(dir);
  srv = await server.startServer(0, { userDataDir: dir });
  base = `http://127.0.0.1:${srv.address().port}`;
  token = server.getToken();
});
test.after(() => {
  try { server.stopServer(); } catch {}
  try { db.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

const H = () => ({ 'X-JAT-Token': token, 'Content-Type': 'application/json' });
let n = 0;
async function queuedTask(source) {
  n += 1;
  // upsertJob returns { job, created } — not the job itself.
  const { job } = db.upsertJob({
    title: `Test Engineer ${n}`, company: `Co${n}`, jobUrl: `https://example.com/j/${n}`,
    source, status: 'saved',
  });
  const t = db.queueAdd(job.id, { force: true });
  assert.ok(t, 'task queued');
  return t;
}
const patch = (id, body) => fetch(`${base}/queue/${id}`, { method: 'PATCH', headers: H(), body: JSON.stringify(body) });
const applyDay = (p) => db.platformTouchCounts(p).apply.day;
const visitDay = (p) => db.platformTouchCounts(p).visit.day;

test('running charges the apply budget exactly once, tagged with the task', async () => {
  const t = await queuedTask('linkedin');
  const before = applyDay('linkedin');
  assert.equal((await patch(t.id, { state: 'running' })).status, 200);
  assert.equal(applyDay('linkedin'), before + 1);
  // A second progress report on an already-running task must not charge again.
  await patch(t.id, { state: 'running', transcript: 'still going' });
  assert.equal(applyDay('linkedin'), before + 1, 'no double charge');
});

test('an external posting gives the allowance back', async () => {
  const t = await queuedTask('linkedin');
  const beforeApply = applyDay('linkedin');
  const beforeVisit = visitDay('linkedin');
  await patch(t.id, { state: 'running' });
  assert.equal(applyDay('linkedin'), beforeApply + 1, 'charged on open');
  await patch(t.id, { state: 'skipped', lastError: 'external posting — no Easy Apply on this job (skipped, easy-apply-only)' });
  assert.equal(applyDay('linkedin'), beforeApply, 'refunded on skip');
  assert.equal(visitDay('linkedin'), beforeVisit + 1, 'kept on the record as a page view');
});

test('a REAL session keeps its charge — parked for answers', async () => {
  const t = await queuedTask('indeed');
  const before = applyDay('indeed');
  await patch(t.id, { state: 'running' });
  await patch(t.id, { state: 'parked', lastError: 'needs 1 answer(s)' });
  assert.equal(applyDay('indeed'), before + 1, 'a filled form that stopped for answers stays charged');
});

test('a REAL session keeps its charge — a driven page that found no form', async () => {
  const t = await queuedTask('indeed');
  const before = applyDay('indeed');
  await patch(t.id, { state: 'running' });
  await patch(t.id, { state: 'skipped', lastError: 'no Easy Apply opener and no drivable form appeared (visible tab) — inspect' });
  assert.equal(applyDay('indeed'), before + 1, 'we drove this page; it is not a peek');
});

test('a submission keeps its charge', async () => {
  const t = await queuedTask('linkedin');
  const before = applyDay('linkedin');
  await patch(t.id, { state: 'running' });
  await patch(t.id, { state: 'done', transcript: 'application submitted (text-became-success)' });
  assert.equal(applyDay('linkedin'), before + 1);
});

test('the refund survives a replayed terminal patch', async () => {
  const t = await queuedTask('linkedin');
  const before = applyDay('linkedin');
  await patch(t.id, { state: 'running' });
  const reason = 'no Easy Apply on this posting — apply is on the company site (not auto-applicable)';
  await patch(t.id, { state: 'skipped', lastError: reason });
  await patch(t.id, { state: 'skipped', lastError: reason });
  assert.equal(applyDay('linkedin'), before, 'still exactly one refund, not a negative balance');
});

test('the net effect: ten dispatches, three applyable — only three eat the budget', async () => {
  const start = applyDay('glassdoor');
  for (let i = 0; i < 10; i++) {
    const t = await queuedTask('glassdoor');
    await patch(t.id, { state: 'running' });
    if (i < 3) await patch(t.id, { state: 'done', transcript: 'application submitted (new-confirmation-node)' });
    else await patch(t.id, { state: 'skipped', lastError: 'external posting — no Easy Apply on this job (skipped, easy-apply-only)' });
  }
  assert.equal(applyDay('glassdoor') - start, 3, 'the old behaviour charged all ten');
  assert.equal(visitDay('glassdoor'), 7);
});
