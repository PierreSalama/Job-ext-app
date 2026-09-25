// Run every migration against a COPY of the live ledger, not a fresh one.
//
// Twice on 2026-09-05 a change passed the entire suite and then failed on Pierre's actual database:
//
//   • v23 fell back to `ORDER BY created_at` on the profiles table, which has is_default and
//     updated_at and no created_at at all. Every unit test passed because a fresh database took the
//     is_default branch and never reached the fallback. On the real ledger it threw INSIDE the
//     migration transaction, which takes the app down on launch.
//   • The same shape had already bitten in the résumé work: fixture data was small enough that a
//     truncation bug was invisible.
//
// A fresh database is systematically unlike his: smaller, newer, fewer branches taken, none of the
// rows that accumulated through twenty-odd earlier migrations. That difference is exactly where
// migration bugs live, and it is not something to remember to check by hand.
//
// This copies the live file read-only and opens the copy, which runs the migration chain end to
// end. It SKIPS when the file is absent, so it does nothing on a machine that is not his.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const LIVE = process.env.APPDATA ? path.join(process.env.APPDATA, 'jat11-app', 'jat.db') : null;
const haveLive = !!(LIVE && fs.existsSync(LIVE));

test('every migration runs clean against the live ledger', { skip: haveLive ? false : 'no live ledger on this machine' }, () => {
  const db = require(path.join(root, 'app/src/db.js'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-realmig-'));
  fs.copyFileSync(LIVE, path.join(work, 'jat.db'));
  try {
    // open() runs the whole migration chain. A throw here is an app that will not launch.
    db.open(work);
    const jobs = db.listJobs({ limit: 5000 });
    assert.ok(jobs.length > 0, 'the copy should carry his real jobs');

    // v23 specifically: every pre-existing row must have an owner, or he silently loses the
    // duplicate protection that stops him applying to the same employer twice.
    const unowned = jobs.filter((j) => !j.profileId);
    assert.equal(unowned.length, 0,
      `${unowned.length} of ${jobs.length} jobs have no owner after the backfill`);
  } finally {
    try { db.close(); } catch { /* already closed */ }
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp */ }
  }
});

test('the live ledger is only ever COPIED, never opened in place', () => {
  // Opening it directly would run migrations against the database the running app has open, and
  // node-sqlite3-wasm guards the file with a lock directory. This test is a guard on the test.
  const src = fs.readFileSync(new URL('./migrations-real-ledger.test.mjs', import.meta.url), 'utf8');
  assert.match(src, /copyFileSync\(LIVE/, 'copy first');
  const opens = src.match(/db\.open\(([^)]*)\)/g) || [];
  for (const o of opens) assert.match(o, /db\.open\(work\)/, `must open the copy, got ${o}`);
});
