// JAT v11 — host bot-challenge circuit breaker (pure, node-testable core).
//
// When the executor reports a bot-challenge (Cloudflare / CAPTCHA / verify wall) on a host,
// the background SW records it and STOPS dispatching further queued jobs for THAT host for a
// cooldown window. Rationale: one Cloudflare wall on indeed.com is host-wide — without a
// breaker the pool would feed every queued Indeed job straight into the same wall, burning
// the whole run and tanking the success rate. While the breaker is tripped, same-host jobs
// are parked with an honest "host under bot-challenge cooldown" reason instead of each
// hitting the wall.
//
// The state lives in the SW as a plain in-memory Map (host → entry), so an MV3 eviction /
// browser restart clears it — exactly what we want (a fresh run gets to re-probe the host).
// The DECISION is pure here so the cooldown logic is covered by tests without booting the SW.

// 20 min — within the asked 15–30 min band.
export const HOST_BREAKER_COOLDOWN_MS = 20 * 60 * 1000;

// Normalize a job URL → bare host (www-stripped). Returns '' on a bad/relative URL.
export function hostOfUrl(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

// PURE: may we dispatch a job for `host` right now? `state` is the breaker map (host→entry,
// a Map or a plain object). Returns { dispatch:boolean, reason, until } — dispatch=false
// means the host is cooling down.
export function shouldDispatchHost(host, now, state, cooldownMs = HOST_BREAKER_COOLDOWN_MS) {
  void cooldownMs;
  const h = String(host || '').toLowerCase();
  if (!h) return { dispatch: true, reason: 'no-host', until: 0 };
  const entry = state && (typeof state.get === 'function' ? state.get(h) : state[h]);
  if (!entry) return { dispatch: true, reason: 'not-tripped', until: 0 };
  const until = Number(entry.until) || 0;
  if (now >= until) return { dispatch: true, reason: 'cooled-down', until };
  return { dispatch: false, reason: 'host-cooldown', until };
}

// PURE: produce the next breaker entry for a host after a challenge was detected on it
// (extends/refreshes an existing entry, incrementing the hit count). Caller stores it.
export function trippedEntry(prev, kind, now, cooldownMs = HOST_BREAKER_COOLDOWN_MS) {
  return {
    trippedAt: now,
    until: now + cooldownMs,
    kind: kind || (prev && prev.kind) || 'cloudflare',
    hits: ((prev && prev.hits) || 0) + 1,
  };
}
