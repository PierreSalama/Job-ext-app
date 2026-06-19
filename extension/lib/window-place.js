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

export function pickApplyWindowBounds(displays) {
  if (!Array.isArray(displays) || displays.length === 0) return null;

  if (displays.length >= 2) {
    // Prefer a NON-primary display so the apply window never sits on the user's main screen.
    const secondary = displays.find((d) => !d?.isPrimary) || displays[1] || displays[0];
    const area = workAreaOf(secondary);
    if (!area) return null;
    // Top-left of the secondary display (it's a whole free screen — no need to hide it).
    return placeInArea(area, 'top-left');
  }

  // Single display: keep it out of the way (bottom-right of the work area).
  const area = workAreaOf(displays[0]);
  if (!area) return null;
  return placeInArea(area, 'bottom-right');
}
