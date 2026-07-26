// THE recurring bug of 2026-07-20, found four times in one day: a TRANSIENT condition written as
// a PERMANENT state. 'skipped' is terminal and never re-dispatched, so every one of these
// permanently discarded jobs that had not even been attempted.
//
//   anchor opener      an opener merely not recognised    -> 71 LinkedIn jobs
//   host breaker       a Cloudflare wall, clears in ~20m  -> 48 Indeed jobs
//   executor challenge the same wall, first job to hit it ->  8 jobs
//   cancel()           a pause or an Escape keypress      -> 123 jobs (88 pause, 35 escape)
//
// The rule this file enforces: only a real VERDICT on the job may be terminal. An interruption,
// a wall, or an unrecognised control must leave the job dispatchable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ex = fs.readFileSync(path.join(here, '..', 'extension', 'content', 'executor.js'), 'utf8');

test('interrupting a run returns the job to the queue', () => {
  const start = ex.indexOf('const TRANSIENT_CANCEL');
  const fn = ex.slice(start, ex.indexOf('let reportQueue', start));
  assert.ok(fn.length, 'cancel() and its transient set not found');

  for (const r of ['user', 'escape', 'teach-stop'])
    assert.match(fn, new RegExp(`'${r}'`), `${r} is an interruption, not a decision — it must be transient`);

  assert.match(fn, /state: 'queued'/, 'a transient cancel must requeue the job');
  assert.match(fn, /TRANSIENT_CANCEL\.has\(reason\)/, 'the branch must key off the reason');
});

test('an explicit user decision NOT to apply stays terminal', () => {
  // These two are verdicts on the job, not interruptions: the user pressed skip on the recovery
  // prompt, or declined the final submit. Requeuing them would re-ask forever.
  for (const r of ['recovery-skip', 'submit-not-approved']) {
    const start = ex.indexOf('const TRANSIENT_CANCEL');
    const fn = ex.slice(start, ex.indexOf('let reportQueue', start));
    assert.doesNotMatch(fn, new RegExp(`'${r}'`), `${r} is a decision and must NOT be requeued`);
  }
  assert.match(ex, /report\(\{ state: 'skipped', lastError: `stopped by \$\{reason\}`/,
    'the terminal branch must still exist for real decisions');
});

test('a bot challenge defers the job instead of discarding it', () => {
  const start = ex.indexOf('if (challenge.blocked)');
  const block = ex.slice(start, ex.indexOf('const blocker = captchaOrLoginPresent', start));
  assert.ok(block.length, 'bot-challenge block not found');
  assert.match(block, /state: 'queued'/, 'the walled job must survive the wall');
  assert.match(block, /scheduledAt: deferUntil/, 'and come back after the breaker window');
  assert.doesNotMatch(block, /state: 'skipped'/, "regression: a wall is transient, 'skipped' is not");
  assert.match(block, /botChallenge: \{ kind: challenge\.kind/, 'the host breaker must still be armed');
});

test('executor.js imports nothing outside content/ and its own lib', () => {
  // Importing extension/lib/host-breaker.js broke the ENTIRE executor at runtime:
  // "Failed to fetch dynamically imported module" — that module is not in
  // web_accessible_resources, so every apply failed until the import was removed. The cooldown
  // constant is mirrored inline instead.
  const imports = [...ex.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
  for (const spec of imports) {
    assert.ok(!spec.startsWith('../lib/'),
      `${spec} is outside the content-script bundle — importing it fails the whole module load`);
  }
});
