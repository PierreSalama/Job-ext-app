// Autofill DAMAGED three real applications Pierre made BY HAND on 2026-08-22/23. Each failure is
// pinned here, and each assertion below fails on the pre-fix code.
//
// 1. UNCOMMITTED COMBOBOX. detector.runProfileAutofill (the passive path that runs while a human
//    fills a form) had no combobox branch at all: every react-select fell through to a plain
//    setNativeValue. The widget DISPLAYS the typed text while holding no value, so Country /
//    Location / yes-no screening fields looked filled and submit bounced "Select a country" /
//    "This field is required". fillCombobox had the same shape of hole on its failure path — it
//    typed the value in first and returned false without ever clearing it.
//    RULE: a value we cannot COMMIT is not written at all. Blank is honest; blank gets caught.
//
// 2. WRONG TORONTO. On a Faire Greenhouse form the Location field ended up holding
//    "Toronto, Ohio, United States". The pick was simply the first option that STARTS WITH the
//    typed city, and the option list is alphabetical by region — Ohio sorts before Ontario. The
//    profile's own province and country were never consulted. AutoTrader offers eight Torontos.
//
// 3. UNDERCUT SALARY. On an AutoTrader posting whose stated band was CAD 110,000-140,000, autofill
//    pre-filled the stored expectation "CAD 85,000-110,000" — the whole ask sitting at or below
//    their floor, before a human read a word. That is real money.

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  pickLocationIndex, parseMoneyRange, salaryWouldUndercut, findPostedSalaryRange,
  looksLikeLocationLabel, looksLikeSalaryLabel, fillCombobox, comboboxCommitted, isReactSelect,
  AutofillEngine,
} from '../extension/content/autofill.js';

// ---------------------------------------------------------------------------------------------
// jsdom plumbing. jsdom has no layout, so offsetParent is always null and fillCombobox's
// visibility filter would drop every option; map it to parentElement so attached nodes count.
// ---------------------------------------------------------------------------------------------
function mountDom(html, url = 'https://job-boards.greenhouse.io/faire/jobs/1') {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', {
    get() { return this.parentElement; }, configurable: true,
  });
  for (const k of ['window', 'document', 'MouseEvent', 'KeyboardEvent', 'Event',
    'HTMLInputElement', 'HTMLElement', 'Node', 'getComputedStyle']) {
    globalThis[k] = dom.window[k];
  }
  return dom;
}
function unmountDom(dom) {
  try { dom.window.close(); } catch {}
  for (const k of ['window', 'document', 'MouseEvent', 'KeyboardEvent', 'Event',
    'HTMLInputElement', 'HTMLElement', 'Node', 'getComputedStyle']) delete globalThis[k];
}

// A faithful react-select: emotion-style control wrapper, the combobox input nested inside a
// value-container, and a separate menu of options. `commit` decides whether clicking an option
// actually selects it — react-select ignores clicks it does not recognise, which is exactly the
// live failure, so the default is the honest "nothing happens".
function reactSelect({ label, options, commit = false }) {
  const html = `
    <div class="select-shell">
      <div class="css-1s2u09g-control select__control">
        <div class="select__value-container">
          <div class="select__placeholder">Select...</div>
          <div class="select__input-container">
            <input id="ctl" role="combobox" aria-label="${label}" value="" />
          </div>
        </div>
      </div>
      <div class="select__menu">
        ${options.map((o, i) => `<div class="select__option" data-i="${i}">${o}</div>`).join('')}
      </div>
    </div>`;
  const dom = mountDom(html);
  const doc = dom.window.document;
  if (commit) {
    for (const opt of doc.querySelectorAll('.select__option')) {
      opt.addEventListener('click', () => {
        const vc = doc.querySelector('.select__value-container');
        doc.querySelector('.select__placeholder')?.remove();
        vc.querySelector('.select__single-value')?.remove();
        const sv = doc.createElement('div');
        sv.className = 'select__single-value';
        sv.textContent = opt.textContent;
        vc.prepend(sv);
        doc.getElementById('ctl').value = '';        // react-select empties the input on commit
      });
    }
  }
  return { dom, input: doc.getElementById('ctl'), doc };
}

const singleValue = (doc) => doc.querySelector('.select__single-value')?.textContent || null;

// The two live option lists, in the order the pages actually rendered them.
const FAIRE_TORONTOS = ['Toronto, Ohio, United States', 'Toronto, Ontario, Canada'];
const AUTOTRADER_TORONTOS = [
  'Toronto, Illinois, United States', 'Toronto, Iowa, United States',
  'Toronto, Kansas, United States', 'Toronto, Missouri, United States',
  'Toronto, New South Wales, Australia', 'Toronto, Ohio, United States',
  'Toronto, Ontario, Canada', 'Toronto, South Dakota, United States',
];
const PIERRE = { city: 'Toronto', state: 'Ontario', country: 'Canada' };

// =============================================================================================
// FAILURE 1 — a combobox we cannot commit must be LEFT ALONE, not left looking filled
// =============================================================================================

test('a react-select that never commits is reverted, not left displaying typed text', async () => {
  const { dom, input, doc } = reactSelect({ label: 'Country', options: ['Canada', 'United States'] });
  try {
    const ok = await fillCombobox(input, 'Canada');
    assert.equal(ok, false, 'an uncommitted selection is a FAILURE, not a success');
    assert.equal(input.value, '',
      'the typed text must be cleared — leaving "Canada" visible with no value is what made the form look filled and submit wrong');
    assert.equal(singleValue(doc), null, 'nothing was actually selected');
  } finally { unmountDom(dom); }
});

test('a react-select that DOES commit still fills normally (no regression)', async () => {
  const { dom, input, doc } = reactSelect({ label: 'Country', options: ['Canada', 'United States'], commit: true });
  try {
    assert.equal(await fillCombobox(input, 'Canada'), true);
    assert.equal(singleValue(doc), 'Canada', 'the control holds the committed value');
    assert.ok(comboboxCommitted(input));
  } finally { unmountDom(dom); }
});

test('commit is read off the control, never off the input the text was typed into', async () => {
  const { dom, input, doc } = reactSelect({ label: 'Country', options: ['Canada'] });
  try {
    assert.ok(isReactSelect(input), 'the emotion -control wrapper identifies a react-select');
    assert.equal(comboboxCommitted(input), false, 'no single-value yet → not committed');
    const vc = doc.querySelector('.select__value-container');
    const sv = doc.createElement('div');
    sv.className = 'select__single-value';
    sv.textContent = 'Canada';
    vc.prepend(sv);
    assert.equal(comboboxCommitted(input), true);
  } finally { unmountDom(dom); }
});

// =============================================================================================
// FAILURE 2 — the location must be the profile's own city, or nothing
// =============================================================================================

test('the wrong-country Toronto is never picked, however it sorts', () => {
  assert.equal(FAIRE_TORONTOS[pickLocationIndex(FAIRE_TORONTOS, PIERRE)], 'Toronto, Ontario, Canada',
    'the live Faire list put Ohio first; first-match-wins is what filled the wrong country');
  assert.equal(AUTOTRADER_TORONTOS[pickLocationIndex(AUTOTRADER_TORONTOS, PIERRE)], 'Toronto, Ontario, Canada',
    'eight Torontos, one of them right');
});

test('abbreviated and spelled-out regions compare equal in both directions', () => {
  assert.equal(AUTOTRADER_TORONTOS[pickLocationIndex(AUTOTRADER_TORONTOS, { city: 'Toronto', state: 'ON', country: 'CA' })],
    'Toronto, Ontario, Canada');
  const abbrevOpts = ['Toronto, OH, United States', 'Toronto, ON, Canada'];
  assert.equal(abbrevOpts[pickLocationIndex(abbrevOpts, PIERRE)], 'Toronto, ON, Canada');
});

test('ambiguity leaves the field blank rather than guessing', () => {
  assert.equal(pickLocationIndex(AUTOTRADER_TORONTOS, { city: 'Toronto' }), -1,
    'no province and no country → we cannot be sure, so we do not answer');
  assert.equal(pickLocationIndex(['Toronto, Ontario, Canada', 'Toronto, Ontario, Canada'], PIERRE), -1,
    'a tie at the best tier is still ambiguous');
  assert.equal(pickLocationIndex(['London, Ontario, Canada', 'Ottawa, Ontario, Canada'], PIERRE), -1,
    'the city must actually be present');
  assert.equal(pickLocationIndex([], PIERRE), -1);
});

test('the city must be the option\'s leading component, not merely inside it', () => {
  const opts = ['East Toronto Junction, Ontario, Canada', 'Toronto, Ontario, Canada'];
  assert.equal(opts[pickLocationIndex(opts, PIERRE)], 'Toronto, Ontario, Canada');
});

test('a US profile still resolves to its own country', () => {
  const us = { city: 'Toronto', state: 'Ohio', country: 'United States' };
  assert.equal(AUTOTRADER_TORONTOS[pickLocationIndex(AUTOTRADER_TORONTOS, us)], 'Toronto, Ohio, United States');
});

test('a location combobox picks the qualified option end-to-end', async () => {
  const { dom, input, doc } = reactSelect({ label: 'Location (City)', options: FAIRE_TORONTOS, commit: true });
  try {
    const ok = await fillCombobox(input, 'Toronto', { locationHint: PIERRE });
    assert.equal(ok, true);
    assert.equal(singleValue(doc), 'Toronto, Ontario, Canada',
      'pre-fix this committed "Toronto, Ohio, United States" — the first option starting with the typed city');
  } finally { unmountDom(dom); }
});

test('an unqualifiable location commits nothing and clears the box', async () => {
  const { dom, input, doc } = reactSelect({ label: 'Location (City)', options: AUTOTRADER_TORONTOS, commit: true });
  try {
    const ok = await fillCombobox(input, 'Toronto', { locationHint: { city: 'Toronto' } });
    assert.equal(ok, false, 'eight candidates and nothing to choose between them');
    assert.equal(singleValue(doc), null, 'nothing was committed');
    assert.equal(input.value, '', 'and no text was left behind pretending it was');
  } finally { unmountDom(dom); }
});

test('location labels are recognised in the shapes the ATSs actually use', () => {
  for (const l of ['Location (City)', 'City', 'Location', 'Where are you based?', 'Ville'])
    assert.ok(looksLikeLocationLabel(l), l);
  for (const l of ['First Name', 'Are you authorized to work?', 'Salary expectation'])
    assert.equal(looksLikeLocationLabel(l), false, l);
});

// =============================================================================================
// FAILURE 3 — never anchor at or below the posting's own stated range
// =============================================================================================

test('the live AutoTrader numbers are recognised as an undercut', () => {
  assert.equal(salaryWouldUndercut('CAD 85,000–110,000', 'CAD 110,000–140,000'), true,
    'the top of the ask equals their floor — the whole range sits at or under the posted band');
});

test('an ask that reaches above the posted floor is still written', () => {
  assert.equal(salaryWouldUndercut('CAD 130,000–160,000', 'CAD 110,000–140,000'), false);
  assert.equal(salaryWouldUndercut('CAD 120,000', 'CAD 110,000–140,000'), false);
});

test('unknown, unparseable, or mismatched-currency never blocks (one-directional rule)', () => {
  assert.equal(salaryWouldUndercut('CAD 85,000', ''), false, 'no stated range → old behaviour');
  assert.equal(salaryWouldUndercut('CAD 85,000', null), false);
  assert.equal(salaryWouldUndercut('', 'CAD 110,000-140,000'), false);
  assert.equal(salaryWouldUndercut('negotiable', 'CAD 110,000-140,000'), false);
  assert.equal(salaryWouldUndercut('USD 85,000', 'CAD 110,000-140,000'), false,
    'different currencies are not comparable — we do not guess an exchange rate');
});

test('money ranges parse across the spellings postings actually use', () => {
  assert.deepEqual(
    (({ min, max, currency }) => ({ min, max, currency }))(parseMoneyRange('CAD 110,000–140,000')),
    { min: 110000, max: 140000, currency: 'CAD' });
  assert.deepEqual(
    (({ min, max }) => ({ min, max }))(parseMoneyRange('$110,000 - $140,000 a year')),
    { min: 110000, max: 140000 });
  assert.deepEqual((({ min, max }) => ({ min, max }))(parseMoneyRange('110k-140k')), { min: 110000, max: 140000 });
  assert.equal(parseMoneyRange('$60/hr').max, 124800, 'hourly annualises, else 60 < 110000 is nonsense');
  assert.equal(parseMoneyRange('').known, false);
  assert.equal(parseMoneyRange('competitive salary').known, false);
  assert.equal(parseMoneyRange('2026').known, false, 'a year is not a salary');
});

test('the posted range is read off the page', () => {
  const dom = mountDom('<h1>Senior Engineer</h1><p>Salary range: CAD 110,000 - 140,000 per year</p>');
  try {
    const posted = findPostedSalaryRange(null);
    assert.ok(posted && posted.known);
    assert.equal(posted.min, 110000);
    assert.equal(posted.max, 140000);
  } finally { unmountDom(dom); }
});

test('a page with no stated band reports none, so nothing is blocked', () => {
  const dom = mountDom('<h1>Senior Engineer</h1><p>Compensation is competitive.</p><p>Founded 2015.</p>');
  try { assert.equal(findPostedSalaryRange(null), null); } finally { unmountDom(dom); }
});

test('salary labels are recognised in the shapes the ATSs actually use', () => {
  for (const l of ['Salary expectation', 'What is your expected salary?', 'Desired compensation',
    'Expected pay', 'Pay range expectation'])
    assert.ok(looksLikeSalaryLabel(l), l);
  for (const l of ['First Name', 'Location (City)']) assert.equal(looksLikeSalaryLabel(l), false, l);
});

// =============================================================================================
// End-to-end through AutofillEngine.fill() — the path the executor drives
// =============================================================================================

// BEHAVIOUR CHANGE (salary is now derived per posting — see tests/salary-dynamic-ask.test.mjs).
// This test used to assert the MECHANISM: when the profile band would undercut the posting, the
// field was left EMPTY. That protected against undercutting but left a required field blank,
// which blocks the submit. The GUARANTEE it existed to protect — never anchor at or below the
// posting's own floor — is unchanged and is what is asserted now; the field is answered instead
// of skipped, with an ask taken from the upper half of the posting's stated band.
test('fill() never anchors a salary at or below the posted band\'s floor', async () => {
  const dom = mountDom(`
    <h1>Senior Engineer</h1>
    <p>Salary range: CAD 110,000 - 140,000 per year</p>
    <form><label for="sal">Salary expectation</label><input id="sal" aria-label="Salary expectation" /></form>`);
  try {
    const input = dom.window.document.getElementById('sal');
    const engine = new AutofillEngine({ getProfile: async () => ({ salaryExpectation: 'CAD 85,000-110,000' }) });
    const outcomes = [];
    await engine.fill(
      [{ input, label: 'Salary expectation', source: 'profile', field: 'salaryExpectation', value: 'CAD 85,000-110,000' }],
      (o) => outcomes.push(o.outcome));
    assert.notEqual(input.value, 'CAD 85,000-110,000',
      'the undercutting profile band must never be written under a band opening at 110,000');
    if (input.value) {
      const lo = Number(String(input.value).match(/[\d,]+/)[0].replace(/,/g, ''));
      assert.ok(lo > 110000, `the ask must sit above the posted floor — got "${input.value}"`);
      assert.ok(outcomes.includes('salary-derived'), `outcomes: ${outcomes.join(',')}`);
    } else {
      assert.deepEqual(outcomes, ['skipped-salary-undercut']);
    }
  } finally { unmountDom(dom); }
});

test('fill() still writes a salary when the posting states no range', async () => {
  const dom = mountDom(`
    <h1>Senior Engineer</h1><p>Compensation is competitive.</p>
    <form><label for="sal">Salary expectation</label><input id="sal" aria-label="Salary expectation" /></form>`);
  try {
    const input = dom.window.document.getElementById('sal');
    const engine = new AutofillEngine({ getProfile: async () => ({ salaryExpectation: 'CAD 85,000-110,000' }) });
    const outcomes = [];
    await engine.fill(
      [{ input, label: 'Salary expectation', source: 'profile', field: 'salaryExpectation', value: 'CAD 85,000-110,000' }],
      (o) => outcomes.push(o.outcome));
    assert.equal(input.value, 'CAD 85,000-110,000', 'no stated band → unchanged behaviour');
    assert.deepEqual(outcomes, ['filled']);
  } finally { unmountDom(dom); }
});

test('fill() leaves an uncommittable react-select empty and says so', async () => {
  const { dom, input, doc } = reactSelect({ label: 'Country', options: ['Canada', 'United States'] });
  try {
    const engine = new AutofillEngine({ getProfile: async () => ({ country: 'Canada' }) });
    const outcomes = [];
    await engine.fill(
      [{ input, label: 'Country', source: 'profile', field: 'country', value: 'Canada' }],
      (o) => outcomes.push(o.outcome));
    assert.equal(input.value, '', 'no text left behind pretending the field is answered');
    assert.equal(singleValue(doc), null);
    assert.deepEqual(outcomes, ['skipped-combobox-miss']);
  } finally { unmountDom(dom); }
});
