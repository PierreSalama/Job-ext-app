// TWO DASHBOARD DEFECTS FOUND IN ONE PASS, AND ONE OF THEM EXPLAINS THE OTHER'S INVISIBILITY.
//
// 1. THE DASHBOARD DOWNLOADED THE ENTIRE QUEUE TO COUNT IT.
//    Measured on the real node: GET /queue returns 1,152,389 bytes -- 1,334 task rows -- and the
//    Dashboard used it for exactly one thing, counting three states to render the chip
//    "Auto-apply - N queued - M need you". The page's other nine calls come to roughly 60 KB
//    combined, so this single request was 95% of the dashboard's payload, on every load.
//
//    /auto-apply/live was NOT a valid substitute, which is the trap here: its counts are for the
//    CURRENT RUN. Measured side by side on the same node at the same moment, awaiting_review was
//    90 in the queue and 1 in the session. Swapping them would have silently changed what the
//    chip reports rather than only making it cheaper.
//
// 2. THE GMAIL CHIP SAID "SYNCED" WHEN THE SYNC HAD FAILED.
//    It read lastResult.at and printed "synced " + how long ago. `at` is stamped on EVERY
//    attempt including a failed one, so a node reporting authorized:false, stale:true and
//    "deleted_client: The OAuth client was deleted" rendered as "Gmail - synced just now", every
//    fifteen minutes, for eighteen days. That is why nobody noticed the mail sync was dead: the
//    one surface anybody looks at said it was fine every single time it failed.
//
//    Against the two REAL nodes, before and after:
//      PC      "Gmail - synced 0h ago"   ->  "Gmail - failing - last synced 18d ago"  [bad]
//      laptop  "Gmail - synced 25d ago"  ->  "Gmail - not connected"                  [bad]
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.join(here, '..', 'extension', 'app', 'app.js'), 'utf8');
const MIRROR = fs.readFileSync(path.join(here, '..', 'app', 'src', 'app', 'app.js'), 'utf8');
const DB = fs.readFileSync(path.join(here, '..', 'app', 'src', 'db.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(here, '..', 'app', 'src', 'server.js'), 'utf8');

test('the authored file and its mirror agree', () => {
  assert.equal(APP, MIRROR, 'run `node tools/mirror.mjs`');
});

// ---------------------------------------------------------------------------------------
// 1. counts, not the whole queue
// ---------------------------------------------------------------------------------------
test('the server can count the queue without reading it', () => {
  assert.match(DB, /function queueCounts\(\)/);
  assert.match(DB, /SELECT state, COUNT\(\*\) AS n FROM auto_apply_tasks GROUP BY state/,
    'it must count in SQL — counting in JS is the bug this replaces');
  assert.match(SERVER, /pathname === '\/queue\/counts'/);
});

test('/queue/counts is registered BEFORE /queue', () => {
  // Route order matters: a prefix match on '/queue' would shadow it and quietly serve 1.1 MB.
  const counts = SERVER.indexOf("pathname === '/queue/counts'");
  const list = SERVER.indexOf("pathname === '/queue'");
  assert.ok(counts > 0 && list > 0);
  assert.ok(counts < list, 'the more specific route must come first');
});

test('the Dashboard asks for counts, not for the queue', () => {
  const i = APP.indexOf("route('/', async () => {");
  const view = APP.slice(i, i + 3000);
  assert.match(view, /api\('\/queue\/counts'\)/, 'the dashboard must use the cheap endpoint');
  assert.ok(!/api\('\/queue'\)\.catch\(\(\) => \(\{ items: \[\] \}\)\)/.test(view),
    'the old whole-queue fetch must be gone from the dashboard');
});

test('it still falls back if the node is too old to have the route', () => {
  // apiTarget can point at another machine, and a 404 there must degrade to the old behaviour
  // rather than blanking the chip.
  const i = APP.indexOf("route('/', async () => {");
  const view = APP.slice(i, i + 3000);
  assert.match(view, /\.catch\(\(\) => api\('\/queue'\)/, 'a 404 must fall back to the full list');
});

test('both shapes render the same chip', () => {
  // The fallback returns {items}, the fast path returns {counts}. If the render only understood
  // one of them, the fallback would silently show nothing.
  const i = APP.indexOf("route('/', async () => {");
  const view = APP.slice(i, i + 3500);
  assert.match(view, /const qCounts = queueR\.counts \|\| \{\};/);
  assert.match(view, /if \(!queueR\.counts\) for \(const t of \(queueR\.items \|\| \[\]\)\)/,
    'the {items} shape must still be counted client-side');
  assert.match(view, /const qTotal = Object\.values\(qCounts\)\.reduce/,
    'the "is there anything at all" test must work for both shapes');
});

// ---------------------------------------------------------------------------------------
// 2. the chip that lied
// ---------------------------------------------------------------------------------------
const gmailBlock = (() => {
  const i = APP.indexOf('if (gmailR?.enabled) {');
  assert.ok(i > 0, 'the Gmail chip must still exist');
  return APP.slice(i, i + 1800);
})();

test('THE BUG: the chip no longer reports a failed attempt as a sync', () => {
  assert.ok(!/lr\?\.at \? 'synced ' \+ fmtRel\(lr\.at\)/.test(gmailBlock),
    'lastResult.at is stamped on FAILURE too — it can never mean "synced"');
  assert.match(gmailBlock, /h\.lastSuccessAt \? Date\.parse\(h\.lastSuccessAt\) : null/,
    '"synced" must be measured from the last SUCCESS');
});

test('a failing sync is shown as failing, and marked bad', () => {
  assert.match(gmailBlock, /const failing = !!\(lr && lr\.error\) \|\| gmailR\.authorized === false;/);
  assert.match(gmailBlock, /cls \+= ' bad';\s*\n\s*text = lastOk \? `failing/,
    'a failure must be styled as a failure, not left looking neutral');
});

test('it says how long ago it ACTUALLY worked', () => {
  // "failing" alone is not enough — 18 days versus 20 minutes is the difference between
  // "ignore it" and "everything downstream of this is stale".
  assert.match(gmailBlock, /failing · last synced \$\{fmtRel\(lastOk\)\}/);
  assert.match(gmailBlock, /'failing · never synced'/, 'and the never-worked case must be distinct');
});

test('the reason is carried in the tooltip rather than thrown away', () => {
  assert.match(gmailBlock, /title="\$\{esc\(why\)\}"/);
  assert.match(gmailBlock, /const why = String\(\(lr && lr\.error\) \|\| h\.lastError \|\| ''\)/);
});

test('a healthy sync still just says "synced"', () => {
  // The expensive direction: if this regressed to crying failure on a working connection, the
  // chip becomes noise and gets ignored again — which is how the original bug did its damage.
  assert.match(gmailBlock, /else if \(lastOk\) text = `synced \$\{fmtRel\(lastOk\)\}`;/);
});

test('stale-but-not-failing is its own state', () => {
  assert.match(gmailBlock, /else if \(gmailR\.stale\) \{/);
  assert.match(gmailBlock, /cls \+= ' warn';/, 'stale warns; it does not claim failure');
});

// Verified against a copy of the live database and against BOTH real nodes' /gmail/status:
//   dashboard payload   1,152,389 B -> 105 B, chip text identical ("21 queued - 90 need you")
//   PC gmail chip       "synced 0h ago"  -> "failing - last synced 18d ago"  [sys-chip bad]
//   laptop gmail chip   "synced 25d ago" -> "not connected"                  [sys-chip bad]
