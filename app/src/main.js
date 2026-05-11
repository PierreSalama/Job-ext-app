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
const { startServer, PORT, setLocalBroadcast, setUpdateBridge } = require('./server.js');

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

app.whenReady().then(() => {
  const dbPath = path.join(app.getPath('userData'), 'jat5.sqlite3');
  db = new JatDb(dbPath);
  server = startServer(db);
  setLocalBroadcast(broadcastEvent);
  global.__jat = { db, server, broadcastEvent };
  console.log(`[jat8] sync server listening on :${PORT} — db at ${dbPath}`);
  createWindow();
  setupTray();
  setupGlobalShortcuts();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // v8: keep app alive in tray on Windows/Linux when window closes
  // (mac is already idiomatic with the dock running)
  // User must use the tray menu to quit explicitly.
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
});

app.on('before-quit', () => {
  try { server?.close(); } catch {}
  try { db?.close(); } catch {}
});
