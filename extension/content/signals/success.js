// JAT v11 — submission-success signals (EN + FR + structural).
// v10's English-only string matching missed non-English ATSes; v11 adds
// French and a structural detector (apply form vanished + confirmation
// container appeared) that detector.js drives with its own state.

const SUCCESS_TEXT_RX = /(your\s*application\s*(was|has\s*been)\s*(sent|submitted|received)|application\s*(sent|submitted|received|complete|successful)|(have|'ve|has\s*been)\s*submitted\s*your\s*application|submitted\s*your\s*application|successfully\s*(submitted|applied|completed)|thank\s*you\s*for\s*(your\s*)?(applying|interest|application|consideration|submission)|thanks?\s*for\s*(your\s*)?(application|interest|applying|submission)|you['\s]?re\s*all\s*set|we['\s]?ve\s*received\s*your\s*application|we\s*have\s*received\s*your\s*application|your\s*application\s*(is\s*on\s*its\s*way|has\s*been\s*received)|application\s*(confirmation|complete)|candidature\s*(envoy[ée]e|soumise|re[çc]ue|transmise)|votre\s*candidature\s*a\s*(bien\s*)?[ée]t[ée]\s*(envoy[ée]e|soumise|re[çc]ue)|merci\s*(d['e]\s*)?(avoir\s*postul[ée]|pour\s*votre\s*candidature))/i;

const SUCCESS_URL_RX = /\/(confirmation|thank[-_]?you|merci|applied|success|submitted|post[-_]?apply|apply[-_]?complete|application[-_]?(complete|received|sent|success))(\/|\?|$|#)/i;

export function pageTextLooksLikeSuccess(maxLen = 5000) {
  const text = (document.body?.textContent || '').slice(0, maxLen);
  return SUCCESS_TEXT_RX.test(text);
}

export function urlLooksLikeSuccess(href = location.href) {
  return SUCCESS_URL_RX.test(href);
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

export { SUCCESS_TEXT_RX, SUCCESS_URL_RX };
