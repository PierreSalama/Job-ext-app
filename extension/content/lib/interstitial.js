// JAT v11 — LinkedIn Easy-Apply INTERSTITIAL classifier (pure, DOM-free, testable).
//
// Why this exists: between clicking "Easy Apply" and reaching the real, field-bearing
// Easy-Apply form, LinkedIn sometimes shows an INTERMEDIATE modal — a resume picker
// ("Choose a resume" / "Be sure to include an updated resume"), a "Continue applying"
// confirmation, or a review/"Submit application"-less interstitial — that carries no
// fillable answer fields. The executor's form scan therefore reports haveForm=false, so
// the loop wants to re-click the underlying Easy-Apply opener; the duplicate-opener
// breaker then stops it and the run terminal-failed ("repeated page-level action did
// not transfer: Easy Apply"), killing Easy Apply (the dominant submit source).
//
// This module decides, from a plain description of the modal's controls, whether the
// current modal is such an interstitial and which control ADVANCES it toward the real
// form (and whether to first pick a default resume). It is intentionally DOM-free: the
// executor builds the description from the live dialog and acts on the decision. Keeping
// it pure makes the decision node-testable without a browser.

// Controls that move an interstitial FORWARD (no field input required).
const ADVANCE_LABEL_RX = /^(continue|continue applying|next|review|review your application|use this resume|apply|done|got it|ok)\b/i;
// French equivalents (LinkedIn localizes).
const ADVANCE_LABEL_FR_RX = /^(continuer|suivant|réviser|revoir|utiliser ce|postuler|terminer|j'?ai compris|d'?accord)\b/i;
// Text that identifies the resume/application-choice interstitial specifically. Used as
// supporting evidence so we don't treat an arbitrary modal (cookie/consent) as one.
const INTERSTITIAL_TEXT_RX = /\b(resume|résumé|\bcv\b|be sure to include|updated resume|choose (a|your) resume|select (a|your) resume|continue applying|review your application)\b/i;
// A FINAL submit must NEVER be treated as an interstitial advance — the executor owns the
// gated submit path. If the only forward control is a submit, this is not an interstitial.
const FINAL_SUBMIT_RX = /^(submit( application)?|send( application)?|soumettre|envoyer)\b/i;

function labelMatchesAdvance(label) {
  const t = String(label || '').trim();
  if (!t) return false;
  if (FINAL_SUBMIT_RX.test(t)) return false;
  return ADVANCE_LABEL_RX.test(t) || ADVANCE_LABEL_FR_RX.test(t);
}

// Decide whether the described modal is a LinkedIn Easy-Apply interstitial we should
// advance through, and how.
//
// `info` shape (all optional, built by the executor from the live dialog):
//   {
//     onLinkedIn:   boolean,                 // host is *.linkedin.com
//     present:      boolean,                 // a candidate apply dialog is open
//     hasAnswerableFields: boolean,          // text/select/combobox/file inputs present
//     dialogText:   string,                  // visible text of the dialog
//     buttons:      [{ label, index }],      // visible forward-ish controls in the dialog
//     resumeChoices:[{ label, index, recent }] // resume radio/list options, if any
//   }
//
// Returns:
//   { isInterstitial: false }  — not an interstitial; caller proceeds normally.
//   { isInterstitial: true, advanceIndex, pickResumeIndex } — act on it: optionally select
//     resume at pickResumeIndex first, then click the control at advanceIndex.
export function classifyInterstitial(info = {}) {
  const no = { isInterstitial: false };
  if (!info.onLinkedIn || !info.present) return no;
  // A real, field-bearing apply form is NOT an interstitial — the executor fills it.
  if (info.hasAnswerableFields) return no;

  const buttons = Array.isArray(info.buttons) ? info.buttons : [];
  const resumeChoices = Array.isArray(info.resumeChoices) ? info.resumeChoices : [];
  const text = String(info.dialogText || '');

  // Find a forward control that is NOT the final submit.
  const advance = buttons.find((b) => labelMatchesAdvance(b.label));
  if (!advance) return no;

  // Require supporting evidence that this is the resume/continue/review interstitial —
  // either resume-choice controls, interstitial-specific copy, or an explicit
  // continue/review/use-this-resume label. This avoids advancing an unrelated modal.
  const supported = resumeChoices.length > 0
    || INTERSTITIAL_TEXT_RX.test(text)
    || /^(continue|continue applying|review|use this resume|continuer|réviser|utiliser ce)/i.test(String(advance.label || '').trim());
  if (!supported) return no;

  // If a resume choice is offered, prefer the most-recent; otherwise the first.
  let pickResumeIndex = null;
  if (resumeChoices.length) {
    const recent = resumeChoices.find((r) => r.recent);
    pickResumeIndex = (recent || resumeChoices[0]).index;
  }

  return { isInterstitial: true, advanceIndex: advance.index, pickResumeIndex };
}

export { labelMatchesAdvance };
