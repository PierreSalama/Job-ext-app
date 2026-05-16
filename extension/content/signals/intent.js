// JAT v10 — intent signals.
// Pure-text click classifiers. Generic to every site: we look at the button's
// text content, aria-label, value, and class names for the universal apply /
// submit / step-advance vocabulary.

const APPLY_RX  = /\b(easy\s*apply|apply\s*now|apply\s*for|^apply$|i'?m\s*interested)\b/i;
const SUBMIT_RX = /\b(submit\s*application|send\s*application|^submit$|^send$)\b/i;
const STEP_RX   = /\b(next|continue|review|proceed|save\s*and\s*continue)\b/i;

function targetText(el) {
  if (!el) return '';
  const t = (el.textContent || '').trim();
  const a = el.getAttribute?.('aria-label') || '';
  const v = el.value || '';
  const cls = (el.className || '').toString();
  return `${t} ${a} ${v} ${cls}`;
}

export function isApplyClick(el) {
  if (!el) return false;
  const txt = targetText(el);
  if (APPLY_RX.test(txt)) return true;
  // Class hint many ATSes share: 'jobs-apply-button', 'apply-button', 'cta-apply'
  if (/jobs?-apply|apply-button|cta-apply|btn-apply/i.test(el.className || '')) return true;
  return false;
}

export function isSubmitClick(el) {
  if (!el) return false;
  const txt = targetText(el);
  if (SUBMIT_RX.test(txt)) return true;
  if (/easy-apply-footer__submit|submit-application/i.test(el.className || '')) return true;
  return false;
}

export function isStepAdvanceClick(el) {
  return !!el && STEP_RX.test(targetText(el));
}
