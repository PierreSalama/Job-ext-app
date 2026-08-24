// SIGNED-OUT STARVATION — the fourth member of a family of bugs with one shape.
//
// Live on pierre-laptop, 2026-08-11 04:00: the node reported enabled, running, 317 queued, and had
// submitted almost nothing for 13 hours. The cause:
//
//   • the browser had been signed out of LinkedIn for 804 minutes
//   • 313 of the 317 queued jobs were LinkedIn, so the signed-out latch held every one
//   • but those 313 still counted toward "queue full" in the discovery refill gate
//   • so jobspy never ran, Indeed supply drained to ZERO queued, and the only dispatchable work
//     left was 4 Greenhouse jobs, 3 of which were behind the per-site cap
//
// The rule already written in that function — "a task that cannot be dispatched now must never gate
// discovery" — was stated for the Easy-Apply cooldown and the host wall. Signed-out is the same
// case and was missing. These tests pin all four members so the next one is added, not rediscovered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'app', 'src', 'discovery', 'index.js'), 'utf8');
const gate = src.slice(src.indexOf('const ATS_FEED_SOURCES'), src.indexOf("return { ok: false, reason: 'queue-full' }"));

test('the refill gate excludes ALL FIVE kinds of undispatchable task', () => {
  assert.match(gate, /ATS_FEED_SOURCES\.has\(src\)/, '1. the separate direct-ATS feed');
  assert.match(gate, /cooledDownGate && src === 'linkedin'/, '2. LinkedIn during the Easy-Apply cooldown');
  assert.match(gate, /signedOutGate && src === 'linkedin'/, '3. LinkedIn while signed out — THE FIX');
  assert.match(gate, /Date\.parse\(t\.scheduledAt\) > nowMs/, '4. tasks deferred behind a host wall');
  assert.match(gate, /notThisNode\(src\)/, '5. platforms this node does not own (role != primary)');
});

test('the signed-out check is read from the latch, defensively', () => {
  assert.match(gate, /try \{ signedOutGate = db\.isSignedOut\(\); \} catch/,
    'a throwing latch must not take discovery down with it');
});

test('discovery steers AWAY from LinkedIn while signed out', () => {
  // Searching LinkedIn while signed out spends account budget to pile up jobs the executor will
  // refuse — the worst of both: request volume against a platform that just restricted him, and no
  // usable supply out of it.
  const boards = src.slice(src.indexOf('let signedOutBoards'), src.indexOf('const boardIndex'));
  assert.match(boards, /signedOutBoards/);
  assert.match(boards, /boards\.filter\(\(b\) => b !== 'linkedin'\)/);
});

test('easyApplyOnly is relaxed while signed out, so external work keeps flowing', () => {
  const line = src.slice(src.indexOf('const effEasyApplyOnly'), src.indexOf('const effEasyApplyOnly') + 200);
  assert.match(line, /!cooledDown && !signedOutBoards/,
    'Easy-Apply-only would otherwise restrict discovery to the one board that cannot be used');
});

test('the reason it exists is written down where the next person will read it', () => {
  assert.match(gate, /signed out/i);
  assert.match(src, /313|804/, 'the live numbers make the failure recognisable next time');
});
