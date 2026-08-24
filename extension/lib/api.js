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

// PURE decision helper (node-testable): given what we know about pairing/health,
// decide how the popup should render the connection row. Resilient to a TRANSIENT
// health blip — having a token AND a recent successful health means we stay
// "connected" even if THIS probe timed out. Only a genuine no-token state, or an
// authed request that came back 401 (token rejected), drops us to a pair/setup
// prompt. Times in ms; graceMs defaults to ~60s.
export function decideConnectionState({ paired, healthOk, lastHealthyAt = 0, now = Date.now(), unauthorized = false, graceMs = 60000 } = {}) {
  // A real 401 means the stored token is no longer valid → must re-pair, even if
  // the app is otherwise up.
  if (unauthorized) return { connected: false, setupNeeded: true, reason: 'unauthorized', appInstalledButClosed: false };
  if (!paired) {
    // Never paired. If the app is answering, it's "almost there" (connect to finish);
    // otherwise it's a not-running/not-installed setup prompt.
    return { connected: false, setupNeeded: true, reason: healthOk ? 'connect' : 'no-app', appInstalledButClosed: false };
  }
  // Paired. Healthy now, or healthy within the grace window → stay connected.
  if (healthOk) return { connected: true, setupNeeded: false, reason: 'healthy', appInstalledButClosed: false };
  const recentlyHealthy = lastHealthyAt > 0 && (now - lastHealthyAt) <= graceMs;
  if (recentlyHealthy) return { connected: true, setupNeeded: false, reason: 'grace', appInstalledButClosed: false };
  // Paired but the app has been silent past the grace window → it's genuinely closed.
  // This is NOT a re-pair prompt (the token is still good) — it's an "open the app".
  return { connected: false, setupNeeded: false, reason: 'app-closed', appInstalledButClosed: true };
}

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
const LAST_HEALTHY_KEY = 'jat11.lastHealthyAt';
// The new Teach code makes the app busier (screenshot crop, distill), so a tight
// 1.2s probe blips more often. A blip must NOT flip a paired popup back to the
// "Connect" prompt — so we (a) give health a roomier timeout and (b) remember the
// last time the app answered, so the popup can ride through a brief stall.
export async function health() {
  try {
    // Report the LOADED manifest version on every probe. The applier laptop runs an UNPACKED
    // copy that nothing updates automatically, and until this existed the app had no way to know
    // which build was live — it sat three versions behind for three days, unnoticed, because
    // extVersion on /auto-apply/live was always empty. This is also the carrier for the app's
    // reload request coming back (see background.js handleExtReload).
    let ident = '';
    try {
      const m = chrome.runtime.getManifest();
      ident = `?extVersion=${encodeURIComponent(m.version || '')}&extId=${encodeURIComponent(chrome.runtime.id || '')}`;
    } catch { ident = ''; }
    const r = await fetch(BASE + '/health' + ident, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const body = await r.json();
    try { await chrome.storage.local.set({ [LAST_HEALTHY_KEY]: Date.now() }); } catch {}
    return body;
  } catch { return null; }
}

// Last time /health answered OK (ms epoch, 0 if never). Used by the popup to keep
// the connected UI through a brief health blip instead of re-prompting to pair.
export async function lastHealthyAt() {
  try { return (await chrome.storage.local.get(LAST_HEALTHY_KEY))[LAST_HEALTHY_KEY] || 0; }
  catch { return 0; }
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
