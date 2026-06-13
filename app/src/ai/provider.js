// JAT v11 — AI provider chain.
// One entry point: run({ kind, prompt, system, schema, prose }) → result.
// Chain per settings.ai.order:
//   cloud-first : codex → ollama
//   local-first : ollama → codex
//   cloud-only / local-only : single provider
// Every call is logged to ai_log (provider, model, ms, ok) for the usage meter.

const codex = require('./codex');
const ollama = require('./ollama');
const db = require('../db');
const { scope } = require('../logger');

const log = scope('ai');

function chainFor(order) {
  switch (order) {
    case 'local-first': return ['ollama', 'codex'];
    case 'cloud-only': return ['codex'];
    case 'local-only': return ['ollama'];
    case 'cloud-first':
    default: return ['codex', 'ollama'];
  }
}

let lastStatus = { codex: null, ollama: null, checkedAt: 0, valid: false };

async function statusAll(force = false) {
  const s = db.getSettings().ai;
  // Only serve the cache after a complete fresh probe (valid=true). A failure
  // object written directly by run()'s catch (e.g. CODEX_AUTH) sets valid=false
  // so the next status call re-probes instead of serving the stale failure.
  if (!force && lastStatus.valid && Date.now() - lastStatus.checkedAt < 30000) return lastStatus;
  const [cx, ol] = await Promise.all([
    codex.status().catch((e) => ({ available: false, reason: e.message })),
    ollama.status(s.local).catch((e) => ({ available: false, reason: e.message })),
  ]);
  lastStatus = { codex: cx, ollama: ol, order: s.order, checkedAt: Date.now(), valid: true };
  return lastStatus;
}

// kind: short label for the log ('fit-score', 'cover-letter', …)
// prose: true → use the local prose model instead of the structured model
async function run({ kind, prompt, system, schema, prose = false, modelOverride = null, providerOverride = null }) {
  const s = db.getSettings().ai;
  const chain = providerOverride ? [providerOverride] : chainFor(s.order);
  const errors = [];

  for (const name of chain) {
    const started = Date.now();
    // Resolve the model up front so the error path can log the real model too.
    const model = name === 'codex'
      ? (modelOverride || s.cloud.model)
      : (modelOverride || (prose ? s.local.proseModel : s.local.structuredModel));
    try {
      const result = name === 'codex'
        ? await codex.generate({ prompt, system, schema, model, timeoutMs: s.cloud.timeoutMs })
        : await ollama.generate({ prompt, system, schema, model, timeoutMs: s.local.timeoutMs, cfg: s.local });
      db.aiLog({
        provider: name, model, kind, ms: Date.now() - started, ok: true,
        promptChars: prompt.length, responseChars: result.text.length,
      });
      return { ...result, provider: name, model };
    } catch (e) {
      db.aiLog({
        provider: name, model, kind, ms: Date.now() - started,
        ok: false, error: String(e.message || e).slice(0, 300), promptChars: prompt.length,
      });
      log.warn(`${name} failed for ${kind}:`, e.code || '', e.message);
      errors.push({ provider: name, code: e.code, message: e.message });
      // Auth failures shouldn't silently fall through forever — surface them in
      // status so the UI can show "run codex login". Invalidate the cache so the
      // next status call re-probes once the user fixes it.
      if (e.code === 'CODEX_AUTH') {
        lastStatus.codex = { available: false, needsLogin: true, reason: e.message };
        lastStatus.valid = false;
      }
    }
  }
  const err = new Error('All AI providers failed: ' +
    errors.map((e) => `${e.provider}(${e.code || 'ERR'})`).join(', '));
  err.details = errors;
  throw err;
}

module.exports = { run, statusAll, chainFor };
