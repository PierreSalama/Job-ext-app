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
    local: { enabled: true, autoPick: true },
  };
  assert.deepEqual(names(provider.buildAttempts(s, {})), ['claude-cli', 'claude', 'codex', 'openai', 'ollama']);
});

test('buildAttempts: unconfigured providers are skipped', () => {
  const base = { order: ['claude', 'chatgpt', 'local'], local: { enabled: true, autoPick: true } };
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
  const s = { order: ['claude', 'chatgpt', 'local'], claude: { useSubscription: true, apiKey: 'k' }, chatgpt: { useSubscription: true }, local: { enabled: true } };
  // override to claude → only claude's attempts (CLI subscription first, then the API key).
  assert.deepEqual(names(provider.buildAttempts(s, { providerOverride: 'claude' })), ['claude-cli', 'claude']);
  assert.deepEqual(names(provider.buildAttempts(s, { providerOverride: 'local' })), ['ollama']);
});

test('buildAttempts: local model auto-picks for hardware, prose uses prose model', () => {
  const s = { order: ['local'], local: { enabled: true, autoPick: true } };
  const structured = provider.buildAttempts(s, { prose: false })[0];
  const prose = provider.buildAttempts(s, { prose: true })[0];
  assert.ok(structured.model && prose.model, 'both resolve a model');
  // an explicit override wins over the recommendation
  const overridden = provider.buildAttempts({ order: ['local'], local: { enabled: true, structuredModel: 'mymodel:7b' } }, {})[0];
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

// ---------------------------------------------------------------------------
// THE UNREACHABLE PEER
//
// Measured on the applier laptop 2026-09-05, in its own ai log: of the last 50 calls, 16 were
// 'remote' failing with "cannot reach the peer", each taking 10.8 to 13.8 seconds, then codex
// failing instantly on quota, then claude-cli answering in about 7. The peer is Pierre's PC and
// the app there was not running. Two thirds of every agent step was spent waiting on it.
//
// Nothing was broken in the sense of throwing: the chain fell through and the call was served.
// That is exactly why nobody noticed. It only shows up as a number.
// ---------------------------------------------------------------------------
const REMOTE_ON = {
  order: ['remote', 'chatgpt', 'claude', 'local'],
  remote: { enabled: true, url: 'http://100.78.234.94:7744' },
  claude: { useSubscription: true },
  chatgpt: { useSubscription: true },
  local: { enabled: false },
};

test('a peer that could not be REACHED leaves the chain for a cooldown', () => {
  provider._clearOutcomes();
  assert.deepEqual(names(provider.buildAttempts(REMOTE_ON, {})), ['remote', 'codex', 'claude-cli'],
    'baseline: the peer leads the chain');

  provider.noteOutcome('remote', false, { code: 'REMOTE_NET', message: 'cannot reach the peer' });
  assert.deepEqual(names(provider.buildAttempts(REMOTE_ON, {})), ['codex', 'claude-cli'],
    'after one unreachable call the peer is skipped, and nothing else changes');
});

test('a peer that ANSWERED, even with an error, stays in the chain', () => {
  // The distinction is the whole point. A peer that replied is alive, and quietly dropping it
  // would hide a token or version problem worth seeing.
  for (const code of ['REMOTE_HTTP', 'REMOTE_AUTH', 'REMOTE_BADJSON', 'REMOTE_ERR']) {
    provider._clearOutcomes();
    provider.noteOutcome('remote', false, { code, message: code });
    assert.equal(names(provider.buildAttempts(REMOTE_ON, {}))[0], 'remote', `${code} must not trip the breaker`);
  }
});

test('a peer that worked is not penalised', () => {
  provider._clearOutcomes();
  provider.noteOutcome('remote', true);
  assert.equal(names(provider.buildAttempts(REMOTE_ON, {}))[0], 'remote');
});

test('the cooldown lapses, and the peer gets another real chance', () => {
  provider._clearOutcomes();
  provider.noteOutcome('remote', false, { code: 'REMOTE_NET', message: 'cannot reach the peer' });
  assert.equal(provider.remoteCoolingDown(), true, 'cooling down right now');
  assert.equal(provider.remoteCoolingDown(Date.now() + provider.REMOTE_COOLDOWN_MS - 1000), true,
    'still cooling down just inside the window');
  assert.equal(provider.remoteCoolingDown(Date.now() + provider.REMOTE_COOLDOWN_MS + 1000), false,
    'past the window the peer is tried again, and one real call decides');
});

test('the breaker never empties the chain', () => {
  // A thin client whose only provider IS the peer must still call it. Failing instantly with no
  // attempt at all is worse than waiting for a timeout.
  provider._clearOutcomes();
  const only = {
    order: ['remote'],
    remote: { enabled: true, url: 'http://100.78.234.94:7744' },
    claude: { useSubscription: false },
    chatgpt: { useSubscription: false },
    local: { enabled: false },
  };
  assert.deepEqual(names(provider.buildAttempts(only, {})), ['remote']);
  provider.noteOutcome('remote', false, { code: 'REMOTE_NET', message: 'cannot reach the peer' });
  assert.equal(provider.remoteCoolingDown(), true, 'the breaker is tripped');
  assert.deepEqual(names(provider.buildAttempts(only, {})), ['remote'],
    'and it is still attempted, because there is nothing else');
  provider._clearOutcomes();
});
