// The freshness ramp only works if the per-combo tier SURVIVES service-worker eviction.
//
// background.js runs as an MV3 service worker: Chrome evicts it after ~30s idle, and discovery
// ticks are minutes apart (discovery.intervalMinutes, default 5). So any ramp state held in a
// plain module-level Map is guaranteed to be gone by the next tick — every combo restarts at
// NARROWEST_TIER (1h) forever, and the whole ladder above 1h becomes unreachable dead code.
//
// That was live on 2026-07-20. The f_AL LinkedIn search reported:
//   freshness 3600 -> next 7200, found 15, enqueued 0
//   "all 15 jobs here were already tried — rotating to the next search"
// i.e. it computed the widened tier correctly and then dropped it, which is precisely the
// SATURATED state the doctor reports. The 30-day depth added specifically to escape saturation
// could never be reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NARROWEST_TIER, WIDEST_TIER, nextFreshnessTier } from '../extension/lib/freshness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bg = fs.readFileSync(path.join(here, '..', 'extension', 'background.js'), 'utf8');

test('the ramp cannot escape the narrowest tier without persistence', () => {
  // A saturated niche: every scan finds jobs but ingests 0 new. With state that survives, the
  // combo climbs the ladder. This is the behaviour the fix is meant to unlock.
  let tier = NARROWEST_TIER;
  for (let i = 0; i < 8; i++) tier = nextFreshnessTier(tier, false);
  assert.equal(tier, WIDEST_TIER, 'a persistently dry combo must reach the widest (30d) tier');

  // Simulating eviction between every tick — the pre-fix behaviour — the tier never advances,
  // no matter how many ticks run.
  let evicted = NARROWEST_TIER;
  for (let i = 0; i < 8; i++) { nextFreshnessTier(evicted, false); evicted = NARROWEST_TIER; }
  assert.equal(evicted, NARROWEST_TIER, 'without persistence the ramp is pinned at 1h forever');
});

test('discoverTick reads and writes the tier through chrome.storage, not a bare Map', () => {
  assert.doesNotMatch(bg, /const DISCOVER_TIERS = new Map\(\)/,
    'regression: a module-level Map does not survive MV3 service-worker eviction');
  assert.match(bg, /DISCOVER_TIERS_KEY\s*=\s*'jat11\.discoverTiers'/, 'tiers need a storage key');
  assert.match(bg, /const tierSeconds = await loadDiscoverTier\(cKey\)/,
    'the tick must READ the persisted tier');
  assert.match(bg, /await saveDiscoverTier\(cKey, nextTier\)/,
    'the tick must WRITE the advanced tier back');
});

test('a storage failure degrades to the freshest window, never to a bogus tier', () => {
  // loadDiscoverTier must fall back to NARROWEST_TIER on any error or junk value, so a corrupt
  // entry restarts the combo at the freshest window rather than pinning it at a wrong one.
  const load = bg.slice(bg.indexOf('async function loadDiscoverTier'), bg.indexOf('async function saveDiscoverTier'));
  assert.match(load, /Number\.isFinite\(v\) && v > 0 \? v : NARROWEST_TIER/, 'junk values must snap to the narrowest tier');
  assert.match(load, /catch \{ return NARROWEST_TIER; \}/, 'a storage read failure must not throw out of the tick');
});
