// JAT v11 — advance-vs-opener keyword decision (pure, node-testable core).
//
// BUG-1: multi-page LinkedIn Easy Apply stalled because the in-form advance scan matched
// the page-level OPENER ("Easy Apply to this job") as if it were the modal's Next/Review/
// Submit. The fix splits the keyword space:
//   • ADVANCE_KEYWORDS — TRUE in-form advance buttons only (Next/Review/Submit/…). Never
//     includes the opener, so the in-form path can never re-click "Easy Apply".
//   • OPEN_KEYWORDS     — page-level OPENERS ("Apply", "Easy Apply", "Postuler"). Matched
//     ONLY when explicitly allowed (allowOpen:true), used by the OPEN-branch generic
//     fallbacks so non-LinkedIn generic pages still open.
//
// isAdvanceLabel(text, {allowOpen}) is the pure decision (no DOM): visibility / disabled /
// the structural Easy-Apply-opener guard remain in executor.js.

export const ADVANCE_KEYWORDS = [
  // "submit application" (LinkedIn/ATS) + "submit your application" (Indeed smartapply's real
  // final-submit label — without the "your" variant it was never found → smartapply stalled on
  // its review step, "no advance button found").
  /^submit( your)? application$/i, /^submit$/i, /^submit & continue$/i,
  /^review your application$/i, /^review$/i,
  /^next$/i, /^continue$/i, /^continue to/i, /^proceed/i,
  /^save and continue$/i, /^save & continue$/i,
  /^finish$/i,
  /^send application$/i, /^suivant$/i, /^continuer$/i, /^soumettre$/i, /^envoyer/i,
];

// OPEN_KEYWORDS are matched ONLY in the open branch (allowOpen:true), which the executor gates
// to non-LinkedIn-job-view pages (shouldUseGenericOpenFallback). Word-boundary PREFIXES so a
// company-ATS opener like "Apply for this job" / "Apply for this position" / "Postuler à ce poste"
// matches — the anchored-exact set used to miss those, the dominant cause of external "no generic
// advance found" stalls. Still scoped to apply-intent leading words; the 40-char guard in
// isAdvanceLabel bounds run-on labels, and ADVANCE_KEYWORDS (in-form) is deliberately unchanged.
export const OPEN_KEYWORDS = [
  /^apply\b/i, /^easy apply/i, /^postuler\b/i,
];

export function isAdvanceLabel(text, { allowOpen = false } = {}) {
  const t = String(text || '').trim();
  if (!t || t.length > 40) return false;
  if (ADVANCE_KEYWORDS.some((re) => re.test(t))) return true;
  if (allowOpen && OPEN_KEYWORDS.some((re) => re.test(t))) return true;
  return false;
}
