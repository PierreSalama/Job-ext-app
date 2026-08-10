// Backend layer for the daily schedule: the settings actually round-trip through the real DB.
//
// The pure rules are covered in daily-schedule.test.mjs. This proves the parts that only break in
// the database: that the schedule block exists with Pierre's defaults, that a partial patch merges
// instead of clobbering siblings, that the once-per-day ledger persists, and — the one that would
// silently break the whole feature — that writing the ledger does not disturb autoApply.enabled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const db = require_(path.join(here, '..', 'app', 'src', 'db.js'));

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-sched-')); db.open(dir); });

test('the schedule ships with Pierre\'s window, and OFF by default', () => {
  const s = db.getSettings().autoApply.schedule;
  assert.equal(s.enabled, false, 'a node must never start applying on a timer nobody set');
  assert.equal(s.onAt, '04:00');
  assert.equal(s.offAt, '10:00');
  assert.equal(s.lastOnDate, '');
  assert.equal(s.lastOffDate, '');
});

test('enabling the schedule persists and does not touch auto-apply itself', () => {
  db.patchSettings({ autoApply: { enabled: false } });
  db.patchSettings({ autoApply: { schedule: { enabled: true, onAt: '04:00', offAt: '10:00' } } });
  const aa = db.getSettings().autoApply;
  assert.equal(aa.schedule.enabled, true);
  assert.equal(aa.enabled, false, 'turning the SCHEDULE on must not turn AUTO-APPLY on');
});

test('a partial patch merges — it must not wipe sibling settings', () => {
  const before = db.getSettings().autoApply;
  db.patchSettings({ autoApply: { schedule: { lastOnDate: '2026-08-09' } } });
  const after = db.getSettings().autoApply;
  assert.equal(after.schedule.lastOnDate, '2026-08-09', 'the ledger was written');
  assert.equal(after.schedule.onAt, '04:00', 'onAt survived a patch that did not mention it');
  assert.equal(after.schedule.offAt, '10:00', 'offAt survived too');
  assert.equal(after.schedule.enabled, true, 'and the schedule stayed enabled');
  assert.equal(after.concurrency, before.concurrency, 'unrelated autoApply settings untouched');
});

test('the ledger survives a close/reopen (it is the once-per-day guarantee)', () => {
  db.patchSettings({ autoApply: { schedule: { lastOnDate: '2026-08-09', lastOffDate: '2026-08-09' } } });
  db.close?.();
  db.open(dir);
  const s = db.getSettings().autoApply.schedule;
  assert.equal(s.lastOnDate, '2026-08-09', 'a restart must not re-fire today\'s boundary');
  assert.equal(s.lastOffDate, '2026-08-09');
});

test('the schedule writing the ledger leaves auto-apply exactly as it was', () => {
  // This is the tick's "already in the wanted state" path: stamp the ledger, change nothing else.
  db.patchSettings({ autoApply: { enabled: true } });
  const sched = db.getSettings().autoApply.schedule;
  db.patchSettings({ autoApply: { schedule: { ...sched, lastOnDate: '2026-08-11' } } });
  const aa = db.getSettings().autoApply;
  assert.equal(aa.enabled, true, 'stamping the ledger must never flip the engine');
  assert.equal(aa.schedule.lastOnDate, '2026-08-11');
});

test('turning the schedule off leaves the times intact for later', () => {
  db.patchSettings({ autoApply: { schedule: { enabled: false } } });
  const s = db.getSettings().autoApply.schedule;
  assert.equal(s.enabled, false);
  assert.equal(s.onAt, '04:00', 'his window is remembered so re-enabling is one click');
  assert.equal(s.offAt, '10:00');
});
