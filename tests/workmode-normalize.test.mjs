// Work-mode/location split + country clamp. A location is ALWAYS a geography; work-mode
// words ('remote'/'hybrid'/'onsite'/'wfh'/…) are folded out of `locations` into
// `workModes`; an empty `locations` defaults to [country] so a search is never borderless.
// The repair runs on every getSettings() read (auto-heals a bad stored config — e.g. the
// dad's "remote" location) and is idempotent. Pure normalizer + the live read path.
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
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-wm-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('"remote" typed as a location is folded into workModes; locations defaults to the country', () => {
  const out = db.normalizeAutoApply({ locations: ['Remote'], workModes: [], country: 'Canada' });
  assert.deepEqual(out.workModes, ['remote']);
  assert.deepEqual(out.locations, ['Canada'], 'no real geography left → clamp to country');
});

test('all work-mode synonyms are recognized (case-insensitive)', () => {
  const out = db.normalizeAutoApply({ locations: ['WFH', 'Work From Home', 'On-Site', 'Hybrid', 'anywhere'], country: 'Canada' });
  assert.deepEqual(out.workModes, ['remote', 'hybrid', 'onsite'], 'deduped + ordered');
  assert.deepEqual(out.locations, ['Canada']);
});

test('a real geography is KEPT; only the work-mode word is stripped out', () => {
  const out = db.normalizeAutoApply({ locations: ['Toronto, ON', 'remote', 'Vancouver'], country: 'Canada' });
  assert.deepEqual(out.locations, ['Toronto, ON', 'Vancouver']);
  assert.deepEqual(out.workModes, ['remote']);
});

test('existing workModes are preserved and merged with folded-out location words', () => {
  const out = db.normalizeAutoApply({ locations: ['hybrid'], workModes: ['remote'], country: 'Canada' });
  assert.deepEqual(out.workModes, ['remote', 'hybrid']);
});

test('idempotent — running twice changes nothing the second time', () => {
  const once = db.normalizeAutoApply({ locations: ['remote', 'Toronto'], country: 'Canada' });
  const twice = db.normalizeAutoApply(once);
  assert.deepEqual(twice, once);
});

test('missing country defaults to Canada; locations never end up empty', () => {
  const out = db.normalizeAutoApply({ locations: [] });
  assert.equal(out.country, 'Canada');
  assert.deepEqual(out.locations, ['Canada']);
  assert.deepEqual(out.workModes, []);
});

test('a clean geo-only config is returned unchanged (no spurious work-mode)', () => {
  const out = db.normalizeAutoApply({ locations: ['Montreal, QC'], workModes: ['onsite'], country: 'Canada' });
  assert.deepEqual(out.locations, ['Montreal, QC']);
  assert.deepEqual(out.workModes, ['onsite']);
});

test('the LIVE read path auto-repairs a bad stored config (dad\'s "remote" location)', () => {
  // Persist the bad config the dad would have saved, then read it back through getSettings().
  db.patchSettings({ autoApply: { locations: ['remote'], country: 'Canada' } });
  const aa = db.getSettings().autoApply;
  assert.deepEqual(aa.workModes, ['remote'], 'getSettings folded the bad location into workModes');
  assert.deepEqual(aa.locations, ['Canada'], 'getSettings clamped the empty geography to the country');
});
