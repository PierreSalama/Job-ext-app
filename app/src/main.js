// JAT v11 — Electron main process.
// Single instance, tray-resident (close-to-tray keeps capture alive),
// token-guarded REST+SSE server on 127.0.0.1:7744, electron-updater,
// global hotkey, in-app notifications (toasts pushed over SSE — never native OS
// popups), daily backups, Gmail sync scheduler.

const {
  app, BrowserWindow, Tray, Menu, dialog, globalShortcut,
  ipcMain, nativeImage, shell, powerMonitor,
} = require('electron');
const path = require('path');
const crypto = require('crypto');
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
let emailInterval = null;
let emailWarmup = null;
let isQuitting = false;
let suspended = false;       // machine asleep → pause all background work
let maintenanceInterval = null;

// Industry-norm guard for BACKGROUND work (email/gmail sync): don't run while the
// machine is asleep, optionally pause on battery, and skip if our own memory is high
// (so we never become the process that overstresses a laptop).
function shouldRunBackground() {
  if (suspended) return false;
  try {
    const m = db.getSettings().maintenance || {};
    if (m.pauseBackgroundOnBattery && powerMonitor.isOnBatteryPower && powerMonitor.isOnBatteryPower()) return false;
    const rssMB = process.memoryUsage().rss / (1024 * 1024);
    if (rssMB > (m.memoryGuardMB || 1400)) { log.warn(`skipping background tick — RSS ${Math.round(rssMB)}MB over guard`); return false; }
  } catch {}
  return true;
}

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
  // Any link/button that opens an external URL → the user's DEFAULT browser, never
  // an in-app Electron window and never a navigation away from the dashboard. This
  // catches window.open, target="_blank", and plain <a href="http…"> clicks alike.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (/^https?:\/\//i.test(url)) { e.preventDefault(); shell.openExternal(url); }   // hash routing is in-page; only real off-app nav hits this
  });
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

// A catastrophic startup failure (DB won't open, port taken) is shown in a small
// custom window — never a native dialog.showErrorBox. Closing it quits the app.
function showFatalError(title, detail) {
  try {
    const w = new BrowserWindow({
      width: 520, height: 360, title: 'Job Application Tracker', icon: iconPath(),
      backgroundColor: '#0a0a0a', resizable: false, minimizable: false, maximizable: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    w.removeMenu();
    w.loadFile(path.join(__dirname, 'fatal.html'), { query: { title: String(title || 'Error'), detail: String(detail || '') } });
    w.on('closed', () => { isQuitting = true; app.quit(); });
  } catch { isQuitting = true; app.quit(); }
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
        showWindow();
        const r = await manualCheckForUpdates();
        const body = r.status === 'dev' ? 'Updates are only checked in the installed app.'
          : r.status === 'current' ? `You're on the latest version (v${r.current}).`
          : (r.status === 'available' || r.status === 'downloaded') ? `Update v${r.version} found — downloading in the background. You'll be prompted to restart when it's ready.`
          : r.status === 'error' ? (r.error || 'Could not check for updates.')
          : 'Still checking — try again in a moment.';
        // Manual check → always give feedback (bypass the notifications gate) as an in-app toast.
        try { broadcast('notify.toast', { kind: 'updates', title: 'Updates', body, toastKind: r.status === 'error' ? 'danger' : 'info' }); } catch {}
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
// Delivered as in-app toasts over SSE — never as native OS notifications. If no
// dashboard window is open they're simply not shown (the user sees them next time
// the app is in front); state that needs action (a downloaded update) persists in
// updateState and re-renders as an in-app banner on the next open.
function notify(kind, title, body, toastKind = 'info') {
  try {
    const s = db.getSettings().notifications;
    const gate = { status: s.statusChanges, autoApply: s.autoApply, updates: s.updates, followUps: s.followUps };
    if (kind in gate && !gate[kind]) return;
    broadcast('notify.toast', { kind, title, body: String(body || '').slice(0, 240), toastKind });
  } catch {}
}

function notifyEvent(type, payload) {
  if (type === 'status' && payload?.job) {
    if (payload.action === 'created') {
      notify('status', 'Application captured', `${payload.job.title} — ${payload.job.company}`, 'success');
    } else if (payload.statusChanged) {
      notify('status', 'Status updated', `${payload.job.title}: ${payload.previousStatus} → ${payload.job.status}`, 'info');
    }
  }
  if (type === 'autoApply' && payload) {
    const msgs = {
      awaiting_review: 'An application is filled and waiting for your review.',
      awaiting_input: 'Auto-apply needs your input on a question it could not answer.',
      done: 'An application was submitted.',
      failed: `A queued application failed: ${payload.lastError || 'see transcript'}`,
    };
    const kinds = { awaiting_review: 'info', awaiting_input: 'warn', done: 'success', failed: 'danger' };
    if (msgs[payload.state]) notify('autoApply', 'Auto-apply', msgs[payload.state], kinds[payload.state] || 'info');
  }
}

// ---------- pairing consent (in-app modal, never a native dialog) ----------
// The server awaits this promise before granting the token. We surface the request
// to the dashboard two ways so it can't be missed: a live SSE 'pairing.request'
// (window already open) and a jat:pending-pair poll the renderer runs on boot
// (window was just opened by showWindow()). Times out → denied.
let pendingPair = null;   // { id, info:{client,origin}, resolve(allow), timer }
function confirmPair(info) {
  return new Promise((resolve) => {
    if (pendingPair) { try { pendingPair.resolve(false); } catch {} }   // supersede any stale request
    const id = crypto.randomUUID();
    const data = { id, client: String(info.client || 'unknown').slice(0, 60), origin: String(info.origin || '').slice(0, 200) };
    const finish = (allow) => {
      if (!pendingPair || pendingPair.id !== id) return;
      clearTimeout(pendingPair.timer);
      pendingPair = null;
      resolve(!!allow);
    };
    pendingPair = { id, info: { client: data.client, origin: data.origin }, resolve: finish, timer: setTimeout(() => finish(false), 60000) };
    showWindow();
    // Deliver the consent prompt ONLY to the trusted desktop renderer (never broadcast
    // it to other authed clients). If the window is still loading, the renderer's
    // boot-time jat:pending-pair poll picks it up; pairingShownId de-dupes any overlap.
    try {
      const wc = mainWindow && mainWindow.webContents;
      if (wc) {
        if (wc.isLoading()) wc.once('did-finish-load', () => { try { wc.send('jat:pairing-request', data); } catch {} });
        else wc.send('jat:pairing-request', data);
      }
    } catch {}
  });
}

// ---------- auto-updater ----------
const RELEASES_URL = 'https://github.com/PierreSalama/Job-ext-app/releases';
let updateState = { status: 'idle', current: null, version: null, percent: 0 };

// Push update state to every connected dashboard so it can render the in-app
// banner / status line. Never triggers a native popup.
function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  try { broadcast('updates.state', updateState); } catch {}
}

// A background check that no-ops in dev and when the user set mode:'manual'.
function maybeCheck() {
  if (!app.isPackaged) return;
  try { if (db.getSettings().autoUpdate.mode === 'manual') return; } catch {}
  autoUpdater.checkForUpdates().catch((e) => log.warn('[updater] check failed:', e?.message || e));
}

// ---- idle auto-install (the centerpiece) ----
// Install an ALREADY-DOWNLOADED update only when the machine is idle AND no auto-apply
// work is in flight, so a restart can NEVER interrupt an application mid-submit or yank
// focus from active work. A human "Later" opts out; only non-response triggers this.
let pendingInstall = null;      // { version, downloadedAt }
let autoInstallTimer = null;
let updateDeferred = false;     // user clicked "Later" → no unattended install for this version

function armIdleAutoInstall() {
  if (autoInstallTimer) clearInterval(autoInstallTimer);
  autoInstallTimer = setInterval(tryIdleInstall, 60 * 1000);
}
function tryIdleInstall() {
  try {
    const au = db.getSettings().autoUpdate;
    if (!pendingInstall || au.mode !== 'auto' || updateDeferred) return;
    // GATE 1: grace window — give a returning user the chance to see the banner first.
    if (Date.now() - pendingInstall.downloadedAt < (au.graceMinutes || 10) * 60000) return;
    // GATE 2: machine genuinely idle and not asleep, no pairing prompt open.
    if (suspended || pendingPair) return;
    let idleSec = 0;
    try { idleSec = powerMonitor.getSystemIdleTime(); } catch { return; }
    if (idleSec < (au.idleMinutes || 5) * 60) return;
    // GATE 3 (the data-safety gate): never restart while an application is running,
    // dispatched, or still queued for this run — only when the pool is fully drained.
    try {
      const aa = db.getSettings().autoApply;
      if (aa && aa.enabled) {
        const live = db.queueLive({ startedAt: aa.startedAt || '' });
        if (live.active > 0 || live.scheduled > 0 || live.queuedDepth > 0) return;
      }
    } catch { return; }
    log.info('[updater] idle + safe → auto-installing update', pendingInstall.version);
    clearInterval(autoInstallTimer); autoInstallTimer = null;
    isQuitting = true;
    autoUpdater.quitAndInstall(true, true);   // silent install + relaunch into the new version
  } catch (e) { log.warn('[updater] idle install check failed', e?.message || e); }
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = rootLog;
  updateState.current = app.getVersion();

  autoUpdater.on('error', (err) => {
    log.warn('[updater] error:', err?.message || err);
    setUpdateState({ status: 'error', error: String(err?.message || err) });
  });
  autoUpdater.on('checking-for-update', () => setUpdateState({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    log.info('[updater] update available:', info?.version);
    updateDeferred = false;   // a NEW version resets any prior "Later"
    setUpdateState({ status: 'downloading', version: info?.version, percent: 0 });
    // Announce the moment an update is detected (it downloads in the background) —
    // as an in-app toast, never a native OS notification.
    notify('updates', 'Update available', `Job Application Tracker v${info?.version} is downloading — you'll be prompted to restart when it's ready.`);
  });
  autoUpdater.on('update-not-available', () => setUpdateState({ status: 'current' }));
  autoUpdater.on('download-progress', (p) => setUpdateState({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => {
    setUpdateState({ status: 'downloaded', version: info?.version });
    notify('updates', 'Update ready', `v${info?.version} downloaded — restart to apply (it auto-installs once your machine is idle).`, 'success');
    showWindow();   // bring the dashboard forward so the in-app "Restart now" banner is visible
    pendingInstall = { version: info?.version, downloadedAt: Date.now() };
    armIdleAutoInstall();
  });

  const everyMs = (() => { try { return Math.max(15, db.getSettings().autoUpdate.checkEveryMinutes || 30) * 60000; } catch { return 30 * 60000; } })();
  maybeCheck();
  updateInterval = setInterval(maybeCheck, everyMs);

  // Also check when the window regains focus (throttled to every 10min) so a release
  // is noticed within minutes of the user being active, not just on the slow interval.
  try {
    if (mainWindow) {
      let lastFocusCheck = 0;
      mainWindow.on('focus', () => {
        try { if (db.getSettings().autoUpdate.checkOnFocus === false) return; } catch {}
        if (Date.now() - lastFocusCheck < 10 * 60000) return;
        lastFocusCheck = Date.now();
        maybeCheck();
      });
    }
  } catch {}
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
    if (!shouldRunBackground()) return;
    try {
      const gmail = require('./gmail');
      const r = await gmail.syncNow();
      if (r.ok && r.updated) broadcast('jobs.updated', { action: 'gmail-sync' });
    } catch (e) { log.warn('gmail tick failed', e.message); }
  }, everyMs);
  log.info(`gmail sync scheduled every ${everyMs / 60000}m`);
}

// ---------- email scheduler (multi-provider IMAP, resumable) ----------
// Ticks every few minutes; each account resumes from its DB cursor, so it keeps
// chipping through the mailbox over time and picks up where it left off after the
// app is closed + reopened. Only runs when at least one account is connected.
function scheduleEmailSync() {
  if (emailInterval) clearInterval(emailInterval);
  if (emailWarmup) { clearTimeout(emailWarmup); emailWarmup = null; }
  let email;
  try { email = require('./email'); } catch { return; }
  if (!email.listAccounts().some((a) => a.enabled && a.password)) return;
  const everyMs = Math.max(3, (db.getSettings().email && db.getSettings().email.syncIntervalMinutes) || 15) * 60000;
  const tick = async () => {
    if (!shouldRunBackground()) return;
    try {
      const r = await email.syncAll();
      if (r && r.ok && r.results.some((x) => x.created)) { broadcast('jobs.updated', { action: 'email-sync' }); broadcast('emails.updated', {}); }
    } catch (e) { log.warn('email sync tick failed', e.message); }
  };
  emailInterval = setInterval(tick, everyMs);
  emailWarmup = setTimeout(tick, 8000);   // a first pass shortly after (re)connect/startup
  // guard the broadcast: only refresh the UI when a tick actually pulled new mail.
  log.info(`email sync scheduled every ${everyMs / 60000}m`);
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
  scheduleEmailSync();
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
// User clicked "Later" on the in-app update banner → suppress the unattended idle
// install for this version (an explicit human choice beats idle auto-install).
ipcMain.handle('jat:update-later', () => { updateDeferred = true; return true; });
ipcMain.handle('jat:pick-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder to index', properties: ['openDirectory'],
  });
  return (r.canceled || !r.filePaths?.length) ? null : r.filePaths[0];
});
// Pairing consent (answered by the in-app modal in the dashboard).
ipcMain.handle('jat:pending-pair', () => (pendingPair ? { id: pendingPair.id, ...pendingPair.info } : null));
ipcMain.handle('jat:pair-respond', (_e, id, allow) => { if (pendingPair && pendingPair.id === id) pendingPair.resolve(!!allow); });

// ---------- lifecycle ----------
app.whenReady().then(async () => {
  try {
    db.open(app.getPath('userData'));
  } catch (e) {
    log.error('failed to open DB', e);
    showFatalError('Database error', 'Could not open the JAT database:\n' + e.message + '\n\nIf this keeps happening, check the logs from the tray or app data folder.');
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
    // Without the server there is no backend for the dashboard — show the reason in
    // a custom window (closing it quits, which cleans up via will-quit) rather than
    // a native error box.
    showFatalError('Port in use',
      `JAT could not listen on 127.0.0.1:${port} (${e.code || e.message}).\n\n` +
      'Another program is using that port. Close it, or change the port in Settings → General, then restart.');
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

  // Self-care: prune stale data + compact the DB shortly after launch (don't block
  // startup) and once a day after that.
  setTimeout(() => { try { db.maintenance(); } catch (e) { log.warn('maintenance failed', e.message); } }, 25000);
  maintenanceInterval = setInterval(() => { try { db.maintenance(); } catch (e) { log.warn('maintenance failed', e.message); } }, 24 * 3600 * 1000);

  // Laptop-friendly: pause all background work while the machine sleeps; resume on
  // wake (each sync resumes from its own cursor, so nothing is lost or doubled).
  try {
    powerMonitor.on('suspend', () => { suspended = true; log.info('system suspend — pausing background work'); });
    powerMonitor.on('resume', () => { suspended = false; log.info('system resume — background work re-enabled'); scheduleEmailSync(); maybeCheck(); });
  } catch (e) { log.warn('powerMonitor unavailable', e.message); }

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
  if (autoInstallTimer) clearInterval(autoInstallTimer);
  if (backupInterval) clearInterval(backupInterval);
  if (gmailInterval) clearInterval(gmailInterval);
  if (emailInterval) clearInterval(emailInterval);
  if (emailWarmup) clearTimeout(emailWarmup);
  if (maintenanceInterval) clearInterval(maintenanceInterval);
  globalShortcut.unregisterAll();
  if (tray) { try { tray.destroy(); } catch {} tray = null; }
  stopServer();
  db.close();
});
