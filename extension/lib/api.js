// JAT v11 — API client (service-worker side).
// Talks to the desktop app on localhost:7744 with the pairing token.
//
// Pairing: first use → POST /pair → the app shows a native consent dialog →
// token stored in chrome.storage.local under 'jat11.token'.
// Offline behaviour: writes queue in chrome.storage.local ('jat11.writeQueue')
// and flush on the next successful health probe (1-min alarm in background.js).

export const BASE = 'http://localhost:7744';
const QUEUE_KEY = 'jat11.writeQueue';
const TOKEN_KEY = 'jat11.token';

let cachedToken = null;

export async function getToken() {
  if (cachedToken) return cachedToken;
  const s = await chrome.storage.local.get(TOKEN_KEY);
  cachedToken = s[TOKEN_KEY] || null;
  return cachedToken;
}

export async function setToken(t) {
  cachedToken = t;
  await chrome.storage.local.set({ [TOKEN_KEY]: t });
}

export async function isPaired() { return !!(await getToken()); }

// Ask the app for a token. The app pops a consent dialog — only call this from
// an explicit user action (popup "Connect" button) or right after install.
export async function pair() {
  try {
    const r = await fetch(BASE + '/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client: `extension ${chrome.runtime.id}` }),
      signal: AbortSignal.timeout(120000),   // user has to click Allow in the app
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const body = await r.json();
    if (body.token) { await setToken(body.token); return { ok: true }; }
    return { ok: false, error: body.error || 'no token returned' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function fetchJson(path, opts = {}) {
  const token = await getToken();
  const r = await fetch(BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-JAT-Token': token } : {}),
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(opts.timeoutMs || 5000),
  });
  if (r.status === 401) {
    const err = new Error('unauthorized');
    err.unauthorized = true;
    throw err;
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---- Reads (null on failure) ----
export async function health() {
  try {
    const r = await fetch(BASE + '/health', { signal: AbortSignal.timeout(1200) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
export async function get(path, timeoutMs) {
  try { return await fetchJson(path, { timeoutMs }); }
  catch (e) { return e.unauthorized ? { ok: false, unauthorized: true } : null; }
}

// ---- Writes (queued when the app is offline) ----
export async function upsertJob(data) {
  return writeOrQueue({ method: 'POST', path: '/jobs', body: data });
}
export async function patchJob(id, patch) {
  return writeOrQueue({ method: 'PATCH', path: '/jobs/' + encodeURIComponent(id), body: patch });
}
export async function recordEvent(ev) {
  return writeOrQueue({ method: 'POST', path: '/events', body: ev });
}
export async function qaRecord(item) {
  return writeOrQueue({ method: 'POST', path: '/qa', body: item });
}
// Direct (non-queued) call for interactive flows — AI answers, queue updates.
export async function call(method, path, body, timeoutMs = 150000) {
  try {
    return await fetchJson(path, {
      method, body: body ? JSON.stringify(body) : undefined, timeoutMs,
    });
  } catch (e) {
    return { ok: false, error: String(e?.message || e), unauthorized: !!e.unauthorized };
  }
}

async function writeOrQueue(op) {
  try {
    const r = await fetchJson(op.path, {
      method: op.method,
      body: op.body ? JSON.stringify(op.body) : undefined,
    });
    return { ok: true, ...r, queued: false };
  } catch (e) {
    if (e.unauthorized) return { ok: false, queued: false, unauthorized: true, error: 'not paired' };
    await queuePush(op);
    return { ok: false, queued: true, error: String(e.message || e) };
  }
}

async function queuePush(op) {
  const cur = (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY] || [];
  cur.push({ ...op, queuedAt: Date.now() });
  await chrome.storage.local.set({ [QUEUE_KEY]: cur.slice(-500) });
}

export async function queueLength() {
  const cur = (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY] || [];
  return cur.length;
}

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
    } catch (e) {
      if (e.unauthorized) break;
      break;
    }
  }
  await chrome.storage.local.set({ [QUEUE_KEY]: remaining });
  return { flushed, remaining: remaining.length };
}
