// JAT v11 — Electron main process.
// Single instance, tray-resident (close-to-tray keeps capture alive),
// token-guarded REST+SSE server on 127.0.0.1:7744, electron-updater,
// global hotkey, in-app notifications (toasts pushed over SSE — never native OS
// popups), daily backups, Gmail sync scheduler.

const {
  app, BrowserWindow, Tray, Menu, dialog, globalShortcut,
  ipcMain, nativeImage, shell, powerMonitor, powerSaveBlocker, Notification,
} = require('electron');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { startServer, stopServer, getToken, broadcast, rescanAllFolders, startFolderWatchers, ingestDiscoveredJobs } = require('./server');
const sessionSync = require('./session-sync');
const { createDiscoveryService } = require('./discovery');
const { createAtsBoardsService } = require('./discovery/ats-boards');
const { decideSchedule } = require('./schedule');
const db = require('./db');
const { autoUpdater } = require('electron-updater');
const { scope, log: rootLog } = require('./logger');

const log = scope('main');
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

// Test isolation (same convention as v13): JAT_USERDATA points the whole app (db, logs, backups)
// at a scratch dir so dev/test runs never touch the real jat11-app data. Unset = normal behavior.
if (process.env.JAT_USERDATA) app.setPath('userData', process.env.JAT_USERDATA);

// A SECOND instance on the same machine (the laptop running Dad's search alongside Pierre's)
// sets JAT_PORT so it doesn't collide with the first on the default 7744. Falls back to the
// stored setting. Paired with JAT_USERDATA, this makes a fully isolated co-resident instance.
function effectivePort() {
  const env = parseInt(process.env.JAT_PORT || '', 10);
  if (env > 0 && env < 65536) return env;
  try { return db.getSettings().server.port; } catch { return 7744; }
}

// Last-resort crash guards: a background subsystem (e.g. a child-process spawn ENOENT,
// a rejected promise deep in the AI chain) must NEVER take the whole app down. Dad's
// logs showed an uncaughtException from `spawn ollama ENOENT`. Log and keep running.
process.on('uncaughtException', (e) => { try { log.error('uncaughtException (survived)', e); } catch {} });
process.on('unhandledRejection', (e) => { try { log.warn('unhandledRejection (survived)', e); } catch {} });

let mainWindow = null;
let tray = null;
let updateInterval = null;
let backupInterval = null;
let gmailInterval = null;
let gmailWatchdogInterval = null;
let emailInterval = null;
let emailWarmup = null;
let isQuitting = false;
let suspended = false;       // machine asleep → pause all background work
let maintenanceInterval = null;
let ghostSweepInterval = null;
let discoveryService = null;
let atsBoardsService = null;
let keepAwakeId = null;
let pipelineWatchdogInterval = null;
let scheduleInterval = null;

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

  // CRASH RECOVERY (the 8h "black screen"): after a long run the RENDERER process can die
  // (GPU fault / OOM) while the main process + server keep running — the window goes black and a
  // relaunch just re-showed the same dead renderer (single-instance lock → showWindow), so the
  // user was stuck until a hard kill. Auto-reload on any renderer death/hang so it self-heals.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log.error('renderer gone:', (details && details.reason) || '?', '— reloading the dashboard');
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload(); } catch {}
  });
  // HEAP OBSERVABILITY — the dashboard renderer OOM-crashes over hours; we can't profile it
  // remotely, so sample the renderer's JS heap + DOM size + current route every 60s. A climbing
  // usedJSHeapSize toward jsHeapSizeLimit (and which route it grows on) pinpoints the leak for the
  // next fix instead of guessing. Cheap, read-only, and torn down with the window.
  const heapTimer = setInterval(async () => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const m = await mainWindow.webContents.executeJavaScript(
        '({h:(performance.memory&&performance.memory.usedJSHeapSize)||0,lim:(performance.memory&&performance.memory.jsHeapSizeLimit)||0,route:location.hash||"#/",nodes:document.getElementsByTagName("*").length})',
        true);
      if (m && m.h) log.info(`[heap] used=${Math.round(m.h / 1048576)}MB/${Math.round(m.lim / 1048576)}MB nodes=${m.nodes} route=${m.route}`);
    } catch {}
  }, 60000);
  mainWindow.on('closed', () => { try { clearInterval(heapTimer); } catch {} });
  mainWindow.on('unresponsive', () => {
    log.warn('window unresponsive — reloading the dashboard');
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload(); } catch {}
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    if (code === -3) return;   // user-aborted / in-page hash nav — not a failure
    log.warn('did-fail-load', code, desc, '— retrying load');
    setTimeout(() => { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadFile(path.join(__dirname, 'app', 'app.html')); } catch {} }, 800);
  });

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
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  // If a relaunch ("restart") lands here because the single instance is already running, make sure
  // we don't just re-show a CRASHED/black renderer — reload it so the user actually gets the app.
  try { if (mainWindow.webContents.isCrashed()) mainWindow.reload(); } catch {}
  mainWindow.show();
  mainWindow.focus();
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

// A NATIVE OS notification (Windows Action Center / macOS Notification Center) — used for
// auto-apply OUTCOMES so a submitted/failed/needs-you application is visible even when the
// dashboard window isn't in front. Silently no-ops where the platform can't show one.
// Clicking it brings the app window forward.
function nativeNotify(title, body) {
  try {
    if (!Notification || !Notification.isSupported || !Notification.isSupported()) return;
    const n = new Notification({ title: String(title || 'Auto-apply'), body: String(body || '').slice(0, 240), silent: false });
    n.on('click', () => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
      } catch {}
    });
    n.show();
  } catch {}
}

// ---------- AI Apply alert bridge ----------
// Alerts are the blocks that STOP a run: a human check, an account wall, a password, an expired
// CLI login. They get a native OS notification (so a full-screen game does not hide them) AND an
// in-app toast, and each one is announced exactly once, ever.
let alertWatcher = null;
let providerHealth = null;
function startAlertWatcher() {
  if (alertWatcher) return alertWatcher;
  const { makeAlertWatcher, peerFetcher } = require('./ai/alerts');

  // Minimal authed GET against a peer node. Kept here rather than in alerts.js so that module
  // stays free of transport concerns and can be tested without a network.
  const httpJson = async (url, token) => {
    const res = await fetch(url, {
      headers: { 'X-JAT-Token': token || '' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  alertWatcher = makeAlertWatcher({
    db,
    fetchPeer: peerFetcher(httpJson),
    selfName: 'this computer',
    nodes: () => {
      try { return (db.getSettings().nodes || []).filter((n) => n && n.baseUrl && n.token); }
      catch { return []; }
    },
    onAlert: ({ title, body }) => {
      nativeNotify(title, body);
      try { broadcast('notify.toast', { kind: 'autoApply', title, body, toastKind: 'danger' }); } catch {}
    },
  });
  alertWatcher.start();
  return alertWatcher;
}

// Nothing was watching whether this machine could still think. AI Apply reached the server laptop
// and could not take a step: both CLIs installed, neither signed in, the Codex token five weeks
// expired, and no sign of any of it anywhere. The alert already existed. This gives it a source.
function startProviderHealth() {
  if (providerHealth) return providerHealth;
  const { makeProviderHealth } = require('./ai/provider-health');
  const provider = require('./ai/provider');
  providerHealth = makeProviderHealth({
    db,
    statusAll: (force) => provider.statusAll(force),
    machine: os.hostname(),
    onBlock: (block) => { try { broadcast('ai.block', { block }); } catch {} },
  });
  providerHealth.start();
  return providerHealth;
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
    // Name the actual application in every notification (the task row only carries jobId).
    let jobLabel = '';
    try {
      const j = payload.jobId ? db.getJob(payload.jobId) : null;
      if (j) jobLabel = [j.title, j.company].filter(Boolean).join(' — ');
    } catch {}
    const msgs = {
      awaiting_review: 'An application is filled and waiting for your review.',
      awaiting_input: 'Auto-apply needs your input on a question it could not answer.',
      done: 'An application was submitted.',
      failed: `A queued application failed: ${payload.lastError || 'see transcript'}`,
    };
    const kinds = { awaiting_review: 'info', awaiting_input: 'warn', done: 'success', failed: 'danger' };
    if (msgs[payload.state]) {
      notify('autoApply', 'Auto-apply', jobLabel ? `${jobLabel} — ${msgs[payload.state]}` : msgs[payload.state], kinds[payload.state] || 'info');
    }
    // The second, always-visible notification (Pierre's ask): a NATIVE OS popup on EVERY
    // outcome — success or not — gated by notifications.autoApplyDesktop (default on).
    try {
      const s = db.getSettings().notifications;
      if (s.autoApply !== false && s.autoApplyDesktop !== false) {
        const native = {
          done:            { t: '✅ Application submitted',        b: jobLabel || 'An application was submitted.' },
          awaiting_review: { t: '📝 Filled — needs your review',    b: jobLabel || 'An application is waiting for your review.' },
          awaiting_input:  { t: '❓ Auto-apply needs your answer',   b: jobLabel || 'A question could not be answered automatically.' },
          parked:          { t: '⏸ Application parked',             b: (jobLabel ? jobLabel + ' — ' : '') + (payload.parkReason || payload.lastError || 'needs your input') },
          failed:          { t: '⚠ Application failed',             b: (jobLabel ? jobLabel + ' — ' : '') + (payload.lastError || 'see transcript') },
        };
        const nd = native[payload.state];
        if (nd) nativeNotify(nd.t, nd.b);
      }
    } catch {}
  }
  // SIGNED OUT OF LINKEDIN — the one state only Pierre can clear.
  //
  // The signed-out latch (v11.90.13) correctly halts LinkedIn dispatch the moment the executor sees
  // the sign-in wall, which is what stops a repeat of the 31-hour outage that started this work. But
  // the notify hook wired alongside it dispatched a type NOTHING here handled, so it silently did
  // nothing: on 2026-08-09 the PC sat halted and signed out for 81 minutes with 23 LinkedIn jobs
  // held back and no signal to anyone. Halting without telling him turns a loud failure into a quiet
  // one — the node looks alive and simply produces nothing.
  //
  // Deliberately BOTH channels: the in-app feed for history, and a native OS popup because this
  // requires him to act. server.js fires this only on the clear→set transition, so it cannot spam
  // once per held task.
  // ACCOUNT RESTRICTED — the loudest thing this app can say. Auto-apply and discovery are already
  // stopped by the time this fires; the alert exists so Pierre learns within seconds rather than
  // whenever he next glances at a screen (2026-08-10: he found the restriction himself, unaided).
  if (type === 'accountRestricted') {
    const msg = 'LinkedIn has restricted this account. Auto-apply and discovery are STOPPED and will not resume on their own. Do not restart until the restriction lifts.';
    notify('autoApply', 'LinkedIn account restricted', msg, 'danger');
    try { nativeNotify('⛔ LinkedIn account restricted', msg); } catch {}
  }
  if (type === 'signedOut') {
    const msg = 'Auto-apply is halted: this browser is signed out of LinkedIn. Sign in and it resumes by itself.';
    notify('autoApply', 'Signed out of LinkedIn', msg, 'danger');
    try { nativeNotify('🔴 Signed out of LinkedIn', msg); } catch {}
  }
}

// ---------- pairing consent (in-app modal, never a native dialog) ----------
// The server awaits this promise before granting the token. We surface the request
// to the dashboard two ways so it can't be missed: a live SSE 'pairing.request'
// (window already open) and a jat:pending-pair poll the renderer runs on boot
// (window was just opened by showWindow()). Times out → denied.
let pendingPair = null;   // { id, info:{client,origin}, resolve(allow), timer }

// Unattended-setup auto-approve: during the USB setup script's run, the app must pair the script
// AND the force-installed extension with ZERO clicks. The script drops a sentinel file
// <userData>/.setup-autopair before launching the app; while it exists and is fresh (< 15 min),
// every pairing request is auto-approved (and logged). The window closes itself after that TTL, so
// this can never silently auto-approve later — it's a one-time, time-boxed setup convenience.
const SETUP_AUTOPAIR_TTL_MS = 15 * 60 * 1000;
function setupAutopairActive() {
  try {
    const f = path.join(app.getPath('userData'), '.setup-autopair');
    const st = require('fs').statSync(f);
    if (Date.now() - st.mtimeMs < SETUP_AUTOPAIR_TTL_MS) return true;
    try { require('fs').unlinkSync(f); } catch {}   // expired → clean it up
  } catch {}
  return false;
}

function confirmPair(info) {
  // Unattended setup window: approve immediately, no modal (the script + extension pair silently).
  if (setupAutopairActive()) {
    try { log.info('pairing auto-approved (setup window)', { client: String(info.client || '').slice(0, 60), origin: String(info.origin || '').slice(0, 200) }); } catch {}
    return Promise.resolve(true);
  }
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

// A background check that no-ops in dev, when the user set mode:'manual', and ALWAYS when
// mode:'pinned' — a pinned machine never even asks the release feed (Dad's laptop stays on
// its installed version until the setting is changed in person).
function maybeCheck() {
  if (!app.isPackaged) return;
  try {
    const m = db.getSettings().autoUpdate.mode;
    if (m === 'manual' || m === 'pinned') return;
  } catch {}
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
    // GATE 3 (the data-safety gate): never restart while an application is IN FLIGHT — running or
    // dispatched. Those have real state that a restart would lose.
    //
    // It used to also require queuedDepth === 0, which was a permanent deadlock: discovery refills
    // the queue continuously, so a healthy working node NEVER has an empty queue and could never
    // install an update. Live 2026-08-09: the PC downloaded 11.90.18 at 05:21 and was still on
    // 11.90.17 hours later, re-downloading the same installer every 30 minutes forever. Every
    // reliability fix we ship would silently never reach a node that was busy — i.e. exactly the
    // nodes that need them.
    //
    // A QUEUED task has not started: it carries no in-flight state, it survives the restart in the
    // database, and the pump picks it straight back up. Queue depth is not a safety signal.
    //
    // ESCALATION. Dropping queuedDepth improves the odds but does not GUARANTEE delivery: a healthy
    // node is applying almost continuously, so `active === 0 && scheduled === 0` is a narrow window
    // that a 60-second poll can miss indefinitely. Measured on the PC: active=1 on 11 of 12 samples
    // over five minutes. An update that never lands is the same bug in a slower disguise, so the
    // gate relaxes the longer an install has been waiting — the recovery passes that run at every
    // startup (reconcileStaleRunning, retryStaleQueue) exist precisely to pick these up.
    //   <4h  : fully safe — nothing in flight at all
    //   >=4h : allow a dispatched-but-not-started task to be reclaimed on restart
    //   >=12h: install regardless; a stuck update now costs more than one interrupted application
    try {
      const aa = db.getSettings().autoApply;
      if (aa && aa.enabled) {
        const waitingMs = Date.now() - (pendingInstall.downloadedAt || Date.now());
        const live = db.queueLive({ startedAt: aa.startedAt || '' });
        if (waitingMs < 4 * 3600000) {
          if (live.active > 0 || live.scheduled > 0) return;
        } else if (waitingMs < 12 * 3600000) {
          if (live.active > 0) return;
        } else if (live.active > 0) {
          log.warn(`[updater] update has waited ${Math.round(waitingMs / 3600000)}h — installing despite ${live.active} in-flight application(s); startup recovery will reclaim them`);
        }
      }
    } catch { return; }
    log.info('[updater] idle + safe → auto-installing update', pendingInstall.version);
    // Remember whether the engine was running, so the relaunch can restore it (see the
    // resume-after-update check in whenReady). Recorded HERE because this is the moment we choose
    // to restart — anything that clears the flag afterwards is exactly what we are compensating for.
    try { db.kvSet('autoApplyResumeAfterUpdate', (db.getSettings().autoApply || {}).enabled ? 1 : 0); } catch {}
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
  // pinned wins over even an explicit check — the machine is frozen on purpose.
  try {
    if (db.getSettings().autoUpdate.mode === 'pinned') {
      return Promise.resolve({ status: 'pinned', current: app.getVersion() });
    }
  } catch {}
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

// Tell the user their mail sync is dead, at most once every RENOTIFY_HOURS. Email is
// how every status past "submitted" is learned, so a silent sync means interviews and
// rejections stop arriving with no visible symptom — that is precisely how a broken
// refresh token went unnoticed for 31 days and 1,828 ticks. A native OS notification
// is used (not just a toast) because the dashboard window is usually closed.
const GMAIL_RENOTIFY_HOURS = 6;

function warnIfGmailBroken(gmail) {
  try {
    const h = gmail.health();
    const { stale, hours } = gmail.staleness();
    if (!stale) return;
    const last = h.lastNotifiedAt ? Date.parse(h.lastNotifiedAt) : 0;
    if (Date.now() - last < GMAIL_RENOTIFY_HOURS * 3600000) return;

    const since = Number.isFinite(hours)
      ? `No successful sync in ${Math.floor(hours)}h.`
      : 'It has never synced successfully.';
    // THE 7-DAY DEATH. Reconnecting fixes `invalid_grant` for exactly one week and then it dies
    // again — measured: re-authorised 2026-08-01, last success 2026-08-08 14:15, a 7.6-day life.
    // That is the signature of a Google Cloud OAuth consent screen still in TESTING status, where
    // refresh tokens are expired after 7 days by policy. Telling the user to "reconnect" is
    // therefore advice that guarantees a repeat, so say the actual fix here — the alert is the only
    // place he sees this, and neither of us should have to interpret it for him next time.
    const repeatOffender = h.needsAuth && /invalid_grant/i.test(String(h.lastError || ''));
    const why = repeatOffender
      ? 'Google expired the saved authorization (invalid_grant). If this keeps happening weekly, the OAuth consent screen is in "Testing" — publish it in Google Cloud Console (APIs & Services → OAuth consent screen → Publish app), then reconnect Gmail in Settings.'
      : h.needsAuth
        ? 'Google rejected the saved authorization — reconnect Gmail in Settings.'
        : (h.lastError || 'Unknown error.');

    log.warn('gmail sync unhealthy', { hours, consecutiveFailures: h.consecutiveFailures, error: h.lastError });
    nativeNotify('JAT: email sync is not working', `${since} ${why}`);
    notify('status', 'Email sync is not working', `${since} ${why}`, 'error');
    broadcast('gmail.unhealthy', { ...h, staleHours: hours });
    gmail.markNotified();
  } catch (e) { log.warn('gmail health check failed', e.message); }
}

// An INDEPENDENT watchdog. warnIfGmailBroken also runs from the sync tick, but that tick
// is itself part of what can fail: if gmailInterval is never armed, gets cleared, or the
// settings flip enabled without a restart, no tick ever runs and nothing would ever
// complain. This timer's only job is to notice that success has gone stale, so the
// alarm does not depend on the machinery it is watching.
function scheduleGmailWatchdog() {
  if (gmailWatchdogInterval) clearInterval(gmailWatchdogInterval);
  const check = () => { try { warnIfGmailBroken(require('./gmail')); } catch (e) { log.warn('gmail watchdog failed', e.message); } };
  setTimeout(check, 90 * 1000);                                  // once shortly after boot
  gmailWatchdogInterval = setInterval(check, 60 * 60 * 1000);     // then hourly
}

// ---------- company watchlist board poller ----------
//
// Polls the public ATS boards of the watched companies that HAVE one — measured 2026-08-10, that
// is two of twenty-seven (Syntronic and Kepler, both Lever). The other 25 run Workday /
// SuccessFactors / bespoke pages with no public board, which is also why broad discovery never
// surfaced them; those are on the manual list instead.
//
// Cadence is deliberately slow and jittered. Eleven days after LinkedIn restricted the account for
// discovery volume (281 searches/day), a new poller must not become the next thing throttled. Two
// requests, twice a day, is plenty for employers who post monthly.
let watchlistPollInterval = null;
const WATCHLIST_POLL_MS = 12 * 60 * 60 * 1000;   // twice a day

async function pollWatchlistBoards() {
  try {
    const watchlist = require('./watchlist');
    const s = db.getSettings().autoApply || {};
    const entries = (Array.isArray(s.watchlist) ? s.watchlist : []).filter((e) => e && e.board);
    if (!entries.length) return;

    const seen = new Set(db.kvGet('watchlistBoardSeen') || []);
    const before = seen.size;
    const { alerts, errors } = await watchlist.pollBoards({ entries, seen });
    // Cap the memo so it cannot grow without bound on a board that churns postings.
    db.kvSet('watchlistBoardSeen', [...seen].slice(-2000));
    if (errors.length) log.warn('watchlist poll errors:', errors.join('; '));
    if (!alerts.length) { log.info(`watchlist poll: no new postings (${before} known)`); return; }

    const list = db.kvGet('watchlistAlerts') || [];
    db.kvSet('watchlistAlerts', [...alerts, ...list].slice(0, 200));
    broadcast('watchlist.hit', { alerts });

    // One notification for the batch, naming the company and the contact — a per-posting popup
    // from a board that just opened six roles would be noise, and noise gets muted.
    const byCompany = [...new Set(alerts.map((a) => a.company))];
    const lead = alerts[0];
    nativeNotify(
      `${alerts.length} new opening${alerts.length === 1 ? '' : 's'} at ${byCompany.join(', ')}`,
      `${lead.title} — ${lead.location || 'location n/a'}${lead.contact ? `. Contact: ${lead.contact}` : ''}`,
    );
    notify('status', 'Watched company posted', `${alerts.length} new opening(s) at ${byCompany.join(', ')}`, 'info');
    log.info(`watchlist poll: ${alerts.length} new posting(s) at ${byCompany.join(', ')}`);
  } catch (e) { log.warn('watchlist poll failed', e.message); }
}

function scheduleWatchlistPoll() {
  if (watchlistPollInterval) clearInterval(watchlistPollInterval);
  // Jitter both the first run and the interval so the requests do not arrive on a metronome.
  const jitter = () => Math.round(WATCHLIST_POLL_MS * (0.85 + Math.random() * 0.3));
  setTimeout(() => { pollWatchlistBoards(); }, 3 * 60 * 1000 + Math.round(Math.random() * 120000));
  watchlistPollInterval = setInterval(() => { pollWatchlistBoards(); }, jitter());
}

// ---------- gmail scheduler ----------
function scheduleGmail() {
  if (gmailInterval) clearInterval(gmailInterval);
  const s = db.getSettings().gmail;
  if (!s.enabled) return;
  // Floor of 1 minute (was 5): near-real-time status updates are the whole point of the mail sync —
  // an incremental tick only ever fetches the handful of messages newer than the watermark, so a
  // 1-minute cadence is cheap and stays well inside Gmail's quota.
  const everyMs = Math.max(1, s.intervalMinutes || 30) * 60000;
  gmailInterval = setInterval(async () => {
    if (!shouldRunBackground()) return;
    try {
      const gmail = require('./gmail');
      const r = await gmail.syncNow();
      if (r.ok && r.updated) broadcast('jobs.updated', { action: 'gmail-sync' });
      if (!r.ok) warnIfGmailBroken(gmail);
    } catch (e) {
      log.warn('gmail tick failed', e.message);
      try { warnIfGmailBroken(require('./gmail')); } catch {}
    }
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
  scheduleGmailWatchdog();
  scheduleWatchlistPoll();
  try {
    const aa = db.getSettings().autoApply || {};
    const shouldBlock = !!aa.enabled && aa.keepAwake !== false;
    if (keepAwakeId != null && (!shouldBlock || !powerSaveBlocker.isStarted(keepAwakeId))) {
      try { powerSaveBlocker.stop(keepAwakeId); } catch {}
      keepAwakeId = null;
    }
    if (shouldBlock && keepAwakeId == null) {
      keepAwakeId = powerSaveBlocker.start(aa.keepDisplayAwake ? 'prevent-display-sleep' : 'prevent-app-suspension');
      log.info(`auto-apply keep-awake enabled (${aa.keepDisplayAwake ? 'display' : 'system'})`);
    }
  } catch (e) { log.warn('keep-awake update failed', e.message); }
}

// Apply the daily schedule. All the rules live in decideSchedule() (pure, node-tested); this only
// carries out its verdict and records the once-per-day ledger.
//
// It writes autoApply.enabled the same way the dashboard's Start/Stop button does, so the toggle
// audit attributes it and `startedAt` stays correct. When the verdict is null — which is almost
// always — it writes nothing at all. That is what lets Pierre override it: turning auto-apply off
// inside the window is simply left alone until tomorrow's boundary.
function scheduleTick() {
  const s = db.getSettings().autoApply || {};
  const sched = s.schedule || {};
  const verdict = decideSchedule(sched, new Date());
  if (!verdict.action) return;

  const want = verdict.action === 'on';
  const ledger = verdict.action === 'on' ? { lastOnDate: verdict.lastOnDate } : { lastOffDate: verdict.lastOffDate };

  // Stamp the ledger even when auto-apply is ALREADY in the wanted state, so the boundary is
  // consumed exactly once either way and we don't re-evaluate it every minute for the rest of the day.
  if (!!s.enabled === want) {
    db.patchSettings({ autoApply: { schedule: { ...sched, ...ledger } } });
    log.info(`[schedule] ${verdict.action} boundary (${verdict.reason}) — auto-apply already ${want ? 'on' : 'off'}, nothing to change`);
    return;
  }

  db.patchSettings({
    autoApply: {
      enabled: want,
      startedAt: want ? new Date().toISOString() : '',
      schedule: { ...sched, ...ledger },
    },
  });
  log.warn(`[schedule] auto-apply turned ${want ? 'ON' : 'OFF'} by the daily schedule (${sched.onAt}–${sched.offAt}, ${verdict.reason})`);
  broadcast('queue.updated', { action: 'schedule', to: want });
}

async function pipelineWatchdogTick() {
  if (!shouldRunBackground()) return;
  const aa = db.getSettings().autoApply || {};
  let repaired = 0;
  try { repaired += db.reconcileStaleRunning({ olderThanMinutes: 8 }); } catch {}
  try { repaired += db.reclaimDeadParks(); } catch {}
  // Self-heal the failed pile: recycle retriable failures back to 'queued' so a drained-but-
  // failed queue refills itself. Previously retryStaleQueue only ran opportunistically inside
  // queueNext (gated on enabled && empty live-queue, limit 10), so hundreds of action=retry
  // failures sat as 'failed' and the queue dispatched nothing. The pump still gates on
  // enabled/window/cap/gap, so this never causes an apply burst — it only keeps the queue
  // ready to drain whenever auto-apply is running. Environmental failures retry without
  // charging an attempt (see retryStaleQueue); a 24h ceiling retires truly-dead tasks.
  try { repaired += db.retryStaleQueue({ olderThanMinutes: 20, maxAttempts: 4, limit: 50 }); } catch {}
  // Retire tasks a host verification wall never released. Clearing these by hand was the single
  // most repeated manual intervention in this system (Indeed, most check-ups of 2026-08-07/08/09):
  // they can never dispatch, they hold queue slots, and before the refill-gate fix they also
  // starved discovery outright. A transient wall is untouched — only a full day of being
  // un-dispatchable retires a task.
  try {
    const retired = db.expireWalledTasks({ olderThanHours: 24 });
    if (retired) log.warn(`pipeline watchdog retired ${retired} task(s) stuck behind a host wall`);
    repaired += retired;
  } catch {}
  // Keep "needs you" a real signal. Parks that only ever held unanswerable content (combobox
  // screen-reader text, CAPTCHA gates, week-old site sign-in gates) bury the questions Pierre could
  // actually answer — live it was 86 parked jobs with almost nothing actionable in them.
  try {
    const cleared = db.retireUnanswerableParks({ loginAfterDays: 7 });
    if (cleared) log.warn(`pipeline watchdog retired ${cleared} unanswerable park(s)`);
    repaired += cleared;
  } catch {}
  // Release parks that have BECOME answerable. queueRetryParked only ever ran from the intake
  // endpoint — i.e. only when Pierre personally submitted an answer — so a task that became
  // retryable any other way (memory learned the answer from a different application, or its only
  // remaining blocker turned out to be non-question junk) stayed parked forever with nobody to
  // notice. That also made the junk-unblocking fix inert on its own. Recovery must not depend on
  // the user happening to type something.
  try {
    const requeued = db.queueRetryParked();
    if (requeued) log.warn(`pipeline watchdog requeued ${requeued} park(s) that are now answerable`);
    repaired += requeued;
  } catch {}
  const health = db.pipelineHealth();
  if (repaired) {
    log.warn(`pipeline watchdog repaired ${repaired} stranded task(s)`);
    broadcast('queue.updated', { action: 'watchdog-repair', repaired });
  }
  if (aa.enabled) {
    const live = db.queueLive({ startedAt: aa.startedAt || '' });
    if (!live.active && !live.queuedDepth && !live.scheduled) { discoveryService?.runTick().catch(() => {}); atsBoardsService?.runTick().catch(() => {}); }
  }
  broadcast('autoApply.health', health);
}

// ---------- IPC ----------
ipcMain.handle('jat:boot', () => ({
  token: getToken(),
  version: app.getVersion(),
  port: effectivePort(),
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
  // Windows attributes native notifications to this AppUserModelID; setting it explicitly
  // makes auto-apply outcome notifications show correctly in dev too (the installer sets it
  // for the packaged app). Harmless on macOS/Linux.
  try { app.setAppUserModelId('com.pierre.jat11'); } catch {}
  try {
    db.open(app.getPath('userData'));
    // Per-person Chrome profiles live beside the database, not in %TEMP%. They hold the LinkedIn
    // and ATS logins the agent depends on, and Windows cleans temp — a profile kept there would
    // silently sign both people out with nothing in the logs to explain the sudden login walls.
    try {
      require('./browser/cdp').setProfileRoot(path.join(app.getPath('userData'), 'chrome-profiles'));
    } catch (e) { log.warn('could not set the browser profile root', e.message); }
  } catch (e) {
    log.error('failed to open DB', e);
    showFatalError('Database error', 'Could not open the JAT database:\n' + e.message + '\n\nIf this keeps happening, check the logs from the tray or app data folder.');
    return;
  }

  // RESUME AUTO-APPLY AFTER AN UPDATE RESTART.
  // An auto-install deliberately quits and relaunches the app. On the PC, auto-apply was found OFF
  // after the restart four separate times on 2026-08-09, each needing a manual re-enable — the exact
  // kind of chore this loop exists to remove. I could not identify what clears it: the app's quit
  // path, migrations, the extension's automatic paths, a one-at-a-time enforcer and scheduled tasks
  // were all ruled out. So rather than guess at the cause, make the outcome survivable — if the
  // engine was running when we chose to restart, it must be running afterwards. tryIdleInstall
  // records the state immediately before quitAndInstall; we restore it here exactly once.
  try {
    if (Number(db.kvGet('autoApplyResumeAfterUpdate')) === 1) {
      db.kvSet('autoApplyResumeAfterUpdate', 0);
      const aa = db.getSettings().autoApply || {};
      if (!aa.enabled) {
        db.patchSettings({ autoApply: { enabled: true, startedAt: new Date().toISOString() } });
        log.warn('[updater] auto-apply was ON before the update restart but came back OFF — restored');
      } else {
        log.info('[updater] auto-apply survived the update restart');
      }
    }
  } catch (e) { log.warn('resume-after-update check failed', e?.message || e); }

  // Self-heal on startup: transient auto-apply failures that were misfiled as
  // awaiting_input/parked with no real question used to block discovery forever
  // (starving the queue to zero submits). Reclaim them to retriable 'failed'.
  try {
    const reclaimed = db.reclaimDeadParks();
    if (reclaimed) log.info(`reclaimed ${reclaimed} dead awaiting_input/parked task(s) → failed (retriable)`);
  } catch (e) { log.warn('reclaimDeadParks failed', e); }
  // Repair false "submitted" stamps left by passive capture on auto-apply tabs whose
  // application never actually completed (now prevented at the source in detector.js).
  try {
    const fixed = db.reconcileFalseSubmits();
    if (fixed) log.info(`reverted ${fixed} false auto-apply submit(s) → started`);
  } catch (e) { log.warn('reconcileFalseSubmits failed', e); }
  // Free any pool slots held by tasks stuck 'running'/'scheduled' from a previous run.
  try {
    const unstuck = db.reconcileStaleRunning({ olderThanMinutes: 8 });
    if (unstuck) log.info(`reconciled ${unstuck} stale running/scheduled task(s) → failed (retriable)`);
  } catch (e) { log.warn('reconcileStaleRunning failed', e); }
  try {
    const discoveryRepair = db.reconcileDiscovery({ olderThanMinutes: 10 });
    if (discoveryRepair.interrupted || discoveryRepair.staleClaims) log.info(`reconciled discovery: ${discoveryRepair.interrupted} interrupted, ${discoveryRepair.staleClaims} stale fallback claim(s)`);
  } catch (e) { log.warn('reconcileDiscovery failed', e); }

  const port = effectivePort();
  discoveryService = createDiscoveryService({
    ingestJobs: (source, jobs, meta) => ingestDiscoveredJobs(source, jobs, {
      providerName: meta?.provider || 'jobspy', batchId: meta?.batchId || null,
    }),
    broadcast,
  });
  // Direct-ATS JSON board discovery (Greenhouse/Lever/Ashby) — feeds the harness-proven
  // apply adapters that JobSpy's board list never discovers postings for. See ats-boards.js.
  atsBoardsService = createAtsBoardsService({
    ingestJobs: (source, jobs, meta) => ingestDiscoveredJobs(source, jobs, {
      providerName: meta && meta.provider, batchId: meta && meta.batchId,
    }),
    broadcast, db, logger: scope('ats-boards'),
  });
  const serverOpts = {
    getVersion: () => app.getVersion(),
    userDataDir: app.getPath('userData'),
    confirmPair,
    notify: notifyEvent,
    discovery: discoveryService,
    onSettingsChanged: () => applyAppSettings(),
  };
  // Bind with a short EADDRINUSE retry: a prior JAT process's socket can still be releasing
  // (TIME_WAIT / a renderer-crash zombie) right when the user restarts — without this the new
  // instance failed to bind and the dashboard had no backend (the "black screen on restart").
  // The single-instance lock prevents a genuine second instance, so a retry is safe.
  let serverUp = false;
  for (let attempt = 1; attempt <= 6 && !serverUp; attempt++) {
    try {
      await startServer(port, serverOpts);
      serverUp = true;
      log.info(`server listening on http://127.0.0.1:${port}${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`);
      // Session bridge: on the laptop's Dad-instance this starts the loop that keeps Dad's
      // Chrome logged in. No-ops everywhere else (sessionSync.enabled is off by default).
      try {
        const r = sessionSync.applyFromSettings(db.getSettings(), { log: (lvl, m) => ((log[lvl] || log.info).call(log, m)) });
        if (r.started) log.info('session sync started (Dad-instance)');
      } catch (e) { log.warn('session sync boot skipped', e.message); }
      // AI Apply alert bridge: a CAPTCHA or account wall on the SERVER LAPTOP is useless to Pierre
      // sitting at his desk unless something tells him. This polls this machine and every peer node
      // and raises a real OS notification, which survives a full-screen game.
      try { startAlertWatcher(); } catch (e) { log.warn('alert watcher boot skipped', e.message); }
      try { startProviderHealth(); } catch (e) { log.warn('provider health boot skipped', e.message); }
    } catch (e) {
      if (e.code === 'EADDRINUSE' && attempt < 6) {
        log.warn(`port ${port} busy — retry ${attempt}/5 in 1.5s (a stale JAT socket may still be releasing)`);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      log.error('failed to start server', e);
      showFatalError('Port in use',
        `JAT could not listen on 127.0.0.1:${port} (${e.code || e.message}).\n\n` +
        'Another program (or a stale JAT process) is using that port. End it in Task Manager, or change the port in Settings → General, then restart.');
      return;
    }
  }

  createWindow();
  createTray();
  applyAppSettings();
  discoveryService.start({
    intervalMs: Math.max(1, Number(db.getSettings().autoApply?.discovery?.intervalMinutes) || 1) * 60000,
    warmupMs: 12000,
  });
  // Start the ATS board-API feed UNCONDITIONALLY, exactly like discoveryService above: runTick now
  // self-gates on auto-apply enablement, so starting it here means it's live the moment the user
  // toggles auto-apply on in the dashboard — instead of only ever running if it happened to be
  // enabled at launch. That boot-gate was why the feed had never run once (launch-off→toggle-on).
  // 15-min cadence (was 60s): the ATS board APIs are re-scanned on rotation for NEW postings, which
  // appear a few times/day — every-60s produced ~16k useless discovery batches/day (32k provenance
  // rows) for ~35 jobs and helped clog the queue. 15 min = each of the 113 companies scanned ~8×/day,
  // ample for fresh-posting detection, ~95% less churn.
  atsBoardsService.start({ intervalMs: 900000 });
  pipelineWatchdogInterval = setInterval(() => pipelineWatchdogTick().catch((e) => log.warn('pipeline watchdog failed', e.message)), 60000);
  setTimeout(() => pipelineWatchdogTick().catch(() => {}), 18000);

  // Daily on/off schedule. Every minute, but it acts only on a boundary crossing (see schedule.js) —
  // so a manual toggle stands until the next boundary instead of being fought every tick. Runs a few
  // seconds after boot too, so a machine that was asleep at 04:00 catches up if it wakes inside the
  // window.
  scheduleInterval = setInterval(() => { try { scheduleTick(); } catch (e) { log.warn('schedule tick failed', e?.message || e); } }, 60000);
  setTimeout(() => { try { scheduleTick(); } catch {} }, 12000);

  // Auto-index linked document folders: catch up on changes since last run, then
  // watch for live edits. Fire-and-forget so it never blocks startup.
  Promise.resolve()
    .then(() => rescanAllFolders())
    .then(() => startFolderWatchers())
    .catch((e) => log.warn('folder auto-index setup failed', e.message));

  // Local-AI auto-setup (only if the user opted in) — downloads Ollama + the
  // hardware-recommended models in the background; progress shows in Settings.
  try {
    const ai = db.getSettings().ai;
    const lc = ai.local;
    // Auto-download local AI in the background ONLY when the user hasn't supplied a
    // cloud key — so a fresh machine (e.g. Dad's) gets working AI with zero config,
    // without forcing a multi-GB download on someone who set their own Claude/OpenAI key.
    // ai.disabled wins over everything: an AI-off machine never downloads Ollama.
    const hasCloudKey = !!((ai.claude && ai.claude.apiKey) || (ai.chatgpt && ai.chatgpt.apiKey));
    if (!ai.disabled && lc && lc.enabled && lc.autoSetup && !hasCloudKey) {
      const ls = require('./localsetup');
      const rec = require('./hardware').probe().recommend;
      // Kick off after a short delay so it never competes with launch/first-paint —
      // it streams in the background and surfaces progress in Settings.
      setTimeout(() => {
        ls.setup({ models: [lc.structuredModel || rec.structured, lc.proseModel || rec.prose], cfg: lc })
          .catch((e) => log.warn('local AI auto-setup failed', e.message));
      }, 8000);
    }
  } catch (e) { log.warn('local AI auto-setup skipped', e.message); }

  db.dailyBackup();
  backupInterval = setInterval(() => db.dailyBackup(), 24 * 3600 * 1000);

  // Self-care: prune stale data + compact the DB shortly after launch (don't block
  // startup) and once a day after that.
  setTimeout(() => { try { db.maintenance(); } catch (e) { log.warn('maintenance failed', e.message); } }, 25000);
  maintenanceInterval = setInterval(() => { try { db.maintenance(); } catch (e) { log.warn('maintenance failed', e.message); } }, 24 * 3600 * 1000);

  // GHOSTING sweep: a submitted job with no inbox response after N days → 'ghosted'. Only meaningful
  // when we're MONITORING the inbox (Gmail/IMAP on) — otherwise "no response" just means "not
  // watched". Runs shortly after launch + every 6h.
  const runGhostSweep = () => {
    try {
      const s = db.getSettings();
      const monitoring = !!(s.gmail && s.gmail.enabled) || ((s.email && Array.isArray(s.email.accounts) && s.email.accounts.length) > 0);
      if (!monitoring) return;
      const days = Number(s.gmail && s.gmail.ghostAfterDays) || 28;
      const r = db.sweepGhosted({ days });
      if (r && r.swept) { log.info(`ghost sweep: ${r.swept} job(s) → ghosted (no response in ${days}d)`); broadcast('jobs.updated', { action: 'ghost-sweep' }); }
    } catch (e) { log.warn('ghost sweep failed', e.message); }
  };
  setTimeout(runGhostSweep, 35000);
  ghostSweepInterval = setInterval(runGhostSweep, 6 * 3600 * 1000);

  // Laptop-friendly: pause all background work while the machine sleeps; resume on
  // wake (each sync resumes from its own cursor, so nothing is lost or doubled).
  try {
    powerMonitor.on('suspend', () => { suspended = true; log.info('system suspend — pausing background work'); });
    powerMonitor.on('resume', () => { suspended = false; log.info('system resume — background work re-enabled'); scheduleEmailSync(); maybeCheck(); discoveryService?.runTick().catch(() => {}); atsBoardsService?.runTick().catch(() => {}); });
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
  if (ghostSweepInterval) clearInterval(ghostSweepInterval);
  if (gmailInterval) clearInterval(gmailInterval);
  if (gmailWatchdogInterval) clearInterval(gmailWatchdogInterval);
  if (emailInterval) clearInterval(emailInterval);
  if (emailWarmup) clearTimeout(emailWarmup);
  if (maintenanceInterval) clearInterval(maintenanceInterval);
  if (pipelineWatchdogInterval) clearInterval(pipelineWatchdogInterval);
  if (scheduleInterval) clearInterval(scheduleInterval);
  if (discoveryService) discoveryService.stop();
  if (atsBoardsService) atsBoardsService.stop();
  if (keepAwakeId != null) { try { powerSaveBlocker.stop(keepAwakeId); } catch {} keepAwakeId = null; }
  globalShortcut.unregisterAll();
  if (tray) { try { tray.destroy(); } catch {} tray = null; }
  stopServer();
  db.close();
});
