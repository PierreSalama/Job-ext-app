// ── SINGLE-FOCUS ARBITER (parallel-safe) ────────────────────────────────────────
// The multi-window freeze (locked mouse) was caused by >1 apply window each calling
// chrome.windows.update({focused:true}) in a tight re-pump loop → an OS focus war that
// starves the pointer/keyboard. EVERY window-front request now routes through this pure
// decision so that:
//   • at most ONE window is granted the foreground within `minIntervalMs`, and
//   • a re-front of the already-held window inside `holdMs` is a cheap no-op (no yank),
// so parallel apply windows can never fight for focus. A refused front is harmless: the
// worker windows are already visible-but-unfocused (tiled), where the SPA hydrates fine.
//
// Pure + deterministic (now is injected) so the war-breaker guarantee is node-testable.
//
// state: { heldWin: number|null, heldAt: number }   (epoch ms)
// returns: { grant, alreadyFront, state }

export const FRONT_MIN_INTERVAL_MS = 1500;   // no two DIFFERENT windows fronted closer than this
export const FRONT_HOLD_MS = 8000;           // a granted front "owns" the foreground this long

export function focusArbiterDecision(state, winId, now, opts = {}) {
  const minIntervalMs = opts.minIntervalMs ?? FRONT_MIN_INTERVAL_MS;
  const holdMs = opts.holdMs ?? FRONT_HOLD_MS;
  const force = !!opts.force;
  const held = state && state.heldWin != null ? state.heldWin : null;
  const heldAt = (state && Number(state.heldAt)) || 0;

  // The already-fronted window asking again inside its hold window: nothing to do.
  if (held === winId && now - heldAt < holdMs && !force) {
    return { grant: false, alreadyFront: true, state: { heldWin: held, heldAt } };
  }
  // A DIFFERENT window fronted too recently → REFUSE. This is the war-breaker: rapid
  // competing front requests from parallel windows are dropped instead of thrashing focus.
  if (!force && held != null && held !== winId && now - heldAt < minIntervalMs) {
    return { grant: false, alreadyFront: false, state: { heldWin: held, heldAt } };
  }
  // Grant: this window becomes the (single) held foreground.
  return { grant: true, alreadyFront: false, state: { heldWin: winId, heldAt: now } };
}
