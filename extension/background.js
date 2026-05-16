// JAT v10 — background service worker.
// RPC surface for the popup, dashboard, and content scripts:
//   • 'ping'                  — SW health
//   • 'app-health'            — probe http://localhost:7744/health
//   • 'check-app-update'      — compare running app to latest GitHub release
//   • 'download-app-installer'— pull OS-matched installer from GitHub Releases
//   • 'pipeline-event'        — content-script capture event; routes to /jobs
//
// All persistent writes go through the app's REST API (localhost:7744). If
// the app is offline, writes are queued by lib/api.js and flushed on the
// next health probe.

import * as api from './lib/api.js';

const APP_BASE = 'http://localhost:7744';
const GH_OWNER = 'PierreSalama';
const GH_REPO  = 'Job-ext-app';
const UPDATE_CACHE_KEY = 'jat10.appUpdateCache';
const UPDATE_CACHE_TTL_MS = 5 * 60 * 1000;

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const ts = new Date().toISOString();
  await chrome.storage.local.set({ installedAt: ts, lastReason: reason });
  console.log('[JAT v10] installed', { reason, ts });
});

// Periodically try to flush the offline write queue.
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'jat10-flush-queue') {
    const h = await api.health();
    if (h?.ok) await api.flushQueue();
  }
});
chrome.alarms.create('jat10-flush-queue', { periodInMinutes: 1 });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'ping') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version, ts: Date.now() });
    return;
  }
  if (msg?.type === 'app-health') {
    (async () => sendResponse(await probeAppHealth()))();
    return true;
  }
  if (msg?.type === 'check-app-update') {
    (async () => {
      try { sendResponse(await checkAppUpdate(!!msg?.force)); }
      catch (e) { sendResponse({ ok: false, error: String(e?.message || e) }); }
    })();
    return true;
  }
  if (msg?.type === 'download-app-installer') {
    (async () => {
      try { sendResponse({ ok: true, ...(await downloadAppInstaller()) }); }
      catch (e) { sendResponse({ ok: false, error: String(e?.message || e) }); }
    })();
    return true;
  }
  if (msg?.type === 'pipeline-event') {
    (async () => {
      try { sendResponse(await handlePipelineEvent(msg.data, sender)); }
      catch (e) { sendResponse({ ok: false, error: String(e?.message || e) }); }
    })();
    return true;
  }
});

// ---------- Pipeline event handler ----------
// Content script fires:
//   { stage: 'started'|'progressing'|'submitted', job: {...}, eventType, summary }
// We upsert the job (dedup + forward-only status elevation happens server-side)
// and broadcast jobs.updated so any open dashboard re-fetches.
async function handlePipelineEvent({ stage, job, eventType, summary }, sender) {
  if (!job?.title || !job?.company) {
    return { ok: false, error: 'missing title/company' };
  }
  const payload = { ...job, _source: 'extension' };
  const result = await api.upsertJob(payload);
  // upsertJob returns {ok, queued, ...} — queued=true means app offline.
  if (result.queued) {
    return { ok: false, queued: true, error: 'app offline; queued' };
  }
  const jobId = result.job?.id;
  // Pipeline-specific events (progressing, attached, etc.) get logged as
  // explicit timeline entries — status_changed is already auto-recorded by
  // the server when status moves.
  if (jobId && (eventType === 'progressing' || eventType === 'attached')) {
    await api.recordEvent({
      jobId, type: eventType, source: 'extension',
      summary: summary || eventType,
      data: { resumeName: job.attachments?.find((a) => a.role === 'resume')?.name },
    });
  }
  broadcastJobsUpdated({ jobId, stage });
  return { ok: true, jobId, action: result.action, statusChanged: result.statusChanged };
}

function broadcastJobsUpdated(info) {
  // Tab broadcast: any dashboard tab open will receive this and refresh.
  chrome.runtime.sendMessage({ type: 'jobs.updated', data: info }).catch(() => {});
}

// ---------- App-side helpers (unchanged from prior v10) ----------
async function probeAppHealth() {
  try {
    const r = await fetch(`${APP_BASE}/health`, { signal: AbortSignal.timeout(1200) });
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` };
    const body = await r.json().catch(() => ({}));
    return { ok: true, app: body };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 120) };
  }
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

async function checkAppUpdate(force = false) {
  if (!force) {
    const cached = (await chrome.storage.local.get(UPDATE_CACHE_KEY))[UPDATE_CACHE_KEY];
    if (cached && Date.now() - cached.checkedAt < UPDATE_CACHE_TTL_MS) return cached;
  }
  const health = await probeAppHealth();
  const current = health.ok ? (health.app?.version || null) : null;
  let latest = null, releaseUrl = null;
  try {
    const release = await fetchMatchingRelease(extensionMajor());
    if (release) { latest = String(release.tag_name || '').replace(/^v/, '') || null; releaseUrl = release.html_url; }
  } catch {}
  const hasUpdate = !!(current && latest && semverGt(latest, current));
  const result = { ok: true, appRunning: !!current, current, latest, hasUpdate, releaseUrl, checkedAt: Date.now() };
  await chrome.storage.local.set({ [UPDATE_CACHE_KEY]: result });
  return result;
}

async function detectOs() {
  try {
    const info = await chrome.runtime.getPlatformInfo();
    if (info.os === 'win') return 'windows';
    if (info.os === 'mac') return 'mac';
    return 'linux';
  } catch { return 'windows'; }
}
function extensionMajor() {
  const v = chrome.runtime.getManifest().version || '';
  const m = v.match(/^(\d+)/);
  return m ? m[1] : '';
}
function installerNameFor(os, major) {
  if (os === 'mac') return `JAT-v${major}.dmg`;
  if (os === 'linux') return `JAT-v${major}.AppImage`;
  return `JAT-v${major}-setup.exe`;
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
async function downloadAppInstaller() {
  const major = extensionMajor();
  if (!major) throw new Error('could not parse extension version');
  const os = await detectOs();
  const fileName = installerNameFor(os, major);
  const release = await fetchMatchingRelease(major);
  if (!release) throw new Error(`no v${major} release published yet`);
  const tag = release.tag_name;
  const asset = (release.assets || []).find((a) => a.name === fileName);
  const url = asset ? asset.browser_download_url
                    : `https://github.com/${GH_OWNER}/${GH_REPO}/releases/download/${tag}/${fileName}`;
  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename: fileName, saveAs: false, conflictAction: 'overwrite' }, (id) => {
      const err = chrome.runtime.lastError;
      if (err || !id) reject(new Error(err?.message || 'download failed'));
      else resolve(id);
    });
  });
  return { downloadId, url, fileName, tag, os };
}
