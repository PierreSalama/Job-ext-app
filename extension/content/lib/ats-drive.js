// Pure, DOM-free decision helpers for the external-ATS driving path (executor).
// Extracted so they're node-testable without a browser (tests/external-ats.test.mjs).
//
// confirmSignalsMatched: a per-ATS adapter may declare `confirmSignals` (an array
// of RegExp or string) that mark "application received" post-submit copy. These are
// ADDITIONAL evidence layered on top of R1 success-truth (evaluateSubmitEvidence) —
// they must NEVER weaken R1. So a signal only counts as confirmation when it appears
// AFTER the submit click (i.e. it is NEW vs the pre-click baseline text). This guards
// against pre-existing static "thank you for your interest" recruiting copy minting a
// false done — exactly the Activision/Canada-Job-Bank failure mode R1 was built for.
//
// @param signals  adapter.confirmSignals — array of RegExp | string, or falsy.
// @param beforeText  normalized page/form text captured BEFORE the submit click.
// @param afterText   normalized page/form text captured AFTER the submit settled.
// @returns the matched signal's source (string) when a signal matches afterText AND
//          did NOT already match beforeText (it is genuinely new); else null.
export function confirmSignalsMatched(signals, beforeText, afterText) {
  if (!Array.isArray(signals) || !signals.length) return null;
  const after = String(afterText || '');
  if (!after) return null;
  const before = String(beforeText || '');
  for (const sig of signals) {
    const re = toRegExp(sig);
    if (!re) continue;
    // Must appear AFTER the click. If it ALSO appeared before, it's pre-existing
    // static copy — not new confirmation evidence — so it does not count.
    if (re.test(after) && !re.test(before)) {
      return re.source;
    }
  }
  return null;
}

// findPackSubmitBroadened — BROADENED final-submit pick for a recognised account-less
// ATS whose final "Submit Application" button sits OUTSIDE the field container (e.g.
// BambooHR renders it in a page-level footer, not inside the form root). The normal
// in-form advance/submit scan is root-scoped and misses it. When that scan finds nothing,
// the executor re-scans a BROADER scope (document) and asks THIS helper which candidate is
// the pack's final submit, using ONLY the adapter's specific `isSubmitHint` — never an
// arbitrary button. This keeps the broadening conservative: a button must match the pack's
// own submit recognizer (e.g. bamboohr → "submit application") AND be visible + enabled.
//
// The DOM walk stays in the executor (it builds the candidates array with live text +
// visibility + the element handle); THIS function is the pure, node-testable decision:
// "of these candidates, which is the pack's final submit?".
//
// @param candidates  array of { text, el, visible, disabled } — buttons in the broad scope.
// @param isSubmitHint  the adapter's submit recognizer: (text, el) => boolean.
// @returns the index of the first visible, enabled candidate the adapter recognises as its
//          final submit; or -1 when none qualify (so the executor does NOT broaden blindly).
export function findPackSubmitBroadened(candidates, isSubmitHint) {
  if (!Array.isArray(candidates) || typeof isSubmitHint !== 'function') return -1;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c || !c.visible || c.disabled) continue;
    let hit = false;
    try { hit = !!isSubmitHint(c.text, c.el); } catch { hit = false; }
    if (hit) return i;
  }
  return -1;
}

// Normalize a confirmSignal entry (RegExp or string) into a case-insensitive RegExp.
// Strings are treated as literal substrings (escaped). Returns null on bad input.
function toRegExp(sig) {
  try {
    if (sig instanceof RegExp) return sig;
    if (typeof sig === 'string' && sig.trim()) {
      const escaped = sig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(escaped, 'i');
    }
  } catch {}
  return null;
}
