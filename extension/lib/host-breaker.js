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

// Reduce a host to its registrable domain (eTLD+1) so the breaker keys ONE entry per site.
// A Cloudflare wall on the apply flow (smartapply.indeed.com) must gate the job's host
// (ca.indeed.com) too — both normalize to "indeed.com". Keying on the exact hostname is what let
// Indeed jobs keep reopening into a wall the breaker had already seen (the "refreshes a lot" loop).
const BREAKER_MULTI_TLDS = new Set(['co.uk', 'com.au', 'co.jp', 'co.nz', 'co.in', 'com.br', 'co.za', 'com.mx', 'org.uk', 'gov.uk']);
export function registrableDomain(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '').replace(/:.*$/, '').trim();
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return h;
  const last2 = parts.slice(-2).join('.');
  return BREAKER_MULTI_TLDS.has(last2) ? parts.slice(-3).join('.') : last2;
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

// Ceiling for the backoff below. Long enough that a host which is simply refusing us stops being
// probed all day; short enough that a wall lifting overnight is noticed the same day.
export const HOST_BREAKER_MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// PURE: how long to stay off a host that has now tripped `hits` times in a row.
// Doubling from the base: 20m → 40m → 80m → 160m → 320m → capped at 6h.
export function backoffMs(hits, base = HOST_BREAKER_COOLDOWN_MS, cap = HOST_BREAKER_MAX_COOLDOWN_MS) {
  const n = Math.max(1, Number(hits) || 1);
  return Math.min(cap, base * Math.pow(2, n - 1));
}

// PURE: produce the next breaker entry for a host after a challenge was detected on it
// (extends/refreshes an existing entry, incrementing the hit count). Caller stores it.
//
// BACKOFF. `hits` was counted here from the start but never used: every trip got the SAME fixed
// cooldown, so a host that is permanently walling us was re-probed on a constant timer forever.
// Live 2026-08-09, one Indeed task: scheduled → wall → deferred, EIGHT times in three hours, with
// attempts=0 — never actually attempted. Every cycle costs a dispatch, a page load and a worker
// slot, and it means repeatedly hitting a host that is actively blocking us, on an account already
// warned for automated access. Doubling makes a transient wall cost one retry and a permanent one
// cost almost nothing, while `hits` resetting on success keeps recovery fast.
export function trippedEntry(prev, kind, now, cooldownMs = HOST_BREAKER_COOLDOWN_MS) {
  const hits = ((prev && prev.hits) || 0) + 1;
  return {
    trippedAt: now,
    until: now + backoffMs(hits, cooldownMs),
    kind: kind || (prev && prev.kind) || 'cloudflare',
    hits,
  };
}

// How long a host must go WITHOUT tripping before we forget it entirely and the next wall starts
// from the base cooldown again. This is the "it behaved" reset: without it the backoff would ratchet
// up permanently and a site that had one bad afternoon would stay half-blocked for days.
//
// It also fixes the reason the hit counter never worked: the caller used to DELETE the entry the
// moment its cooldown lapsed, so `prev` was always undefined and `hits` was always 1. Entries must
// OUTLIVE their cooldown for a backoff to exist at all — dispatch resumes anyway, because
// shouldDispatchHost() compares against `until` and does not care whether an entry is present.
export const HOST_BREAKER_FORGET_MS = 12 * 60 * 60 * 1000;

// PURE: should this entry be forgotten entirely? (Cooled down AND quiet since its last trip.)
export function shouldForget(entry, now, forgetMs = HOST_BREAKER_FORGET_MS) {
  if (!entry) return true;
  const trippedAt = Number(entry.trippedAt) || 0;
  const until = Number(entry.until) || 0;
  return now >= until && (now - trippedAt) >= forgetMs;
}
