// "BLOCKED THE APPLICATION — COULD NOT FILL THE ANSWER": the radio never actually commits.
//
// 19 live tasks (Aug 3–8) are FULLY ANSWERED — memory holds every answer they ask for — yet they
// stay parked. Re-posting the answers is a no-op because nothing is missing: the failure is
// MECHANICAL. The extension could not click a radio.
//
// Root cause: setValueRaw() writes text inputs through the NATIVE value setter precisely so
// React's change tracker sees the write. The radio and checkbox branches of fill() did not —
// they assigned `el.checked = true` directly. That bypasses React's `checked` tracker, so React
// re-renders its own unchanged state and the selection reverts. The group still reads as
// unanswered and the form refuses to advance.
//
// This is the same FAMILY as the earlier LinkedIn/smartapply fix (0×0 hidden radios made
// invisible to the scanner) but a different failure: there the control was never seen, here it
// is seen, "set", and silently undone.
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
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0 };
  };
  for (const k of ['window', 'document', 'Element', 'Node', 'HTMLElement', 'NodeFilter', 'getComputedStyle']) globalThis[k] = dom.window[k];
  globalThis.CSS = dom.window.CSS || { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') };
  af = await import(pathToFileURL(path.join(here, '..', 'extension', 'content', 'autofill.js')).href);
});

function mount(html) {
  dom.window.document.body.innerHTML = `<form>${html}</form>`;
  return dom.window.document.querySelector('form');
}

const YESNO = `<fieldset><legend>Are you legally authorized to work in Canada?</legend>
  <label for="y"><input type="radio" id="y" name="auth" value="yes"> Yes</label>
  <label for="n"><input type="radio" id="n" name="auth" value="no"> No</label>
</fieldset>`;

test('a plain radio commits', () => {
  mount(YESNO);
  const yes = dom.window.document.getElementById('y');
  assert.equal(af.setNativeChecked(yes, true), true);
  assert.equal(yes.checked, true);
});

// Simulate React's controlled input: it reverts any `checked` write that did not come through
// the native setter it patched, and only accepts state changes originating from a real click.
function makeControlled(input) {
  let reactState = false;
  const proto = Object.getPrototypeOf(input);
  const nativeDesc = Object.getOwnPropertyDescriptor(proto, 'checked')
    || Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'checked');
  Object.defineProperty(input, 'checked', {
    configurable: true,
    get() { return reactState; },
    set(v) { /* a direct assignment is swallowed — React owns this value */ },
  });
  input.addEventListener('click', () => { reactState = true; });
  return { nativeDesc, get state() { return reactState; } };
}

test('a REACT-CONTROLLED radio still ends up checked (the live failure)', () => {
  mount(YESNO);
  const yes = dom.window.document.getElementById('y');
  const ctl = makeControlled(yes);

  // the OLD behaviour, reproduced exactly: a direct assignment + synthetic events
  yes.checked = true;
  yes.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  yes.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.equal(yes.checked, false, 'a direct .checked write is silently reverted — the live bug');

  // the fix: verified, with a real click as the fallback
  assert.equal(af.setNativeChecked(yes, true), true, 'setNativeChecked must make it stick');
  assert.equal(yes.checked, true);
  assert.equal(ctl.state, true, 'the widget itself registered the selection');
});

test('a 0x0 / visually-hidden radio is committed via its styled label', () => {
  mount(`<fieldset><legend>Do you require sponsorship?</legend>
    <input type="radio" id="hy" name="spon" value="yes" style="opacity:0;width:0;height:0">
    <label for="hy">Yes</label>
  </fieldset>`);
  const hidden = dom.window.document.getElementById('hy');
  makeControlled(hidden);
  assert.equal(af.setNativeChecked(hidden, true), true, 'the label click must reach the input');
  assert.equal(hidden.checked, true);
});

test('fill() reports an UNCOMMITTABLE radio as a failure, never as filled', async () => {
  mount(YESNO);
  const yes = dom.window.document.getElementById('y');
  // a radio that refuses every route — neither assignment nor click changes it
  Object.defineProperty(yes, 'checked', { configurable: true, get() { return false; }, set() {} });
  const engine = new af.AutofillEngine({
    getProfile: async () => ({}), lookupAnswer: async () => null, recordAnswer: async () => null,
  });
  const outcomes = [];
  const n = await engine.fill([{ input: yes, label: 'Are you legally authorized to work in Canada?', value: 'Yes' }],
    (o) => outcomes.push(o.outcome));
  assert.equal(n, 0, 'an uncommitted radio is not a fill');
  assert.ok(!outcomes.includes('filled'), `outcomes: ${outcomes.join(',')}`);
  assert.ok(outcomes.includes('skipped-radio-uncommitted'), `outcomes: ${outcomes.join(',')}`);
});

test('fill() commits a normal radio end to end', async () => {
  mount(YESNO);
  const yes = dom.window.document.getElementById('y');
  const engine = new af.AutofillEngine({
    getProfile: async () => ({}), lookupAnswer: async () => null, recordAnswer: async () => null,
  });
  const outcomes = [];
  const n = await engine.fill([{ input: yes, label: 'Are you legally authorized to work in Canada?', value: 'Yes' }],
    (o) => outcomes.push(o.outcome));
  assert.equal(n, 1);
  assert.deepEqual(outcomes, ['filled']);
  assert.equal(yes.checked, true);
});
