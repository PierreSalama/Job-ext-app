// JAT v11 — AI provider chain.
// One entry point: run({ kind, prompt, system, schema, prose }) → result.
//
// Priority comes from settings.ai.order (an array, e.g. ['claude','chatgpt',
// 'local']); the first provider that's actually configured + working wins.
//   claude  → Anthropic API key (Claude Sonnet 4.6)
//   chatgpt → ChatGPT subscription via Codex CLI, then OpenAI API key
//   local   → Ollama (model auto-picked for the machine unless overridden)
// Every attempt is logged to ai_log for the usage meter. Old single-string
// orders ('cloud-first' etc.) and the old ai.cloud shape still work.

const codex = require('./codex');
const claudeCli = require('./claude');
const ollama = require('./ollama');
const anthropic = require('./anthropic');
const openai = require('./openai');
const deterministic = require('./deterministic');
const db = require('../db');
const { scope } = require('../logger');

const log = scope('ai');

const KNOWN = ['claude', 'chatgpt', 'local', 'ollama', 'codex'];
function resolveOrder(order) {
  if (Array.isArray(order)) {
    const out = order.map((k) => (k === 'ollama' ? 'local' : k === 'codex' ? 'chatgpt' : k)).filter((k) => KNOWN.includes(k));
    return out.length ? out : ['claude', 'chatgpt', 'local'];
  }
  switch (order) {            // legacy string orders
    case 'local-first': return ['local', 'chatgpt'];
    case 'cloud-only': return ['chatgpt'];
    case 'local-only': return ['local'];
    case 'cloud-first':
    default: return ['chatgpt', 'local'];
  }
}

// Bridge the new ai.chatgpt config over the legacy ai.cloud one FIELD-BY-FIELD:
// deepMerge always fills ai.chatgpt with full defaults (apiKey:'', model:
// 'gpt-5.4'), so a naive {...cloud, ...chatgpt} spread would clobber a real
// legacy OpenAI key/model with the empty defaults. Fall back to ai.cloud only
// where the new field is empty.
function bridgeChatgpt(s) {
  const cg = s.chatgpt || {}, old = s.cloud || {};
  return {
    useSubscription: cg.useSubscription,
    apiKey: cg.apiKey || old.apiKey || '',
    model: cg.model || old.model || 'gpt-5.4',
    timeoutMs: cg.timeoutMs || old.timeoutMs,
  };
}

let hwCache = null;
function localRecommend() {
  if (!hwCache) {
    try { hwCache = require('../hardware').probe(); }
    catch { hwCache = { recommend: { structured: 'qwen2.5:3b', prose: 'llama3.2:3b' } }; }
  }
  return hwCache.recommend;
}
function clearHwCache() { hwCache = null; }

// Build the ordered list of concrete attempts for this call.
function buildAttempts(s, { prose, modelOverride, providerOverride }) {
  const order = providerOverride ? resolveOrder([providerOverride]) : resolveOrder(s.order);
  const attempts = [];
  for (const key of order) {
    if (key === 'claude') {
      const cfg = s.claude || {};
      // SUBSCRIPTION via the official Claude CLI (subprocess) FIRST — identical secure pattern to
      // chatgpt→codex: the CLI owns its own credentials + refresh in ~/.claude; we never read,
      // store, or hardcode the token. Default ON; flip cfg.useSubscription=false to use only the key.
      if (cfg.useSubscription !== false) {
        const model = modelOverride || cfg.cliModel || null;   // null → CLI's own default model
        attempts.push({ name: 'claude-cli', model: model || 'cli-default', run: (a) => claudeCli.generate({ ...a, model, timeoutMs: cfg.timeoutMs }) });
      }
      // API-key fallback (Anthropic direct) when a key is set.
      if (cfg.apiKey) {
        const model = modelOverride || cfg.model || 'claude-sonnet-4-6';
        attempts.push({ name: 'claude', model, run: (a) => anthropic.generate({ ...a, model, cfg }) });
      }
    } else if (key === 'chatgpt') {
      const cfg = bridgeChatgpt(s);
      const model = modelOverride || cfg.model || 'gpt-5.4';
      if (cfg.useSubscription !== false) {
        attempts.push({ name: 'codex', model, run: (a) => codex.generate({ ...a, model, timeoutMs: cfg.timeoutMs }) });
      }
      if (cfg.apiKey) {
        attempts.push({ name: 'openai', model, run: (a) => openai.generate({ ...a, model, cfg }) });
      }
    } else if (key === 'local') {
      const cfg = s.local || {};
      if (!cfg.enabled) continue;   // local AI is opt-in: off → never in the chain, no spawn path exists
      const rec = (cfg.autoPick !== false) ? localRecommend() : { structured: cfg.structuredModel, prose: cfg.proseModel };
      const model = modelOverride || (prose ? (cfg.proseModel || rec.prose) : (cfg.structuredModel || rec.structured));
      attempts.push({ name: 'ollama', model, run: (a) => ollama.generate({ ...a, model, timeoutMs: cfg.timeoutMs, cfg }) });
    }
  }
  return attempts;
}

let lastStatus = { checkedAt: 0, valid: false };

// The disabled shape: everything unavailable with ONE consistent human reason. No probe,
// no spawn — codex/claude-cli/ollama status checks all launch child processes, and on a
// machine with none of them installed those probes are pure noise (and were Dad's crash source).
const AI_OFF_MSG = 'AI features are turned off on this computer.';
function disabledStatus() {
  const off = { available: false, reason: AI_OFF_MSG };
  return {
    disabled: true,
    claude: { available: false, subscription: off, apiKey: off, useSubscription: false },
    chatgpt: { available: false, subscription: off, apiKey: off, useSubscription: false },
    local: off, codex: off, ollama: off,
    order: [], checkedAt: Date.now(), valid: true,
  };
}

async function statusAll(force = false) {
  const s = db.getSettings().ai;
  if (s.disabled) return disabledStatus();
  if (!force && lastStatus.valid && Date.now() - lastStatus.checkedAt < 30000) return lastStatus;
  const chatgptCfg = bridgeChatgpt(s);
  const claudeCfg = s.claude || {};
  // Local off → don't even ping Ollama's port; report one clear reason instead.
  const localCfg = s.local || {};
  const localOff = { available: false, reason: 'Local AI is turned off — enable it in Settings to use Ollama.', disabled: true };
  const [cx, claudeCliSt, ol, claudeApiSt, openaiSt] = await Promise.all([
    codex.status().catch((e) => ({ available: false, reason: e.message })),
    claudeCli.status().catch((e) => ({ available: false, reason: e.message })),
    localCfg.enabled ? ollama.status(localCfg).catch((e) => ({ available: false, reason: e.message })) : Promise.resolve(localOff),
    anthropic.status(claudeCfg).catch((e) => ({ available: false, reason: e.message })),
    openai.status(chatgptCfg).catch((e) => ({ available: false, reason: e.message })),
  ]);
  const chatgpt = {
    available: (chatgptCfg.useSubscription !== false && cx.available) || openaiSt.available,
    subscription: cx, apiKey: openaiSt, useSubscription: chatgptCfg.useSubscription !== false,
  };
  // Claude now mirrors chatgpt: CLI subscription (claude.js) + API key (anthropic.js).
  const claude = {
    available: (claudeCfg.useSubscription !== false && claudeCliSt.available) || claudeApiSt.available,
    subscription: claudeCliSt, apiKey: claudeApiSt, useSubscription: claudeCfg.useSubscription !== false,
  };
  lastStatus = {
    claude, chatgpt, local: ol,
    codex: cx, ollama: ol,                 // legacy keys
    order: resolveOrder(s.order), checkedAt: Date.now(), valid: true,
  };
  return lastStatus;
}

// The deterministic floor UNDER `local`: a pure no-model answer for the common
// grounded application questions (location/education/years/relocation/…). Only the
// answer-question path passes a `deterministic` ctx ({ question, profile, resume,
// options }); for every other kind this is a no-op and the call errors as before.
// Best-effort + metered; an exact options match is guaranteed by deterministic.js.
function tryDeterministic({ kind, deterministicCtx }) {
  if (kind !== 'answer-question' || !deterministicCtx || !deterministicCtx.question) return null;
  const started = Date.now();
  try {
    const det = deterministic.answer(deterministicCtx.question, deterministicCtx);
    if (det && det.answer) {
      const json = { answer: det.answer, confidence: det.confidence, refuse: false, reason: 'deterministic floor (no model)' };
      try { db.aiLog({ provider: 'deterministic', model: 'rules', kind, ms: Date.now() - started, ok: true, promptChars: deterministicCtx.question.length, responseChars: det.answer.length }); } catch {}
      return { text: det.answer, json, provider: 'deterministic', model: 'rules' };
    }
  } catch (e) {
    try { db.aiLog({ provider: 'deterministic', model: 'rules', kind, ms: Date.now() - started, ok: false, error: String(e.message || e).slice(0, 300) }); } catch {}
  }
  return null;
}

// kind: short label for the log ('fit-score', 'cover-letter', …)
// prose: true → prefer the local prose model when local is used
// deterministic: optional no-model floor ctx for answer-question (see tryDeterministic)
async function run({ kind, prompt, system, schema, prose = false, modelOverride = null, providerOverride = null, deterministic: deterministicCtx = null }) {
  const s = db.getSettings().ai;
  if (s.disabled) {
    // AI is off: the deterministic no-model floor still answers the grounded questions
    // (it's rules, not a model); everything else gets the ONE clean message — no provider
    // is attempted, no process spawns, nothing logs a failure chain.
    const det = tryDeterministic({ kind, deterministicCtx });
    if (det) return det;
    throw Object.assign(new Error(AI_OFF_MSG), { code: 'AI_DISABLED' });
  }
  const attempts = buildAttempts(s, { prose, modelOverride, providerOverride });
  if (!attempts.length) {
    // No cloud/local provider configured — the floor under `local` still answers
    // the common grounded questions on a no-AI machine (Dad's laptop, offline box).
    const det = tryDeterministic({ kind, deterministicCtx });
    if (det) return det;
    // If local AI is still downloading in the background, say so — "unavailable until
    // ready" rather than a flat "not configured" error.
    let setupMsg = '';
    try { const st = require('../localsetup').getState(); if (st && st.busy) setupMsg = `Local AI is still setting up in the background (${st.message || st.step}) — AI features will work once it finishes.`; } catch {}
    throw Object.assign(
      new Error(setupMsg || 'No AI provider is configured. Add a Claude or OpenAI API key, connect ChatGPT, or set up local AI in Settings.'),
      { code: setupMsg ? 'AI_SETTING_UP' : 'NO_PROVIDER' });
  }
  const errors = [];
  for (const att of attempts) {
    const started = Date.now();
    try {
      const result = await att.run({ prompt, system, schema });
      db.aiLog({ provider: att.name, model: att.model, kind, ms: Date.now() - started, ok: true, promptChars: prompt.length, responseChars: result.text.length });
      return { ...result, provider: att.name, model: att.model };
    } catch (e) {
      db.aiLog({ provider: att.name, model: att.model, kind, ms: Date.now() - started, ok: false, error: String(e.message || e).slice(0, 300), promptChars: prompt.length });
      log.warn(`${att.name} failed for ${kind}:`, e.code || '', e.message);
      errors.push({ provider: att.name, code: e.code, message: e.message });
      if (e.code === 'CODEX_AUTH') { lastStatus.valid = false; }
    }
  }
  // Every provider (incl. local) errored — drop to the deterministic floor for the
  // answer-question path before giving up, so a weak/down local model doesn't strand
  // the run on a question the rules can ground. Cloud order above is untouched.
  const det = tryDeterministic({ kind, deterministicCtx });
  if (det) return det;
  const err = new Error('All AI providers failed: ' + errors.map((e) => `${e.provider}(${e.code || 'ERR'})`).join(', '));
  err.details = errors;
  throw err;
}

module.exports = { run, statusAll, resolveOrder, buildAttempts, clearHwCache };
