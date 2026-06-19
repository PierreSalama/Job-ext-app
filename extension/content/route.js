const EASY_RX = /\beasy apply\b|candidature simplifi[ée]e?/i;
const EXTERNAL_RX = /apply on (?:the )?(?:company|employer)|company (?:site|website)|employer (?:site|website)|apply externally|postuler sur le site|site de l['’](?:employeur|entreprise)/i;
const APPLY_INTENT_RX = /\bapply\b|postuler|candidature/i;

function value(el, name) {
  try { return el?.getAttribute?.(name) || ''; } catch { return ''; }
}

function labelOf(el) {
  return String(value(el, 'aria-label') || el?.textContent || el?.value || '').replace(/\s+/g, ' ').trim();
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

export function classifyApplyControl(el, { currentUrl = location.href } = {}) {
  if (!el) return { state: 'unknown', evidence: 'missing-control' };
  const label = labelOf(el);
  const href = el.href || value(el, 'href');
  const currentHost = hostOf(currentUrl);
  const targetHost = href ? hostOf(new URL(href, currentUrl).href) : '';
  const offOrigin = !!targetHost && targetHost !== currentHost;
  if (EASY_RX.test(label)) return { state: 'linkedin_easy_apply_modal', evidence: 'easy-apply-label', label, href: href || null };
  if ((offOrigin && APPLY_INTENT_RX.test(label)) || EXTERNAL_RX.test(label)) {
    return {
      state: value(el, 'target') === '_blank' ? 'external_new_tab' : 'external_same_tab',
      evidence: offOrigin ? 'off-origin-href' : 'explicit-external-label', label, href: href || null,
    };
  }
  return { state: 'unknown', evidence: 'no-external-evidence', label, href: href || null };
}

export function observeRoute({ beforeUrl, afterUrl, childCaptured = false, dialogOpen = false } = {}) {
  if (dialogOpen) return { state: 'linkedin_easy_apply_modal', evidence: 'apply-dialog-observed' };
  if (childCaptured) return { state: 'external_new_tab', evidence: 'child-tab-observed' };
  const beforeHost = hostOf(beforeUrl);
  const afterHost = hostOf(afterUrl);
  if (beforeHost && afterHost && beforeHost !== afterHost) return { state: 'external_same_tab', evidence: 'off-origin-navigation-observed' };
  if (beforeUrl && afterUrl && beforeUrl !== afterUrl) return { state: 'same_tab_application', evidence: 'same-origin-navigation-observed' };
  return { state: 'unknown', evidence: 'no-route-transition' };
}

export function applyRouteForState(state) {
  if (state === 'linkedin_easy_apply_modal' || state === 'same_tab_application') return 'easy-apply';
  if (state === 'external_new_tab' || state === 'external_same_tab') return 'external';
  return 'unknown';
}

export { labelOf };
