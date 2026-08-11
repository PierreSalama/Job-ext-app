// THE PARK-RESCUE HOT LOOP — 24 hours of the server burning its entire daily apply budget and
// submitting nothing at all.
//
// Live on pierre-laptop, 2026-08-11:
//   • the supervisor log showed the SAME three Tenstorrent Greenhouse jobs cycling every ~20s,
//     each answering 401 "UnauthorizedError: User is not logged in."
//   • the app log showed "pipeline watchdog requeued 2-3 park(s) that are now answerable" EVERY
//     MINUTE, without pause, for a day
//   • Indeed's apply budget read 40/40 spent, and verified submissions in 24h were ZERO
//
// The mechanism: queueRetryParked requeues a parked task whenever memory COULD answer its pending
// questions, clearing park_reason, pending_questions and the failure record on the way out. It kept
// no record of having tried. So a task that parks for a reason the questions have nothing to do
// with — a 401 — is rescued, fails identically, parks, and is rescued again 60 seconds later. The
// attempts cap can never bite because the rescue wipes the evidence.
//
// The fix is a bound, not smarter detection: after MAX_PARK_RESCUES the task stays parked and
// surfaces to a human, instead of quietly consuming the account's daily budget forever.
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

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-rescue-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

let n = 0;
// A park whose questions memory CAN answer — the exact shape that qualified for rescue forever.
function parkedAnswerable() {
  const pid = db.ensureDefaultProfileId();
  const q = `Do you have experience with tool ${++n}?`;
  db.profileFieldUpsert({ profileId: pid, question: q, value: 'Yes', fromUser: true, confidence: 1 });
  const job = db.upsertJob({ title: `Role ${n}`, company: `Co${n}`, source: 'greenhouse', status: 'started', jobUrl: `https://job-boards.greenhouse.io/x/${n}` }).job;
  const t = db.queueAdd(job.id, { mode: 'auto' });
  db.queuePatch(t.id, { state: 'parked', parkReason: 'needs 1 answer(s)', pendingQuestions: [{ question: q }] });
  return t.id;
}
// Re-park it exactly as the executor would after failing again for an unrelated reason (the 401).
function reparkSameWay(taskId) {
  const t = db.queueGet(taskId);
  const q = `Do you have experience with tool ${String(t.jobId).slice(-1)}?`;
  db.queuePatch(taskId, { state: 'parked', parkReason: 'needs 1 answer(s)', pendingQuestions: [{ question: q }] });
}

test('an answerable park IS rescued — the useful behaviour is preserved', () => {
  const id = parkedAnswerable();
  assert.equal(db.queueRetryParked(), 1);
  assert.equal(db.queueGet(id).state, 'queued');
});

test('THE LOOP IS BOUNDED — a task that keeps re-parking is eventually left alone', () => {
  const id = parkedAnswerable();
  let rescues = 0;
  // Simulate the live loop: rescue, fail identically, re-park. Unbounded, this runs forever.
  for (let i = 0; i < 25; i++) {
    const r = db.queueRetryParked();
    if (!r) break;
    rescues += r;
    reparkSameWay(id);
  }
  assert.ok(rescues <= 3, `stopped after ${rescues} rescues, not 25 — a bound, not a smarter guess`);
  assert.equal(db.queueGet(id).state, 'parked', 'it stays parked, where a human can see it');
});

test('the rescue count is persisted, so a restart does not reset the loop', () => {
  const id = parkedAnswerable();
  db.queueRetryParked();
  const t = db.queueGet(id);
  assert.equal(t.rescueCount, 1, 'the counter survives on the row, not in memory');
});

test('each task is bounded independently — one bad job does not starve the others', () => {
  const stuck = parkedAnswerable();
  for (let i = 0; i < 5; i++) { db.queueRetryParked(); reparkSameWay(stuck); }
  const fresh = parkedAnswerable();
  assert.equal(db.queueRetryParked(), 1, 'a NEW answerable park is still rescued');
  assert.equal(db.queueGet(fresh).state, 'queued');
});

test('a park with genuinely unanswerable questions is never rescued at all', () => {
  const job = db.upsertJob({ title: 'Unanswerable', company: 'X', source: 'linkedin', status: 'started', jobUrl: 'https://x/u1' }).job;
  const t = db.queueAdd(job.id, { mode: 'auto' });
  db.queuePatch(t.id, { state: 'parked', parkReason: 'needs 1 answer(s)', pendingQuestions: [{ question: 'What is your grandmother\'s maiden name in hex?' }] });
  db.queueRetryParked();
  assert.equal(db.queueGet(t.id).state, 'parked');
  assert.equal(db.queueGet(t.id).rescueCount, 0, 'not rescued means not counted');
});

test('the bound is small enough to stop wasting budget within minutes', () => {
  // The watchdog runs every 60s. At 3 rescues the loop costs 3 minutes, not 24 hours.
  const src = fs.readFileSync(path.join(here, '..', 'app', 'src', 'db.js'), 'utf8');
  const m = /const MAX_PARK_RESCUES = (\d+);/.exec(src);
  assert.ok(m, 'the bound is a named constant');
  assert.ok(Number(m[1]) <= 5, `MAX_PARK_RESCUES=${m[1]} — a large bound is the bug with extra steps`);
});

test('the incident is documented where the next person will look', () => {
  const src = fs.readFileSync(path.join(here, '..', 'app', 'src', 'db.js'), 'utf8');
  const fn = src.slice(src.indexOf('function queueRetryParked'), src.indexOf('function saveIntakeAnswer'));
  assert.match(fn, /hot loop/i);
  assert.match(fn, /401|budget/i, 'the symptom that made it findable');
});
