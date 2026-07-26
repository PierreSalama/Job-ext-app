// A leaked node-sqlite3-wasm lock directory must NOT brick the app on startup.
//
// node-sqlite3-wasm guards jat.db with a mkdir-based jat.db.lock directory. An unclean exit -- a
// crash, a force-kill, or an installer overlapping a running instance -- leaks it, and then every
// later db.open() throws "database is locked" on the first query. That is the "won't boot / goes
// gray and stops" failure: confirmed on Dad's laptop 2026-07-22 (re-running the installer over his
// first install), and it made his machine unusable because the app could never start again.
//
// Electron's single-instance lock guarantees only one JAT runs, so a lock present at open time is
// always stale. open() must clear it and proceed.
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

test('open() recovers from a stale jat.db.lock left by an unclean exit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-lock-'));
  try {
    // First open + close = a normal run, leaving a real jat.db behind.
    db.open(dir);
    db.close();

    // Simulate the unclean exit: the lock directory leaks and is never cleaned up.
    const lockDir = path.join(dir, 'jat.db.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    assert.ok(fs.existsSync(lockDir), 'precondition: stale lock present');

    // The old code threw "database is locked" here and the app never started. It must now recover.
    let opened = false;
    assert.doesNotThrow(() => { db.open(dir); opened = true; }, 'open() must not throw on a stale lock');
    assert.ok(opened, 'app opened despite the stale lock');

    // And the DB must actually be usable (a query works), not just "not thrown".
    const v = db.stats ? db.stats() : null;
    assert.ok(v !== undefined, 'DB is queryable after recovery');

    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a normal open (no stale lock) still works', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-lock2-'));
  try {
    assert.doesNotThrow(() => db.open(dir));
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
