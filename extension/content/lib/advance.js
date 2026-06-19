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
  /^submit application$/i, /^submit$/i, /^submit & continue$/i,
  /^review your application$/i, /^review$/i,
  /^next$/i, /^continue$/i, /^continue to/i, /^proceed/i,
  /^save and continue$/i, /^save & continue$/i,
  /^finish$/i,
  /^send application$/i, /^suivant$/i, /^continuer$/i, /^soumettre$/i, /^envoyer/i,
];

export const OPEN_KEYWORDS = [
  /^apply now$/i, /^apply$/i, /^easy apply/i, /^postuler$/i,
];

export function isAdvanceLabel(text, { allowOpen = false } = {}) {
  const t = String(text || '').trim();
  if (!t || t.length > 40) return false;
  if (ADVANCE_KEYWORDS.some((re) => re.test(t))) return true;
  if (allowOpen && OPEN_KEYWORDS.some((re) => re.test(t))) return true;
  return false;
}
