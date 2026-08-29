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

// ---------------------------------------------------------------------------------------
// 3. THE SAME LIE, TWO MORE PLACES (found by auditing every fmtRel() call)
//
// Having fixed the dashboard chip, the obvious question is where else a timestamp becomes a
// status claim. Grepping every fmtRel() call in the file found two more:
//
//   Settings -> Gmail   "● connected · last sync just now · 0 updated"   while every sync was
//                       being refused. This is the page you would OPEN IN ORDER TO FIX IT.
//                       `authorized` only means a token exists, not that Google still takes it.
//                       On the laptop it was self-contradictory: "○ not connected" AND
//                       "last sync 25d ago · 0 updated" on the same line.
//
//   Auto-apply watchdog `const hp = d.health || {}` then two absent counters rendered as
//                       "healthy". Absence of evidence printed as a positive health claim --
//                       a node that stopped reporting looked identical to a node with nothing
//                       wrong.
const SETTINGS = (() => {
  const i = APP.indexOf('const gmailStatusHtml =');
  assert.ok(i > 0, 'the settings Gmail status must be built up front');
  return APP.slice(i, i + 1500);
})();

test('Settings shows Gmail as FAILING when the last sync errored', () => {
  assert.match(SETTINGS, /if \(lr && lr\.error\)/);
  assert.match(SETTINGS, /● failing/);
  assert.match(SETTINGS, /sys-chip bad/, 'and it must be styled as bad, not neutral');
});

test('Settings measures "last sync" from the last SUCCESS', () => {
  assert.match(SETTINGS, /gh\.lastSuccessAt \? Date\.parse\(gh\.lastSuccessAt\) : null/);
  assert.ok(!/lastResult\.at/.test(SETTINGS),
    'lastResult.at is stamped on failures — it can never mean "last sync"');
});

test('Settings no longer prints a sync time next to "not connected"', () => {
  // The laptop rendered both at once, which is how a contradiction hides in plain sight.
  assert.match(SETTINGS, /return '<span class="sys-chip">○ not connected<\/span>';/,
    'the not-connected branch must return on its own, with no trailing note');
});

test('Settings still says connected, plainly, when it is', () => {
  assert.match(SETTINGS, /'<span class="sys-chip ok">● connected<\/span>'/);
  assert.match(SETTINGS, /last sync ' \+ fmtRel\(lastOk\)/);
});

test('the Gmail status is built OUTSIDE the template literal', () => {
  // Not style: a nested template literal inside the settings markup is what broke this file on
  // the first attempt. Keeping it in a const is the thing that makes it safe to edit.
  const i = APP.indexOf('const gmailStatusHtml =');
  const j = APP.indexOf('${gmailStatusHtml}');
  assert.ok(i > 0 && j > i, 'it must be computed before the markup that uses it');
});

test('THE WATCHDOG: missing health data is not "healthy"', () => {
  const i = APP.indexOf('const healthLine =');
  const line = APP.slice(i, i + 700);
  assert.match(line, /\(hp\.staleTasks == null && hp\.invalidWaits == null\) \? '<b>not reporting<\/b>'/,
    'a node that reports nothing must say so, not claim health');
  assert.match(line, /'<b>healthy<\/b>'/, 'and a node reporting zero issues must still say healthy');
});

// Verified against BOTH real nodes' /gmail/status payloads:
//   PC      Settings  "● connected · last sync 0h ago · 0 updated"
//                 ->  "● failing · last successful sync 18d ago"      [bad]
//   laptop  Settings  "○ not connected · last sync 25d ago · 0 updated"
//                 ->  "○ not connected"
// And the watchdog line across all four states: {} -> "not reporting", {0,0} -> "healthy",
// {3,0} -> "3 issue(s) detected", {0,1} -> "1 issue(s) detected". Both real nodes report 0/0,
// so "healthy" there is now an earned claim rather than a default.

// ---------------------------------------------------------------------------------------
// 4. "PACING" WITH A QUEUE THIS MACHINE MAY NEVER TOUCH
//
// The PC reported status "pacing" with 21 queued — which reads as "working through them". Every
// one of those 21 is LinkedIn or Indeed, both deliberately role:'none' on that node so it can
// never re-trigger the 2026-08-10 LinkedIn restriction. They are permanently undispatchable
// there; only a human changing the role frees them. So the number described work that was never
// going to happen, which is the same class of untruth as the Gmail chip above: a surface that
// says fine because nothing told it otherwise.
//
// Measured against a copy of the live database:
//   PC      status pacing -> queue-blocked, queuedDepth 21, queuedBlocked 21, queuedRunnable 0
//   laptop  linkedin=primary indeed=primary -> queuedBlocked 0, queuedRunnable 56, still pacing
test('the server counts queued tasks by source without reading them', () => {
  assert.match(DB, /function queuedBySource\(\)/);
  assert.match(DB, /WHERE t\.state = 'queued' GROUP BY src/,
    'counted in SQL — queueList() returns 1.1 MB to answer a question about integers');
});

test('a queue nothing here may run is its own status, not "pacing"', () => {
  assert.match(SERVER, /status = 'queue-blocked'/);
  assert.match(SERVER, /queuedRunnable === 0 && live\.scheduled === 0/,
    'blocked means nothing RUNNABLE and nothing scheduled — not merely "some are blocked"');
});

test('blocked is decided by the SAME role rule as dispatch and discovery', () => {
  // If these three ever disagree, the dashboard starts describing a queue the pump does not
  // actually have — the reverse of the bug, and harder to notice.
  const i = SERVER.indexOf('let queuedBlocked = 0;');
  assert.ok(i > 0);
  const blk = SERVER.slice(i, i + 700);
  assert.match(blk, /safety\.isConfiguredPlatform\(s\.safety, src\)/);
  assert.match(blk, /String\(safety\.platformConfig\(s\.safety, src\)\.role\)\.toLowerCase\(\) !== 'primary'/);
  assert.match(blk, /s\.safety\.enabled !== false/, 'safety off means ungoverned means dispatchable');
});

test('both counts reach the client', () => {
  assert.match(SERVER, /concurrency, status, \.\.\.live, queuedBlocked, queuedRunnable,/);
});

test('the status label says what it means in words', () => {
  assert.match(APP, /'queue-blocked': 'Idle · nothing this machine may run'/,
    'a raw status string in the UI is not an explanation');
});

test('the dashboard chip names the blocked share', () => {
  assert.match(APP, /const qBlocked = Number\(liveR && liveR\.queuedBlocked\) \|\| 0;/);
  assert.match(APP, /not for this machine/);
  assert.match(APP, /\$\{awaiting \|\| qBlocked \? 'warn' : ''\}/,
    'a queue that cannot move should not look calm');
});

test('a node whose lanes ARE primary is untouched', () => {
  // The expensive direction. On the laptop linkedin and indeed are both primary, so nothing is
  // blocked and the status must stay exactly as it was — verified against its real settings:
  // queuedBlocked 0, queuedRunnable 56, status pacing.
  const i = SERVER.indexOf('let queuedBlocked = 0;');
  const blk = SERVER.slice(i, i + 700);
  assert.match(blk, /queuedBlocked \+= n;/);
  assert.ok(!/queuedBlocked \+= 1;|queuedBlocked = live\.queuedDepth/.test(blk),
    'only genuinely non-primary sources may count as blocked');
});

// ---------------------------------------------------------------------------------------
// 5. A COMBINED TOTAL THAT IS MISSING A MACHINE IS NOT A TOTAL
//
// Dashboard, Applications and Pipeline all show every machine combined. When one does not
// answer its share is skipped — deliberately, and correctly: one machine being off must not
// blank the view. But nothing SAID so, and both helpers returned ok:true regardless.
//
// Demonstrated in a browser by making the laptop unreachable mid-session:
//   "Submitted today"  33  ->  6      (an 82% drop, indistinguishable from a real number)
// and back to 33, with no warning, once it answered again.
test('the merge helpers report which machines did not answer', () => {
  assert.match(APP, /function missingOf\(res\) \{/);
  assert.match(APP, /res\.filter\(\(r\) => !r\.ok\)\.map/,
    'derived from the per-node ok flag fetchAllNodes already returns');
  assert.match(APP, /return \{ ok: true, items, total: items\.length, missing: missingOf\(res\) \};/);
  assert.match(APP, /out\.missing = missingOf\(res\);/);
});

test('an unreachable machine is still SKIPPED, not fatal', () => {
  // The original behaviour is the right one and must survive: one machine off must never blank
  // the combined view. This change adds the disclosure, not a failure.
  const i = APP.indexOf('async function fetchAllNodes');
  const fn = APP.slice(i, i + 500);
  assert.match(fn, /Promise\.allSettled/, 'one node failing must not reject the whole fetch');
});

test('the dashboard says so when the totals are short', () => {
  assert.match(APP, /const missingNodes = \(statsR && statsR\.missing\) \|\| \[\];/);
  assert.match(APP, /not reachable · totals incomplete/);
  assert.match(APP, /sys-chip bad/, 'an incomplete total is not a neutral condition');
});

test('and says nothing when every machine answered', () => {
  // The expensive direction: a warning that shows on a healthy system is noise, and noise is
  // how the Gmail chip earned its eighteen days of being ignored.
  assert.match(APP, /if \(missingNodes\.length\) \{/,
    'the note must be conditional on an actual failure');
});

test('the tooltip explains what the number is missing', () => {
  // "not reachable" alone does not tell him the headline figures are understated.
  assert.match(APP, /These numbers are the total across your machines\./);
  assert.match(APP, /did not answer, so its applications are not counted here/);
});

// ---------------------------------------------------------------------------------------
// 3. A METRIC THAT DEPENDS ON A DEAD PIPELINE MUST NOT REPORT A NUMBER
//
//    Observed on the laptop node, 2026-08-28, on the SAME row of the SAME page:
//      "Response rate  0%   1 replied · 1 interview"      against 1,036 submitted
//      "Gmail · synced 26d"
//    Replies are found by reading the inbox. With that sync dead for 26 days the response
//    rate is not low, it is UNMEASURED -- and 0% next to a thousand applications is the most
//    demoralising thing this app can put on a screen. Same rule as the Gmail chip: a failure
//    must never be rendered as an answer.
// ---------------------------------------------------------------------------------------
test('the dashboard knows when replies are not being detected', () => {
  assert.match(APP, /let repliesBlind = null;/,
    'the stat row needs the Gmail health that only the chip block computes');
  assert.match(APP, /repliesBlind = failing \? 'the Gmail sync is failing'/);
  assert.match(APP, /the Gmail sync has never completed/);
  assert.match(APP, /the Gmail sync is switched off/,
    'switched off is also blind — not just failing');
});

test('a stale sync counts as blind, not just an outright failure', () => {
  // The 26-day case reported `synced`, not `failing`: it was not erroring, it simply was not
  // running. Age has to be part of the test or this whole fix misses the case that prompted it.
  assert.match(APP, /const STALE_MS = 3 \* 24 \* 60 \* 60 \* 1000;/);
  assert.match(APP, /\(Date\.now\(\) - lastOk\) > STALE_MS/);
});

test('a blind response rate shows no percentage at all', () => {
  const i = APP.indexOf('Replies are detected by reading the inbox');
  assert.ok(i > 0, 'the reasoning must stay next to the code');
  const block = APP.slice(i, i + 1400);
  assert.match(block, /if \(repliesBlind\) \{/);
  assert.match(block, /not counting</, 'print words, not a number that will be read as a result');
  assert.ok(!/\$\{pct\}/.test(block.slice(0, block.indexOf('return `<div class="stat"><div class="stat-label">Response rate'))),
    'the percentage must not be rendered on the blind path');
});

test('and rounding does not manufacture a zero either', () => {
  // 1 reply in 1,036 is 0.096%, which Math.round prints as "0%" directly above the words
  // "1 replied". Arithmetically fine, and it reads as a contradiction.
  assert.match(APP, /fn\.responseRate === 0 && \(fn\.responded \|\| 0\) > 0\) \? '<1%'/);
});

// ---------------------------------------------------------------------------------------
// 4. TWO DIFFERENT NUMBERS MAY NOT SHARE ONE LABEL
//
//    Sidebar chip: "Auto-apply · 46 queued · 85 need you"   (every parked item, all sessions)
//    Auto-apply card: "Needs you  0"                        (this session only)
//    Both correct, both on screen together, nothing to tell them apart. This is the same trap
//    the /auto-apply/live swap above was rejected for: session counts are not queue counts.
// ---------------------------------------------------------------------------------------
test('the session needs-you number says it is the session', () => {
  assert.match(APP, /Needs you · this session/,
    'an unqualified "Needs you" beside a different unqualified "Needs you" is the defect');
});

test('and points at the real total when the session count is zero', () => {
  // Zero is the misleading case: the card reads "nothing to do" while 85 items wait.
  assert.match(APP, /awaiting && !sess\.needsYou \? `<div class="mini-sub"><a href="#\/needs-you">\$\{awaiting\} waiting overall/);
});

test('the two counts still come from their own sources', () => {
  // The fix is labelling, NOT making them equal. Making the card show the queue total would
  // lose the "what is this run doing" signal, which is the card's whole job.
  assert.match(APP, /\$\{sess\.needsYou \|\| 0\}/, 'the card still reports the session');
  assert.match(APP, /const awaiting = \(qCounts\.awaiting_review \|\| 0\) \+ \(qCounts\.awaiting_input \|\| 0\);/,
    'the overall figure still comes from /queue/counts');
});
