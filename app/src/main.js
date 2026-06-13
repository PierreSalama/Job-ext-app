// JAT v11 — Electron main process.
// Single instance, tray-resident (close-to-tray keeps capture alive),
// token-guarded REST+SSE server on 127.0.0.1:7744, electron-updater,
// global hotkey, native notifications, daily backups, Gmail sync scheduler.

const {
  app, BrowserWindow, Tray, Menu, dialog, globalShortcut,
  Notification, ipcMain, nativeImage, shell,
} = require('electron');
const path = require('path');
const { startServer, stopServer, getToken, broadcast, rescanAllFolders, startFolderWatchers } = require('./server');
const db = require('./db');
const { autoUpdater } = require('electron-updater');
const { scope, log: rootLog } = require('./logger');

const log = scope('main');
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let mainWindow = null;
let tray = null;
let updateInterval = null;
let backupInterval = null;
let gmailInterval = null;
let isQuitting = false;

// ---------- single instance ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // The browser extension launches us via jat11:// when we're already
  // installed; on Windows that arrives as a second instance → just focus.
  app.on('second-instance', () => showWindow());
}

// Register the jat11:// protocol so the extension can open the installed app
// (electron-builder also declares it so the installer wires it system-wide).
try {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('jat11', process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient('jat11');
  }
} catch { /* non-fatal */ }
app.on('open-url', () => showWindow());   // macOS protocol activation

process.on('uncaughtException', (e) => log.error('uncaughtException', e));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));

// ---------- window ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: 'Job Application Tracker',
    icon: iconPath(),
    backgroundColor: '#0a0a0a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'app', 'app.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (e) => {
    const s = db.getSettings().app;
    if (!isQuitting && s.closeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function showWindow() {
  if (!mainWindow) createWindow();
  else { mainWindow.show(); mainWindow.focus(); }
}

function iconPath() {
  return path.join(__dirname, 'icons',
    process.platform === 'win32' ? 'icon.ico'
      : process.platform === 'darwin' ? 'icon.icns' : 'icon128.png');
}

// ---------- tray ----------
function createTray() {
  const img = nativeImage.createFromPath(
    path.join(__dirname, 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon32.png'));
  tray = new Tray(img);
  tray.setToolTip('Job Application Tracker');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open dashboard', click: showWindow },
    { type: 'separator' },
    {
      label: 'Check for updates…',
      click: async () => {
        const r = await manualCheckForUpdates();
        if (r.status === 'dev') {
          dialog.showMessageBox(mainWindow, { type: 'info', title: 'Dev build', message: 'Updates are only checked in the installed app.', noLink: true });
        } else if (r.status === 'current') {
          dialog.showMessageBox(mainWindow, { type: 'info', title: 'Up to date', message: `You're on the latest version (v${r.current}).`, noLink: true });
        } else if (r.status === 'available' || r.status === 'downloaded') {
          dialog.showMessageBox(mainWindow, { type: 'info', title: 'Update found', message: `v${r.version} is downloading. You'll be asked to restart when it's ready.`, noLink: true });
        } else if (r.status === 'error') {
          dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Update check failed', message: r.error || 'Could not check for updates.', noLink: true });
        } else {
          dialog.showMessageBox(mainWindow, { type: 'info', title: 'Checking…', message: 'Still checking — try again in a moment.', noLink: true });
        }
      },
    },
    {
      label: 'Back up database now',
      click: () => {
        const dest = db.backupNow('manual-' + new Date().toISOString().slice(0, 10));
        notify('updates', 'Backup', dest ? `Saved to ${dest}` : 'Backup failed — see logs');
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('double-click', showWindow);
}

// ---------- notifications (all gated by settings) ----------
function notify(kind, title, body) {
  try {
    const s = db.getSettings().notifications;
    const gate = { status: s.statusChanges, autoApply: s.autoApply, updates: s.updates, followUps: s.followUps };
    if (kind in gate && !gate[kind]) return;
    if (!Notification.isSupported()) return;
    new Notification({ title, body: String(body || '').slice(0, 180), icon: iconPath() }).show();
  } catch {}
}

function notifyEvent(type, payload) {
  if (type === 'status' && payload?.job) {
    if (payload.action === 'created') {
      notify('status', 'Application captured', `${payload.job.title} — ${payload.job.company}`);
    } else if (payload.statusChanged) {
      notify('status', 'Status updated', `${payload.job.title}: ${payload.previousStatus} → ${payload.job.status}`);
    }
  }
  if (type === 'autoApply' && payload) {
    const msgs = {
      awaiting_review: 'An application is filled and waiting for your review.',
      awaiting_input: 'Auto-apply needs your input on a question it could not answer.',
      done: 'An application was submitted.',
      failed: `A queued application failed: ${payload.lastError || 'see transcript'}`,
    };
    if (msgs[payload.state]) notify('autoApply', 'Auto-apply', msgs[payload.state]);
  }
}

// ---------- pairing consent ----------
async function confirmPair(info) {
  showWindow();
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: 'Connect extension?',
    message: 'A browser extension wants to connect to your Job Application Tracker data.',
    detail: `Client: ${info.client}\nOrigin: ${info.origin || '(none)'}\n\nOnly allow this if you just clicked "Connect" in the JAT extension.`,
    buttons: ['Allow', 'Deny'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return r.response === 0;
}

// ---------- auto-updater ----------
const RELEASES_URL = 'https://github.com/PierreSalama/Job-ext-app/releases';
let updateState = { status: 'idle', current: null, version: null, percent: 0 };

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = rootLog;
  updateState.current = app.getVersion();

  autoUpdater.on('error', (err) => {
    log.warn('[updater] error:', err?.message || err);
    updateState = { ...updateState, status: 'error', error: String(err?.message || err) };
  });
  autoUpdater.on('checking-for-update', () => { updateState = { ...updateState, status: 'checking' }; });
  autoUpdater.on('update-available', (info) => {
    log.info('[updater] update available:', info?.version);
    updateState = { ...updateState, status: 'downloading', version: info?.version, percent: 0 };
    // Prompt the moment an update is detected (it downloads in the background).
    notify('updates', 'Update available', `Job Application Tracker v${info?.version} is downloading — you'll be asked to restart when it's ready.`);
  });
  autoUpdater.on('update-not-available', () => { updateState = { ...updateState, status: 'current' }; });
  autoUpdater.on('download-progress', (p) => { updateState = { ...updateState, status: 'downloading', percent: Math.round(p.percent || 0) }; });
  autoUpdater.on('update-downloaded', (info) => {
    updateState = { ...updateState, status: 'downloaded', version: info?.version };
    notify('updates', 'Update ready', `v${info?.version} downloaded — restart to apply.`);
    promptRestart(info?.version);
  });

  autoUpdater.checkForUpdates().catch((e) => log.warn('[updater] initial check failed:', e?.message || e));
  updateInterval = setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), UPDATE_CHECK_INTERVAL_MS);
}

function promptRestart(version) {
  showWindow();
  const result = dialog.showMessageBoxSync({
    type: 'info',
    title: 'Update ready',
    message: `Job Application Tracker v${version} is ready to install.`,
    detail: 'Restart now to apply the update, or it will install the next time you quit.',
    buttons: ['Restart now', 'Later'],
    defaultId: 0, cancelId: 1, noLink: true,
  });
  if (result === 0) { isQuitting = true; autoUpdater.quitAndInstall(true, true); }
}

// Manual check that resolves with a user-facing result (tray + dashboard).
function manualCheckForUpdates() {
  if (!app.isPackaged) return Promise.resolve({ status: 'dev', current: app.getVersion() });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve({ current: app.getVersion(), ...r }); } };
    autoUpdater.once('update-available', (info) => finish({ status: 'available', version: info?.version }));
    autoUpdater.once('update-not-available', () => finish({ status: 'current' }));
    autoUpdater.once('update-downloaded', (info) => finish({ status: 'downloaded', version: info?.version }));
    autoUpdater.once('error', (e) => finish({ status: 'error', error: String(e?.message || e) }));
    setTimeout(() => finish({ status: 'timeout' }), 30000);
    autoUpdater.checkForUpdates().catch((e) => finish({ status: 'error', error: String(e?.message || e) }));
  });
}

// ---------- gmail scheduler ----------
function scheduleGmail() {
  if (gmailInterval) clearInterval(gmailInterval);
  const s = db.getSettings().gmail;
  if (!s.enabled) return;
  const everyMs = Math.max(5, s.intervalMinutes || 30) * 60000;
  gmailInterval = setInterval(async () => {
    try {
      const gmail = require('./gmail');
      const r = await gmail.syncNow();
      if (r.ok && r.updated) broadcast('jobs.updated', { action: 'gmail-sync' });
    } catch (e) { log.warn('gmail tick failed', e.message); }
  }, everyMs);
  log.info(`gmail sync scheduled every ${everyMs / 60000}m`);
}

// ---------- app prefs that mirror settings ----------
function applyAppSettings() {
  const s = db.getSettings().app;
  try {
    app.setLoginItemSettings({ openAtLogin: !!s.autoLaunch });
  } catch (e) { log.warn('setLoginItemSettings failed', e.message); }

  globalShortcut.unregisterAll();
  if (s.globalHotkey) {
    try {
      globalShortcut.register('Control+Shift+J', () => {
        if (mainWindow?.isVisible()) mainWindow.hide();
        else showWindow();
      });
    } catch (e) { log.warn('hotkey registration failed', e.message); }
  }
  scheduleGmail();
}

// ---------- IPC ----------
ipcMain.handle('jat:boot', () => ({
  token: getToken(),
  version: app.getVersion(),
  port: db.getSettings().server.port,
  platform: process.platform,
}));
ipcMain.handle('jat:open-external', (_e, url) => {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
});
ipcMain.handle('jat:open-logs', () => {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    shell.openPath(dir);
  } catch {}
});
ipcMain.handle('jat:settings-changed', () => { applyAppSettings(); });
ipcMain.handle('jat:check-updates', () => manualCheckForUpdates());
ipcMain.handle('jat:update-state', () => updateState);
ipcMain.handle('jat:open-releases', () => shell.openExternal(RELEASES_URL));
ipcMain.handle('jat:restart-to-update', () => {
  if (updateState.status === 'downloaded') { isQuitting = true; autoUpdater.quitAndInstall(true, true); return true; }
  return false;
});
ipcMain.handle('jat:pick-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder to index', properties: ['openDirectory'],
  });
  return (r.canceled || !r.filePaths?.length) ? null : r.filePaths[0];
});

// ---------- lifecycle ----------
app.whenReady().then(async () => {
  try {
    db.open(app.getPath('userData'));
  } catch (e) {
    log.error('failed to open DB', e);
    dialog.showErrorBox('Database error', 'Could not open the JAT database:\n' + e.message);
    app.quit();
    return;
  }

  const port = db.getSettings().server.port;
  try {
    await startServer(port, {
      getVersion: () => app.getVersion(),
      userDataDir: app.getPath('userData'),
      confirmPair,
      notify: notifyEvent,
    });
    log.info(`server listening on http://127.0.0.1:${port}`);
  } catch (e) {
    log.error('failed to start server', e);
    dialog.showErrorBox(
      'Port in use',
      `JAT could not listen on 127.0.0.1:${port} (${e.code || e.message}).\n\n` +
      'Another program is using that port. Close it, or change the port in Settings → General, then restart.');
    // Without the server there is no backend for the dashboard — don't bring up
    // a window/tray that looks alive but can't talk to anything. Quit cleanly.
    db.close();
    isQuitting = true;
    app.quit();
    return;
  }

  createWindow();
  createTray();
  applyAppSettings();

  // Auto-index linked document folders: catch up on changes since last run, then
  // watch for live edits. Fire-and-forget so it never blocks startup.
  Promise.resolve()
    .then(() => rescanAllFolders())
    .then(() => startFolderWatchers())
    .catch((e) => log.warn('folder auto-index setup failed', e.message));

  // Local-AI auto-setup (only if the user opted in) — downloads Ollama + the
  // hardware-recommended models in the background; progress shows in Settings.
  try {
    const lc = db.getSettings().ai.local;
    if (lc && lc.autoSetup) {
      const ls = require('./localsetup');
      const rec = require('./hardware').probe().recommend;
      ls.setup({ models: [lc.structuredModel || rec.structured, lc.proseModel || rec.prose], cfg: lc })
        .catch((e) => log.warn('local AI auto-setup failed', e.message));
    }
  } catch (e) { log.warn('local AI auto-setup skipped', e.message); }

  db.dailyBackup();
  backupInterval = setInterval(() => db.dailyBackup(), 24 * 3600 * 1000);

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  if (app.isPackaged) setupAutoUpdater();
});

app.on('before-quit', () => { isQuitting = true; });

app.on('window-all-closed', () => {
  // Tray mode: server + DB stay alive. Only quit if closeToTray is disabled.
  const s = db.getSettings().app;
  if (!s.closeToTray && process.platform !== 'darwin') {
    isQuitting = true;
    app.quit();
  }
});

app.on('will-quit', () => {
  // Stop every timer that might touch the DB BEFORE we close it, so an
  // in-flight gmail tick / backup can't call into a closed database.
  if (updateInterval) clearInterval(updateInterval);
  if (backupInterval) clearInterval(backupInterval);
  if (gmailInterval) clearInterval(gmailInterval);
  globalShortcut.unregisterAll();
  if (tray) { try { tray.destroy(); } catch {} tray = null; }
  stopServer();
  db.close();
});
