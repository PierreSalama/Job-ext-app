// JAT v11 — Claude Code CLI provider (cloud, Claude subscription).
//
// Mirrors ai/codex.js: the app SHELLS OUT to the locally-installed `claude` CLI (the OFFICIAL
// client) as a subprocess. The CLI owns its own credentials in ~/.claude and refreshes them
// itself — the app NEVER reads, stores, or hardcodes the OAuth token. This is the only secure +
// ToS-safe way to "piggyback the subscription": we invoke the official client, we don't lift its
// token (Anthropic blocks raw subscription tokens used outside the official client).
//
// Discovery order (Windows-first; falls back to POSIX):
//   1. `where claude` / `which claude` on PATH (npm global install puts claude(.cmd) here)
//   2. npm global bin: %APPDATA%\npm\claude.cmd  (Windows) / ~/.npm-global, /usr/local/bin
//   3. ~/.claude/local/claude  (native installer location)
//
// Invocation contract (Claude Code CLI, stable print-mode flags):
//   claude -p --output-format json [--model <m>] [--append-system-prompt <s>]
//   prompt on STDIN. JSON envelope on stdout: { type:'result', is_error, result:'<text>', ... }
// When a schema is requested we instruct JSON in the prompt and parse `result` (Claude Code has
// no --output-schema flag).

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scope } = require('../logger');

const log = scope('ai:claude');
const IS_WIN = process.platform === 'win32';
let cachedCli = null;

function discoverCli() {
  if (cachedCli && fs.existsSync(cachedCli)) return cachedCli;
  cachedCli = null;
  // 1. PATH
  try {
    const r = spawnSync(IS_WIN ? 'where.exe' : 'which', ['claude'], { encoding: 'utf8' });
    const p = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (p && fs.existsSync(p)) { cachedCli = p; return p; }
  } catch {}
  // 2. npm global bin + common install dirs
  const guesses = IS_WIN
    ? [
        path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
        path.join(process.env.APPDATA || '', 'npm', 'claude.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'claude.exe'),
        path.join(os.homedir(), '.claude', 'local', 'claude.exe'),
      ]
    : [
        path.join(os.homedir(), '.claude', 'local', 'claude'),
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',
        path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
      ];
  for (const g of guesses) { try { if (g && fs.existsSync(g)) { cachedCli = g; return g; } } catch {} }
  return null;
}

// Status probe: binary present + (best-effort) responds. We avoid a paid round-trip — binary +
// `--version` success means it's installed and runnable; auth is validated on the first real
// generate() call and surfaced as a CLAUDE_AUTH error (which the UI turns into a "sign in" prompt).
async function status() {
  const cli = discoverCli();
  if (!cli) return { available: false, reason: 'Claude CLI not found', needsInstall: true };
  return new Promise((resolve) => {
    const child = spawn(cli, ['--version'], { windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 8000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ok = code === 0;
      resolve({ available: ok, cli, version: out.trim().slice(0, 60) || null, reason: ok ? null : (out.trim().slice(0, 200) || `exit ${code}`) });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ available: false, reason: e.message }); });
  });
}

// generate({ prompt, system, schema, model, timeoutMs }) → { text, json }
async function generate({ prompt, system, schema, model, timeoutMs = 120000 }) {
  const cli = discoverCli();
  if (!cli) throw Object.assign(new Error('Claude CLI not found'), { code: 'CLAUDE_MISSING' });

  const args = ['-p', '--output-format', 'json'];
  if (model) args.push('--model', model);
  if (system) args.push('--append-system-prompt', system);
  // When a schema is requested, steer Claude to emit ONLY JSON matching it (no --output-schema flag).
  const fullPrompt = schema
    ? `${prompt}\n\nReturn ONLY a JSON object matching this schema, no prose, no markdown fences:\n${JSON.stringify(schema)}`
    : prompt;

  return new Promise((resolve, reject) => {
    // shell:true so a .cmd shim (npm global on Windows) is invoked correctly.
    const child = spawn(cli, args, { windowsHide: true, shell: IS_WIN && /\.cmd$/i.test(cli) });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(Object.assign(new Error(`claude timed out after ${timeoutMs}ms`), { code: 'CLAUDE_TIMEOUT' }));
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (/unauthorized|not logged in|please run.*login|authentication|invalid api key|credit balance/i.test(stderr)) {
        return reject(Object.assign(new Error('Claude auth failed — run `claude` and sign in'), { code: 'CLAUDE_AUTH' }));
      }
      if (code !== 0 && !stdout.trim()) {
        return reject(Object.assign(new Error(`claude exited ${code}: ${stderr.trim().slice(0, 300)}`), { code: 'CLAUDE_EXIT' }));
      }
      // Parse the --output-format json envelope; tolerate a raw text fallback.
      let text = '';
      try {
        const env = JSON.parse(stdout.trim());
        if (env && env.is_error) {
          return reject(Object.assign(new Error(`claude error: ${String(env.result || env.error || '').slice(0, 200)}`), { code: 'CLAUDE_RESULT_ERR' }));
        }
        text = String(env?.result ?? '').trim();
      } catch {
        text = stdout.trim();   // not JSON envelope — use raw (older CLI / text mode)
      }
      if (!text) return reject(Object.assign(new Error('claude returned no output'), { code: 'CLAUDE_EMPTY' }));
      let json = null;
      if (schema) {
        const m = text.match(/\{[\s\S]*\}/);   // strip any stray prose/fences around the JSON
        try { json = JSON.parse(m ? m[0] : text); }
        catch { return reject(Object.assign(new Error('claude output did not parse as JSON despite schema'), { code: 'CLAUDE_BADJSON' })); }
      }
      resolve({ text, json });
    });
    child.on('error', (e) => { clearTimeout(timer); reject(Object.assign(e, { code: e.code || 'CLAUDE_SPAWN' })); });

    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}

// Claude Code signs in interactively (run `claude`, then /login, or it prompts on first run).
// We can't drive that headlessly; surface guidance for the settings UI.
function login() {
  const cli = discoverCli();
  if (!cli) return { ok: false, error: 'Claude CLI not found — install it (npm i -g @anthropic-ai/claude-code) and sign in.' };
  return { ok: true, message: 'Open a terminal, run `claude`, and sign in once. Then click Re-check.' };
}

module.exports = { discoverCli, status, generate, login, name: 'claude-cli' };
