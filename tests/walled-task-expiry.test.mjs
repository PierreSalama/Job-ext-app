// Tasks stuck behind a host verification wall must retire themselves.
//
// The dispatch breaker parks a walled task by pushing scheduled_at into the FUTURE and leaving it
// 'queued'. That is deliberate: on 2026-07-20 skipping them destroyed 40+ never-attempted jobs in
// ten minutes, and a TRANSIENT wall must never discard work.
//
// But a wall that does not lift leaves those tasks queued forever. Live: 65 Indeed jobs sat behind
// Indeed's wall (oldest 6 days), held the queue above refillBelow and starved discovery for 18h, and
// then had to be cleared BY HAND in nearly every check-up across 2026-08-07/08/09 — the single most
// repeated manual intervention in this system.
//
// The bound satisfies both: hours of walling still defers and retries untouched; only a full day of
// being un-dispatchable retires the task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import os from 'node:os';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const db = read('app', 'src', 'db.js');
const main = read('app', 'src', 'main.js');

const HOUR = 3600 * 1000;
// Mirror the SQL predicate: queued AND scheduled_at in the future AND created_at older than cutoff.
function retires({ state, scheduledAt, createdAt, now, olderThanHours = 24 }) {
  if (state !== 'queued') return false;
  if (!scheduledAt) return false;
  if (scheduledAt <= now) return false;                       // due now — not walled
  return createdAt < now - olderThanHours * HOUR;
}

test('the live case retires: an Indeed task walled for 6 days', () => {
  const now = Date.now();
  assert.equal(retires({ state: 'queued', scheduledAt: now + 20 * 60000, createdAt: now - 6 * 24 * HOUR, now }), true);
});

test('a TRANSIENT wall is left alone — this is the 2026-07-20 protection', () => {
  const now = Date.now();
  assert.equal(retires({ state: 'queued', scheduledAt: now + 20 * 60000, createdAt: now - 2 * HOUR, now }), false,
    'two hours behind a wall must still defer and retry, never be discarded');
  assert.equal(retires({ state: 'queued', scheduledAt: now + 20 * 60000, createdAt: now - 23 * HOUR, now }), false,
    'just under the bound still defers');
});

test('a task that is simply DUE is never retired, however old', () => {
  const now = Date.now();
  assert.equal(retires({ state: 'queued', scheduledAt: now - 60000, createdAt: now - 30 * 24 * HOUR, now }), false,
    'past scheduled_at means dispatchable — age alone must not retire it');
});

test('only queued tasks are considered', () => {
  const now = Date.now();
  for (const state of ['running', 'parked', 'done', 'failed', 'awaiting_review']) {
    assert.equal(retires({ state, scheduledAt: now + 20 * 60000, createdAt: now - 6 * 24 * HOUR, now }), false,
      `${state} is not the breaker's deferral state`);
  }
});

test('the implementation gates on BOTH future scheduled_at and age', () => {
  const fn = db.slice(db.indexOf('function expireWalledTasks'), db.indexOf('// Repair PASSIVE-CAPTURE'));
  assert.ok(fn.length, 'expireWalledTasks must exist');
  assert.match(fn, /state = 'queued'/, 'only the breaker deferral state');
  assert.match(fn, /scheduled_at > \?/, 'must require it to still be deferred into the future');
  assert.match(fn, /created_at < \?/, 'must require it to have been that way for the bound');
  assert.match(fn, /state='skipped'/, 'retire terminally so it stops holding a queue slot');
  assert.match(fn, /LIMIT \?/, 'bounded per pass');
});

test('it runs unattended in the pipeline watchdog', () => {
  assert.match(main, /db\.expireWalledTasks\(/,
    'if it is not wired into the watchdog it is still a manual chore, which is the whole bug');
  const tick = main.slice(main.indexOf('async function pipelineWatchdogTick'));
  assert.match(tick.slice(0, 2500), /expireWalledTasks/, 'must be inside the watchdog tick');
});

test('the default bound is a full day, not something twitchy', () => {
  const fn = db.slice(db.indexOf('function expireWalledTasks'));
  assert.match(fn.slice(0, 400), /olderThanHours = 24/,
    'shorter than a day risks re-creating the 07-20 data loss on a slow-lifting wall');
});

// The tests above assert the SQL as text and run `retires`, a local mirror of the same predicate.
// A mirror agrees with the real query by construction, and the text assertions cannot tell whether
// the query is ever reached or what it actually does to a row. Both directions matter here and
// both have already gone wrong in production: retiring too eagerly destroyed 40+ never-attempted
// jobs in ten minutes on 2026-07-20, and not retiring at all starved discovery for 18 hours.
// expireWalledTasks is exported, so run it against a real ledger.
test('BEHAVIOUR: a day-old wall retires, a fresh one and a due task do not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-walled-'));
  const ledger = require(path.join(here, '..', 'app', 'src', 'db.js'));
  const { Database } = require(path.join(here, '..', 'app', 'node_modules', 'node-sqlite3-wasm'));
  ledger.open(dir);

  // created_at is set by the ledger and there is no API to backdate it, so reach in with a
  // short-lived second handle — the pattern rank-punish.test.mjs already uses for decay_at.
  const backdate = (taskId, ms) => {
    const h = new Database(path.join(dir, 'jat.db'));
    try { h.run('UPDATE auto_apply_tasks SET created_at = ? WHERE id = ?', [new Date(Date.now() - ms).toISOString(), taskId]); }
    finally { h.close(); }
  };

  try {
    const mk = (n, { deferHours, ageHours }) => {
      const url = `https://ca.indeed.com/viewjob?jk=walled${n}`;
      const { job } = ledger.upsertJob({ title: 'Dev', company: `Co ${n}`, jobUrl: url, status: 'started', source: 'indeed' }, { manual: true });
      const t = ledger.queueAdd(job.id, { mode: 'auto', force: true });
      ledger.queuePatch(t.id, { state: 'queued', scheduledAt: new Date(Date.now() + deferHours * HOUR).toISOString() });
      backdate(t.id, ageHours * HOUR);
      return t.id;
    };

    const walledSixDays = mk(1, { deferHours: 1, ageHours: 6 * 24 });   // the live Indeed case
    const walledTwoHours = mk(2, { deferHours: 1, ageHours: 2 });       // transient — must survive
    const oldButDue = mk(3, { deferHours: -1, ageHours: 30 * 24 });     // ancient but dispatchable

    const retired = ledger.expireWalledTasks({ olderThanHours: 24 });
    const stateOf = (id) => ledger.queueList({}).find((t) => t.id === id)?.state;

    assert.equal(retired, 1, 'exactly one task qualified');
    assert.equal(stateOf(walledSixDays), 'skipped', 'a wall that never lifted must stop holding a queue slot');
    assert.equal(stateOf(walledTwoHours), 'queued',
      'THE 2026-07-20 PROTECTION: a transient wall must still defer and retry, never be discarded');
    assert.equal(stateOf(oldButDue), 'queued',
      'past its scheduled time means dispatchable — age alone must never retire a task');
  } finally {
    try { ledger.close(); } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
});
