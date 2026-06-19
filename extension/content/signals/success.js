// JAT v11 — submission-success signals (EN + FR + structural).
// v10's English-only string matching missed non-English ATSes; v11 adds
// French and a structural detector (apply form vanished + confirmation
// container appeared) that detector.js drives with its own state.

const SUCCESS_TEXT_RX = /(your\s*application\s*(was|has\s*been)\s*(sent|submitted|received)|application\s*(sent|submitted|received|complete|successful)|(have|'ve|has\s*been)\s*submitted\s*your\s*application|submitted\s*your\s*application|successfully\s*(submitted|applied|completed)|thank\s*you\s*for\s*(your\s*)?(applying|interest|application|consideration|submission)|thanks?\s*for\s*(your\s*)?(application|interest|applying|submission)|you['\s]?re\s*all\s*set|we['\s]?ve\s*received\s*your\s*application|we\s*have\s*received\s*your\s*application|your\s*application\s*(is\s*on\s*its\s*way|has\s*been\s*received)|application\s*(confirmation|complete)|candidature\s*(envoy[ée]e|soumise|re[çc]ue|transmise)|votre\s*candidature\s*a\s*(bien\s*)?[ée]t[ée]\s*(envoy[ée]e|soumise|re[çc]ue)|merci\s*(d['e]\s*)?(avoir\s*postul[ée]|pour\s*votre\s*candidature))/i;

const SUCCESS_URL_RX = /\/(confirmation|thank[-_]?you|merci|applied|success|submitted|post[-_]?apply|apply[-_]?complete|application[-_]?(complete|received|sent|success))(\/|\?|$|#)/i;
const NON_SUCCESS_URL_RX = /\/(login|log-in|signin|sign-in|auth|register|create-account)(\/|\?|$|#)|[?&](?:stepname|step)=?(?:login|signin|auth)\b/i;

export function pageTextLooksLikeSuccess(maxLen = 5000) {
  const text = (document.body?.textContent || '').slice(0, maxLen);
  return SUCCESS_TEXT_RX.test(text);
}

export function urlLooksLikeSuccess(href = location.href) {
  return !NON_SUCCESS_URL_RX.test(href) && SUCCESS_URL_RX.test(href);
}

// ============================================================
// SUCCESS-TRUTH: the pure, node-testable submit-evidence evaluator.
// ============================================================
// A submit is only VERIFIED when a post-click CHANGE proves it — never from
// pre-existing static page text. The executor captures a baseline IMMEDIATELY
// before the final-submit click (apply-dialog/body text, URL, form signature)
// and again AFTER the click+settle, then feeds both snapshots here. This fn owns
// the decision so it can be exercised against the known false positives
// (Activision, Canada Job Bank) without a browser.
//
// Inputs (all plain data — no DOM):
//   before        : { text, url, successText:boolean }  baseline pre-click
//   after         : { text, url, successText:boolean }  post-click + settle
//   formGrounded  : boolean   a REAL application form was opened+filled this run
//   msElapsed     : number    ms from click to the verifying observation
//   urlBefore     : string    (optional; falls back to before.url)
//   urlAfter      : string    (optional; falls back to after.url)
//   newNodes      : Array<{ text, confirmation }>  containers that APPEARED post-click
//   networkPost   : boolean   (optional, best-effort) a correlated application POST/XHR
//
// Returns { verified:boolean, reason:string }.
//
// The minimum plausible time for a genuine server round-trip + confirmation
// render. A "confirmation" that appears faster than this WITHOUT any network or
// DOM-structure change is the Activision pattern (static text + a fast click) —
// reject it.
const MIN_CONFIRM_MS = 400;

function hasNewSuccessNode(newNodes) {
  if (!Array.isArray(newNodes)) return false;
  return newNodes.some((n) => {
    if (!n) return false;
    if (n.confirmation === true) return true;
    const t = String(n.text || '');
    return t.length > 0 && t.length < 800 && SUCCESS_TEXT_RX.test(t);
  });
}

export function evaluateSubmitEvidence({
  before = {},
  after = {},
  formGrounded = false,
  msElapsed = 0,
  urlBefore,
  urlAfter,
  newNodes = [],
  networkPost = false,
} = {}) {
  // (2) GROUNDED-FORM REQUIREMENT — a generic page-level Submit on a careers /
  // search / newsletter / problem-report page can never be a verified submit.
  // This alone rejects Canada Job Bank (no application form ever opened/filled).
  if (!formGrounded) return { verified: false, reason: 'no-grounded-form' };

  const uBefore = urlBefore != null ? urlBefore : before.url;
  const uAfter = urlAfter != null ? urlAfter : after.url;

  // (1) URL → confirmation page (not a login/search/error URL). A real
  // navigation to a success URL is strong, independent proof.
  if (uAfter && uAfter !== uBefore && !NON_SUCCESS_URL_RX.test(uAfter) && SUCCESS_URL_RX.test(uAfter)) {
    return { verified: true, reason: 'url-confirmation' };
  }

  // A correlated application network POST/XHR observed around the submit is
  // independent proof the form actually transmitted (best-effort; optional).
  if (networkPost === true) return { verified: true, reason: 'network-post' };

  // (1) NEW confirmation that was NOT present in the baseline (diff, not absolute
  // match). Pre-existing static success-like text — i.e. the baseline ALREADY
  // matched — must NOT count. This is the Activision rejection: identical
  // before/after success text, no new node.
  const newNode = hasNewSuccessNode(newNodes);
  const textBecameSuccess = !before.successText && after.successText === true;
  if (newNode || textBecameSuccess) {
    // Implausibly fast with no network and no NEW structural node → not real.
    if (msElapsed < MIN_CONFIRM_MS && !networkPost && !newNode) {
      return { verified: false, reason: 'confirmation-too-fast' };
    }
    return { verified: true, reason: newNode ? 'new-confirmation-node' : 'text-became-success' };
  }

  // Baseline already looked like success (static recruitment/"thank you" copy)
  // and nothing changed → the canonical false positive. Reject.
  if (before.successText) return { verified: false, reason: 'static-success-text-unchanged' };

  return { verified: false, reason: 'no-post-click-change' };
}

export function nodeLooksLikeSuccess(node) {
  if (!(node instanceof Element)) return false;
  if (node.id === 'post-apply-modal') return true;
  if (node.matches?.('[id^="post-apply"], [class*="post-apply"], [class*="application-success"], [class*="thank-you"], [class*="confirmation"], [role="alert"], [role="status"]')) {
    const t = (node.textContent || '').slice(0, 600);
    if (SUCCESS_TEXT_RX.test(t)) return true;
    // Containers with the right class but neutral text still count when small
    if (t.length < 200 && /confirm|success|thank|merci/i.test(node.className + ' ' + node.id)) return true;
  }
  const t = (node.textContent || '').slice(0, 600);
  return t.length < 600 && SUCCESS_TEXT_RX.test(t);
}

export { SUCCESS_TEXT_RX, SUCCESS_URL_RX, NON_SUCCESS_URL_RX, MIN_CONFIRM_MS };
