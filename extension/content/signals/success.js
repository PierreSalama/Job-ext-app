// JAT v10 — submission-success signals.
// Three independent detectors, any one of which → "this application was just
// submitted". Combined in detector.js to avoid double-firing for the same job.

const SUCCESS_TEXT_RX = /(your\s*application\s*(was|has\s*been)\s*(sent|submitted)|application\s*(sent|submitted|received)|thank\s*you\s*for\s*applying|we['\s]?ve\s*received\s*your\s*application|application\s*complete)/i;
const SUCCESS_URL_RX  = /\/(confirmation|thank[-_]?you|applied|success|submitted|application[-_]?complete)(\/|\?|$)/i;

export function pageTextLooksLikeSuccess(maxLen = 4000) {
  const text = (document.body?.textContent || '').slice(0, maxLen);
  return SUCCESS_TEXT_RX.test(text);
}

export function urlLooksLikeSuccess(href = location.href) {
  return SUCCESS_URL_RX.test(href);
}

// For newly-injected nodes (mutation records). Cheap test — only inspects
// the node's own text, capped at 600 chars.
export function nodeLooksLikeSuccess(node) {
  if (!(node instanceof Element)) return false;
  // Common containers that ATSes use for the success state
  if (node.id === 'post-apply-modal') return true;
  if (node.matches?.('[id^="post-apply"], [class*="post-apply"], [class*="application-success"], [class*="thank-you"], [class*="confirmation"]')) return true;
  const t = (node.textContent || '').slice(0, 600);
  return t.length < 600 && SUCCESS_TEXT_RX.test(t);
}
