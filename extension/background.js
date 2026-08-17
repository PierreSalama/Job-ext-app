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
import { computeIdleGate, clampIdleThreshold } from './lib/idle-gate.js';
import { isJobPageUrl } from './lib/jobpage.js';
import { HOST_BREAKER_COOLDOWN_MS, HOST_BREAKER_FORGET_MS, hostOfUrl, shouldDispatchHost, trippedEntry, registrableDomain, shouldForget, backoffMs } from './lib/host-breaker.js';
import { focusArbiterDecision } from './lib/focus-arbiter.js';
import { pickApplyWindowBounds } from './lib/window-place.js';
import { buildSearchUrl } from './lib/search-url.js';
import { NARROWEST_TIER, nextFreshnessTier } from './lib/freshness.js';
import { applyHardCapMs, APPLY_HIDDEN_STALL_CAP_MS } from './lib/apply-cap.js';
import { externalTargetFromNav } from './content/replay.js';

// ---------- browser capability probe (cross-browser parity, Apprenticeship Engine P8) ----------
// Firefox lacks some Chrome MV3 surfaces (tabGroups, storage.session). The existing apply-pool
// code already guards every chrome.tabGroups?.* call and keeps all state in storage.local; this
// single probe makes the assumption EXPLICIT so any NEW code path (Observer nav, replay dispatch)
// can branch on a capability instead of optimistically touching an API Firefox doesn't expose.
const CAPS = {
  tabGroups: !!chrome.tabGroups,
  storageSession: !!chrome.storage?.session,
};

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

// NAVIGATION-RESUMING RUN DISPATCH — module-level so the apply pump AND the harness call the SAME
// code (the harness used its own raw sendMessage, so it could not exercise this at all).
//
// sendMessage awaits the ENTIRE executor run, but an opener that NAVIGATES (stripe.com "Apply now",
// ashby, lever - anything leaving the job page for a separate application page) destroys the
// receiving content script mid-message. Chrome rejects with "message channel closed", the run never
// resolves, and the task burns its full hard cap before being reaped as a timeout. Live 2026-08-14
// that was every navigating ATS opener on both machines, and it is why the ATS lane produced 1
// completion against LinkedIn's 141 - LinkedIn Easy Apply is a MODAL, so it never navigates.
//
// On that specific rejection, re-send to the NEW document. Bounded at 2 resumes so a page that
// reloads in a loop cannot spin. Not a double-apply risk: the channel dies at the OPENER click,
// before any submit - and if a post-submit confirmation navigation ever triggers it, the resumed
// executor finds no form and skips rather than re-applying.
const CHANNEL_CLOSED_RX = /message channel closed|Receiving end does not exist/i;
const MAX_NAV_RESUMES = 2;
async function sendRunWithNavResume(tabId, msg, opts = {}) {
  const settleMs = opts.settleMs == null ? 2500 : opts.settleMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await chrome.tabs.sendMessage(
        tabId,
        { ...msg, resumedAfterNavigation: attempt > 0 },
        { frameId: 0 },
      );
    } catch (e) {
      const em = String((e && e.message) || e);
      if (!CHANNEL_CLOSED_RX.test(em) || attempt >= MAX_NAV_RESUMES) throw e;
      // Only resume if the TAB still exists - a closed/discarded tab is a real failure.
      let live = null;
      try { live = await chrome.tabs.get(tabId); } catch { throw e; }
      if (!live || live.discarded) throw e;
      try { console.log('[jat] resuming run after navigation ->', String(live.url || '').slice(0, 80)); } catch {}
      // Let the new document finish loading, or it has no listener yet.
      await new Promise((r) => setTimeout(r, settleMs));
    }
  }
}
// Exposed for the harness so its fixture drives the REAL dispatch path, not a copy of it.
try { globalThis.__jatSendRunWithNavResume = sendRunWithNavResume; } catch {}


chrome.webNavigation.onReferenceFragmentUpdated.addListener((d) => rebootTab(d.tabId, d.frameId, d.url));

// ---------- Observer: always-on nav recorder (Apprenticeship Engine P2) ----------
// Tap the SAME webNavigation events to POST every top-frame navigation to the app, which
// classifies the (ats, company) and learns board→ATS handoff edges. Cross-browser: state
// lives in storage.local (Firefox has no storage.session) and no tabGroups API is touched.
// Per-tab last-URL gives us the referrer edge + dedups repeated fires. Fully guarded: if
// the app is down api.call returns {ok:false} (never throws), so navigation never breaks.
const NAV_LAST_KEY = 'jat11.navLast';        // { [tabId]: { url, ts } } — referrer + dedup
const NAV_DEDUP_MS = 1500;                    // ignore the same url firing back-to-back
const NAV_TTL_MS = 10 * 60 * 1000;            // sweep stale entries (a lost-update race with onRemoved can strand a closed tab's entry until SW eviction)

async function recordNav(tabId, frameId, url) {
  if (frameId !== 0) return;                                   // top frame / main navigation only
  if (!url || !/^https?:/i.test(url)) return;                 // skip about:, chrome://, file:, etc.
  try {
    if (!(await api.isPaired())) return;                      // no app paired → nothing to record
    const store = (await chrome.storage.local.get(NAV_LAST_KEY))[NAV_LAST_KEY] || {};
    const prev = store[tabId];
    const nowMs = Date.now();
    // Dedup: same url in this tab within the window (history fires can double-tap).
    if (prev && prev.url === url && (nowMs - (prev.ts || 0)) < NAV_DEDUP_MS) return;
    const referrer = (prev && prev.url !== url) ? prev.url : undefined;   // intra-tab edge = referrer
    // Sweep stale/stranded entries on write (minutes-scale TTL so a slow multi-step apply's referrer
    // edge survives). This is the only durable symptom of the get→modify→set race with onRemoved, and
    // removing it here needs no extra API or locking.
    for (const k of Object.keys(store)) { if (!store[k] || (nowMs - (store[k].ts || 0)) > NAV_TTL_MS) delete store[k]; }
    store[tabId] = { url, ts: nowMs };
    await chrome.storage.local.set({ [NAV_LAST_KEY]: store });
    // Fire-and-forget; api.call swallows offline/unauthorized into {ok:false}.
    api.call('POST', '/observe', { kind: 'nav', url, referrer }).catch(() => {});
  } catch { /* never let the Observer break navigation */ }
}
chrome.webNavigation.onCompleted.addListener((d) => { recordNav(d.tabId, d.frameId, d.url); });
chrome.webNavigation.onHistoryStateUpdated.addListener((d) => { recordNav(d.tabId, d.frameId, d.url); });
// Drop a closed tab's last-URL so the registry can't grow unbounded.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const store = (await chrome.storage.local.get(NAV_LAST_KEY))[NAV_LAST_KEY] || {};
    if (store[tabId] != null) { delete store[tabId]; await chrome.storage.local.set({ [NAV_LAST_KEY]: store }); }
  } catch {}
});

// ---------- alarms ----------
chrome.alarms.create('jat11-flush', { periodInMinutes: 1 });
chrome.alarms.create('jat11-autoapply', { periodInMinutes: 1 });
chrome.alarms.create('jat11-extupdate', { periodInMinutes: 360 });
chrome.alarms.create('jat11-aa-reaper', { periodInMinutes: 2 });   // close stale/excess auto-apply tabs

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'jat11-flush') {
    const h = await api.health();
    if (h?.ok && await api.isPaired()) await api.flushQueue();
    await paintBadge();
  }
  if (a.name === 'jat11-autoapply') {
    // Top up the apply pool (serial self-drives between ticks; this is the backstop
    // + the parallel re-fill). If nothing could be dispatched AND no applies are in
    // flight, use the tick to grow the queue via a discovery search instead.
    const r = await pump();
    // Auto-apply was turned OFF (from either dashboard host) → tidy up the run's
    // tabs/group. Cheap no-op once aaGroupId is cleared.
    if (r.reason === 'disabled' && aaGroupId != null) await closeAutoApplyTabs().catch(() => {});
    // EA-DENSE TOP-UP (primary supply). When the queue runs low, grow it with an Easy-Apply-ONLY
    // LinkedIn search (f_AL=true) so the pool is REAL Easy-Apply jobs, not the JobSpy external
    // flood the executor has to skip (the dominant "nothing submitted" cause). discoverTick
    // self-gates: no-op unless auto-apply + discovery.enabled, inside the window, and queued
    // depth < refillBelow — so this never over-enqueues or scrapes aggressively.
    await discoverTick().catch(() => {});
    // App-owned JobSpy is the FALLBACK discovery engine (runs only when the queue is empty).
    // Chrome only consumes an explicit fallback request after JobSpy reports a typed failure.
    await processDiscoveryFallback().catch(() => {});
  }
  if (a.name === 'jat11-extupdate') {
    await checkExtUpdate().catch(() => {});
    await paintBadge();
  }
  if (a.name === 'jat11-aa-reaper') {
    await reapAaTabs().catch(() => {});
  }
});

// ---------- idle-gate reactivity ----------
// When "only when idle" is on, react to the user going away / audio stopping so auto-apply
// resumes within a second instead of waiting for the 1-min alarm — and pauses promptly when
// they come back. Guarded by _idleOnlyHint so there is ZERO extra work when the toggle is off.
// (schedulePump / discoverTick are function declarations → hoisted; _idleOnlyHint is read only
// at event time, after the module has fully evaluated.)
try {
  chrome.idle.onStateChanged.addListener((newState) => {
    if (!_idleOnlyHint) return;
    // 'idle'/'locked' may OPEN the gate → try to resume applies + top up discovery.
    // 'active' will re-gate on the next pump; nudging is harmless (pump self-gates).
    schedulePump();
    if (newState === 'idle' || newState === 'locked') discoverTick().catch(() => {});
  });
} catch { /* 'idle' permission missing — feature simply won't react in real time */ }
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.audible === undefined || !_idleOnlyHint) return;
  // Audio started (pump will re-gate) or stopped (may open the gate) → re-evaluate.
  schedulePump();
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
    case 'jat11.nudge-apply-window':
      // An apply tab reported itself hidden/occluded (Chrome throttled it → LinkedIn
      // won't hydrate). Briefly raise the dedicated apply window(s) to force a visible
      // render pass, then hand focus straight back to the user. Fire-and-forget.
      respond(nudgeApplyWindows().then(() => ({ ok: true })).catch(() => ({ ok: true })));
      return true;
    case 'jat11.human-challenge':
      // An apply tab hit a Cloudflare check it can't pass without a HUMAN (Option 2 — we never
      // auto-solve). Fire an OS notification + make that tab the visible one so the user can
      // complete it; the executor keeps polling and resumes on its own once they verify.
      respond(notifyHumanChallenge(sender, msg).then(() => ({ ok: true })).catch(() => ({ ok: true })));
      return true;
    case 'jat11.human-challenge-resolved':
      // The check cleared (or timed out) — clear the notification, badge, and awaiting-human flag.
      // NOT cleared (unattended / not solved in time) → trip the host breaker NOW so sibling jobs
      // for the same host skip immediately instead of each hitting (and probing) the same wall.
      if (msg && msg.cleared === false) {
        const chost = hostOfUrl(sender?.tab?.url) || (msg.host ? String(msg.host).replace(/^www\./, '').toLowerCase() : '');
        if (chost) tripHostBreaker(chost, 'cloudflare');
      }
      respond(clearHumanChallengeNotice(sender?.tab?.id ?? null).then(() => ({ ok: true })).catch(() => ({ ok: true })));
      return true;
    case 'jat11.front-until-hydrated':
      // An apply tab reported itself occluded AND not yet hydrated. Bring ITS window to the
      // front and KEEP it there (sustained visible time so a heavy SPA can hydrate), then
      // hand focus back on jat11.apply-hydrated or after a hard cap. Only ever fronts a
      // window WE own (the apply tab's window). Fire-and-forget; never throws.
      // FIX 1: record that THIS apply tab is hidden-and-not-yet-hydrated so the dispatch
      // race fails it fast+retriably (short cap) instead of burning the full 5.5-min cap.
      try { if (sender?.tab?.id != null) aaFrontRequested.set(sender.tab.id, { at: Date.now(), hydrated: false }); } catch {}
      respond(frontUntilHydrated(sender?.tab?.windowId).then(() => ({ ok: true })).catch(() => ({ ok: true })));
      return true;
    case 'jat11.apply-hydrated':
      // The apply form hydrated (or the run ended) — release the held front and restore the
      // user's previously-focused window. Idempotent + guarded.
      // FIX 1: the tab DID hydrate → clear the hidden-stall fast-fail so it gets full time.
      try { const r = sender?.tab?.id != null && aaFrontRequested.get(sender.tab.id); if (r) r.hydrated = true; } catch {}
      respond(releaseFrontUntilHydrated(sender?.tab?.windowId).then(() => ({ ok: true })).catch(() => ({ ok: true })));
      return true;
    case 'jat11.external-handoff-arm':
      // Arm BEFORE the page clicks an external/company-site CTA. target=_blank tabs can
      // appear within a few milliseconds, so registering after the click races and loses
      // the child. The captured child is tracked like every other AA tab and becomes the
      // authoritative executor for this task.
      respond(armExternalHandoff(sender?.tab?.id, msg.taskId, msg.routeState).then((token) => ({ ok: !!token, token })));
      return true;
    case 'jat11.external-handoff-run':
      respond(runExternalHandoff(sender?.tab?.id, msg.token, msg.task, msg.context));
      return true;
    case 'jat11.external-handoff-open':
      // The opener's window.open() was popup-blocked; the executor captured the intended URL
      // (MAIN-world hook → data-jat-exturl, or the control's href) and asks us to open it
      // directly. We register the new tab as this handoff's child so the in-flight
      // runExternalHandoff adopts + drives it.
      respond(openExternalUrl(sender?.tab?.id, msg.token, msg.url));
      return true;
    case 'run-discovery':
      respond(api.call('POST', '/auto-apply/discover-now', {}, 180000));
      return true;
    case 'run-autoapply-now':
      // TEST button: apply the next queued job RIGHT NOW (skips window/cap/gap).
      respond(forceApplyOne().then((s) => ({ ok: true, ...s })));
      return true;
    case 'watch-and-teach':
      // Unified Control Studio: recording is preapproved for the session and the
      // supervised overlay owns pacing, correction, recovery and submit approval.
      try { chrome.storage.local?.set({ 'jat11.teachMode': true }); } catch {}
      respond(watchAndTeachOne().then((s) => ({ ok: true, ...s })));
      return true;
    case 'stop-autoapply':
      // Dashboard "Stop everything" → close the run's tabs + drop the group.
      respond(closeAutoApplyTabs().then(() => ({ ok: true })));
      return true;
    case 'sync-applied':
      // Applications page → import past LinkedIn/Indeed applications.
      respond(syncApplied({ sources: msg.sources, maxDays: msg.maxDays }));
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
    case 'teach-screenshot':
      // Teach Mode (Teach & Correct T2): capture the visible tab, hand the full PNG +
      // the apply-form rect to the app, which crops + saves + records the screenshot and
      // attaches its id to the demonstration. FULLY BEST-EFFORT — any failure (no
      // permission, capture error, app down) resolves {ok:false} and the step has already
      // been recorded without a screenshot, so nothing is lost.
      respond((async () => {
        try {
          if (!(await api.isPaired())) return { ok: false, error: 'not paired' };
          const winId = sender?.tab?.windowId;
          const dataUrl = await chrome.tabs.captureVisibleTab(winId, { format: 'png' });
          if (!dataUrl) return { ok: false, error: 'no capture' };
          return await api.call('POST', '/observe/screenshot', {
            dataUrl, rect: msg.rect, demo: msg.demo, url: sender?.tab?.url,
          }, 20000);
        } catch (e) { return { ok: false, error: String(e?.message || e) }; }
      })());
      return true;
    case 'task-progress': {
      // A bot-challenge outcome trips the per-run host circuit breaker so we stop feeding
      // same-host jobs into the same wall. The botChallenge hint is breaker-only state —
      // strip it from the PATCH so the queue row stores just the honest lastError/parkReason.
      let patch = msg.patch || {};
      const bc = patch.botChallenge;
      if (bc && (bc.host || bc.kind)) {
        const host = hostOfUrl(bc.url) || bc.host || '';
        if (host) tripHostBreaker(host, bc.kind);   // async persist (fire-and-forget); normalizes to registrable domain
        const { botChallenge, ...rest } = patch;   // eslint-disable-line no-unused-vars
        patch = rest;
      }
      respond(api.call('PATCH', '/queue/' + encodeURIComponent(msg.taskId), patch));
      return true;
    }
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
  const [health, paired, queueN, extUpd, lastHealthy] = await Promise.all([
    probeAppHealth(),
    api.isPaired(),
    api.queueLength(),
    chrome.storage.local.get(EXT_UPDATE_KEY).then((s) => s[EXT_UPDATE_KEY] || null),
    api.lastHealthyAt(),
  ]);
  let autoApply = null;
  let unauthorized = false;
  if (health.ok && paired) {
    const s = await api.get('/settings', 3000);
    if (s?.ok) autoApply = { enabled: s.settings.autoApply.enabled, mode: s.settings.autoApply.mode };
    else if (s?.unauthorized) unauthorized = true;   // a real 401 → the token was rejected
  }
  // Resilient connection decision (decideConnectionState is PURE + unit-tested):
  // a transient health blip must NOT flip a paired popup back to the Connect prompt.
  // We re-prompt only when there's genuinely no token, or an authed call returned 401.
  const conn = api.decideConnectionState({
    paired, healthOk: health.ok, lastHealthyAt: lastHealthy, unauthorized,
  });
  return {
    ok: true, health, paired, queueN, extUpdate: extUpd, autoApply,
    connected: conn.connected,
    setupNeeded: conn.setupNeeded,
    appInstalledButClosed: conn.appInstalledButClosed,
    connReason: conn.reason,
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

// ---------- auto-apply dispatcher (worker pool) ----------
// Aggressive serial by DEFAULT (concurrency 1) but SELF-DRIVING: each job re-pumps
// the moment it finishes instead of waiting for the 1-min alarm — that alone takes
// throughput from ~one-per-tick to as fast as the pacing gap allows. The user can
// raise `concurrency` (server setting) to run several apply tabs in PARALLEL.
//   activeCount  — apply tabs currently running (the pool's live slots)
//   pumping      — re-entrancy guard for the fill loop
//   scanning     — separate mutex for discovery / applied-sync (never overlap an apply)
let activeCount = 0;
let pumping = false;
let scanning = false;
let currentConcurrency = 1;       // default SERIAL (1 window) for reliability — the new full-page /apply/ flow throttles in a backgrounded parallel window; re-learned from each /queue/next response (server clamps 1..3)
let gapTimer = null;              // precise wake-up when only the pacing gap held us back
let pumpDirty = false;            // a re-pump request arrived while pumping — re-run once we finish
// Resume the right parallelism after an MV3 service-worker eviction — otherwise the
// pool silently runs serial (1) until the next grant re-learns the concurrency.
try { chrome.storage.local?.get('jat11.concurrency').then((o) => { const c = o && o['jat11.concurrency']; if (c) currentConcurrency = Math.max(1, Math.min(8, Number(c))); }).catch(() => {}); } catch {}

// ---------- host bot-challenge circuit breaker (PERSISTED) ----------
// When the executor reports a bot-challenge (Cloudflare / CAPTCHA / verify wall) on a host, record
// it and STOP dispatching further queued jobs for that host for a cooldown window. One Cloudflare
// wall on indeed.com is host-wide — without a breaker the pool feeds every queued Indeed job
// straight into the same wall, burning the run and tanking the success rate.
//
// PERSISTED to chrome.storage.local, NOT an in-memory Map. This is an MV3 service worker: it evicts
// after ~30s idle, and auto-apply tasks are minutes apart, so an in-memory breaker was WIPED between
// tasks — every Indeed job then re-probed the wall. Live 2026-07-25 (Dad + Pierre): a single task
// hit Cloudflare 126 times, Indeed "refreshed a lot" showing "there's a problem, please try again
// later", and the pile-up of reopened tabs eventually white-screened Firefox. Persisting the breaker
// makes the cooldown actually hold across evictions. Same fix pattern as the discovery freshness ramp.
const HOST_BREAKER_KEY = 'jat11.hostBreaker';       // { [registrableDomain]: {trippedAt,until,kind,hits} }

// registrableDomain() is imported from ./lib/host-breaker.js (pure + node-tested) — it maps every
// subhost (ca.indeed.com, smartapply.indeed.com, www.indeed.com) to one key: "indeed.com".
async function loadHostBreaker() {
  try { const o = await chrome.storage.local.get(HOST_BREAKER_KEY); return o[HOST_BREAKER_KEY] || {}; }
  catch { return {}; }
}
async function saveHostBreaker(map) {
  try { await chrome.storage.local.set({ [HOST_BREAKER_KEY]: map }); } catch {}
}

// Trip (or extend) the breaker for a host after a challenge was detected on it.
async function tripHostBreaker(host, kind, now = Date.now()) {
  const h = registrableDomain(host);
  if (!h) return;
  const map = await loadHostBreaker();
  map[h] = trippedEntry(map[h], kind, now);
  await saveHostBreaker(map);
  // Report the ACTUAL backoff for this trip, not the base constant — a host on its 5th consecutive
  // wall is paused for hours, and a log line claiming "~20 min" would hide exactly that.
  const mins = Math.round(backoffMs(map[h].hits) / 60000);
  console.log(`[jat11] host breaker TRIPPED (persisted): ${h} (bot-challenge: ${kind || 'unknown'}) hit #${map[h].hits} — pausing dispatch ~${mins} min`);
}

// Read the persisted breaker, forgetting only hosts that have been QUIET for the forget window.
//
// This used to delete an entry the moment its cooldown elapsed, which silently defeated the hit
// counter: `prev` was always undefined at the next trip, so `hits` was always 1 and every wall got
// the same fixed cooldown forever. Entries must outlive their cooldown for a backoff to exist.
// Dispatch is unaffected — shouldDispatchHost() compares against `until` and does not care whether
// an entry is present, so a cooled-down host is dispatched exactly as before.
async function loadHostBreakerPruned(now = Date.now()) {
  const map = await loadHostBreaker();
  let changed = false;
  for (const [h, entry] of Object.entries(map)) {
    if (shouldForget(entry, now)) {
      delete map[h]; changed = true;
      console.log(`[jat11] host breaker forgotten (quiet ${Math.round(HOST_BREAKER_FORGET_MS / 3600000)}h): ${h} — next wall starts from the base cooldown`);
    }
  }
  if (changed) await saveHostBreaker(map);
  return map;
}

// Keep every auto-apply / discovery tab in ONE labelled Chrome tab group so the
// user can see + manage them together (and they're not scattered everywhere).
const AA_GROUP_TITLE = 'JAT Auto-apply';
let aaGroupId = null;
// A DEDICATED background window for auto-apply tabs. They must never open in YOUR
// browsing window (that hijacks the tab you're working in — the "it interrupted me"
// bug), and must be the ACTIVE/visible tab in their own window so Chrome doesn't
// throttle the page (a hidden tab won't hydrate LinkedIn's Easy-Apply button).
let stopping = false;             // true briefly while tearing a run down, so in-flight launches bow out as 'skipped' (not 'failed')

// ---------- auto-apply TAB REGISTRY (the leak fix) ----------
// Every apply/discovery/sync tab is tracked here by id→createdAt, persisted to
// storage.LOCAL (Firefox has no storage.session). Cleanup uses this registry, so it
// works even where tabGroups doesn't exist (Firefox). A reaper closes stale/excess
// tabs so they can never pile up to "90+ open tabs" again.
const AA_TABS_KEY = 'jat11.aaTabs';
const AA_PRIMARY_WINDOW_KEY = 'jat11.aaWindowId';
const AA_WINDOW_POOL_KEY = 'jat11.aaWindowPool';
const AA_REUSE_TAB_KEY = 'jat11.aaReuseTab';   // the ONE warm serial apply tab we navigate per job (Cloudflare session continuity)
let aaReuseTabId = null;
const AA_TAB_MAX_AGE_MS = 4.5 * 60 * 1000;   // 4.5 min. The 2-min jat11-aa-reaper alarm (alarms SURVIVE
                                             // MV3 SW eviction, unlike setTimeout) closes an orphaned/hung
                                             // apply tab here; reconcileAaTabsAndSlots then frees the
                                             // concurrency slot. Kept just ABOVE APPLY_HARD_CAP_MS (4 min)
                                             // so a normal run ends via its own cap first; this is the
                                             // eviction-proof backstop that ends the 8-15 min pump stalls.
const AA_TAB_CAP = 10;                       // hard ceiling on simultaneously-open AA tabs
const AA_WINDOW_CAP = 5;                     // hard ceiling on owned AA windows (primary + workers); matches server concurrency clamp
let aaTabs = {};                             // { [tabId]: createdAtMs }
let aaWindowId = null;
let aaWindowPool = [];                       // DEDICATED apply window ids (created by us only)
const aaBusyWindows = new Set();             // window ids currently hosting a RUNNING apply tab
let aaRuntimeHydrated = false;

// ---- STABLE apply-window focus model (F2 regression fix) -----------------------------
// Chrome THROTTLES non-visible/occluded tabs: a background apply window's JS timers are
// suspended → LinkedIn's Easy-Apply modal never mounts and external pages never hydrate.
// v11.24.0 worked because the apply window was fronted (focused) so it stayed un-throttled;
// v11.24.1/v11.25.0 created it focused:false → near-total non-hydration. The fix is a STABLE
// model (no 700ms focus-thrash): we capture the user's focused window ONCE at run start,
// keep the active apply window FRONTED for the whole run, and restore the user's focus only
// when the run goes idle / stops. With concurrency 1 there is exactly ONE apply window, so
// it can be the single foreground window for the duration.
let userFocusedWindowId = null;             // the user's window at run start (restore target)
let userFocusCaptured = false;              // capture only once per run

// Record the user's currently-focused window so we can hand focus back when the run ends.
// Idempotent within a run; never records one of OUR apply windows as the restore target.
async function captureUserFocusOnce() {
  if (userFocusCaptured) return;
  userFocusCaptured = true;
  try {
    const w = await chrome.windows.getLastFocused();
    const id = w?.id;
    if (id != null && !isOurApplyWindow(id)) userFocusedWindowId = id;
  } catch {}
}

// ── the single-focus arbiter's runtime state + gate ──
// EVERY window-front in the pool routes through grantWindowFront so parallel apply
// windows can never fight for the foreground (the freeze). At most one window is
// granted focus per interval; competing requests are dropped (harmless — the worker
// windows are already visible-but-unfocused tiles where the SPA hydrates fine).
let _focusArb = { heldWin: null, heldAt: 0 };
async function grantWindowFront(winId, { force = false } = {}) {
  if (winId == null || !chrome.windows?.update) return false;
  const d = focusArbiterDecision(_focusArb, winId, Date.now(), { force });
  _focusArb = d.state;
  if (d.alreadyFront) return true;   // already the held foreground — no yank
  if (!d.grant) return false;        // REFUSED — this is what prevents the focus war
  try { await chrome.windows.update(winId, { focused: true, state: 'normal' }); } catch {}
  return true;
}

// Bring an apply window to the foreground and KEEP it there (no yank). Un-throttles the tab
// so the SPA hydrates. Captures the user's focus first so we can restore it later.
async function focusApplyWindow(winId) {
  if (winId == null || !chrome.windows?.update) return;
  await captureUserFocusOnce();
  await grantWindowFront(winId);     // arbiter-gated: never wars with a sibling window
}

// Restore focus to the user's previously-focused window — called when the run goes idle /
// stops. Resets capture so the next run records a fresh restore target.
async function restoreUserFocus() {
  const id = userFocusedWindowId;
  userFocusedWindowId = null;
  userFocusCaptured = false;
  _focusArb = { heldWin: null, heldAt: 0 };   // run over → clear the arbiter for the next run
  if (id == null || !chrome.windows?.update) return;
  if (isOurApplyWindow(id)) return;          // never restore "back" to one of our windows
  try { await chrome.windows.update(id, { focused: true }); } catch {}
}

// ── Option 2: human-in-the-loop Cloudflare check ──────────────────────────────────────────────
// When an apply tab hits a Cloudflare wall it can't pass without a person, we DON'T auto-solve.
// We raise an OS notification (chrome.notifications) and surface that tab so the user does the one
// click; the content-script executor keeps polling and resumes itself once cf_clearance is set
// (that cookie is shared across the normal Chrome profile, so one solve covers many later jobs).
const HUMAN_CHALLENGE_NOTE_ID = 'jat11-human-challenge';
let humanChallengeTabId = null;
let humanChallengeWinId = null;
// tab.id → ts while that apply tab is WAITING FOR THE USER on a Cloudflare wall. The run's hard-cap
// timer reads this (applyHardCapMs awaitingHuman) to use a 12-min cap instead of the 90s hidden-stall
// / 5.5-min caps — otherwise the cap fires, the channel breaks, and the background closes the very
// tab the user is solving. Persisted to storage.session so a recycled SW can still read it.
const aaAwaitingHuman = new Map();
async function setAwaitingHuman(tabId, on) {
  if (tabId == null) return;
  if (on) aaAwaitingHuman.set(tabId, Date.now()); else aaAwaitingHuman.delete(tabId);
  try { await chrome.storage?.session?.set?.({ jatAwaitingHuman: [...aaAwaitingHuman.keys()] }); } catch {}
}
(async () => { try { const s = await chrome.storage?.session?.get?.('jatAwaitingHuman'); for (const id of (s?.jatAwaitingHuman || [])) aaAwaitingHuman.set(Number(id), Date.now()); } catch {} })();
function setChallengeBadge(on) {
  try { chrome.action?.setBadgeText?.({ text: on ? '!' : '' }); } catch {}
  try { if (on) chrome.action?.setBadgeBackgroundColor?.({ color: '#d4351c' }); } catch {}
}
// Persist the challenge target so the notification CLICK still works after the MV3 service worker
// sleeps during the multi-minute wait (in-memory vars are lost when the SW is killed).
async function rememberChallengeTarget(tabId, winId) {
  humanChallengeTabId = tabId; humanChallengeWinId = winId;
  try { await chrome.storage?.session?.set?.({ jatHumanChallenge: { tabId, winId } }); } catch {}
}
async function recallChallengeTarget() {
  if (humanChallengeTabId != null) return { tabId: humanChallengeTabId, winId: humanChallengeWinId };
  try { const s = await chrome.storage?.session?.get?.('jatHumanChallenge'); return s?.jatHumanChallenge || { tabId: null, winId: null }; } catch { return { tabId: null, winId: null }; }
}
async function notifyHumanChallenge(sender, msg) {
  const tabId = sender?.tab?.id;
  if (tabId == null) return;
  const winId = sender?.tab?.windowId ?? null;
  await rememberChallengeTarget(tabId, winId);
  await setAwaitingHuman(tabId, true);       // suspend the run's hard cap while the user solves it
  trackAaTab(tabId);                         // refresh the tab's age so the reaper never closes it mid-solve
  setChallengeBadge(true);                   // toolbar badge — a persistent indicator
  try { await chrome.tabs.update(tabId, { active: true }); } catch {}        // make it the visible tab
  // MULTI-CHANNEL alert (OS often BLOCKS programmatic focus-steal, so don't rely on one signal):
  //   • drawAttention flashes the taskbar/title (works even when focus is denied) — every ping.
  //   • focusApplyWindow tries to raise the window (captures/restores focus) — first time only, so
  //     we don't yank focus back while the user is mid-solve.
  try { if (winId != null) await chrome.windows.update(winId, { drawAttention: true }); } catch {}
  if (!msg?.repeat) { try { if (winId != null) await focusApplyWindow(winId); } catch {} }
  if (!chrome.notifications?.create) return;
  const host = String(msg?.host || 'the job site').replace(/^www\./, '');
  try {
    await chrome.notifications.create(HUMAN_CHALLENGE_NOTE_ID, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Quick check needed to keep applying',
      message: `${host} wants you to confirm you're human. Click here (or the flashing tab) and check the box — auto-apply will continue on its own.`,
      priority: 2,
      requireInteraction: true,
    });
  } catch {}
}
async function clearHumanChallengeNotice(tabId = null) {
  if (tabId != null) await setAwaitingHuman(tabId, false);
  else { aaAwaitingHuman.clear(); try { await chrome.storage?.session?.remove?.('jatAwaitingHuman'); } catch {} }
  setChallengeBadge(false);
  humanChallengeTabId = null;
  humanChallengeWinId = null;
  try { await chrome.storage?.session?.remove?.('jatHumanChallenge'); } catch {}
  try { await chrome.notifications?.clear?.(HUMAN_CHALLENGE_NOTE_ID); } catch {}
}
// Clicking the notification brings the apply window forward (user gesture → safe) + focuses the tab
// so the user lands right on the check. Recalls the target from storage if the SW was recycled.
chrome.notifications?.onClicked?.addListener((id) => {
  if (id !== HUMAN_CHALLENGE_NOTE_ID) return;
  (async () => {
    const { tabId, winId } = await recallChallengeTarget();
    try { if (winId != null) await focusApplyWindow(winId); } catch {}
    try { if (tabId != null) await chrome.tabs.update(tabId, { active: true }); } catch {}
    try { await chrome.notifications.clear(HUMAN_CHALLENGE_NOTE_ID); } catch {}
  })();
});

// source tab id -> { token, childTabId, createdAt }. This intentionally stays in memory:
// the arm→click→claim transaction lasts seconds and the open message port keeps MV3 alive.
// Stale entries are swept defensively so an intercepted click cannot leak state.
const externalHandoffs = new Map();

function normalizeWindowIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0))];
}

const aaRuntimeLoad = (async () => {
  try {
    const o = await chrome.storage.local.get([AA_TABS_KEY, AA_PRIMARY_WINDOW_KEY, AA_WINDOW_POOL_KEY, AA_REUSE_TAB_KEY]);
    aaTabs = (o && o[AA_TABS_KEY]) || {};
    aaWindowId = o && o[AA_PRIMARY_WINDOW_KEY] ? Number(o[AA_PRIMARY_WINDOW_KEY]) : null;
    aaWindowPool = normalizeWindowIds(o && o[AA_WINDOW_POOL_KEY]);
    aaReuseTabId = o && o[AA_REUSE_TAB_KEY] ? Number(o[AA_REUSE_TAB_KEY]) : null;
  } catch {}
  aaRuntimeHydrated = true;
})();

async function hydrateAaRuntime() {
  if (!aaRuntimeHydrated) {
    try { await aaRuntimeLoad; } catch {}
    aaRuntimeHydrated = true;
  }
}

function persistAaTabs() { try { chrome.storage.local.set({ [AA_TABS_KEY]: aaTabs }); } catch {} }
function trackAaTab(id) { if (id != null) { aaTabs[id] = Date.now(); persistAaTabs(); } }
function untrackAaTab(id) { if (id != null && aaTabs[id] != null) { delete aaTabs[id]; persistAaTabs(); } }
function persistAaWindowPool() { try { chrome.storage.local.set({ [AA_WINDOW_POOL_KEY]: aaWindowPool }); } catch {} }
function persistAaWindowId() {
  try {
    if (aaWindowId != null) chrome.storage.local.set({ [AA_PRIMARY_WINDOW_KEY]: aaWindowId });
    else chrome.storage.local.remove(AA_PRIMARY_WINDOW_KEY);
  } catch {}
}
function allOwnedWindowIds() {
  return normalizeWindowIds([aaWindowId, ...aaWindowPool]);
}
function isBlankChromeTab(t) {
  const u = String(t?.url || '').toLowerCase();
  // Recognize the blank / new-tab / home page across Chrome, Edge AND FIREFOX. This gates whether a
  // dedicated apply window counts as "empty" (safe to close) vs "has a real user tab" (leave open).
  // The window that chrome.windows.create() opens gets a browser new-tab; on Firefox that URL is
  // about:newtab / about:home (not chrome://newtab), so the OLD Chrome-only check misread it as a
  // user tab → windowHasUserTabs()=true → the apply window was NEVER closed and orphaned windows piled
  // up by the dozen (dad's Firefox: 20-30 windows that Stop couldn't clear). Cover the Firefox URLs.
  return !u
    || u === 'about:blank'
    || u === 'about:newtab'
    || u === 'about:home'
    || u === 'about:privatebrowsing'
    || u.startsWith('chrome://newtab')
    || u.startsWith('edge://newtab');
}
// A user (or Chrome) closing a tab must drop it from the registry too.
chrome.tabs.onRemoved.addListener((tabId) => {
  untrackAaTab(tabId);
  aaFrontRequested.delete(tabId);   // authoritative cleanup for EVERY close path (supervised/reaper/Stop) — the per-run deletes in launchOne miss the supervised branch
  externalHandoffs.delete(tabId);
  for (const [sourceId, handoff] of externalHandoffs) {
    if (handoff.childTabId === tabId) externalHandoffs.delete(sourceId);
  }
});

// POPUP-BLOCKED-HANDOFF FIX: an external "Apply on company site (opens in a new tab)" control
// usually opens via window.open(). Chrome blocks window.open under our SYNTHETIC (untrusted)
// click, so the company tab never opens and the handoff finds nothing ("apply handoff did not
// attach" — the dominant Indeed failure in the live logs). We can't synthesize a trusted click
// from a content script, so instead we hook window.open in the page's MAIN world to RECORD the
// URL the page wanted to open (onto a shared DOM attribute the isolated content world can read),
// suppress the (blocked-anyway) popup, and then open that URL ourselves via chrome.tabs.create.
// Also captures target=_blank anchor clicks. Best-effort + idempotent; never breaks the page.
async function installOpenHook(tabId) {
  if (!chrome.scripting?.executeScript || tabId == null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      func: () => {
        if (window.__jatOpenHooked) return;
        window.__jatOpenHooked = true;
        const rec = (u) => { try { if (u) document.documentElement.setAttribute('data-jat-exturl', String(u)); } catch (e) {} };
        const orig = window.open;
        try {
          window.open = function (u) { rec(u); return null; };   // suppress the blocked popup; we open it via the SW
          window.open.toString = () => orig.toString();
        } catch (e) {}
        document.addEventListener('click', (e) => {
          // ONLY target=_blank is a genuine new-tab intent. rel="noopener" alone does NOT mean a
          // new tab (plain same-tab links carry it too) — capturing those would wrongly open a
          // competing tab alongside a same-tab navigation. window.open (above) covers the rest.
          try { const a = e.target && e.target.closest && e.target.closest('a[href]'); if (a && a.target === '_blank') rec(a.href); } catch (_) {}
        }, true);
      },
    });
  } catch {}
}

// Open the captured external URL directly (bypassing the popup block) and register it as THIS
// handoff's child, so the existing waitForExternalTarget/runExternalHandoff path drives it.
async function openExternalUrl(sourceTabId, token, url) {
  const h = externalHandoffs.get(sourceTabId);
  if (!h || h.token !== token || h.childTabId != null || !url) return { ok: false };
  if (!/^https?:\/\//i.test(String(url))) return { ok: false };   // only real http(s) targets
  let winId;
  try { winId = (await chrome.tabs.get(sourceTabId))?.windowId; } catch {}
  let tab = null;
  try { tab = await chrome.tabs.create({ url, active: false, ...(winId != null ? { windowId: winId } : {}) }); } catch {}
  if (tab?.id != null) { captureExternalChild(sourceTabId, tab.id); return { ok: true, tabId: tab.id }; }
  return { ok: false };
}

async function armExternalHandoff(sourceTabId, taskId, routeState) {
  if (sourceTabId == null) return null;
  for (const [id, stale] of externalHandoffs) {
    if (Date.now() - stale.createdAt > 30000) externalHandoffs.delete(id);
  }
  const token = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let initialUrl = '';
  try { initialUrl = (await chrome.tabs.get(sourceTabId))?.url || ''; } catch {}
  externalHandoffs.set(sourceTabId, { token, childTabId: null, createdAt: Date.now(), initialUrl, taskId: taskId || null });
  await installOpenHook(sourceTabId);   // record where the opener's window.open() wants to go
  if (taskId) {
    await api.call('PATCH', '/queue/' + taskId, {
      handoffToken: token, routeState: routeState || 'unknown', applyRoute: 'external',
      transcriptAppend: { kind: 'handoff', note: 'external ownership armed before click' },
    }).catch(() => {});
  }
  return token;
}

function captureExternalChild(sourceTabId, childTabId) {
  const handoff = externalHandoffs.get(sourceTabId);
  if (!handoff || childTabId == null || Date.now() - handoff.createdAt > 30000) return;
  handoff.childTabId = childTabId;
  trackAaTab(childTabId);
  try { chrome.tabs.update(childTabId, { autoDiscardable: false }).catch(() => {}); } catch {}
  try { groupTab(childTabId).catch(() => {}); } catch {}
}

// Chrome exposes openerTabId on target=_blank. webNavigation's created-target event is
// the stronger fallback for scripted window.open and redirector links.
chrome.tabs.onCreated.addListener((tab) => captureExternalChild(tab?.openerTabId, tab?.id));
try {
  chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => captureExternalChild(d?.sourceTabId, d?.tabId));
} catch {}

async function waitForExternalTarget(sourceTabId, token, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const handoff = externalHandoffs.get(sourceTabId);
    if (!handoff || handoff.token !== token) return null;
    if (handoff.childTabId != null) return { tabId: handoff.childTabId, child: true };
    try {
      const source = await chrome.tabs.get(sourceTabId);
      // EXT-2: a host-OR-path change on the source tab means the external handoff transferred
      // it in-tab (host change = the obvious linkedin.com→company.com; path-only change = a slow
      // /jobs→/jobs/apply or an SSO bounce that keeps the host). A query/hash-only change is
      // render noise, not a navigation — externalTargetFromNav (via pageActionUrlKey) ignores it.
      if (externalTargetFromNav({ initialUrl: handoff.initialUrl, currentUrl: source?.url })) {
        return { tabId: sourceTabId, child: false };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

// The manifest declares content/loader.js as the resident content script in every
// frame; this is the SAME entry, so programmatic injection mirrors the normal load
// path (the loader then lazy-imports the engine). Idempotent: the loader self-guards
// with window.__jat11_loaded, so re-injecting an already-loaded frame is a no-op.
const CONTENT_ENTRY = 'content/loader.js';

// Heavy SPA / redirect / login / late document_idle on the external ATS child tab
// frequently means the manifest content script hasn't attached yet, so the very first
// sendMessage gets "Could not establish connection. Receiving end does not exist." That
// is recoverable: force-inject the content entry, then retry. Only after injection +
// retry still fails do we let the caller fall back.
async function injectContentEntry(tabId) {
  // MV3 (Chrome + Firefox event-page): chrome.scripting.
  if (chrome.scripting?.executeScript) {
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: [CONTENT_ENTRY] });
      return true;
    } catch { return false; }
  }
  // MV2 (the persistent Firefox variant): chrome.scripting does not exist — use the classic
  // tabs.executeScript. Without this the apply tab never gets the content entry, every task
  // fails "Receiving end does not exist" → timed out/interrupted, and nothing ever submits.
  if (chrome.tabs?.executeScript) {
    try {
      await new Promise((resolve, reject) => {
        chrome.tabs.executeScript(tabId, { file: CONTENT_ENTRY, frameId: 0, runAt: 'document_idle' }, (r) => {
          const e = chrome.runtime && chrome.runtime.lastError;
          if (e) reject(e); else resolve(r);
        });
      });
      return true;
    } catch { return false; }
  }
  return false;
}

async function sendTaskWhenReady(tabId, message, timeoutMs = 20000) {
  const started = Date.now();
  let lastError = null;
  let injected = false;
  while (Date.now() - started < timeoutMs) {
    try { return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 }); }
    catch (e) {
      lastError = e;
      // "Receiving end does not exist" → the content script isn't loaded in this tab.
      // Inject it once (mirroring the manifest load), then keep retrying so the loader
      // has time to register its onMessage listener before we give up.
      if (!injected) { injected = await injectContentEntry(tabId); }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError || new Error('external target content script did not become ready');
}

async function runExternalHandoff(sourceTabId, token, task, context) {
  const target = await waitForExternalTarget(sourceTabId, token);
  if (!target) {
    externalHandoffs.delete(sourceTabId);
    return { ok: true, captured: false };
  }
  const childTabId = target.tabId;
  let child = null;
  try {
    await waitTabComplete(childTabId, 30000);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    child = await chrome.tabs.get(childTabId);
    // Proactively ensure the content entry is attached on the external ATS tab before we
    // dispatch. The manifest content script may not have run yet (redirect chains, login
    // walls, throttled document_idle), and sendTaskWhenReady also injects-on-miss as a
    // belt-and-braces retry. Idempotent via the loader's window.__jat11_loaded guard.
    await injectContentEntry(childTabId);
    const childContext = {
      ...(context || {}),
      externalHandoff: true,
      sourceJobUrl: context?.job?.jobUrl || null,
      // A recipe resolved for the LinkedIn/Indeed source page must never replay on a
      // different ATS. The child still uses generic autofill + QA memory, while its
      // recorder learns the real target site's recipe from this run.
      recipe: null,
      job: { ...(context?.job || {}), jobUrl: child?.url || context?.job?.jobUrl },
    };
    if (task?.id != null) {
      await api.call('PATCH', '/queue/' + task.id, {
        handoffToken: token,
        routeState: target.child ? 'external_new_tab' : 'external_same_tab',
        applyRoute: 'external',
        transcriptAppend: { kind: 'handoff', note: `executor transferred to external tab ${childTabId}`, url: child?.url || null },
      }).catch(() => {});
    }
    const runType = childContext.supervised ? 'jat11.supervised-run' : 'jat11.run-task';
    const dispatch = sendTaskWhenReady(childTabId, { type: runType, task, context: childContext });
    const result = childContext.supervised
      ? await dispatch
      : await Promise.race([
          dispatch,
          new Promise((_, reject) => setTimeout(() => reject(new Error('external apply timed out after 4 min')), 240000)),
        ]);
    return { ok: result?.ok !== false, captured: true, childTabId, sameTab: !target.child, url: child?.url || null, result };
  } catch (e) {
    if (task?.id != null) {
      await api.call('PATCH', '/queue/' + task.id, {
        state: 'failed', attemptsDelta: 1, lastError: String(e?.message || e),
        transcriptAppend: { kind: 'handoff', note: 'external executor error: ' + String(e?.message || e), url: child?.url || null },
      }).catch(() => {});
    }
    return { ok: false, captured: true, childTabId, error: String(e?.message || e), result: { ok: false, state: 'failed', error: String(e?.message || e) } };
  } finally {
    externalHandoffs.delete(sourceTabId);
    if (target.child) {
      try { await chrome.tabs.remove(childTabId); } catch {}
      untrackAaTab(childTabId);
    }
  }
}

// Close any tracked AA tab that's too old (stuck) or over the cap (oldest first), and
// drop ids whose tab no longer exists. Safety net beyond the per-task close paths.
async function reapAaTabs() {
  await hydrateAaRuntime();
  await reapIdleApplyWindows();   // close any empty dedicated windows the opt-in modes left behind
  const ids = Object.keys(aaTabs).map(Number);
  if (!ids.length) return;
  const now = Date.now();
  // verify existence + collect ages
  const live = [];
  for (const id of ids) {
    let tab = null;
    try { tab = await chrome.tabs.get(id); } catch { untrackAaTab(id); continue; }
    if (!tab) { untrackAaTab(id); continue; }
    live.push({ id, age: now - (aaTabs[id] || now) });
  }
  // age-out
  for (const t of live) {
    if (t.age > AA_TAB_MAX_AGE_MS) { try { await chrome.tabs.remove(t.id); } catch {} untrackAaTab(t.id); }
  }
  // cap (close oldest beyond the ceiling)
  const remaining = live.filter((t) => aaTabs[t.id] != null).sort((x, y) => y.age - x.age);
  for (let i = AA_TAB_CAP; i < remaining.length; i++) {
    try { await chrome.tabs.remove(remaining[i].id); } catch {} untrackAaTab(remaining[i].id);
  }
}

async function windowHasUserTabs(win) {
  return ((win && win.tabs) || []).some((t) => aaTabs[t.id] == null && !isBlankChromeTab(t));
}

async function closeOwnedWindowIfSafe(id) {
  if (id == null || !chrome.windows?.get || !chrome.windows?.remove) return false;
  let win = null;
  try { win = await chrome.windows.get(id, { populate: true }); } catch { return true; }
  if (await windowHasUserTabs(win)) return false;   // Pierre may have moved a real tab there; forget, don't close it.
  try { await chrome.windows.remove(id); } catch {}
  return true;
}

async function reconcileOwnedWindows({ closeIdle = false } = {}) {
  await hydrateAaRuntime();
  let changed = false;
  if (aaWindowId != null && chrome.windows?.get) {
    try { await chrome.windows.get(aaWindowId); }
    catch { aaWindowId = null; changed = true; }
  }
  const livePool = [];
  for (const id of aaWindowPool) {
    try { if (chrome.windows?.get) await chrome.windows.get(id); livePool.push(id); }
    catch { aaBusyWindows.delete(id); changed = true; }
  }
  if (livePool.length !== aaWindowPool.length) { aaWindowPool = normalizeWindowIds(livePool); changed = true; }

  if (closeIdle) {
    for (const id of allOwnedWindowIds()) {
      if (aaBusyWindows.has(id)) continue;
      let win = null;
      try { win = await chrome.windows.get(id, { populate: true }); } catch { continue; }
      const tabs = (win && win.tabs) || [];
      const hasAa = tabs.some((t) => aaTabs[t.id] != null);
      if (hasAa) continue;
      if (await windowHasUserTabs(win)) {
        if (id === aaWindowId) { aaWindowId = null; changed = true; }
        if (aaWindowPool.includes(id)) { aaWindowPool = aaWindowPool.filter((w) => w !== id); changed = true; }
        aaBusyWindows.delete(id);
        continue;
      }
      await closeOwnedWindowIfSafe(id);
      if (id === aaWindowId) { aaWindowId = null; changed = true; }
      if (aaWindowPool.includes(id)) { aaWindowPool = aaWindowPool.filter((w) => w !== id); changed = true; }
      aaBusyWindows.delete(id);
    }
  }

  const cap = Math.max(1, Math.min(AA_WINDOW_CAP, Number(currentConcurrency) || 1));
  const extra = aaWindowPool.filter((id) => !aaBusyWindows.has(id)).slice(cap);
  for (const id of extra) {
    await closeOwnedWindowIfSafe(id);
    aaWindowPool = aaWindowPool.filter((w) => w !== id);
    aaBusyWindows.delete(id);
    changed = true;
  }
  if (changed) { persistAaWindowId(); persistAaWindowPool(); }
}

async function reconcileAaTabsAndSlots() {
  await hydrateAaRuntime();
  const live = [];
  for (const id of Object.keys(aaTabs).map(Number)) {
    try { await chrome.tabs.get(id); live.push(id); }
    catch { untrackAaTab(id); }
  }
  if (!live.length) {
    if (activeCount > 0) activeCount = 0;
    return 0;
  }
  // Count BUSY slots by how many applies are ACTUALLY IN FLIGHT (app truth: running + scheduled),
  // NOT by how many tabs are open. In serial mode the ONE warm reuse-tab (aaReuseTabId) stays open
  // BETWEEN applies to preserve the site session — but it's IDLE, not running an apply. The old code
  // counted every live tab as an occupied slot, so that single idle warm tab pinned the concurrency-1
  // slot until it aged out at AA_TAB_MAX_AGE_MS (8 min) — the pump then refused to dispatch and applies
  // gapped ~9 min apart (THE root cause of the ~7/hr collapse). Using the in-flight count frees the
  // slot the instant an apply finishes, while `scheduled` still counts a just-dispatched apply so we
  // NEVER open a second on top of a genuinely-running one (preserves the parallel-window freeze guard).
  // Falls back to the old live-tab count only if the app is unreachable (stays conservative → no burst).
  let inFlight = null;
  try {
    const r = await api.call('GET', '/auto-apply/live', null, 5000);
    if (r && (Number.isFinite(r.active) || Number.isFinite(r.scheduled))) {
      inFlight = (Number(r.active) || 0) + (Number(r.scheduled) || 0);
    }
  } catch {}
  const busy = inFlight != null ? inFlight : live.length;
  activeCount = Math.max(0, Math.min(busy, live.length, Math.max(1, currentConcurrency)));
  return live.length;
}

// MV3 evicts the service worker after ~30s idle, which would wipe aaGroupId and make
// the next tick spawn a SECOND group. Recover the existing one by its title first so
// there's only ever one "JAT Auto-apply" group across SW restarts.
async function recoverAaGroup() {
  if (aaGroupId != null) return aaGroupId;
  if (!CAPS.tabGroups) return aaGroupId;   // Firefox: no tabGroups — the tab REGISTRY drives cleanup instead
  try {
    if (chrome.tabGroups?.query) {
      const groups = await chrome.tabGroups.query({ title: AA_GROUP_TITLE });
      if (groups && groups.length) aaGroupId = groups[0].id;
    }
  } catch {}
  return aaGroupId;
}

// The window auto-apply / discovery / sync tabs open in. A PERSISTENT dedicated window
// that JAT owns — NEVER the window you're working in. It's created ONCE, on-display but
// BEHIND your work (focused:false + focus handed straight back), and then REUSED for the
// whole run (so it never repeatedly pops up), and closed only on Stop. The apply tab is
// the ACTIVE tab there, so the page loads un-throttled WITHOUT ever touching your window.
// BUG-2: resolve where the dedicated apply window should be created. Queries the connected
// displays (guarded — chrome.system.display may be absent on older/Firefox builds) and asks
// the pure pickApplyWindowBounds helper. Returns a {left,top,width,height} placement merged
// onto the base create options, plus `multiDisplay` so callers can decide focus behavior:
//   • ≥2 displays → place on a NON-primary display (fully visible there ⇒ not occluded ⇒
//     Chrome won't throttle AND it never covers the user's main-display work).
//   • 1 display    → place out of the way (bottom-right) and DON'T steal focus.
// Falls back to today's top-left placement if display info is unavailable.
async function resolveApplyWindowCreate(base = {}, tile = {}) {
  // DEFENSIVE ANTI-STACK: when the display API is unavailable we can't tile to a real work area,
  // but we must still NOT create every parallel worker window at the same coordinates — stacked
  // windows occlude each other → Chrome throttles the covered ones → they never hydrate AND the
  // front-until-hydrate net fights over the foreground. So cascade each slot by a fixed offset
  // so parallel windows are at least distinct + individually reachable. Single-worker (slots<=1)
  // keeps the original top-left placement.
  const slots = Math.max(1, Number(tile.slots) || 1);
  const slot = Math.max(0, Math.min(slots - 1, Number(tile.slot) || 0));
  const fbLeft = 60 + (slots > 1 ? slot * 80 : 0);
  const fbTop = 60 + (slots > 1 ? slot * 70 : 0);
  const fbW = slots > 1 ? 1000 : 1200;
  const fallback = { left: fbLeft, top: fbTop, width: fbW, height: 900, ...base };
  let displays = null;
  try {
    if (chrome.system?.display?.getInfo) displays = await chrome.system.display.getInfo();
  } catch { displays = null; }
  if (!Array.isArray(displays) || !displays.length) return { create: fallback, multiDisplay: false };
  // `tile` = { slot, slots } — when slots>1 (concurrency>1) each worker window gets a distinct
  // side-by-side tile so parallel windows never occlude/throttle each other.
  const bounds = pickApplyWindowBounds(displays, tile);
  if (!bounds) return { create: fallback, multiDisplay: false };
  return { create: { ...base, ...bounds }, multiDisplay: displays.length >= 2 };
}

async function autoApplyTargetWindow() {
  await hydrateAaRuntime();
  await recoverAaGroup();
  if (aaGroupId != null && chrome.tabGroups?.get) {
    try { const g = await chrome.tabGroups.get(aaGroupId); aaWindowId = g.windowId; return g.windowId; }
    catch { aaGroupId = null; }
  }
  // Reuse our dedicated window if it's still open.
  if (aaWindowId != null && chrome.windows?.get) {
    try { await chrome.windows.get(aaWindowId); return aaWindowId; }
    catch { aaWindowId = null; }
  }
  // Create it once. We OWN it (safe to close on Stop) — we never borrow or close one of
  // your own windows.
  try {
    let win = null;
    // NON-FOCUS-STEALING (reverts the v11.26.0 focus thrash). DIRECT live observation proved
    // the Easy Apply form mounts + works on a HIDDEN, UNFOCUSED tab (document.hasFocus()===false,
    // visibilityState==='hidden'). So we do NOT steal the foreground: create the apply window
    // `focused:false`. BUG-2 placement is KEPT — on a multi-display setup the window goes FULLY
    // onto a non-primary display (off the user's main screen, so it's visible+un-throttled there
    // WITHOUT covering the user's work); on a single display it goes out of the way (bottom-right).
    // The opener-stall→front + front-until-hydrate paths remain as a RARE last-resort safety net.
    const placement = await resolveApplyWindowCreate({ focused: false, state: 'normal' });
    try { win = await chrome.windows.create(placement.create); } catch {}
    aaWindowId = win ? win.id : null;
    persistAaWindowId();
    return aaWindowId != null ? aaWindowId : undefined;
  } catch { return undefined; }
}

// SAFETY-NET ONLY (reverted from the v11.26.0 always-on focus model). The normal path no
// longer fronts the apply window — live observation proved the form mounts on a hidden/
// unfocused tab, so fronting only disrupts the user. This fires solely from the legacy
// jat11.nudge-apply-window message (when frontToHydrate is OFF) as a rare last-resort raise
// for a tab that reported itself occluded AND not hydrating. The user's focus is restored at
// run idle/stop (restoreUserFocus). Only ever touches windows WE own. Idempotent + guarded.
async function nudgeApplyWindows() {
  await hydrateAaRuntime();
  if (!chrome.windows?.update) return;
  await captureUserFocusOnce();
  const ids = [aaWindowId, ...aaWindowPool].filter((x) => x != null);
  // Arbiter-gated: fronting EVERY owned window in a loop was itself a focus war. The
  // arbiter grants at most one per interval, so at most one nudge lands per cycle.
  for (const id of ids) {
    if (await grantWindowFront(id)) break;   // one nudge is enough; the rest wait their turn
  }
}

// ---- FRONT-UNTIL-HYDRATED (occlusion safety net) ------------------------------------
// With the STABLE focus model above, the active apply window is already fronted for the run,
// so an occluded apply tab should be rare. This stays as a reactive SAFETY NET: if an apply
// tab still reports itself occluded-and-not-yet-hydrated (e.g. the user clicked back onto
// their own window mid-run), re-front its window for a SHORT window so the SPA gets visible
// time. The run-level restoreUserFocus() owns handing focus back, so release here only clears
// the safety timer (no per-release focus yank → no thrash). Only ever touches OUR windows.
const frontHeld = new Map();   // applyWindowId → { timer }
// EXT-3: 4s was too short for a Chrome-throttled SPA resuming from background to render the
// Easy-Apply / "Apply on company site" handoff link before we released focus. 14s gives a heavy
// external ATS time to hydrate while reactively fronted, then self-releases. This is STILL the
// safety-net path only (fires from nudge-apply-window when a tab reports itself occluded AND not
// hydrating); the normal path never fronts. bringToFrontToHydrate stays OFF by default — we do
// NOT steal focus on every apply, only on a tab that proved it was stuck behind the throttle.
const FRONT_HARD_CAP_MS = 14000;   // safety-net only; the apply window is normally already front

// ---- HIDDEN-NON-HYDRATING fast-fail (FIX 1) ----------------------------------------
// THROUGHPUT BUG (live): a hidden apply tab that won't hydrate used to burn the FULL
// APPLY_HARD_CAP_MS (5.5 min) before failing — at concurrency=1 that single stall freezes
// the whole queue. The cap selection lives in the pure lib/apply-cap.js helper (node-
// testable). A tab that front-requested but NOT yet hydrated is the "hidden, non-hydrating"
// case → fail it FAST + RETRIABLY (~90s) so retry-stale re-attempts it later (when it may be
// foreground). aaFrontRequested tracks per-tab { at, hydrated } from the two messages below.
const aaFrontRequested = new Map();        // apply tabId → { at, hydrated } (hidden-non-hydrating tracker)

function isOurApplyWindow(winId) {
  if (winId == null) return false;
  return winId === aaWindowId || aaWindowPool.includes(winId);
}

async function frontUntilHydrated(applyWinId) {
  await hydrateAaRuntime();
  if (applyWinId == null || !chrome.windows?.update) return;
  if (!isOurApplyWindow(applyWinId)) return;   // never front a window we don't own
  if (frontHeld.has(applyWinId)) return;       // already holding this one
  await captureUserFocusOnce();
  // Bring the apply window to the front and keep it there (stable; no 700ms yank).
  // Arbiter-gated so N parallel windows requesting front-until-hydrate can't thrash focus.
  if (!(await grantWindowFront(applyWinId))) return;   // refused this cycle → stay a visible tile
  // Short safety cap — just clears the hold marker; focus restore is run-level.
  const timer = setTimeout(() => { try { releaseFrontUntilHydrated(applyWinId); } catch {} }, FRONT_HARD_CAP_MS);
  frontHeld.set(applyWinId, { timer });
}

async function releaseFrontUntilHydrated(applyWinId) {
  if (applyWinId == null) return;
  const held = frontHeld.get(applyWinId);
  if (!held) return;
  frontHeld.delete(applyWinId);
  try { clearTimeout(held.timer); } catch {}
  // No focus yank here — restoreUserFocus() (run idle/stop) owns handing the user back.
}

// ---------- dedicated-window POOL for the OPT-IN reliability / PARALLEL modes ----------
// Only used when "bring window to front" is on OR concurrency > 1. Each such worker gets
// its OWN dedicated window (one active/visible, un-throttled tab per window). Windows are
// reused across applies; the reaper closes empty ones; Stop closes them all.
async function acquireApplyWindow(focus = false) {
  await hydrateAaRuntime();
  await reconcileOwnedWindows();
  const cap = Math.max(1, Math.min(AA_WINDOW_CAP, Number(currentConcurrency) || 1));
  // Reuse a free dedicated window…
  let win = aaWindowPool.find((id) => !aaBusyWindows.has(id));
  if (win == null) {
    // If an MV3 restart desynced slot accounting, stay bounded: reuse an owned
    // window instead of creating an unbounded new Chrome window.
    if (aaWindowPool.length >= cap && aaWindowPool.length) win = aaWindowPool[0];
  }
  if (win == null && aaWindowPool.length < cap) {
    // …or create one. NON-FOCUS-STEALING: create it `focused:false` by default (the form
    // mounts fine on an unfocused on-display tab). Only the opt-in "bring window to front"
    // path (focus===true) actually fronts. BUG-2 placement is kept: a non-primary display
    // when available (off the user's screen + un-throttled), else out of the way.
    try {
      if (focus) await captureUserFocusOnce();
      // Tile this worker's window into its own slot (its index in the pool) of `cap` columns,
      // so concurrency>1 lays the windows side-by-side instead of stacking them (stacked =
      // occluded = Chrome-throttled = never hydrates). Single-worker runs pass slots:1 → the
      // original out-of-the-way placement.
      const placement = await resolveApplyWindowCreate(
        { focused: !!focus, state: 'normal' },
        { slot: aaWindowPool.length, slots: cap },
      );
      const w = await chrome.windows.create(placement.create);
      if (w) {
        win = w.id;
        aaWindowPool = normalizeWindowIds([...aaWindowPool, win]);
        persistAaWindowPool();
        if (focus) { await grantWindowFront(win); }   // arbiter-gated (opt-in bring-to-front mode)
      }
    } catch {}
  }
  if (win != null) aaBusyWindows.add(win);
  return win;
}
function releaseApplyWindow(winId) { if (winId != null) aaBusyWindows.delete(winId); }

// Close dedicated apply windows that are idle (not running an apply) AND empty (no
// auto-apply tabs left) so the opt-in reliability/parallel modes never leave a stray
// empty Chrome window sitting around. Called from the 2-min reaper.
async function reapIdleApplyWindows() {
  await hydrateAaRuntime();
  if (!allOwnedWindowIds().length || !chrome.windows?.get) return;
  await reconcileOwnedWindows({ closeIdle: true });
}

// Open a tab for an auto-apply / discovery / applied-sync job in a dedicated window.
// APPLY tabs open ACTIVE (active+visible = un-throttled, so the page + Easy-Apply
// button hydrate). DISCOVERY/SYNC tabs open in the BACKGROUND (active:false) so they
// never steal "active" from a running apply tab (which would re-throttle it); their
// scraping tolerates throttling. `winId` overrides the window (used by the worker pool).
// Returns the created tab.
async function createAaTab(url, { active = true, focusWindow = false, winId: forceWin, isApply = false } = {}) {
  const winId = forceWin != null ? forceWin : await autoApplyTargetWindow();
  const tab = await chrome.tabs.create({ url, active, ...(winId ? { windowId: winId } : {}) });
  trackAaTab(tab.id);   // register for cleanup/reaping (works without tabGroups, e.g. Firefox)
  await groupTab(tab.id);
  // NON-FOCUS-STEALING: the normal path does NOT front the apply window (live observation
  // proved the form mounts on a hidden/unfocused tab, so fronting only disrupts the user).
  // The apply tab is the ACTIVE tab in its own (on-display) dedicated window; the opener-stall
  // → front and front-until-hydrate paths remain as a rare reactive safety net for the unusual
  // case where the tab really is occluded AND won't hydrate. `focusWindow` opt-in still fronts.
  if (isApply && focusWindow && winId != null && chrome.windows?.update) {
    try { await focusApplyWindow(winId); } catch {}
  }
  return tab;
}

// Collapse the "JAT Auto-apply" group so its background tabs stay tucked behind a single
// chip — keeps your tab bar tidy in the default (unobtrusive) mode. (In the opt-in
// dedicated-window modes the apply tab is the active tab in its own window, which Chrome
// keeps visible regardless, so this is a harmless no-op there.)
async function collapseAaGroup() {
  if (aaGroupId == null || !chrome.tabGroups?.update) return;   // Firefox: no tabGroups → skip
  try { await chrome.tabGroups.update(aaGroupId, { collapsed: true }); } catch {}
}
async function groupTab(tabId) {
  try {
    if (!chrome.tabs.group) return;
    await recoverAaGroup();   // reuse the existing group after an SW restart
    if (aaGroupId != null) {
      try {
        if (chrome.tabGroups?.get) await chrome.tabGroups.get(aaGroupId);   // confirm it still exists
        await chrome.tabs.group({ tabIds: [tabId], groupId: aaGroupId });   // joins the group (and its window)
        await collapseAaGroup();
        return;
      } catch { aaGroupId = null; }   // stale — make a fresh group below
    }
    aaGroupId = await chrome.tabs.group({ tabIds: [tabId] });
    if (chrome.tabGroups?.update) {
      try { await chrome.tabGroups.update(aaGroupId, { title: AA_GROUP_TITLE, color: 'yellow' }); } catch {}
    }
    await collapseAaGroup();
  } catch { aaGroupId = null; }
}

// Close every tab in the auto-apply group and forget it — used by "Stop everything"
// so the run's tabs don't linger. Task state is already persisted in the app DB
// (the dashboard stop-all patches queued/running → skipped before this runs), so
// nothing is lost by closing them.
async function closeAutoApplyTabs() {
  await hydrateAaRuntime();
  // Mark the teardown FIRST so any in-flight launchOne whose tab we're about to remove
  // bows out as 'skipped' instead of re-patching 'failed' (which fired the scary
  // "a queued application failed" toasts on Stop).
  stopping = true;
  if (stopWatchdog) { clearInterval(stopWatchdog); stopWatchdog = null; }
  aaReuseTabId = null;   // the warm reuse tab is among the tabs being closed below; forget it
  try { await chrome.storage?.local?.remove?.(AA_REUSE_TAB_KEY); } catch {}
  try {
    const ids = new Set();
    // Close EVERY "JAT Auto-apply" group's tabs — not just the cached one. An SW
    // eviction mid-run can leave MORE THAN ONE such group (recoverAaGroup only ever
    // adopted groups[0]), so Stop used to close one and leave the rest lingering.
    if (chrome.tabGroups?.query) {
      const groups = await chrome.tabGroups.query({ title: AA_GROUP_TITLE });
      for (const g of (groups || [])) {
        try { const tabs = await chrome.tabs.query({ groupId: g.id }); for (const t of tabs) if (t.id != null) ids.add(t.id); } catch {}
      }
    }
    if (aaGroupId != null && chrome.tabs?.query) {   // also the cached id, in case the title query missed it
      try { const tabs = await chrome.tabs.query({ groupId: aaGroupId }); for (const t of tabs) if (t.id != null) ids.add(t.id); } catch {}
    }
    // The TAB REGISTRY — the authoritative source, and the ONLY one that works in
    // Firefox (no tabGroups). Union it in so cleanup never misses a tracked tab.
    for (const id of Object.keys(aaTabs)) ids.add(Number(id));
    if (ids.size) { try { await chrome.tabs.remove([...ids]); } catch {} }
    aaTabs = {}; persistAaTabs();
    // Close EVERY dedicated apply window (the pool for parallel workers + the primary)
    // so none linger empty after Stop.
    const winIds = new Set(aaWindowPool);
    if (aaWindowId != null) winIds.add(aaWindowId);
    if (chrome.windows?.remove) {
      for (const id of winIds) {
        try { await releaseFrontUntilHydrated(id); } catch {}
        await closeOwnedWindowIfSafe(id);
      }
    }
    aaWindowPool = []; aaBusyWindows.clear();
  } catch {}
  // F2 FIX: the run is over — hand the user's focus back to where it was at run start.
  try { await restoreUserFocus(); } catch {}
  // Stop the self-driving timers too, so a queued re-pump can't pop a new tab open
  // moments after the user hit Stop.
  if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
  if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
  pumpDirty = false;
  aaGroupId = null;
  aaWindowId = null;
  persistAaWindowId();
  persistAaWindowPool();
  // Let in-flight launches see `stopping`, then clear it so the next Start is normal.
  setTimeout(() => { stopping = false; }, 8000);
}

// While a run is active, the user may stop it from the DESKTOP app — where the
// dashboard has no `chrome` and so can't reach the tabs. The app just flips
// enabled=false; without this watchdog the tabs would linger until the next 1-min
// alarm and the interrupted task would fail → toast. Poll the enabled flag cheaply
// and tear the run down the moment it goes off.
// LAG FIX (#2.4): ONE instance per RUN (the guard makes startStopWatchdog idempotent across
// every job-launch), cleared the moment activeCount hits 0, and polled at 8s (was 4s) — a
// desktop-app Stop tolerates an ~8s detection latency and this halves the background poll.
let stopWatchdog = null;
function startStopWatchdog() {
  if (stopWatchdog) return;
  stopWatchdog = setInterval(async () => {
    try {
      if (activeCount <= 0) { clearInterval(stopWatchdog); stopWatchdog = null; try { await restoreUserFocus(); } catch {} return; }
      const s = await api.call('GET', '/settings', null, 4000);
      const enabled = s?.ok ? !!s.settings?.autoApply?.enabled : true;
      if (!enabled) await closeAutoApplyTabs();   // clears the watchdog itself
    } catch {}
  }, 8000);
}

// Run ONE queued task end-to-end in its own tab. Pure per-task: opens the tab,
// hands the task to the executor (awaits the WHOLE run → resolves with the run's
// authoritative terminal state, which the executor has already report()-ed),
// reconciles, and closes the tab on terminal/parked outcomes. Never throws;
// returns the final state string. Slot accounting belongs to the caller.
async function launchOne(task, context) {
  const url = context.job.jobUrl;
  let tab = null;
  const bringFront = !!(context && context.bringToFront);
  const parallel = currentConcurrency > 1;
  // TAB REUSE (serial only): keep ONE warm apply tab and NAVIGATE it to each job rather than
  // open+close a fresh tab every time. A reused tab preserves the site's session — the Cloudflare
  // cf_clearance cookie, the navigation/referrer continuity, and the per-session bot-score trust —
  // so once the user passes a check it stays cleared far longer (fewer re-verifications). A parallel
  // pool still needs its own tab per worker, so reuse is off when concurrency > 1.
  const reuse = !parallel;
  const keepTab = (t) => { if (reuse && t) { aaReuseTabId = t.id; try { chrome.storage?.local?.set?.({ [AA_REUSE_TAB_KEY]: aaReuseTabId }); } catch {} } };
  // The apply tab is the ACTIVE tab in a window that is NEVER the one you're working in
  // (a persistent dedicated window — or a per-worker one when parallel). Being the active
  // tab in an on-display window means the page loads un-throttled, and since it's not your
  // window it never interrupts you. focusWindow (opt-in) additionally brings it to front.
  const winId = parallel ? await acquireApplyWindow(bringFront) : await autoApplyTargetWindow();
  try {
    // Reuse the warm serial tab if it's still alive — navigate it to this job (keeps the session).
    if (reuse && aaReuseTabId != null) {
      try {
        const warm = await chrome.tabs.get(aaReuseTabId);
        if (warm && !warm.discarded) {
          tab = warm;
          await chrome.tabs.update(tab.id, { url, active: true, autoDiscardable: false });
          trackAaTab(tab.id);                 // refresh its age so the reaper won't close it mid-run
          try { await groupTab(tab.id); } catch {}
        }
      } catch { aaReuseTabId = null; }
    }
    if (!tab) {
      tab = await createAaTab(url, { active: true, focusWindow: bringFront, winId, isApply: true });
      try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch {}   // don't let Chrome discard it mid-apply
    }
    keepTab(tab);

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
      // HARD TIMEOUT: a hung executor (frozen tab / infinite wait) must NOT hold the
      // pool slot forever — that stalled the whole pipeline (tasks stuck "running" for
      // 13+ min, zero new applies). Allow enough room for one owned external handoff
      // (target hydration + a 4-min child executor), then fail + free up before the
      // server's 8-min stale-run reconciliation.
      // SUPERVISED ("Watch & Teach") runs use the supervised entry path (Step/Run overlay
      // + Fix-this picker) and bring the window to front so Pierre can watch + correct. No
      // hard cap — a supervised run is paced by the human, not the pool. [T4]
      const runType = context && context.supervised ? 'jat11.supervised-run' : 'jat11.run-task';
      // FIX 1: reset this tab's hidden-non-hydrating tracker for a fresh run.
      try { aaFrontRequested.delete(tab.id); } catch {}
      // NAVIGATION-RESUMING DISPATCH.
      //
      // sendMessage awaits the ENTIRE executor run, but an opener that NAVIGATES (stripe.com
      // "Apply now", ashby, lever — anything that leaves the job page for a separate application
      // page) destroys the receiving content script mid-message. Chrome then rejects with "message
      // channel closed", the run never resolves, and the task burns its full hard cap before being
      // reaped as a timeout. Live 2026-08-14 that was every navigating ATS opener on both machines,
      // and it is why the ATS lane produced 1 completion against LinkedIn's 141 — LinkedIn's Easy
      // Apply is a MODAL, so it never navigates and never hit this.
      //
      // On that specific rejection, re-send to the NEW document instead of failing. Bounded at 2
      // resumes so a page that reloads in a loop cannot spin. Not a double-apply risk: the channel
      // dies at the OPENER click, before any submit — and if a post-submit confirmation navigation
      // ever triggers it, the resumed executor finds no form and skips rather than re-applying.
      const dispatch = sendRunWithNavResume(tab.id, { type: runType, task, context });
      if (context && context.supervised) {
        result = await dispatch;
      } else {
        // ADAPTIVE HARD CAP (FIX 1): poll the per-tab hidden-non-hydrating signal and shorten
        // the cap to ~90s for a tab that asked to be fronted and still hasn't hydrated (the
        // throughput-killing stall), while keeping the full 5.5-min cap for a visible-but-slow
        // tab (which never sends front-until-hydrated). The reject is phrased RETRIABLY
        // (transient) so the server classifier reschedules it via retry-stale.
        const runStart = Date.now();
        let capTimer = null;
        const timeout = new Promise((_, rej) => {
          const tick = () => {
            const tr = aaFrontRequested.get(tab.id) || {};
            const cap = applyHardCapMs({ frontRequested: !!tr.at, hydrated: !!tr.hydrated, awaitingHuman: aaAwaitingHuman.has(tab.id) });
            if (Date.now() - runStart >= cap) {
              rej(new Error(cap === APPLY_HIDDEN_STALL_CAP_MS
                ? 'apply form did not hydrate on a throttled/occluded tab — will retry'
                : 'apply timed out after 5.5 min — will retry'));
              return;
            }
            capTimer = setTimeout(tick, 2000);
          };
          capTimer = setTimeout(tick, 2000);
        });
        try {
          result = await Promise.race([dispatch, timeout]);
        } finally {
          if (capTimer) { try { clearTimeout(capTimer); } catch {} }
          try { aaFrontRequested.delete(tab.id); } catch {}
        }
      }
    } catch (e) {
      // Run being torn down (user pressed Stop) → the tab was removed out from under
      // us. That's NOT a real failure: leave the task as the dashboard set it (skipped)
      // and bow out quietly, so no "application failed" toast fires.
      if (stopping) return 'skipped';
      const emsg = String(e?.message || e);
      // A BENIGN channel break — NOT a real failure:
      //   • the MV3 service worker was recycled while the executor sat in a LONG human Cloudflare wait
      //     (the executor is still running in the tab and reports its own terminal state), or
      //   • a same-tab external handoff navigated away from the source content script.
      // In these cases NEVER mark 'failed' and NEVER close the tab — closing it would kill the very
      // captcha the user is solving (the live "runs out of time, waits for nothing" bug). Poll the
      // server for the executor's authoritative terminal state instead.
      const channelBroke = /message channel closed|Receiving end does not exist|message port closed|back\/forward cache|No tab with id/i.test(emsg);
      const awaitingHuman = aaAwaitingHuman.has(tab.id);
      let handedOff = null;
      try {
        const qr = await api.call('GET', '/queue', null, 8000);
        handedOff = (qr?.items || []).find((x) => x.id === task.id && x.handoffToken);
      } catch {}
      if (handedOff || channelBroke || awaitingHuman) {
        const deadline = Date.now() + (awaitingHuman ? 780000 : 285000);   // ~13 min while a human is verifying
        while (Date.now() < deadline && !stopping) {
          try {
            const qr = await api.call('GET', '/queue', null, 8000);
            const current = (qr?.items || []).find((x) => x.id === task.id);
            if (current && ['done', 'awaiting_review', 'awaiting_input', 'parked', 'failed', 'skipped'].includes(current.state)) return current.state;
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        // Deadline hit without a terminal state — leave the tab + run ALONE (the executor's report is
        // authoritative; the tab-reaper cleans up a truly-abandoned tab). No clobber, no tab close.
        return 'skipped';
      }
      await api.call('PATCH', '/queue/' + task.id, {
        state: 'failed', attemptsDelta: 1, lastError: emsg,
        transcriptAppend: { note: 'executor error: ' + emsg },
      });
      if (!reuse) { try { await chrome.tabs.remove(tab.id); } catch {} untrackAaTab(tab.id); }   // reuse: keep the warm tab; the next job navigates it
      return 'failed';
    }
    const finalState = (result && typeof result.state === 'string') ? result.state : null;
    if (stopping) return 'skipped';
    if (!result || result.ok === false || !finalState) {
      await api.call('PATCH', '/queue/' + task.id, {
        state: 'failed', attemptsDelta: 1, lastError: String(result?.error || 'executor returned no state'),
        transcriptAppend: { note: 'executor failed: ' + String(result?.error || 'no state') },
      });
      if (!reuse) { try { await chrome.tabs.remove(tab.id); } catch {} untrackAaTab(tab.id); }
      return 'failed';
    }
    if (finalState !== 'running') {
      // Idempotent reconcile — but it MUST carry the executor's terminal evidence, not just the
      // state. The executor's own evidence-bearing report() is fire-and-forget and can be dropped
      // when we tear the apply tab down right after a verified submit; if this reconcile sent
      // {state:'done'} alone, the server's terminal-integrity guard would downgrade a genuinely
      // VERIFIED submission to awaiting_review ("reported without confirmation evidence"). Carry
      // the full terminal result so this deterministic last write preserves the proof.
      const reconcile = { state: finalState };
      if (result.submissionEvidence != null) reconcile.submissionEvidence = result.submissionEvidence;
      if (result.lastError != null) reconcile.lastError = result.lastError;
      if (result.parkReason != null) reconcile.parkReason = result.parkReason;
      if (Array.isArray(result.pendingQuestions) && result.pendingQuestions.length) reconcile.pendingQuestions = result.pendingQuestions;
      if (result.routeState != null) reconcile.routeState = result.routeState;
      // Carry the apply ROUTE too — a dropped fire-and-forget report() otherwise loses it on this
      // deterministic last write, so a relevance skip lands route-less and the server synthesizes
      // "skipped without a diagnostic". (The executor's return now echoes applyRoute for skips.)
      if (result.applyRoute != null) reconcile.applyRoute = result.applyRoute;
      await api.call('PATCH', '/queue/' + task.id, reconcile);
    }
    if (result?.nextRequested) setTimeout(() => { watchAndTeachOne().catch(() => {}); }, 900);
    // Close the apply tab on terminal outcomes AND on awaiting_input — the user now
    // finishes parked/needs-you items from the Applications "Needs your input" panel in
    // the dashboard, NOT in the tab, so leaving them open just piled tabs to 90+. Only
    // awaiting_review (review-mode: the user manually clicks submit in that tab) stays
    // open — and the reaper still closes it after the max age as a backstop.
    if (['done', 'skipped', 'failed', 'parked', 'awaiting_input'].includes(finalState)) {
      // reuse (serial): KEEP the warm tab — the next job navigates it, preserving the Cloudflare
      // session so a passed check stays cleared. Only close it on Stop (closeAutoApplyTabs) or when
      // the reaper ages it out. Parallel: close per-job as before.
      if (!reuse) { try { await chrome.tabs.remove(tab.id); } catch {} untrackAaTab(tab.id); }
    }
    return finalState;
  } catch (e) {
    if (tab && !reuse) { try { await chrome.tabs.remove(tab.id); } catch {} untrackAaTab(tab.id); }
    return stopping ? 'skipped' : 'failed';
  } finally {
    if (parallel && winId != null) releaseApplyWindow(winId);   // free this worker's pool window (parallel only)
  }
}

// Debounced top-up: when an apply slot frees, try to launch the next job WITHOUT
// waiting for the 1-min alarm. This is what makes serial mode fast and keeps a
// parallel pool full.
let pumpTimer = null;
function schedulePump() {
  if (pumpTimer) return;
  pumpTimer = setTimeout(() => { pumpTimer = null; pump().catch(() => {}); }, 300);
}

// Fill open apply slots up to the configured concurrency, paced by the server.
// FIRE-AND-FORGET per task: each launch frees its slot on completion and re-pumps,
// so N tabs cycle continuously. concurrency comes back with every /queue/next.
async function pump(force = false) {
  if (pumping) { pumpDirty = true; return { dispatched: false, reason: 'pumping' }; }
  await hydrateAaRuntime();
  await reapAaTabs().catch(() => {});
  // Reconcile after MV3 service-worker eviction. If Chrome still has tracked AA tabs
  // alive, treat them as occupied slots; if none remain, free the counter.
  await reconcileAaTabsAndSlots().catch(() => {});
  if (!(await api.isPaired())) return { dispatched: false, reason: 'not paired' };
  const h = await api.health();
  if (!h?.ok) return { dispatched: false, reason: 'app offline' };
  // IDLE GATE: when "only when idle" is on and the user is active (input) or media is
  // playing, don't START new applies. A manual "Apply next now" (force) always bypasses.
  // In-flight tasks keep running; the idle/audible listeners re-pump when the user goes away.
  if (!force) {
    const g = await evalIdleGate(await getAaCached());
    if (g.gated) {
      await postIdlePauseStatus(g);
      return { dispatched: false, reason: 'idle-gate:' + (g.activeInput ? 'user-active' : 'media-playing') };
    }
    if (g.idleOnly) await clearIdlePauseStatus();
  }
  if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
  pumping = true;
  let dispatched = 0;
  let reason = 'idle';
  let gapEligibleAt = null;
  let parkedThisPump = 0;            // breaker parks per pump — bounds the no-dispatch loop
  try {
    while (activeCount < currentConcurrency) {
      // Tell the server which hosts our breaker is currently holding, so it never hands us a job we
      // would only have to hand straight back. The old flow claimed the task first (GET /queue/next
      // marks it 'scheduled'), then checked the breaker, then PATCHed it back — and that release is
      // `.catch(() => {})`, so a failed PATCH left the task claimed and stranded. Measured
      // 2026-08-09: ~12 stranded claims/hour, 106 of 164 on Indeed. The breaker check below stays as
      // the authority (the map can change between the request and the reply); this only stops the
      // server offering walled work in the first place.
      const nowMs = Date.now();
      const walledHosts = Object.entries(await loadHostBreakerPruned(nowMs))
        .filter(([, e]) => e && nowMs < (Number(e.until) || 0))
        .map(([h]) => h);
      const qs = [force ? 'force=1' : '', walledHosts.length ? 'skipHosts=' + encodeURIComponent(walledHosts.join(',')) : '']
        .filter(Boolean).join('&');
      const r = await api.call('GET', '/queue/next' + (qs ? '?' + qs : ''), null, 8000);
      if (r && r.concurrency) {
        const c = Math.max(1, Math.min(8, r.concurrency));
        if (c !== currentConcurrency) { currentConcurrency = c; try { chrome.storage.local?.set({ 'jat11.concurrency': c }); } catch {} }
      }
      if (!r?.ok || !r.task) {
        reason = r?.reason || 'nothing queued';
        if (r?.nextEligibleAt) gapEligibleAt = r.nextEligibleAt;
        break;
      }
      // HOST CIRCUIT BREAKER: if this job's host is cooling down after a bot-challenge,
      // don't burn it on the same wall. Park it honestly and pull the NEXT job instead
      // (no slot consumed). The breaker is in-memory/per-run and self-expires.
      const jobHost = registrableDomain(hostOfUrl(r.context?.job?.jobUrl || r.task?.jobUrl));
      const breakerMap = await loadHostBreakerPruned();   // PERSISTED — survives MV3 eviction between tasks
      const gate = shouldDispatchHost(jobHost, Date.now(), breakerMap);
      if (!gate.dispatch && r.task?.id != null) {
        console.log(`[jat11] deferring ${jobHost} job ${r.task.id} until ${new Date(gate.until).toISOString()} — host under bot-challenge cooldown`);
        // DEFER, never skip. This used to PATCH state:'skipped', which is TERMINAL and
        // non-retriable, so a temporary wall permanently discarded jobs that had never been
        // attempted. Live 2026-07-20: Indeed began serving a Cloudflare challenge and this
        // destroyed 40+ queued jobs in ten minutes (all attempts=0), draining the Indeed queue
        // from 60 to 16. The breaker is right to stop dispatching into a wall, but the job must
        // survive it — exactly how the Easy-Apply cooldown leaves its tasks queued.
        //
        // Staying 'queued' with a FUTURE scheduled_at is what makes this safe: queueNext skips
        // not-yet-due tasks (server.js hostDeferred) so the pump moves to another host instead of
        // handing back the same row forever, and the job becomes dispatchable again by itself
        // once the breaker expires.
        await api.call('PATCH', '/queue/' + encodeURIComponent(r.task.id), {
          state: 'queued',
          scheduledAt: new Date(gate.until).toISOString(),
          lastError: null,
          transcriptAppend: { kind: 'recovery', note: `host ${jobHost} is serving a verification wall — deferred until ${new Date(gate.until).toISOString()} (not skipped)` },
        }).catch(() => {});
        reason = 'host-cooldown';
        // Bound the park loop so a server that keeps re-returning the same row can't spin
        // this pump forever; the next alarm/re-pump will drain the rest.
        if (++parkedThisPump >= 25) break;
        continue;             // pull the next queued job; don't open a tab for this one
      }
      stopping = false;        // actively launching → not in teardown (clears a recent Stop)
      startStopWatchdog();     // catch a desktop-app Stop (no chrome there) while this runs
      activeCount++;
      dispatched++;
      launchOne(r.task, r.context)
        // A LAUNCH FAILURE MUST NOT BE SILENT. This was `.catch(() => {})`, so anything thrown
        // between claiming the task and the executor starting vanished — and the task, already
        // marked 'scheduled' by GET /queue/next, sat claimed until the reconciler reclaimed it and
        // labelled it "timed out / interrupted". That label is why this looked like a timeout for
        // three rounds. Note launchOne's very first statement (acquiring the apply window) is
        // OUTSIDE its own try block, so a window/tab failure lands here.
        //
        // Measured 2026-08-09: ~10-15 stranded claims/hour on the laptop, every one with entries=1
        // and executorStarted=0. Two guesses at the cause did not move that rate, because nothing
        // recorded WHY the launch died. Now it does — and the claim is released immediately instead
        // of holding a worker slot until the 2-minute reclaim.
        .catch((e) => {
          const msg = String((e && e.message) || e || 'unknown').slice(0, 200);
          console.warn(`[jat11] launch FAILED before executor start for task ${r.task.id}: ${msg}`);
          api.call('PATCH', '/queue/' + encodeURIComponent(r.task.id), {
            state: 'queued',                 // never attempted — must stay retriable, and charge no attempt
            lastError: `launch failed before the executor started: ${msg}`,
            transcriptAppend: { kind: 'recovery', note: `launch failed before the executor started: ${msg} — returned to the queue` },
          }).catch(() => {});
        })
        .finally(() => { activeCount = Math.max(0, activeCount - 1); schedulePump(); });
      // Small stagger so parallel launches don't open N tabs in the same instant.
      if (activeCount < currentConcurrency) await new Promise((r2) => setTimeout(r2, 500));
    }
  } finally {
    pumping = false;
  }
  // A slot-free (or alarm) re-pump that arrived while we were mid-pump is honoured now,
  // so freed parallel slots never get swallowed by the re-entrancy guard.
  if (pumpDirty) { pumpDirty = false; schedulePump(); }
  // Held back only by the pacing gap → wake exactly when it expires (bounded), so
  // a fast-finishing job doesn't idle until the next 1-min alarm.
  if (reason === 'gap' && gapEligibleAt) {
    const delay = Math.max(300, new Date(gapEligibleAt).getTime() - Date.now());
    if (delay < 70000) { clearTimeout(gapTimer); gapTimer = setTimeout(() => { gapTimer = null; pump().catch(() => {}); }, delay); }
  }
  // F2 FIX — run idle → restore the user's focus. When no apply tab is running AND nothing is
  // queued (NOT merely waiting on the pacing gap, where the next job is imminent and the apply
  // window should stay fronted), the run has gone quiet: hand the user's focus back to where it
  // was at run start. The next dispatch re-captures + re-fronts. Idempotent + guarded.
  if (activeCount <= 0 && dispatched === 0 && reason !== 'gap') {
    try { await restoreUserFocus(); } catch {}
  }
  return { dispatched: dispatched > 0, count: dispatched, active: activeCount, reason };
}

// TEST button: apply the next queued job RIGHT NOW (skips window/cap/gap), AWAITED
// so the dashboard can show the outcome. Still counts against the pool's slots.
async function forceApplyOne() {
  if (!(await api.isPaired())) return { dispatched: false, reason: 'not paired' };
  const h = await api.health();
  if (!h?.ok) return { dispatched: false, reason: 'app offline' };
  const r = await api.call('GET', '/queue/next?force=1', null, 8000);
  if (r && r.concurrency) currentConcurrency = Math.max(1, Math.min(8, r.concurrency));
  if (!r?.ok || !r.task) return { dispatched: false, reason: r?.reason || 'nothing queued' };
  activeCount++;
  try {
    const state = await launchOne(r.task, r.context);
    return { dispatched: true, state, title: r.context?.job?.title };
  } finally {
    activeCount = Math.max(0, activeCount - 1);
    schedulePump();
  }
}

// "Watch & Teach" [T4]: apply the next queued job in SUPERVISED mode — the executor shows
// the Step/Run overlay and the on-page Fix-this picker, and corrections rewrite the recipe
// authoritatively. Same /queue/next source as forceApplyOne, but flagged supervised +
// brought to front so Pierre can watch. Awaited so the dashboard can show the outcome.
async function watchAndTeachOne() {
  if (!(await api.isPaired())) return { dispatched: false, reason: 'not paired' };
  const h = await api.health();
  if (!h?.ok) return { dispatched: false, reason: 'app offline' };

  // MOST USEFUL behavior: "teach me on the job I'm looking at." If the ACTIVE tab is a
  // job/application page, supervise THAT tab in place (Step/Run overlay + Fix-this picker)
  // rather than yanking the next queued job into a fresh window. Only when the active tab
  // isn't a job page do we fall back to /queue/next.
  const active = await superviseActiveTab();
  if (active) {
    if (active.nextRequested) setTimeout(() => { watchAndTeachOne().catch(() => {}); }, 900);
    return active;
  }

  const r = await api.call('GET', '/queue/next?force=1', null, 8000);
  if (r && r.concurrency) currentConcurrency = Math.max(1, Math.min(8, r.concurrency));
  if (!r?.ok || !r.task) {
    // Nothing to supervise: no job page open AND the queue is empty. Tell the popup
    // exactly what to do instead of silently reverting to Start.
    return { dispatched: false, reason: 'no-job', message: 'Open a job posting first, then Watch & teach' };
  }
  const context = { ...(r.context || {}), supervised: true, bringToFront: true };
  activeCount++;
  try {
    const state = await launchOne(r.task, context);
    return { dispatched: true, state, title: r.context?.job?.title };
  } finally {
    activeCount = Math.max(0, activeCount - 1);
    schedulePump();
  }
}

// If the user's active tab is a job/application page, run a SUPERVISED teach session
// in THAT tab (no new tab/window — supervise what they're looking at). Returns a
// result object on success, or null if the active tab isn't a job page so the caller
// can fall back to the queue.
async function superviseActiveTab() {
  let tab = null;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch { return null; }
  if (!tab?.id || !isJobPageUrl(tab.url)) return null;
  // Minimal task/context: no queue row backing this, so it's an ad-hoc supervised run.
  // The content engine recognizes the page identity itself; we just flag supervised.
  const task = { id: null, mode: 'supervised', adhoc: true };
  const context = { supervised: true, bringToFront: true, adhoc: true };
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'jat11.supervised-run', task, context }, { frameId: 0 });
    if (result && result.ok !== false) {
      return { dispatched: true, scope: 'active-tab', state: result.state || 'supervised', title: tab.title || '', nextRequested: !!result.nextRequested };
    }
    return { dispatched: false, reason: result?.error || 'could not start in this tab' };
  } catch (e) {
    // The content script may not be loaded in this tab (e.g. it was suppressed or never
    // booted). Treat as "couldn't supervise here" and fall back to the queue.
    return null;
  }
}

// ---- discovery: search a board for Easy-Apply jobs + enqueue them ----
// Rotation cursor over the FULL board × keyword × location search space. It MUST be
// persisted: a plain in-memory counter resets to 0 on every MV3 service-worker
// eviction (~30s idle), which pinned discovery to combo #0 forever and saturated a
// single search (a root cause of the queue starving to zero submits).
const DISCOVER_IDX_KEY = 'jat11.discoverIdx';

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

// ── IDLE GATE ("only auto-apply while I'm idle/away") ────────────────────────────
// When autoApply.idleOnly is ON, pause NEW dispatch + discovery the instant the user is
// active (mouse/keyboard input) or any tab is playing audio/video, and resume only when
// they're idle AND silent. The pure rule lives in ./lib/idle-gate.js (node-tested); here
// we feed it the live chrome.idle state + audible-tab count. In-flight applies are left to
// finish — we only stop STARTING new work — so a half-filled form isn't abandoned mid-run.
let _aaCache = null, _aaCacheAt = 0;
let _idleOnlyHint = false;         // cheap flag so event listeners can skip work when the feature is off
let _idlePausePosted = false;      // whether we've surfaced a pause marker that later needs clearing

// Lightweight settings cache so a hot pump loop doesn't hit /settings on every slot.
async function getAaCached(maxAgeMs = 3000) {
  const now = Date.now();
  if (_aaCache && now - _aaCacheAt < maxAgeMs) return _aaCache;
  try {
    const s = await api.call('GET', '/settings', null, 5000);
    if (s?.ok) { _aaCache = s.settings?.autoApply || {}; _aaCacheAt = now; _idleOnlyHint = _aaCache.idleOnly === true; }
  } catch { /* keep last cache on a blip */ }
  return _aaCache;
}

// Live idle-gate decision for the given autoApply settings. Returns { gated:false } when
// the feature is off. When on, queries chrome.idle + audible tabs and applies the pure rule.
async function evalIdleGate(aa) {
  if (!aa || aa.idleOnly !== true) { _idleOnlyHint = false; return { gated: false, idleOnly: false }; }
  _idleOnlyHint = true;
  const threshold = clampIdleThreshold(aa.idleThresholdSeconds);
  try { chrome.idle.setDetectionInterval(threshold); } catch {}
  let idleState = 'active';
  try { idleState = await chrome.idle.queryState(threshold); } catch { idleState = 'active'; }
  let audible = 0;
  try { audible = (await chrome.tabs.query({ audible: true })).length; } catch {}
  const d = computeIdleGate(idleState, audible);
  return { gated: d.busy, idleOnly: true, threshold, ...d };
}

// Surface WHY the engine is paused so an idle-pause never reads as "broken" (reuses the
// discovery-status kv the Auto-apply page already renders — no server change needed).
async function postIdlePauseStatus(g) {
  _idlePausePosted = true;
  await api.call('POST', '/auto-apply/discovery-status', {
    ok: true, paused: true, pauseReason: g.reason,
    note: `Paused — ${g.reason}. Auto-apply resumes automatically when you're idle and nothing is playing.`,
    board: '', keyword: '', found: 0, enqueued: 0,
  }, 5000).catch(() => {});
}

// Clear a previously-posted pause marker the moment the gate opens (so the banner drops
// even before the next discovery scan overwrites the status).
async function clearIdlePauseStatus() {
  if (!_idlePausePosted) return;
  _idlePausePosted = false;
  await api.call('POST', '/auto-apply/discovery-status', { ok: true, paused: false, note: '' }, 5000).catch(() => {});
}

// buildSearchUrl now lives in ./lib/search-url.js (pure + node-testable): geography is
// mandatory (empty location → country), work-mode → LinkedIn f_WT / Indeed remote attr,
// and freshnessSeconds → LinkedIn f_TPR / Indeed fromage. The freshness tier per combo is
// tracked in DISCOVER_TIERS below (newest-first ramp; widens only when a scan finds 0 new).
// PERSISTED, not a bare Map. This is an MV3 service worker: Chrome evicts it after ~30s idle,
// and discovery ticks are minutes apart (intervalMinutes, default 5), so an in-memory ramp was
// GUARANTEED to be empty on every tick — every combo restarted at NARROWEST_TIER (1h) forever and
// the ladder above 1h was unreachable dead code. Confirmed live 2026-07-20: the f_AL search
// reported freshness 3600 → next 7200, found 15, enqueued 0 ("all 15 jobs here were already
// tried"), i.e. it correctly computed the widened tier and then lost it. That is exactly the
// SATURATED state the doctor reports, and the reason the 30d depth added for saturation never
// helped. DISCOVER_IDX_KEY right below is persisted for this same eviction reason.
const DISCOVER_TIERS_KEY = 'jat11.discoverTiers';   // { [comboKey]: tierSeconds }
const comboKey = (board, keyword, location) => `${board}|${keyword}|${location}`;

async function loadDiscoverTier(cKey) {
  try {
    const o = await chrome.storage.local.get(DISCOVER_TIERS_KEY);
    const map = o[DISCOVER_TIERS_KEY];
    const v = Number(map && map[cKey]);
    return Number.isFinite(v) && v > 0 ? v : NARROWEST_TIER;
  } catch { return NARROWEST_TIER; }
}

async function saveDiscoverTier(cKey, tierSeconds) {
  try {
    const o = await chrome.storage.local.get(DISCOVER_TIERS_KEY);
    const map = { ...(o[DISCOVER_TIERS_KEY] || {}), [cKey]: tierSeconds };
    await chrome.storage.local.set({ [DISCOVER_TIERS_KEY]: map });
  } catch { /* a lost tier just means this combo restarts at the freshest window */ }
}

async function processDiscoveryFallback() {
  if (scanning || pumping) return { ok: false, note: 'busy' };
  if (!(await api.isPaired())) return { ok: false, note: 'not paired' };
  const next = await api.call('GET', '/auto-apply/discovery-fallback/next', null, 8000);
  const req = next?.request;
  if (!req) return { ok: false, note: 'no fallback requested' };
  scanning = true;
  let tab = null, resp = null;
  try {
    const sres = await api.call('GET', '/settings', null, 6000);
    const aa = sres?.settings?.autoApply || {};
    const url = buildSearchUrl(req.source, req.keyword || '', req.location || '', {
      easyApplyOnly: aa.easyApplyOnly !== false,
      workModes: aa.workModes || [],
      country: aa.country || 'Canada',
    });
    tab = await createAaTab(url, { active: false });
    await waitTabComplete(tab.id, 35000);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    resp = await chrome.tabs.sendMessage(tab.id, {
      type: 'jat11.discover-search', source: req.source,
      max: Math.max(10, Math.min(50, Number(aa.discovery?.perRunLimit) || 25)),
      easyApplyOnly: aa.easyApplyOnly !== false,
    }, { frameId: 0 });
    const done = await api.call('POST', `/auto-apply/discovery-fallback/${encodeURIComponent(req.id)}/complete`, {
      ok: resp?.ok !== false, jobs: resp?.jobs || [], error: resp?.error || null,
    }, 30000);
    if ((done?.enqueued || 0) > 0) schedulePump();
    return { ok: done?.ok !== false, source: req.source, found: resp?.found || 0, enqueued: done?.enqueued || 0 };
  } catch (e) {
    await api.call('POST', `/auto-apply/discovery-fallback/${encodeURIComponent(req.id)}/complete`, {
      ok: false, jobs: [], error: String(e?.message || e),
    }, 15000).catch(() => {});
    return { ok: false, error: String(e?.message || e) };
  } finally {
    if (tab) { try { await chrome.tabs.remove(tab.id); } catch {} untrackAaTab(tab.id); }
    scanning = false;
  }
}

async function discoverTick(force = false) {
  // Only block on another scan or the brief pump grab-window — discovery may run
  // ALONGSIDE active applies (its own tab) so the queue stays fed while the pool
  // is busy. (aaGroup tab-window races during the grab are why we still gate on pumping.)
  if (scanning || pumping) return { ok: false, note: 'busy' };
  if (!(await api.isPaired())) return { ok: false, note: 'not paired' };
  const h = await api.health();
  if (!h?.ok) return { ok: false, note: 'app offline' };
  const sres = await api.call('GET', '/settings', null, 6000);
  const aa = sres?.ok ? sres.settings?.autoApply : null;
  if (!aa || !aa.enabled || !aa.discovery?.enabled) return { ok: false, note: 'auto-apply is off' };
  // Refresh the cache the pump reads, so pump + discovery agree on the idle-gate state.
  if (aa) { _aaCache = aa; _aaCacheAt = Date.now(); _idleOnlyHint = aa.idleOnly === true; }
  // IDLE GATE: don't open a discovery/search tab while the user is active or media is playing
  // (a background tab popping up is itself intrusive). Manual "Search now" (force) bypasses.
  if (!force) {
    const g = await evalIdleGate(aa);
    if (g.gated) { await postIdlePauseStatus(g); return { ok: false, note: `paused — ${g.reason}` }; }
    if (g.idleOnly) await clearIdlePauseStatus();
  }
  const keywords = (aa.keywords || []).filter(Boolean);
  let boards = (aa.boards || []).filter(Boolean);
  if (aa.easyApplyOnly !== false) {
    // Glassdoor search cards do not reliably expose Easy Apply. When the user asks
    // for Easy-Apply-only, skip Glassdoor discovery instead of burning the run on
    // sign-in / employer-site postings that the executor will correctly skip.
    boards = boards.filter((b) => b !== 'glassdoor');
  }
  if (!keywords.length) return { ok: false, note: 'add keywords first' };
  if (!boards.length) {
    return {
      ok: false,
      note: aa.easyApplyOnly !== false
        ? 'Glassdoor is skipped in Easy-Apply-only mode because its cards do not expose a reliable Easy Apply badge'
        : 'add a job board first',
    };
  }
  if (!force && !withinWindow(aa)) return { ok: false, note: 'outside the time window' };

  // Cycle the FULL search space — board × keyword × location — so successive searches
  // surface FRESH jobs instead of re-finding the same handful from one fixed query
  // (the #1 cause of the "found 6, enqueued 0" pool exhaustion).
  const locList = (aa.locations || []).filter(Boolean);
  const combos = [];
  for (const b of boards) for (const k of keywords) for (const l of (locList.length ? locList : [''])) combos.push({ b, k, l });
  // PEEK the next combo before the refill gate: the gate below is per-board, so it needs to know
  // which board this tick would scan. The index is only PERSISTED once we commit to scanning, so a
  // gated tick does not burn a rotation slot (which would silently skip combos).
  let dIdx = 0;
  try { const o = await chrome.storage.local.get(DISCOVER_IDX_KEY); dIdx = Number(o[DISCOVER_IDX_KEY]) || 0; } catch {}
  const combo = combos[dIdx % combos.length];
  const board = combo.b, keyword = combo.k, location = combo.l;

  // SOURCE-AWARE refill gate — only auto-discover when the queue is low for THIS BOARD. A manual
  // run (force) bypasses it.
  //
  // This gate used to count the WHOLE queue, which mirrors the exact starvation bug already fixed
  // on the app side (discovery/index.js) and re-created it here: the app's JobSpy feed and the
  // direct-ATS feed pour into the SAME queue, so their backlog held the total above refillBelow and
  // this browser discovery — the ONLY source of real LinkedIn Easy-Apply jobs — never ran at all.
  // Measured live 2026-07-20: 106 queued = 86 Indeed + 6 LinkedIn against refillBelow 40, so the
  // Indeed backlog was permanently blocking the one feed that would have diluted it, and 58 of the
  // last 90 minutes' outcomes were "external, no Easy Apply" skips. Per-board depth breaks the loop:
  // a deep Indeed backlog no longer starves LinkedIn discovery, and each board still self-limits.
  if (!force) {
    const q = await api.call('GET', '/queue?state=queued', null, 6000);
    const boardQueued = (q?.items || [])
      .filter((t) => String(t?.job?.source || '').toLowerCase() === String(board).toLowerCase()).length;
    if (boardQueued >= (aa.discovery.refillBelow || 3)) return { ok: false, note: `queue already full for ${board}` };
  }

  // ACCOUNT BUDGET PERMIT. This lane opens a REAL search in the logged-in session — the most
  // attributable traffic the system produces, and, until v11.93.0, counted nowhere. LinkedIn
  // restricted the account on 2026-08-10 for "an unusually high volume of LinkedIn profile data"
  // while every visible counter (applies) sat at a comfortable ~40/day.
  //
  // Asked BEFORE the tab is opened, and NOT bypassed by `force` — a manual "discover now" is still
  // a request the platform counts. The permit spends the budget server-side on grant, so a crash
  // between here and the scan costs us one slot rather than going unrecorded.
  const permit = await api.call('GET', `/auto-apply/search-permit?source=${encodeURIComponent(board)}`, null, 6000).catch(() => null);
  if (permit && permit.allowed === false) {
    const mins = Math.round((permit.retryAfterMs || 0) / 60000);
    return { ok: false, note: `account budget: ${board} search held (${permit.reason}${permit.budget ? ` ${permit.used}/${permit.budget}` : ''}${mins ? `, ~${mins}min` : ''})` };
  }

  scanning = true;
  let tab = null;
  try { await chrome.storage.local.set({ [DISCOVER_IDX_KEY]: (dIdx + 1) % 1000000 }); } catch {}
  // Newest-first freshness ramp, per combo: start at the NARROWEST tier (last 1h) and keep
  // hammering it while it yields NEW jobs; widen one tier each time a scan enqueues 0 new,
  // capping at 7d so the queue always stays fed. LinkedIn gets the fine f_TPR ramp; Indeed
  // clamps sub-day tiers to fromage=1 inside buildSearchUrl.
  const cKey = comboKey(board, keyword, location);
  const tierSeconds = await loadDiscoverTier(cKey);
  const url = buildSearchUrl(board, keyword, location, {
    easyApplyOnly: aa.easyApplyOnly !== false,
    workModes: aa.workModes || [],
    country: aa.country || 'Canada',
    freshnessSeconds: tierSeconds,
  });
  let resp = null, enqueued = 0;
  try {
    tab = await createAaTab(url, { active: false });   // background: don't steal "active" from a running apply tab
    await waitTabComplete(tab.id, 30000);
    await new Promise((r2) => setTimeout(r2, 2000));
    try {
      resp = await chrome.tabs.sendMessage(tab.id, { type: 'jat11.discover-search', source: board, max: aa.discovery.perRunLimit || 8, easyApplyOnly: aa.easyApplyOnly !== false }, { frameId: 0 });
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
    if (tab) { try { await chrome.tabs.remove(tab.id); } catch {} untrackAaTab(tab.id); }
    scanning = false;
  }
  // Pool exhaustion: a valid search that enqueued nothing must not leave the engine
  // silently idle for the rest of an overnight run. This includes both "all deduped"
  // and a temporarily empty search page. Re-queue only policy-approved stale failures;
  // the normalized fingerprint breaker prevents identical failures from churning.
  const found = resp?.found ?? 0;
  let note = resp?.note || resp?.error || '';
  let requeued = 0;
  if (resp?.ok !== false && enqueued === 0) {
    const rr = await api.call('POST', '/auto-apply/retry-stale', {}, 6000).catch(() => null);
    requeued = rr?.requeued ?? 0;
    note = requeued
      ? `${found ? `all ${found} here were already tried` : 'this search had no fresh jobs'} — re-queued ${requeued} recoverable job(s)`
      : (found
          ? `all ${found} jobs here were already tried — rotating to the next search`
          : 'no fresh jobs in this search — rotating to the next search');
  }
  // Advance this combo's freshness tier: enqueuing NEW jobs keeps the narrow window (keep
  // hammering fresh); 0 new widens to the next tier (capped at 7d). A scan that couldn't
  // even reach the page (resp.ok === false) is not treated as "exhausted" — keep the tier.
  const foundNew = enqueued > 0;
  const reachable = resp?.ok !== false;
  const nextTier = reachable ? nextFreshnessTier(tierSeconds, foundNew) : tierSeconds;
  await saveDiscoverTier(cKey, nextTier);
  if (enqueued > 0 || requeued > 0) schedulePump();
  const status = { board, keyword, url, found, enqueued, note, ok: resp?.ok !== false, freshnessSeconds: tierSeconds, nextFreshnessSeconds: nextTier };
  await api.call('POST', '/auto-apply/discovery-status', status, 6000).catch(() => {});
  console.log('[JAT] discovery', board, '"' + keyword + '"@"' + location + '" tier r' + tierSeconds + '→r' + nextTier, 'found', found, 'enqueued', enqueued, note);
  return status;
}

// ---------- applied-jobs sync: import the user's PAST applications ----------
const APPLIED_URL = {
  linkedin: 'https://www.linkedin.com/my-items/saved-jobs/?cardType=APPLIED',
  indeed: 'https://myjobs.indeed.com/',
};
async function syncAppliedFor(source, maxDays) {
  const url = APPLIED_URL[source];
  if (!url) return { source, error: 'unknown source' };
  let tab = null;
  try {
    tab = await createAaTab(url, { active: false });   // background: applied-sync scraping tolerates throttling
    await waitTabComplete(tab.id, 35000);
    await new Promise((r) => setTimeout(r, 3000));   // the applied list hydrates slowly
    let resp = null;
    try { resp = await chrome.tabs.sendMessage(tab.id, { type: 'jat11.sync-applied', source, max: 400 }, { frameId: 0 }); }
    catch (e) { resp = { ok: false, error: String(e?.message || e), jobs: [], note: 'could not reach the applied-jobs page (are you logged in?)' }; }
    const all = (resp && resp.jobs) || [];
    const cutoff = Date.now() - Math.max(1, maxDays) * 86400 * 1000;
    // Keep undated items too (don't silently drop) — the importer dedups regardless.
    const jobs = all.filter((j) => !j.appliedAt || Date.parse(j.appliedAt) >= cutoff);
    let imp = { created: 0, merged: 0 };
    if (jobs.length) imp = (await api.call('POST', '/import/applications', { source, jobs }, 20000)) || imp;
    return { source, scraped: all.length, kept: jobs.length, created: imp.created || 0, merged: imp.merged || 0, note: resp?.note || resp?.error || '' };
  } catch (e) {
    return { source, error: String(e?.message || e) };
  } finally {
    if (tab) { try { await chrome.tabs.remove(tab.id); } catch {} untrackAaTab(tab.id); }
  }
}
async function syncApplied({ sources = ['linkedin'], maxDays = 90 } = {}) {
  if (scanning || pumping || activeCount > 0) return { ok: false, error: 'busy — auto-apply is mid-task, try again in a moment' };
  if (!(await api.isPaired())) return { ok: false, error: 'app not connected' };
  const list = (Array.isArray(sources) ? sources : [sources]).filter((s) => APPLIED_URL[s]);
  if (!list.length) return { ok: false, error: 'pick LinkedIn and/or Indeed' };
  scanning = true;
  try {
    const results = [];
    for (const s of list) results.push(await syncAppliedFor(s, maxDays));   // serial — one tab at a time
    return { ok: true, results };
  } finally { scanning = false; }
}
