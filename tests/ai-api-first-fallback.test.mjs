// API key PRIMARY, subscription CLI FALLBACK (Pierre, 2026-10-09). With claude.apiFirst the API
// attempt leads, and whenever it fails (auth, 429, out of credit, network) the SAME call is
// answered by claude-cli. No network, no CLI spawn: fetch, the CLI module and the db are stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'app', 'src');
const provider = require(path.join(src, 'ai', 'provider.js'));
const claudeCli = require(path.join(src, 'ai', 'claude.js'));
const db = require(path.join(src, 'db.js'));

const names = (a) => a.map((x) => x.name);
const API_FIRST = {
  order: ['claude', 'chatgpt', 'local'],
  claude: { useSubscription: true, apiFirst: true, apiKey: 'test-key', model: 'claude-haiku-5-5', strictModel: true, effort: 'low', thinking: 'disabled' },
  chatgpt: { useSubscription: true },
  local: { enabled: false },
};

test('apiFirst: claude (API) leads, claude-cli (subscription) is next, the rest after', () => {
  assert.deepEqual(names(provider.buildAttempts(API_FIRST, {})), ['claude', 'claude-cli', 'codex']);
});

test('apiFirst off or unset: the old CLI-first order is unchanged', () => {
  const s = { ...API_FIRST, claude: { ...API_FIRST.claude, apiFirst: false } };
  assert.deepEqual(names(provider.buildAttempts(s, {})), ['claude-cli', 'claude', 'codex']);
  const u = { ...API_FIRST, claude: { useSubscription: true, apiKey: 'k' } };
  assert.deepEqual(names(provider.buildAttempts(u, {})), ['claude-cli', 'claude', 'codex']);
});

test('apiFirst without a key: only the subscription CLI is in the chain', () => {
  const s = { ...API_FIRST, claude: { ...API_FIRST.claude, apiKey: '' } };
  assert.deepEqual(names(provider.buildAttempts(s, {})), ['claude-cli', 'codex']);
});

// Drive the real run() with a failing API and a working CLI.
async function runWith(fetchImpl) {
  const orig = { fetch: globalThis.fetch, gs: db.getSettings, log: db.aiLog, cli: claudeCli.generate };
  const logged = [];
  const cliCalls = [];
  globalThis.fetch = fetchImpl;
  db.getSettings = () => ({ ai: { ...API_FIRST, order: ['claude'] } });
  db.aiLog = (e) => { logged.push(e); };
  claudeCli.generate = async (a) => { cliCalls.push(a); return { text: 'from-subscription', json: null }; };
  provider._clearOutcomes();
  try {
    const r = await provider.run({ kind: 'test', prompt: 'hi' });
    return { r, logged, cliCalls };
  } finally {
    globalThis.fetch = orig.fetch; db.getSettings = orig.gs; db.aiLog = orig.log; claudeCli.generate = orig.cli;
    provider._clearOutcomes();
  }
}
const httpErr = (status, body) => async () => ({ ok: false, status, text: async () => body, json: async () => JSON.parse(body) });

for (const [label, impl, code] of [
  ['auth failure (401)', httpErr(401, '{"type":"error","error":{"type":"authentication_error"}}'), 'ANTHROPIC_AUTH'],
  ['rate limit (429)', httpErr(429, '{"type":"error","error":{"type":"rate_limit_error"}}'), 'ANTHROPIC_RATE'],
  ['out of credit (400)', httpErr(400, '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'), 'ANTHROPIC_CREDIT'],
  ['overloaded (529)', httpErr(529, '{"type":"error","error":{"type":"overloaded_error"}}'), 'ANTHROPIC_HTTP'],
  ['network error', async () => { throw new Error('ECONNRESET'); }, 'ANTHROPIC_NET'],
]) {
  test(`apiFirst: ${label} on the API falls back to claude-cli on the same call`, async () => {
    const { r, logged, cliCalls } = await runWith(impl);
    assert.equal(r.provider, 'claude-cli');
    assert.equal(r.text, 'from-subscription');
    assert.equal(cliCalls.length, 1);
    assert.deepEqual(logged.map((e) => [e.provider, e.ok]), [['claude', false], ['claude-cli', true]]);
    assert.match(logged[0].error, /Anthropic/);
    const st = provider.HARD_FAIL;
    if (code === 'ANTHROPIC_CREDIT' || code === 'ANTHROPIC_AUTH') assert.ok(st.has(code), `${code} is a hard failure`);
    else assert.ok(!st.has(code), `${code} is transient`);
  });
}

test('apiFirst: a working API answers and the subscription CLI is never spawned', async () => {
  const ok = async (url, init) => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'from-api' }], usage: { input_tokens: 3, output_tokens: 2 } }) });
  const { r, logged, cliCalls } = await runWith(ok);
  assert.equal(r.provider, 'claude');
  assert.equal(r.model, 'claude-haiku-5-5');
  assert.equal(cliCalls.length, 0);
  assert.deepEqual(logged.map((e) => [e.provider, e.ok]), [['claude', true]]);
});

test('the failure codes are the named ones (so ai_log says why it fell back)', async () => {
  const anthropic = require(path.join(src, 'ai', 'anthropic.js'));
  const cfg = { apiKey: 'k', model: 'claude-haiku-5-5' };
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = httpErr(429, 'slow down');
    await assert.rejects(anthropic.generate({ prompt: 'x', cfg }), { code: 'ANTHROPIC_RATE' });
    globalThis.fetch = httpErr(400, '{"error":{"message":"Your credit balance is too low"}}');
    await assert.rejects(anthropic.generate({ prompt: 'x', cfg }), { code: 'ANTHROPIC_CREDIT' });
    globalThis.fetch = httpErr(400, '{"error":{"message":"max_tokens too large"}}');
    await assert.rejects(anthropic.generate({ prompt: 'x', cfg }), { code: 'ANTHROPIC_HTTP' });
  } finally { globalThis.fetch = orig; }
  assert.ok(anthropic.SUPPORTS.includes('apiFirst'));
});
