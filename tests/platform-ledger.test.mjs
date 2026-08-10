// The platform touch ledger against a real DB — the counter that had to exist before any budget
// could mean anything. Searches and applies land in ONE table so a single question ("how much have
// we touched LinkedIn today?") has a single answer.
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
const safety = require(path.join(here, '..', 'app', 'src', 'safety.js'));

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-ledger-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

const ago = (ms) => new Date(Date.now() - ms);

test('a fresh ledger reads as zero, not as undefined', () => {
  const c = db.platformTouchCounts('linkedin');
  assert.deepEqual(c, { search: { day: 0, hour: 0 }, apply: { day: 0, hour: 0 } },
    'the governor multiplies these — a missing kind must be 0, never undefined');
});

test('touches are counted per platform and per kind', () => {
  for (let i = 0; i < 5; i++) db.recordPlatformTouch('linkedin', 'search');
  for (let i = 0; i < 3; i++) db.recordPlatformTouch('linkedin', 'apply');
  db.recordPlatformTouch('indeed', 'search');
  const li = db.platformTouchCounts('linkedin');
  assert.equal(li.search.day, 5);
  assert.equal(li.apply.day, 3);
  assert.equal(db.platformTouchCounts('indeed').search.day, 1, 'platforms never bleed into each other');
});

test('the rolling windows are rolling — old touches age out of the hour but not the day', () => {
  db.recordPlatformTouch('rolltest', 'search', ago(90 * 60 * 1000));   // 90 min ago
  db.recordPlatformTouch('rolltest', 'search', ago(5 * 60 * 1000));    // 5 min ago
  db.recordPlatformTouch('rolltest', 'search', ago(30 * 3600 * 1000)); // 30h ago — outside both
  const c = db.platformTouchCounts('rolltest');
  assert.equal(c.search.day, 2, '30h-old touch is outside the 24h window');
  assert.equal(c.search.hour, 1, 'only the 5-minute-old one is inside the hour');
});

test('the last-touch clock is per kind, so the apply gap is not reset by a search', () => {
  db.recordPlatformTouch('gaptest', 'apply', ago(60 * 60 * 1000));
  db.recordPlatformTouch('gaptest', 'search', ago(1000));
  const lastApply = db.lastPlatformTouchAt('gaptest', 'apply');
  assert.ok(Date.now() - lastApply > 55 * 60 * 1000,
    'a search must not make the applier think it just applied');
  assert.ok(Date.now() - db.lastPlatformTouchAt('gaptest', 'search') < 10 * 1000);
});

test('a platform never touched has a last-touch of 0, which the governor reads as "no gap yet"', () => {
  assert.equal(db.lastPlatformTouchAt('never-seen', 'apply'), 0);
  const d = safety.decideTouch({
    safety: { enabled: true, platforms: { 'never-seen': { role: 'primary', minApplyGapMinutes: 60, quietStart: '00:00', quietEnd: '00:00' } } },
    platform: 'never-seen', kind: 'apply',
    counts: db.platformTouchCounts('never-seen'),
    lastTouchAt: db.lastPlatformTouchAt('never-seen', 'apply'),
  });
  assert.equal(d.ok, true, 'the first touch of the day is never gated on a gap that has no start');
});

test('kind is normalised, so a typo cannot mint an uncounted third bucket', () => {
  db.recordPlatformTouch('normtest', 'APPLY');
  db.recordPlatformTouch('normtest', 'anything-else');
  const c = db.platformTouchCounts('NORMTEST');
  assert.equal(c.apply.day, 1);
  assert.equal(c.search.day, 1, 'unknown kinds fall back to search — counted, never dropped');
});

test('pruning keeps the recent window the governor actually reads', () => {
  db.recordPlatformTouch('prunetest', 'search', ago(20 * 86400000));
  db.recordPlatformTouch('prunetest', 'search', ago(2 * 3600 * 1000));
  const removed = db.prunePlatformTouches(7);
  assert.ok(removed >= 1, 'the 20-day-old row went');
  assert.equal(db.platformTouchCounts('prunetest').search.day, 1, 'today is untouched');
});

test('end to end: the ledger drives the governor to a refusal at the budget line', () => {
  const s = {
    enabled: true,
    platforms: { e2e: { role: 'primary', searchesPerDay: 4, searchesPerHour: 99, minSearchGapMinutes: 0, quietStart: '00:00', quietEnd: '00:00' } },
  };
  const ask = () => safety.decideTouch({
    safety: s, platform: 'e2e', kind: 'search',
    counts: db.platformTouchCounts('e2e'),
    lastTouchAt: db.lastPlatformTouchAt('e2e', 'search'),
  });
  let allowed = 0;
  for (let i = 0; i < 10; i++) {
    if (!ask().ok) break;
    db.recordPlatformTouch('e2e', 'search');
    allowed++;
  }
  assert.equal(allowed, 4, 'exactly the budget got through — not 5, not 281');
  assert.equal(ask().reason, 'daily-budget');
});
