// JAT v11 — preload. Hands the dashboard its auth token + app facts over a
// minimal, contextIsolation-safe bridge.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jatDesktop', {
  boot: () => ipcRenderer.invoke('jat:boot'),
  openExternal: (url) => ipcRenderer.invoke('jat:open-external', url),
  openLogs: () => ipcRenderer.invoke('jat:open-logs'),
  settingsChanged: () => ipcRenderer.invoke('jat:settings-changed'),
  checkUpdates: () => ipcRenderer.invoke('jat:check-updates'),
  updateState: () => ipcRenderer.invoke('jat:update-state'),
  openReleases: () => ipcRenderer.invoke('jat:open-releases'),
  restartToUpdate: () => ipcRenderer.invoke('jat:restart-to-update'),
  pickFolder: () => ipcRenderer.invoke('jat:pick-folder'),
});
