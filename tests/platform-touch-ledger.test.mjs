// The touch ledger, against a real SQLite file: rows are written, a non-attempt charge is
// reclassified in place, and the governor's counts move accordingly. This is the backend half of
// the refund — the classifier tests prove WHICH sessions qualify, these prove the ledger obeys.
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
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-touch-')); db.open(dir); });
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('the ref column exists — the migration ran', () => {
  const t = db.recordPlatformTouch('linkedin', 'apply', new Date(), 'task_mig');
  assert.equal(t.ref, 'task_mig');
});

test('an apply touch counts against the apply budget', () => {
  const before = db.platformTouchCounts('indeed').apply.day;
  db.recordPlatformTouch('indeed', 'apply', new Date(), 'task_a');
  assert.equal(db.platformTouchCounts('indeed').apply.day, before + 1);
});

test('downgrading moves the charge out of apply and into visit — same row, not a delete', () => {
  db.recordPlatformTouch('indeed', 'apply', new Date(), 'task_b');
  const before = db.platformTouchCounts('indeed');
  const n = db.downgradePlatformTouch('task_b');
  const after = db.platformTouchCounts('indeed');
  assert.equal(n, 1, 'one row reclassified');
  assert.equal(after.apply.day, before.apply.day - 1, 'apply budget given back');
  assert.equal(after.visit.day, before.visit.day + 1, 'row survives as a visit');
});

test('a visit counts against NEITHER budget — not apply, and not search either', () => {
  const before = db.platformTouchCounts('glassdoor');
  db.recordPlatformTouch('glassdoor', 'visit', new Date(), 'task_v');
  const after = db.platformTouchCounts('glassdoor');
  assert.equal(after.apply.day, before.apply.day);
  assert.equal(after.search.day, before.search.day, 'a visit must not leak into the search budget');
  assert.equal(after.visit.day, before.visit.day + 1);
});

test('downgrade is idempotent and scoped — it cannot touch another task\u2019s charge', () => {
  db.recordPlatformTouch('linkedin', 'apply', new Date(), 'task_keep');
  db.recordPlatformTouch('linkedin', 'apply', new Date(), 'task_drop');
  const before = db.platformTouchCounts('linkedin').apply.day;
  assert.equal(db.downgradePlatformTouch('task_drop'), 1);
  assert.equal(db.downgradePlatformTouch('task_drop'), 0, 'second call is a no-op');
  assert.equal(db.platformTouchCounts('linkedin').apply.day, before - 1, 'only the one charge moved');
  assert.equal(db.downgradePlatformTouch(''), 0);
  assert.equal(db.downgradePlatformTouch(null), 0);
});

test('a refunded page view still SPACES the next touch — it was still traffic', () => {
  // This is the asymmetry that keeps the refund safe. Give back the budget, keep the clock.
  const t = new Date();
  db.recordPlatformTouch('zip_recruiter', 'apply', t, 'task_space');
  db.downgradePlatformTouch('task_space');
  assert.equal(db.platformTouchCounts('zip_recruiter').apply.day, 0, 'budget was given back');
  assert.equal(db.lastPlatformTouchAt('zip_recruiter', 'apply'), t.getTime(), 'but the gap clock still sees it');
});

test('an unknown kind fails safe into search rather than vanishing', () => {
  const before = db.platformTouchCounts('google').search.day;
  db.recordPlatformTouch('google', 'nonsense', new Date(), 'task_x');
  assert.equal(db.platformTouchCounts('google').search.day, before + 1);
});

test('hourly and daily windows are counted separately', () => {
  const old = new Date(Date.now() - 3 * 3600 * 1000);
  db.recordPlatformTouch('linkedin', 'search', old, 'task_old');
  db.recordPlatformTouch('linkedin', 'search', new Date(), 'task_new');
  const c = db.platformTouchCounts('linkedin');
  assert.ok(c.search.day >= 2);
  assert.ok(c.search.hour >= 1 && c.search.hour < c.search.day);
});

test('searches are never affected by an apply downgrade', () => {
  db.recordPlatformTouch('indeed', 'search', new Date(), 'task_s');
  const before = db.platformTouchCounts('indeed').search.day;
  db.downgradePlatformTouch('task_s');
  assert.equal(db.platformTouchCounts('indeed').search.day, before, 'only apply rows are downgradable');
});
