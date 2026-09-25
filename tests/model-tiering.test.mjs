// CHEAP WHERE IT IS A SHAPE, SONNET WHERE IT IS A VOICE.
//
// Pierre asked for cheaper models "while also still giving us the result we want". The line between
// those is not the task name, it is whether the output is validated on arrival.
//
//   schema present -> the caller checks the structure, so a weaker model that gets it wrong is
//                     CAUGHT rather than believed. Haiku is fine.
//   no schema      -> free prose. A resume bullet, a cover letter, "why do you want to work here".
//                     That is the text a recruiter decides on, and a cheaper model there produces
//                     exactly the flat over-connected writing the voice gate exists to reject.
//                     Saving quota there costs interviews, which is the only point of the system.
//
// And the original guarantee has to survive all of it: no path may reach Opus. That module exists
// because `model` was once allowed to be null, meaning "whatever the CLI defaults to today" — the
// quiet way an Opus-priced sweep over 1,400 emails nearly happened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const mp = require(path.join(here, '..', 'app', 'src', 'ai', 'model-policy.js'));

test('a schema means structured output, which goes to the cheap tier', () => {
  assert.equal(mp.enforce(null, { schema: { type: 'object' } }).model, mp.HAIKU_ALIAS);
  assert.equal(mp.tierFor({ schema: {} }), mp.HAIKU_ALIAS);
});

test('no schema means prose, which stays on Sonnet', () => {
  assert.equal(mp.enforce(null, {}).model, mp.SONNET_ALIAS);
  assert.equal(mp.enforce(null).model, mp.SONNET_ALIAS, 'called with no options at all');
  assert.equal(mp.tierFor({}), mp.SONNET_ALIAS);
});

test('the reason says WHY, so a swapped model is never silent', () => {
  assert.match(mp.enforce(null, { schema: {} }).reason, /structured|cheap/i);
  assert.match(mp.enforce(null, {}).reason, /prose|Sonnet/i);
});

// ---------------------------------------------------------------------------
// the guarantee that predates tiering
// ---------------------------------------------------------------------------
test('Opus is unreachable, with or without a schema', () => {
  for (const asked of ['opus', 'claude-opus-5', 'claude-3-opus-20240229', 'OPUS']) {
    assert.doesNotMatch(mp.enforce(asked, {}).model, /opus/i, `${asked} leaked through on prose`);
    assert.doesNotMatch(mp.enforce(asked, { schema: {} }).model, /opus/i, `${asked} leaked through on structured`);
  }
});

test('an unknown or junk model never becomes the CLI default', () => {
  // The original bug: null meant "whatever the CLI prefers today".
  for (const junk of ['', null, undefined, '   ', 'gpt-4', 'llama3', 'not-a-model']) {
    const m = mp.enforce(junk, {}).model;
    assert.ok(m === mp.SONNET_ALIAS || m === mp.HAIKU_ALIAS, `${JSON.stringify(junk)} resolved to ${m}`);
  }
});

// ---------------------------------------------------------------------------
// explicit requests are honoured — this is how the email pipeline pins Sonnet
// ---------------------------------------------------------------------------
test('an explicit Sonnet request survives even on a structured call', () => {
  // Pierre's 2026-08-10 instruction was "Sonnet and only Sonnet" for the email pipeline. Tiering
  // must not quietly downgrade a caller that asked for Sonnet on purpose.
  assert.equal(mp.enforce('sonnet', { schema: {} }).model, 'sonnet');
  assert.equal(mp.enforce('claude-sonnet-5', { schema: {} }).model, 'claude-sonnet-5');
  assert.equal(mp.enforce('sonnet', { schema: {} }).overridden, false);
});

test('an explicit Haiku request is honoured on prose too', () => {
  assert.equal(mp.enforce('haiku', {}).model, 'haiku');
  assert.equal(mp.enforce('claude-haiku-4-5-20251001', {}).overridden, false);
});

test('the recognisers accept aliases and dated ids alike', () => {
  for (const m of ['sonnet', 'claude-sonnet-5', 'claude-sonnet-4-6']) assert.ok(mp.isSonnet(m), m);
  for (const m of ['haiku', 'claude-haiku-4-5-20251001']) assert.ok(mp.isHaiku(m), m);
  assert.ok(!mp.isSonnet('haiku') && !mp.isHaiku('sonnet'), 'the two must not overlap');
  assert.ok(!mp.isSonnet('opus') && !mp.isHaiku('opus'));
});
