// Indeed's searchable dropdown blocked 6 real applications across 6 employers on 2026-07-25,
// via THREE chained defects. Each is pinned here.
//
// 1. LABEL — the widget's only self-describing text is the placeholder "Search to select an
//    option". With every other label source empty it became the whole label, so the answer layer
//    saw a prompt with no question and refused (correctly): "The actual application question is
//    missing". The real question sits in an unwired block above the input.
// 2. ROUTING — it is a plain <input type=text>, not role="combobox", so fill() typed into it.
//    Typing leaves the widget unselected: the field LOOKS filled while the form refuses to advance.
// 3. VALUE — the options are RANGES ("1-3 years", "5-10 years") while the profile holds a plain
//    number ("6"). No amount of text matching connects those.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isGenericPlaceholder, looksLikeSearchableSelect, matchNumericRangeOption } from '../extension/content/autofill.js';

test('generic widget placeholders are not treated as questions', () => {
  for (const p of ['Search to select an option', 'Select an option', 'Select', 'Choose one',
    'Start typing', 'Please select', '-- Select --', 'Type to search', 'N/A'])
    assert.ok(isGenericPlaceholder(p), `${p} is widget chrome, not a question`);
});

test('a SPECIFIC placeholder is still useful and kept', () => {
  for (const p of ['e.g. 5 years', 'Toronto, ON', 'your.name@email.com', 'How many years?'])
    assert.equal(isGenericPlaceholder(p), false, `${p} carries real meaning`);
});

test('a searchable select is detected from a placeholder that implies CHOOSING', () => {
  const mk = (placeholder, type = 'text') => ({ tagName: 'INPUT', type, placeholder });
  assert.ok(looksLikeSearchableSelect(mk('Search to select an option')));
  assert.ok(looksLikeSearchableSelect(mk('Select an option')));
  assert.ok(looksLikeSearchableSelect(mk('Choisir une option')));
});

test('a plain search box is NOT rerouted (free text must never regress)', () => {
  const mk = (placeholder, type = 'text') => ({ tagName: 'INPUT', type, placeholder });
  assert.equal(looksLikeSearchableSelect(mk('Search…')), false, 'searching is not choosing');
  assert.equal(looksLikeSearchableSelect(mk('e.g. 5 years')), false);
  assert.equal(looksLikeSearchableSelect(mk('')), false);
  assert.equal(looksLikeSearchableSelect({ tagName: 'TEXTAREA', placeholder: 'Select an option' }), false);
});

test('a numeric answer resolves to the RANGE option that contains it', () => {
  const OPTS = ['Less than 1 year', '1-3 years', '3-5 years', '5-10 years', 'More than 10 years'];
  assert.equal(OPTS[matchNumericRangeOption('0', OPTS)], 'Less than 1 year');
  assert.equal(OPTS[matchNumericRangeOption('2', OPTS)], '1-3 years');
  assert.equal(OPTS[matchNumericRangeOption('6', OPTS)], '5-10 years');   // the live failure
  assert.equal(OPTS[matchNumericRangeOption('12', OPTS)], 'More than 10 years');
});

test('other common range spellings work too', () => {
  const O = ['0-2 years', '3-5 years', '6-10 years', '10+ years'];
  assert.equal(O[matchNumericRangeOption('1', O)], '0-2 years');
  assert.equal(O[matchNumericRangeOption('7', O)], '6-10 years');
  assert.equal(O[matchNumericRangeOption('15', O)], '10+ years');
});

test('non-numeric or unmatched values return -1 rather than guessing', () => {
  const OPTS = ['Less than 1 year', '1-3 years'];
  assert.equal(matchNumericRangeOption('abc', OPTS), -1);
  assert.equal(matchNumericRangeOption('', OPTS), -1);
  assert.equal(matchNumericRangeOption('yes', OPTS), -1);
  assert.equal(matchNumericRangeOption('5', ['Red', 'Green', 'Blue']), -1, 'no ranges → no match');
});
