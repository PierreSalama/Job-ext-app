// Under easyApplyOnly, a SUCCESSFUL JobSpy batch is still mostly unusable supply.
//
// Live measurement this encodes (Pierre's PC, 2026-08-20): linkedin 6 applied vs 13 skipped
// ("no Easy Apply on this posting"), indeed 0 applied vs 8 skipped. JobSpy scrapes public search
// results, which do NOT expose the one-click-apply badge, so jobs arrive applyCapability 'unknown'
// and the executor only discovers they are external after opening them. No dispatch-side setting can
// lift that ceiling.
//
// The browser lane runs the same search in the user's logged-in session with the platform's own
// easy-apply filter, so its results are easy-apply-dense. It already existed but fired ONLY when
// JobSpy errored (FALLBACK_STATUSES) — never on the common case of JobSpy succeeding with low-value
// results. Rule: under easyApplyOnly it must also be queued after a SUCCESSFUL linkedin/indeed batch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const disc = fs.readFileSync(path.join(here, '..', 'app', 'src', 'discovery', 'index.js'), 'utf8');
const server = fs.readFileSync(path.join(here, '..', 'app', 'src', 'server.js'), 'utf8');

// The success path is the try-block; the error path is the catch. Split on the catch so we can
// assert WHICH branch the new queueing lives in — putting it in the catch would be a no-op change.
// Anchor inside searchBoard: '} catch (e) {' also appears in earlier helpers, and slicing on the
// first occurrence silently produced a window that contained neither branch.
const sbStart = disc.indexOf('async function searchBoard(');
const sbEnd   = disc.indexOf('async function runTick(');
const searchBoard = disc.slice(sbStart, sbEnd);
const sbCatch = searchBoard.indexOf('} catch (e) {');
const successBranch = searchBoard.slice(searchBoard.indexOf('const done = db.discoveryBatchComplete'), sbCatch);

test('a successful jobspy batch queues the browser lane too', () => {
  assert.match(successBranch, /discoveryFallbackQueue\(/,
    'the SUCCESS branch must queue a browser search, not just the error branch');
});

test('it is gated on easyApplyOnly', () => {
  assert.match(successBranch, /easyApplyOnly === true/,
    'must require an EXPLICIT opt-in — an unset flag must not add traffic to a restricted account');
  assert.match(successBranch, /status === 'ok'/,
    'an EMPTY batch must not trigger a browser search: it would spend budget to re-confirm nothing');
});

test('only for platforms whose badge jobspy cannot read', () => {
  assert.match(successBranch, /\['linkedin', 'indeed'\]\.includes\(source\)/,
    'ATS sources already report capability accurately and must not get a redundant browser search');
});

test('the error-path fallback still exists (not replaced)', () => {
  const catchBranch = searchBoard.slice(sbCatch);
  assert.match(catchBranch.slice(0, 1200), /FALLBACK_STATUSES\.has\(status\)[\s\S]{0,120}discoveryFallbackQueue/,
    'the original blocked/rate-limited fallback must remain');
});

test('every browser search still goes through the platform budget', () => {
  // This lane opens a REAL search in the user's logged-in session, so it is exactly the traffic the
  // 2026-08-10 restriction was about. Making it proactive must NOT create an ungoverned lane.
  const ep = server.slice(server.indexOf("pathname === '/auto-apply/discovery-fallback/next'"));
  const head = ep.slice(0, 1200);
  assert.match(head, /safety\.decideTouch\(/, 'the fallback endpoint must consult the governor');
  assert.match(head, /kind: 'search'/, 'it must be counted as a search touch');
  assert.match(head, /if \(!gate\.ok\) return/, 'a refused gate must hand out no request');
  assert.match(head, /db\.recordPlatformTouch\(/, 'an allowed request must be charged');
});

test('at most one browser search per jobspy batch', () => {
  // discoveryFallbackQueue is keyed (batch_id, source) via INSERT OR IGNORE, so repeated calls for
  // one batch cannot fan out. Without that this would multiply searches against a warned account.
  const db = fs.readFileSync(path.join(here, '..', 'app', 'src', 'db.js'), 'utf8');
  const fn = db.slice(db.indexOf('function discoveryFallbackQueue'));
  assert.match(fn.slice(0, 700), /INSERT OR IGNORE INTO discovery_fallbacks/,
    'queueing must be idempotent per (batch, source)');
});
