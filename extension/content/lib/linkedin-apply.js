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

// CONFIRMED ROOT CAUSE (firsthand, eBay job 4412182454): JobSpy ingests EVERY LinkedIn
// search result (it can't read the Easy-Apply flag → applyCapability:'unknown'), so the
// queue fills with NON-Easy-Apply LinkedIn postings ("Apply ↗" to the company site,
// "Responses managed off LinkedIn"). With easyApplyOnly ON, the executor opens each one,
// finds no Easy-Apply opener, then BURNS the full ~20s hydration cap waiting for a form
// that will never appear before finally skipping. Dozens of 20s-wasting skips per run.
//
// This pure predicate lets the executor decide, in ~0s, that a LinkedIn JOB-VIEW page is a
// POSITIVELY-external posting (no Easy Apply will ever open) so it can FAST-skip honestly
// instead of waiting out the hydration cap. It is intentionally CONSERVATIVE: it ONLY fires
// on a POSITIVE external signal, and NEVER on the mere absence of an Easy-Apply opener (a
// real Easy Apply can be mid-hydration on a throttled tab — that path keeps the full wait).
//
// PURE — the live DOM is reduced to plain booleans by the caller, so this is node-testable:
//   onLinkedIn          — is the live host linkedin.com (or a subdomain)?
//   onApplyRoute        — is the live path the /apply/ full-page route? (true → never fast-skip;
//                         we are already inside the Easy-Apply flow)
//   hasEasyApplyOpener  — did findEasyApplyButton() find a REAL Easy-Apply opener? (true →
//                         never fast-skip; it's drivable Easy Apply)
//   haveForm            — has an apply form/dialog already been recognised this run?
//   offsiteApplyAnchor  — is there a VISIBLE "Apply"-intent control that is an <a> pointing
//                         OFF LinkedIn (the "Apply ↗" external link)?
//   externalApplyLabel  — is there a VISIBLE Apply control whose label is explicitly external
//                         ("Apply on company website", "Apply externally", FR equivalents)?
//   managedOffLinkedIn  — does the page show "Responses managed off LinkedIn" (LinkedIn's own
//                         marker that the posting routes applicants to the employer's ATS)?
//
// Returns { external: boolean, signal: string|null }. external=true ⇒ FAST-skip is safe.
export function detectLinkedInExternalPosting({
  onLinkedIn = false,
  onApplyRoute = false,
  hasEasyApplyOpener = false,
  haveForm = false,
  offsiteApplyAnchor = false,
  externalApplyLabel = false,
  managedOffLinkedIn = false,
} = {}) {
  // Only ever fast-skip on a LinkedIn JOB-VIEW page where no Easy Apply is in play.
  if (!onLinkedIn || onApplyRoute || hasEasyApplyOpener || haveForm) {
    return { external: false, signal: null };
  }
  // POSITIVE external evidence (any one is sufficient). Prefer the most specific signal name.
  if (externalApplyLabel) return { external: true, signal: 'external-apply-label' };
  if (offsiteApplyAnchor) return { external: true, signal: 'offsite-apply-anchor' };
  if (managedOffLinkedIn) return { external: true, signal: 'responses-managed-off-linkedin' };
  // No positive signal → NOT confidently external. The caller keeps the normal hydration
  // wait so a genuinely-slow Easy Apply is never mis-skipped.
  return { external: false, signal: null };
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

// ============================================================
// FIX 1 — advance-blocked screening questions (the #1 remaining cap).
// ============================================================
// ROOT CAUSE (confirmed live, Webisoft new full-page Easy Apply): on the "Additional
// Questions" page the executor filled the contact fields but left a REQUIRED screening
// radio/select unanswered, clicked Review → LinkedIn blocked the advance (a required Q
// is unanswered) → the page didn't change → the stall guard just re-clicked Review and
// gave up "stuck — page stopped advancing". The fix re-scans the CURRENT page for
// unanswered REQUIRED fields, ANSWERS them (profile → qa → AI → grounded eligibility
// default), retries the advance, and PARKS honestly only what truly can't be answered.
//
// These pieces are PURE so the answer-or-park decision + the grounded eligibility
// defaults are node-testable without a DOM. The executor builds the live signals and
// acts on the decision.

// The well-known WORK-ELIGIBILITY screening questions. Yes/No (or a dropdown) questions
// whose truthful answer is fully determined by the user's stated work authorization — so
// when the profile/qa store DIDN'T already answer them we may apply a GROUNDED default
// (never a fabrication). Anything outside this set is left to profile/qa/AI or parked.
// EN + FR + ES. Indeed smartapply screening questions are often French ("Êtes-vous autorisé à
// travailler au Canada?") or Spanish; once the prompt is recovered the grounded default must
// still match across language so the eligibility radio is answered, not parked.
const ELIGIBILITY_AUTHORIZED_RX = /(legally\s+)?authori[sz]ed\s+to\s+work|eligible\s+to\s+work|right\s+to\s+work|work\s+(?:permit|authori[sz]ation)\b|are\s+you\s+(?:legally\s+)?(?:authori[sz]ed|eligible|permitted)\s+to\s+work|autoris[ée]{0,2}\s+(?:à|a|de|pour)\s+travailler|admissible\s+(?:à|a)\s+travailler|droit\s+de\s+travailler|permis\s+de\s+travail|habilit[ée]{0,2}\s+(?:à|a)\s+travailler|autorizad[oa]\s+(?:a|para)\s+trabajar|derecho\s+a\s+trabajar|elegible\s+para\s+trabajar/i;
const ELIGIBILITY_SPONSOR_RX = /(require|need|seek).{0,30}(sponsor|visa)|sponsor(ship)?\b.{0,30}(require|need|now or in the future)|(now or in the future).{0,30}sponsor|(?:besoin|exiger|exigez|requ[ié]|requerr|n[ée]cessit|aurez|avez)\b.{0,30}(?:parrainage|visa)|(?:parrainage|visa)\b.{0,30}(?:maintenant|futur|avenir|pr[ée]sent)|\bparrainage\b|\bpatrocinio\b/i;
// "Are you able to perform the [essential] duties/functions of this position, with or without
// reasonable accommodation?" — a standard ABILITY-to-do-the-job screen (very common on Indeed
// smartapply; the AI refuses it because "accommodation" reads as disability-adjacent, so it parks +
// blocks the form). The truthful answer for an APPLICANT is YES — you're applying to do the job, and
// the phrasing is INCLUSIVE (with or without accommodation). It is NOT a disability disclosure: it
// never asks whether you HAVE a disability or NEED an accommodation, only whether you can do the job.
// Anchored on "able to perform … <duties/functions/job>" so it never matches "do you require an
// accommodation" / "do you have a disability" (those stay parked via NEVER_AUTOFILL_RX).
const ABILITY_TO_PERFORM_RX = /\b(?:are you able to|able to|can you)\b[^?]{0,70}\bperform\b[^?]{0,70}\b(?:duties|functions|tasks|requirements|responsibilities|role|position|job)\b/i;

// Decide a GROUNDED answer for a well-known work-eligibility screening question, given
// what the profile already tells us. Returns a string answer (e.g. 'Yes'/'No') or null
// when the question is NOT a determinable eligibility one (→ caller leaves it to AI/park).
// NEVER fabricates: it only answers the two eligibility questions whose truthful value
// follows from `authorizedToWork`, and ONLY when we actually know `authorizedToWork`.
//   label             — the question text.
//   authorizedToWork  — is the user authorized to work (in the job's country)? boolean|null.
//                       null/undefined = unknown → return null (don't guess).
//   yesText/noText    — the literal option strings to emit (defaults 'Yes'/'No') so a
//                       select/radio whose options read e.g. "Yes, I am" can be matched.
export function groundedEligibilityAnswer(label, { authorizedToWork = null, yesText = 'Yes', noText = 'No' } = {}) {
  const t = String(label || '');
  if (!t.trim()) return null;
  // Ability-to-perform-the-job → always Yes (truthful for an applicant; independent of work auth).
  if (ABILITY_TO_PERFORM_RX.test(t)) return yesText;
  if (authorizedToWork == null) return null;        // unknown authorization → never guess
  // "Are you authorized / eligible / permitted to work…?" → Yes iff authorized.
  if (ELIGIBILITY_AUTHORIZED_RX.test(t)) return authorizedToWork ? yesText : noText;
  // "Will you now or in the future require sponsorship / a visa?" → No iff already authorized.
  // We only ground the NEGATIVE (authorized → no sponsorship needed). If NOT authorized we
  // do NOT assume sponsorship IS required (could be relocating, etc.) → leave to AI/park.
  if (ELIGIBILITY_SPONSOR_RX.test(t)) return authorizedToWork ? noText : null;
  return null;
}

// Is this label one of the determinable work-eligibility screening questions (so the
// caller may apply a grounded default)? Pure helper, used to keep the executor's branch
// readable and node-testable.
export function isEligibilityScreeningQuestion(label) {
  const t = String(label || '');
  return ELIGIBILITY_AUTHORIZED_RX.test(t) || ELIGIBILITY_SPONSOR_RX.test(t) || ABILITY_TO_PERFORM_RX.test(t);
}

// Partition the unanswered REQUIRED fields blocking an advance into the ones we can
// answer this pass vs the ones we must PARK. PURE: the caller resolves `answerable`
// (did profile/qa/AI/grounded-default produce a confident value?) and `parkable`
// (is it a real question we can hand to the user?) for each field, and this decides
// what to do. Keeps the answer-vs-park policy in one node-testable place.
//   fields — [{ label, answer (string|null), parkable (bool), fieldType, options, reason }]
// Returns { toAnswer:[{label,answer,...}], toPark:[{label,reason,...}], allHandled:bool }.
//   toAnswer   — fields with a non-empty grounded answer → fill them, then retry advance.
//   toPark     — required fields with no answer that ARE parkable → honest park.
//   allHandled — every blocking field was either answered or parked (nothing left in a
//                limbo "blocked but invisible" state).
export function decideAnswerOrPark(fields = []) {
  const toAnswer = [];
  const toPark = [];
  for (const f of Array.isArray(fields) ? fields : []) {
    if (!f) continue;
    const ans = (f.answer != null && String(f.answer).trim()) ? String(f.answer) : null;
    if (ans) { toAnswer.push({ ...f, answer: ans }); continue; }
    if (f.parkable) { toPark.push({ ...f, reason: f.reason || 'needs your answer' }); }
  }
  const allHandled = (toAnswer.length + toPark.length) >= (Array.isArray(fields) ? fields.filter(Boolean).length : 0);
  return { toAnswer, toPark, allHandled };
}

export {
  APPLY_ADVANCE_LABEL_RX,
  UPLOAD_RESUME_LABEL_RX,
  RESUME_REQUIRED_RX,
  ELIGIBILITY_AUTHORIZED_RX,
  ELIGIBILITY_SPONSOR_RX,
};
