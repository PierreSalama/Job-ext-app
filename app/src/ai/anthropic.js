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

async function status(cfg) {
  if (!cfg?.apiKey) return { available: false, reason: 'no API key', needsKey: true };
  return { available: true, model: cfg.model || 'claude-sonnet-4-6' };
}

// generate({ prompt, system, schema, model, timeoutMs, cfg }) → { text, json }
async function generate({ prompt, system, schema, model, timeoutMs, cfg }) {
  const apiKey = cfg?.apiKey;
  if (!apiKey) throw Object.assign(new Error('no Anthropic API key'), { code: 'ANTHROPIC_NOKEY' });

  const body = {
    model: model || cfg.model || 'claude-sonnet-4-6',
    max_tokens: cfg.maxTokens || 4096,
    messages: [{ role: 'user', content: prompt }],
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
    throw Object.assign(new Error(`Anthropic HTTP ${r.status}: ${t.slice(0, 200)}`), { code: 'ANTHROPIC_HTTP' });
  }
  const data = await r.json();

  if (schema) {
    const tu = (data.content || []).find((c) => c.type === 'tool_use');
    if (!tu) throw Object.assign(new Error('Anthropic returned no structured output'), { code: 'ANTHROPIC_NOJSON' });
    return { text: JSON.stringify(tu.input), json: tu.input };
  }
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  if (!text) throw Object.assign(new Error('Anthropic returned empty content'), { code: 'ANTHROPIC_EMPTY' });
  return { text, json: null };
}

module.exports = { status, generate, name: 'anthropic' };
