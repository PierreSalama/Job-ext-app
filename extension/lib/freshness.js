// JAT v11 — newest-first freshness ramp (pure, node-testable).
//
// The user wants to apply to the FRESHEST jobs first, then widen only when a search
// stops surfacing new ones. LinkedIn's time-posted filter is `f_TPR=r<seconds>`
// (r3600 = last 1h, … r604800 = last 7d). We start at the NARROWEST tier and hammer it
// while it keeps producing NEW jobs; the moment a (board,keyword,location) scan ingests
// 0 new jobs, we widen to the next tier. At the widest tier we stay put (the queue stays
// fed with the freshest 7-day window) — never narrower-than-1h, never wider-than-7d.
//
// Indeed only exposes day-granularity (`&fromage=<days>`), so the sub-day tiers there
// clamp to fromage=1 — the fine ramp is LinkedIn-only, which is fine.

// Narrowest → widest. Seconds.
const FRESHNESS_TIERS = [3600, 7200, 14400, 28800, 86400, 604800];

// The tier a brand-new combo starts at (the narrowest — freshest).
const NARROWEST_TIER = FRESHNESS_TIERS[0];
const WIDEST_TIER = FRESHNESS_TIERS[FRESHNESS_TIERS.length - 1];

// Given the combo's current tier (seconds) and whether the last scan found NEW jobs,
// return the tier to use NEXT:
//   • foundNew === true  → KEEP the current tier (keep hammering the fresh window).
//   • foundNew === false → WIDEN to the next tier; once at the widest, STAY there.
// An unknown / out-of-ladder current value snaps to the narrowest (safe restart).
function nextFreshnessTier(currentSeconds, foundNew) {
  const idx = FRESHNESS_TIERS.indexOf(Number(currentSeconds));
  if (idx === -1) return NARROWEST_TIER;          // unknown → restart at the freshest
  if (foundNew) return FRESHNESS_TIERS[idx];      // productive → stay narrow
  return FRESHNESS_TIERS[Math.min(idx + 1, FRESHNESS_TIERS.length - 1)];  // dry → widen (clamped)
}

// Convert a tier (seconds) to Indeed's coarse day filter: any sub-day tier maps to 1 day
// (Indeed's finest granularity), otherwise floor to whole days, min 1.
function tierToIndeedDays(seconds) {
  const s = Number(seconds) || NARROWEST_TIER;
  return Math.max(1, Math.floor(s / 86400));
}

export { FRESHNESS_TIERS, NARROWEST_TIER, WIDEST_TIER, nextFreshnessTier, tierToIndeedDays };
