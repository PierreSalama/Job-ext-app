// AI provider chain — order resolution + attempt building across the new
// multi-provider shape (Claude / ChatGPT / local), incl. legacy bridging.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const provider = require(path.join(here, '..', 'app', 'src', 'ai', 'provider.js'));
const hardware = require(path.join(here, '..', 'app', 'src', 'hardware.js'));
const anthropic = require(path.join(here, '..', 'app', 'src', 'ai', 'anthropic.js'));
const openai = require(path.join(here, '..', 'app', 'src', 'ai', 'openai.js'));

const names = (atts) => atts.map((a) => a.name);

test('resolveOrder: array passes through, legacy strings map', () => {
  assert.deepEqual(provider.resolveOrder(['claude', 'chatgpt', 'local']), ['claude', 'chatgpt', 'local']);
  assert.deepEqual(provider.resolveOrder('cloud-first'), ['chatgpt', 'local']);
  assert.deepEqual(provider.resolveOrder('local-first'), ['local', 'chatgpt']);
  assert.deepEqual(provider.resolveOrder('cloud-only'), ['chatgpt']);
  // unknown keys are dropped, empty falls back to the full default
  assert.deepEqual(provider.resolveOrder([]), ['claude', 'chatgpt', 'local']);
  assert.deepEqual(provider.resolveOrder(['ollama', 'codex']), ['local', 'chatgpt']);
});

test('buildAttempts: full config yields claude-cli → claude → codex → openai → ollama', () => {
  // useSubscription defaults ON for both cloud providers, so each yields its CLI-subscription
  // attempt FIRST (claude-cli / codex), then its API-key attempt (claude / openai) as fallback.
  const s = {
    order: ['claude', 'chatgpt', 'local'],
    claude: { useSubscription: true, apiKey: 'k', model: 'claude-sonnet-4-6' },
    chatgpt: { useSubscription: true, apiKey: 'k2', model: 'gpt-5.4' },
    local: { autoPick: true },
  };
  assert.deepEqual(names(provider.buildAttempts(s, {})), ['claude-cli', 'claude', 'codex', 'openai', 'ollama']);
});

test('buildAttempts: unconfigured providers are skipped', () => {
  const base = { order: ['claude', 'chatgpt', 'local'], local: { autoPick: true } };
  // claude subscription OFF + no key → claude skipped entirely; chatgpt subscription ON → codex.
  assert.deepEqual(names(provider.buildAttempts({ ...base, claude: { useSubscription: false }, chatgpt: { useSubscription: true } }, {})), ['codex', 'ollama']);
  // claude API key only (subscription OFF) → anthropic 'claude'; chatgpt subscription OFF + no key → skipped.
  assert.deepEqual(names(provider.buildAttempts({ ...base, claude: { useSubscription: false, apiKey: 'k' }, chatgpt: { useSubscription: false } }, {})), ['claude', 'ollama']);
  // an EMPTY claude config still attempts the CLI subscription (default ON) — this is the live
  // 401 source the chatgpt-first default order works around.
  assert.deepEqual(names(provider.buildAttempts({ ...base, claude: {}, chatgpt: { useSubscription: false } }, {})), ['claude-cli', 'ollama']);
});

test('buildAttempts: legacy ai.cloud OpenAI key survives the bridge (backward compat)', () => {
  // Simulates a merged old install: ai.chatgpt is the empty default, ai.cloud holds the real key.
  const s = {
    order: ['chatgpt', 'local'],
    chatgpt: { useSubscription: true, apiKey: '', model: 'gpt-5.4' },   // deepMerge default
    cloud: { apiKey: 'sk-old', model: 'gpt-4o' },                       // legacy stored value
    local: {},
  };
  const atts = provider.buildAttempts(s, {});
  assert.ok(names(atts).includes('openai'), 'legacy OpenAI key must still produce an openai attempt');
});

test('buildAttempts: providerOverride restricts to one provider', () => {
  const s = { order: ['claude', 'chatgpt', 'local'], claude: { useSubscription: true, apiKey: 'k' }, chatgpt: { useSubscription: true }, local: {} };
  // override to claude → only claude's attempts (CLI subscription first, then the API key).
  assert.deepEqual(names(provider.buildAttempts(s, { providerOverride: 'claude' })), ['claude-cli', 'claude']);
  assert.deepEqual(names(provider.buildAttempts(s, { providerOverride: 'local' })), ['ollama']);
});

test('buildAttempts: local model auto-picks for hardware, prose uses prose model', () => {
  const s = { order: ['local'], local: { autoPick: true } };
  const structured = provider.buildAttempts(s, { prose: false })[0];
  const prose = provider.buildAttempts(s, { prose: true })[0];
  assert.ok(structured.model && prose.model, 'both resolve a model');
  // an explicit override wins over the recommendation
  const overridden = provider.buildAttempts({ order: ['local'], local: { structuredModel: 'mymodel:7b' } }, {})[0];
  assert.equal(overridden.model, 'mymodel:7b');
});

test('hardware.probe returns a usable recommendation', () => {
  const h = hardware.probe();
  assert.ok(h.ramGb > 0, 'detects RAM');
  assert.ok(h.recommend.structured && h.recommend.prose, 'recommends models');
  assert.ok(typeof h.recommend.approxGb === 'number');
});

test('API providers report unavailable without a key (no network call)', async () => {
  assert.equal((await anthropic.status({})).available, false);
  assert.equal((await openai.status({})).available, false);
  assert.equal((await anthropic.status({ apiKey: 'x' })).available, true);
  await assert.rejects(() => anthropic.generate({ prompt: 'hi', cfg: {} }), /no Anthropic API key/);
  await assert.rejects(() => openai.generate({ prompt: 'hi', cfg: {} }), /no OpenAI API key/);
});
