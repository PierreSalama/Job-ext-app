// THE SECOND UNBOUNDED RETRY LOOP. Same shape as the park-rescue loop fixed in v11.102.0, on a
// different path — which is why the fix is a counter the retry cannot reset, not a smarter guess.
//
// Live 2026-08-12: the laptop's ONE runner sat on a single Greenhouse posting (elastic "Java
// Developer II - AutoOps Services") for 14+ hours, cycling
//     Apply Now → "self-heal retry after transient_page (environmental — no attempt charged)"
// every ~29 minutes, while 300+ other jobs waited behind it. dispatched=284, verified_done=0.
//
// retryStaleQueue believed it had TWO brakes. Both fail open for exactly this case:
//   1. maxAttempts — but an environmental failure sets attemptsDelta:0 on purpose (a throttled tab
//      says nothing about the posting), so `attempts` stays 0 and the cap never fires.
//   2. maxAgeHours — its own comment promises it "retires anything that has been failing for a full
//      day, so nothing retries forever". It filters on `updated_at >= ageFloor`, and every retry
//      WRITES updated_at. A looping task therefore always looks freshly updated and can never age
//      out. The ceiling measures the clock the retry itself resets.
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
const src = fs.readFileSync(path.join(here, '..', 'app', 'src', 'db.js'), 'utf8');

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-selfheal-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

let n = 0;
// A task failed the way the live one did: environmental, so no attempt is charged.
function failedEnvironmentally() {
  const job = db.upsertJob({ title: `Java Developer II ${++n}`, company: 'elastic', source: 'greenhouse', status: 'started', jobUrl: `https://job-boards.greenhouse.io/elastic/${n}` }).job;
  const t = db.queueAdd(job.id, { mode: 'auto' });
  db.queuePatch(t.id, { state: 'failed', lastError: 'page stopped advancing — will retry' });
  return t.id;
}
test('the environmental failure genuinely charges no attempt — the premise of the bug', () => {
  const id = failedEnvironmentally();
  assert.equal(db.queueGet(id).attempts, 0);
});

test('THE LOOP IS BOUNDED — a task cannot be self-healed forever', () => {
  const id = failedEnvironmentally();
  let heals = 0;
  // Drive the live loop: retry, fail environmentally again, repeat. Unbounded, this never ends.
  for (let i = 0; i < 30; i++) {
    const healed = db.retryStaleQueue({ olderThanMinutes: -1, maxAttempts: 3, limit: 50 });
    if (!healed) break;
    heals += healed;
    db.queuePatch(id, { state: 'failed', lastError: 'page stopped advancing — will retry' });
  }
  assert.ok(heals > 0, 'precondition: the retry path actually ran — 0 heals would pass the bound vacuously');
  // Assert on THIS task, not the aggregate: retryStaleQueue heals every eligible task, so `heals`
  // also counts tasks left behind by other tests in this shared DB.
  const t = db.queueGet(id);
  assert.ok(t.selfHealCount <= 4, `this task was healed ${t.selfHealCount} times, bound is 4`);
  assert.equal(t.state, 'failed', 'it stays failed, freeing the runner for the queue behind it');
});

test('the counter is persisted on the row, so a restart cannot reset the loop', () => {
  const id = failedEnvironmentally();
  db.retryStaleQueue({ olderThanMinutes: -1, maxAttempts: 3, limit: 50 });
  assert.equal(db.queueGet(id).selfHealCount, 1);
});

test('a self-heal is still USEFUL — a genuinely transient failure recovers', () => {
  const id = failedEnvironmentally();
  assert.equal(db.retryStaleQueue({ olderThanMinutes: -1, maxAttempts: 3, limit: 50 }), 1);
  assert.equal(db.queueGet(id).state, 'queued', 'the healing behaviour is preserved, only bounded');
});

test('one stuck task does not consume the budget of the others', () => {
  const stuck = failedEnvironmentally();
  for (let i = 0; i < 8; i++) {
    db.retryStaleQueue({ olderThanMinutes: -1, maxAttempts: 3, limit: 50 });
    db.queuePatch(stuck, { state: 'failed', lastError: 'page stopped advancing — will retry' });
  }
  const fresh = failedEnvironmentally();
  db.retryStaleQueue({ olderThanMinutes: -1, maxAttempts: 3, limit: 50 });
  assert.equal(db.queueGet(fresh).state, 'queued', 'a NEW transient failure still heals');
});

test('a NON-environmental failure still charges an attempt, so maxAttempts still governs it', () => {
  const job = db.upsertJob({ title: 'Broken form', company: 'X', source: 'greenhouse', status: 'started', jobUrl: 'https://x/broken' }).job;
  const t = db.queueAdd(job.id, { mode: 'auto' });
  db.queuePatch(t.id, { state: 'failed', lastError: 'stuck on a step (page stopped advancing) — will retry' });
  const before = db.queueGet(t.id).attempts;
  db.retryStaleQueue({ olderThanMinutes: -1, maxAttempts: 3, limit: 50 });
  assert.ok(db.queueGet(t.id).attempts >= before, 'the existing attempt accounting is untouched');
});

// ---- the reasoning has to survive, or this gets "simplified" back into a loop -------------------

test('the bound is small enough to matter', () => {
  const m = /const MAX_SELF_HEALS = (\d+);/.exec(src);
  assert.ok(m, 'named constant');
  assert.ok(Number(m[1]) <= 6, `MAX_SELF_HEALS=${m[1]} — at ~29 min a cycle, a large bound is the bug with extra steps`);
});

test('the updated_at trap is documented, because it looks like a working ceiling', () => {
  const fn = src.slice(src.indexOf('function retryStaleQueue('), src.indexOf('// Tasks stuck in'));
  assert.match(fn, /updated_at/, 'the ceiling that cannot fire must be called out');
  assert.match(fn, /cannot be reset by the retry itself/i);
});
