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

// Fix 1: on a linkedin.com JOB-VIEW page (not the /apply/ route) that has NO Easy-Apply
// opener, the executor must NOT fall back to the generic advance/open button scan. That
// fallback would grab a STRAY "Next" elsewhere on the page (a carousel, a "more jobs"
// pager, the search pagination) and click it repeatedly — the "repeated page-level action
// did not transfer: Next" loop observed on external/"Apply on company website" postings
// (Bosch). Such a posting is external / no-easy-apply and must be handled honestly, never
// driven by a phantom advance button.
//
// PURE: returns whether the generic open/advance fallback is allowed to run on THIS page.
//   onLinkedIn          — is the live host linkedin.com (or a subdomain)?
//   onApplyRoute        — is the live path the /apply/ full-page route?
//   hasEasyApplyOpener  — did findEasyApplyButton() find a real Easy-Apply opener?
//   haveForm            — has an apply form/dialog already been recognised this step?
// On a non-LinkedIn host (genuine external ATS) the generic fallback is ALWAYS allowed —
// that's its legitimate job. Only the LinkedIn job-view-without-Easy-Apply case is blocked.
export function shouldUseGenericOpenFallback({
  onLinkedIn = false,
  onApplyRoute = false,
  hasEasyApplyOpener = false,
  haveForm = false,
} = {}) {
  if (!onLinkedIn) return true;            // non-LinkedIn ATS pages keep the generic fallback
  if (onApplyRoute) return true;           // the /apply/ full-page flow drives via advance scan
  if (haveForm) return true;               // a real LinkedIn form is open — advance within it
  if (hasEasyApplyOpener) return true;     // a real Easy-Apply opener exists — open it
  // LinkedIn job-view page, no /apply/ route, no form, no Easy-Apply opener → external /
  // no-easy-apply. Block the generic fallback so a stray "Next" is never clicked.
  return false;
}

// Fix (resume page): decide what to do on the RESUME step of the new full-page Easy Apply
// flow (or any apply form with a resume requirement). ROOT CAUSE (confirmed live on
// linkedin.com): the user has NO saved resume in LinkedIn, and the upload is a plain
// `<button>Upload resume</button>` with NO `<input type=file>` in the DOM until that button
// is clicked. The executor's attach path only looked for an EXISTING file input, found none,
// and couldn't satisfy "A resume is required" → "Next" blocked → the flow stalled.
//
// PURE + node-testable: the live DOM is reduced to plain booleans/counts by the caller, and
// this returns a decision the caller then ACTS on (selecting a card / clicking the upload
// affordance + attaching / parking honestly).
//
//   savedResumeCount       — number of selectable saved-resume cards/radios on the page.
//   anySavedSelected       — is one of those saved resumes already selected/checked?
//   fileInputPresent       — is there an empty resume-ish `input[type=file]` already mounted?
//   uploadAffordancePresent— is there an "Upload resume" button/element (no input yet)?
//   resumeRequired         — does the page show a resume requirement ("A resume is required",
//                            "Resume*", etc.)?
//   haveResumeBytes        — does the app have résumé bytes available to upload (a configured
//                            résumé doc)?
//
// Returns one of:
//   { action:'select', index }   — select the saved resume at `index` (most-recent), then proceed.
//   { action:'none', reason }    — nothing to do (already selected, or no resume requirement).
//   { action:'attach' }          — a file input is present → attach the bytes (existing path).
//   { action:'upload-then-attach'} — click the upload affordance to CREATE the input, then attach.
//   { action:'park', reason }    — a resume is genuinely required but can't be attached → park honestly.
export function decideResumePage({
  savedResumeCount = 0,
  anySavedSelected = false,
  fileInputPresent = false,
  uploadAffordancePresent = false,
  resumeRequired = false,
  haveResumeBytes = false,
} = {}) {
  // 1) Saved-resume SELECTION controls exist. If one is already selected, nothing to do;
  //    otherwise pick the first/most-recent — no upload needed.
  if (savedResumeCount > 0) {
    if (anySavedSelected) return { action: 'none', reason: 'saved-resume-already-selected' };
    return { action: 'select', index: 0 };
  }
  // 2) A file input is already mounted → attach the bytes via the existing path (old modal
  //    layout, or a page that pre-mounts the input). Only meaningful if we have bytes.
  if (fileInputPresent && haveResumeBytes) return { action: 'attach' };
  // 3) No file input present, but an "Upload resume" affordance exists (or the page shows a
  //    resume requirement) AND we have bytes → click the affordance to CREATE the input, then
  //    attach. This is the new full-page case the executor previously couldn't handle.
  if (!fileInputPresent && (uploadAffordancePresent || resumeRequired) && haveResumeBytes) {
    return { action: 'upload-then-attach' };
  }
  // 4) A resume is genuinely required but we cannot attach one (no bytes, OR no input and no
  //    affordance to create one) → park honestly instead of looping "stuck".
  if (resumeRequired) {
    const reason = !haveResumeBytes
      ? 'resume required — add a résumé to your profile so JAT can attach it'
      : 'resume required — could not find an upload control on this page';
    return { action: 'park', reason };
  }
  // 5) No resume requirement on this page → nothing to do.
  return { action: 'none', reason: 'no-resume-requirement' };
}

// Pure recognizers the executor uses to BUILD the decideResumePage signals from the live DOM
// (kept here so they're node-testable). Text-only; the caller passes element text.
// Matches the "Upload resume" / "Upload CV" / "Attach resume" affordance label.
const UPLOAD_RESUME_LABEL_RX = /upload\s+(?:your\s+)?(?:resume|résumé|cv)|attach\s+(?:your\s+)?(?:resume|résumé|cv)|upload\s+r[ée]sum[ée]/i;
// Matches a page/error that signals a résumé is REQUIRED ("A resume is required", "Resume*",
// "résumé is required", etc.).
const RESUME_REQUIRED_RX = /(?:resume|résumé|cv)\s*(?:\*|is required|required)|(?:a\s+)?(?:resume|résumé|cv)\s+is\s+required|required[^.]{0,20}(?:resume|résumé|cv)/i;
export function isUploadResumeAffordanceLabel(text) {
  return UPLOAD_RESUME_LABEL_RX.test(String(text || ''));
}
export function pageRequiresResume(text) {
  return RESUME_REQUIRED_RX.test(String(text || ''));
}

export { APPLY_ADVANCE_LABEL_RX, UPLOAD_RESUME_LABEL_RX, RESUME_REQUIRED_RX };
