// THE HOST BREAKER'S MISSING HALF: a host that accepted an application is not walling us.
//
// trippedEntry doubles the cooldown per consecutive hit (20m, 40m, 80m, 160m, 320m, capped 6h) and
// the comment beside it has always said "`hits` resetting on success keeps recovery fast". Nothing
// ever reset them. The only route back to zero was shouldForget's twelve QUIET hours, which a busy
// host never gets, so the counter could only ever climb.
//
// Live 2026-09-08: Indeed sat at three hits, pricing the next wall at 160 minutes and the one after
// at 320, while every runnable job in the queue was on Indeed and Indeed had also accepted 112
// submissions all-time. A host that mostly works was priced like one that never does, and an
// unattended night would have been spent almost entirely silent.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const hb = await import(pathToFileURL(path.join(here, '..', 'extension', 'lib', 'host-breaker.js')).href);
const { trippedEntry, behavedEntry, shouldForget, shouldDispatchHost, backoffMs,
  HOST_BREAKER_COOLDOWN_MS, HOST_BREAKER_FORGET_MS } = hb;

test('the backoff really does climb, which is why a reset has to exist', () => {
  const base = HOST_BREAKER_COOLDOWN_MS;
  assert.equal(backoffMs(1, base), base);
  assert.equal(backoffMs(2, base), base * 2);
  assert.equal(backoffMs(3, base), base * 4);       // the state Indeed was in: 80 min
  assert.equal(backoffMs(4, base), base * 8);       // the next wall would have cost 160 min
});

test('consecutive trips accumulate hits', () => {
  const t0 = 1_000_000;
  let e = trippedEntry(null, 'cloudflare', t0);
  assert.equal(e.hits, 1);
  e = trippedEntry(e, 'cloudflare', t0 + 60_000);
  e = trippedEntry(e, 'cloudflare', t0 + 120_000);
  assert.equal(e.hits, 3);
  assert.equal(e.until, t0 + 120_000 + backoffMs(3));
});

test('a behaved host is forgotten outright, so the next wall starts from the base cooldown', () => {
  // behavedEntry() returning null is the contract the caller relies on to DELETE the entry.
  assert.equal(behavedEntry(), null);

  const t0 = 1_000_000;
  const escalated = trippedEntry(trippedEntry(trippedEntry(null, 'cloudflare', t0), 'cloudflare', t0), 'cloudflare', t0);
  assert.equal(escalated.hits, 3);

  // Simulate what background.js does on a verified submit: drop the entry.
  const map = { 'indeed.com': escalated };
  if (behavedEntry() === null) delete map['indeed.com'];
  assert.equal(map['indeed.com'], undefined);

  // The very next wall is priced from scratch, not from hit #4.
  const afterReset = trippedEntry(map['indeed.com'] || null, 'cloudflare', t0 + 5_000_000);
  assert.equal(afterReset.hits, 1);
  assert.equal(afterReset.until - (t0 + 5_000_000), HOST_BREAKER_COOLDOWN_MS);
});

test('the twelve-hour forget rule still exists and is now the fallback, not the only route', () => {
  const t0 = 1_000_000;
  const e = trippedEntry(null, 'cloudflare', t0);
  assert.equal(shouldForget(e, t0 + 60_000), false, 'still inside its cooldown');
  assert.equal(shouldForget(e, t0 + HOST_BREAKER_COOLDOWN_MS + 1000), false, 'cooled down but not yet quiet for long');
  assert.equal(shouldForget(e, t0 + HOST_BREAKER_FORGET_MS + 1000), true);
});

test('resetting does not let a host be dispatched while it is still cooling', () => {
  // The reset only ever happens ON a successful submit, which cannot occur while the host is
  // walled. This pins the ordering anyway: the entry, while present, still blocks dispatch.
  const t0 = 1_000_000;
  const e = trippedEntry(null, 'cloudflare', t0);
  assert.equal(shouldDispatchHost('indeed.com', t0 + 1000, { 'indeed.com': e }).dispatch, false);
  assert.equal(shouldDispatchHost('indeed.com', t0 + HOST_BREAKER_COOLDOWN_MS + 1, { 'indeed.com': e }).dispatch, true);
});

test('the reset keys on REACHING THE FORM, not on submitting, and never on a challenge', () => {
  const src = fs.readFileSync(path.join(here, '..', 'extension', 'background.js'), 'utf8');

  // Requiring a completed submit was the first version and it was too strict. Live 2026-09-08:
  // indeed.com's cooldown lapsed, one job reached the form and stopped on an unanswerable question,
  // the count was never cleared, and the node went straight back to being walled on the only host
  // its entire queue was on. A reset that can only fire on a submit can never fire on a host that
  // is blocking submits.
  assert.doesNotMatch(src, /if \(finalState === 'done'\) \{[\s\S]{0,120}noteHostBehaved/,
    'reaching the form is the test, not completing a submission');
  assert.match(src, /if \(result\.everHadForm === true && result\.parkReason !== 'bot_challenge'\)/,
    'reset on a latched application form, except when the run ended because of a challenge');

  // The guard is the load-bearing half: without it the breaker would clear itself on the very
  // evidence that tripped it.
  assert.match(src, /parkReason !== 'bot_challenge'/);
  // `job` is not a binding in launchOne - the job url is captured as `url` at the top. Optional
  // chaining does NOT save an undeclared identifier, so `job?.jobUrl` here would throw on every
  // successful application. It did, in the first draft of this change.
  assert.doesNotMatch(src, /noteHostBehaved\(hostOfUrl\(job\?/,
    'noteHostBehaved must not reference an undeclared `job`');
  assert.match(src, /noteHostBehaved\(hostOfUrl\(url\)\)/);
});

test('the executor reports everHadForm, or the pump has nothing to key on', () => {
  const ex = fs.readFileSync(path.join(here, '..', 'extension', 'content', 'executor.js'), 'utf8');
  assert.match(ex, /everHadForm: !!everHadForm,/,
    'the terminal return must carry everHadForm through to background.js');
});
