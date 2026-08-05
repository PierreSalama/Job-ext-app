// The per-site pacing gap must never become a DEADLOCK.
//
// Live failure this guards: during a LinkedIn Easy-Apply cooldown every LinkedIn job is (correctly)
// deferred, leaving Indeed as the only dispatchable source. Every Indeed job shares one site key
// ("ats:indeed"), so a single intra-site pacing timer held the entire pipeline — 321 jobs queued and
// nothing running for a whole night, reported only as "easyapply-cooldown".
//
// Rule: pacing may delay a job while OTHER work exists, but when a gap-deferred job is the only
// thing left, queueNext must release it rather than idle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = fs.readFileSync(path.join(here, '..', 'app', 'src', 'server.js'), 'utf8');

test('gap-deferred jobs are retained, not discarded', () => {
  assert.match(server, /const gapOnly = \[\];/, 'must keep a list of gap-only deferrals');
  assert.match(server, /gapOnly\.push\(\{ t, j, order: i \}\)/, 'the gap branch must retain the job');
});

test('when nothing else is dispatchable, the oldest gap-deferred job is released', () => {
  const block = server.slice(server.indexOf('if (!candidates.length && gapOnly.length)'));
  assert.ok(block.length > 0, 'a gap fallback must exist');
  assert.match(block.slice(0, 400), /candidates\.push\(gapOnly\[0\]\)/, 'must promote a gap-deferred job');
  assert.match(block.slice(0, 400), /sort\(\(a, b\) => b\.order - a\.order\)/, 'oldest-first, matching normal dispatch order');
});

test('the fallback runs BEFORE the idle reasons, so pacing cannot mask a stall', () => {
  const fallback = server.indexOf('if (!candidates.length && gapOnly.length)');
  const easyIdle = server.indexOf("reason: 'easyapply-cooldown'");
  const hostIdle = server.indexOf("reason: 'host-cooldown'");
  assert.ok(fallback > -1 && easyIdle > -1 && hostIdle > -1, 'all three branches must exist');
  assert.ok(fallback < easyIdle, 'gap fallback must precede the easyapply-cooldown return');
  assert.ok(fallback < hostIdle, 'gap fallback must precede the host-cooldown return');
});

test('pacing still applies normally when other candidates exist', () => {
  // The fallback is gated on an EMPTY candidate list — it must never bypass pacing while real
  // candidates are available, or the anti-throttle spacing would be defeated entirely.
  assert.match(server, /if \(!candidates\.length && gapOnly\.length\) \{/, 'fallback must require zero candidates');
});
