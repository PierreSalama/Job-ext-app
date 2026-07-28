// JAT v11 — apply-run HARD CAP selector (pure, node-testable).
//
// FIX 1 (throughput, live-observed): a HIDDEN apply tab that won't hydrate used to burn the
// FULL cap (5.5 min) before failing — at concurrency=1 that single stall froze the whole
// queue ("apply timed out after 5.5 min"). The apply tab only ever sends
// jat11.front-until-hydrated when it is OCCLUDED *and* not yet hydrated (after its OWN initial
// ~20s on-display hydration wait already failed), and jat11.apply-hydrated the instant the
// form mounts. So "frontRequested && !hydrated" is precisely the hidden-non-hydrating case:
// cut its cap to ~90s so retry-stale re-attempts it later (when it may be foreground). A
// merely-slow but VISIBLE tab never sends front-until-hydrated, so it keeps the full cap.

// 4 min — MUST fire BEFORE Chrome's ~5-min MV3 service-worker eviction. The cap is enforced by a
// setTimeout chain in background.js (launchOne), and Chrome DESTROYS all setTimeouts when it evicts
// the SW. At the old 5.5 min the SW was evicted (~5 min) before the cap fired, so the timeout never
// rejected, launchOne hung forever, and the concurrency-1 slot stayed pinned until the server's
// 8-min stale-run reconcile — the "stuck on pacing for 8-15 min, nothing applies" stall on the
// headless laptop node (2026-07-27). 4 min fires while the SW is still alive → the slot frees
// cleanly. Still well above a normal Easy-Apply (1-3 min); a genuinely slower run is retried.
export const APPLY_HARD_CAP_MS = 240000;
export const APPLY_HIDDEN_STALL_CAP_MS = 90000;   // ~90s — hidden tab that asked to be fronted and still hasn't hydrated
export const APPLY_HUMAN_CHECK_CAP_MS = 720000;   // 12 min — the USER is solving a Cloudflare check; never time them out

// Pick the hard cap (ms) for an apply run from the live hidden/hydration signals.
//   frontRequested — the tab sent jat11.front-until-hydrated (occluded + not yet hydrated)
//   hydrated       — the tab later sent jat11.apply-hydrated (the form mounted)
//   awaitingHuman  — the tab is on a Cloudflare wall WAITING FOR THE USER to verify (jat11.human-
//                    challenge). This is a deliberate human pause, NOT a stall — give it a long cap
//                    so the 90s hidden-stall / 5.5-min caps don't kill the captcha tab mid-solve.
// awaitingHuman wins; else short cap when fronted-but-unhydrated; else the full cap.
export function applyHardCapMs({ frontRequested = false, hydrated = false, awaitingHuman = false } = {}) {
  if (awaitingHuman) return APPLY_HUMAN_CHECK_CAP_MS;
  return (frontRequested && !hydrated) ? APPLY_HIDDEN_STALL_CAP_MS : APPLY_HARD_CAP_MS;
}
