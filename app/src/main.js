// Electron entry. Boots SQLite + sync server, opens a single window pointed
// at src/index.html. Closing the window exits the app (no tray) — keeping
// it minimal per the spec.
//
// Protocol handler: registers jat8:// at startup so the Chrome extension can
// launch / focus / deep-link the app via chrome.tabs.create({ url: 'jat8://...' }).
// We also enforce single-instance — a second launch (e.g. from a jat8:// click
// while the app is already running) just focuses the existing window and
// routes the URL into the renderer.

const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Tray, Menu, globalShortcut, Notification } = require('electron');
const path = require('path');

const { JatDb } = require('./db.js');
const { startServer, PORT, setLocalBroadcast, setUpdateBridge, destroyAllWs } = require('./server.js');

// v8.0.2: Auto-update via electron-updater (GitHub Releases backend).
// Reads provider config from package.json build.publish at build time.
let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch {}

let mainWindow = null;
let tray = null;
let db = null;
let server = null;
// Stash any jat8:// URL captured before the window exists so we can route it
// once the renderer is ready.
let pendingProtocolUrl = null;

// ---- Single-instance + jat8:// protocol registration ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    // Windows / Linux: the protocol URL is somewhere in argv on the second
    // launch. Mac uses the 'open-url' event instead.
    const url = (argv || []).find((a) => typeof a === 'string' && a.startsWith('jat8://'));
    if (url) handleProtocolUrl(url);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Register as default handler for jat8://. On Windows the installer also
// writes the registry key (so launching from Chrome works even when the app
// isn't running), but doing it here keeps dev runs working too.
try {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('jat8', process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient('jat8');
  }
} catch (e) {
  console.warn('[jat5] setAsDefaultProtocolClient failed:', e?.message || e);
}

// macOS protocol delivery
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleProtocolUrl(url);
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

// First-launch protocol delivery on Windows: the URL shows up in process.argv
const initialProtocolUrl = process.argv.find((a) => typeof a === 'string' && a.startsWith('jat8://'));
if (initialProtocolUrl) pendingProtocolUrl = initialProtocolUrl;

function handleProtocolUrl(url) {
  // Routes:
  //   jat8://open              → focus the window (default)
  //   jat8://job/<id>          → focus + tell renderer to open the job detail
  //   jat8://<other>           → focus + forward verbatim for future routes
  if (!url || typeof url !== 'string') return;
  const stripped = url.replace(/^jat8:\/\//i, '').replace(/\/+$/, '');
  console.log(`[jat5] protocol: ${url} (route="${stripped}")`);

  const dispatch = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const m = stripped.match(/^job\/([A-Za-z0-9_\-]+)$/);
    if (m) {
      mainWindow.webContents.send('jat-protocol', { route: 'job', id: m[1], raw: url });
    } else if (!stripped || stripped === 'open') {
      mainWindow.webContents.send('jat-protocol', { route: 'open', raw: url });
    } else {
      mainWindow.webContents.send('jat-protocol', { route: stripped, raw: url });
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };

  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    dispatch();
  } else {
    pendingProtocolUrl = url;
  }
}

// v8: resolve the icon path with user-override support. The user can drop a
// PNG/ICO at <userData>/custom-icon.png to replace the bundled one at runtime.
// (The compiled binary's icon is baked in by the installer, but the window +
// tray + taskbar icon are runtime-controllable.)
function resolveAppIcon() {
  try {
    const custom = path.join(app.getPath('userData'), 'custom-icon.png');
    if (require('fs').existsSync(custom)) return custom;
  } catch {}
  // Platform-preferred bundled icon
  if (process.platform === 'win32') {
    const ico = path.join(__dirname, 'icons', 'icon.ico');
    if (require('fs').existsSync(ico)) return ico;
  }
  return path.join(__dirname, 'icons', 'icon128.png');
}

function createWindow() {
  const iconPath = resolveAppIcon();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0e1116',
    icon: nativeImage.createFromPath(iconPath),
    titleBarStyle: 'hiddenInset',
    titleBarOverlay: { color: '#0e1116', symbolColor: '#e6e9ef', height: 28 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // preload uses ipcRenderer/fetch, not Node fs/etc.
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingProtocolUrl) {
      const u = pendingProtocolUrl;
      pendingProtocolUrl = null;
      handleProtocolUrl(u);
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function broadcastEvent(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('jat-event', msg);
  }
}

ipcMain.handle('jat:open-external', (_e, url) => {
  if (typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return false;
  return shell.openExternal(url).then(() => true).catch(() => false);
});

ipcMain.handle('jat:pick-folder', async () => {
  if (!mainWindow) return null;
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (r.canceled || !r.filePaths?.length) return null;
  return r.filePaths[0];
});

// v8: System tray — uses the same icon resolver as the window so user overrides apply.
function setupTray() {
  try {
    const img = nativeImage.createFromPath(resolveAppIcon());
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
    const menu = Menu.buildFromTemplate([
      { label: 'Open Job Tracker', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } else createWindow(); } },
      { label: 'Quick Add (Ctrl+Shift+J)', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); mainWindow.webContents.send('quick-add'); } } },
      { type: 'separator' },
      { label: 'Today\'s interviews', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.webContents.send('navigate', '#/calendar'); } } },
      { label: 'Inbox', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.webContents.send('navigate', '#/inbox'); } } },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ]);
    tray.setToolTip('Job Application Tracker v8');
    tray.setContextMenu(menu);
    tray.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } else createWindow(); });
  } catch (e) { console.warn('[v8] tray setup failed:', e.message); }
}

// v8: Global hotkey for quick-add
function setupGlobalShortcuts() {
  try {
    globalShortcut.register('CommandOrControl+Shift+J', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send('quick-add');
      } else {
        createWindow();
      }
    });
    console.log('[v8] global hotkey Ctrl+Shift+J registered');
  } catch (e) { console.warn('[v8] global shortcut failed:', e.message); }
}

// v8: User-customizable app icon. Renderer calls 'jat:pick-icon' to open a file
// picker, then we copy the chosen PNG into <userData>/custom-icon.png and
// hot-update the window + tray icons. Survives restarts.
ipcMain.handle('jat:pick-icon', async () => {
  if (!mainWindow) return { ok: false, error: 'No window' };
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Image (PNG/ICO/JPEG)', extensions: ['png', 'ico', 'jpg', 'jpeg'] }]
  });
  if (r.canceled || !r.filePaths?.length) return { ok: false, canceled: true };
  const src = r.filePaths[0];
  const dst = path.join(app.getPath('userData'), 'custom-icon.png');
  try {
    require('fs').copyFileSync(src, dst);
    const img = nativeImage.createFromPath(dst);
    if (mainWindow && !img.isEmpty()) mainWindow.setIcon(img);
    if (tray && !img.isEmpty()) tray.setImage(img.resize({ width: 16, height: 16 }));
    return { ok: true, path: dst };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('jat:reset-icon', async () => {
  try {
    const dst = path.join(app.getPath('userData'), 'custom-icon.png');
    if (require('fs').existsSync(dst)) require('fs').unlinkSync(dst);
    const img = nativeImage.createFromPath(resolveAppIcon());
    if (mainWindow) mainWindow.setIcon(img);
    if (tray) tray.setImage(img.resize({ width: 16, height: 16 }));
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});

// v8.0.5: Track the latest available update so the extension's HTTP probe
// can report it instantly without re-asking GitHub.
let _latestUpdate = { current: app.getVersion(), available: false, version: null, downloaded: false, downloadProgress: 0 };

// v8.0.2: Auto-updater plumbing
function setupAutoUpdater() {
  if (!autoUpdater) {
    console.warn('[v8] electron-updater not installed; skipping auto-update');
    // Still register a stub bridge so the extension gets a clean answer.
    setUpdateBridge({
      status: async () => ({ current: app.getVersion(), available: false, reason: 'electron-updater not bundled' }),
      check: async () => ({ ok: false, error: 'electron-updater not bundled' }),
      install: () => {}
    });
    return;
  }
  autoUpdater.autoDownload = true;          // download in background once a new version is detected
  autoUpdater.autoInstallOnAppQuit = true;  // apply on next quit/restart
  autoUpdater.on('checking-for-update', () => sendUpdateEvent('checking'));
  autoUpdater.on('update-available', (info) => {
    _latestUpdate = { current: app.getVersion(), available: true, version: info.version, downloaded: false, downloadProgress: 0 };
    sendUpdateEvent('available', { version: info.version });
  });
  autoUpdater.on('update-not-available', (info) => {
    _latestUpdate = { current: app.getVersion(), available: false, version: info?.version || null, downloaded: false, downloadProgress: 0 };
    sendUpdateEvent('current', { version: info?.version });
  });
  autoUpdater.on('error', (err) => sendUpdateEvent('error', { error: String(err?.message || err) }));
  autoUpdater.on('download-progress', (p) => {
    _latestUpdate.downloadProgress = Math.round(p.percent);
    sendUpdateEvent('progress', { percent: Math.round(p.percent), bps: p.bytesPerSecond });
  });
  autoUpdater.on('update-downloaded', (info) => {
    _latestUpdate.downloaded = true;
    _latestUpdate.version = info.version;
    sendUpdateEvent('downloaded', { version: info.version });
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update ready',
        message: `Version ${info.version} is downloaded and ready to install.`,
        detail: 'The app will restart and apply the update.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1
      }).then((r) => { if (r.response === 0) autoUpdater.quitAndInstall(); });
    }
  });
  // Background check on startup (silent) + every 6 hours
  setTimeout(() => { autoUpdater.checkForUpdatesAndNotify().catch(() => {}); }, 5000);
  setInterval(() => { autoUpdater.checkForUpdatesAndNotify().catch(() => {}); }, 6 * 60 * 60 * 1000);

  // v8.0.5: expose update controls to the HTTP server so the extension can
  // probe and trigger updates over localhost:7733.
  setUpdateBridge({
    status: async () => ({ ..._latestUpdate, current: app.getVersion() }),
    check: async () => {
      try {
        const r = await autoUpdater.checkForUpdates();
        const latestVersion = r?.updateInfo?.version;
        const available = !!latestVersion && latestVersion !== app.getVersion();
        _latestUpdate = { ..._latestUpdate, available, version: latestVersion || _latestUpdate.version };
        return { available, version: latestVersion, current: app.getVersion() };
      } catch (e) { return { available: false, error: String(e?.message || e), current: app.getVersion() }; }
    },
    install: () => { try { autoUpdater.quitAndInstall(); } catch (e) { console.warn(e); } }
  });
}

function sendUpdateEvent(name, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-event', { name, data: data || {} });
  }
}

ipcMain.handle('jat:check-updates', async () => {
  if (!autoUpdater) return { ok: false, error: 'electron-updater not available' };
  try {
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, version: r?.updateInfo?.version, available: r?.updateInfo && r.updateInfo.version !== app.getVersion() };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
});

ipcMain.handle('jat:install-update', () => {
  if (!autoUpdater) return false;
  autoUpdater.quitAndInstall();
  return true;
});

ipcMain.handle('jat:app-version', () => app.getVersion());

// v8: Native notification helper exposed to renderer
ipcMain.handle('notify', (_e, { title, body, urgent }) => {
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title: title || 'Job Tracker', body: body || '', urgency: urgent ? 'critical' : 'normal' });
      n.on('click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
      n.show();
      return true;
    }
  } catch (e) { console.warn('notify', e); }
  return false;
});

// v8.0.6: hardened boot. Every subsystem is wrapped so that a single failure
// (port already in use, native-module ABI mismatch, corrupt db, etc.) is
// surfaced as a friendly dialog instead of a silent process crash. The window
// is created FIRST so users can see what failed; sub-failures degrade
// gracefully rather than aborting the whole startup.
// v8.0.8: try to kill whatever process is holding the given TCP port. Used
// on relaunch when a previous instance left a zombie binding port 7733.
function tryKillPortHolder(port) {
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano -p tcp | findstr :${port}`, { encoding: 'utf8' });
      const pids = new Set();
      for (const line of out.split('\n')) {
        const m = line.match(/LISTENING\s+(\d+)/);
        if (m) pids.add(m[1]);
      }
      for (const pid of pids) {
        try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); console.log(`[v8] killed zombie PID ${pid} on port ${port}`); } catch {}
      }
    } else {
      const pid = execSync(`lsof -ti:${port}`, { encoding: 'utf8' }).trim();
      if (pid) { execSync(`kill -9 ${pid}`); console.log(`[v8] killed zombie PID ${pid} on port ${port}`); }
    }
  } catch (e) { /* port wasn't bound, or no permission */ }
}

function fatalDialog(title, detail, allowReinstall = true) {
  try {
    const buttons = allowReinstall ? ['Quit', 'Open log folder'] : ['Quit'];
    dialog.showMessageBoxSync({
      type: 'error',
      title,
      message: title,
      detail: detail + '\n\nIf this keeps happening, run the clean-uninstall script from the Chrome extension\'s setup folder and reinstall from a fresh release.',
      buttons,
      defaultId: 0
    });
  } catch {}
}

app.whenReady().then(async () => {
  // 1. Create the window FIRST (so the user has something on screen even if
  //    sub-systems fail) — but in a try because GPU init can throw.
  try { createWindow(); } catch (e) {
    console.error('[v8] createWindow failed:', e);
    fatalDialog('Window failed to open', String(e?.message || e));
    return app.exit(1);
  }

  // 2. Open the database with active recovery if it fails (corrupt sqlite,
  //    ABI mismatch from a botched update, etc.) — offer to reset rather
  //    than just showing a fatal dialog.
  const dbPath = path.join(app.getPath('userData'), 'jat5.sqlite3');
  const tryOpenDb = () => {
    try { db = new JatDb(dbPath); console.log(`[jat8] db at ${dbPath}`); return true; }
    catch (e) { console.error('[v8] db init failed:', e); return e; }
  };
  let dbResult = tryOpenDb();
  if (dbResult !== true) {
    const fs = require('fs');
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'Local database could not be opened',
      message: 'The Job Tracker database appears to be corrupted or from an incompatible version.',
      detail: `Error: ${String(dbResult?.message || dbResult)}\n\nOptions:\n  • Reset database — wipes local jobs/settings, then continues with a fresh DB\n  • Continue without DB — app starts but nothing persists (read-only state)\n  • Quit`,
      buttons: ['Reset database', 'Continue without DB', 'Quit'],
      defaultId: 0,
      cancelId: 2
    });
    if (choice === 0) {
      try {
        for (const ext of ['', '-shm', '-wal']) { try { fs.unlinkSync(dbPath + ext); } catch {} }
        dbResult = tryOpenDb();
        if (dbResult !== true) {
          fatalDialog('Still could not open the database', String(dbResult?.message || dbResult), false);
        }
      } catch (e) { fatalDialog('Reset failed', String(e?.message || e), false); }
    } else if (choice === 2) {
      return app.quit();
    }
    // choice === 1: continue with db = null
  }

  // 3. Start the local HTTP/WS server. If port 7733 is already taken (usually
  //    a zombie instance from a crashed previous run), retry with backoff —
  //    Node's http.server.close() only stops *accepting* new connections,
  //    sockets already open keep the port bound for several seconds.
  if (db) {
    const startWithRetry = async () => {
      // v8.0.9: silent retry — no dialog flashes, no user-visible noise.
      // Try aggressively to clear the zombie port and start cleanly.
      // Only show a dialog if all attempts fail.
      for (let attempt = 1; attempt <= 8; attempt++) {
        try {
          server = startServer(db);
          setLocalBroadcast(broadcastEvent);
          console.log(`[jat8] sync server listening on :${PORT} (attempt ${attempt})`);
          return true;
        } catch (e) {
          const portInUse = /EADDRINUSE|address already in use/i.test(String(e?.message || e));
          if (!portInUse) { console.error('[v8] server start failed:', e); return false; }
          if (attempt < 8) {
            console.warn(`[v8] port :${PORT} busy (attempt ${attempt}/8), retrying…`);
            // Kill the zombie on attempt 1 (immediately) and again on 4 (in case it respawned).
            if (attempt === 1 || attempt === 4) tryKillPortHolder(PORT);
            await new Promise((r) => setTimeout(r, 800));
          } else {
            // Final failure — present a clear actionable dialog with three buttons.
            const choice = dialog.showMessageBoxSync({
              type: 'warning',
              title: `Port ${PORT} is in use`,
              message: `Another process is using port ${PORT}.`,
              detail: 'Likely a previous instance of Job Application Tracker that didn\'t exit cleanly.\n\nOptions:\n  • Retry — try to free the port and continue\n  • Continue without sync — start the app anyway (Chrome extension won\'t connect until you restart)\n  • Quit',
              buttons: ['Retry', 'Continue without sync', 'Quit'],
              defaultId: 0,
              cancelId: 2
            });
            if (choice === 0) {
              tryKillPortHolder(PORT);
              await new Promise((r) => setTimeout(r, 2000));
              return startWithRetry();
            }
            if (choice === 2) { app.quit(); return false; }
            return false; // 1 = continue without sync
          }
        }
      }
      return false;
    };
    await startWithRetry();
  }

  global.__jat = { db, server, broadcastEvent };

  // 4. Each optional subsystem isolated — failures degrade gracefully.
  try { setupTray(); } catch (e) { console.warn('[v8] tray failed:', e.message); }
  try { setupGlobalShortcuts(); } catch (e) { console.warn('[v8] hotkey failed:', e.message); }
  try { setupAutoUpdater(); } catch (e) { console.warn('[v8] updater failed:', e.message); }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      try { createWindow(); } catch (e) { console.error('[v8] activate createWindow failed:', e); }
    }
  });
}).catch((e) => {
  console.error('[v8] whenReady failed:', e);
  fatalDialog('App failed to initialize', String(e?.message || e), false);
  app.exit(1);
});

// v8.0.6: catch any unhandled rejection late in startup
process.on('uncaughtException', (e) => {
  console.error('[v8] uncaughtException:', e);
  try { fatalDialog('Unexpected error', String(e?.message || e), false); } catch {}
});

app.on('window-all-closed', () => {
  // v8.0.9: close = quit. Previous behavior (stay in tray) confused users
  // — they thought the app was closed but it kept port 7733 bound, so the
  // next "launch" hit the single-instance lock and looked broken. macOS
  // gets the standard dock-stays-running idiom.
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
});

app.on('before-quit', () => {
  // v8.0.8: actively destroy keep-alive sockets + WS connections so port 7733
  // releases immediately. Without this, the WS keeps the port bound for
  // 30-60s, causing EADDRINUSE on quick relaunch (= "app breaks, reinstall").
  try {
    try { destroyAllWs(); } catch {}
    if (server) {
      try { server.closeAllConnections?.(); } catch {}
      try { server.closeIdleConnections?.(); } catch {}
      try { server.close(); } catch {}
      server = null;
    }
  } catch {}
  try { db?.close(); db = null; } catch {}
});
