// JAT v11 — Codex CLI provider (cloud, ChatGPT subscription).
//
// The Codex desktop app ships a managed CLI at a hash-rotating path. Discovery
// order (verified on this machine 2026-06-11):
//   1. ~\.codex\chrome-native-hosts.json → chromeNativeHosts[0].codexCliPath
//   2. newest %LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe
//   3. `codex` on PATH (present if Pierre runs `npm i -g @openai/codex`)
// Never ~\.codex\.sandbox-bin (stale March build).
//
// Invocation contract (verified against codex-cli 0.136.0-alpha.2):
//   codex exec --json --ephemeral --skip-git-repo-check --ignore-user-config
//              -s read-only -C <tmp> -m <model>
//              [--output-schema <schema.json>] --output-last-message <out.txt>
//   prompt on stdin; CODEX_HOME env; JSONL progress on stdout.
// --ignore-user-config matters: Pierre's config.toml spins up MCP servers we
// must not pay for (or grant) on every call. Auth still resolves via CODEX_HOME.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scope } = require('../logger');

const log = scope('ai:codex');

const CODEX_HOME = path.join(os.homedir(), '.codex');
let cachedCli = null;

function discoverCli() {
  if (cachedCli && fs.existsSync(cachedCli)) return cachedCli;
  cachedCli = null;
  // 1. chrome-native-hosts.json pointer
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, 'chrome-native-hosts.json'), 'utf8'));
    const p = j?.chromeNativeHosts?.[0]?.codexCliPath;
    if (p && fs.existsSync(p)) { cachedCli = p; return p; }
  } catch {}
  // 2. newest managed binary
  try {
    const binRoot = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
    const candidates = fs.readdirSync(binRoot)
      .map((d) => path.join(binRoot, d, 'codex.exe'))
      .filter((p) => fs.existsSync(p))
      .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (candidates.length) { cachedCli = candidates[0].p; return cachedCli; }
  } catch {}
  // 3. PATH
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['codex'], { encoding: 'utf8' });
    const p = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (p && fs.existsSync(p)) { cachedCli = p; return p; }
  } catch {}
  return null;
}

// Status probe: binary found + logged in?
async function status() {
  const cli = discoverCli();
  if (!cli) return { available: false, reason: 'codex CLI not found' };
  return new Promise((resolve) => {
    const child = spawn(cli, ['login', 'status'], {
      env: { ...process.env, CODEX_HOME },
      windowsHide: true,
    });
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 10000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const loggedIn = code === 0 && /logged in/i.test(out);
      resolve({
        available: loggedIn,
        cli,
        reason: loggedIn ? null : (out.trim().slice(0, 200) || `exit ${code}`),
        needsLogin: !loggedIn,
      });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ available: false, reason: e.message }); });
  });
}

// generate({ prompt, system, schema, model, timeoutMs }) → { text, json }
async function generate({ prompt, system, schema, model, timeoutMs = 120000 }) {
  const cli = discoverCli();
  if (!cli) throw Object.assign(new Error('codex CLI not found'), { code: 'CODEX_MISSING' });

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-codex-'));
  const outFile = path.join(work, 'last-message.txt');
  const args = [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config',
    '-s', 'read-only', '-C', work,
    '--output-last-message', outFile,
  ];
  if (model) args.push('-m', model);
  let schemaFile = null;
  if (schema) {
    schemaFile = path.join(work, 'schema.json');
    fs.writeFileSync(schemaFile, JSON.stringify(schema));
    args.push('--output-schema', schemaFile);
  }

  const fullPrompt = system ? `${system}\n\n---\n\n${prompt}` : prompt;

  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, {
      env: { ...process.env, CODEX_HOME },
      windowsHide: true,
    });
    let stderr = '';
    let authError = false;
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(Object.assign(new Error(`codex timed out after ${timeoutMs}ms`), { code: 'CODEX_TIMEOUT' }));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      // JSONL progress events; tolerate unknown shapes (alpha channel).
      for (const line of String(d).split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          const blob = JSON.stringify(ev).toLowerCase();
          if (blob.includes('unauthorized') || blob.includes('login') && blob.includes('required')) {
            authError = true;
          }
        } catch {}
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('close', (code) => {
      clearTimeout(timer);
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8').trim(); } catch {}
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}

      if (authError || /unauthorized|not logged in|login required/i.test(stderr)) {
        return reject(Object.assign(new Error('codex auth failed — run `codex login`'), { code: 'CODEX_AUTH' }));
      }
      if (code !== 0 && !text) {
        return reject(Object.assign(
          new Error(`codex exited ${code}: ${stderr.trim().slice(0, 300)}`), { code: 'CODEX_EXIT' }));
      }
      if (!text) {
        return reject(Object.assign(new Error('codex returned no output'), { code: 'CODEX_EMPTY' }));
      }
      let json = null;
      if (schema) {
        try { json = JSON.parse(text); }
        catch (e) {
          return reject(Object.assign(
            new Error('codex output did not parse as JSON despite schema'), { code: 'CODEX_BADJSON' }));
        }
      }
      resolve({ text, json });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
      reject(Object.assign(e, { code: e.code || 'CODEX_SPAWN' }));
    });

    child.stdin.write(fullPrompt);
    child.stdin.end();
  });
}

module.exports = { discoverCli, status, generate, name: 'codex' };
