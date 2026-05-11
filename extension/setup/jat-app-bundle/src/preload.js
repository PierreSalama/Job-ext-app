// Preload runs in an isolated world with Node access; the renderer (the
// extension's app.js) only sees what we expose on window.jat5 via
// contextBridge. Everything else stays sandboxed.
const { contextBridge, ipcRenderer } = require('electron');

// One JSON-RPC channel for all UI ↔ store traffic. Mirrors the extension's
// chrome.runtime.sendMessage shape: caller passes { type, data }, server
// returns { ok, ...payload }.
async function api(envelope) {
  try {
    const r = await fetch('http://localhost:7733/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope || {})
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// Event bus — main process emits 'jat-event' over IPC when something
// changes (e.g. extension pushed a snapshot). Mirrors the extension's
// chrome.runtime.onMessage shape so the UI handler is identical.
const eventListeners = new Set();
ipcRenderer.on('jat-event', (_e, msg) => {
  for (const fn of eventListeners) {
    try { fn(msg); } catch (err) { console.error('jat-event listener', err); }
  }
});

contextBridge.exposeInMainWorld('jat5', {
  api,
  onEvent(fn) { eventListeners.add(fn); return () => eventListeners.delete(fn); },
  openExternal(url) { return ipcRenderer.invoke('jat:open-external', url); },
  pickFolder()      { return ipcRenderer.invoke('jat:pick-folder'); },
  serverPort: 7733,
  version: '5.0.0'
});
