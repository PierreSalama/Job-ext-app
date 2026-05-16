// JAT v10 — API client.
// Wraps fetch() against the desktop app's HTTP server on localhost:7744.
// Used by background.js and the dashboard SPA. Both run in contexts that have
// host permission for localhost (manifest), so CORS isn't a concern.
//
// Offline behaviour: writes that fail because the app is offline are queued
// in chrome.storage.local under 'jat10.writeQueue' and flushed on the next
// successful health probe. Reads do not queue — they return null on failure
// and let the caller decide how to render the empty/loading state.

export const BASE = 'http://localhost:7744';
const QUEUE_KEY = 'jat10.writeQueue';

async function fetchJson(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeoutMs || 2500),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---- Reads (return null on failure) ----
export async function health() {
  try { return await fetchJson('/health', { timeoutMs: 1200 }); }
  catch { return null; }
}
export async function listJobs(params = {}) {
  try {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.source) q.set('source', params.source);
    if (params.limit)  q.set('limit', String(params.limit));
    const r = await fetchJson('/jobs' + (q.toString() ? `?${q}` : ''));
    return r.items || [];
  } catch { return null; }
}
export async function getJob(id) {
  try { return (await fetchJson('/jobs/' + encodeURIComponent(id))).job; }
  catch { return null; }
}
export async function listEvents(jobId) {
  try { return (await fetchJson('/events?jobId=' + encodeURIComponent(jobId))).items || []; }
  catch { return null; }
}
export async function stats() {
  try { return await fetchJson('/stats'); }
  catch { return null; }
}

// ---- Writes (queued if app is offline) ----
export async function upsertJob(data) {
  return writeOrQueue({ method: 'POST', path: '/jobs', body: data });
}
export async function patchJob(id, patch) {
  return writeOrQueue({ method: 'PATCH', path: '/jobs/' + encodeURIComponent(id), body: patch });
}
export async function recordEvent(ev) {
  return writeOrQueue({ method: 'POST', path: '/events', body: ev });
}
export async function deleteJob(id) {
  return writeOrQueue({ method: 'DELETE', path: '/jobs/' + encodeURIComponent(id) });
}

async function writeOrQueue(op) {
  try {
    const r = await fetchJson(op.path, {
      method: op.method,
      body: op.body ? JSON.stringify(op.body) : undefined,
    });
    return { ok: true, ...r, queued: false };
  } catch (e) {
    await queuePush(op);
    return { ok: false, queued: true, error: String(e.message || e) };
  }
}

async function queuePush(op) {
  const cur = (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY] || [];
  cur.push({ ...op, queuedAt: Date.now() });
  await chrome.storage.local.set({ [QUEUE_KEY]: cur });
}

export async function queueLength() {
  const cur = (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY] || [];
  return cur.length;
}

// Called on health-probe success. Drains the queue in order, dropping each
// op as it succeeds. Stops on the first failure (probably means the app went
// offline again) — remaining ops stay queued for next try.
export async function flushQueue() {
  const cur = (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY] || [];
  if (!cur.length) return { flushed: 0, remaining: 0 };
  let flushed = 0;
  const remaining = [...cur];
  while (remaining.length) {
    const op = remaining[0];
    try {
      await fetchJson(op.path, {
        method: op.method,
        body: op.body ? JSON.stringify(op.body) : undefined,
      });
      remaining.shift();
      flushed++;
    } catch {
      break;
    }
  }
  await chrome.storage.local.set({ [QUEUE_KEY]: remaining });
  return { flushed, remaining: remaining.length };
}
