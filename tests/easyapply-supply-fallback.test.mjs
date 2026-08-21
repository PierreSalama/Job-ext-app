// Easy-Apply must be PRIORITISED, but must not become a dead end.
//
// easyApplyCooledDown() already relaxed easyApplyOnly when LinkedIn's daily CAP was spent. It did not
// cover the far more common production case: the cap is untouched, but the queue holds no one-click
// work, so every dispatch fast-skips ("no Easy Apply on this posting" / "external posting") and the
// node produces nothing while looking busy. Measured 2026-08-20 on Pierre's PC: linkedin 6 applied vs
// 13 skipped; the Indeed batch was 0 applied vs 8 skipped, every one external.
//
// Rule: when one-click supply is exhausted, fall back to driving external postings — a slower rate
// beats zero — and return to Easy-Apply-first the moment one-click work exists again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const db = fs.readFileSync(path.join(here, '..', 'app', 'src', 'db.js'), 'utf8');
const server = fs.readFileSync(path.join(here, '..', 'app', 'src', 'server.js'), 'utf8');
const fn = db.slice(db.indexOf('function easyApplySupplyExhausted'), db.indexOf('function easyApplyStatus'));

test('the detector exists and is exported', () => {
  assert.ok(fn.length > 0, 'easyApplySupplyExhausted must exist');
  assert.match(db, /easyApplyCooledDown, easyApplySupplyExhausted,/, 'must be exported for server.js');
});

test('ANY recent application means supply is NOT exhausted', () => {
  // This is what makes it self-correcting with no timer and no stored state: one easy-apply landing
  // flips it back off, re-prioritising easy-apply automatically.
  assert.match(fn, /const applied = rows\.filter/, 'must count recent applications');
  assert.match(fn, /if \(applied > 0\) return false;/, 'a single application must cancel exhaustion');
});

test('it refuses to judge on a thin sample', () => {
  // Relaxing on one or two skips would drop the easy-apply priority the moment a run started badly.
  assert.match(fn, /if \(rows\.length < minSkips\) return false;/, 'must require enough history');
  assert.match(fn, /window = 25, minSkips = 10/, 'defaults must require a substantial run of skips');
});

test('it judges by OUTCOMES, not by the capability flag', () => {
  // JobSpy jobs are all applyCapability:'unknown', so counting flagged jobs would report an
  // exhaustion that is not real. The skip REASONS are the only trustworthy signal.
  assert.match(fn, /no easy apply\|external posting/i, 'must match the executor-written skip reasons');
  assert.doesNotMatch(fn, /apply_capability|applyCapability/, 'must not rely on the unknown capability flag');
});

test('BOTH the ingest and executor paths relax together', () => {
  // If only ingest relaxed, external jobs would be queued and then fast-skipped by the executor -
  // still zero applications. If only the executor relaxed, nothing external would be queued to drive.
  const sites = server.match(/easyApplyOnly[^\n]*db\.easyApplyCooledDown\(\)[^\n]*/g) || [];
  assert.equal(sites.length, 2, 'there must be exactly the two known relax sites');
  for (const site of sites) {
    assert.match(site, /!db\.easyApplySupplyExhausted\(\)/, `both sites must honour supply exhaustion: ${site.trim()}`);
  }
});

test('easy-apply still takes priority while it is available', () => {
  // The fallback must be an AND on top of the existing conditions, never a replacement - otherwise
  // easyApplyOnly would stop meaning anything and we would be back to driving slow external sites.
  assert.match(server, /s\.easyApplyOnly !== false && !db\.easyApplyCooledDown\(\) && !db\.easyApplySupplyExhausted\(\)/,
    'the user setting must still gate everything');
});
