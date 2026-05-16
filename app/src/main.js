// JAT v10 desktop companion — Electron main process.
// Skeleton: opens one window showing connection status, starts a tiny HTTP
// server on http://localhost:7744 exposing GET /health. Nothing else.

const { app, BrowserWindow } = require('electron');
const path = require('path');
const { startServer, stopServer } = require('./server');

const PORT = 7744;
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    title: 'Job Application Tracker v10',
    icon: path.join(__dirname, 'icons', process.platform === 'win32' ? 'icon.ico' : process.platform === 'darwin' ? 'icon.icns' : 'icon128.png'),
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'app', 'app.html'));
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
});

app.on('window-all-closed', () => {
  stopServer();
  if (process.platform !== 'darwin') app.quit();
});
