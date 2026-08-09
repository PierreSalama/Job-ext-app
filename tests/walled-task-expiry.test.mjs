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
