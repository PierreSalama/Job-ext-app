// CODEX WAS FAILING 100% OF STRUCTURED CALLS, AND IT WAS FIRST IN THE CHAIN.
//
// Measured live 2026-09-08, with Codex first at Pierre's instruction:
//
//     codex exited 1: Invalid schema for response_format 'codex_output_schema':
//     In context=(), 'additionalProperties' is required to be supplied and to be false
//
// Not quota, not login. The schemas JAT already used are perfectly valid JSON Schema and simply are
// not what OpenAI strict mode demands. So the first provider burned 9 to 31 seconds failing on every
// structured call before the chain fell through — and when Claude then failed to parse and the peer
// was unreachable, an agent run hung at step 0 with a browser open.
//
// Two requirements, both invisible in ordinary JSON Schema:
//   1. every object carries additionalProperties: false
//   2. every object's `required` lists EVERY key in `properties`
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { toStrictSchema } = require(path.join(here, '..', 'app', 'src', 'ai', 'strict-schema.js'));

test('every object gets additionalProperties: false', () => {
  const s = toStrictSchema({ type: 'object', properties: { answer: { type: 'string' } } });
  assert.equal(s.additionalProperties, false);
});

test('every property is listed as required', () => {
  const s = toStrictSchema({
    type: 'object',
    properties: { answer: { type: 'string' }, confidence: { type: 'number' }, refuse: { type: 'boolean' } },
    required: ['answer'],
  });
  assert.deepEqual([...s.required].sort(), ['answer', 'confidence', 'refuse']);
});

test('a property that was optional stays optional in MEANING, by accepting null', () => {
  // Strict mode has no way to say "may be absent", so optionality moves into the type. Without this
  // the transform would silently make previously-optional fields mandatory to produce.
  const s = toStrictSchema({
    type: 'object',
    properties: { answer: { type: 'string' }, note: { type: 'string' } },
    required: ['answer'],
  });
  assert.deepEqual(s.properties.note.type, ['string', 'null']);
  assert.equal(s.properties.answer.type, 'string', 'an already-required field is not made nullable');
});

test('nested objects and arrays of objects are fixed too', () => {
  const s = toStrictSchema({
    type: 'object',
    properties: {
      steps: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string' } } } },
      meta: { type: 'object', properties: { ok: { type: 'boolean' } } },
    },
  });
  assert.equal(s.properties.steps.items.additionalProperties, false);
  assert.deepEqual(s.properties.steps.items.required, ['tool']);
  assert.equal(s.properties.meta.additionalProperties, false);
});

test('an object without an explicit type is still recognised', () => {
  // Plenty of hand-written schemas omit `type: object` and just carry `properties`.
  const s = toStrictSchema({ properties: { a: { type: 'string' } } });
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, ['a']);
});

test('THE ORIGINAL IS NEVER MUTATED', () => {
  // Schemas are shared across providers. Mutating in place would push OpenAI's rules into Claude's
  // and Ollama's requests, which is how one provider's quirk becomes everybody's bug.
  const original = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a'] };
  const copy = JSON.parse(JSON.stringify(original));
  toStrictSchema(original);
  assert.deepEqual(original, copy, 'toStrictSchema must be pure');
});

test('non-object nodes pass through untouched', () => {
  assert.equal(toStrictSchema('string'), 'string');
  assert.equal(toStrictSchema(7), 7);
  assert.equal(toStrictSchema(null), null);
  assert.deepEqual(toStrictSchema([{ type: 'string' }]), [{ type: 'string' }]);
});

test('a scalar property is not given additionalProperties', () => {
  const s = toStrictSchema({ type: 'object', properties: { n: { type: 'number' } } });
  assert.equal(s.properties.n.additionalProperties, undefined);
});
