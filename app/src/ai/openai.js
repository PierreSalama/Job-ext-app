// JAT v11 — OpenAI provider (ChatGPT models, via API key).
//
// This is the API-key path for OpenAI (pay-per-token). The OTHER way to use
// ChatGPT — your ChatGPT subscription — goes through the official Codex CLI
// (see codex.js); OpenAI's terms forbid using the subscription to power other
// apps, so the subscription path is personal-use-only and lives in codex.js.

const { scope } = require('../logger');
const log = scope('ai:openai');

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

async function status(cfg) {
  if (!cfg?.apiKey) return { available: false, reason: 'no API key', needsKey: true };
  return { available: true, model: cfg.model || 'gpt-5.4' };
}

// generate({ prompt, system, schema, model, timeoutMs, cfg }) → { text, json }
async function generate({ prompt, system, schema, model, timeoutMs, cfg }) {
  const apiKey = cfg?.apiKey;
  if (!apiKey) throw Object.assign(new Error('no OpenAI API key'), { code: 'OPENAI_NOKEY' });

  const body = {
    model: model || cfg.model || 'gpt-5.4',
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt },
    ],
  };
  if (schema) {
    body.response_format = { type: 'json_schema', json_schema: { name: 'result', schema, strict: false } };
  }

  let r;
  try {
    r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs || cfg.timeoutMs || 120000),
    });
  } catch (e) {
    throw Object.assign(new Error('OpenAI request failed: ' + (e.message || e)), { code: 'OPENAI_NET' });
  }
  if (r.status === 401) throw Object.assign(new Error('OpenAI auth failed — check your API key'), { code: 'OPENAI_AUTH' });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw Object.assign(new Error(`OpenAI HTTP ${r.status}: ${t.slice(0, 200)}`), { code: 'OPENAI_HTTP' });
  }
  const data = await r.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();
  if (!text) throw Object.assign(new Error('OpenAI returned empty content'), { code: 'OPENAI_EMPTY' });

  let json = null;
  if (schema) {
    try { json = JSON.parse(text); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { json = JSON.parse(m[0]); } catch {} }
      if (!json) throw Object.assign(new Error('OpenAI output did not parse as JSON'), { code: 'OPENAI_BADJSON' });
    }
  }
  return { text, json };
}

module.exports = { status, generate, name: 'openai' };
