// "No" AGAINST OPTIONS THAT ARE SENTENCES.
//
// Live 2026-08-24 on the Affirm postings, this line appeared on every run:
//
//   trace:field "have you previously been employed at affirm for any length of time?*" type=combobox src=qa → No
//   trace:fill  "have you previously been employed at affirm for any length of time?*" → left-empty (no matching option)
//
// while GitLab's identically SHAPED question on the same ATS, in the same run, filled fine:
//
//   trace:fill  "have you previously worked at or consulted for gitlab?*" → filled-from-qa
//
// The widget was never the difference. Read off the live Affirm form (question_30047847003), the
// options are not Yes/No at all:
//
//     I have not previously been employed at Affirm
//     I have been employed at Affirm as a full-time employee
//     I have been employed at Affirm as a part-time employee
//     I have been employed at Affirm as an intern
//     I have been employed at Affirm as a contractor
//
// GitLab's are the literal words "Yes" and "No", so its exact tier hit. Affirm's reach NONE of the
// tiers: "No" is not exact, not a prefix of any option, and the substring tier is switched off for
// a two-character value (`vl.length > 2`) — the one guard that stops "no" matching every option
// containing the letters n-o. Nine Tier A Affirm tasks were parked behind this.
//
// The resolution is by POLARITY, and it must be conservative: exactly one option may carry the
// wanted polarity, or we park. "Yes" against this widget is genuinely ambiguous — full-time,
// part-time, intern and contractor are four materially different employment histories — so it must
// NOT be guessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const autofillUrl = pathToFileURL(path.join(here, '..', 'extension', 'content', 'autofill.js')).href;

const GLOBALS = ['window', 'document', 'MouseEvent', 'KeyboardEvent', 'Event',
  'HTMLInputElement', 'HTMLElement', 'Element', 'Node', 'NodeFilter', 'getComputedStyle'];

let matchPolarityOption, isNegativeOptionText, matchOption, fillCombobox;
test.before(async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://job-boards.greenhouse.io/affirm/jobs/7663436003' });
  for (const k of GLOBALS) globalThis[k] = dom.window[k];
  globalThis.CSS = dom.window.CSS || { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') };
  ({ matchPolarityOption, isNegativeOptionText, matchOption, fillCombobox } = await import(autofillUrl));
});

// A react-select the way Greenhouse actually ships it (classes read off the live Affirm form:
// select__control / select__input-container / select__option), including its default filtering —
// which is the detail that makes the live menu show ONE row by the time the matcher looks.
function mountDom(html, url = 'https://job-boards.greenhouse.io/affirm/jobs/7663436003') {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', {
    get() { return this.parentElement; }, configurable: true,
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const on = !!this.ownerDocument?.contains(this);
    return { x: 0, y: 0, top: 0, left: 0, right: on ? 120 : 0, bottom: on ? 20 : 0, width: on ? 120 : 0, height: on ? 20 : 0, toJSON() { return this; } };
  };
  for (const k of GLOBALS) globalThis[k] = dom.window[k];
  return dom;
}
function unmountDom(dom) {
  try { dom.window.close(); } catch {}
  for (const k of GLOBALS) delete globalThis[k];
}
function greenhouseSelect({ label, options }) {
  const dom = mountDom(`
    <div class="select__container"><div class="select-shell">
      <div class="select__control"><div class="select__value-container">
        <div class="select__placeholder">Select...</div>
        <div class="select__input-container">
          <input id="ctl" class="select__input" role="combobox" aria-label="${label}" value="" />
        </div>
      </div></div>
      <div class="select__menu"></div>
    </div></div>`);
  const doc = dom.window.document;
  const input = doc.getElementById('ctl');
  const menu = doc.querySelector('.select__menu');
  const vc = doc.querySelector('.select__value-container');
  function render() {
    const q = String(input.value || '').trim().toLowerCase();
    menu.innerHTML = '';
    for (const o of options.filter((x) => !q || x.toLowerCase().includes(q))) {
      const el = doc.createElement('div');
      el.className = 'select__option remix-css-18355b6-option';
      el.setAttribute('role', 'option');
      el.textContent = o;
      el.addEventListener('click', () => {
        doc.querySelector('.select__placeholder')?.remove();
        vc.querySelector('.select__single-value')?.remove();
        const sv = doc.createElement('div');
        sv.className = 'select__single-value';
        sv.textContent = o;
        vc.prepend(sv);
        input.value = '';
        render();
      });
      menu.appendChild(el);
    }
  }
  for (const ev of ['pointerdown', 'mousedown', 'click']) input.addEventListener(ev, render);
  input.addEventListener('input', render);
  return { dom, doc, input };
}
const singleValue = (doc) => doc.querySelector('.select__single-value')?.textContent || '';

// Verbatim from the live form.
const AFFIRM = [
  'I have not previously been employed at Affirm',
  'I have been employed at Affirm as a full-time employee',
  'I have been employed at Affirm as a part-time employee',
  'I have been employed at Affirm as an intern',
  'I have been employed at Affirm as a contractor',
];

test('THE BUG: "No" resolves to the single negated Affirm option', () => {
  assert.equal(matchPolarityOption(AFFIRM, 'No'), 0);
});

test('"Yes" against the same widget is ambiguous and must NOT be guessed', () => {
  assert.equal(matchPolarityOption(AFFIRM, 'Yes'), -1,
    'four affirmative options are four different employment histories — parking is the honest outcome');
});

test('a widget that offers a literal Yes/No is left to the exact tier', () => {
  // GitLab's version. Polarity must stand aside so it can never second-guess an exact match.
  assert.equal(matchPolarityOption(['Yes', 'No'], 'No'), -1);
  assert.equal(matchPolarityOption(['Yes', 'No', 'Prefer not to say'], 'Yes'), -1);
});

test('a prose answer is not a polarity claim', () => {
  assert.equal(matchPolarityOption(AFFIRM, 'I worked there as a contractor'), -1);
  assert.equal(matchPolarityOption(AFFIRM, '5-10 years'), -1);
});

test('negation is read as WHOLE WORDS, so "non-", "Norway" and "nothing" are not negatives', () => {
  assert.equal(isNegativeOptionText('I have not previously been employed at Affirm'), true);
  assert.equal(isNegativeOptionText("I haven't worked there"), true);
  assert.equal(isNegativeOptionText('No prior experience'), true);
  assert.equal(isNegativeOptionText('I have been employed at Affirm as a contractor'), false);
  assert.equal(isNegativeOptionText('I was a non-employee contractor'), false);
  assert.equal(isNegativeOptionText('Norway'), false);
  assert.equal(isNegativeOptionText('Nothing to declare'), false);
});

test('two negatives are ambiguous — never pick one', () => {
  assert.equal(matchPolarityOption(['I have not worked there', 'I have never applied before', 'I worked there'], 'No'), -1);
});

test('the same gap on a NATIVE <select> is closed too (matchOption)', () => {
  const dom = new JSDOM(`<!doctype html><body><select id="s">
    ${AFFIRM.map((o, i) => `<option value="v${i}">${o}</option>`).join('')}
  </select></body>`, { url: 'https://job-boards.greenhouse.io/affirm/jobs/1' });
  const sel = dom.window.document.getElementById('s');
  const opt = matchOption(sel, 'No');
  assert.ok(opt, '"No" must resolve against prose options on a plain select as well');
  assert.equal(opt.text.trim(), 'I have not previously been employed at Affirm');
  assert.equal(matchOption(sel, 'Yes'), null, 'and "Yes" is still ambiguous here');
});

test('a normal Yes/No select is unaffected', () => {
  const dom = new JSDOM('<!doctype html><body><select id="s"><option>Yes</option><option>No</option></select></body>',
    { url: 'https://x/' });
  const sel = dom.window.document.getElementById('s');
  assert.equal(matchOption(sel, 'No').text, 'No');
  assert.equal(matchOption(sel, 'Yes').text, 'Yes');
});

// ---- end to end, through the widget that actually failed ------------------------------------

const AFFIRM_Q = 'Have you previously been employed at Affirm for any length of time?*';

test('END TO END: the real Affirm widget now commits "No"', async () => {
  const { dom, doc, input } = greenhouseSelect({ label: AFFIRM_Q, options: AFFIRM });
  try {
    let why = '';
    const ok = await fillCombobox(input, 'No', { trace: (r) => { why = r; } });
    assert.equal(ok, true, `fillCombobox abandoned the field: "${why}"`);
    assert.equal(singleValue(doc), 'I have not previously been employed at Affirm');
  } finally { unmountDom(dom); }
});

test('END TO END: GitLab\'s literal Yes/No version still fills, unchanged', async () => {
  const { dom, doc, input } = greenhouseSelect({
    label: 'Have you previously worked at or consulted for GitLab?*', options: ['Yes', 'No'],
  });
  try {
    assert.equal(await fillCombobox(input, 'No'), true);
    assert.equal(singleValue(doc), 'No');
  } finally { unmountDom(dom); }
});

test('END TO END: "Yes" against Affirm\'s widget leaves the field ALONE (rule 1)', async () => {
  const { dom, doc, input } = greenhouseSelect({ label: AFFIRM_Q, options: AFFIRM });
  try {
    assert.equal(await fillCombobox(input, 'Yes'), false, 'ambiguous — must abandon, not guess');
    assert.equal(singleValue(doc), '', 'nothing committed');
    assert.equal(input.value, '', 'and the typed text is restored, so the form cannot look answered');
  } finally { unmountDom(dom); }
});

test('a years-of-experience select still resolves by range, not polarity', () => {
  const dom = new JSDOM('<!doctype html><body><select id="s"><option>0-4 years</option><option>5-10 years</option><option>10+ years</option></select></body>',
    { url: 'https://x/' });
  const sel = dom.window.document.getElementById('s');
  assert.equal(matchOption(sel, '6').text, '5-10 years');
});
