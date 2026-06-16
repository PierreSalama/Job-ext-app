// JAT v11 — local-AI (Ollama) auto-setup with progress.
//
// Makes the local fallback "just work": detects whether Ollama is installed +
// running, pulls the hardware-recommended models, and reports progress so the
// Settings page can show a bar. Installing the Ollama binary itself needs one
// click (we download + launch the official installer) — the OS install step
// can't be fully silent/unattended reliably; everything after is automatic.

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scope } = require('./logger');
const log = scope('localsetup');

const OLLAMA_WIN_URL = 'https://ollama.com/download/OllamaSetup.exe';

// SHA-256 a file and compare to an expected hex digest (P4 weights integrity).
// Streams the file so a multi-GB GGUF doesn't load into memory. Best-effort:
// any error (missing file, read error) → false, so a corrupt/partial download is
// rejected and re-pulled rather than loaded. NEVER throws.
function verifyChecksum(file, expectedSha256) {
  return new Promise((resolve) => {
    try {
      if (!expectedSha256 || !fs.existsSync(file)) { resolve(false); return; }
      const want = String(expectedSha256).trim().toLowerCase();
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(file);
      stream.on('error', () => resolve(false));
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex').toLowerCase() === want));
    } catch { resolve(false); }
  });
}

// Where a true-offline / USB install can drop pre-downloaded GGUF weights so first
// run never touches the network. Checked BEFORE any fetch. Looks next to the app
// (resources/models for a packaged build) and in a sibling models/ dir in dev.
function sidecarDirs() {
  const dirs = [];
  try { if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'models')); } catch {}
  try { dirs.push(path.join(path.dirname(process.execPath || ''), 'models')); } catch {}
  try { dirs.push(path.join(__dirname, '..', 'models')); } catch {}
  return [...new Set(dirs.filter(Boolean))];
}

// Find a sidecar weight file for a model id (e.g. 'gemma3:1b' → gemma3-1b.gguf).
// Returns the verified path or null. Honors an optional { 'model': sha256 } map.
async function findSidecar(model, checksums = {}) {
  const safe = String(model || '').replace(/[^a-z0-9.]+/gi, '-').toLowerCase();
  const names = [`${safe}.gguf`, `${safe}.bin`, `${String(model).replace(/[^a-z0-9]+/gi, '')}.gguf`];
  for (const dir of sidecarDirs()) {
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        if (!fs.existsSync(p)) continue;
        const expected = checksums[model] || checksums[safe];
        if (expected && !(await verifyChecksum(p, expected))) { log.warn(`sidecar ${name} failed checksum — ignoring`); continue; }
        log.info(`using USB/offline sidecar weights: ${p}`);
        return p;
      } catch {}
    }
  }
  return null;
}

let state = { step: 'idle', progress: 0, message: '', model: '', error: null, busy: false };
let emit = () => {};

function setEmitter(fn) { emit = typeof fn === 'function' ? fn : (() => {}); }
function getState() { return { ...state }; }
function set(p) { state = { ...state, ...p }; try { emit(getState()); } catch {} }

function ollamaOnPath() {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['ollama'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    return !!(r.stdout || '').trim();
  } catch { return false; }
}

async function ping(url, ms = 1500) {
  try { const r = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(ms) }); return r.ok; } catch { return false; }
}

async function detect(cfg) {
  const url = cfg?.url || 'http://localhost:11434';
  const serverUp = await ping(url);
  const installed = serverUp || ollamaOnPath();
  let models = [];
  if (serverUp) {
    try { const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2500) }); models = ((await r.json()).models || []).map((m) => m.name); } catch {}
  }
  return { installed, serverUp, models };
}

async function ensureServer(cfg) {
  const url = cfg?.url || 'http://localhost:11434';
  if (await ping(url)) return true;
  if (!ollamaOnPath() && !(cfg?.exePath)) return false;
  try {
    const exe = cfg?.exePath || 'ollama';
    const child = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    // ENOENT-safe: a missing binary fires 'error' ASYNCHRONOUSLY (the try/catch only
    // catches sync throws). Without this listener the ENOENT becomes an
    // uncaughtException and crashes the app (Dad's no-Ollama machine). Swallow it; the
    // ping loop below just reports "down" and the deterministic floor stays in charge.
    child.on('error', (e) => { try { log.warn('ollama serve spawn error:', e && e.message); } catch {} });
    child.unref();
  } catch (e) { log.warn('spawn ollama serve failed', e.message); return false; }
  for (let i = 0; i < 12; i++) { await new Promise((r) => setTimeout(r, 800)); if (await ping(url)) return true; }
  return false;
}

// Download + launch the official Ollama installer (Windows). Returns the path.
async function downloadInstaller() {
  if (process.platform !== 'win32') throw new Error('auto-install only implemented on Windows; install Ollama from ollama.com');
  set({ step: 'downloading-ollama', progress: 0, message: 'Downloading Ollama installer…' });
  const dest = path.join(os.tmpdir(), 'OllamaSetup.exe');
  const r = await fetch(OLLAMA_WIN_URL, { signal: AbortSignal.timeout(180000) });
  if (!r.ok || !r.body) throw new Error(`download failed (HTTP ${r.status})`);
  const total = Number(r.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(dest);
  let got = 0;
  for await (const chunk of r.body) {
    out.write(chunk); got += chunk.length;
    if (total) set({ progress: Math.round((got / total) * 100), message: `Downloading Ollama… ${Math.round(got / 1048576)} MB` });
  }
  await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  return dest;
}

// Pull one model via the streaming /api/pull endpoint, reporting %.
async function pullModel(model, cfg) {
  const url = cfg?.url || 'http://localhost:11434';
  set({ step: 'pulling-model', model, progress: 0, message: `Downloading model ${model}…` });
  const r = await fetch(`${url}/api/pull`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
    signal: AbortSignal.timeout(60 * 60 * 1000),
  });
  if (!r.ok || !r.body) throw new Error(`pull failed (HTTP ${r.status})`);
  let buf = '';
  for await (const chunk of r.body) {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }   // skip non-JSON lines only
      if (ev.error) throw new Error('ollama pull: ' + ev.error);   // real failure → propagate
      if (ev.total && ev.completed != null) set({ model, progress: Math.round((ev.completed / ev.total) * 100), message: `${model}: ${ev.status || 'downloading'}` });
      else if (ev.status) set({ message: `${model}: ${ev.status}` });
    }
  }
}

// Full setup: ensure Ollama, then pull the requested models. busy-guarded.
async function setup({ models, cfg }) {
  if (state.busy) return getState();
  set({ busy: true, error: null, step: 'starting', progress: 0, message: 'Checking local AI…' });
  try {
    const d = await detect(cfg);
    if (!d.installed) {
      const installer = await downloadInstaller();
      set({ step: 'installing-ollama', message: 'Installing Ollama in the background…' });
      // UNATTENDED install (Ollama's installer is Inno Setup) so non-technical users
      // (Dad) don't have to click anything. Fall back to a normal launch if the silent
      // run errors. The async ENOENT/error is handled so it can't crash the app.
      let silentOk = false;
      try {
        const child = spawn(installer, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOCANCEL'], { detached: true, stdio: 'ignore' });
        child.on('error', (e) => { try { log.warn('silent installer error', e && e.message); } catch {} });
        child.unref();
        silentOk = true;
      } catch (e) { log.warn('silent install failed, trying interactive', e.message); }
      if (!silentOk) {
        set({ message: 'Opening the Ollama installer — click through it, then this continues automatically.' });
        try { const c = spawn(installer, [], { detached: true, stdio: 'ignore' }); c.on('error', () => {}); c.unref(); }
        catch (e) { throw new Error('could not launch installer: ' + e.message); }
      }
      // wait (up to ~6 min) for the install to finish + the server to come up
      let up = false;
      for (let i = 0; i < 72; i++) { await new Promise((r) => setTimeout(r, 5000)); if (await ensureServer(cfg)) { up = true; break; } }
      if (!up) throw new Error('Ollama not detected after install — open it once, then it will be picked up automatically.');
    } else if (!(await ensureServer(cfg))) {
      throw new Error('Ollama is installed but not responding — start it, then retry.');
    }
    const want = [...new Set((models || []).filter(Boolean))];
    const have = (await detect(cfg)).models;
    const present = (list, m) => list.some((h) => h === m || h.startsWith(m + ':') || m.startsWith(h));
    for (const m of want) {
      if (present(have, m)) continue;
      await pullModel(m, cfg);
    }
    // Verify the models actually landed — a swallowed/partial pull must not read as ready.
    const after = (await detect(cfg)).models;
    const missing = want.filter((m) => !present(after, m));
    if (missing.length) throw new Error('these models did not install: ' + missing.join(', '));
    set({ step: 'ready', progress: 100, message: 'Local AI is ready.', busy: false });
  } catch (e) {
    log.warn('local setup failed', e.message);
    set({ step: 'error', error: String(e.message || e), message: String(e.message || e), busy: false });
  }
  return getState();
}

// First-run provisioning (P4): pull/load ONLY the detected tier's model(s) — Dad's
// laptop fetches the ~smallest pair, not every tier. Order of operations:
//   1) resolve the tier's {structuredModel, proseModel} (hardware.recommendModels,
//      honoring the user's Settings override),
//   2) for each, prefer a USB/offline `models/` SIDECAR (checksum-verified) so a
//      true-offline box never hits the network,
//   3) only then fall back to the streaming network pull (reuses setup()).
// Wrapped so it is ENOENT-safe and NEVER throws to main — a bad/missing runtime,
// network, or weights leaves the deterministic floor in charge instead of crashing.
async function provision({ cfg = {}, override = {}, checksums = {} } = {}) {
  try {
    let rec;
    try { rec = require('./hardware').recommendModels(override); }
    catch { rec = { structuredModel: 'qwen2.5:1.5b', proseModel: 'gemma3:1b', tier: 'sm' }; }
    const want = [...new Set([rec.structuredModel, rec.proseModel].filter(Boolean))];

    // Sidecar pass — if every wanted model is present on USB/offline, skip the network.
    const fromSidecar = [];
    for (const m of want) { const p = await findSidecar(m, checksums); if (p) fromSidecar.push({ model: m, path: p }); }
    if (fromSidecar.length === want.length && want.length) {
      set({ step: 'ready', progress: 100, message: 'Local AI models loaded from offline bundle.', busy: false });
      return { tier: rec.tier, models: want, sidecar: fromSidecar, networkPull: false };
    }

    // Otherwise pull only the tier's models over the network (best-effort).
    const st = await setup({ models: want, cfg });
    return { tier: rec.tier, models: want, sidecar: fromSidecar, networkPull: true, state: st };
  } catch (e) {
    // NEVER throw to main: the documented ENOENT-safe contract. The deterministic
    // floor keeps the engine applying even if provisioning can't complete.
    try { log.warn('provision failed (deterministic floor remains active):', e && e.message); } catch {}
    set({ step: 'error', error: String((e && e.message) || e), message: 'Local AI provisioning skipped — deterministic answers remain available.', busy: false });
    return { tier: null, models: [], sidecar: [], networkPull: false, error: String((e && e.message) || e) };
  }
}

module.exports = { detect, setup, pullModel, ensureServer, getState, setEmitter, verifyChecksum, findSidecar, sidecarDirs, provision };
