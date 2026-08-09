// A host that keeps walling us must be probed exponentially less often.
//
// The breaker counted `hits` from the start but never used it: every trip got the SAME fixed
// cooldown. Worse, the caller DELETED the entry the moment its cooldown lapsed, so `prev` was always
// undefined and `hits` was always 1 — the counter could not have driven a backoff even if the
// arithmetic had existed.
//
// Live 2026-08-09, one Indeed task: scheduled → wall → deferred, EIGHT times in three hours, with
// attempts=0 — never actually attempted. Each cycle costs a dispatch, a page load and a worker slot,
// and it means repeatedly hitting a host that is actively blocking us, on an account already warned
// for automated access.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  backoffMs, trippedEntry, shouldForget, shouldDispatchHost,
  HOST_BREAKER_COOLDOWN_MS, HOST_BREAKER_MAX_COOLDOWN_MS, HOST_BREAKER_FORGET_MS,
} from '../extension/lib/host-breaker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bg = fs.readFileSync(path.join(here, '..', 'extension', 'background.js'), 'utf8');
const MIN = 60000;

test('the cooldown doubles with each consecutive wall', () => {
  assert.equal(backoffMs(1), 20 * MIN, 'first wall = base');
  assert.equal(backoffMs(2), 40 * MIN);
  assert.equal(backoffMs(3), 80 * MIN);
  assert.equal(backoffMs(4), 160 * MIN);
});

test('the backoff is capped so a wall that lifts is still noticed the same day', () => {
  assert.equal(backoffMs(50), HOST_BREAKER_MAX_COOLDOWN_MS);
  assert.ok(HOST_BREAKER_MAX_COOLDOWN_MS <= 6 * 60 * MIN, 'cap must not exceed 6h');
});

test('the live case: 8 walls in 3 hours becomes 4', () => {
  const WINDOW = 3 * 60 * MIN;
  // Old behaviour: a fixed 20-minute cooldown → a probe every 20 min.
  const fixedProbes = Math.floor(WINDOW / HOST_BREAKER_COOLDOWN_MS);   // 9
  // New: probes land at 0, 20, 60, 140 min (each wait is the backoff for the trip just made).
  let elapsed = 0, probes = 0;
  while (elapsed < WINDOW) { probes++; elapsed += backoffMs(probes); }
  assert.equal(probes, 4, 'probes at 0/20/60/140 minutes');
  assert.ok(probes * 2 < fixedProbes, `must be less than half the old rate (${probes} vs ${fixedProbes})`);
});

test('hits accumulate across trips — the bug was that they could not', () => {
  const now = 1_000_000_000;
  const e1 = trippedEntry(null, 'cloudflare', now);
  assert.equal(e1.hits, 1);
  assert.equal(e1.until, now + backoffMs(1));

  const e2 = trippedEntry(e1, 'cloudflare', now + 30 * MIN);
  assert.equal(e2.hits, 2, 'a second wall must see the first');
  assert.equal(e2.until, now + 30 * MIN + backoffMs(2), 'and back off further');
});

test('an entry OUTLIVES its cooldown, or the counter resets and there is no backoff', () => {
  const now = 1_000_000_000;
  const e = trippedEntry(null, 'cloudflare', now);
  const justCooled = now + backoffMs(1) + 1000;
  assert.equal(shouldForget(e, justCooled), false,
    'regression: forgetting at cooldown-expiry is exactly what defeated the hit counter');
});

test('a cooled-down host still dispatches even though its entry is retained', () => {
  const now = 1_000_000_000;
  const e = trippedEntry(null, 'cloudflare', now);
  const state = { 'indeed.com': e };
  assert.equal(shouldDispatchHost('indeed.com', now + 60000, state).dispatch, false, 'inside cooldown');
  assert.equal(shouldDispatchHost('indeed.com', now + backoffMs(1) + 1, state).dispatch, true,
    'past the cooldown it must dispatch — retention must not block work');
});

test('a host that behaves is eventually forgotten, so backoff cannot ratchet forever', () => {
  const now = 1_000_000_000;
  const e = trippedEntry(null, 'cloudflare', now);
  assert.equal(shouldForget(e, now + HOST_BREAKER_FORGET_MS - 1000), false, 'not yet');
  assert.equal(shouldForget(e, now + HOST_BREAKER_FORGET_MS + 1000), true,
    'after a quiet window the next wall starts from the base cooldown again');
});

test('the background SW uses the shared forget rule, not cooldown-expiry', () => {
  const fn = bg.slice(bg.indexOf('async function loadHostBreakerPruned'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /shouldForget\(entry, now\)/, 'must use the forget rule');
  assert.doesNotMatch(body, /now >= \(Number\(entry\.until\) \|\| 0\)/,
    'regression: deleting at cooldown-expiry resets hits and kills the backoff');
});

test('the trip log reports the ACTUAL backoff, not the base constant', () => {
  assert.match(bg, /backoffMs\(map\[h\]\.hits\)/,
    'a log claiming "~20 min" while the host is paused for hours hides the behaviour');
  assert.ok(HOST_BREAKER_COOLDOWN_MS === 20 * MIN, 'base unchanged');
});
