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
