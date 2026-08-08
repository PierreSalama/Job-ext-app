// A wedged Gmail sync must not disable Gmail forever.
//
// `syncing` is an in-memory flag set before the fetch loop and cleared in a finally. A finally only
// runs if the promise SETTLES — and the Gmail calls carry no timeout, so a request that never
// resolves leaves the flag true for the life of the process. Every later sync then returns
// "sync already running" and no employer mail is ingested at all.
//
// Live 2026-08-06: a sync started at 04:30 and never completed. Gmail went 47 HOURS with zero
// successful runs. Nothing surfaced it — the flag is in-memory, and the health record only advances
// when a run finishes, so `lastResult` just kept showing the last good sync. This is the same shape
// as the earlier silent-death bug where gmailLastResult only advanced on success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'app', 'src', 'gmail.js'), 'utf8');

test('the busy guard is bounded by how long the current sync has been running', () => {
  assert.match(src, /syncStartedAt/, 'must record when the current sync started');
  assert.match(src, /SYNC_STALE_MS/, 'must define a staleness bound');
  assert.doesNotMatch(src, /if \(syncing\) return \{ ok: false, error: 'sync already running' \};/,
    'regression: an UNBOUNDED busy guard wedges Gmail permanently');
  const guard = src.slice(src.indexOf('async function syncNow'), src.indexOf('const token = await accessToken'));
  assert.match(guard, /syncing && \(Date\.now\(\) - syncStartedAt\) < SYNC_STALE_MS/,
    'the guard must only block while the running sync is still within the staleness bound');
});

test('syncStartedAt is stamped whenever the flag is raised', () => {
  const i = src.indexOf('syncing = true;');
  assert.ok(i > -1, 'the flag is still set somewhere');
  const after = src.slice(i, i + 200);
  assert.match(after, /syncStartedAt = Date\.now\(\)/,
    'raising `syncing` without stamping the time makes the staleness check meaningless');
});

test('a wedged run is taken over, and the takeover is recorded not silent', () => {
  const guard = src.slice(src.indexOf('async function syncNow'), src.indexOf('const token = await accessToken'));
  assert.match(guard, /recordFailure\(/,
    'taking over a wedged sync must be written to health — a silent takeover hides the underlying hang');
});

// The arithmetic of the guard, so the intent is pinned independently of the source text.
test('guard arithmetic: blocks a live sync, releases a wedged one', () => {
  const STALE = 15 * 60 * 1000;
  const blocked = (syncing, startedAt, now) => syncing && (now - startedAt) < STALE;
  const now = 1_000_000_000;

  assert.equal(blocked(true, now - 30_000, now), true, 'a sync 30s old is genuinely running — block');
  assert.equal(blocked(true, now - 14 * 60000, now), true, 'still inside the window — block');
  assert.equal(blocked(true, now - 16 * 60000, now), false, 'past the window — treat as dead, allow');
  assert.equal(blocked(true, now - 47 * 3600_000, now), false, 'the live 47h wedge must be released');
  assert.equal(blocked(false, 0, now), false, 'not syncing — never block');
});
