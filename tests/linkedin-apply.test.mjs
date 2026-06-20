// JAT v11 — NEW full-page Easy Apply recognition + the search-page filter-pill exclusion.
//
// LinkedIn migrated Easy Apply from a pop-up modal to a FULL-PAGE flow on the
// /jobs/view/<id>/apply/ route (no <form>, no [role=dialog], obfuscated class names, a Next/
// Review/Submit button). These tests pin the PURE detection pieces that recognise + drive it,
// and the FIX 3 guard that stops the "Easy Apply filter." search pill from being picked as an
// opener. All pure — no browser needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLinkedInEasyApplyApplyUrl,
  isLinkedInApplyAdvanceLabel,
  deriveApplyRootFromAdvanceButton,
  shouldUseGenericOpenFallback,
  detectLinkedInExternalPosting,
} from '../extension/content/lib/linkedin-apply.js';

// ---- isLinkedInEasyApplyApplyUrl: the /apply/ route guard (LIVE-VALIDATED) ----
test('isLinkedInEasyApplyApplyUrl: TRUE for the /jobs/view/<id>/apply route', () => {
  assert.equal(isLinkedInEasyApplyApplyUrl('/jobs/view/123/apply'), true);
  assert.equal(isLinkedInEasyApplyApplyUrl('/jobs/view/4012345678/apply/'), true);
  assert.equal(isLinkedInEasyApplyApplyUrl('/jobs/collections/789/apply'), true);
  assert.equal(isLinkedInEasyApplyApplyUrl('/jobs/view/123/apply?refId=abc'), true);
});

test('isLinkedInEasyApplyApplyUrl: FALSE for the plain job-view page (no /apply/)', () => {
  assert.equal(isLinkedInEasyApplyApplyUrl('/jobs/view/123'), false);
  assert.equal(isLinkedInEasyApplyApplyUrl('/jobs/view/123/'), false);
  assert.equal(isLinkedInEasyApplyApplyUrl('/jobs/collections/recommended'), false);
  assert.equal(isLinkedInEasyApplyApplyUrl('/feed/'), false);
  assert.equal(isLinkedInEasyApplyApplyUrl(''), false);
  assert.equal(isLinkedInEasyApplyApplyUrl(undefined), false);
});

// ---- isLinkedInApplyAdvanceLabel: the visible advance/submit CTA ----
test('isLinkedInApplyAdvanceLabel: matches Next/Review/Submit application/Continue exactly', () => {
  for (const t of ['Next', 'next', 'Review', 'Review your application', 'Submit application', 'Submit', 'Continue']) {
    assert.equal(isLinkedInApplyAdvanceLabel(t), true, `expected advance: "${t}"`);
  }
});

test('isLinkedInApplyAdvanceLabel: does NOT match the opener or unrelated buttons', () => {
  for (const t of ['Easy Apply', 'Easy Apply to this job', 'Apply', 'Save', 'Dismiss', 'Follow', '', 'x'.repeat(60)]) {
    assert.equal(isLinkedInApplyAdvanceLabel(t), false, `expected NOT advance: "${t.slice(0, 20)}"`);
  }
});

// ---- deriveApplyRootFromAdvanceButton: walk UP to the field-bearing, nav-free ancestor ----
// Build a tiny synthetic ancestor chain: button → footer → formRoot → page(body, has nav).
// Only `formRoot` bears fields AND has no nav, so it is the chosen root.
function chain() {
  const page = { name: 'page', parent: null, fields: 3, nav: true };
  const formRoot = { name: 'formRoot', parent: page, fields: 3, nav: false };
  const footer = { name: 'footer', parent: formRoot, fields: 0, nav: false };
  const button = { name: 'button', parent: footer, fields: 0, nav: false };
  const helpers = {
    parentOf: (el) => el.parent,
    countFields: (el) => el.fields,
    hasNav: (el) => el.nav,
  };
  return { page, formRoot, footer, button, helpers };
}

test('deriveApplyRootFromAdvanceButton: picks the field-bearing ancestor, EXCLUDING the nav-bearing page root', () => {
  const { button, formRoot, helpers } = chain();
  const root = deriveApplyRootFromAdvanceButton(button, helpers);
  assert.equal(root, formRoot);
});

test('deriveApplyRootFromAdvanceButton: a button that itself bears fields is its own root (when nav-free)', () => {
  const self = { name: 'self', parent: { name: 'p', parent: null, fields: 0, nav: false }, fields: 2, nav: false };
  const root = deriveApplyRootFromAdvanceButton(self, {
    parentOf: (el) => el.parent, countFields: (el) => el.fields, hasNav: (el) => el.nav,
  });
  assert.equal(root, self);
});

test('deriveApplyRootFromAdvanceButton: returns null when no ancestor bears fields', () => {
  const top = { name: 'top', parent: null, fields: 0, nav: false };
  const btn = { name: 'btn', parent: top, fields: 0, nav: false };
  const root = deriveApplyRootFromAdvanceButton(btn, {
    parentOf: (el) => el.parent, countFields: (el) => el.fields, hasNav: (el) => el.nav,
  });
  assert.equal(root, null);
});

test('deriveApplyRootFromAdvanceButton: missing args never throw (defensive null)', () => {
  assert.equal(deriveApplyRootFromAdvanceButton(), null);
  assert.equal(deriveApplyRootFromAdvanceButton(null, {}), null);
  assert.equal(deriveApplyRootFromAdvanceButton({}, { parentOf: () => null }), null);   // no countFields
});

// ---- FIX 1: the generic open/advance fallback must NOT run on a LinkedIn job-view page
//      that has no Easy-Apply opener (that's where the stray "Next" gets clicked) ----
test('shouldUseGenericOpenFallback: BLOCKED on a LinkedIn job page with no Easy Apply (the stray-Next bug)', () => {
  // Bosch case: linkedin.com/jobs/view/<id>, no /apply/ route, no form, no Easy-Apply opener.
  assert.equal(shouldUseGenericOpenFallback({
    onLinkedIn: true, onApplyRoute: false, hasEasyApplyOpener: false, haveForm: false,
  }), false);
});

test('shouldUseGenericOpenFallback: ALLOWED on a genuine non-LinkedIn ATS page', () => {
  // A real external ATS (greenhouse/lever/company site) still needs the generic open fallback.
  assert.equal(shouldUseGenericOpenFallback({
    onLinkedIn: false, onApplyRoute: false, hasEasyApplyOpener: false, haveForm: false,
  }), true);
});

test('shouldUseGenericOpenFallback: ALLOWED on the LinkedIn /apply/ full-page route', () => {
  // The full-page flow drives via the advance scan — must keep working (preserve v11.27.0).
  assert.equal(shouldUseGenericOpenFallback({
    onLinkedIn: true, onApplyRoute: true, hasEasyApplyOpener: false, haveForm: false,
  }), true);
});

test('shouldUseGenericOpenFallback: ALLOWED on LinkedIn when a real Easy-Apply opener exists', () => {
  assert.equal(shouldUseGenericOpenFallback({
    onLinkedIn: true, onApplyRoute: false, hasEasyApplyOpener: true, haveForm: false,
  }), true);
});

test('shouldUseGenericOpenFallback: ALLOWED on LinkedIn once a real apply form is already open', () => {
  assert.equal(shouldUseGenericOpenFallback({
    onLinkedIn: true, onApplyRoute: false, hasEasyApplyOpener: false, haveForm: true,
  }), true);
});

test('shouldUseGenericOpenFallback: defensive defaults (no args) → blocked is impossible only off-LinkedIn', () => {
  // No args = onLinkedIn:false → fallback allowed (safe generic default).
  assert.equal(shouldUseGenericOpenFallback(), true);
  assert.equal(shouldUseGenericOpenFallback({}), true);
});

// ---- FIX 1: detectLinkedInExternalPosting — the FAST-SKIP decision (CONFIRMED ROOT CAUSE) ----
// With easyApplyOnly ON, JobSpy floods the queue with NON-Easy-Apply LinkedIn postings and the
// executor used to burn the ~20s hydration cap skipping each. This pure predicate lets it bail
// in ~0s ONLY on a POSITIVE external signal — and NEVER on the mere absence of an Easy-Apply
// opener (so a slow-hydrating REAL Easy Apply is never mis-skipped).
test('detectLinkedInExternalPosting: EXTERNAL on an off-site "Apply ↗" anchor (the eBay case)', () => {
  const v = detectLinkedInExternalPosting({ onLinkedIn: true, onApplyRoute: false, hasEasyApplyOpener: false, haveForm: false, offsiteApplyAnchor: true });
  assert.equal(v.external, true);
  assert.equal(v.signal, 'offsite-apply-anchor');
});

test('detectLinkedInExternalPosting: EXTERNAL on an explicit "Apply on company website" label', () => {
  const v = detectLinkedInExternalPosting({ onLinkedIn: true, externalApplyLabel: true });
  assert.equal(v.external, true);
  assert.equal(v.signal, 'external-apply-label');
});

test('detectLinkedInExternalPosting: EXTERNAL on the "Responses managed off LinkedIn" marker', () => {
  const v = detectLinkedInExternalPosting({ onLinkedIn: true, managedOffLinkedIn: true });
  assert.equal(v.external, true);
  assert.equal(v.signal, 'responses-managed-off-linkedin');
});

test('detectLinkedInExternalPosting: NEVER external with NO positive signal (slow-hydrating Easy Apply is safe)', () => {
  // The mere absence of an Easy-Apply opener is NOT external — a real Easy Apply may be
  // mid-hydration on a throttled tab. This is the exact mis-skip we must avoid.
  const v = detectLinkedInExternalPosting({ onLinkedIn: true, onApplyRoute: false, hasEasyApplyOpener: false, haveForm: false });
  assert.equal(v.external, false);
  assert.equal(v.signal, null);
});

test('detectLinkedInExternalPosting: NEVER external when a real Easy-Apply opener exists (even with stray external signals)', () => {
  const v = detectLinkedInExternalPosting({ onLinkedIn: true, hasEasyApplyOpener: true, offsiteApplyAnchor: true, managedOffLinkedIn: true });
  assert.equal(v.external, false);
});

test('detectLinkedInExternalPosting: NEVER external on the /apply/ route (already inside the Easy-Apply flow)', () => {
  const v = detectLinkedInExternalPosting({ onLinkedIn: true, onApplyRoute: true, offsiteApplyAnchor: true });
  assert.equal(v.external, false);
});

test('detectLinkedInExternalPosting: NEVER external once a form is already recognised', () => {
  const v = detectLinkedInExternalPosting({ onLinkedIn: true, haveForm: true, offsiteApplyAnchor: true });
  assert.equal(v.external, false);
});

test('detectLinkedInExternalPosting: NEVER external off LinkedIn (real ATS pages own their own flow)', () => {
  const v = detectLinkedInExternalPosting({ onLinkedIn: false, offsiteApplyAnchor: true, managedOffLinkedIn: true });
  assert.equal(v.external, false);
});

test('detectLinkedInExternalPosting: defensive — no args never throws and is not external', () => {
  assert.deepEqual(detectLinkedInExternalPosting(), { external: false, signal: null });
  assert.deepEqual(detectLinkedInExternalPosting({}), { external: false, signal: null });
});

// ---- FIX 3: the "Easy Apply filter." search pill must NOT be classified as an opener ----
test('classifyApplyControl excludes the "Easy Apply filter." search pill', async () => {
  globalThis.location = { href: 'https://www.linkedin.com/jobs/search/?keywords=engineer' };
  const route = await import('../extension/content/route.js');
  const filterPill = {
    textContent: 'Easy Apply', value: '', href: '',
    getAttribute(name) { return name === 'aria-label' ? 'Easy Apply filter.' : ''; },
    closest() { return null; },
  };
  const r = route.classifyApplyControl(filterPill);
  assert.notEqual(r.state, 'linkedin_easy_apply_modal');
  assert.equal(r.state, 'unknown');
  assert.equal(r.evidence, 'filter-control-excluded');
});

test('classifyApplyControl excludes a control inside the search filter bar even without a filter label', async () => {
  const route = await import('../extension/content/route.js');
  const inBar = {
    textContent: 'Easy Apply', value: '', href: '',
    getAttribute(name) { return name === 'aria-label' ? 'Easy Apply' : ''; },
    closest(sel) { return /search-reusables__filters-bar/.test(sel) ? {} : null; },
  };
  const r = route.classifyApplyControl(inBar);
  assert.equal(r.state, 'unknown');
  assert.equal(r.evidence, 'filter-control-excluded');
});

test('classifyApplyControl STILL recognises the real top-card Easy Apply opener', async () => {
  const route = await import('../extension/content/route.js');
  const opener = {
    textContent: 'Easy Apply', value: '', href: '',
    getAttribute(name) { return name === 'aria-label' ? 'Easy Apply to this job' : ''; },
    closest() { return null; },   // not in a filter bar
  };
  const r = route.classifyApplyControl(opener);
  assert.equal(r.state, 'linkedin_easy_apply_modal');
});
