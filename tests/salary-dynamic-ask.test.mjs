// THE SALARY ASK MUST DEPEND ON THE POSTING.
//
// Pierre, verbatim: "for the salary stuff, you can set it to whatever amount you want… wherever
// it depends really on the job. So try to make it more dynamic than just hard."
//
// Before: the profile held one static band (CAD 115,000–140,000) and it was written verbatim
// into every salary field — and when that band would have undercut the posting, the field was
// left EMPTY instead (a required field left blank blocks the submit).
//
// Rules, in order:
//   1. Posting states a range → ask within its UPPER HALF, never below its floor.
//   2. Posting states nothing → fall back to the profile band.
//   3. Never below the profile band's own floor, whatever the posting says.
//   4. Respect the field shape — a numeric field gets ONE number, never a range string.
//      (Real live block reason: "Enter a decimal number larger than 0.0". A range string in a
//      numeric field never validates, so that task re-parks on every retry.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let af, dom;
test.before(async () => {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.com/' });
  dom.window.Element.prototype.getBoundingClientRect = function () {
    return { width: 120, height: 24, top: 0, left: 0, right: 120, bottom: 24, x: 0, y: 0 };
  };
  for (const k of ['window', 'document', 'Element', 'Node', 'HTMLElement', 'NodeFilter', 'getComputedStyle']) globalThis[k] = dom.window[k];
  globalThis.CSS = dom.window.CSS || { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') };
  af = await import(pathToFileURL(path.join(here, '..', 'extension', 'content', 'autofill.js')).href);
});

const BAND = 'CAD 115,000–140,000';        // Pierre's profile band
const num = (s) => Number(String(s).replace(/[^\d.]/g, ''));
const nums = (s) => String(s).match(/[\d,]+/g).map((x) => Number(x.replace(/,/g, '')));

// ---------------------------------------------------------------------------
// RULE 1 — posted range: ask in the upper half
// ---------------------------------------------------------------------------

test('posting range ABOVE his band → ask in the posting\'s upper half, not his band', () => {
  const posted = af.parseMoneyRange('CAD 150,000 - 200,000 per year');
  const ask = af.deriveSalaryAsk(BAND, posted);
  const [lo, hi] = nums(ask);
  assert.equal(lo, 175000, `upper half starts at the midpoint — got ${ask}`);
  assert.equal(hi, 200000);
  assert.ok(lo >= 150000, 'never below the posted floor');
  assert.ok(lo > 140000, 'and emphatically not the static band');
});

test('posting range OVERLAPPING his band → upper half of the posting', () => {
  const posted = af.parseMoneyRange('CAD 100,000 to 150,000 annually');
  const [lo, hi] = nums(af.deriveSalaryAsk(BAND, posted));
  assert.equal(lo, 125000);
  assert.equal(hi, 150000);
  assert.ok(lo >= 115000, 'never below his own floor');
});

test('posting range BELOW his band → clamped UP to his floor, never below it', () => {
  const posted = af.parseMoneyRange('CAD 80,000 - 100,000 per year');
  const ask = af.deriveSalaryAsk(BAND, posted);
  const [lo] = nums(ask);
  assert.ok(lo >= 115000, `must never emit below the profile floor — got ${ask}`);
});

test('RULE 2 — posting states NOTHING → the profile band, unchanged', () => {
  const [lo, hi] = nums(af.deriveSalaryAsk(BAND, null));
  assert.equal(lo, 115000);
  assert.equal(hi, 140000);
});

test('nothing stated anywhere → say nothing (never invent a number)', () => {
  assert.equal(af.deriveSalaryAsk('', null), null);
  assert.equal(af.deriveSalaryAsk('negotiable', null), null);
});

// ---------------------------------------------------------------------------
// RULE 4 — field shape
// ---------------------------------------------------------------------------

test('a NUMERIC field gets a single bare number, never a range string', () => {
  const posted = af.parseMoneyRange('CAD 150,000 - 200,000 per year');
  const ask = af.deriveSalaryAsk(BAND, posted, { numeric: true });
  assert.match(ask, /^\d+$/, `numeric fields need a bare number — got "${ask}"`);
  assert.equal(Number(ask), 175000);
  // it must satisfy the live validator that rejected the range string
  assert.ok(Number.isFinite(parseFloat(ask)) && parseFloat(ask) > 0.0);
});

test('a numeric field with NO posted range still gets a single number (the profile floor)', () => {
  const ask = af.deriveSalaryAsk(BAND, null, { numeric: true });
  assert.match(ask, /^\d+$/);
  assert.equal(Number(ask), 115000);
});

test('a TEXT field keeps a readable range', () => {
  const ask = af.deriveSalaryAsk(BAND, af.parseMoneyRange('CAD 150,000 - 200,000 per year'));
  assert.match(ask, /175,000.*200,000/);
});

test('isNumericField recognises the shapes ATS forms actually use', () => {
  dom.window.document.body.innerHTML = '<form>'
    + '<input id="a" type="number">'
    + '<input id="b" type="text" inputmode="decimal">'
    + '<input id="c" type="text" inputmode="numeric">'
    + '<input id="d" type="text">'
    + '</form>';
  const $ = (id) => dom.window.document.getElementById(id);
  assert.equal(af.isNumericField($('a')), true);
  assert.equal(af.isNumericField($('b')), true);
  assert.equal(af.isNumericField($('c')), true);
  assert.equal(af.isNumericField($('d')), false);
});

// ---------------------------------------------------------------------------
// intervals — an hourly posting must not receive an annual figure
// ---------------------------------------------------------------------------

test('an HOURLY posting is answered in $/hour, not an annualised figure', () => {
  const posted = af.parseMoneyRange('$60 - $80 per hour');
  const ask = af.deriveSalaryAsk('CAD 60 - 80 / hr', posted);
  const [lo] = nums(ask);
  assert.ok(lo < 500, `an hourly field must get an hourly number — got "${ask}"`);
  assert.equal(lo, 70, 'upper half of 60–80');
  assert.match(ask, /hour/);
  assert.equal(af.deriveSalaryAsk('CAD 60 - 80 / hr', posted, { numeric: true }), '70');
});

// ---------------------------------------------------------------------------
// end to end through fill()
// ---------------------------------------------------------------------------

test('fill() writes the DERIVED ask into the field, not the static band', async () => {
  dom.window.document.body.innerHTML = `
    <div>Compensation: CAD 150,000 - 200,000 per year</div>
    <form>
      <label for="s">What are your salary expectations?</label>
      <input id="s" name="s" type="text">
    </form>`;
  const input = dom.window.document.getElementById('s');
  const engine = new af.AutofillEngine({
    getProfile: async () => ({ salaryExpectation: BAND }), lookupAnswer: async () => null, recordAnswer: async () => null,
  });
  await engine.fill([{ input, label: 'What are your salary expectations?', field: 'salaryExpectation', value: BAND }]);
  assert.notEqual(input.value, BAND, 'the static band must not be written verbatim');
  const [lo] = nums(input.value);
  assert.ok(lo >= 150000, `must sit inside the posted band — got "${input.value}"`);
});

test('fill() writes a bare number into a NUMERIC salary field', async () => {
  dom.window.document.body.innerHTML = `
    <div>Salary range: CAD 150,000 - 200,000 per year</div>
    <form>
      <label for="s">Desired base salary</label>
      <input id="s" name="s" type="number">
    </form>`;
  const input = dom.window.document.getElementById('s');
  const engine = new af.AutofillEngine({
    getProfile: async () => ({ salaryExpectation: BAND }), lookupAnswer: async () => null, recordAnswer: async () => null,
  });
  await engine.fill([{ input, label: 'Desired base salary', field: 'salaryExpectation', value: BAND }]);
  assert.match(input.value, /^\d+$/, `a numeric field must receive a bare number — got "${input.value}"`);
  assert.ok(num(input.value) >= 150000);
});

test('the anti-undercut guarantee survives: nothing below the posted floor is ever written', async () => {
  dom.window.document.body.innerHTML = `
    <div>Compensation: CAD 150,000 - 200,000 per year</div>
    <form><label for="s">Salary expectation</label><input id="s" name="s" type="text"></form>`;
  const input = dom.window.document.getElementById('s');
  const engine = new af.AutofillEngine({
    getProfile: async () => ({ salaryExpectation: 'CAD 85,000-110,000' }), lookupAnswer: async () => null, recordAnswer: async () => null,
  });
  await engine.fill([{ input, label: 'Salary expectation', field: 'salaryExpectation', value: 'CAD 85,000-110,000' }]);
  if (input.value) {
    const [lo] = nums(input.value);
    assert.ok(lo >= 150000, `never anchor below the posting's own floor — got "${input.value}"`);
  }
});
