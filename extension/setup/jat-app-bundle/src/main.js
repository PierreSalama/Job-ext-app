// Electron entry. Boots SQLite + sync server, opens a single window pointed
// at src/index.html. Closing the window exits the app (no tray) — keeping
// it minimal per the spec.
//
// Protocol handler: registers jat9:// at startup so the Chrome extension can
// launch / focus / deep-link the app via chrome.tabs.create({ url: 'jat9://...' }).
// We also enforce single-instance — a second launch (e.g. from a jat9:// click
// while the app is already running) just focuses the existing window and
// routes the URL into the renderer.

const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Tray, Menu, globalShortcut, Notification } = require('electron');
const path = require('path');

const { JatDb } = require('./db.js');
const { startServer, PORT, setLocalBroadcast } = require('./server.js');

let mainWindow = null;
let tray = null;
let db = null;
let server = null;
// Stash any jat9:// URL captured before the window exists so we can route it
// once the renderer is ready.
let pendingProtocolUrl = null;

// ---- Single-instance + jat9:// protocol registration ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    // Windows / Linux: the protocol URL is somewhere in argv on the second
    // launch. Mac uses the 'open-url' event instead.
    const url = (argv || []).find((a) => typeof a === 'string' && a.startsWith('jat9://'));
    if (url) handleProtocolUrl(url);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Register as default handler for jat9://. On Windows the installer also
// writes the registry key (so launching from Chrome works even when the app
// isn't running), but doing it here keeps dev runs working too.
try {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('jat9', process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient('jat9');
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
const initialProtocolUrl = process.argv.find((a) => typeof a === 'string' && a.startsWith('jat9://'));
if (initialProtocolUrl) pendingProtocolUrl = initialProtocolUrl;

function handleProtocolUrl(url) {
  // Routes:
  //   jat9://open              → focus the window (default)
  //   jat9://job/<id>          → focus + tell renderer to open the job detail
  //   jat9://<other>           → focus + forward verbatim for future routes
  if (!url || typeof url !== 'string') return;
  const stripped = url.replace(/^jat9:\/\//i, '').replace(/\/+$/, '');
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

function createWindow() {
  const iconPath = path.join(__dirname, 'icons', 'icon128.png');
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

// v8: System tray
function setupTray() {
  try {
    const iconPath = path.join(__dirname, 'icons', 'icon.png');
    const img = nativeImage.createFromPath(iconPath);
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
    tray.setToolTip('Job Application Tracker v9');
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
  console.log(`[jat9] sync server listening on :${PORT} — db at ${dbPath}`);
  createWindow();
  setupTray();
  setupGlobalShortcuts();

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
