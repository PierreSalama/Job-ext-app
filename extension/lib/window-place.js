// JAT v11 — apply-window placement (pure, node-testable core).
//
// BUG-2: the dedicated apply window was always created at the PRIMARY display's top-left
// (left:60, top:60) and fronted to beat Chrome's occlusion throttle — popping over the
// user's main-display work and stealing focus.
//
// Better placement, given the connected displays (chrome.system.display.getInfo):
//   • ≥2 displays → put the apply window FULLY on a NON-primary display. A window fully
//     visible on a secondary display is NOT occluded, so Chrome won't throttle it AND it
//     never covers the user's main-display work. Fixes BOTH the annoyance and the throttle.
//   • 1 display → keep it on that display but OUT OF THE WAY (bottom-right of the work
//     area) rather than top-left over the user's content. The caller keeps it focused:false
//     and only fronts when genuinely throttled (front-until-hydrate), restoring focus.
//
// Returns {left, top, width, height} clamped inside the chosen display's work area, or
// null when we have no usable display info (caller falls back to today's behavior).
// Cross-browser safe: this is a pure function over a plain array; the caller guards the
// chrome.system.display API itself.

const DEFAULT_W = 1200;
const DEFAULT_H = 900;
const INSET = 40;        // small inset so the window isn't flush against a screen edge

function workAreaOf(display) {
  // chrome.system.display gives workArea (excludes taskbar/dock); fall back to bounds.
  const a = display?.workArea || display?.bounds;
  if (!a || typeof a.left !== 'number' || typeof a.top !== 'number'
      || typeof a.width !== 'number' || typeof a.height !== 'number') return null;
  return a;
}

// Place a window inside `area`, at `corner` ('top-left' | 'bottom-right'), clamping the
// size to fit and keeping it fully within the work area.
function placeInArea(area, corner) {
  const width = Math.max(480, Math.min(DEFAULT_W, area.width - 2 * INSET));
  const height = Math.max(360, Math.min(DEFAULT_H, area.height - 2 * INSET));
  let left, top;
  if (corner === 'bottom-right') {
    left = area.left + area.width - width - INSET;
    top = area.top + area.height - height - INSET;
  } else {
    left = area.left + INSET;
    top = area.top + INSET;
  }
  // Final clamp (guards tiny/odd work areas).
  left = Math.round(Math.max(area.left, Math.min(left, area.left + area.width - width)));
  top = Math.round(Math.max(area.top, Math.min(top, area.top + area.height - height)));
  return { left, top, width: Math.round(width), height: Math.round(height) };
}

// Tile window `slot` of `slots` as side-by-side columns inside `area`. Every tile is FULLY
// visible (no overlap), so none of the parallel apply windows occlude each other — and an
// un-occluded window is never Chrome-throttled, which is the whole point at concurrency > 1
// (stacked windows = the covered ones throttle and never hydrate). Columns, not a grid: a
// ~1/3-width window is still wide enough to render an ATS form, and a single row is simplest
// to reason about for the 2–3 workers we cap at.
function tileInArea(area, slot, slots) {
  const GAP = 16;
  const n = Math.max(1, slots | 0);
  const i = Math.max(0, Math.min(n - 1, slot | 0));
  const width = Math.max(420, Math.floor((area.width - GAP * (n + 1)) / n));
  const height = Math.max(360, area.height - 2 * INSET);
  let left = area.left + GAP + i * (width + GAP);
  let top = area.top + INSET;
  left = Math.round(Math.max(area.left, Math.min(left, area.left + area.width - width)));
  top = Math.round(Math.max(area.top, Math.min(top, area.top + area.height - height)));
  return { left, top, width: Math.round(width), height: Math.round(height) };
}

// opts.slots = total parallel apply windows (concurrency); opts.slot = this window's 0-based
// index. Defaults to a single window (slots:1) = the original, unchanged placement.
export function pickApplyWindowBounds(displays, opts = {}) {
  if (!Array.isArray(displays) || displays.length === 0) return null;
  const slots = Math.max(1, Number(opts.slots) || 1);
  const slot = Math.max(0, Number(opts.slot) || 0);

  // Choose the display: a NON-primary one when available (keeps apply windows off the user's
  // main screen entirely), else the single display.
  const chosen = displays.length >= 2
    ? (displays.find((d) => !d?.isPrimary) || displays[1] || displays[0])
    : displays[0];
  const area = workAreaOf(chosen);
  if (!area) return null;

  // PARALLEL (concurrency > 1): tile the N windows side-by-side so none occlude → none throttle.
  if (slots >= 2) return tileInArea(area, slot, slots);

  // SINGLE worker: unchanged — secondary display → top-left (whole free screen); single
  // display → bottom-right (out of the user's way).
  return placeInArea(area, displays.length >= 2 ? 'top-left' : 'bottom-right');
}
