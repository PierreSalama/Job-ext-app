// Storage must stay BOUNDED over a long life. Two measured leaks on Pierre's live install:
//   1. teach screenshots: deleted only by reference count, but NOTHING ever sets
//      demonstrations.screenshot_id / recipe_steps.screenshot_id -> 1,992 files / 43MB,
//      100% orphaned, growing ~57/day with no collector that could ever fire.
//   2. backups: rotation matched ONLY /^jat-\d{4}-\d{2}-\d{2}\.db$/, so jat-manual-*.db and
//      the per-migration jat-pre-vN.db files were never pruned (14 files / 82MB and one more
//      every migration). And 14 daily FULL copies of a 38MB DB = 675MB.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));
const { DEFAULTS } = require(path.join(here, '..', 'app', 'src', 'config.js'));

function freshDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-storage-'));
  return d;
}

test('defaults: backups carry a total byte budget and screenshots have a retention window', () => {
  assert.ok(DEFAULTS.backups.maxTotalMb >= 50, 'a backups byte budget must exist');
  assert.ok(DEFAULTS.backups.keep <= 14, 'daily keep should be modest — each is a FULL DB copy');
  assert.ok(DEFAULTS.maintenance.screenshotRetentionDays > 0, 'orphan screenshots need a retention window');
});

test('orphaned teach screenshots are swept (row + PNG); REFERENCED ones are never touched', () => {
  const dir = freshDir();
  db.open(dir);
  try {
    const shotDir = path.join(dir, 'teach-shots');
    fs.mkdirSync(shotDir, { recursive: true });
    const mkPng = (name) => { const p = path.join(shotDir, name + '.png'); fs.writeFileSync(p, 'PNGDATA'); return p; };

    // Real API — exactly how the recorder stores them.
    const orphanPath = mkPng('orphan');
    const orphanId = db.recordTeachScreenshot({ path: orphanPath, w: 10, h: 10, bytes: 7 });
    const keptPath = mkPng('referenced');
    const keptId = db.recordTeachScreenshot({ path: keptPath, w: 10, h: 10, bytes: 7 });
    // ...and one that IS referenced by a demonstration (the linkage that never happens in prod).
    db.recordDemonstration({ label: 'First name', action: 'fill', value: 'Pierre', screenshotId: keptId });

    // Grace window: a cutoff in the PAST must sweep nothing (both were just created).
    const sweptEarly = db.pruneOrphanScreenshots(new Date(Date.now() - 86400e3).toISOString());
    assert.equal(sweptEarly, 0, 'recent screenshots must be inside the grace window');
    assert.equal(fs.existsSync(orphanPath), true);

    // Cutoff in the FUTURE = "everything is now old enough".
    const swept = db.pruneOrphanScreenshots(new Date(Date.now() + 60_000).toISOString());
    assert.equal(swept, 1, `exactly the orphan should be swept, got ${swept}`);
    assert.equal(fs.existsSync(orphanPath), false, 'orphaned PNG must be deleted from disk');
    assert.equal(fs.existsSync(keptPath), true, 'a REFERENCED screenshot must never be swept');
    assert.equal(db.getTeachScreenshotPath(orphanId), null, 'orphan row must be gone');
    assert.equal(db.getTeachScreenshotPath(keptId), keptPath, 'referenced row must survive');
  } finally { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
});

test('dailyBackup() enforces a total size budget across EVERY backup file, not just date-named', () => {
  const dir = freshDir();
  db.open(dir);
  try {
    const bdir = path.join(dir, 'backups');
    fs.mkdirSync(bdir, { recursive: true });
    // Seed 66MB across names the OLD rotation could never match (manual + per-migration),
    // all backdated so they are the first to be evicted. 6 x 11MB > the 50MB floor budget.
    const big = Buffer.alloc(11 * 1024 * 1024, 7);
    const unseen = ['jat-manual-2026-01-01T00-00-00.db', 'jat-pre-v2.db', 'jat-pre-v3.db',
                    'jat-pre-v4.db', 'jat-pre-v5.db', 'jat-pre-v6.db'];
    unseen.forEach((f, i) => {
      const p = path.join(bdir, f);
      fs.writeFileSync(p, big);
      const t = new Date(Date.now() - (100 - i) * 86400e3);
      fs.utimesSync(p, t, t);
    });
    // (open() runs migrations, which themselves write jat-pre-vN.db backups here — so assert
    //  our seeds are present rather than an exact folder count.)
    const seeded = fs.readdirSync(bdir).filter((f) => unseen.includes(f));
    assert.equal(seeded.length, 6, 'seeded 6 non-date-named backups');
    const bytesBefore = fs.readdirSync(bdir).filter((f) => f.endsWith('.db'))
      .reduce((n, f) => n + fs.statSync(path.join(bdir, f)).size, 0);
    assert.ok(bytesBefore > 50 * 1024 * 1024, 'seed must exceed the budget for the test to mean anything');

    db.patchSettings({ backups: { keep: 1, maxTotalMb: 50 } });
    db.dailyBackup();

    const after = fs.readdirSync(bdir).filter((f) => f.endsWith('.db'));
    const bytes = after.reduce((n, f) => n + fs.statSync(path.join(bdir, f)).size, 0);
    assert.ok(bytes <= 50 * 1024 * 1024, `backups folder must respect the byte budget, got ${(bytes / 1048576).toFixed(1)}MB`);
    const survivingSeeds = after.filter((f) => unseen.includes(f)).length;
    assert.ok(survivingSeeds < 6, `old non-date-named backups must be evicted — the OLD rotation ignored them entirely (still ${survivingSeeds}/6)`);
    // today's backup survives
    const today = `jat-${new Date().toISOString().slice(0, 10)}.db`;
    assert.ok(after.includes(today), "today's backup must never be deleted");
  } finally { try { db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); }
});
