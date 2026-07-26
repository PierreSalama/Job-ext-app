// Local AI (Ollama) is STRICTLY OPT-IN (ai.local.enabled, default false). Contract:
//   1. defaults ship enabled:false, trySpawn:false, autoSetup:false — a fresh install
//      can never spawn `ollama serve` or download Ollama
//   2. statusAll() with local off reports one clear reason WITHOUT touching ollama.status
//      (which pings the port and can spawn)
//   3. buildAttempts: local off → ollama.generate is never attempted, even when 'local'
//      is in the provider order
//   4. local on → ollama is back in the chain (the opt-in actually works)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const provider = require(path.join(here, '..', 'app', 'src', 'ai', 'provider.js'));
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));
const ollama = require(path.join(here, '..', 'app', 'src', 'ai', 'ollama.js'));
const codex = require(path.join(here, '..', 'app', 'src', 'ai', 'codex.js'));
const claudeCli = require(path.join(here, '..', 'app', 'src', 'ai', 'claude.js'));
const anthropic = require(path.join(here, '..', 'app', 'src', 'ai', 'anthropic.js'));
const openai = require(path.join(here, '..', 'app', 'src', 'ai', 'openai.js'));
const { DEFAULTS } = require(path.join(here, '..', 'app', 'src', 'config.js'));

const origGetSettings = db.getSettings;
const origAiLog = db.aiLog;
function withAi(ai, fn) {
  db.getSettings = () => ({ ai });
  db.aiLog = () => {};
  return Promise.resolve()
    .then(fn)
    .finally(() => { db.getSettings = origGetSettings; db.aiLog = origAiLog; });
}

test('defaults: local AI ships fully opt-in (enabled/trySpawn/autoSetup all false)', () => {
  assert.equal(DEFAULTS.ai.local.enabled, false);
  assert.equal(DEFAULTS.ai.local.trySpawn, false);
  assert.equal(DEFAULTS.ai.local.autoSetup, false);
});

test('statusAll() with local off never calls ollama.status and reports the off reason', () =>
  withAi({ disabled: false, order: ['local'], local: { enabled: false }, claude: {}, chatgpt: {} }, async () => {
    let ollamaProbed = false;
    const oSt = ollama.status, cxSt = codex.status, clSt = claudeCli.status, anSt = anthropic.status, opSt = openai.status;
    ollama.status = async () => { ollamaProbed = true; return { available: true }; };
    // quiet the cloud probes too — this test is about ollama only
    codex.status = async () => ({ available: false, reason: 'stub' });
    claudeCli.status = async () => ({ available: false, reason: 'stub' });
    anthropic.status = async () => ({ available: false, reason: 'stub' });
    openai.status = async () => ({ available: false, reason: 'stub' });
    try {
      const st = await provider.statusAll(true);
      assert.equal(ollamaProbed, false, 'ollama.status must NOT be called when local is off');
      assert.equal(st.local.available, false);
      assert.match(st.local.reason, /turned off/i);
    } finally {
      ollama.status = oSt; codex.status = cxSt; claudeCli.status = clSt; anthropic.status = anSt; openai.status = opSt;
    }
  }));

test('run() with only local in the order and local off never attempts ollama', () =>
  withAi({ disabled: false, order: ['local'], local: { enabled: false }, claude: { useSubscription: false }, chatgpt: { useSubscription: false } }, async () => {
    let generated = false;
    const oGen = ollama.generate;
    ollama.generate = async () => { generated = true; return { text: 'nope' }; };
    try {
      await assert.rejects(
        provider.run({ kind: 'cover-letter', prompt: 'write one' }),
        (e) => e.code === 'NO_PROVIDER' || e.code === 'AI_SETTING_UP',
      );
      assert.equal(generated, false, 'ollama.generate must NOT be attempted when local is off');
    } finally { ollama.generate = oGen; }
  }));

test('run() with local enabled puts ollama back in the chain', () =>
  withAi({ disabled: false, order: ['local'], local: { enabled: true, structuredModel: 'm', proseModel: 'm', autoPick: false }, claude: { useSubscription: false }, chatgpt: { useSubscription: false } }, async () => {
    const oGen = ollama.generate;
    ollama.generate = async () => ({ text: 'local says hi', json: null });
    try {
      const out = await provider.run({ kind: 'cover-letter', prompt: 'write one' });
      assert.equal(out.text, 'local says hi');
      assert.equal(out.provider, 'ollama');
    } finally { ollama.generate = oGen; }
  }));
