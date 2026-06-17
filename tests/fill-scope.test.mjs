// T0 / BUG A2 — the executor must NEVER fill site chrome (LinkedIn's global search bar,
// header/nav typeaheads). isSiteChromeInput is the shared guard now enforced in
// scanFillable, scanUnknown, fill(), and fillCombobox. autofill.js is a browser ESM
// module but imports cleanly under node (browser globals are touched only at call time),
// so we import the predicate directly and exercise it with DUCK-TYPED fake elements.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isSiteChromeInput } from '../extension/content/autofill.js';

// Minimal fake element: implements just what isSiteChromeInput (and fieldLabel) touch.
// `chromeSel` is a list of selector substrings that this element's closest() should match
// (simulating a chrome ancestor); `label` drives fieldLabel via aria-label.
function fakeInput({ type = 'text', tagName = 'INPUT', role = null, label = '', chromeSel = [], id = '' } = {}) {
  const attrs = { role, 'aria-label': label };
  const el = {
    type,
    tagName,
    id,
    placeholder: '',
    name: '',
    getAttribute(name) { return attrs[name] ?? null; },
    getRootNode() { return { querySelector: () => null, getElementById: () => null }; },
    closest(sel) {
      if (!sel) return null;
      // label-related closest() calls (label, [role="group"]) → no match.
      // chrome selectors → return a truthy fake ancestor when any simulated chrome
      // substring is present in the queried selector string.
      for (const needle of chromeSel) {
        if (sel.includes(needle)) return { __chromeAncestor: needle };
      }
      return null;
    },
    // fieldLabel pokes these; keep them inert.
    previousElementSibling: null,
    parentElement: { querySelector: () => null },
  };
  return el;
}

test('A2: a search input (type="search") is site chrome', () => {
  assert.equal(isSiteChromeInput(fakeInput({ type: 'search' })), true);
});

test('A2: a role=combobox labeled "search" is site chrome', () => {
  assert.equal(isSiteChromeInput(fakeInput({ type: 'text', role: 'combobox', label: 'Search' })), true);
});

test('A2: a label of "search search" (doubled) is site chrome', () => {
  assert.equal(isSiteChromeInput(fakeInput({ label: 'search search' })), true);
});

test('A2: an input inside a nav / global-nav ancestor is site chrome', () => {
  assert.equal(isSiteChromeInput(fakeInput({ chromeSel: ['nav'] })), true);
  assert.equal(isSiteChromeInput(fakeInput({ chromeSel: ['global-nav'] })), true);
  assert.equal(isSiteChromeInput(fakeInput({ chromeSel: ['search-global-typeahead'] })), true);
});

test('A2: a normal apply field (text, "Years of experience", no chrome ancestor) is NOT site chrome', () => {
  assert.equal(isSiteChromeInput(fakeInput({ type: 'text', label: 'Years of experience' })), false);
});

test('A2: a normal location combobox (not labeled search) is NOT site chrome', () => {
  assert.equal(isSiteChromeInput(fakeInput({ type: 'text', role: 'combobox', label: 'City' })), false);
});

test('A2: defensive — null / throwing input never throws, returns false', () => {
  assert.equal(isSiteChromeInput(null), false);
  const bad = { get type() { throw new Error('boom'); } };
  assert.equal(isSiteChromeInput(bad), false);
});
