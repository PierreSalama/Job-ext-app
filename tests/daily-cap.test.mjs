// FIX 5 (anti-ban): soft DAILY CAP + gentler whole-session pacing.
// autoApply.dailyCap (default 120) counts EVERY apply DISPATCH (submits + attempts) in the
// rolling 24h. When it's reached, queueNext pauses dispatch with reason 'daily-soft-cap'
// until the window rolls — so an over-aggressive maxPerHour (e.g. 999) can't drive a marathon
// session that throttles/bans the account. Configurable; dailyCap<=0 disables it. This must
// NOT regress the existing window/cap/gap pacing.

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
const { DEFAULTS } = require(path.join(here, '..', 'app', 'src', 'config.js'));

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-dailycap-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

function addTask({ url, state = 'queued', lastError = '' }) {
  const job = db.upsertJob({ externalId: url, title: 'Dev ' + url, company: 'Acme', source: 'linkedin', status: 'started', jobUrl: url }).job;
  const task = db.queueAdd(job.id, { mode: 'auto' });
  if (state !== 'queued') db.queuePatch(task.id, { state, lastError });
  return task;
}

test('config: autoApply.dailyCap default is 120 (and exists)', () => {
  assert.equal(DEFAULTS.autoApply.dailyCap, 120);
});

test('queueRunStats.dispatchedDay counts submits + attempts in the rolling 24h', () => {
  addTask({ url: 'https://linkedin.com/jobs/view/d1', state: 'done', lastError: '' });
  addTask({ url: 'https://linkedin.com/jobs/view/d2', state: 'failed', lastError: 'will retry' });
  addTask({ url: 'https://linkedin.com/jobs/view/d3', state: 'skipped', lastError: 'external' });
  const stats = db.queueRunStats();
  assert.ok(stats.dispatchedDay >= 3, 'done + failed + skipped all count as dispatches');
});

test('queueNext pauses with daily-soft-cap once dispatchedDay >= dailyCap', async () => {
  // Aggressive maxPerHour/maxPerDay so ONLY the soft cap can gate; a SMALL dailyCap.
  // runAnytime keeps the window open; a generous gap so the gap clock never trips first.
  db.patchSettings({ autoApply: {
    enabled: true, runAnytime: true, maxPerHour: 999, maxPerDay: 999,
    minGapMinutes: 0, maxGapMinutes: 0, dailyCap: 5,
  } });
  // Drive dispatchedDay to the cap with ATTEMPTS (failed) so doneDay/doneHour stay 0 and the
  // hourly/daily SUCCESS caps can't be the thing that gates — isolating the soft cap.
  for (let i = 0; i < 6; i++) addTask({ url: `https://linkedin.com/jobs/view/cap${i}`, state: 'failed', lastError: 'will retry' });
  // Leave a dispatchable queued task so the only reason to refuse is the cap.
  addTask({ url: 'https://linkedin.com/jobs/view/fresh', state: 'queued' });

  const res = await server.queueNext(false);
  assert.equal(res.task, null);
  assert.equal(res.reason, 'daily-soft-cap');
  assert.equal(res.dailyCap, 5);
  assert.ok(res.dispatchedDay >= 5);
});

test('dailyCap <= 0 disables the soft cap (no regression to old pacing)', async () => {
  db.patchSettings({ autoApply: { dailyCap: 0 } });
  const res = await server.queueNext(false);
  // With the soft cap off, the gate falls through to the normal dispatch path — so the reason
  // is anything EXCEPT daily-soft-cap (it will dispatch the queued task or hit gap/empty).
  assert.notEqual(res.reason, 'daily-soft-cap');
});

test('force=true bypasses the soft cap (the dashboard "apply now" button)', async () => {
  db.patchSettings({ autoApply: { dailyCap: 1 } });
  const res = await server.queueNext(true);
  assert.notEqual(res.reason, 'daily-soft-cap');
});
