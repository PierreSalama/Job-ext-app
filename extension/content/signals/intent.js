// JAT v11 — intent signals: pure-text click classifiers (EN + FR).
// v10 base, extended with French vocabulary and shadow-DOM-safe scanning.

import { qsa } from '../lib/dom.js';

const APPLY_RX = /\b(easy\s*apply|quick\s*apply|one\s*click\s*apply|apply\s*now|apply\s*for|apply\s*on\s+company\s+site|start\s+application|begin\s+application|continue\s+to\s+application|submit\s+resume|i'?m\s*interested|postuler(\s*maintenant)?|d[ée]poser\s+ma\s+candidature|^apply$)\b/i;
const SUBMIT_RX = /\b(submit(?:\s+your)?\s+application|send(?:\s+your)?\s+application|complete\s+application|finish\s+application|confirm\s+and\s+submit|envoyer\s+(ma\s+)?candidature|soumettre(\s+ma\s+candidature)?|^submit$|^send$|^envoyer$|^soumettre$)\b/i;
const STEP_RX = /\b(next(?:\s+step)?|continue(?:\s+application|(?:\s+to)?\s+next\s+step)?|review(?:\s+(?:your|application))?|proceed|save\s*(?:&|and)\s*continue|keep\s+going|suivant|continuer|poursuivre|v[ée]rifier)\b/i;
const APPLY_CLASS_RX = /jobs?-apply|apply-button|cta-apply|btn-apply|easy-apply|apply-now|application-cta|careers?-apply/i;
const SUBMIT_CLASS_RX = /easy-apply-footer__submit|submit-application|application-submit|final-submit|btn-submit/i;
const SIGNAL_ATTRS = ['aria-label', 'title', 'value', 'id', 'name', 'data-test', 'data-testid', 'data-control-name', 'data-automation-id', 'href'];

// Things that look like apply verbs but are account actions — hard negatives.
const ACCOUNT_RX = /\b(create\s+(an\s+)?account|sign\s*up|register|join\s+now|log\s*in|sign\s*in|subscribe|s'inscrire|se\s+connecter|cr[ée]er\s+un\s+compte)\b/i;

function targetText(el) {
  if (!el) return '';
  const parts = [];
  const t = (el.textContent || '').trim();
  if (t) parts.push(t.slice(0, 200));
  for (const attr of SIGNAL_ATTRS) {
    const v = el.getAttribute?.(attr);
    if (v) parts.push(v);
  }
  const cls = (el.className || '').toString();
  if (cls) parts.push(cls);
  return parts.join(' ');
}

export function isApplyClick(el) {
  if (!el) return false;
  const txt = targetText(el);
  if (ACCOUNT_RX.test(txt) && !APPLY_RX.test(txt)) return false;
  if (APPLY_RX.test(txt)) return true;
  if (APPLY_CLASS_RX.test((el.className || '').toString())) return true;
  return false;
}

export function isSubmitClick(el) {
  if (!el) return false;
  const txt = targetText(el);
  if (ACCOUNT_RX.test(txt) && !SUBMIT_RX.test(txt)) return false;
  if (SUBMIT_RX.test(txt)) return true;
  if (SUBMIT_CLASS_RX.test((el.className || '').toString())) return true;
  return false;
}

export function isStepAdvanceClick(el) {
  if (!el) return false;
  const txt = targetText(el);
  if (ACCOUNT_RX.test(txt)) return false;
  return STEP_RX.test(txt);
}

export function hasApplyAction(root = document) {
  const actions = qsa('button, a[href], [role="button"], input[type="button"], input[type="submit"]', root);
  let scanned = 0;
  for (const el of actions) {
    if (scanned++ > 250) break;
    if (isApplyClick(el)) return true;
  }
  return false;
}
