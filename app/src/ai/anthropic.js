// JAT v11 — Anthropic provider (Claude, via API key).
//
// Subscription (Claude Pro/Max) auth is NOT usable here: Anthropic blocks
// subscription OAuth tokens outside their own Claude Code (server-side, since
// Jan 2026), so the only sanctioned way to use Claude in this app is an API key
// from console.anthropic.com. Structured output uses forced tool-use.

const { scope } = require('../logger');
const log = scope('ai:anthropic');

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// What this build of the API provider understands. ai-switch.ps1 (Pierre's subscription <-> API
// billing switch) reads this from /ai/status and refuses to flip to the API on a build that would
// ignore effort/thinking, because on Haiku 5.5 that means default (medium) effort with adaptive
// thinking ON - and adaptive thinking cannot be combined with the forced tool_choice used below.
// apiFirst: provider.js puts this API attempt AHEAD of claude-cli, which becomes the fallback.
const SUPPORTS = ['effort', 'thinking', 'strictModel', 'usageLog', 'apiFirst'];
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

async function status(cfg) {
  if (!cfg?.apiKey) return { available: false, reason: 'no API key', needsKey: true, supports: SUPPORTS };
  return { available: true, model: cfg.model || 'claude-sonnet-4-6', effort: cfg.effort || '', supports: SUPPORTS };
}

// Request-body knobs that keep the API path cheap (2026-10-08: Pierre moved JAT onto API credits,
// Haiku only, low effort). Pure so it can be tested without a network call.
//   cfg.effort   'low'|'medium'|'high'|'xhigh'|'max' -> output_config.effort. '' = model default.
//   cfg.thinking 'disabled' -> thinking:{type:'disabled'}. '' = model default.
// A FORCED tool_choice (every schema call) is incompatible with extended/adaptive thinking, and the
// 5.x models think by default - so a schema call always sends thinking disabled, whatever cfg says.
function costControls(cfg, { schema } = {}) {
  const out = {};
  const effort = String(cfg?.effort || '').trim().toLowerCase();
  if (EFFORTS.has(effort)) out.output_config = { effort };
  if (schema || String(cfg?.thinking || '').trim().toLowerCase() === 'disabled') out.thinking = { type: 'disabled' };
  return out;
}

// generate({ prompt, system, schema, model, timeoutMs, cfg }) → { text, json }
async function generate({ prompt, system, schema, model, timeoutMs, cfg }) {
  const apiKey = cfg?.apiKey;
  if (!apiKey) throw Object.assign(new Error('no Anthropic API key'), { code: 'ANTHROPIC_NOKEY' });

  const body = {
    model: model || cfg.model || 'claude-sonnet-4-6',
    max_tokens: cfg.maxTokens || 4096,
    messages: [{ role: 'user', content: prompt }],
    ...costControls(cfg, { schema }),
  };
  if (system) body.system = system;
  if (schema) {
    // Force a single tool whose input IS the schema → guaranteed structured JSON.
    body.tools = [{ name: 'emit_result', description: 'Return the structured result.', input_schema: schema }];
    body.tool_choice = { type: 'tool', name: 'emit_result' };
  }

  let r;
  try {
    r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs || cfg.timeoutMs || 120000),
    });
  } catch (e) {
    throw Object.assign(new Error('Anthropic request failed: ' + (e.message || e)), { code: 'ANTHROPIC_NET' });
  }
  if (r.status === 401 || r.status === 403) {
    throw Object.assign(new Error('Anthropic auth failed — check your API key'), { code: 'ANTHROPIC_AUTH' });
  }
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    // Named codes so the ai_log says WHY the chain fell back to the subscription (apiFirst).
    const code = r.status === 429 ? 'ANTHROPIC_RATE'
      : /credit balance|billing|insufficient/i.test(t) ? 'ANTHROPIC_CREDIT'
      : 'ANTHROPIC_HTTP';
    throw Object.assign(new Error(`Anthropic HTTP ${r.status}: ${t.slice(0, 200)}`), { code });
  }
  const data = await r.json();
  // Token usage, so "is the API being used and how much" has an answer on this machine too, not
  // only on console.anthropic.com. ai_log has no token columns (no schema change for this); the
  // app log carries it and the result hands it back to the caller.
  const usage = data.usage ? { input_tokens: data.usage.input_tokens || 0, output_tokens: data.usage.output_tokens || 0 } : null;
  if (usage) log.info(`usage model=${body.model} in=${usage.input_tokens} out=${usage.output_tokens}`);

  if (schema) {
    const tu = (data.content || []).find((c) => c.type === 'tool_use');
    if (!tu) throw Object.assign(new Error('Anthropic returned no structured output'), { code: 'ANTHROPIC_NOJSON' });
    return { text: JSON.stringify(tu.input), json: tu.input, usage };
  }
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  if (!text) throw Object.assign(new Error('Anthropic returned empty content'), { code: 'ANTHROPIC_EMPTY' });
  return { text, json: null, usage };
}

module.exports = { status, generate, costControls, SUPPORTS, name: 'anthropic' };
