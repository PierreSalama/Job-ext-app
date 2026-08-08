// The Easy-Apply cap is per ACCOUNT. The early-reset heuristic reads a PER-NODE count.
//
// easyApplyCooledDown() ends the cooldown early once this node's rolling-24h count drops a margin
// below the observed limit — correct when one node owns the account, wrong the moment there are two.
// Each node sees only its own applies, so neither ever reaches `observed - margin`, the early reset
// fires permanently, and both keep dispatching into a cap LinkedIn is actively enforcing.
//
// Live 2026-08-08: laptop submitted24h=19, PC=16, observedLimit=40 (margin 4). Both evaluated
// 19 < 36 and 16 < 36 → cooledDown=false, while LinkedIn refused every attempt with
// "easyapply-limit — daily Easy Apply cap reached". Combined they had spent ~35 of ~40. The result
// was an unbounded loop of refused requests on an account already warned for automated access.
//
// Fix: an explicit refusal from LinkedIn is ground truth about the ACCOUNT and outranks the local
// guess for a blackout window; after that the early reset resumes so recovery is still fast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'app', 'src', 'db.js'), 'utf8');
const fn = src.slice(src.indexOf('function easyApplyCooledDown'), src.indexOf('function easyApplyStatus'));

test('an explicit LinkedIn refusal is recorded with a timestamp, not just an expiry', () => {
  const setter = src.slice(src.indexOf('function setEasyApplyCooldown'), src.indexOf('function easyApplyCooledDown'));
  assert.match(setter, /easyApplyLimitSeenAt/,
    'setEasyApplyCooldown must record WHEN LinkedIn actually refused, not only when the timer ends');
});

test('the blackout is checked BEFORE the early-reset heuristic', () => {
  const iSeen = fn.indexOf('easyApplyLimitSeenAt');
  const iEarly = fn.indexOf('easyApplyObservedLimit');
  assert.ok(iSeen > -1, 'cooledDown must consult the last-refusal time');
  assert.ok(iEarly > -1, 'the early-reset heuristic is still present');
  assert.ok(iSeen < iEarly,
    'the blackout must short-circuit first — otherwise the per-node count still wins');
  assert.match(fn, /EARLY_RESET_BLACKOUT_MS/, 'the window must be a named constant');
  assert.match(fn, /return true;/, 'inside the blackout the node must report COOLED DOWN');
});

// The decision logic itself, so intent is pinned independently of the source text.
function cooled({ until, seenAt, observed, mine, now }) {
  if (!until) return false;
  if (now >= until) return false;
  const BLACKOUT = 60 * 60 * 1000;
  if (seenAt && (now - seenAt) < BLACKOUT) return true;
  if (observed > 0) {
    const margin = Math.max(2, Math.round(observed * 0.1));
    if (mine < observed - margin) return false;
  }
  return true;
}

test('the live two-node case: both nodes stay cooled down', () => {
  const now = 1_000_000_000;
  const until = now + 20 * 3600_000;
  const seenAt = now - 5 * 60000;          // LinkedIn refused 5 minutes ago

  assert.equal(cooled({ until, seenAt, observed: 40, mine: 19, now }), true, 'laptop (19) must hold');
  assert.equal(cooled({ until, seenAt, observed: 40, mine: 16, now }), true, 'PC (16) must hold');
});

test('without the blackout, the old logic released BOTH nodes — the regression this guards', () => {
  const now = 1_000_000_000;
  const until = now + 20 * 3600_000;
  assert.equal(cooled({ until, seenAt: 0, observed: 40, mine: 19, now }), false,
    'no refusal recorded → per-node count wins → this is exactly the bug');
});

test('early reset still works once the blackout passes (fast recovery preserved)', () => {
  const now = 1_000_000_000;
  const until = now + 20 * 3600_000;
  const seenAt = now - 90 * 60000;         // refusal was 90 minutes ago

  assert.equal(cooled({ until, seenAt, observed: 40, mine: 10, now }), false,
    'well under the limit and past the blackout → resume Easy-Apply');
  assert.equal(cooled({ until, seenAt, observed: 40, mine: 38, now }), true,
    'still at the limit → stay cooled');
});

test('the fixed 24h expiry remains the outer safety net', () => {
  const now = 1_000_000_000;
  assert.equal(cooled({ until: now - 1, seenAt: now - 60_000, observed: 40, mine: 40, now }), false,
    'once the 24h timer expires the cooldown ends regardless of the blackout');
});
