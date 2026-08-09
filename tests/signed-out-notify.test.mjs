// Halting because we are signed out must TELL Pierre — he is the only one who can clear it.
//
// The signed-out latch (v11.90.13) correctly halts LinkedIn dispatch the moment the executor sees
// the sign-in wall. That is what prevents a repeat of the 31-hour outage this whole effort started
// from. But the notify hook wired alongside it dispatched type 'signedOut', and main.js's dispatcher
// only implemented 'status' and 'autoApply' — so it fell through and did NOTHING.
//
// Live 2026-08-09: the PC sat signed out and halted for 81 minutes, with /queue/next returning
// reason=signed-out and 23 LinkedIn jobs held back, and no signal to anyone. Halting silently turns
// a loud failure into a quiet one: the node looks alive and simply produces nothing. Detection
// without notification is only half the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const main = read('app', 'src', 'main.js');
const server = read('app', 'src', 'server.js');

test("main.js actually HANDLES the 'signedOut' notify type", () => {
  assert.match(main, /if \(type === 'signedOut'\)/,
    'regression: dispatching a type nothing handles is the same as not notifying at all');
});

test('it reaches Pierre on both channels', () => {
  const block = main.slice(main.indexOf("if (type === 'signedOut')"));
  const body = block.slice(0, block.indexOf('\n}'));
  assert.match(body, /notify\('autoApply'/, 'in-app feed, so there is a history of it');
  assert.match(body, /nativeNotify\(/, 'native OS popup, because this needs him to act');
});

test('the message says what to do, not just what broke', () => {
  const block = main.slice(main.indexOf("if (type === 'signedOut')"));
  const body = block.slice(0, block.indexOf('\n}'));
  assert.match(body, /signed out of LinkedIn/i, 'names the actual cause');
  assert.match(body, /resumes by itself/i,
    'he must know signing in is enough — the latch self-clears on the next successful apply');
});

test('it fires ONCE per sign-out, not once per held task', () => {
  const fn = server.slice(server.indexOf("if (body.parkReason === 'signed_out'"));
  const block = fn.slice(0, fn.indexOf('// ...and clear it'));
  assert.match(block, /const wasSignedOut = db\.isSignedOut\(\)/, 'must read the prior state');
  assert.match(block, /if \(!wasSignedOut && opts\.notify\)/,
    'every held task reports this — notifying per report would fire dozens of native popups');
});

test('the latch itself is still set on every report', () => {
  const fn = server.slice(server.indexOf("if (body.parkReason === 'signed_out'"));
  const block = fn.slice(0, fn.indexOf('// ...and clear it'));
  assert.match(block, /db\.setSignedOut\(/,
    'de-duplicating the NOTIFICATION must not de-duplicate the halt');
  const iRead = block.indexOf('const wasSignedOut');
  const iSet = block.indexOf('db.setSignedOut(');
  assert.ok(iRead < iSet, 'the prior state must be read before it is overwritten');
});

// The de-dup arithmetic, pinned independently of the source.
test('one sign-out with many held tasks produces exactly one notification', () => {
  let latched = false, notifications = 0;
  const report = () => { const was = latched; latched = true; if (!was) notifications++; };
  for (let i = 0; i < 23; i++) report();      // the 23 LinkedIn jobs held live
  assert.equal(notifications, 1, 'one popup, not 23');

  latched = false;                             // he signs in; a later sign-out must notify again
  report();
  assert.equal(notifications, 2);
});
