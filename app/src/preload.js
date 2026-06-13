// JAT v11 — preload. Hands the dashboard its auth token + app facts over a
// minimal, contextIsolation-safe bridge.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jatDesktop', {
  boot: () => ipcRenderer.invoke('jat:boot'),
  openExternal: (url) => ipcRenderer.invoke('jat:open-external', url),
  openLogs: () => ipcRenderer.invoke('jat:open-logs'),
  settingsChanged: () => ipcRenderer.invoke('jat:settings-changed'),
});
