// JAT v11 — LinkedIn FULL-PAGE Easy Apply recognition (pure core + a thin DOM driver).
//
// ROOT CAUSE (confirmed live on linkedin.com): LinkedIn MIGRATED Easy Apply from a pop-up
// MODAL to a FULL-PAGE flow. Clicking "Easy Apply to this job" on a /jobs/view/<id> page now
// NAVIGATES to /jobs/view/<id>/apply/ — a full-page form with NO `<form>` element, NO
// `[role=dialog]`, obfuscated/rotating class names, a "N/M pages" indicator and a "Next"
// (later "Review" / "Submit application") button. The executor's findApplyDialog() only knows
// the OLD modal selectors, so on the new layout it finds NO dialog → haveForm stays false →
// it re-clicks the opener → the duplicate-opener breaker fails the task. That is the entire
// zero-submission problem. The OLD modal STILL appears from the search/collections split-view,
// so BOTH layouts must work.
//
// This module is split so the URL/predicate logic is PURE + node-testable without a DOM:
//   • isLinkedInEasyApplyApplyUrl(pathname)         — is this the /apply/ route?
//   • isLinkedInApplyAdvanceLabel(text)             — is this button the visible advance CTA?
//   • deriveApplyRootFromAdvanceButton(btn, opts)   — walk UP to the field-bearing ancestor.
// findLinkedInApplyPageRoot() composes them against the live DOM (the only DOM-coupled fn).

// The advance button on the new full-page flow: a <button> whose TRIMMED text is exactly one
// of Next / Review / Review your application / Submit application / Continue (LinkedIn renders
// the label in plain text or aria-label). Kept tight (exact match) so it never matches the
// page-level "Easy Apply" opener or unrelated chrome buttons.
const APPLY_ADVANCE_LABEL_RX = /^(next|review|review your application|submit application|submit|continue)$/i;

// Is the given pathname the LinkedIn full-page Easy-Apply /apply/ route?
// LIVE-VALIDATED: true for /jobs/view/123/apply and /jobs/collections/123/apply (with or
// without a trailing slash / query / hash); false for the plain /jobs/view/123 job page.
// Pure: takes the pathname string only (caller checks the linkedin.com host separately).
export function isLinkedInEasyApplyApplyUrl(pathname) {
  return /\/jobs\/(?:view|collections)\/[^/]*\/?apply\b/i.test(String(pathname || ''));
}

// Is this trimmed button text the new full-page flow's advance/submit CTA?
export function isLinkedInApplyAdvanceLabel(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 40) return false;
  return APPLY_ADVANCE_LABEL_RX.test(t);
}

// Walk UP from the visible advance button until an ancestor contains >=1 visible field
// (input/select/textarea/combobox/contenteditable). That ancestor is the form root — it holds
// the apply fields and EXCLUDES the global nav/search box (LIVE-VALIDATED: rootHasNav=false).
//
// PURE: all DOM access is injected so this is node-testable.
//   button          — the advance button element (the walk start; its own subtree is searched
//                     too, since the button can sit beside the fields under the same wrapper).
//   parentOf(el)    — returns the parent element (or null at the top).
//   countFields(el) — returns the number of VISIBLE fillable fields within el's subtree.
//   hasNav(el)      — true if el's subtree contains the global nav / search box (reject roots
//                     that swallow the page chrome — keeps walking past document.body).
//   maxDepth        — guard against a pathological ancestor chain (default 25).
//
// Returns the chosen ancestor element, or null if none qualifies.
export function deriveApplyRootFromAdvanceButton(button, {
  parentOf,
  countFields,
  hasNav = () => false,
  maxDepth = 25,
} = {}) {
  if (!button || typeof parentOf !== 'function' || typeof countFields !== 'function') return null;
  let el = button;
  let depth = 0;
  while (el && depth < maxDepth) {
    let fields = 0;
    try { fields = Number(countFields(el)) || 0; } catch { fields = 0; }
    if (fields >= 1) {
      // This ancestor bears the fields. Reject it ONLY if it also swallows the global nav
      // (it's too broad — e.g. document.body) and keep walking is pointless (broader still
      // has nav too), so a nav-bearing first hit means "no clean root here".
      let navInside = false;
      try { navInside = !!hasNav(el); } catch { navInside = false; }
      if (!navInside) return el;
    }
    let next = null;
    try { next = parentOf(el); } catch { next = null; }
    if (!next || next === el) break;
    el = next;
    depth++;
  }
  return null;
}

export { APPLY_ADVANCE_LABEL_RX };
