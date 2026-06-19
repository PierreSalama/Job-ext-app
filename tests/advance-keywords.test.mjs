// BUG-1 regression: the LinkedIn Easy Apply page-level OPENER must NEVER be treated as an
// in-form advance button (re-clicking it is the multi-page "1/5 pages" stall). The pure
// advance-vs-opener decision lives in extension/content/lib/advance.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAdvanceLabel, ADVANCE_KEYWORDS, OPEN_KEYWORDS } from '../extension/content/lib/advance.js';

test('the Easy Apply OPENER is not an advance button when allowOpen=false', () => {
  // The exact label from the live transcript.
  assert.equal(isAdvanceLabel('Easy Apply to this job', { allowOpen: false }), false);
  assert.equal(isAdvanceLabel('Easy Apply', { allowOpen: false }), false);
  assert.equal(isAdvanceLabel('Apply', { allowOpen: false }), false);
  assert.equal(isAdvanceLabel('Apply now', { allowOpen: false }), false);
  assert.equal(isAdvanceLabel('Postuler', { allowOpen: false }), false);
});

test('the OPENER labels ARE matchable when allowOpen=true (generic open branch)', () => {
  assert.equal(isAdvanceLabel('Easy Apply to this job', { allowOpen: true }), true);
  assert.equal(isAdvanceLabel('Apply', { allowOpen: true }), true);
  assert.equal(isAdvanceLabel('Apply now', { allowOpen: true }), true);
  assert.equal(isAdvanceLabel('Postuler', { allowOpen: true }), true);
});

test('Next / Review / Submit ARE advance buttons regardless of allowOpen', () => {
  for (const allowOpen of [false, true]) {
    assert.equal(isAdvanceLabel('Next', { allowOpen }), true);
    assert.equal(isAdvanceLabel('Continue', { allowOpen }), true);
    assert.equal(isAdvanceLabel('Review', { allowOpen }), true);
    assert.equal(isAdvanceLabel('Review your application', { allowOpen }), true);
    assert.equal(isAdvanceLabel('Submit', { allowOpen }), true);
    assert.equal(isAdvanceLabel('Submit application', { allowOpen }), true);
    assert.equal(isAdvanceLabel('Suivant', { allowOpen }), true);   // FR
    assert.equal(isAdvanceLabel('Soumettre', { allowOpen }), true); // FR
  }
});

test('opener keywords are split OUT of ADVANCE_KEYWORDS and INTO OPEN_KEYWORDS', () => {
  const advanceMatches = (s) => ADVANCE_KEYWORDS.some((re) => re.test(s));
  const openMatches = (s) => OPEN_KEYWORDS.some((re) => re.test(s));
  for (const opener of ['Apply', 'Apply now', 'Easy Apply', 'Postuler']) {
    assert.equal(advanceMatches(opener), false, `${opener} must not be an ADVANCE keyword`);
    assert.equal(openMatches(opener), true, `${opener} must be an OPEN keyword`);
  }
  for (const adv of ['Next', 'Review', 'Submit application']) {
    assert.equal(advanceMatches(adv), true, `${adv} must be an ADVANCE keyword`);
    assert.equal(openMatches(adv), false, `${adv} must not be an OPEN keyword`);
  }
});

test('empty / overlong labels never match', () => {
  assert.equal(isAdvanceLabel('', { allowOpen: true }), false);
  assert.equal(isAdvanceLabel('   ', { allowOpen: true }), false);
  assert.equal(isAdvanceLabel('Apply to all the jobs you can possibly find today now', { allowOpen: true }), false);
});
