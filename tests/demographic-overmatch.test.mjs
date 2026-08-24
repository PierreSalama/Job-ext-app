// A PRIVACY NOTICE IS NOT A DEMOGRAPHIC QUESTION.
//
// v11.124.0 added STRUCTURAL demographic detection because "Which categories describe you? Select
// all that apply to you:" names no protected class at all — the label gives nothing away, and the
// AI had answered a list of ethnicities with "Fullstack, Backend, Frontend". Asking "what container
// is this field in" is the right question for that field.
//
// It is the wrong question for everything ELSE an ATS renders in that same block. Live 2026-08-24
// hootsuite parked on:
//
//   "I have read the privacy notice and consent to the processing of my personal data…"
//   reason: "voluntary demographic question with no decline option — your call"
//
// A consent checkbox has no decline option because it is not a question. Parking it stops the whole
// application on a box that only ever needed ticking.
//
// The discriminator is linguistic: a consent statement asserts that the CANDIDATE has read / agrees
// to / acknowledges a NOTICE, POLICY or TERMS; a demographic question asks what the candidate IS.
// It is checked AFTER the protected-class label test, so it can only ever release a field whose
// label gives no protected-class reason to hold it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const autofillUrl = pathToFileURL(path.join(here, '..', 'extension', 'content', 'autofill.js')).href;

let isDemographicField;
let doc;
test.before(async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="demographic-section">
      <label for="cat">Which categories describe you? Select all that apply to you:</label>
      <select id="cat"><option>Select...</option></select>

      <label for="gid">How do you currently describe your gender identity?</label>
      <select id="gid"><option>Select...</option></select>

      <!-- the hootsuite case: a consent checkbox living inside the demographic block -->
      <label for="priv">I have read the privacy notice and consent to the processing of my personal data for recruitment purposes</label>
      <input type="checkbox" id="priv" />

      <label for="terms">By selecting I agree, I understand my information will be processed in accordance with the candidate privacy policy</label>
      <input type="checkbox" id="terms" />
    </div>
    <div id="ordinary">
      <label for="nm">First Name</label><input id="nm" />
    </div>
  </body>`, { url: 'https://job-boards.greenhouse.io/hootsuite/jobs/1' });
  for (const k of ['window', 'document', 'Element', 'Node', 'HTMLElement', 'NodeFilter', 'getComputedStyle']) {
    globalThis[k] = dom.window[k];
  }
  globalThis.CSS = dom.window.CSS || { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') };
  doc = dom.window.document;
  ({ isDemographicField } = await import(autofillUrl));
});

test('THE BUG: a privacy-notice consent inside the demographic block is NOT demographic', () => {
  assert.equal(
    isDemographicField(doc.getElementById('priv'),
      'I have read the privacy notice and consent to the processing of my personal data for recruitment purposes'),
    false);
});

test('...and neither is the "by selecting I agree" candidate-privacy variant', () => {
  assert.equal(
    isDemographicField(doc.getElementById('terms'),
      'By selecting I agree, I understand my information will be processed in accordance with the candidate privacy policy'),
    false);
});

test('THE PROTECTION SURVIVES: "Which categories describe you?" is still caught structurally', () => {
  assert.equal(
    isDemographicField(doc.getElementById('cat'), 'Which categories describe you? Select all that apply to you:'),
    true,
    'it names no protected class — the container is the only thing that gives it away');
});

test('a label that names a protected class is demographic wherever it lives', () => {
  assert.equal(isDemographicField(null, 'How do you currently describe your gender identity?'), true);
  assert.equal(isDemographicField(doc.getElementById('nm'), 'Please select your race/ethnicity'), true);
  assert.equal(isDemographicField(null, 'Are you a protected veteran?'), true);
  // ...and the escape hatch cannot release one, however consent-ish the wording is.
  assert.equal(
    isDemographicField(doc.getElementById('gid'),
      'I agree to voluntarily self-identify my gender identity for reporting purposes'),
    true,
    'a protected class named in the label always wins over the consent phrasing');
});

test('an ordinary field outside the block is unaffected', () => {
  assert.equal(isDemographicField(doc.getElementById('nm'), 'First Name'), false);
});
