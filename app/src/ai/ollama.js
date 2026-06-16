// JAT v11 — Ollama provider (local fallback).
//
// Ollama 0.23.2 supports JSON-Schema structured output via the `format` field
// of POST /api/chat — the same schema object we hand codex --output-schema.
// Ollama is NOT a Windows service (per-user Startup shortcut), so liveness is
// checked before every call and we optionally try `ollama serve` once.

const { spawn } = require('child_process');
const { scope } = require('../logger');

const log = scope('ai:ollama');

let spawnTried = false;

async function ping(url, timeoutMs = 1500) {
  try {
    const r = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function ensureUp(cfg) {
  const v = await ping(cfg.url);
  if (v) return true;
  if (!cfg.trySpawn || spawnTried) return false;
  spawnTried = true;
  try {
    const exe = cfg.exePath || 'ollama';
    const child = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    // CRITICAL: spawn reports a missing binary (ENOENT) ASYNCHRONOUSLY via an 'error'
    // event — the surrounding try/catch only sees sync throws. Without this listener the
    // ENOENT becomes an uncaughtException and CRASHES the app (Dad's machine: no ollama
    // installed → repeated crashes). Swallow it; the ping loop below just reports "down".
    child.on('error', (e) => { try { log.warn('ollama serve spawn error:', e && e.message); } catch {} });
    child.unref();
    log.info('spawned `ollama serve`, waiting for it to come up…');
  } catch (e) {
    log.warn('could not spawn ollama:', e.message);
    return false;
  }
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 700));
    if (await ping(cfg.url)) return true;
  }
  return false;
}

async function status(cfg) {
  // statusAll() runs this before each generate-chain (and on a 30s timer), so
  // it's the natural place to re-arm the one-shot spawn guard — that way a
  // user who restarts Ollama gets a fresh spawn attempt instead of permanent
  // OLLAMA_DOWN for the rest of the app's lifetime.
  spawnTried = false;
  const v = await ping(cfg.url);
  if (!v) return { available: false, reason: 'not responding on ' + cfg.url };
  let models = [];
  try {
    const r = await fetch(`${cfg.url}/api/tags`, { signal: AbortSignal.timeout(2500) });
    const body = await r.json();
    models = (body.models || []).map((m) => ({ name: m.name, sizeBytes: m.size }));
  } catch {}
  return { available: true, version: v.version, models };
}

// generate({ prompt, system, schema, model, timeoutMs, cfg }) → { text, json }
async function generate({ prompt, system, schema, model, timeoutMs, cfg }) {
  const up = await ensureUp(cfg);
  if (!up) throw Object.assign(new Error('ollama is not running'), { code: 'OLLAMA_DOWN' });

  const body = {
    model: model || cfg.structuredModel,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt },
    ],
    stream: false,
    options: { temperature: 0.2, num_ctx: cfg.numCtx || 8192 },
    keep_alive: cfg.keepAlive || '15m',
  };
  if (schema) body.format = schema;

  const r = await fetch(`${cfg.url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs || cfg.timeoutMs || 90000),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw Object.assign(new Error(`ollama HTTP ${r.status}: ${errText.slice(0, 200)}`), { code: 'OLLAMA_HTTP' });
  }
  const data = await r.json();
  const text = (data?.message?.content || '').trim();
  if (!text) throw Object.assign(new Error('ollama returned empty content'), { code: 'OLLAMA_EMPTY' });

  let json = null;
  if (schema) {
    try { json = JSON.parse(text); }
    catch {
      // Last-ditch: tolerant extraction (fences / first brace pair)
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { json = JSON.parse(m[0]); } catch {} }
      if (!json) throw Object.assign(new Error('ollama output did not parse as JSON'), { code: 'OLLAMA_BADJSON' });
    }
  }
  return { text, json };
}

module.exports = { status, generate, ping, name: 'ollama' };
