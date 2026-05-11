// Background service worker for v5. Handles:
//   - 'capture' from any content adapter — sanitizes + upserts job
//   - jobs CRUD + queries
//   - settings/profile read/write
//   - AI feature router
//   - notifications + alarms (follow-up reminders)
import { db, upsertJob, listJobs, getJob, patchJob, deleteJob, statusSummary, getSettings, patchSettings, getProfile, patchProfile, broadcast, pushNotification, listNotifications, addDocument, listDocuments, patchDocument, deleteDocument, listLogs, appendLog, recordAnswer, lookupAnswer, listAnswers, deleteAnswer, normalizeQuestion, saveRecommendations, listRecommendations, listNamedProfiles, getNamedProfile, createNamedProfile, patchNamedProfile, deleteNamedProfile, getProfileForSource } from './lib/db.js';
import { computeFit as _computeFit } from './lib/fit.js';
import { writeLog, log } from './lib/logger.js';
import * as ai from './lib/ai.js';
import { ICON_PRESETS, presetToImageData } from './lib/icon-presets.js';
import { SyncClient } from './lib/sync-client.js';

// ============ Audit log infrastructure ============
// Tamper-evident hash chain. Each entry's hash incorporates the previous
// entry's hash so any tampering is detectable. Optionally signed with a
// per-install ECDSA P-256 key (private key never leaves chrome.storage).
const AUDIT_KEY_STORAGE = 'jat8.auditKeyJwk';
const AUDIT_PUB_STORAGE = 'jat8.auditPubJwk';
let _auditKeyPromise = null;

async function getOrCreateAuditKey() {
  if (_auditKeyPromise) return _auditKeyPromise;
  _auditKeyPromise = (async () => {
    try {
      const stored = await chrome.storage.local.get([AUDIT_KEY_STORAGE, AUDIT_PUB_STORAGE]);
      if (stored[AUDIT_KEY_STORAGE]) {
        const priv = await crypto.subtle.importKey('jwk', stored[AUDIT_KEY_STORAGE], { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
        return { priv, pubJwk: stored[AUDIT_PUB_STORAGE] || null };
      }
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
      const pubJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
      await chrome.storage.local.set({ [AUDIT_KEY_STORAGE]: privJwk, [AUDIT_PUB_STORAGE]: pubJwk });
      return { priv: pair.privateKey, pubJwk };
    } catch (e) {
      return { priv: null, pubJwk: null };
    }
  })();
  return _auditKeyPromise;
}

function _auditUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'a-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}
function _bufToHex(buf) { return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join(''); }
function _bufToB64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
async function _sha256Hex(text) { return _bufToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); }
async function _computeAuditHash(prevHash, ts, actor, kind, summary, data) {
  return _sha256Hex(`${prevHash}|${ts}|${actor}|${kind}|${summary}|${JSON.stringify(data ?? null)}`);
}

async function audit(actor, kind, summary, data = null) {
  try {
    const all = await db.getAll('audit');
    const last = all.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))[0];
    const prevHash = last?.hash || '';
    const ts = new Date().toISOString();
    const hash = await _computeAuditHash(prevHash, ts, actor, kind, summary, data);
    let signature = '';
    try {
      const key = await getOrCreateAuditKey();
      if (key.priv) {
        const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: { name: 'SHA-256' } }, key.priv, new TextEncoder().encode(hash));
        signature = _bufToB64(sig);
      }
    } catch {}
    const entry = {
      id: _auditUuid(),
      timestamp: ts,
      actor: String(actor || 'unknown'),
      kind: String(kind || 'unknown'),
      summary: String(summary || ''),
      data: data ?? null,
      prevHash, hash, signature
    };
    await db.put('audit', entry);
    try { await broadcast('audit.updated', { id: entry.id }); } catch {}
    return entry;
  } catch (e) {
    try { log.warn('audit', `audit() failed: ${e.message || e}`); } catch {}
    return null;
  }
}

async function verifyAuditChain() {
  try {
    const all = (await db.getAll('audit')).sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    let prev = '';
    for (const r of all) {
      const expected = await _computeAuditHash(prev, r.timestamp, r.actor, r.kind, r.summary, r.data ?? null);
      if (expected !== r.hash || r.prevHash !== prev) {
        return { ok: false, brokenAt: r.id, reason: expected !== r.hash ? 'hash mismatch' : 'prevHash mismatch' };
      }
      prev = r.hash;
    }
    return { ok: true, checked: all.length };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}

// ---------- Desktop-app sync ----------
// Single SyncClient instance for the SW lifetime. Health probes + WS reconnect
// are managed internally; we just need to wire onEvent → local mutations and
// hook up local mutations → pushChange.
let syncClient = null;
let syncStatus = { healthy: false, connected: false };

async function applyRemoteEvent(name, data) {
  try {
    if (name === 'job.created' || name === 'job.updated') {
      if (!data?.job) return;
      const cur = await getJob(data.job.id);
      if (cur && cur.updatedAt && data.job.updatedAt && new Date(cur.updatedAt) > new Date(data.job.updatedAt)) {
        return; // local newer — last-write-wins
      }
      const result = await upsertJob(data.job);
      await broadcast(result.action === 'created' ? 'job.created' : 'job.updated', { job: result.job });
    } else if (name === 'job.deleted') {
      if (!data?.id) return;
      await deleteJob(data.id);
      await broadcast('job.deleted', { id: data.id });
    } else if (name === 'settings.updated') {
      if (!data?.settings) return;
      const next = await patchSettings(data.settings);
      await broadcast('settings.updated', { settings: next });
    } else if (name === 'profile.updated') {
      if (!data?.profile) return;
      const next = await patchProfile(data.profile);
      await broadcast('profile.updated', { profile: next });
    }
  } catch (e) {
    log.warn('sync.remote', `Failed to apply ${name}: ${e.message || e}`);
  }
}

async function ensureSyncClient() {
  if (syncClient) return syncClient;
  const settings = await getSettings();
  const interval = Number(settings.syncIntervalSeconds || 5);
  syncClient = new SyncClient({
    intervalSeconds: interval,
    onEvent: (name, data) => applyRemoteEvent(name, data),
    onStatus: (s) => {
      syncStatus = s;
      // Tell UI surfaces about connectivity changes
      try { broadcast('sync.status', s); } catch {}
    },
    log: (ctx, msg) => log.info(ctx, msg)
  });
  syncClient.start();
  return syncClient;
}
function pushSync(name, data) {
  if (!syncClient || !syncClient.isHealthy()) return;
  try { syncClient.pushChange(name, data); } catch {}
}

// Apply the toolbar icon. Service workers can't rasterize SVG via
// createImageBitmap reliably, so when a preset/custom is selected the APP
// PAGE pre-rasterizes the bundle and stores it in chrome.storage.local under
// 'jat5.iconBundle' as a {size: {width, height, data: number[]}} object.
async function applyIconFromSettings() {
  try {
    const stored = (await chrome.storage.local.get('jat5.iconBundle'))?.['jat5.iconBundle'];
    if (stored && typeof stored === 'object' && stored['16']) {
      const imageData = {};
      for (const s of [16, 32, 48, 128]) {
        const entry = stored[String(s)] || stored[s];
        if (!entry) continue;
        // Reconstruct ImageData (Uint8ClampedArray buffer + width/height)
        const arr = new Uint8ClampedArray(entry.data);
        imageData[s] = new ImageData(arr, entry.width, entry.height);
      }
      await chrome.action.setIcon({ imageData });
      return;
    }
    // Fall back to packaged PNGs
    await chrome.action.setIcon({ path: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' } });
  } catch (e) {
    log.warn('icon', `Failed to apply icon: ${e.message || e}`);
  }
}

self.addEventListener('install', () => { self.skipWaiting?.(); });
self.addEventListener('activate', () => {
  self.clients?.claim?.();
  scheduleAlarms();
  applyIconFromSettings();
  ensureSyncClient();
});

chrome.runtime.onInstalled.addListener(() => {
  log.info('background', 'Installed', { version: chrome.runtime.getManifest().version });
  scheduleAlarms();
  applyIconFromSettings();
  ensureSyncClient();
});
// Also boot the sync client at module load — covers SW wakeups that don't
// trigger 'activate' (e.g. cold start to handle a message).
ensureSyncClient();

function scheduleAlarms() {
  try { chrome.alarms.create('jat5-followups', { periodInMinutes: 60 }); } catch {}
  // Keepalive alarm: minimum allowed period is 30s in MV3. Used to keep the SW
  // warm during long AI calls. Fires every 25s via chrome.runtime self-ping.
  try { chrome.alarms.create('jat5-keepalive', { periodInMinutes: 0.5 }); } catch {}
  // v8.5 QoL alarms
  try { chrome.alarms.create('jat-auto-archive',  { periodInMinutes: 24 * 60 }); } catch {}
  try { chrome.alarms.create('jat-daily-summary', { periodInMinutes: 60 }); } catch {} // checks hourly, runs once at 9am
  try { chrome.alarms.create('jat-stale-refresh', { periodInMinutes: 24 * 60 }); } catch {}
  try { chrome.alarms.create('jat-health-check',  { periodInMinutes: 5 }); } catch {}
}

// ============ v8.5 auto-* alarm handlers ============
async function autoArchiveStale() {
  try {
    const all = await listJobs();
    const cutoff = Date.now() - 90 * 86400000;
    let archived = 0;
    for (const j of all) {
      if (j.status !== 'submitted') continue;
      if (j.autoArchiveOptOut) continue;
      const last = new Date(j.updatedAt || j.submittedAt || 0).getTime();
      if (last && last < cutoff) {
        await patchJob(j.id, { status: 'archived' });
        archived++;
      }
    }
    if (archived > 0) {
      log.info('auto-archive', `Auto-archived ${archived} stale submitted job(s) (>90d).`);
    }
  } catch (e) {
    log.warn('auto-archive', `Failed: ${e.message || e}`);
  }
}

async function maybeRunDailySummary() {
  try {
    const now = new Date();
    if (now.getHours() !== 9) return; // run between 9 and 10 local time
    const today = now.toISOString().slice(0, 10);
    const all = await db.getAll('dailySummaries');
    if (all.some((s) => s.day === today)) return;
    const settings = await getSettings();
    const aiOk = await ai.aiStatus(settings).catch(() => ({ available: false }));
    if (!aiOk.available) return;
    const jobs = await listJobs();
    const summary = await ai.aiInsightsSummary(jobs, settings).catch(() => '');
    if (!summary) return;
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'ds-' + Date.now();
    await db.put('dailySummaries', {
      id, day: today, summary, createdAt: new Date().toISOString()
    });
    try {
      chrome.notifications?.create?.(`jat-daily-${today}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Daily summary',
        message: String(summary).slice(0, 240)
      });
    } catch {}
    await broadcast('dailySummaries.updated', { id });
  } catch (e) {
    log.warn('daily-summary', `Failed: ${e.message || e}`);
  }
}

async function refreshStaleJobs() {
  try {
    const all = await listJobs();
    const cutoff = Date.now() - 24 * 3600000;
    const stale = all.filter((j) => !j.description && (!j._lastEnrichAt || new Date(j._lastEnrichAt).getTime() < cutoff)).slice(0, 5);
    for (const j of stale) {
      await patchJob(j.id, { _lastEnrichAt: new Date().toISOString() });
    }
    if (stale.length) log.info('stale-refresh', `Marked ${stale.length} job(s) for re-enrichment.`);
  } catch (e) {
    log.warn('stale-refresh', `Failed: ${e.message || e}`);
  }
}

async function autoHealthCheck() {
  try {
    const settings = await getSettings();
    const checks = {};
    try { checks.ai = await ai.aiStatus(settings); } catch (e) { checks.ai = { available: false, reason: String(e.message || e) }; }
    try {
      const url = (settings.desktopAppUrl || 'http://localhost:7733') + '/health';
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      checks.desktop = { ok: r.ok };
    } catch { checks.desktop = { ok: false }; }
    if (settings.aiProvider === 'ollama' && !checks.ai?.available) {
      log.warn('health', `Ollama health check failed: ${checks.ai?.reason || 'unknown'}`);
    }
    if (settings.desktopAppEnabled && !checks.desktop?.ok) {
      // Desktop intentionally offline — only log at debug to avoid noise
    }
  } catch (e) {
    log.warn('health-check', `Failed: ${e.message || e}`);
  }
}

// Track in-flight AI calls so we can refuse to die mid-call.
let inFlightAiCalls = 0;
function bumpKeepAlive() {
  // Touch storage every 20s while AI calls are running — this resets the
  // service worker idle timer.
  if (inFlightAiCalls <= 0) return;
  try { chrome.storage.local.get('jat5._ka').then(() => chrome.storage.local.set({ 'jat5._ka': Date.now() })); } catch {}
  setTimeout(bumpKeepAlive, 20000);
}

chrome.alarms?.onAlarm?.addListener(async (a) => {
  if (a.name === 'jat5-followups') await checkFollowUps();
  else if (a.name === 'jat-auto-archive')  await autoArchiveStale();
  else if (a.name === 'jat-daily-summary') await maybeRunDailySummary();
  else if (a.name === 'jat-stale-refresh') await refreshStaleJobs();
  else if (a.name === 'jat-health-check')  await autoHealthCheck();
});

// ============ v8: Smart-tag rules + sandbox + webhooks ============
async function applySmartTagRules(job) {
  try {
    const rules = await db.getAll('smartTagRules');
    if (!rules.length) return;
    const tags = new Set(job.tags || []);
    let changed = false;
    for (const rule of rules) {
      let target = '';
      if (rule.field === 'description') target = job.description || '';
      else if (rule.field === 'title') target = job.title || '';
      else if (rule.field === 'company') target = job.company || '';
      else target = `${job.title || ''} ${job.description || ''}`;
      try {
        if (new RegExp(rule.pattern, 'i').test(target) && !tags.has(rule.tag)) {
          tags.add(rule.tag); changed = true;
        }
      } catch {}
    }
    if (changed) {
      await patchJob(job.id, { tags: [...tags] });
    }
  } catch (e) { console.warn('smart-tag', e); }
}

async function fireWebhooks(kind, payload) {
  try {
    const settings = await getSettings();
    if (settings.localOnlyMode || !settings.outgoingWebhooksEnabled) return;
    const hooks = (await db.getAll('webhooks')).filter((h) => h.kind === kind);
    for (const h of hooks) {
      try {
        const body = h.format === 'slack'
          ? JSON.stringify({ text: `[Job Tracker] ${kind}: ${payload.title || ''} @ ${payload.company || ''}` })
          : JSON.stringify({ kind, ts: new Date().toISOString(), payload });
        await fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      } catch (e) { console.warn('webhook', h.id, e); }
    }
  } catch {}
}

const SANDBOX_TAG = 'demo';
async function sandboxSeed() {
  const settings = await getSettings();
  if (settings.sandboxSeeded) return { ok: false, error: 'Already seeded — wipe first.' };
  const now = Date.now();
  const demos = [
    { title: 'Senior Software Engineer', company: 'Stripe', status: 'submitted', applied: true, location: 'remote', source: 'Demo' },
    { title: 'Staff Engineer', company: 'Anthropic', status: 'interview', applied: true, location: 'San Francisco', source: 'Demo' },
    { title: 'Frontend Engineer', company: 'Linear', status: 'received', applied: true, location: 'remote', source: 'Demo' },
    { title: 'Platform Engineer', company: 'Cloudflare', status: 'reviewing', applied: true, location: 'remote', source: 'Demo' },
    { title: 'Backend Engineer', company: 'Supabase', status: 'recruiter_replied', applied: true, location: 'remote', source: 'Demo' },
    { title: 'Tech Lead', company: 'Vercel', status: 'interview', applied: true, location: 'remote', source: 'Demo' },
    { title: 'ML Engineer', company: 'OpenAI', status: 'rejected', applied: true, location: 'San Francisco', source: 'Demo' },
    { title: 'Senior PM', company: 'Notion', status: 'offer', applied: true, location: 'remote', source: 'Demo' },
    { title: 'iOS Engineer', company: 'Spotify', status: 'started', applied: false, location: 'Stockholm', source: 'Demo' },
    { title: 'DevOps Engineer', company: 'Render', status: 'submitted', applied: true, location: 'remote', source: 'Demo' },
    { title: 'Data Engineer', company: 'Airbyte', status: 'rejected', applied: true, location: 'remote', source: 'Demo' },
    { title: 'Engineering Manager', company: 'GitHub', status: 'assessment', applied: true, location: 'remote', source: 'Demo' }
  ];
  let n = 0;
  for (const d of demos) {
    const r = await upsertJob({ ...d, tags: [SANDBOX_TAG], description: `[DEMO] ${d.title} role at ${d.company}. Generated for the v8 sandbox.`, _source: 'sandbox' });
    if (r?.job) n++;
  }
  // Seed tags + saved views
  for (const t of [['remote','#10b981'],['no-leetcode','#3b82f6'],['dream-co','#f59e0b'],['demo','#9ca3af'],['top-priority','#ef4444']]) {
    await db.put('tags', { id: 't-' + t[0], name: t[0], color: t[1], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    n++;
  }
  for (const v of [
    { id: 'v-active', name: 'Active pipeline', status: 'submitted, interview, recruiter_replied', q: '', tags: '' },
    { id: 'v-remote', name: 'Remote roles', status: '', q: 'remote', tags: '' },
    { id: 'v-priority', name: 'Top priority', status: '', q: '', tags: 'top-priority' }
  ]) {
    await db.put('savedViews', { ...v, updatedAt: new Date().toISOString() });
    n++;
  }
  await patchSettings({ sandboxSeeded: true });
  await broadcast('jobs.updated', {});
  return { ok: true, count: n };
}

async function sandboxWipe() {
  const jobs = await listJobs();
  let n = 0;
  for (const j of jobs) {
    if ((j.tags || []).includes(SANDBOX_TAG) || j.source === 'Demo' || (j.description || '').startsWith('[DEMO]')) {
      await deleteJob(j.id); n++;
    }
  }
  for (const t of await db.getAll('tags')) {
    if (['remote','no-leetcode','dream-co','demo','top-priority'].includes(t.name) && t.id.startsWith('t-')) {
      await db.delete('tags', t.id); n++;
    }
  }
  for (const v of await db.getAll('savedViews')) {
    if (['v-active','v-remote','v-priority'].includes(v.id)) {
      await db.delete('savedViews', v.id); n++;
    }
  }
  await patchSettings({ sandboxSeeded: false });
  await broadcast('jobs.updated', {});
  return { ok: true, count: n };
}

async function checkFollowUps() {
  const settings = await getSettings();
  if (!settings.notificationsEnabled) return;
  const all = await listJobs();
  const due = all.filter((j) => j.followUpDueAt && new Date(j.followUpDueAt).getTime() <= Date.now() && !['offer', 'rejected', 'withdrawn', 'archived'].includes(j.status));
  for (const j of due) {
    // Only notify once per due cycle
    if (j._lastFollowUpNotifiedAt && new Date(j._lastFollowUpNotifiedAt).getTime() > Date.now() - 24 * 3600000) continue;
    try {
      chrome.notifications?.create?.(`jat5-fu-${j.id}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: `Follow up: ${j.title}`,
        message: `${j.company} — applied ${j.submittedAt ? new Date(j.submittedAt).toLocaleDateString() : 'recently'}`
      });
    } catch {}
    await patchJob(j.id, { _lastFollowUpNotifiedAt: new Date().toISOString() });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const { type, data } = msg || {};
    try {
      switch (type) {
        case 'capture': {
          const settings = await getSettings();
          const before = data.applied;
          const result = await upsertJob(data);
          // v8: apply smart-tag rules + fire webhooks
          if (result.job) {
            try { await applySmartTagRules(result.job); } catch {}
            try {
              if (result.action === 'created') await fireWebhooks('job_created', { id: result.job.id, title: result.job.title, company: result.job.company });
              if (result.previousStatus && result.previousStatus !== result.job.status) {
                await fireWebhooks('status_changed', { id: result.job.id, title: result.job.title, company: result.job.company, from: result.previousStatus, to: result.job.status });
                if (result.job.status === 'offer') await fireWebhooks('offer', { id: result.job.id, title: result.job.title, company: result.job.company });
                else if (result.job.status === 'rejected') await fireWebhooks('rejected', { id: result.job.id, title: result.job.title, company: result.job.company });
                else if (result.job.status === 'interview') await fireWebhooks('interview', { id: result.job.id, title: result.job.title, company: result.job.company });
              }
            } catch {}
          }
          // Optional AI sanity check
          if (settings.aiValidateCaptures && result.job) {
            try {
              const warnings = await ai.aiValidateCapture(result.job, settings);
              if (warnings && warnings.length) {
                result.job.aiWarnings = warnings;
                result.job.aiWarningsAt = new Date().toISOString();
                await db.put('jobs', result.job);
                log.warn('ai.validate', `Flagged ${warnings.length} field(s) for ${result.job.title}`, { warnings });
              }
            } catch (e) {
              log.warn('ai.validate', `Validation failed: ${e.message || e}`);
            }
          }
          // Auto follow-up date if applied
          if (before && result.job?.applied && !result.job.followUpDueAt) {
            const days = settings.defaultFollowUpDays || 10;
            const due = new Date(Date.now() + days * 86400000).toISOString();
            await patchJob(result.job.id, { followUpDueAt: due });
            result.job.followUpDueAt = due;
          }
          // Auto-tag industry on first capture
          try {
            if (result.action === 'created' && !result.job.industry && result.job.description) {
              const industry = await ai.aiTagIndustry(result.job.description, settings);
              if (industry) {
                await patchJob(result.job.id, { industry });
                result.job.industry = industry;
              }
            }
          } catch (e) { log.warn('auto-tag', `Failed: ${e.message || e}`); }
          // Auto-pick best resume from documents if not already set
          try {
            if (result.action === 'created' && !result.job.resumeName) {
              const docs = await listDocuments();
              const resumes = docs.filter((d) => d.type === 'resume');
              if (resumes.length >= 2) {
                const pick = await ai.aiPickResume(result.job, resumes, settings);
                if (pick) {
                  await patchJob(result.job.id, { resumeName: pick });
                  result.job.resumeName = pick;
                }
              }
            }
          } catch (e) { log.warn('auto-pick-resume', `Failed: ${e.message || e}`); }
          // Auto-research company if first time we see it
          try {
            if (result.action === 'created' && result.job.company) {
              const companies = await db.getAll('companies');
              const existing = companies.find((c) => (c.name || '').toLowerCase() === result.job.company.toLowerCase());
              if (!existing) {
                const aiOk = await ai.aiStatus(settings).catch(() => ({ available: false }));
                let info = null;
                if (aiOk.available) {
                  info = await ai.aiCompanyResearch(result.job.company, settings).catch(() => null);
                }
                const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'co-' + Date.now();
                await db.put('companies', {
                  id, name: result.job.company,
                  research: info?.summary || '',
                  researchedAt: info?.researchedAt || '',
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString()
                });
                await broadcast('companies.updated', { id });
              }
            }
          } catch (e) { log.warn('auto-research', `Failed: ${e.message || e}`); }
          await broadcast(result.action === 'created' ? 'job.created' : 'job.updated', { job: result.job });
          pushSync(result.action === 'created' ? 'job.created' : 'job.updated', { job: result.job });
          sendResponse({ ok: true, action: result.action, job: result.job });
          break;
        }
        case 'step-advance': {
          // Content script saw a "Next/Continue" click in an apply flow.
          // If the surrounding context mentions interview-ish keywords, drop a +1d reminder.
          try {
            const text = String(data?.text || '').toLowerCase();
            const jobId = data?.jobId;
            if (jobId && /interview|phone screen|technical screen|on[- ]site|recruiter call|chat/.test(text)) {
              const all = await db.getAll('reminders');
              const dupe = all.find((r) => r.jobId === jobId && r.kind === 'follow-up-interview' && !r.done);
              if (!dupe) {
                const fireAt = new Date(Date.now() + 86400000).toISOString();
                const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'rm-' + Date.now();
                await db.put('reminders', {
                  id, jobId, kind: 'follow-up-interview',
                  text: 'Follow up on interview',
                  fireAt, done: false,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString()
                });
                await broadcast('reminders.updated', { id });
              }
            }
          } catch (e) { log.warn('step-advance', `Failed: ${e.message || e}`); }
          sendResponse({ ok: true });
          break;
        }
        case 'list-jobs': sendResponse({ ok: true, items: await listJobs() }); break;
        case 'get-job':   sendResponse({ ok: true, job: await getJob(data.id) }); break;
        case 'patch-job': {
          const j = await patchJob(data.id, data.patch || {});
          if (j) { await broadcast('job.updated', { job: j }); pushSync('job.updated', { job: j }); audit('user', 'job.patched', `Patched ${j.title || data.id}`, { id: data.id, patch: data.patch }); }
          sendResponse({ ok: !!j, job: j });
          break;
        }
        case 'delete-job': {
          await deleteJob(data.id);
          await broadcast('job.deleted', { id: data.id });
          pushSync('job.deleted', { id: data.id });
          audit('user', 'job.deleted', `Deleted job ${data.id}`, { id: data.id });
          sendResponse({ ok: true });
          break;
        }
        case 'sync.remote-event': {
          // Manual injection point — rarely used since the WS handles inbound;
          // mostly for tests / forwarded popup events.
          await applyRemoteEvent(data?.name, data?.data);
          sendResponse({ ok: true });
          break;
        }
        case 'sync.status': sendResponse({ ok: true, status: syncStatus }); break;
        case 'status-summary': sendResponse({ ok: true, summary: await statusSummary() }); break;

        case 'get-settings': sendResponse({ ok: true, settings: await getSettings() }); break;
        case 'patch-settings': {
          const next = await patchSettings(data || {});
          await broadcast('settings.updated', { settings: next });
          pushSync('settings.updated', { settings: next });
          // Audit only sensitive keys to avoid noise from theme/UI tweaks.
          const SENSITIVE = ['openaiKey','openaiBaseUrl','ollamaUrl','aiProvider','desktopAppUrl','desktopAppEnabled','auditEnabled','auditRetentionDays','redactInLogs','shareAnonymousMetrics','autoBackupEnabled','autoBackupIntervalDays','gmailClientId','gmailClientSecret'];
          const changedSensitive = SENSITIVE.filter((k) => Object.prototype.hasOwnProperty.call(data || {}, k));
          if (changedSensitive.length) {
            audit('user', 'settings.patched', `Updated ${changedSensitive.join(', ')}`, { keys: changedSensitive });
          }
          // If the user changed the sync interval, propagate to the live client.
          if (syncClient && data && Object.prototype.hasOwnProperty.call(data, 'syncIntervalSeconds')) {
            try { syncClient.setIntervalSeconds(Number(next.syncIntervalSeconds || 5)); } catch {}
          }
          sendResponse({ ok: true, settings: next });
          break;
        }
        case 'set-icon-bundle': {
          // App page pre-rasterized the icon (SW can't decode SVG). Bundle is
          // {16: {width,height,data:[...]}, 32: {...}, 48: {...}, 128: {...}}
          // OR null to clear (revert to default packaged PNGs).
          if (data?.bundle) await chrome.storage.local.set({ 'jat5.iconBundle': data.bundle });
          else await chrome.storage.local.remove('jat5.iconBundle');
          await applyIconFromSettings();
          sendResponse({ ok: true });
          break;
        }
        case 'get-profile': sendResponse({ ok: true, profile: await getProfile() }); break;
        case 'patch-profile': {
          const next = await patchProfile(data || {});
          await broadcast('profile.updated', { profile: next });
          pushSync('profile.updated', { profile: next });
          sendResponse({ ok: true, profile: next });
          break;
        }

        case 'list-documents': sendResponse({ ok: true, items: await listDocuments() }); break;
        case 'add-document': {
          const doc = await addDocument(data);
          await broadcast('documents.updated', {});
          audit('user', 'document.added', `Added document ${doc?.name || ''}`, { id: doc?.id, name: doc?.name, type: doc?.type });
          sendResponse({ ok: true, doc });
          break;
        }
        case 'patch-document': {
          const doc = await patchDocument(data.id, data.patch || {});
          await broadcast('documents.updated', {});
          sendResponse({ ok: true, doc });
          break;
        }
        case 'delete-document': {
          await deleteDocument(data.id);
          await broadcast('documents.updated', {});
          audit('user', 'document.deleted', `Deleted document ${data.id}`, { id: data.id });
          sendResponse({ ok: true });
          break;
        }
        case 'verify-audit-chain': {
          const result = await verifyAuditChain();
          sendResponse({ ok: true, result });
          break;
        }
        case 'get-audit-public-key': {
          const key = await getOrCreateAuditKey();
          sendResponse({ ok: true, publicKey: key.pubJwk });
          break;
        }

        case 'list-notifications': sendResponse({ ok: true, items: await listNotifications() }); break;

        case 'record-answer': {
          const e = await recordAnswer(data || {});
          // Also infer profile updates from common labels
          await maybeUpdateProfileFromAnswer(data || {});
          sendResponse({ ok: true, entry: e });
          break;
        }
        case 'lookup-answer': sendResponse({ ok: true, answer: await lookupAnswer(data?.question || '') }); break;
        case 'list-answers':  sendResponse({ ok: true, items: await listAnswers() }); break;
        case 'delete-answer': await deleteAnswer(data.key); sendResponse({ ok: true }); break;

        case 'list-recommendations': sendResponse({ ok: true, items: await listRecommendations() }); break;

        case 'list-named-profiles': sendResponse({ ok: true, items: await listNamedProfiles() }); break;
        case 'create-named-profile': {
          const p = await createNamedProfile(data || {});
          await broadcast('namedProfiles.updated', {});
          sendResponse({ ok: true, profile: p });
          break;
        }
        case 'patch-named-profile': {
          const p = await patchNamedProfile(data.id, data.patch || {});
          await broadcast('namedProfiles.updated', {});
          sendResponse({ ok: !!p, profile: p });
          break;
        }
        case 'delete-named-profile': {
          await deleteNamedProfile(data.id);
          await broadcast('namedProfiles.updated', {});
          sendResponse({ ok: true });
          break;
        }
        case 'import-source-profile': {
          // From the in-page profile-scraper. Save as a new named profile and
          // assign it to the source.
          const { source, name, data: pdata } = data || {};
          // Strip private metadata fields starting with _
          const clean = {};
          for (const k of Object.keys(pdata || {})) if (!k.startsWith('_')) clean[k] = pdata[k];
          const created = await createNamedProfile({
            name: name || `${source} import`,
            data: clean,
            sourceAssignments: source ? { [source]: '__self__' } : {}
          });
          // Replace __self__ with the actual id so lookups work
          if (source) {
            await patchNamedProfile(created.id, { sourceAssignments: { [source]: created.id } });
          }
          // Also enrich the legacy default profile if it's empty (so the user sees
          // their info immediately even if they don't switch profiles)
          const legacy = await getProfile();
          const patch = {};
          for (const [k, v] of Object.entries(clean)) {
            if (v && !legacy[k]) patch[k] = v;
          }
          if (Object.keys(patch).length) {
            const next = await patchProfile(patch);
            try { await broadcast('profile.updated', { profile: next }); } catch {}
          }
          await broadcast('namedProfiles.updated', {});
          audit('user', 'profile.imported', `Imported profile from ${source || 'unknown'}`, { id: created?.id, source, name: created?.name });
          sendResponse({ ok: true, profile: created });
          break;
        }
        case 'get-profile-for-source': sendResponse({ ok: true, profile: await getProfileForSource(data?.source) }); break;
        case 'persist-recommendations': {
          // Frontend calls AI via the port (which keeps SW alive), then sends
          // the queries here for expansion + persistence.
          const queries = Array.isArray(data?.queries) ? data.queries : [];
          const items = queries.flatMap((q) => buildSearchUrls(q));
          await saveRecommendations(items);
          await broadcast('recommendations.updated', { count: items.length });
          sendResponse({ ok: true, items });
          break;
        }
        case 'list-logs': sendResponse({ ok: true, items: await listLogs(data?.limit || 200) }); break;

        // ============ v8 generic CRUD for new stores ============
        case 'list-notes':
        case 'list-salaryEntries':
        case 'list-goals':
        case 'list-achievements':
        case 'list-skills':
        case 'list-resumeVersions':
        case 'list-coverLetters':
        case 'list-interviewQuestions':
        case 'list-practice':
        case 'list-dailySummaries':
        case 'list-templates':
        case 'list-savedSearches':
        case 'list-pomodoroSessions':
        case 'list-mockInterviews':
        case 'list-references':
        // v8 NEW
        case 'list-tags':
        case 'list-savedViews':
        case 'list-fitScores':
        case 'list-redFlags':
        case 'list-autopsies':
        case 'list-tailoredResumes':
        case 'list-snapshots':
        case 'list-scrapedSalary':
        case 'list-autoStatusEvents':
        case 'list-embeddings':
        case 'list-drafts':
        case 'list-digests':
        case 'list-healthChecks':
        case 'list-smartTagRules':
        case 'list-recipes':
        case 'list-webhooks':
        case 'list-xpEvents': {
          const store = type.slice('list-'.length);
          sendResponse({ ok: true, items: await db.getAll(store) });
          break;
        }
        case 'add-notes':
        case 'add-salaryEntries':
        case 'add-goals':
        case 'add-achievements':
        case 'add-skills':
        case 'add-resumeVersions':
        case 'add-coverLetters':
        case 'add-interviewQuestions':
        case 'add-practice':
        case 'add-dailySummaries':
        case 'add-templates':
        case 'add-savedSearches':
        case 'add-pomodoroSessions':
        case 'add-mockInterviews':
        case 'add-references': {
          const store = type.slice('add-'.length);
          const now = new Date().toISOString();
          const item = {
            id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'i-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
            createdAt: now,
            updatedAt: now,
            ...(data || {})
          };
          await db.put(store, item);
          await broadcast(`${store}.updated`, { id: item.id });
          sendResponse({ ok: true, item });
          break;
        }
        case 'patch-notes':
        case 'patch-salaryEntries':
        case 'patch-goals':
        case 'patch-achievements':
        case 'patch-skills':
        case 'patch-resumeVersions':
        case 'patch-coverLetters':
        case 'patch-interviewQuestions':
        case 'patch-practice':
        case 'patch-dailySummaries':
        case 'patch-templates':
        case 'patch-savedSearches':
        case 'patch-pomodoroSessions':
        case 'patch-mockInterviews':
        case 'patch-references': {
          const store = type.slice('patch-'.length);
          const cur = await db.get(store, data?.id);
          if (!cur) { sendResponse({ ok: false, error: 'not found' }); break; }
          const next = { ...cur, ...(data?.patch || {}), updatedAt: new Date().toISOString() };
          await db.put(store, next);
          await broadcast(`${store}.updated`, { id: cur.id });
          sendResponse({ ok: true, item: next });
          break;
        }
        case 'delete-notes':
        case 'delete-salaryEntries':
        case 'delete-goals':
        case 'delete-achievements':
        case 'delete-skills':
        case 'delete-resumeVersions':
        case 'delete-coverLetters':
        case 'delete-interviewQuestions':
        case 'delete-practice':
        case 'delete-dailySummaries':
        case 'delete-templates':
        case 'delete-savedSearches':
        case 'delete-pomodoroSessions':
        case 'delete-mockInterviews':
        case 'delete-references': {
          const store = type.slice('delete-'.length);
          await db.delete(store, data?.id);
          await broadcast(`${store}.updated`, { id: data?.id, deleted: true });
          sendResponse({ ok: true });
          break;
        }

        // ============ v8 NEW HANDLERS ============
        case 'ping': sendResponse({ ok: true, ts: Date.now() }); break;

        case 'probe-release-asset': {
          // Page can't probe Release URLs directly (CORS). Background calls
          // api.github.com (which sends proper CORS) — same info, no block.
          // releasesBaseUrl shape: https://github.com/OWNER/REPO/releases/latest/download
          const { releasesBaseUrl, fileName } = data || {};
          try {
            const m = String(releasesBaseUrl || '').match(/github\.com\/([^\/]+)\/([^\/]+)\/releases/);
            if (!m) { sendResponse({ ok: false, error: 'Invalid releases URL' }); break; }
            const apiUrl = `https://api.github.com/repos/${m[1]}/${m[2]}/releases/latest`;
            const r = await fetch(apiUrl, { headers: { Accept: 'application/vnd.github+json' } });
            if (!r.ok) { sendResponse({ ok: false, error: `HTTP ${r.status}` }); break; }
            const rel = await r.json();
            const exists = (rel.assets || []).some((a) => a.name === fileName);
            sendResponse({ ok: true, exists, tag: rel.tag_name, assets: (rel.assets || []).map((a) => a.name) });
          } catch (e) {
            sendResponse({ ok: false, error: String(e?.message || e) });
          }
          break;
        }

        case 'db-stats': {
          const stores = ['jobs','documents','messages','contacts','companies','events','notes','reminders','todos','audit','tags','savedViews','fitScores','autopsies'];
          let total = 0;
          for (const s of stores) {
            try { total += (await db.getAll(s)).length; } catch {}
          }
          sendResponse({ ok: true, totalRows: total, storeCount: stores.length });
          break;
        }

        case 'ai-ping': {
          try {
            const settings = await getSettings();
            const status = await ai.aiStatus(settings);
            if (status?.available) sendResponse({ ok: true, provider: status.provider, detail: status.model || status.defaultModel || 'Connected' });
            else sendResponse({ ok: false, error: status?.reason || 'No AI provider available' });
          } catch (e) { sendResponse({ ok: false, error: String(e?.message || e) }); }
          break;
        }

        case 'sync-status': {
          sendResponse({ ok: true, connected: !!syncStatus?.connected, url: (await getSettings()).desktopAppUrl });
          break;
        }

        case 'add-tag': {
          const id = (crypto.randomUUID && crypto.randomUUID()) || ('t-' + Date.now());
          const item = { id, name: String(data.name).slice(0, 40), color: data.color || '#3b82f6', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
          await db.put('tags', item);
          await broadcast('tags.updated', { id });
          sendResponse({ ok: true, item });
          break;
        }
        case 'delete-tag': {
          await db.delete('tags', data.id);
          await broadcast('tags.updated', { id: data.id, deleted: true });
          sendResponse({ ok: true });
          break;
        }

        case 'add-smart-tag-rule': {
          const id = (crypto.randomUUID && crypto.randomUUID()) || ('r-' + Date.now());
          const item = { id, tag: data.tag, pattern: data.pattern, field: data.field || 'any', updatedAt: new Date().toISOString() };
          await db.put('smartTagRules', item);
          await broadcast('smartTagRules.updated', { id });
          sendResponse({ ok: true, item });
          break;
        }
        case 'delete-smart-tag-rule': {
          await db.delete('smartTagRules', data.id);
          sendResponse({ ok: true });
          break;
        }

        case 'add-saved-view': {
          const id = (crypto.randomUUID && crypto.randomUUID()) || ('v-' + Date.now());
          const item = { id, name: data.name, status: data.status || '', q: data.q || '', tags: data.tags || '', updatedAt: new Date().toISOString() };
          await db.put('savedViews', item);
          await broadcast('savedViews.updated', { id });
          sendResponse({ ok: true, item });
          break;
        }
        case 'delete-saved-view': {
          await db.delete('savedViews', data.id);
          sendResponse({ ok: true });
          break;
        }

        case 'recompute-fit-scores': {
          const jobs = await listJobs();
          const profile = await getProfile();
          const now = new Date().toISOString();
          let n = 0;
          for (const j of jobs) {
            if (['archived','withdrawn'].includes(j.status)) continue;
            const fit = _computeFit(j, profile);
            await db.put('fitScores', { jobId: j.id, ...fit, computedAt: now });
            n++;
          }
          await broadcast('fitScores.updated', {});
          sendResponse({ ok: true, count: n });
          break;
        }

        case 'run-autopsy': {
          const job = await getJob(data.jobId);
          if (!job) { sendResponse({ ok: false, error: 'Job not found' }); break; }
          const profile = await getProfile();
          let summary, gaps = [], actions = [], provider = 'heuristic';
          try {
            const settings = await getSettings();
            const prompt = `You are a job-search coach analyzing a rejection. Output JSON only with keys: summary, gaps[], actions[].\nJob: ${job.title} at ${job.company}\nDescription: ${(job.description || '').slice(0, 1500)}\nMy profile: ${(profile.summary || '').slice(0, 500)} Skills: ${(profile.skills || []).slice(0, 20).join(', ')}\nReturn JSON only.`;
            const aiOut = await ai.aiPrompt(prompt, settings);
            const parsed = ai.parseJsonResponse(aiOut) || {};
            summary = parsed.summary || 'AI analysis unavailable.';
            gaps = parsed.gaps || []; actions = parsed.actions || [];
            provider = aiOut ? 'ai' : 'heuristic';
          } catch {
            summary = `${job.title} at ${job.company} closed without offer. Likely factors: experience match, timing, internal referrals, or fit mismatch. Without recruiter feedback, treat this as a learning data point — not a verdict on you.`;
            gaps = ['Consider a closer skill match for next role', 'Look for warmer referrals at this company tier'];
            actions = ['Save the JD and revisit in 6 months', 'Add this company to a watchlist'];
          }
          const item = { jobId: job.id, summary, gaps, actions, provider, createdAt: new Date().toISOString() };
          await db.put('autopsies', item);
          await broadcast('autopsies.updated', { jobId: job.id });
          sendResponse({ ok: true, item });
          break;
        }

        case 'add-recipe': {
          const id = (crypto.randomUUID && crypto.randomUUID()) || ('rx-' + Date.now());
          const item = { id, trigger: data.trigger, action: data.action, params: data.params || {}, updatedAt: new Date().toISOString() };
          await db.put('recipes', item);
          sendResponse({ ok: true, item });
          break;
        }
        case 'delete-recipe': await db.delete('recipes', data.id); sendResponse({ ok: true }); break;

        case 'add-webhook': {
          const id = (crypto.randomUUID && crypto.randomUUID()) || ('wh-' + Date.now());
          const item = { id, kind: data.kind, url: data.url, format: data.format || 'json' };
          await db.put('webhooks', item);
          sendResponse({ ok: true, item });
          break;
        }
        case 'delete-webhook': await db.delete('webhooks', data.id); sendResponse({ ok: true }); break;
        case 'test-webhook': {
          const settings = await getSettings();
          if (settings.localOnlyMode) { sendResponse({ ok: false, error: 'Local-only mode is on.' }); break; }
          const hook = await db.get('webhooks', data.id);
          if (!hook) { sendResponse({ ok: false, error: 'Not found.' }); break; }
          try {
            const body = hook.format === 'slack'
              ? JSON.stringify({ text: `Job Tracker test ping from v8 (${hook.kind})` })
              : JSON.stringify({ test: true, kind: hook.kind, ts: new Date().toISOString() });
            const r = await fetch(hook.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
            sendResponse({ ok: r.ok, status: r.status });
          } catch (e) { sendResponse({ ok: false, error: String(e?.message || e) }); }
          break;
        }

        case 'sandbox-seed': {
          const r = await sandboxSeed();
          sendResponse(r);
          break;
        }
        case 'sandbox-wipe': {
          const r = await sandboxWipe();
          sendResponse(r);
          break;
        }

        case 'save-draft': {
          const item = { id: data.id, kind: data.kind || '', ownerId: data.ownerId || '', value: data.value || '', updatedAt: data.updatedAt || new Date().toISOString() };
          await db.put('drafts', item);
          sendResponse({ ok: true });
          break;
        }
        case 'delete-draft': {
          await db.delete('drafts', data.id);
          sendResponse({ ok: true });
          break;
        }

        case 'upsert-job': {
          const r = await upsertJob({ ...data, _source: data._source || 'voice' });
          if (r?.job) await applySmartTagRules(r.job);
          await broadcast('jobs.updated', { id: r?.job?.id });
          sendResponse({ ok: true, ...r });
          break;
        }

        case 'log':

        case 'open-app':
          chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html') });
          sendResponse({ ok: true });
          break;

        case 'launch-app': {
          // Launches the desktop companion via the jat8:// URL handler that
          // the Inno Setup installer registers. Optional `data.path` lets
          // callers deep-link (e.g. 'job/<id>' → 'jat8://job/<id>'). The
          // desktop app intercepts the protocol in main.js.
          const sub = (data?.path || 'open').replace(/^\/+/, '');
          const url = `jat8://${sub}`;
          try {
            chrome.tabs.create({ url });
            sendResponse({ ok: true, url });
          } catch (e) {
            sendResponse({ ok: false, error: String(e.message || e) });
          }
          break;
        }

        case 'probe-app-health': {
          // Quick probe of the desktop app's local server.
          const settings = await getSettings();
          const baseUrl = settings.desktopAppUrl || 'http://localhost:7733';
          try {
            const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
            if (!r.ok) { sendResponse({ ok: true, health: { ok: false, reason: `HTTP ${r.status}` } }); break; }
            const health = await r.json();
            sendResponse({ ok: true, health: { ok: true, ...health } });
          } catch (e) {
            sendResponse({ ok: true, health: { ok: false, reason: String(e.message || e).slice(0, 120) } });
          }
          break;
        }
        case 'pair-with-app': {
          const settings = await getSettings();
          const baseUrl = settings.desktopAppUrl || 'http://localhost:7733';
          // Generate a token and POST it to /pair. App stores it. Extension stores it.
          const token = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'tok-' + Date.now();
          try {
            const r = await fetch(`${baseUrl}/pair`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token, extensionId: chrome.runtime.id, name: chrome.runtime.getManifest().name }),
              signal: AbortSignal.timeout(3000)
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            await patchSettings({ desktopAppToken: token, desktopAppPaired: true, desktopAppPairedAt: new Date().toISOString() });
            await broadcast('settings.updated', { settings: await getSettings() });
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: String(e.message || e) });
          }
          break;
        }

        case 'ai-status': {
          const settings = await getSettings();
          sendResponse({ ok: true, status: await ai.aiStatus(settings) });
          break;
        }
        case 'ai-call': {
          const settings = await getSettings();
          const timeoutMs = 135000;
          const f = data.feature;
          const dispatch = async () => {
            if (f === 'summarize') return await ai.aiSummarizeJob(data.job, settings);
            if (f === 'score') return await ai.aiScoreFit(data.job, data.profile, settings);
            if (f === 'coverLetter') return await ai.aiCoverLetter(data.job, data.profile, settings);
            if (f === 'skills') return await ai.aiExtractSkills(data.job, settings);
            if (f === 'questions') return await ai.aiInterviewQuestions(data.job, settings);
            if (f === 'followup') return await ai.aiFollowUp(data.job, data.profile, settings);
            if (f === 'validate') return await ai.aiValidateCapture(data.captured, settings);
            if (f === 'search') return await ai.aiSearchQuery(data.query, data.jobs || [], settings);
            if (f === 'resume') return await ai.aiResumeParse(data.resumeText, settings);
            if (f === 'insights') return await ai.aiInsightsSummary(data.jobs || [], settings);
            if (f === 'nudges') return await ai.aiStatusNudges(data.jobs || [], settings);
            if (f === 'checklist') return await ai.aiApplicationChecklist(data.job, data.profile || {}, settings);
            if (f === 'negotiate') return await ai.aiNegotiateOffer(data.job, data.profile || {}, settings);
            if (f === 'recommend') return await ai.aiRecommendQueries(data.jobs || [], data.profile || {}, settings);
            if (f === 'tailoredResume') return await ai.aiTailoredResume(data.job, data.baseResume || '', data.profile || {}, settings);
            if (f === 'interviewFeedback') return await ai.aiInterviewFeedback(data.question, data.answer, settings);
            if (f === 'rawPrompt') return await ai.aiRawPrompt(data.prompt || '', data.opts || {}, settings);
            const v8 = await dispatchV8Ai(f, data, settings);
            if (v8 !== UNKNOWN_FEATURE) return v8;
            throw new Error(`Unknown AI feature: ${f}`);
          };
          try {
            const result = await Promise.race([
              dispatch(),
              new Promise((_, rej) => setTimeout(() => rej(new Error('AI call timeout — check Ollama is running at ' + (settings.ollamaUrl || 'localhost:11434') + ' and the model "' + (settings.ollamaModel || 'gemma4:e4b') + '" is pulled.')), timeoutMs))
            ]);
            sendResponse({ ok: true, result });
          } catch (e) {
            log.error('ai-call', `Failed: ${e.message || e}`, { feature: f });
            sendResponse({ ok: false, error: String(e.message || e) });
          }
          break;
        }

        default: {
          const handled = await tryGenericCrud(type, data, sendResponse);
          if (handled) break;
          sendResponse({ ok: false, error: `unknown type: ${type}` });
        }
      }
    } catch (e) {
      log.error('background', `Handler error for ${type}: ${e.message || e}`, { type });
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true; // async response
});

// ============ Port-based AI channel ============
// MV3 service workers die after ~30s idle, killing long-running AI calls.
// A connected runtime port keeps the SW alive for the duration of the call.
// Frontend opens `chrome.runtime.connect({ name: 'jat5-ai' })`, posts the
// request, and listens for the result on the same port.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'jat5-ai') return;
  let active = true;
  port.onDisconnect.addListener(() => { active = false; });
  port.onMessage.addListener(async (msg) => {
    const { id, type, data } = msg || {};
    if (type !== 'ai-call' || !data?.feature) {
      try { active && port.postMessage({ id, ok: false, error: 'bad request' }); } catch {}
      return;
    }
    inFlightAiCalls++;
    if (inFlightAiCalls === 1) bumpKeepAlive();
    const settings = await getSettings();
    const f = data.feature;
    const dispatch = async () => {
      if (f === 'summarize') return await ai.aiSummarizeJob(data.job, settings);
      if (f === 'score') return await ai.aiScoreFit(data.job, data.profile, settings);
      if (f === 'coverLetter') return await ai.aiCoverLetter(data.job, data.profile, settings);
      if (f === 'skills') return await ai.aiExtractSkills(data.job, settings);
      if (f === 'questions') return await ai.aiInterviewQuestions(data.job, settings);
      if (f === 'followup') return await ai.aiFollowUp(data.job, data.profile, settings);
      if (f === 'validate') return await ai.aiValidateCapture(data.captured, settings);
      if (f === 'search') return await ai.aiSearchQuery(data.query, data.jobs || [], settings);
      if (f === 'resume') return await ai.aiResumeParse(data.resumeText, settings);
      if (f === 'insights') return await ai.aiInsightsSummary(data.jobs || [], settings);
      if (f === 'nudges') return await ai.aiStatusNudges(data.jobs || [], settings);
      if (f === 'checklist') return await ai.aiApplicationChecklist(data.job, data.profile || {}, settings);
      if (f === 'negotiate') return await ai.aiNegotiateOffer(data.job, data.profile || {}, settings);
      if (f === 'recommend') return await ai.aiRecommendQueries(data.jobs || [], data.profile || {}, settings);
      if (f === 'rawPrompt') return await ai.aiRawPrompt(data.prompt || '', data.opts || {}, settings);
      const v8 = await dispatchV8Ai(f, data, settings);
      if (v8 !== UNKNOWN_FEATURE) return v8;
      throw new Error(`Unknown AI feature: ${f}`);
    };
    try {
      const result = await Promise.race([
        dispatch(),
        new Promise((_, rej) => setTimeout(
          () => rej(new Error(`AI timeout (180s). Check Ollama at ${settings.ollamaUrl || 'localhost:11434'} and that "${settings.ollamaModel || 'gemma4:e4b'}" is pulled.`)),
          180000
        ))
      ]);
      if (active) port.postMessage({ id, ok: true, result });
    } catch (e) {
      log.error('ai.port', `Failed: ${e.message || e}`, { feature: f });
      if (active) port.postMessage({ id, ok: false, error: String(e.message || e) });
    } finally {
      inFlightAiCalls = Math.max(0, inFlightAiCalls - 1);
    }
  });
});

// Best-effort profile auto-population from form answers
// Profile auto-population patterns. Order matters — earlier rules take precedence.
// Each label is normalized (lowercased + accent-stripped) before matching, and
// also matched against a stripped variant. Patterns are intentionally permissive
// to catch real LinkedIn / Indeed / Glassdoor / Workday label variants seen in
// the wild ("First name*", "Mobile phone number", "Country / Region", etc.)
const PROFILE_HINTS = [
  // Specific names BEFORE generic "name"
  [/(first.*name|given.*name|prenom|fore.?name|nombre$|^nombre|^name\s*\(first\))/i, 'firstName'],
  [/(last.*name|family.*name|surname|nom de famille|^nom$|apellido|nachname|cognome|^name\s*\(last\))/i, 'lastName'],
  [/(preferred.*name|nick.?name|^how.*should.*we.*call|prefer.*to.*be.*called|preferred.*first)/i, 'preferredName'],
  [/(full.*name|legal.*name|complete.*name|nom complet|nombre completo|full legal)/i, 'fullName'],
  [/(pronoun)/i, 'pronouns'],

  // Email — secondary BEFORE generic email
  [/(secondary.*email|alternate.*email|other.*email|backup.*email)/i, 'secondaryEmail'],
  [/(email|e-?mail|courriel|correo|mail address|electronic mail)/i, 'email'],

  // Phone variants
  [/(mobile.*phone|cell.*phone|primary.*phone|^phone$|phone number|telephone|telefon|telefono|telefone|cellulaire)/i, 'phone'],

  // Eligibility — checked BEFORE address/state so "United States" in
  // "Authorized to work in the United States" doesn't false-match state.
  [/(authoriz|right.*to.*work|legally.*work|eligible.*to.*work|work permit|autoris)/i, 'workAuthorization'],
  [/(sponsor|visa.*sponsor|require.*sponsorship|sponsorship needed)/i, 'sponsorshipRequired'],
  [/(citizen|citizenship|nationality|nationalit)/i, 'citizenship'],
  [/(security.*clearance|clearance level|habilitation|nulla osta)/i, 'securityClearance'],

  // Address breakdown — country BEFORE state because "Country / Region" should
  // map to country, not state. apt/unit BEFORE address1 to win specificity.
  [/(address.*line.*2|street.*2|address.*2|apt|apartment|unit number|suite)/i, 'address2'],
  [/(address.*line.*1|street address|street|address|adresse|direccion|dirección|anschrift)/i, 'address1'],
  [/(zip|postal.*code|post code|pin code|cep|codice postale)/i, 'postalCode'],
  [/(country|nation|^pays|pa[ií]s\b|land\b|paese)/i, 'country'],
  [/(province|^state\b|^state\/|state of residence|^region\b|prov\b|estado|departement|département)/i, 'state'],
  [/(city|town|locality|ville|ciudad|stadt|citta|città)/i, 'city'],

  // Online presence
  [/(linkedin)/i, 'linkedinUrl'],
  [/(github\b|git ?hub url)/i, 'githubUrl'],
  [/(portfolio|personal site|personal website|webseite)/i, 'portfolioUrl'],
  [/(twitter|^x\b|x url)/i, 'twitterUrl'],
  [/(website|web site|site web|sitio web|web url)/i, 'websiteUrl'],
  [/(sponsor|visa.*sponsor|require.*sponsorship|sponsorship needed)/i, 'sponsorshipRequired'],
  [/(citizen|citizenship|nationality|nationalit)/i, 'citizenship'],
  [/(security.*clearance|clearance level|habilitation|nulla osta)/i, 'securityClearance'],

  // Compensation / availability
  [/(salary.*expect|expected.*salary|desired.*salary|compensation.*expect|expected.*compensation|salaire|pretension salarial|salario esperado)/i, 'salaryExpectation'],
  [/(salary.*min|minimum.*salary|salary floor)/i, 'salaryMin'],
  [/(salary.*max|maximum.*salary|salary ceiling)/i, 'salaryMax'],
  [/(year.*of.*experience|years.*exp|total.*experience|years.*work)/i, 'yearsExperience'],
  [/(notice.*period|notice required|how.*much.*notice)/i, 'noticePeriod'],
  [/(earliest.*start|available start|when.*available|start date|date.*disponibil)/i, 'earliestStartDate'],
  [/(willing.*to.*relocate|relocate|relocation|will move)/i, 'willRelocate'],
  [/(willing.*to.*travel|travel.*percent|travel up to|disposicion.*viajar)/i, 'willTravel'],

  // Education
  [/(highest.*degree|degree.*level|education.*level|highest.*education)/i, 'highestDegree'],
  [/(university|college|school of|institution|école|universidad|universit)/i, 'university'],
  [/(major|field of study|specialization|sp[eé]cialit)/i, 'major'],
  [/(graduation.*year|year.*graduated|year.*of.*graduation|grad year)/i, 'graduationYear'],
  [/(gpa|grade.*point|nota|moyenne)/i, 'gpa'],

  // Demographics (EEO)
  [/(gender)/i, 'gender'],
  [/(ethnicity|race|hispanic.*latino|origine ethnique)/i, 'ethnicity'],
  [/(veteran|protected.*veteran)/i, 'veteranStatus'],
  [/(disability|disabled)/i, 'disabilityStatus'],

  // Resume / cover letter (we only auto-fill the default name fields, file uploads happen separately)
  [/(default.*resume.*name|preferred.*resume)/i, 'defaultResumeName'],
  [/(default.*cover.*letter|preferred.*cover.*letter)/i, 'defaultCoverLetterName'],

  // Headline + summary
  [/(head ?line|professional.*headline|tagline)/i, 'headline'],
  [/(about you|brief about|short bio|summary|professional summary|profile summary|resume summary)/i, 'summary'],
];
function _normLabel(s) {
  // lowercase + accent-strip + append both raw and stripped so patterns can match either form
  const lower = String(s || '').toLowerCase();
  let stripped = lower;
  try { stripped = lower.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch {}
  return lower + ' ' + stripped;
}

async function maybeUpdateProfileFromAnswer({ question, answer }) {
  if (!question || !answer) return;
  const profile = await getProfile();
  const haystack = _normLabel(question);
  for (const [rx, field] of PROFILE_HINTS) {
    if (rx.test(haystack) && !profile[field]) {
      const next = await patchProfile({ [field]: String(answer).slice(0, 500) });
      try { await broadcast('profile.updated', { profile: next }); } catch {}
      log.info('profile.auto', `Auto-filled "${field}" ← "${question.slice(0, 50)}" = "${String(answer).slice(0, 40)}"`);
      return;
    }
  }
}

// Build search URLs from a recommendation query for each major board
function buildSearchUrls({ keywords, location, rationale }) {
  const k = encodeURIComponent(keywords || '');
  const l = encodeURIComponent(location || '');
  return [
    { source: 'LinkedIn', url: `https://www.linkedin.com/jobs/search/?keywords=${k}${l ? `&location=${l}` : ''}`, keywords, location, rationale },
    { source: 'Indeed', url: `https://www.indeed.com/jobs?q=${k}${l ? `&l=${l}` : ''}`, keywords, location, rationale },
    { source: 'Glassdoor', url: `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${k}${l ? `&locKeyword=${l}` : ''}`, keywords, location, rationale },
  ];
}

// ============ Generic CRUD for v8 stores ============
// Handles list-X / add-X / patch-X / delete-X for a known set of stores.
// Each mutation broadcasts X.updated to keep all extension contexts in sync.
const V6_STORES = ['events', 'reminders', 'todos', 'messages', 'emailTemplates', 'contacts', 'companies'];

function v6Uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'v6-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

async function tryGenericCrud(type, data, sendResponse) {
  if (!type) return false;
  const m = type.match(/^(list|add|patch|delete)-(.+)$/);
  if (!m) return false;
  const op = m[1];
  const store = m[2];
  if (!V6_STORES.includes(store)) return false;

  const now = new Date().toISOString();
  if (op === 'list') {
    const items = await db.getAll(store);
    sendResponse({ ok: true, items });
    return true;
  }
  if (op === 'add') {
    const row = { ...(data || {}) };
    if (!row.id) row.id = v6Uuid();
    if (!row.createdAt) row.createdAt = now;
    row.updatedAt = now;
    await db.put(store, row);
    await broadcast(store + '.updated', { id: row.id, action: 'added' });
    sendResponse({ ok: true, item: row });
    return true;
  }
  if (op === 'patch') {
    const id = data?.id;
    if (!id) { sendResponse({ ok: false, error: 'missing id' }); return true; }
    const cur = await db.get(store, id);
    if (!cur) { sendResponse({ ok: false, error: 'not found' }); return true; }
    const next = { ...cur, ...(data.patch || {}), updatedAt: now };
    await db.put(store, next);
    await broadcast(store + '.updated', { id, action: 'patched' });
    sendResponse({ ok: true, item: next });
    return true;
  }
  if (op === 'delete') {
    const id = data?.id;
    if (!id) { sendResponse({ ok: false, error: 'missing id' }); return true; }
    await db.delete(store, id);
    await broadcast(store + '.updated', { id, action: 'deleted' });
    sendResponse({ ok: true });
    return true;
  }
  return false;
}

// ============ v8 AI feature dispatcher (shared by both legacy + port channels) ============
const UNKNOWN_FEATURE = Symbol('unknown-ai-feature');
async function dispatchV8Ai(f, data, settings) {
  if (f === 'mockInterview') return await ai.aiMockInterview(data.job || {}, data.profile || {}, data.transcript || [], settings);
  if (f === 'resumeScore') return await ai.aiResumeScore(data.resumeText || '', data.jobDescription || '', settings);
  if (f === 'coverLetterScore') return await ai.aiCoverLetterScore(data.coverText || '', data.job || {}, settings);
  if (f === 'redFlags') return await ai.aiRedFlagsInJob(data.job || {}, settings);
  if (f === 'linkedinMessage') return await ai.aiLinkedInMessage(data.contact || {}, data.job || {}, data.intent || 'cold', settings);
  if (f === 'optimalFollowUpTime') return await ai.aiOptimalFollowUpTime(data.jobs || [], data.profile || {}, settings);
  if (f === 'companyResearchDeep') return await ai.aiCompanyResearchDeep(data.company || '', settings);
  if (f === 'starFormat') return await ai.aiStarFormat(data.behavioralAnswer || '', settings);
  if (f === 'analyzeRejection') return await ai.aiAnalyzeRejection(data.emailBody || '', settings);
  if (f === 'offerEvaluator') return await ai.aiOfferEvaluator(data.offer || {}, data.profile || {}, data.marketData || {}, settings);
  if (f === 'compareOffers') return await ai.aiCompareOffers(data.offers || [], data.profile || {}, settings);
  if (f === 'thankYouEmail') return await ai.aiThankYouEmail(data.interviewer || {}, data.job || {}, data.mainTopics || [], data.profile || {}, settings);
  if (f === 'analyzeAnswerHistory') return await ai.aiAnalyzeAnswerHistory(data.answers || [], settings);
  if (f === 'styleConsistency') return await ai.aiStyleConsistency(data.coverLetters || [], settings);
  if (f === 'tldrJob') return await ai.aiTLDRJob(data.job || {}, settings);
  if (f === 'commuteImpact') return await ai.aiCommuteImpact(data.jobLocation || '', data.homeLocation || '', data.profile || {}, settings);
  if (f === 'wlbEstimate') return await ai.aiWLBEstimate(data.job || {}, settings);
  if (f === 'cultureFit') return await ai.aiCultureFit(data.job || {}, data.profile || {}, settings);
  if (f === 'careerPath') return await ai.aiCareerPath(data.jobs || [], data.profile || {}, settings);
  if (f === 'inlineComplete') return await ai.aiInlineComplete(data.promptText || '', data.context || '', settings);
  return UNKNOWN_FEATURE;
}
