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

// CHEAP AUTH PROBE — `codex login status` is not a freshness check.
//
// On the server laptop it printed "Logged in" while the stored access token had expired on
// 2026-08-01 and `codex exec` hung instead of refreshing. Every real call returned CODEX_AUTH,
// and /ai/status kept saying ready.
//
// The access token is a JWT; its `exp` claim is exact, local, and free to read. If it is in the
// past the CLI has had every opportunity to refresh and hasn't, so it cannot answer. We read only
// the expiry claim — never the token, never the refresh token.
function tokenExpiry(file) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file || path.join(CODEX_HOME, 'auth.json'), 'utf8')); }
  catch { return null; }                                    // no file → no opinion
  if (j && typeof j.OPENAI_API_KEY === 'string' && j.OPENAI_API_KEY) return { ok: true };   // key mode: no expiry
  const tok = j && j.tokens && j.tokens.access_token;
  if (typeof tok !== 'string' || !tok) return null;
  const parts = tok.split('.');
  if (parts.length < 2) return null;                        // not a JWT → no opinion
  let claims;
  try {
    const b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    claims = JSON.parse(Buffer.from(b + '='.repeat((4 - b.length % 4) % 4), 'base64').toString('utf8'));
  } catch { return null; }
  const exp = Number(claims && claims.exp);
  if (!Number.isFinite(exp) || exp <= 0) return null;
  if (exp * 1000 > Date.now()) return { ok: true, expiresAt: exp * 1000 };
  return {
    ok: false, expiresAt: exp * 1000,
    reason: `the Codex CLI token expired on ${new Date(exp * 1000).toISOString().slice(0, 10)} and has not refreshed — run \`codex login\` on that machine`,
  };
}

// Status probe: binary found, logged in, AND holding an unexpired token.
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
      if (!loggedIn) {
        return resolve({ available: false, cli, reason: out.trim().slice(0, 200) || `exit ${code}`, needsLogin: true });
      }
      const exp = tokenExpiry();
      if (exp && !exp.ok) return resolve({ available: false, cli, reason: exp.reason, needsLogin: true, expiredAt: exp.expiresAt });
      resolve({ available: true, cli, reason: null, needsLogin: false, ...(exp && exp.expiresAt ? { expiresAt: exp.expiresAt } : {}) });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ available: false, reason: e.message }); });
  });
}

// generate({...}) → { text, json } — with ONE retry on a transient codex failure. The codex CLI
// (alpha) intermittently exits 1 with no output on larger structured-output prompts (the apply-
// rescue case: ~18/21 failed "codex exited 1"), while smaller prompts (answer-question) succeed
// ~99.8%. A single retry recovers most of those without changing the contract. Auth/missing
// errors are NOT retried (they won't get better).
async function generate(opts) {
  try { return await generateOnce(opts); }
  catch (e) {
    if (e.code === 'CODEX_EXIT' || e.code === 'CODEX_EMPTY' || e.code === 'CODEX_BADJSON' || e.code === 'CODEX_TIMEOUT') {
      log.warn(`codex transient failure (${e.code}) — retrying once`);
      await new Promise((r) => setTimeout(r, 900));
      return await generateOnce(opts);
    }
    throw e;
  }
}

// generateOnce({ prompt, system, schema, model, timeoutMs }) → { text, json }
async function generateOnce({ prompt, system, schema, model, timeoutMs = 120000 }) {
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

// Kick off the interactive CLI login (opens a browser to sign into ChatGPT).
// Detached — the user completes it in the browser, then re-checks status.
function login() {
  const cli = discoverCli();
  if (!cli) return { ok: false, error: 'Codex CLI not found — install it or sign into the Codex desktop app first.' };
  try {
    const child = spawn(cli, ['login'], { env: { ...process.env, CODEX_HOME }, detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { ok: true, message: 'Complete the sign-in in your browser, then click Re-check.' };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { discoverCli, status, generate, login, tokenExpiry, name: 'codex' };
