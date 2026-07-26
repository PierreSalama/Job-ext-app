// AI master switch (ai.disabled) — the Dad's-laptop mode. Contract:
//   1. run() throws ONE clean AI_DISABLED error — no provider attempt, no child process
//   2. the deterministic no-model floor still answers grounded questions (it's rules, not AI)
//   3. statusAll() returns the disabled shape WITHOUT probing any provider (probes spawn
//      codex/claude/ollama child processes — the trial's crash source)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const provider = require(path.join(here, '..', 'app', 'src', 'ai', 'provider.js'));
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));
const codex = require(path.join(here, '..', 'app', 'src', 'ai', 'codex.js'));
const claudeCli = require(path.join(here, '..', 'app', 'src', 'ai', 'claude.js'));
const ollama = require(path.join(here, '..', 'app', 'src', 'ai', 'ollama.js'));
const deterministic = require(path.join(here, '..', 'app', 'src', 'ai', 'deterministic.js'));

// Stub the settings source + the log sink (shared require cache = provider sees these).
const origGetSettings = db.getSettings;
const origAiLog = db.aiLog;
function withDisabled(fn) {
  db.getSettings = () => ({ ai: { disabled: true, order: ['chatgpt', 'claude', 'local'], local: {} } });
  db.aiLog = () => {};
  return Promise.resolve()
    .then(fn)
    .finally(() => { db.getSettings = origGetSettings; db.aiLog = origAiLog; });
}

test('run() with ai.disabled throws the one clean AI_DISABLED error', () =>
  withDisabled(async () => {
    await assert.rejects(
      provider.run({ kind: 'cover-letter', prompt: 'write one' }),
      (e) => e.code === 'AI_DISABLED' && /turned off on this computer/.test(e.message),
    );
  }));

test('run() with ai.disabled still serves the deterministic no-model floor', () =>
  withDisabled(async () => {
    const origAnswer = deterministic.answer;
    deterministic.answer = () => ({ answer: 'Toronto', confidence: 0.9 });
    try {
      const r = await provider.run({
        kind: 'answer-question', prompt: 'q',
        deterministic: { question: 'What city do you live in?', profile: {} },
      });
      assert.equal(r.provider, 'deterministic');
      assert.equal(r.json.answer, 'Toronto');
    } finally { deterministic.answer = origAnswer; }
  }));

test('statusAll() with ai.disabled returns the off shape and NEVER probes a provider', () =>
  withDisabled(async () => {
    let probed = 0;
    const origs = [codex.status, claudeCli.status, ollama.status];
    codex.status = claudeCli.status = () => { probed++; return Promise.resolve({ available: true }); };
    ollama.status = () => { probed++; return Promise.resolve({ available: true }); };
    try {
      const st = await provider.statusAll(true);
      assert.equal(st.disabled, true);
      assert.equal(st.claude.available, false);
      assert.equal(st.chatgpt.available, false);
      assert.equal(st.local.available, false);
      assert.deepEqual(st.order, []);
      assert.match(st.local.reason, /turned off on this computer/);
      assert.equal(probed, 0); // the whole point: zero child-process probes
    } finally { [codex.status, claudeCli.status, ollama.status] = origs; }
  }));

test('run() with ai ENABLED still builds attempts (the switch defaults open)', async () => {
  // sanity guard: buildAttempts is pure — an enabled config still yields attempts.
  const atts = provider.buildAttempts(
    { order: ['chatgpt'], chatgpt: { useSubscription: true }, local: {} }, {},
  );
  assert.ok(atts.length >= 1);
});
