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
const ollama = require('./ollama');
const anthropic = require('./anthropic');
const openai = require('./openai');
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
      const rec = (cfg.autoPick !== false) ? localRecommend() : { structured: cfg.structuredModel, prose: cfg.proseModel };
      const model = modelOverride || (prose ? (cfg.proseModel || rec.prose) : (cfg.structuredModel || rec.structured));
      attempts.push({ name: 'ollama', model, run: (a) => ollama.generate({ ...a, model, timeoutMs: cfg.timeoutMs, cfg }) });
    }
  }
  return attempts;
}

let lastStatus = { checkedAt: 0, valid: false };

async function statusAll(force = false) {
  const s = db.getSettings().ai;
  if (!force && lastStatus.valid && Date.now() - lastStatus.checkedAt < 30000) return lastStatus;
  const chatgptCfg = bridgeChatgpt(s);
  const [cx, ol, claudeSt, openaiSt] = await Promise.all([
    codex.status().catch((e) => ({ available: false, reason: e.message })),
    ollama.status(s.local || {}).catch((e) => ({ available: false, reason: e.message })),
    anthropic.status(s.claude || {}).catch((e) => ({ available: false, reason: e.message })),
    openai.status(chatgptCfg).catch((e) => ({ available: false, reason: e.message })),
  ]);
  const chatgpt = {
    available: (chatgptCfg.useSubscription !== false && cx.available) || openaiSt.available,
    subscription: cx, apiKey: openaiSt, useSubscription: chatgptCfg.useSubscription !== false,
  };
  lastStatus = {
    claude: claudeSt, chatgpt, local: ol,
    codex: cx, ollama: ol,                 // legacy keys
    order: resolveOrder(s.order), checkedAt: Date.now(), valid: true,
  };
  return lastStatus;
}

// kind: short label for the log ('fit-score', 'cover-letter', …)
// prose: true → prefer the local prose model when local is used
async function run({ kind, prompt, system, schema, prose = false, modelOverride = null, providerOverride = null }) {
  const s = db.getSettings().ai;
  const attempts = buildAttempts(s, { prose, modelOverride, providerOverride });
  if (!attempts.length) {
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
  const err = new Error('All AI providers failed: ' + errors.map((e) => `${e.provider}(${e.code || 'ERR'})`).join(', '));
  err.details = errors;
  throw err;
}

module.exports = { run, statusAll, resolveOrder, buildAttempts, clearHwCache };
