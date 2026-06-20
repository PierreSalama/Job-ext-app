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
