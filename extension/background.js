// JAT v11 — background service worker.
//
// Fixes the #1 v10 capture bug (SPA-navigation blindness): webNavigation
// events re-trigger detection in the tab on every history-state change, so
// LinkedIn feed → job navigation is detected even though the page never
// reloads.
//
// RPC surface (chrome.runtime messages):
//   ping / app-health / pair-app / popup-state
//   check-app-update / download-app-installer / check-ext-update
//   pipeline-event   — content capture → POST /jobs (queued when app offline)
//   capture-now      — popup/context-menu → force capture in active tab
//   qa-record        — learned answer → POST /qa
//   api-call         — generic proxy {method, path, body} for dashboard/executor
//   task-progress    — executor → PATCH /queue/:id
//
// Alarms: jat11-flush (1m, drain offline queue + badge), jat11-autoapply
// (1m, ask app /queue/next and dispatch to a tab), jat11-extupdate (6h).

import * as api from './lib/api.js';

const GH_OWNER = 'PierreSalama';
const GH_REPO = 'Job-ext-app';
const UPDATE_CACHE_KEY = 'jat11.appUpdateCache';
const EXT_UPDATE_KEY = 'jat11.extUpdateInfo';
const UPDATE_CACHE_TTL_MS = 5 * 60 * 1000;

// ---------- install ----------
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await chrome.storage.local.set({ installedAt: new Date().toISOString(), lastReason: reason });
  // onInstalled fires on both 'install' AND 'update'; creating a menu whose id
  // already exists throws. removeAll first so it's idempotent across updates.
  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: 'jat11-track-page',
      title: 'Track this job in JAT',
      contexts: ['page'],
    });
  } catch (e) { console.warn('[JAT v11] context menu setup failed', e); }

  // First install → open the guided setup so a brand-new user (extension only,
  // no desktop app yet) is walked through downloading + connecting it.
  if (reason === 'install') {
    try { await chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') }); } catch {}
  }
  console.log('[JAT v11] installed', reason);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'jat11-track-page' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'jat11.capture-now', manual: true }).catch(() => {});
  }
});

// ---------- SPA navigation → re-detect ----------
function rebootTab(tabId, frameId, url) {
  chrome.tabs.sendMessage(tabId, { type: 'jat11.reboot', url }, { frameId }).catch(() => {});
}
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => rebootTab(d.tabId, d.frameId, d.url));
chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) => rebootTab(d.tabId, d.frameId, d.url));

// ---------- alarms ----------
chrome.alarms.create('jat11-flush', { periodInMinutes: 1 });
chrome.alarms.create('jat11-autoapply', { periodInMinutes: 1 });
chrome.alarms.create('jat11-extupdate', { periodInMinutes: 360 });

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'jat11-flush') {
    const h = await api.health();
    if (h?.ok && await api.isPaired()) await api.flushQueue();
    await paintBadge();
  }
  if (a.name === 'jat11-autoapply') {
    // Apply one paced job; if there was nothing to apply, use the tick to top up
    // the queue via a discovery search instead. Never both in one tick.
    const r = await autoApplyTick();
    // Auto-apply was turned OFF (from either dashboard host) → tidy up the run's
    // tabs/group. Cheap no-op once aaGroupId is cleared.
    if (r.reason === 'disabled' && aaGroupId != null) await closeAutoApplyTabs().catch(() => {});
    if (!r.dispatched) await discoverTick().catch(() => {});
  }
  if (a.name === 'jat11-extupdate') {
    await checkExtUpdate().catch(() => {});
    await paintBadge();
  }
});

// ---------- badge ----------
async function paintBadge() {
  try {
    const ext = (await chrome.storage.local.get(EXT_UPDATE_KEY))[EXT_UPDATE_KEY];
    if (ext?.hasUpdate) {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#b03030' });
      return;
    }
    const n = await api.queueLength();
    await chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
    if (n > 0) await chrome.action.setBadgeBackgroundColor({ color: '#b08a5a' });
  } catch {}
}

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const respond = (p) => p
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));

  switch (msg?.type) {
    case 'ping':
      sendResponse({ ok: true, version: chrome.runtime.getManifest().version, ts: Date.now() });
      return;
    case 'app-health':
      respond(probeAppHealth());
      return true;
    case 'pair-app':
      respond(api.pair().then(async (r) => { await paintBadge(); return r; }));
      return true;
    case 'popup-state':
      respond(popupState());
      return true;
    case 'check-app-update':
      respond(checkAppUpdate(!!msg.force));
      return true;
    case 'check-ext-update':
      respond(checkExtUpdate());
      return true;
    case 'download-app-installer':
      respond(downloadAppInstaller().then((r) => ({ ok: true, ...r })));
      return true;
    case 'get-installer-url':
      respond(resolveInstaller().then((r) => ({ ok: true, ...r }))
        .catch((e) => ({ ok: false, error: String(e?.message || e), releasesUrl: e?.releasesUrl })));
      return true;
    case 'launch-app':
      respond(launchApp());
      return true;
    case 'open-onboarding':
      respond((async () => {
        await chrome.tabs.create({ url: chrome.runtime.getURL('onboarding/onboarding.html') });
        return { ok: true };
      })());
      return true;
    case 'run-discovery':
      // Manual "Run discovery now" from the extension dashboard (bypasses the
      // queue-low + window gates so the user can shake it out on demand).
      respond(discoverTick(true).then((s) => ({ ok: true, status: s })));
      return true;
    case 'run-autoapply-now':
      // TEST button: apply the next queued job RIGHT NOW (skips window/cap/gap).
      respond(autoApplyTick(true).then((s) => ({ ok: true, ...s })));
      return true;
    case 'stop-autoapply':
      // Dashboard "Stop everything" → close the run's tabs + drop the group.
      respond(closeAutoApplyTabs().then(() => ({ ok: true })));
      return true;
    case 'pipeline-event':
      respond(handlePipelineEvent(msg.data, sender));
      return true;
    case 'capture-now': {
      // Forward to the active tab's content script.
      respond((async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return { ok: false, error: 'no active tab' };
        try {
          return await chrome.tabs.sendMessage(tab.id, { type: 'jat11.capture-now', manual: true });
        } catch {
          return { ok: false, error: 'no content script on this page (chrome:// or excluded site)' };
        }
      })());
      return true;
    }
    case 'qa-record':
      respond(api.qaRecord(msg.data));
      return true;
    case 'api-call':
      respond(api.call(msg.method || 'GET', msg.path, msg.body, msg.timeoutMs));
      return true;
    case 'task-progress':
      respond(api.call('PATCH', '/queue/' + encodeURIComponent(msg.taskId), msg.patch));
      return true;
    case 'get-token':
      respond(api.getToken().then((t) => ({ ok: true, token: t })));
      return true;
    case 'save-document':
      // Content script harvested a picked resume/cover-letter → store it in the
      // app's Documents library (dedup is handled extension-side before this).
      respond(api.call('POST', '/documents', {
        name: msg.data?.name, role: msg.data?.role || 'resume',
        mime: msg.data?.mime || '', dataBase64: msg.data?.dataBase64,
      }, 30000));
      return true;
    case 'get-document':
      // Binary fetch for the executor's resume upload: bytes → base64.
      respond((async () => {
        const token = await api.getToken();
        if (!token) return { ok: false, error: 'not paired' };
        const r = await fetch(`${api.BASE}/documents/${encodeURIComponent(msg.documentId)}?raw=1`, {
          headers: { 'X-JAT-Token': token },
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
        const mime = r.headers.get('Content-Type') || 'application/octet-stream';
        const disp = r.headers.get('Content-Disposition') || '';
        const nameMatch = disp.match(/filename="([^"]+)"/);
        const buf = new Uint8Array(await r.arrayBuffer());
        // Base64-encode per chunk (never accumulate a multi-MB binary string,
        // which can choke btoa on large resumes).
        let dataBase64 = '';
        const CHUNK = 0x7e00; // multiple of 3 → no '=' padding between chunks
        for (let i = 0; i < buf.length; i += CHUNK) {
          dataBase64 += btoa(String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK)));
        }
        return {
          ok: true,
          dataBase64,
          mime,
          name: nameMatch ? decodeURIComponent(nameMatch[1]) : 'resume.pdf',
        };
      })());
      return true;
  }
});

// ---------- pipeline ----------
async function handlePipelineEvent({ stage, job, eventType, summary }, sender) {
  // v10 dropped captures lacking title+company. v11 keeps them, flagged.
  const payload = { ...job, _source: 'extension' };
  if (!payload.title && !payload.company) {
    if (!payload.jobUrl && sender?.tab?.url) payload.jobUrl = sender.tab.url;
    if (!payload.jobUrl) return { ok: false, error: 'nothing identifying to save' };
    payload.title = payload.title || '(unknown role)';
    try { payload.company = payload.company || new URL(payload.jobUrl).hostname.replace(/^www\./, ''); }
    catch { payload.company = payload.company || 'unknown'; }
    payload.needsReview = true;
  }
  const result = await api.upsertJob(payload);
  if (result.unauthorized) return { ok: false, unauthorized: true, error: 'not paired with the app' };
  if (result.queued) { await paintBadge(); return { ok: false, queued: true, error: 'app offline; queued' }; }

  const jobId = result.job?.id;
  // Only record a timeline event when a resume/attachment is newly attached —
  // NOT on every 'progressing' form mutation (that produced dozens of noise
  // events). Created / status-change events come from the server on upsert.
  if (jobId && eventType === 'attached') {
    await api.recordEvent({
      jobId, type: 'attached', source: 'extension',
      summary: summary || 'Resume attached',
      data: { resumeName: job.attachments?.find((a) => a.role === 'resume')?.name },
    });
  }
  chrome.runtime.sendMessage({ type: 'jobs.updated', data: { jobId, stage } }).catch(() => {});
  return { ok: true, jobId, action: result.action, statusChanged: result.statusChanged };
}

// ---------- popup state ----------
async function popupState() {
  const [health, paired, queueN, extUpd] = await Promise.all([
    probeAppHealth(),
    api.isPaired(),
    api.queueLength(),
    chrome.storage.local.get(EXT_UPDATE_KEY).then((s) => s[EXT_UPDATE_KEY] || null),
  ]);
  let autoApply = null;
  if (health.ok && paired) {
    const s = await api.get('/settings', 3000);
    if (s?.ok) autoApply = { enabled: s.settings.autoApply.enabled, mode: s.settings.autoApply.mode };
  }
  // setupNeeded → never connected (no token). The popup routes these users to
  // the guided onboarding instead of showing the normal status panel.
  return {
    ok: true, health, paired, queueN, extUpdate: extUpd, autoApply,
    setupNeeded: !paired,
    appInstalledButClosed: !health.ok && paired,
  };
}

// ---------- app health / updates (port of the proven v10 flow) ----------
async function probeAppHealth() {
  const h = await api.health();
  return h ? { ok: true, app: h } : { ok: false, reason: 'offline' };
}

function semverGt(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

function extensionMajor() {
  const m = (chrome.runtime.getManifest().version || '').match(/^(\d+)/);
  return m ? m[1] : '';
}

async function fetchMatchingRelease(major) {
  const headers = { Accept: 'application/vnd.github+json' };
  const latest = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/latest`, { headers })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (latest && String(latest.tag_name || '').replace(/^v/, '').startsWith(`${major}.`)) return latest;
  const list = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases?per_page=30`, { headers })
    .then((r) => (r.ok ? r.json() : [])).catch(() => []);
  return list.find((r) => String(r.tag_name || '').replace(/^v/, '').startsWith(`${major}.`)) || null;
}

async function checkAppUpdate(force = false) {
  const health = await probeAppHealth();
  const liveCurrent = health.ok ? (health.app?.version || null) : null;
  if (!force) {
    const cached = (await chrome.storage.local.get(UPDATE_CACHE_KEY))[UPDATE_CACHE_KEY];
    if (cached && Date.now() - cached.checkedAt < UPDATE_CACHE_TTL_MS && cached.current === liveCurrent) {
      return cached;
    }
  }
  let latest = null, releaseUrl = null;
  try {
    const release = await fetchMatchingRelease(extensionMajor());
    if (release) { latest = String(release.tag_name || '').replace(/^v/, '') || null; releaseUrl = release.html_url; }
  } catch {}
  const result = {
    ok: true,
    appRunning: !!liveCurrent,
    current: liveCurrent,
    latest,
    hasUpdate: !!(liveCurrent && latest && semverGt(latest, liveCurrent)),
    releaseUrl,
    checkedAt: Date.now(),
  };
  await chrome.storage.local.set({ [UPDATE_CACHE_KEY]: result });
  return result;
}

// Extension can't self-update when sideloaded — surface a badge + popup row.
async function checkExtUpdate() {
  const mine = chrome.runtime.getManifest().version;
  const release = await fetchMatchingRelease(extensionMajor());
  const latest = release ? String(release.tag_name || '').replace(/^v/, '') : null;
  const info = {
    mine, latest,
    hasUpdate: !!(latest && semverGt(latest, mine)),
    releaseUrl: release?.html_url || null,
    checkedAt: Date.now(),
  };
  await chrome.storage.local.set({ [EXT_UPDATE_KEY]: info });
  return { ok: true, ...info };
}

async function detectOs() {
  try {
    const info = await chrome.runtime.getPlatformInfo();
    if (info.os === 'win') return 'windows';
    if (info.os === 'mac') return 'mac';
    return 'linux';
  } catch { return 'windows'; }
}

// Resolve the OS-matched installer URL for the current major, WITHOUT
// downloading. The onboarding page does the actual download itself (a visible
// context can call downloads.open/acceptDanger; the service worker cannot).
async function resolveInstaller() {
  const major = extensionMajor();
  const os = await detectOs();
  const fileName = os === 'mac' ? `JAT-v${major}.dmg`
    : os === 'linux' ? `JAT-v${major}.AppImage` : `JAT-v${major}-setup.exe`;
  const release = await fetchMatchingRelease(major);
  if (!release) {
    const err = new Error(`no v${major} release published yet`);
    err.releasesUrl = `https://github.com/${GH_OWNER}/${GH_REPO}/releases`;
    throw err;
  }
  const asset = (release.assets || []).find((a) => a.name === fileName);
  const url = asset ? asset.browser_download_url
    : `https://github.com/${GH_OWNER}/${GH_REPO}/releases/download/${release.tag_name}/${fileName}`;
  return { url, fileName, tag: release.tag_name, os, releasesUrl: release.html_url };
}

// Simple one-shot download (popup fallback button). The onboarding wizard uses
// resolveInstaller() + its own chrome.downloads flow instead.
async function downloadAppInstaller() {
  const info = await resolveInstaller();
  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download({ url: info.url, filename: info.fileName, saveAs: false, conflictAction: 'overwrite' }, (id) => {
      const err = chrome.runtime.lastError;
      if (err || !id) reject(new Error(err?.message || 'download failed'));
      else resolve(id);
    });
  });
  return { downloadId, ...info };
}

// Launch an already-installed app via its jat11:// protocol handler. Best
// effort — only works once the app (which registers the protocol on install)
// has been run at least once.
async function launchApp() {
  try {
    const tab = await chrome.tabs.create({ url: 'jat11://open', active: false });
    // Close the helper tab shortly after — the OS hands the URL to the app.
    setTimeout(() => { try { chrome.tabs.remove(tab.id); } catch {} }, 1500);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// ---------- auto-apply dispatcher ----------
let dispatching = false;

// Keep every auto-apply / discovery tab in ONE labelled Chrome tab group so the
// user can see + manage them together (and they're not scattered everywhere).
const AA_GROUP_TITLE = 'JAT Auto-apply';
let aaGroupId = null;

// MV3 evicts the service worker after ~30s idle, which would wipe aaGroupId and make
// the next tick spawn a SECOND group. Recover the existing one by its title first so
// there's only ever one "JAT Auto-apply" group across SW restarts.
async function recoverAaGroup() {
  if (aaGroupId != null) return aaGroupId;
  try {
    if (chrome.tabGroups?.query) {
      const groups = await chrome.tabGroups.query({ title: AA_GROUP_TITLE });
      if (groups && groups.length) aaGroupId = groups[0].id;
    }
  } catch {}
  return aaGroupId;
}

// Where the next apply/discovery tab should open. We FOLLOW the group: if the user
// drags the "JAT Auto-apply" group to another window, new tabs open in THAT window
// and join the same group (no more splitting into a second group). Only when no
// group exists yet do we pick a window — preferring one that ISN'T focused, so tabs
// don't pop up in the window you're actively working in.
async function autoApplyTargetWindow() {
  await recoverAaGroup();
  if (aaGroupId != null && chrome.tabGroups?.get) {
    try { const g = await chrome.tabGroups.get(aaGroupId); return g.windowId; }
    catch { aaGroupId = null; }   // group no longer exists — pick a fresh window below
  }
  try {
    const wins = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const pick = wins.find((w) => !w.focused) || wins[0];
    return pick ? pick.id : undefined;
  } catch { return undefined; }
}

async function groupTab(tabId) {
  try {
    if (!chrome.tabs.group) return;
    await recoverAaGroup();   // reuse the existing group after an SW restart
    if (aaGroupId != null) {
      try {
        if (chrome.tabGroups?.get) await chrome.tabGroups.get(aaGroupId);   // confirm it still exists
        await chrome.tabs.group({ tabIds: [tabId], groupId: aaGroupId });   // joins the group (and its window)
        return;
      } catch { aaGroupId = null; }   // stale — make a fresh group below
    }
    aaGroupId = await chrome.tabs.group({ tabIds: [tabId] });
    if (chrome.tabGroups?.update) {
      try { await chrome.tabGroups.update(aaGroupId, { title: AA_GROUP_TITLE, color: 'yellow' }); } catch {}
    }
  } catch { aaGroupId = null; }
}

// Close every tab in the auto-apply group and forget it — used by "Stop everything"
// so the run's tabs don't linger. Task state is already persisted in the app DB
// (the dashboard stop-all patches queued/running → skipped before this runs), so
// nothing is lost by closing them.
async function closeAutoApplyTabs() {
  try {
    await recoverAaGroup();   // find the group even if the SW was restarted since
    if (aaGroupId != null && chrome.tabs?.query) {
      const tabs = await chrome.tabs.query({ groupId: aaGroupId });
      const ids = tabs.map((t) => t.id).filter((id) => id != null);
      if (ids.length) { try { await chrome.tabs.remove(ids); } catch {} }
    }
  } catch {}
  aaGroupId = null;
}

async function autoApplyTick(force = false) {
  if (dispatching) return { dispatched: false, reason: 'busy' };
  if (!(await api.isPaired())) return { dispatched: false, reason: 'not paired' };
  const h = await api.health();
  if (!h?.ok) return { dispatched: false, reason: 'app offline' };

  const r = await api.call('GET', '/queue/next' + (force ? '?force=1' : ''), null, 8000);
  if (!r?.ok || !r.task) return { dispatched: false, reason: r?.reason || 'nothing queued' };

  dispatching = true;
  try {
    const { task, context } = r;
    const url = context.job.jobUrl;
    const winId = await autoApplyTargetWindow();
    const tab = await chrome.tabs.create({ url, active: false, ...(winId ? { windowId: winId } : {}) });
    await groupTab(tab.id);

    // Wait for the page (and content script) to settle, then hand over the task.
    await new Promise((resolve) => {
      const done = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(done);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(done);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); resolve(); }, 30000);
    });
    await new Promise((r2) => setTimeout(r2, 2500));

    // Mark running up front, then hand over. IMPORTANT: 'jat11.run-task' awaits
    // the ENTIRE executor run, so this resolves with the run's FINAL result —
    // the executor has already report()-ed its terminal state. We reconcile to
    // that authoritative state and must NEVER clobber it back to 'running'.
    await api.call('PATCH', '/queue/' + task.id, {
      state: 'running', transcriptAppend: { note: `executor started in tab ${tab.id}` },
    });
    let result = null;
    try {
      // Target the TOP frame ONLY — otherwise an iframe (ads/embeds on
      // LinkedIn/Indeed) answers "not top frame" first and the race kills the
      // task while the real executor is still running. This was ~58% of failures.
      result = await chrome.tabs.sendMessage(tab.id, { type: 'jat11.run-task', task, context }, { frameId: 0 });
    } catch (e) {
      await api.call('PATCH', '/queue/' + task.id, {
        state: 'failed', attemptsDelta: 1, lastError: String(e?.message || e),
        transcriptAppend: { note: 'executor error: ' + String(e?.message || e) },
      });
      try { await chrome.tabs.remove(tab.id); } catch {}
      return { dispatched: true, state: 'failed' };
    }
    const finalState = (result && typeof result.state === 'string') ? result.state : null;
    if (!result || result.ok === false || !finalState) {
      await api.call('PATCH', '/queue/' + task.id, {
        state: 'failed', attemptsDelta: 1, lastError: String(result?.error || 'executor returned no state'),
        transcriptAppend: { note: 'executor failed: ' + String(result?.error || 'no state') },
      });
      try { await chrome.tabs.remove(tab.id); } catch {}
      return { dispatched: true, state: 'failed' };
    }
    if (finalState !== 'running') {
      await api.call('PATCH', '/queue/' + task.id, { state: finalState });   // idempotent reconcile
    }
    // Close the apply tab on terminal/parked outcomes (the dashboard is the
    // surface for those); KEEP it open for awaiting_review / awaiting_input —
    // the user finishes those IN that tab.
    if (['done', 'skipped', 'failed', 'parked'].includes(finalState)) {
      try { await chrome.tabs.remove(tab.id); } catch {}
    }
    return { dispatched: true, state: finalState, title: r.context?.job?.title };
  } finally {
    dispatching = false;
  }
}

// ---- discovery: search a board for Easy-Apply jobs + enqueue them ----
let lastBoardIdx = 0;

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const done = (id, info) => { if (id === tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(done); resolve(); } };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); resolve(); }, timeoutMs);
  });
}

// Same window check the server applies (server.js queueNext). runAnytime (default
// ON) means 24/7; otherwise an empty window also means run any time.
function withinWindow(aa) {
  if (aa.runAnytime !== false) return true;
  if (!aa.windowStart || !aa.windowEnd) return true;
  const [sh, sm] = String(aa.windowStart).split(':').map(Number);
  const [eh, em] = String(aa.windowEnd).split(':').map(Number);
  const d = new Date();
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= sh * 60 + (sm || 0) && mins <= eh * 60 + (em || 0);
}

function buildSearchUrl(board, keyword, location) {
  const kw = encodeURIComponent(keyword);
  const loc = location ? encodeURIComponent(location) : '';
  if (board === 'indeed') {
    return `https://www.indeed.com/jobs?q=${kw}&sort=date&fromage=7` + (loc ? `&l=${loc}` : '');
  }
  // linkedin (default) — f_AL=true is the Easy-Apply filter; DD = sort by date
  return `https://www.linkedin.com/jobs/search/?f_AL=true&keywords=${kw}&sortBy=DD` + (loc ? `&location=${loc}` : '');
}

async function discoverTick(force = false) {
  if (dispatching) return { ok: false, note: 'busy' };
  if (!(await api.isPaired())) return { ok: false, note: 'not paired' };
  const h = await api.health();
  if (!h?.ok) return { ok: false, note: 'app offline' };
  const sres = await api.call('GET', '/settings', null, 6000);
  const aa = sres?.ok ? sres.settings?.autoApply : null;
  if (!aa || !aa.enabled || !aa.discovery?.enabled) return { ok: false, note: 'auto-apply is off' };
  const keywords = (aa.keywords || []).filter(Boolean);
  const boards = (aa.boards || []).filter(Boolean);
  if (!keywords.length || !boards.length) return { ok: false, note: 'add keywords + a board first' };
  if (!force && !withinWindow(aa)) return { ok: false, note: 'outside the time window' };

  // Only auto-discover when the queue is low — never over-enqueue. A manual run
  // (force) bypasses this.
  if (!force) {
    const q = await api.call('GET', '/queue?state=queued', null, 6000);
    if ((q?.items || []).length >= (aa.discovery.refillBelow || 3)) return { ok: false, note: 'queue already full' };
  }

  dispatching = true;
  let tab = null;
  const board = boards[lastBoardIdx++ % boards.length];
  const keyword = keywords[Math.floor(Math.random() * keywords.length)];
  const location = (aa.locations || [])[0] || '';
  const url = buildSearchUrl(board, keyword, location);
  let resp = null, enqueued = 0;
  try {
    const winId = await autoApplyTargetWindow();
    tab = await chrome.tabs.create({ url, active: false, ...(winId ? { windowId: winId } : {}) });
    await groupTab(tab.id);
    await waitTabComplete(tab.id, 30000);
    await new Promise((r2) => setTimeout(r2, 2000));
    try {
      resp = await chrome.tabs.sendMessage(tab.id, { type: 'jat11.discover-search', source: board, max: aa.discovery.perRunLimit || 8 }, { frameId: 0 });
    } catch (e) {
      resp = { ok: false, error: String(e?.message || e), jobs: [], found: 0, note: 'could not reach the search page (content script not ready?)' };
    }
    const jobs = (resp && resp.jobs) || [];
    if (jobs.length) {
      const r3 = await api.call('POST', '/queue/discover', { source: board, jobs }, 15000);
      enqueued = r3?.enqueued ?? 0;
    }
  } catch (e) {
    resp = { ok: false, error: String(e?.message || e), jobs: [], found: 0, note: 'discovery failed: ' + String(e?.message || e) };
  } finally {
    if (tab) { try { await chrome.tabs.remove(tab.id); } catch {} }
    dispatching = false;
  }
  // Report what this search saw so the dashboard can show it (and we can tune).
  const status = { board, keyword, url, found: resp?.found ?? 0, enqueued, note: resp?.note || resp?.error || '', ok: resp?.ok !== false };
  await api.call('POST', '/auto-apply/discovery-status', status, 6000).catch(() => {});
  console.log('[JAT] discovery', board, '"' + keyword + '" found', status.found, 'enqueued', enqueued, status.note || '');
  return status;
}
