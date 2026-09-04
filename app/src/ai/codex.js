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

// ---- quota ----------------------------------------------------------------
// Codex reports an exhausted subscription as a JSONL error/turn.failed event and then exits
// non-zero with an EMPTY stderr, so this surfaced as `CODEX_EXIT codex exited 1:` with no message
// and got RETRIED as if it were the known transient alpha flake. Worse, status() only asks
// `codex login status`, and a quota-exhausted account is still logged in — so /ai/status reported
// available:true while every generate call failed. That pair is what let both nodes sit dead for
// hours while the health check read green (2026-09-03). Quota is now its own hard, non-retryable
// code, remembered until the reset time the CLI hands us, and status() reports it honestly.
const QUOTA_RE = /usage limit|quota|rate limit|too many requests/i;
let quotaBlock = null; // { message, until } — until is epoch ms, or null when no date was given

// "…try again at Sep 26th, 2026 5:25 PM." → epoch ms, or null when there is no parseable date.
function parseQuotaReset(message) {
  const m = /try again at\s+([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM))?/i
    .exec(String(message || ''));
  if (!m) return null;
  const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const mon = months[m[1].slice(0, 3).toLowerCase()];
  if (mon === undefined) return null;
  let hour = m[4] ? parseInt(m[4], 10) % 12 : 0;
  if (m[6] && /pm/i.test(m[6])) hour += 12;
  const d = new Date(parseInt(m[3], 10), mon, parseInt(m[2], 10), hour, m[5] ? parseInt(m[5], 10) : 0, 0, 0);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

// The live block, or null once its reset time has passed (a block with no date never expires on
// its own — the next successful call clears it).
function quotaStatus() {
  if (!quotaBlock) return null;
  if (quotaBlock.until && Date.now() >= quotaBlock.until) { quotaBlock = null; return null; }
  return quotaBlock;
}

function noteQuota(message) {
  quotaBlock = { message: String(message), until: parseQuotaReset(message) };
  return quotaBlock;
}

function clearQuota() { quotaBlock = null; }

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

  // AN EXPIRED ACCESS TOKEN IS NOT A LOGGED-OUT ACCOUNT.
  //
  // Codex access tokens last about ten days and the CLI refreshes them from the refresh_token the
  // next time it runs. Treating a stale one as "signed out" created the outage it was reporting:
  // the server laptop had a token that lapsed on 2026-08-01 simply because nothing had invoked
  // Codex since July, so the probe marked it unavailable, so nothing ever invoked it, so it never
  // refreshed. Five weeks of a working account reported as dead.
  //
  // With a refresh_token present the honest answer is "stale, and it will sort itself out on the
  // next call". If that refresh actually fails, the call fails and `honest()` records it from the
  // real attempt, which is a far better source of truth than a guess made from a timestamp.
  const refreshable = !!(j && j.tokens && j.tokens.refresh_token);
  if (refreshable) {
    return {
      ok: true, stale: true, expiresAt: exp * 1000,
      note: `the access token lapsed on ${new Date(exp * 1000).toISOString().slice(0, 10)} and the CLI will refresh it on the next call`,
    };
  }
  return {
    ok: false, expiresAt: exp * 1000,
    reason: `the Codex CLI token expired on ${new Date(exp * 1000).toISOString().slice(0, 10)} and there is no refresh token — run \`codex login\` on that machine`,
  };
}

// Status probe: binary found, logged in, AND holding an unexpired token.
async function status() {
  const cli = discoverCli();
  if (!cli) return { available: false, reason: 'codex CLI not found' };
  // Logged in is NOT the same as has quota. Report the block first or canAnswer lies.
  const blocked = quotaStatus();
  if (blocked) {
    return {
      available: false, cli, quotaBlocked: true, reason: blocked.message,
      ...(blocked.until ? { retryAt: new Date(blocked.until).toISOString() } : {}),
    };
  }
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
      resolve({
        available: true, cli, reason: null, needsLogin: false,
        ...(exp && exp.stale ? { staleToken: true, note: exp.note } : {}),
        ...(exp && exp.expiresAt ? { expiresAt: exp.expiresAt } : {}),
      });
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
  const blocked = quotaStatus();
  if (blocked) {
    throw Object.assign(new Error(blocked.message), { code: 'CODEX_QUOTA', until: blocked.until });
  }
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
    let quotaError = null;
    let lastEventError = null;   // best diagnostic seen in the JSONL, for when stderr is useless
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(Object.assign(new Error(`codex timed out after ${timeoutMs}ms`), { code: 'CODEX_TIMEOUT' }));
    }, timeoutMs);

    // BUFFER ACROSS CHUNKS. stdout arrives in arbitrary slices, so a long JSONL line is routinely
    // delivered in two pieces. Parsing each raw chunk meant the fragments failed JSON.parse and were
    // swallowed by the catch below — and the quota notice is one of the LONGEST lines Codex emits
    // ("You've hit your usage limit… try again at Sep 26th, 2026 5:25 PM.", ~180 chars), so it was
    // the event most likely to be lost. That is why an exhausted account surfaced as a bare
    // CODEX_EXIT and got retried as a transient flake instead of being recorded as quota.
    let lineBuf = '';
    const consumeLine = (line) => {
      if (!line.trim()) return;
      try {
        const ev = JSON.parse(line);
        const blob = JSON.stringify(ev).toLowerCase();
        if (blob.includes('unauthorized') || (blob.includes('login') && blob.includes('required'))) {
          authError = true;
        }
        const msg = ev?.message || ev?.error?.message || '';
        if (msg && QUOTA_RE.test(msg)) quotaError = msg;
        // KEEP THE ONLY DIAGNOSTIC THERE IS. On a failed turn Codex exits non-zero with a stderr
        // that carries nothing usable (29 bytes on the 2026-09-03 repro), so the sole explanation
        // lives in these events. Discarding it is what made every non-quota failure surface as a
        // bare "codex exited 1:" — including a plainly actionable one: the configured model
        // gpt-5.4 being rejected outright for a ChatGPT account.
        if (msg && (ev?.type === 'error' || ev?.type === 'turn.failed' || ev?.item?.type === 'error')) {
          let detail = msg;
          // The payload is often a JSON string wrapping the real sentence — unwrap it once.
          try { const inner = JSON.parse(msg); detail = inner?.error?.message || inner?.message || msg; } catch { /* plain text */ }
          lastEventError = String(detail).slice(0, 300);
        }
      } catch { /* alpha channel emits shapes we do not model — ignore the line, not the stream */ }
    };
    child.stdout.on('data', (d) => {
      // JSONL progress events; tolerate unknown shapes (alpha channel).
      lineBuf += String(d);
      const lines = lineBuf.split(/\r?\n/);
      lineBuf = lines.pop() ?? '';   // keep the trailing partial for the next chunk
      for (const line of lines) consumeLine(line);
    });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('close', (code) => {
      clearTimeout(timer);
      // The last line often arrives without a trailing newline, so it is still sitting in the
      // buffer here. Codex emits turn.failed LAST — exactly the event carrying the quota reason.
      if (lineBuf) { consumeLine(lineBuf); lineBuf = ''; }
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8').trim(); } catch {}
      try { fs.rmSync(work, { recursive: true, force: true }); } catch {}

      if (authError || /unauthorized|not logged in|login required/i.test(stderr)) {
        return reject(Object.assign(new Error('codex auth failed — run `codex login`'), { code: 'CODEX_AUTH' }));
      }
      if (quotaError) {
        const blocked = noteQuota(quotaError);
        return reject(Object.assign(new Error(quotaError), { code: 'CODEX_QUOTA', until: blocked.until }));
      }
      if (code !== 0 && !text) {
        return reject(Object.assign(
          new Error(`codex exited ${code}: ${lastEventError || stderr.trim().slice(0, 300) || '(no diagnostic)'}`),
          { code: 'CODEX_EXIT', detail: lastEventError || null }));
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
      clearQuota();
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

module.exports = {
  discoverCli, status, generate, login, tokenExpiry, name: 'codex',
  parseQuotaReset, quotaStatus, noteQuota, clearQuota,
};
