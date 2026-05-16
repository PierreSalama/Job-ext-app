// JAT v10 desktop companion — Electron main process.
// Opens one window showing the dashboard, starts a tiny HTTP server on
// http://localhost:7744 (used by the extension to detect the app),
// and runs electron-updater so the app silently pulls newer releases from
// GitHub in the background and prompts for a restart when ready.

const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { startServer, stopServer } = require('./server');
const { autoUpdater } = require('electron-updater');

const PORT = 7744;
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
let mainWindow = null;
let updateInterval = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    title: 'Job Application Tracker v10',
    icon: path.join(__dirname, 'icons', process.platform === 'win32' ? 'icon.ico' : process.platform === 'darwin' ? 'icon.icns' : 'icon128.png'),
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'app', 'app.html'));
}

// ---------- Auto-updater ----------
// electron-updater pulls metadata from the GitHub `publish` config in
// package.json. On launch + every 4h it checks for a newer release, downloads
// the delta in the background using the `.blockmap` files we publish, and
// fires `update-downloaded` when ready. We then show a native dialog with a
// Restart-now / Later choice. If the user picks Later, the update is applied
// the next time the app quits (autoInstallOnAppQuit = true, the default).
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Logs are useful when chasing flaky updates — `electron-log` would be the
  // canonical choice but for the v10 skeleton plain console is enough.
  autoUpdater.logger = console;

  autoUpdater.on('error', (err) => {
    console.warn('[updater] error:', err?.message || err);
  });
  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] checking…');
  });
  autoUpdater.on('update-available', (info) => {
    console.log('[updater] update available:', info?.version);
  });
  autoUpdater.on('update-not-available', (info) => {
    console.log('[updater] up to date at v' + (info?.version || app.getVersion()));
  });
  autoUpdater.on('download-progress', (p) => {
    console.log(`[updater] downloading ${Math.round(p.percent)}% (${Math.round(p.bytesPerSecond / 1024)} kB/s)`);
  });
  autoUpdater.on('update-downloaded', (info) => {
    const result = dialog.showMessageBoxSync({
      type: 'info',
      title: 'Update ready',
      message: `Job Application Tracker v${info?.version} is ready to install.`,
      detail: 'Restart now to apply the update, or it will install the next time you quit the app.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result === 0) {
      // isSilent=true skips the installer UI; isForceRunAfter=true relaunches
      // the app immediately once the patch is applied.
      autoUpdater.quitAndInstall(true, true);
    }
  });

  // Initial check + recurring poll. Catch is important — without it a failed
  // network check would bubble as an uncaught rejection on the main process.
  autoUpdater.checkForUpdates().catch((e) => console.warn('[updater] initial check failed:', e?.message || e));
  updateInterval = setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, UPDATE_CHECK_INTERVAL_MS);
}

app.whenReady().then(async () => {
  try {
    await startServer(PORT, () => app.getVersion());
    console.log(`[JAT v10 app] HTTP server listening on http://localhost:${PORT}`);
  } catch (e) {
    console.error('[JAT v10 app] failed to start server', e);
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  // Only run the updater in packaged builds; dev runs (`npm start`) trip
  // electron-updater because there's no `app-update.yml` next to the binary.
  if (app.isPackaged) setupAutoUpdater();
});

app.on('window-all-closed', () => {
  stopServer();
  if (updateInterval) clearInterval(updateInterval);
  if (process.platform !== 'darwin') app.quit();
});
