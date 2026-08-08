// The refill gate has now caused the SAME starvation bug twice, on both sides of the app/extension
// split, so it gets a test that pins the invariant rather than one instance of it.
//
// The invariant: multiple feeds enqueue into ONE shared queue (app JobSpy → linkedin/indeed, the
// direct-ATS feed → greenhouse/lever/ashby, the extension's browser discovery → LinkedIn f_AL).
// If any feed gates itself on the TOTAL queued depth, a backlog belonging to some OTHER feed holds
// the total above refillBelow and that feed never runs again — it is starved by supply it does not
// own, and cannot dilute the backlog that is starving it.
//
// v11.83 fixed this app-side (discovery/index.js). Measured live 2026-07-20 it was still live in the
// extension: 106 queued = 86 Indeed + 6 LinkedIn against refillBelow 40, so LinkedIn Easy-Apply
// discovery — the only real source of Easy-Apply jobs — was permanently gated off, and 58 of the
// last 90 minutes' outcomes were "external, no Easy Apply" skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');

// The arithmetic of the bug, as a pure function — this is what each gate must implement.
function gateAllows({ queued, board, refillBelow }) {
  const own = queued.filter((j) => j.source === board).length;
  return own < refillBelow;
}

test('a per-board gate lets a starved feed run through another feed\'s backlog', () => {
  // The exact live-measured queue that deadlocked discovery.
  const queued = [
    ...Array.from({ length: 86 }, () => ({ source: 'indeed' })),
    ...Array.from({ length: 6 }, () => ({ source: 'linkedin' })),
    ...Array.from({ length: 14 }, () => ({ source: 'greenhouse' })),
  ];
  const refillBelow = 40;

  // The old whole-queue gate: 106 >= 40 blocks EVERY board, including the starved one.
  assert.equal(queued.length >= refillBelow, true, 'precondition: total depth exceeds the threshold');

  // Per-board: LinkedIn (6 queued) runs, Indeed (86 queued) still correctly self-limits.
  assert.equal(gateAllows({ queued, board: 'linkedin', refillBelow }), true,
    'LinkedIn discovery must run — its own backlog is 6, far below the threshold');
  assert.equal(gateAllows({ queued, board: 'indeed', refillBelow }), false,
    'Indeed must still be gated — the fix must not turn into "never throttle anything"');
});

test('extension discoverTick gates on per-board depth, not total queue depth', () => {
  const src = read('extension', 'background.js');
  const gate = src.slice(src.indexOf('SOURCE-AWARE refill gate'));
  assert.ok(gate.length, 'the source-aware refill gate is missing from discoverTick');
  const body = gate.slice(0, gate.indexOf('scanning = true'));

  assert.match(body, /job\?\.source|job\.source/,
    'the gate must count only jobs from the board being scanned');
  assert.doesNotMatch(body, /\(q\?\.items \|\| \[\]\)\.length\s*>=/,
    'regression: gating on the RAW queue length starves this feed behind other feeds\' backlog');
});

test('app-side jobspy gate is source-aware too (both sides must hold the invariant)', () => {
  const src = read('app', 'src', 'discovery', 'index.js');
  assert.match(src, /jobspyQueued\s*>=/, 'app-side gate must compare its OWN queued depth');
  assert.match(src, /ATS_FEED_SOURCES/, 'app-side gate must exclude the separate ATS feed');
});

// --- Third instance of the same invariant, live 2026-08-07 -------------------------------------
// The gate excluded two classes of un-dispatchable queued tasks (other feeds' ATS jobs, and
// cooldown-blocked LinkedIn jobs) but not the third: tasks the dispatch breaker deferred behind a
// site verification wall by pushing scheduled_at into the FUTURE and leaving them 'queued'.
// 65 Indeed jobs sat behind Indeed's wall (oldest 6 days), holding the count at 65 >= refillBelow
// 60. jobspy did not run for 18h, LinkedIn supply went to zero, and the node submitted NOTHING for
// 31 hours while every dashboard read "busy". Generalised: depth means DISPATCHABLE depth.
test('tasks deferred into the future do not count toward "queue full"', () => {
  const now = Date.now();
  const future = new Date(now + 30 * 60000).toISOString();
  const past = new Date(now - 30 * 60000).toISOString();
  const queued = [
    ...Array.from({ length: 65 }, () => ({ source: 'indeed', scheduledAt: future })), // wall-deferred
    ...Array.from({ length: 2 }, () => ({ source: 'indeed', scheduledAt: past })),     // actually due
  ];
  const dispatchable = queued.filter((t) => !(t.scheduledAt && Date.parse(t.scheduledAt) > now));

  assert.equal(queued.length >= 60, true, 'precondition: raw depth exceeds the threshold');
  assert.equal(dispatchable.length, 2, 'only the due tasks are dispatchable');
  assert.equal(dispatchable.length >= 60, false, 'so the gate must let discovery run');
});

test('the app-side gate implements the not-due exclusion', () => {
  const src = read('app', 'src', 'discovery', 'index.js');
  const gate = src.slice(src.indexOf('SOURCE-AWARE refill gate'), src.indexOf('jobspyQueued >='));
  assert.match(gate, /scheduledAt/,
    'the gate must read scheduled_at — a task not yet due cannot be dispatched');
  assert.match(gate, /Date\.parse\(t\.scheduledAt\)\s*>/,
    'a FUTURE scheduled_at is what marks a task un-dispatchable');
});

test('a gated tick does not consume a rotation slot', () => {
  // The gate reads the combo index to know its board, so it must PEEK: persisting the next index on
  // a gated tick would silently skip that combo the next time discovery actually runs.
  const src = read('extension', 'background.js');
  const peek = src.indexOf('PEEK the next combo');
  const gate = src.indexOf('SOURCE-AWARE refill gate');
  const persist = src.indexOf('DISCOVER_IDX_KEY]: (dIdx + 1)');
  assert.ok(peek > -1 && gate > -1 && persist > -1, 'peek / gate / persist markers all present');
  assert.ok(peek < gate, 'the combo must be peeked before the per-board gate reads its board');
  assert.ok(gate < persist, 'the rotation index must only be persisted after the gate is passed');
});
