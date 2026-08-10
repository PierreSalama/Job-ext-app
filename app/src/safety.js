// PLATFORM SAFETY GOVERNOR — the thing that was missing on 2026-08-10 02:28, when LinkedIn
// restricted Pierre's account for "an unusually high volume of LinkedIn profile data".
//
// The post-mortem, from this machine's own discovery_batches table:
//
//     2026-08-08  linkedin  runs=281  found=8627      <- searches
//     2026-08-08  indeed    runs=278  found=7983
//     ...and the laptop was running the SAME settings against the SAME account, in parallel.
//
// Applications were never the problem: ~40/day, at LinkedIn's own Easy-Apply ceiling. The volume
// LinkedIn measured was DISCOVERY — hundreds of search scrapes a day, each pulling 25-50 job
// records, from two machines, unbounded, 24/7, forever. Every cap in the system counted *applies*.
// Nothing counted searches, nothing counted both together, and nothing was shared across nodes.
//
// This module is the single governor for "how much may we touch this platform". It counts EVERY
// touch — searches and applies alike — against one budget, and it is deliberately, boringly
// conservative. Four independent brakes, any one of which can say no:
//
//   1. ROLE       — only ONE node may touch a platform at all. Structural, needs no coordination:
//                   the other node's answer is always no, so two machines can never sum past the
//                   budget. This is what actually fixes "two PCs on one account".
//   2. BUDGET     — rolling 24h and 1h ceilings, per kind (search / apply).
//   3. GAP        — a minimum spacing between touches, JITTERED, so the traffic doesn't arrive on
//                   a metronome (a fixed 60s interval is itself an automation signature).
//   4. QUIET HOURS— a nightly window with no traffic at all. Real people sleep; a job seeker who
//                   searches at a steady rate through 4am is not a job seeker.
//
// Pure functions + explicit inputs, so every brake is testable without a DB, a clock, or a network.

// ---- time helpers ------------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function parseHHMM(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function minutesOfDay(d) { return d.getHours() * 60 + d.getMinutes(); }

// Quiet windows may wrap midnight (23:00 → 07:00 is the default and the common case).
function inQuietWindow(nowMin, startMin, endMin) {
  if (startMin === endMin) return false;                    // zero-length = no quiet hours
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;             // wraps midnight
}

// When does the current quiet window end, in ms from now? Used for retryAfter so callers can back
// off for hours instead of re-asking every tick.
function msUntilQuietEnd(now, endMin) {
  const end = new Date(now);
  end.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);
  if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1);
  return end.getTime() - now.getTime();
}

// ---- config ------------------------------------------------------------------------------------

// Defaults are what we'd want if the settings row were empty or corrupt — they must be SAFE, not
// productive. A missing config must never mean "unlimited".
const PLATFORM_FALLBACK = {
  role: 'none',
  searchesPerDay: 24,
  searchesPerHour: 3,
  minSearchGapMinutes: 20,
  appliesPerDay: 15,
  appliesPerHour: 4,
  minApplyGapMinutes: 4,
  quietStart: '23:00',
  quietEnd: '07:00',
  jitterPct: 0.4,
};

function platformConfig(safety, platform) {
  const table = (safety && safety.platforms) || {};
  const raw = table[String(platform || '').toLowerCase()] || {};
  const cfg = { ...PLATFORM_FALLBACK };
  for (const k of Object.keys(PLATFORM_FALLBACK)) {
    if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') cfg[k] = raw[k];
  }
  return cfg;
}

// Which node owns a platform. 'primary' may touch it; anything else may not.
function ownsPlatform(safety, platform) {
  return String(platformConfig(safety, platform).role).toLowerCase() === 'primary';
}

// Is this platform one we govern at all?
//
// The two call sites want OPPOSITE defaults for an unconfigured platform, on purpose:
//
//   • DISCOVERY searches run against a closed set of scrapers (linkedin, indeed, glassdoor,
//     google, zip_recruiter) — every one of them a site that rate-limits and bans. A new one
//     appearing with no budget must FAIL SAFE and stay off until someone gives it a budget.
//
//   • APPLY dispatch covers the whole world: Greenhouse, Lever, Ashby, and a thousand company
//     career pages. Those are individual employers' own forms, not a platform metering us, and
//     they are precisely the safe lane we want to keep running while LinkedIn is throttled.
//     Blocking everything unconfigured there would silently stop the entire external pipeline.
//
// So callers that pass `requireConfig: true` get "unconfigured ⇒ ungoverned ⇒ allowed".
function isConfiguredPlatform(safety, platform) {
  const table = (safety && safety.platforms) || {};
  return Object.prototype.hasOwnProperty.call(table, String(platform || '').toLowerCase());
}

// ---- the gap, jittered -------------------------------------------------------------------------

// A minimum gap of exactly N minutes, every time, is a fingerprint. Spread each gap over
// [base, base * (1 + jitterPct)] so the inter-arrival times look like a person deciding to look
// again, not a timer firing. Jitter only ever makes us SLOWER — never faster than the floor.
function jitteredGapMs(baseMinutes, jitterPct, rng = Math.random) {
  const base = Math.max(0, Number(baseMinutes) || 0) * 60000;
  const pct = Math.max(0, Math.min(2, Number(jitterPct) || 0));
  return Math.round(base * (1 + pct * rng()));
}

// ---- the decision ------------------------------------------------------------------------------

// counts: { search: { day, hour }, apply: { day, hour } } over rolling windows
// lastTouchAt: ms epoch of the most recent touch of THIS kind (0 = never)
// requiredGapMs: the jittered gap this caller already rolled (so a deferral is stable across
//                re-asks within the same wait — the caller stores it and passes it back)
function decideTouch({ safety, platform, kind, counts, lastTouchAt = 0, requiredGapMs = null, requireConfig = false, now = new Date(), rng = Math.random }) {
  const s = safety || {};
  if (s.enabled === false) return { ok: true, reason: 'safety-disabled' };
  if (requireConfig && !isConfiguredPlatform(s, platform)) return { ok: true, reason: 'ungoverned-platform', platform };

  const cfg = platformConfig(s, platform);
  if (String(cfg.role).toLowerCase() !== 'primary') {
    // Not this node's platform. Permanent for this node — retryAfter is deliberately a full day so
    // nothing spins re-asking; the answer changes only when a human changes the role.
    return { ok: false, reason: 'not-this-node', retryAfterMs: DAY_MS, platform };
  }

  const quietStart = parseHHMM(cfg.quietStart);
  const quietEnd = parseHHMM(cfg.quietEnd);
  if (quietStart != null && quietEnd != null && inQuietWindow(minutesOfDay(now), quietStart, quietEnd)) {
    return { ok: false, reason: 'quiet-hours', retryAfterMs: msUntilQuietEnd(now, quietEnd), platform };
  }

  const isApply = String(kind).toLowerCase() === 'apply';
  const perDay = Number(isApply ? cfg.appliesPerDay : cfg.searchesPerDay) || 0;
  const perHour = Number(isApply ? cfg.appliesPerHour : cfg.searchesPerHour) || 0;
  const c = (counts && counts[isApply ? 'apply' : 'search']) || { day: 0, hour: 0 };
  const day = Number(c.day) || 0;
  const hour = Number(c.hour) || 0;

  if (perDay > 0 && day >= perDay) {
    return { ok: false, reason: 'daily-budget', retryAfterMs: HOUR_MS, platform, used: day, budget: perDay };
  }
  if (perHour > 0 && hour >= perHour) {
    return { ok: false, reason: 'hourly-budget', retryAfterMs: 10 * 60000, platform, used: hour, budget: perHour };
  }

  const baseGap = isApply ? cfg.minApplyGapMinutes : cfg.minSearchGapMinutes;
  const gap = requiredGapMs == null ? jitteredGapMs(baseGap, cfg.jitterPct, rng) : Math.max(0, Number(requiredGapMs) || 0);
  if (lastTouchAt > 0) {
    const since = now.getTime() - lastTouchAt;
    if (since < gap) {
      return { ok: false, reason: 'min-gap', retryAfterMs: gap - since, requiredGapMs: gap, platform };
    }
  }

  return { ok: true, platform, kind: isApply ? 'apply' : 'search', used: day, budget: perDay };
}

// A compact, user-facing summary of where a platform's budget stands — for the dashboard and for
// the report Pierre reads. Never throws on a half-built config.
function budgetSummary({ safety, platform, counts }) {
  const cfg = platformConfig(safety || {}, platform);
  const c = counts || {};
  const sd = (c.search && Number(c.search.day)) || 0;
  const ad = (c.apply && Number(c.apply.day)) || 0;
  return {
    platform,
    role: String(cfg.role).toLowerCase(),
    searches: { used: sd, budget: Number(cfg.searchesPerDay) || 0 },
    applies: { used: ad, budget: Number(cfg.appliesPerDay) || 0 },
    quietHours: `${cfg.quietStart}–${cfg.quietEnd}`,
  };
}

module.exports = {
  decideTouch,
  budgetSummary,
  ownsPlatform,
  isConfiguredPlatform,
  platformConfig,
  jitteredGapMs,
  inQuietWindow,
  parseHHMM,
  PLATFORM_FALLBACK,
  HOUR_MS,
  DAY_MS,
};
