// FIX 3 (open-source research lever): Levenshtein snap-to-real-option.
// matchOption() (selects) and pickRadioInGroup() (radios) gain a FINAL conservative fuzzy
// tier AFTER exact → numeric-range → substring miss: a normalized-Levenshtein similarity
// helper (no dependency) snaps a paraphrased answer to the closest valid option, but ONLY
// above FUZZY_SNAP_MIN (0.72) — so garbage still PARKS (returns null), never mis-selected.
// autofill.js is a browser ESM module but imports cleanly under node (browser globals are
// only touched at call time), so we import the pure pieces + drive them with duck-typed
// fakes (the same approach as fill-scope.test.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fuzzySimilarity, bestFuzzyIndex, FUZZY_SNAP_MIN, matchOption, pickRadioInGroup,
} from '../extension/content/autofill.js';

// ---- the pure similarity helper ----------------------------------------------------
test('fuzzySimilarity: identical (after normalization) → 1', () => {
  assert.equal(fuzzySimilarity('5 To 7 Years', '5 to 7 years'), 1);   // case-only diff → exact
  assert.equal(fuzzySimilarity('Permanent Resident', 'permanent  resident'), 1);
});

test('fuzzySimilarity: close paraphrases score high (well above the 0.72 snap floor)', () => {
  assert.ok(fuzzySimilarity('Bachelor\'s Degree', 'bachelors degree') >= FUZZY_SNAP_MIN);
  assert.ok(fuzzySimilarity('5 to 7 years', '5-7 yrs') >= FUZZY_SNAP_MIN);
});

test('fuzzySimilarity: empty inputs → 0 (never a blind match)', () => {
  assert.equal(fuzzySimilarity('', 'anything'), 0);
  assert.equal(fuzzySimilarity('anything', ''), 0);
});

test('fuzzySimilarity: unrelated strings score low (well under the threshold)', () => {
  assert.ok(fuzzySimilarity('purple monkey dishwasher', 'Bachelor\'s Degree') < FUZZY_SNAP_MIN);
});

test('bestFuzzyIndex: returns the closest index only above the threshold, else null', () => {
  const labels = ['Bachelor\'s Degree', 'Master\'s Degree', 'High School Diploma'];
  assert.equal(bestFuzzyIndex(labels, 'Bachelors'), 0);       // snaps to Bachelor's
  assert.equal(bestFuzzyIndex(labels, 'Masters degre'), 1);   // snaps to Master's (typo)
  assert.equal(bestFuzzyIndex(labels, 'zzzzzzzzzz'), null);   // nothing clears 0.72 → park
});

test('the snap threshold is conservative (0.72)', () => {
  assert.equal(FUZZY_SNAP_MIN, 0.72);
});

// ---- matchOption (selects) ---------------------------------------------------------
function fakeSelect(optionTexts) {
  return {
    options: optionTexts.map((t) => ({ value: t, text: t })),
  };
}

test('matchOption: paraphrase snaps to the real option ("Bachelors" → "Bachelor\'s Degree")', () => {
  const sel = fakeSelect(['Select…', 'Bachelor\'s Degree', 'Master\'s Degree', 'High School Diploma']);
  const opt = matchOption(sel, 'Bachelors');
  assert.ok(opt);
  assert.equal(opt.text, 'Bachelor\'s Degree');
});

test('matchOption: paraphrased range snaps ("5-7 yrs" → "5 to 7 years")', () => {
  const sel = fakeSelect(['Select…', '0 to 2 years', '3 to 4 years', '5 to 7 years', '8+ years']);
  const opt = matchOption(sel, '5-7 yrs');
  assert.ok(opt);
  assert.equal(opt.text, '5 to 7 years');
});

test('matchOption: exact/substring tiers still win (no regression)', () => {
  const sel = fakeSelect(['Select…', 'Yes', 'No']);
  assert.equal(matchOption(sel, 'Yes').text, 'Yes');                 // exact
  const sel2 = fakeSelect(['Select…', '5+ years', '5-10 years', '3-5 years']);
  assert.equal(matchOption(sel2, '6').text, '5-10 years');           // numeric-range
});

test('matchOption: garbage PARKS (returns null) — never mis-selects below 0.72', () => {
  const sel = fakeSelect(['Select…', 'Bachelor\'s Degree', 'Master\'s Degree']);
  assert.equal(matchOption(sel, 'asparagus festival'), null);
});

test('matchOption: the fuzzy tier never snaps onto the placeholder option', () => {
  // "Choose one" is the closest label to the answer by edit distance, but it's a placeholder —
  // the fuzzy tier must skip it and (here, nothing else clears 0.72) PARK rather than pick the
  // empty default. (Guards the fuzzy tier specifically; substring tiers are unaffected.)
  const sel = fakeSelect(['Choose one', 'Citizen', 'Permanent Resident']);
  const opt = matchOption(sel, 'Choose onf');   // 1 char off the placeholder, not a substring
  assert.notEqual(opt && opt.text, 'Choose one');
});

// ---- pickRadioInGroup (radios) -----------------------------------------------------
// A radio whose group is just itself (no name) — fieldLabel falls back to aria-label.
function fakeRadio(label) {
  const attrs = { 'aria-label': label, role: 'radio' };
  return {
    type: 'radio',
    tagName: 'INPUT',
    name: '',           // no name → pickRadioInGroup treats [input] as the whole group
    value: '',
    placeholder: '',
    id: '',
    checked: false,
    getAttribute(n) { return attrs[n] ?? null; },
    getRootNode() { return { querySelector: () => null, getElementById: () => null }; },
    closest() { return null; },
    previousElementSibling: null,
    parentElement: { querySelector: () => null },
  };
}

test('pickRadioInGroup: paraphrase snaps to the matching radio ("Yes" → "Yes, I am authorized…")', () => {
  const r = fakeRadio('Yes, I am authorized to work in this country');
  // "Yes" is a substring of the label → existing substring tier already matches.
  assert.equal(pickRadioInGroup(r, 'Yes'), r);
});

test('pickRadioInGroup: fuzzy snap on a paraphrase that is NOT a clean substring', () => {
  const r = fakeRadio('Permanent Resident');
  assert.equal(pickRadioInGroup(r, 'Permanant Residant'), r);   // two typos, > 0.72
});

test('pickRadioInGroup: garbage PARKS (returns null) — never mis-selects below 0.72', () => {
  const r = fakeRadio('Permanent Resident');
  assert.equal(pickRadioInGroup(r, 'flying spaghetti monster'), null);
});
