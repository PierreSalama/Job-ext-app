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

// How long until the quiet window OPENS — i.e. how much active time is left today. This is the
// horizon the daily budget has to be spread across.
function msUntilQuietStart(now, startMin) {
  const start = new Date(now);
  start.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
  if (start.getTime() <= now.getTime()) start.setDate(start.getDate() + 1);
  return start.getTime() - now.getTime();
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
  // Ceiling on the ADAPTIVE pace below. Spreading a budget over the day is right up to a point;
  // without a ceiling, "2 applies left, 9 active hours to go" computes a 4.5h gap and the node
  // looks dead. Past this the pace stops stretching and the budget simply finishes early.
  maxGapMinutes: 45,
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

// ---- the adaptive pace ---------------------------------------------------------------------
//
// The min-gap alone produces exactly the wrong shape. Live on the laptop 2026-08-21, LinkedIn ran
// minApplyGapMinutes=4 under appliesPerHour=4: four applies inside twenty minutes, then forty
// minutes of nothing, every hour, all day — a burst-and-silence pattern no human produces, and the
// daily budget spent hours before the day ended. The floor answers "how close may two touches be";
// nothing answered "how far apart SHOULD they be so the day's allowance lasts the day".
//
// That is this. Two constraints, and the slower one wins:
//
//   HOURLY — one hour divided by the hourly allowance. Stops a whole hour's worth arriving in the
//            first five minutes, so the hourly ceiling becomes a backstop instead of the throttle.
//   DAILY  — the allowance still UNSPENT divided by the active time still LEFT before quiet hours.
//            Self-correcting by construction: a slow morning speeds the afternoon up, a busy
//            morning slows the evening down, and the budget lands on the day rather than at noon.
//
// Both are advisory targets, not brakes: the real ceilings still refuse independently below.

// Active (non-quiet) milliseconds in a whole day — the fallback horizon when "remaining" is zero.
function activeMsPerDay(cfg) {
  const qs = parseHHMM(cfg.quietStart);
  const qe = parseHHMM(cfg.quietEnd);
  if (qs == null || qe == null || qs === qe) return DAY_MS;
  const quietMin = qs < qe ? (qe - qs) : (1440 - qs + qe);
  return Math.max(HOUR_MS, (1440 - quietMin) * 60000);
}

// Active milliseconds left before the next quiet window opens. Zero while inside quiet hours.
function activeMsRemaining(now, cfg) {
  const qs = parseHHMM(cfg.quietStart);
  const qe = parseHHMM(cfg.quietEnd);
  if (qs == null || qe == null || qs === qe) return DAY_MS;   // no quiet window ⇒ the whole rolling day
  if (inQuietWindow(minutesOfDay(now), qs, qe)) return 0;
  return msUntilQuietStart(now, qs);
}

// The target spacing, before jitter and before the floor. Never a refusal — always a number.
//
// APPLIES ONLY, deliberately. A discovery tick is a BATCH by design — combosPerTick combos fanned
// across every selected board, issued together (discovery/index.js scanCombo) — and the governor is
// asked once per outbound search inside that fan-out. Pacing there would refuse every member of the
// batch except the first, collapsing discovery yield; the search lane is already spaced by its own
// hard per-day/per-hour budgets and by discovery.intervalMinutes, which is the knob that actually
// controls how often a sweep happens. Applies are the opposite shape: strictly one at a time, one
// per dispatch, and that is the stream we want spread evenly across the day.
function paceGapMs({ cfg, kind, counts, now = new Date() }) {
  const isApply = String(kind).toLowerCase() === 'apply';
  if (!isApply) return 0;
  const perDay = Number(cfg.appliesPerDay) || 0;
  const perHour = Number(cfg.appliesPerHour) || 0;
  const c = (counts && counts.apply) || { day: 0, hour: 0 };
  const used = Number(c.day) || 0;

  const hourly = perHour > 0 ? HOUR_MS / perHour : 0;

  let daily = 0;
  if (perDay > 0) {
    const left = perDay - used;
    if (left > 0) {
      // Inside quiet hours the remaining horizon is zero and the quiet brake already refuses; use
      // the whole-day average so callers that ask anyway get a sane number instead of Infinity.
      const horizon = activeMsRemaining(now, cfg) || activeMsPerDay(cfg);
      daily = horizon / left;
    }
  }

  const ceiling = Math.max(0, Number(cfg.maxGapMinutes) || 0) * 60000;
  const pace = Math.max(hourly, daily);
  return ceiling > 0 ? Math.min(pace, ceiling) : pace;
}

// Jitter AROUND the pace, not above it. jitteredGapMs is one-sided on purpose (a floor may only be
// stretched, never shortened), but a pace is a target: stretching it one-sidedly would bias every
// gap long and systematically underspend the budget. So spread symmetrically over ±pct/2 — the mean
// stays on the pace, the arrivals stop being predictable — and clamp to the hard floor.
function jitteredPaceMs(targetMs, floorMs, jitterPct, rng = Math.random) {
  const pct = Math.max(0, Math.min(2, Number(jitterPct) || 0));
  const spread = 1 + pct * (rng() - 0.5);
  return Math.max(Math.max(0, floorMs), Math.round(Math.max(0, targetMs) * spread));
}

// ---- the decision ------------------------------------------------------------------------------

// counts: { search: { day, hour }, apply: { day, hour } } over rolling windows
// lastTouchAt: ms epoch of the most recent touch of THIS kind (0 = never). For the apply lane this
//              INCLUDES refunded page views, because a job page we opened is still traffic.
// lastApplyAt: ms epoch of the most recent REAL application (0 = never; defaults to lastTouchAt).
//              The two clocks are separate on purpose — see the note at the gap check below.
// requiredGapMs: the jittered gap this caller already rolled (so a deferral is stable across
//                re-asks within the same wait — the caller stores it and passes it back)
function decideTouch({ safety, platform, kind, counts, lastTouchAt = 0, lastApplyAt = null, requiredGapMs = null, requireConfig = false, now = new Date(), rng = Math.random }) {
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

  // FLOOR vs PACE — measured against DIFFERENT clocks, and that distinction is what makes the
  // refund worth anything.
  //
  // The floor ("never closer than this") is about traffic, so it runs off the last touch of any
  // sort, refunded page views included. The pace ("how far apart we aim to be") is about spending
  // the day's APPLICATION allowance evenly, so it runs off the last real application.
  //
  // Collapse them onto one clock and the refund becomes cosmetic: two thirds of LinkedIn dispatches
  // turn out to be external postings, and if each of those cost a full paced gap of wall-clock the
  // budget could never be spent — we would hand back allowance we had no time left to use. Keeping
  // the clocks apart means a peek costs the floor (minutes) while a real application costs the pace.
  const baseGap = isApply ? cfg.minApplyGapMinutes : cfg.minSearchGapMinutes;
  const floorMs = Math.max(0, Number(baseGap) || 0) * 60000;
  const paceMs = paceGapMs({ cfg, kind, counts, now });
  const targetMs = Math.max(floorMs, paceMs);
  const gap = requiredGapMs == null
    ? jitteredPaceMs(targetMs, floorMs, cfg.jitterPct, rng)
    : Math.max(0, Number(requiredGapMs) || 0);
  // Callers that do not distinguish the two (the search lane, and any older caller) fall back to
  // the single clock, which reproduces the previous behaviour exactly.
  const applyClock = lastApplyAt == null ? lastTouchAt : Math.max(0, Number(lastApplyAt) || 0);
  if (lastTouchAt > 0) {
    const sinceAny = now.getTime() - lastTouchAt;
    if (sinceAny < floorMs) {
      return { ok: false, reason: 'min-gap', retryAfterMs: floorMs - sinceAny, requiredGapMs: gap, paceMs, floorMs, against: 'floor', platform };
    }
  }
  if (applyClock > 0 && gap > floorMs) {
    const sinceApply = now.getTime() - applyClock;
    if (sinceApply < gap) {
      return { ok: false, reason: 'min-gap', retryAfterMs: gap - sinceApply, requiredGapMs: gap, paceMs, floorMs, against: 'pace', platform };
    }
  }

  return { ok: true, platform, kind: isApply ? 'apply' : 'search', used: day, budget: perDay, paceMs, floorMs, gapMs: gap };
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
  paceGapMs,
  jitteredPaceMs,
  activeMsRemaining,
  activeMsPerDay,
  msUntilQuietStart,
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
