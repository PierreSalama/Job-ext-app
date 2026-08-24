// The Greenhouse / Lever / Ashby lane submitted ZERO applications across 137 attempts while
// LinkedIn and Indeed kept working. Diagnosed on the live faire posting 8603123002 (2026-08-24):
// every value RESOLVED correctly and every one failed at the FILL step. Four distinct causes,
// each pinned below. Every assertion here fails on the pre-fix code.
//
//  1. THE PROFILE'S OWN CITY. profile.city is "Toronto, ON" — a city plus its region, because
//     that is what a person types into a City box. pickLocationIndex compared that whole string
//     against each option's LEADING component ("toronto" !== "toronto, on") and vetoed every
//     candidate, so every location field on every ATS was left blank. "Location (City)*" is the
//     single most parked ATS question on the live install (15 tasks).
//
//  2. THE LABEL TRAP. looksLikeLocationLabel matched the bare word "location" anywhere, so
//     "…can you commit to being in-office three days per week at the LOCATION where this
//     position is posted?" — a Yes/No dropdown — was routed through the location matcher, which
//     looks for a CITY among the options, found none, and abandoned a field whose correct
//     option was on screen. The trace then blamed the widget: "typeahead no match".
//
//  3. THE "No options" NOTICE. The option selector carries [class*="-option"], a SUBSTRING match
//     on the class attribute — and react-select's empty state is
//     class="select__menu-notice select__menu-notice--no-options". "--no-optionS" contains
//     "-option", so the notice counted as an option, satisfied the wait loop on its first tick,
//     matched nothing, and was logged as an "un-pickable widget".
//
//  4. NO MULTI, NO CHECKBOX GROUPS. A "select all that apply" answer arrives as one string; the
//     widget needs it committed one value at a time. And scanUnknown skipped EVERY checkbox
//     ("never auto-decide bare checkboxes"), so a required checkbox group was invisible to the
//     scan and only ever surfaced as an unanswerable blocker at native validation.

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  pickLocationIndex, looksLikeLocationLabel, fillCombobox, isMultiCombobox, splitMultiValue,
  checkboxGroupMembers, checkboxGroupAllRequired, checkboxGroupLabel,
  isDemographicField, declineAnswerCandidates, AutofillEngine,
} from '../extension/content/autofill.js';

// ---------------------------------------------------------------------------------------------
// jsdom plumbing (same shape as autofill-damage-guards): jsdom has no layout, so offsetParent is
// always null and the option-visibility filter would drop every option; map it to parentElement.
// ---------------------------------------------------------------------------------------------
const GLOBALS = ['window', 'document', 'MouseEvent', 'KeyboardEvent', 'Event',
  'HTMLInputElement', 'HTMLElement', 'Node', 'getComputedStyle'];
function mountDom(html, url = 'https://job-boards.greenhouse.io/faire/jobs/8603123002') {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', {
    get() { return this.parentElement; }, configurable: true,
  });
  // jsdom also reports every rect as 0x0, which isProbablyVisible reads as "not on screen" —
  // so nothing would ever be fillable. Give attached elements a real box.
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

// The real faire lists, verbatim.
const FAIRE_TORONTOS = [
  'Toronto, Ontario, Canada', 'North Toronto, Ontario, Canada',
  'Midtown Toronto, Ontario, Canada', 'Old Toronto, Ontario, Canada',
];
const EIGHT_TORONTOS = [
  'Toronto, Illinois, United States', 'Toronto, Iowa, United States',
  'Toronto, Ohio, United States', 'Toronto, Ontario, Canada',
];
// The profile as it actually exists on the live machine.
const REAL_PROFILE = { city: 'Toronto, ON', state: 'Ontario', country: 'Canada' };

// =============================================================================================
// 1 — a city hint that carries its own region
// =============================================================================================

test('the profile\'s real city string "Toronto, ON" resolves the right Toronto', () => {
  assert.equal(pickLocationIndex(FAIRE_TORONTOS, REAL_PROFILE), 0);
});

test('"Toronto, ON" still refuses the wrong country and the wrong province', () => {
  assert.equal(pickLocationIndex(EIGHT_TORONTOS, REAL_PROFILE), 3, 'Ontario/Canada, not Ohio');
  assert.equal(
    pickLocationIndex(['Toronto, Ohio, United States'], REAL_PROFILE), -1,
    'the only candidate is in the wrong country — leave the field alone rather than guess');
});

test('a region carried in the city string is used ONLY when the profile states no state', () => {
  // No separate state field: the "ON" in the city string is the only region evidence there is.
  assert.equal(pickLocationIndex(EIGHT_TORONTOS, { city: 'Toronto, ON', country: 'Canada' }), 3);
  // An explicit state stays authoritative, so a stale/odd suffix cannot override it.
  assert.equal(pickLocationIndex(EIGHT_TORONTOS, { city: 'Toronto, CA', state: 'Ontario', country: 'Canada' }), 3);
});

test('a bare city is unchanged — this fix adds a shape, it does not replace one', () => {
  assert.equal(pickLocationIndex(EIGHT_TORONTOS, { city: 'Toronto', state: 'Ontario', country: 'Canada' }), 3);
  assert.equal(pickLocationIndex(EIGHT_TORONTOS, { city: 'Toronto' }), -1, 'four candidates, nothing to choose between them');
});

// =============================================================================================
// 2 — the label trap
// =============================================================================================

const HYBRID_Q = 'This role will be in-office on a hybrid schedule, can you commit to being '
  + 'in-office three days per week at the location where this position is posted?';

test('a screening sentence that merely mentions a location is NOT a location field', () => {
  assert.equal(looksLikeLocationLabel(HYBRID_Q), false);
  assert.equal(looksLikeLocationLabel('What is your preferred office location for this role, and would you relocate for it?'), false);
});

test('real location field labels are still recognised, including stacked ones', () => {
  for (const l of ['Location (City)', 'Location (City)* Location (City)', 'City', 'Location',
    'Ville', 'Where are you based?', 'What is your current location?', 'City of residence']) {
    assert.ok(looksLikeLocationLabel(l), l);
  }
  for (const l of ['First Name', 'Are you authorized to work?', 'Salary expectation']) {
    assert.equal(looksLikeLocationLabel(l), false, l);
  }
});

// =============================================================================================
// 3 + 4 — the widgets themselves
// =============================================================================================

// A react-select faithful enough to reproduce the failures: emotion class names, a menu that can
// arrive LATE (async lookup), a "No options" notice, and multi-value chips.
function reactSelect({ id = 'ctl', label, options, multi = false, asyncMs = 0, extraHtml = '' }) {
  const html = `
    ${extraHtml}
    <div class="select__container">
      <div class="select-shell">
        <div class="select__control">
          <div class="select__value-container${multi ? ' select__value-container--is-multi' : ''}">
            <div class="select__placeholder">Select...</div>
            <div class="select__input-container">
              <input id="${id}" class="select__input" role="combobox" aria-label="${label}" value="" />
            </div>
          </div>
        </div>
        <div class="select__menu"></div>
      </div>
    </div>`;
  const dom = mountDom(html);
  const doc = dom.window.document;
  const input = doc.getElementById(id);
  const menu = doc.querySelector('.select__menu');
  const vc = doc.querySelector('.select__value-container');
  const chosen = [];
  let ready = asyncMs === 0;
  let timer = null;

  function render() {
    const q = String(input.value || '').trim().toLowerCase();
    menu.innerHTML = '';
    if (!ready) return;
    const shown = options.filter((o) => !chosen.includes(o)).filter((o) => !q || o.toLowerCase().includes(q));
    if (!shown.length) {
      // react-select's empty state — a NOTICE whose emotion class contains "-option".
      const n = doc.createElement('div');
      n.className = 'select__menu-notice select__menu-notice--no-options remix-css-9x5mqu';
      n.textContent = 'No options';
      menu.appendChild(n);
      return;
    }
    for (const o of shown) {
      const el = doc.createElement('div');
      el.className = 'select__option remix-css-1pegj3v-option';
      el.setAttribute('role', 'option');
      el.textContent = o;
      el.addEventListener('click', () => commit(o));
      menu.appendChild(el);
    }
  }
  function commit(text) {
    chosen.push(text);
    doc.querySelector('.select__placeholder')?.remove();
    if (multi) {
      const chip = doc.createElement('div');
      chip.className = 'select__multi-value';
      chip.textContent = text;
      vc.prepend(chip);
    } else {
      vc.querySelector('.select__single-value')?.remove();
      const sv = doc.createElement('div');
      sv.className = 'select__single-value';
      sv.textContent = text;
      vc.prepend(sv);
    }
    input.value = '';
    render();
  }
  for (const ev of ['pointerdown', 'mousedown', 'click']) input.addEventListener(ev, () => render());
  input.addEventListener('input', () => {
    if (asyncMs) {
      ready = false;
      menu.innerHTML = '';
      clearTimeout(timer);
      timer = setTimeout(() => { ready = true; render(); }, asyncMs);
      return;
    }
    render();
  });
  return { dom, doc, input, get chosen() { return chosen.slice(); } };
}
const singleValue = (doc) => doc.querySelector('.select__single-value')?.textContent || null;
const chips = (doc) => [...doc.querySelectorAll('.select__multi-value')].map((n) => n.textContent);

// A FOREIGN open menu on the same page — the live page has several react-selects plus a 244-item
// phone-country list. Searching the whole document for "any option" is what stopped the async
// typeahead from ever waiting.
const FOREIGN_MENU = `<div class="other-widget"><div class="select__menu">
  <div class="select__option" role="option">Afghanistan +93</div>
  <div class="select__option" role="option">Albania +355</div>
</div></div>`;

test('an async typeahead is WAITED for, even while another widget\'s menu is open', async () => {
  const { dom, doc, input } = reactSelect({
    id: 'candidate-location', label: 'Location (City)', options: FAIRE_TORONTOS,
    asyncMs: 600, extraHtml: FOREIGN_MENU,
  });
  try {
    const ok = await fillCombobox(input, 'Toronto, ON', { locationHint: REAL_PROFILE });
    assert.equal(ok, true, 'the options arrive 600ms after typing — that is a wait, not a miss');
    assert.equal(singleValue(doc), 'Toronto, Ontario, Canada');
  } finally { unmountDom(dom); }
});

test('react-select\'s "No options" NOTICE is never treated as an option', async () => {
  const { dom, doc, input } = reactSelect({ label: 'Which categories describe you?', options: ['Black/of African origin', 'Non-Hispanic, White or Caucasian'] });
  try {
    const ok = await fillCombobox(input, 'Fullstack');
    assert.equal(ok, false, 'nothing matched — and the notice is not a match');
    assert.equal(singleValue(doc), null, 'nothing was committed');
    assert.equal(input.value, '', 'and no text was left behind pretending it was');
  } finally { unmountDom(dom); }
});

test('a Yes/No dropdown whose QUESTION mentions a location still answers Yes', async () => {
  const { dom, doc, input } = reactSelect({ label: HYBRID_Q, options: ['Yes', 'No'] });
  try {
    // The engine decides the cfg from the label — reproduce that decision here.
    const cfg = looksLikeLocationLabel(HYBRID_Q) ? { locationHint: REAL_PROFILE } : {};
    const ok = await fillCombobox(input, 'Yes', cfg);
    assert.equal(ok, true);
    assert.equal(singleValue(doc), 'Yes');
  } finally { unmountDom(dom); }
});

// ---- multi ----------------------------------------------------------------------------------

test('splitMultiValue splits an answer without shredding a comma-bearing option', () => {
  assert.deepEqual(splitMultiValue('Fullstack, Backend, Frontend'), ['Fullstack', 'Backend', 'Frontend']);
  assert.deepEqual(splitMultiValue('Backend and Frontend'), ['Backend', 'Frontend']);
});

test('a "select all that apply" combobox commits every value it can match', async () => {
  const { dom, doc, input } = reactSelect({
    label: 'Which describe you?', multi: true,
    options: ['Fullstack', 'Backend', 'Frontend', 'Mobile'],
  });
  try {
    assert.equal(isMultiCombobox(input), true);
    const ok = await fillCombobox(input, 'Fullstack, Backend, Frontend');
    assert.equal(ok, true);
    assert.deepEqual(chips(doc).sort(), ['Backend', 'Frontend', 'Fullstack']);
  } finally { unmountDom(dom); }
});

test('a multi that matches SOME of its values is a partial answer, not a park', async () => {
  const { dom, doc, input } = reactSelect({ label: 'Which describe you?', multi: true, options: ['Backend', 'Mobile'] });
  try {
    assert.equal(await fillCombobox(input, 'Fullstack, Backend, Frontend'), true);
    assert.deepEqual(chips(doc), ['Backend'], 'one real selection satisfies the question; blank guarantees a park');
  } finally { unmountDom(dom); }
});

test('a multi that matches NOTHING is left exactly as it was found', async () => {
  const { dom, doc, input } = reactSelect({ label: 'Which categories describe you?', multi: true, options: ['Black/of African origin', "I don't wish to answer"] });
  try {
    assert.equal(await fillCombobox(input, 'Fullstack, Backend, Frontend'), false);
    assert.deepEqual(chips(doc), []);
    assert.equal(input.value, '');
  } finally { unmountDom(dom); }
});

// ---- checkbox groups ------------------------------------------------------------------------

const HEAR_GROUP = `
  <form id="application-form">
    <fieldset class="checkbox" id="question_hear[]" aria-required="true">
      <legend class="label">How did you hear about Faire? (Select all that apply) *</legend>
      <div><input type="checkbox" id="h1" name="question_hear[]" value="1" /><label for="h1">Billboard or outdoor advertising</label></div>
      <div><input type="checkbox" id="h2" name="question_hear[]" value="2" /><label for="h2">Job posting on LinkedIn, Indeed, or other job board</label></div>
      <div><input type="checkbox" id="h3" name="question_hear[]" value="3" /><label for="h3">Other</label></div>
    </fieldset>
    <div><input type="checkbox" id="consent" /><label for="consent">I agree to the privacy policy</label></div>
  </form>`;

test('a checkbox GROUP is recognised; a lone consent box is not', () => {
  const dom = mountDom(HEAR_GROUP);
  try {
    const doc = dom.window.document;
    assert.equal(checkboxGroupMembers(doc.getElementById('h1'), doc).length, 3);
    assert.equal(checkboxGroupMembers(doc.getElementById('consent'), doc).length, 0,
      'a bare consent checkbox must keep its "never auto-decide" treatment');
    assert.equal(checkboxGroupLabel(doc.getElementById('h1'), doc).label,
      'How did you hear about Faire? (Select all that apply) *');
  } finally { unmountDom(dom); }
});

test('a group whose every option is marked required is detected as the site contradiction it is', () => {
  const dom = mountDom(HEAR_GROUP.replace(/type="checkbox" id="h/g, 'required type="checkbox" id="h'));
  try {
    const doc = dom.window.document;
    assert.equal(checkboxGroupAllRequired(doc.getElementById('h1'), doc), true,
      'the browser only calls this satisfied when EVERY option is ticked — which would be a lie');
  } finally { unmountDom(dom); }
});

function engineFor(doc) {
  return new AutofillEngine({
    getProfile: async () => ({}), lookupAnswer: async () => null, recordAnswer: async () => {}, log: () => {},
  });
}

test('the named option is ticked — and only that one', async () => {
  const dom = mountDom(HEAR_GROUP);
  try {
    const doc = dom.window.document;
    const engine = engineFor(doc);
    const n = await engine.fill([{ input: doc.getElementById('h1'), label: 'How did you hear about Faire?',
      value: 'Job posting on LinkedIn, Indeed, or other job board' }]);
    assert.equal(n, 1);
    assert.deepEqual([...doc.querySelectorAll('input[type=checkbox]')].filter((b) => b.checked).map((b) => b.id), ['h2'],
      'splitting the answer on its commas must not also claim "Other"');
  } finally { unmountDom(dom); }
});

test('a required checkbox group is surfaced to the answer ladder ONCE, with its options', async () => {
  const dom = mountDom(HEAR_GROUP.replace(/type="checkbox" id="h/g, 'required type="checkbox" id="h'));
  try {
    const doc = dom.window.document;
    const engine = engineFor(doc);
    const unknown = await engine.scanUnknown(doc.getElementById('application-form'));
    const group = unknown.filter((u) => u.fieldType === 'checkbox');
    assert.equal(group.length, 1, 'one question, not one blocker per box');
    assert.match(group[0].label, /How did you hear about Faire/);
    assert.equal(group[0].required, true);
    assert.equal(group[0].options.length, 3);
    assert.ok(!unknown.some((u) => u.input && u.input.id === 'consent'), 'the consent box is still never auto-decided');
  } finally { unmountDom(dom); }
});

// =============================================================================================
// Voluntary demographic questions the site marks REQUIRED
// =============================================================================================

test('a demographic question is recognised structurally, not just by its wording', () => {
  const dom = mountDom(`<div id="demographic-section">
      <label for="cat">Which categories describe you? Select all that apply to you:</label>
      <input id="cat" role="combobox" />
    </div>
    <div><label for="nm">First Name</label><input id="nm" /></div>`);
  try {
    const doc = dom.window.document;
    assert.equal(isDemographicField(doc.getElementById('cat'), 'Which categories describe you?'), true,
      'names no protected class — which is exactly how the AI came to answer it with job functions');
    assert.equal(isDemographicField(doc.getElementById('nm'), 'First Name'), false);
    assert.equal(isDemographicField(null, 'How do you currently describe your gender identity?'), true);
  } finally { unmountDom(dom); }
});

test('the decline candidates put the field\'s OWN wording first', () => {
  const own = declineAnswerCandidates(['Black/of African origin', "I don't wish to answer"]);
  assert.equal(own[0], "I don't wish to answer");
  assert.ok(declineAnswerCandidates(null).length > 0, 'a combobox publishes no options — try the common phrasings');
});

test('declining commits, and it is the ONLY thing a demographic field is ever answered with', async () => {
  const { dom, doc, input } = reactSelect({
    label: 'How do you currently describe your gender identity?', multi: true,
    options: ['Man, male or masculine', 'Woman, female or feminine', "I don't wish to answer"],
  });
  try {
    let used = null;
    for (const cand of declineAnswerCandidates(null)) {
      if (await fillCombobox(input, cand)) { used = cand; break; }
    }
    assert.equal(used, "I don't wish to answer");
    assert.deepEqual(chips(doc), ["I don't wish to answer"],
      'never a substantive self-identification — only the site\'s own decline option');
  } finally { unmountDom(dom); }
});
