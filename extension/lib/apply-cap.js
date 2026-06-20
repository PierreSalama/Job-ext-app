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

export const APPLY_HARD_CAP_MS = 330000;          // 5.5 min — generous cap for a visible-but-slow tab
export const APPLY_HIDDEN_STALL_CAP_MS = 90000;   // ~90s — hidden tab that asked to be fronted and still hasn't hydrated

// Pick the hard cap (ms) for an apply run from the live hidden/hydration signals.
//   frontRequested — the tab sent jat11.front-until-hydrated (occluded + not yet hydrated)
//   hydrated       — the tab later sent jat11.apply-hydrated (the form mounted)
// Short cap ONLY when the tab asked to be fronted AND has not hydrated; full cap otherwise.
export function applyHardCapMs({ frontRequested = false, hydrated = false } = {}) {
  return (frontRequested && !hydrated) ? APPLY_HIDDEN_STALL_CAP_MS : APPLY_HARD_CAP_MS;
}
