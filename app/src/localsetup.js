// JAT v11 — local-AI (Ollama) auto-setup with progress.
//
// Makes the local fallback "just work": detects whether Ollama is installed +
// running, pulls the hardware-recommended models, and reports progress so the
// Settings page can show a bar. Installing the Ollama binary itself needs one
// click (we download + launch the official installer) — the OS install step
// can't be fully silent/unattended reliably; everything after is automatic.

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scope } = require('./logger');
const log = scope('localsetup');

const OLLAMA_WIN_URL = 'https://ollama.com/download/OllamaSetup.exe';

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
      set({ step: 'installing-ollama', message: 'Launching the Ollama installer — click through it, then this continues automatically.' });
      try { spawn(installer, [], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { throw new Error('could not launch installer: ' + e.message); }
      // wait (up to ~5 min) for the user to finish the install + server to come up
      let up = false;
      for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 5000)); if (await ensureServer(cfg)) { up = true; break; } }
      if (!up) throw new Error('Ollama not detected after install — finish the installer, then click Set up again.');
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

module.exports = { detect, setup, pullModel, ensureServer, getState, setEmitter };
