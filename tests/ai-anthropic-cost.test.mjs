// Anthropic API cost controls (2026-10-08): JAT moves onto Pierre's API credits with Haiku only,
// low effort. These pin the request body the provider sends and the strict-model routing, without
// touching the network (global fetch is stubbed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const anthropic = require(path.join(here, '..', 'app', 'src', 'ai', 'anthropic.js'));
const provider = require(path.join(here, '..', 'app', 'src', 'ai', 'provider.js'));

function stubFetch(reply) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => reply, text: async () => JSON.stringify(reply) };
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test('costControls: low effort + thinking disabled map to the Messages API fields', () => {
  assert.deepEqual(anthropic.costControls({ effort: 'low', thinking: 'disabled' }),
    { output_config: { effort: 'low' }, thinking: { type: 'disabled' } });
  assert.deepEqual(anthropic.costControls({ effort: 'LOW ' }), { output_config: { effort: 'low' } });
});

test('costControls: unset or junk values send nothing (old behaviour preserved)', () => {
  assert.deepEqual(anthropic.costControls({}), {});
  assert.deepEqual(anthropic.costControls({ effort: 'cheap', thinking: 'maybe' }), {});
  assert.deepEqual(anthropic.costControls(null), {});
});

test('costControls: a schema call (forced tool_choice) always disables thinking', () => {
  assert.deepEqual(anthropic.costControls({}, { schema: { type: 'object' } }), { thinking: { type: 'disabled' } });
});

test('generate: Haiku + low effort body, usage returned, key only in the header', async () => {
  const f = stubFetch({ content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 12, output_tokens: 3 } });
  try {
    const cfg = { apiKey: 'test-key', model: 'claude-haiku-5-5', effort: 'low', thinking: 'disabled' };
    const r = await anthropic.generate({ prompt: 'hi', model: 'claude-haiku-5-5', cfg });
    assert.equal(r.text, 'hello');
    assert.deepEqual(r.usage, { input_tokens: 12, output_tokens: 3 });
    const { body, init } = f.calls[0];
    assert.equal(body.model, 'claude-haiku-5-5');
    assert.deepEqual(body.output_config, { effort: 'low' });
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(init.headers['x-api-key'], 'test-key');
    assert.ok(!JSON.stringify(body).includes('test-key'));
  } finally { f.restore(); }
});

test('generate: schema call forces the tool and disables thinking', async () => {
  const f = stubFetch({ content: [{ type: 'tool_use', name: 'emit_result', input: { answer: 'yes' } }], usage: { input_tokens: 5, output_tokens: 2 } });
  try {
    const r = await anthropic.generate({ prompt: 'q', schema: { type: 'object' }, cfg: { apiKey: 'k', model: 'claude-haiku-5-5', effort: 'low' } });
    assert.deepEqual(r.json, { answer: 'yes' });
    assert.deepEqual(f.calls[0].body.tool_choice, { type: 'tool', name: 'emit_result' });
    assert.deepEqual(f.calls[0].body.thinking, { type: 'disabled' });
  } finally { f.restore(); }
});

test('status advertises what this build supports (ai-switch.ps1 gates the flip on it)', async () => {
  for (const cfg of [{}, { apiKey: 'k', effort: 'low' }]) {
    const st = await anthropic.status(cfg);
    for (const cap of ['effort', 'thinking', 'strictModel']) assert.ok(st.supports.includes(cap), cap);
  }
});

test('strictModel: the API attempt ignores a per-call model override', () => {
  const s = { order: ['claude'], claude: { useSubscription: false, apiKey: 'k', model: 'claude-haiku-5-5', strictModel: true }, chatgpt: { useSubscription: false }, local: { enabled: false } };
  const a = provider.buildAttempts(s, { modelOverride: 'sonnet' });
  assert.deepEqual(a.map((x) => [x.name, x.model]), [['claude', 'claude-haiku-5-5']]);
});

test('strictModel off: the override still wins (existing behaviour)', () => {
  const s = { order: ['claude'], claude: { useSubscription: false, apiKey: 'k', model: 'claude-haiku-5-5' }, chatgpt: { useSubscription: false }, local: { enabled: false } };
  const a = provider.buildAttempts(s, { modelOverride: 'claude-sonnet-4-6' });
  assert.equal(a[0].model, 'claude-sonnet-4-6');
});
