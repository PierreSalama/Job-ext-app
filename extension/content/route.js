const EASY_RX = /\beasy apply\b|candidature simplifi[ée]e?/i;
// Airtight Indeed host match: a leading boundary (^ or .) so "notindeed.com" is rejected, and a
// bounded TLD ([a-z]+ + ONE optional .label) so "indeed.com.evil.com" is rejected while
// indeed.com / ca.indeed.com / smartapply.indeed.com / indeed.co.uk are accepted. Used everywhere
// the Indeed-native classification reasons about a host (current + target) so they never disagree.
const INDEED_HOST_RX = /(^|\.)indeed\.[a-z]+(\.[a-z]+)?$/;
const EXTERNAL_RX = /apply on (?:the )?(?:company|employer)|company (?:site|website)|employer (?:site|website)|apply externally|postuler sur le site|site de l['’](?:employeur|entreprise)/i;
const APPLY_INTENT_RX = /\bapply\b|postuler|candidature/i;
// FIX 3: the LinkedIn SEARCH page renders an "Easy Apply filter." pill (aria-label
// "Easy Apply filter.") that matches EASY_RX but is a search FILTER, not an apply opener.
// Clicking it never opens an application. Exclude any control whose label says "filter" or
// that lives inside the search filter bar so the opener picker can never select it.
const FILTER_LABEL_RX = /\bfilters?\b|\bfiltre/i;
// Narrow to LinkedIn's actual search-filter containers — NOT a broad [class*="filter"] that
// could swallow a legitimate top-card apply opener. The label check ("Easy Apply filter.")
// is the precise primary signal; this is the structural backstop for unlabelled toggles.
const FILTER_BAR_SEL = '.search-reusables__filter-binary-toggle, .search-reusables__filters-bar, .search-reusables__secondary-filters, [class*="search-filters-bar"], [id*="searchFilter" i], [class*="jobs-search-box"]';

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
  // FIX 3: never classify a search FILTER pill as an Easy-Apply opener. A label containing
  // "filter" (e.g. "Easy Apply filter.") or a control inside the search filter bar is a
  // filter toggle, not an apply button — clicking it opens nothing.
  let inFilterBar = false;
  try { inFilterBar = !!el.closest?.(FILTER_BAR_SEL); } catch { inFilterBar = false; }
  if (FILTER_LABEL_RX.test(label) || inFilterBar) {
    return { state: 'unknown', evidence: 'filter-control-excluded', label, href: href || null };
  }
  // INDEED-NATIVE: Indeed's "Easily apply" / "Apply now" widget IS Indeed's easy-apply equivalent
  // — it opens the Indeed-HOSTED smartapply flow on smartapply.indeed.com (a DIFFERENT host, so the
  // generic off-origin test below would wrongly brand it "external company site" and easyApplyOnly
  // would skip it; the widget also has NO href, so it otherwise falls to 'unknown' and the handoff
  // is never armed → the task vanishes on nav, route=null). Recognize it as a distinct
  // `indeed_native` route the executor drives in-tab (allowed even in easy-apply-only mode). A
  // control that points at a NON-Indeed company host stays external via the checks below.
  if (INDEED_HOST_RX.test(currentHost) && !EXTERNAL_RX.test(label)) {
    // A control whose href points OFF Indeed is a genuine external company link → NOT indeed_native
    // (uses the SAME airtight host regex as the gate/target so a "…notindeed.com" host can't slip
    // through the off-Indeed guard and get misrouted as native — the review's MAJOR finding).
    const offIndeedHref = offOrigin && targetHost && !INDEED_HOST_RX.test(targetHost);
    let indeedWidget = false;
    try { indeedWidget = !!el.closest?.('[data-testid*="indeedapply" i], [id*="indeedapply" i], [class*="indeed-apply" i], [class*="indeedapply" i]'); } catch { indeedWidget = false; }
    const indeedTarget = !!targetHost && INDEED_HOST_RX.test(targetHost);
    const nativeLabel = /^\s*(easily\s+)?apply(\s+(now|on\s+indeed))?\s*$/i.test(label) || /candidature\s+simplifi/i.test(label);
    if (!offIndeedHref && (indeedWidget || indeedTarget || nativeLabel)) {
      return { state: 'indeed_native', evidence: indeedWidget ? 'indeed-apply-widget' : indeedTarget ? 'smartapply-target' : 'indeed-apply-label', label, href: href || null };
    }
  }
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
  // indeed_native is Indeed's hosted easy-apply (smartapply) — an in-page/in-tab drive, NOT an
  // external company-site handoff, so it counts as 'easy-apply' on the dashboard split.
  if (state === 'linkedin_easy_apply_modal' || state === 'same_tab_application' || state === 'indeed_native') return 'easy-apply';
  if (state === 'external_new_tab' || state === 'external_same_tab') return 'external';
  return 'unknown';
}

export { labelOf };
