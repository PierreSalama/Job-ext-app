// YES/NO QUESTIONS FILLED WITH RAW PROFILE STRINGS.
//
// Every row below is a real stored answer from the live database. All are wrong:
//
//   will_you_now_or_in_the_future_require_sponsorship…                 'Canada'   → No
//   do_you_have_the_unrestricted_right_to_work_in_the_country…         'Canada'   → Yes
//   are_you_legally_authorized_to_work_in_the_region…                  'Authorized to work in
//                                                       Canada (no sponsorship required)' → Yes
//   will_you_now_or_at_any_point…require_visa_sponsorship_to_work…     same string → No
//   are_you_currently_located_in_canada                     'Toronto, Canada'     → Yes
//   this_is_a_remote_position…where_are_you_currently_located          'Yes'      → a location
//   are_there_any_post_employment_restrictions…                        'Tacel'    → Yes/No
//
// THE POLARITY TRAP: "Yes" to *will you require sponsorship* is exactly as damaging as "No"
// to *are you authorized* — both screen the applicant out on a false statement. Both
// directions are tested here.
//
// Two layers produce these values and both are covered:
//   • extension/content/autofill.js profileFieldFor() — matched a screening SENTENCE on an
//     incidental word ("…in the COUNTRY where…" → profile.country) and pasted the string in.
//   • app/src/ai/deterministic.js — the no-model answer floor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const det = require(path.join(here, '..', 'app', 'src', 'ai', 'deterministic.js'));
const shape = require(path.join(here, '..', 'app', 'src', 'answer-shape.js'));

let profileFieldFor_expectsYesNo, autofill, dom;
// ONE jsdom for the whole file. autofill.js (via lib/dom.js) closes over the globals present at
// import time, so mounting a form in a SECOND jsdom yields elements that the visibility checks
// reject — every scan then returns zero fields and a "nothing was filled" assertion passes
// vacuously. Mount into this one document instead.
function mountForm(html) {
  dom.window.document.body.innerHTML = `<form>${html}</form>`;
  return dom.window.document.querySelector('form');
}
test.before(async () => {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.com/' });
  // jsdom has no layout engine, so getBoundingClientRect() is all zeros and isProbablyVisible()
  // rejects every element — the engine would see zero fields and each "nothing was filled"
  // assertion would pass for the wrong reason. Give elements a non-zero box.
  dom.window.Element.prototype.getBoundingClientRect = function () {
    return { width: 120, height: 24, top: 0, left: 0, right: 120, bottom: 24, x: 0, y: 0 };
  };
  for (const k of ['window', 'document', 'Element', 'Node', 'HTMLElement', 'NodeFilter', 'getComputedStyle']) globalThis[k] = dom.window[k];
  globalThis.CSS = dom.window.CSS || { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') };
  autofill = await import(pathToFileURL(path.join(here, '..', 'extension', 'content', 'autofill.js')).href);
  profileFieldFor_expectsYesNo = autofill.expectsYesNo;
});

// ---------------------------------------------------------------------------
// profileFieldFor — the unit that produced 'Canada' for a work-authorization question
// ---------------------------------------------------------------------------

test('UNIT: profileFieldFor declines every boolean screening question', () => {
  for (const q of [Q_REQUIRE_SPONSOR, Q_REQUIRE_VISA_CA, Q_UNRESTRICTED, Q_AUTHORIZED, Q_LOCATED_CA, Q_POST_EMPLOYMENT]) {
    const hit = autofill.profileFieldFor(q, FLAT);
    assert.equal(hit, null, `"${q}" → ${hit && `${hit.field}="${hit.value}"`}`);
  }
});

test('UNIT: profileFieldFor still answers plain identity labels', () => {
  assert.deepEqual(autofill.profileFieldFor('Country', FLAT), { field: 'country', value: 'Canada' });
  assert.deepEqual(autofill.profileFieldFor('City', FLAT), { field: 'city', value: 'Toronto' });
  assert.deepEqual(autofill.profileFieldFor('Province / State', FLAT), { field: 'state', value: 'Ontario' });
});

test('UNIT: a boolean field IS filled when the profile value is itself a boolean', () => {
  assert.deepEqual(autofill.profileFieldFor(Q_REQUIRE_SPONSOR, { ...FLAT, country: 'No' }),
    { field: 'country', value: 'No' });
});

// Pierre's real profile shape.
const PROFILE = {
  data: {
    city: 'Toronto', region: 'Ontario', country: 'Canada', location: 'Toronto, Canada',
    workAuthorization: 'Authorized to work in Canada (no sponsorship required)',
    sponsorshipRequired: 'Authorized to work in Canada (no sponsorship required)',
  },
};
// The flat shape the extension's profileFieldFor() sees (it keys province as `state`).
const FLAT = { ...PROFILE.data, state: 'Ontario' };

// ---- the real question strings ----
const Q_REQUIRE_SPONSOR = "Will you now or in the future require sponsorship for employment visa status in the country where you're applying?";
const Q_REQUIRE_VISA_CA = 'Will you now or at any point in the future require visa sponsorship to work in Canada?';
const Q_UNRESTRICTED = 'Do you have the unrestricted right to work in the country where this role is located?';
const Q_AUTHORIZED = 'Are you legally authorized to work in the region where this role is located?';
const Q_LOCATED_CA = 'Are you currently located in Canada?';
const Q_WHERE_REMOTE = 'This is a remote position. Where are you currently located?';
const Q_POST_EMPLOYMENT = 'Are there any post-employment restrictions from your current employer?';

// ---------------------------------------------------------------------------
// SHAPE CLASSIFICATION
// ---------------------------------------------------------------------------

test('the yes/no questions are recognised as boolean, and the location question is not', () => {
  for (const q of [Q_REQUIRE_SPONSOR, Q_REQUIRE_VISA_CA, Q_UNRESTRICTED, Q_AUTHORIZED, Q_LOCATED_CA, Q_POST_EMPLOYMENT]) {
    assert.equal(shape.questionShape(q), 'yesno', `expected yes/no: ${q}`);
    assert.equal(profileFieldFor_expectsYesNo(q), true, `extension side, expected yes/no: ${q}`);
  }
  // the inverse: a location prompt with a statement preamble must NOT read as boolean
  assert.equal(shape.questionShape(Q_WHERE_REMOTE), 'location');
  assert.equal(profileFieldFor_expectsYesNo(Q_WHERE_REMOTE), false);
});

// ---------------------------------------------------------------------------
// THE DETERMINISTIC FLOOR — polarity, both directions
// ---------------------------------------------------------------------------

test('POLARITY: "will you REQUIRE sponsorship" is answered No', () => {
  for (const q of [Q_REQUIRE_SPONSOR, Q_REQUIRE_VISA_CA]) {
    const r = det.answer(q, { profile: PROFILE });
    assert.ok(r, `must answer: ${q}`);
    assert.equal(r.answer, 'No', `${q} → ${r.answer}`);
  }
});

test('POLARITY: "are you AUTHORIZED / do you have the RIGHT to work" is answered Yes', () => {
  for (const q of [Q_UNRESTRICTED, Q_AUTHORIZED]) {
    const r = det.answer(q, { profile: PROFILE });
    assert.ok(r, `must answer: ${q}`);
    assert.equal(r.answer, 'Yes', `${q} → ${r.answer}`);
  }
});

test('the negation bug is fixed: "(no sponsorship required)" no longer reads as NOT authorized', () => {
  // The old rule tested /\b(not authorized|no\b|require|need.*visa|sponsor)\b/ against the
  // profile string, and Pierre's own value trips \bno\b, `require` AND `sponsor` — so the
  // profile that says he IS authorized was read as saying he is NOT.
  const r = det.answer('Are you legally authorized to work?', { profile: PROFILE });
  assert.ok(r);
  assert.equal(r.answer, 'Yes');
});

test('an applicant who DOES need sponsorship gets the opposite pair', () => {
  const needs = { data: { workAuthorization: 'Requires visa sponsorship', sponsorshipRequired: 'Yes' } };
  assert.equal(det.answer(Q_REQUIRE_SPONSOR, { profile: needs }).answer, 'Yes');
  assert.equal(det.answer(Q_UNRESTRICTED, { profile: needs }).answer, 'No');
});

test('no work-authorization on file → park, never guess', () => {
  const blank = { data: { city: 'Toronto', country: 'Canada' } };
  assert.equal(det.answer(Q_REQUIRE_SPONSOR, { profile: blank }), null);
  assert.equal(det.answer(Q_AUTHORIZED, { profile: blank }), null);
});

test('a boolean question is NEVER answered with a profile string', () => {
  for (const q of [Q_REQUIRE_SPONSOR, Q_REQUIRE_VISA_CA, Q_UNRESTRICTED, Q_AUTHORIZED, Q_LOCATED_CA, Q_POST_EMPLOYMENT]) {
    const r = det.answer(q, { profile: PROFILE });
    if (r) assert.ok(shape.looksYesNo(r.answer), `${q} → "${r.answer}" is not a boolean`);
  }
});

test('"are you currently located in Canada?" is Yes, not "Toronto, Canada"', () => {
  const r = det.answer(Q_LOCATED_CA, { profile: PROFILE });
  assert.ok(r);
  assert.equal(r.answer, 'Yes');
});

test('the INVERSE: a location question is answered with a location, never "Yes"', () => {
  const r = det.answer(Q_WHERE_REMOTE, { profile: PROFILE });
  assert.ok(r, 'the remote-preamble location question must still be answerable');
  assert.notEqual(r.answer, 'Yes');
  assert.match(r.answer, /Toronto/i);
});

test('a "remote"-flavoured location prompt with no wh-word is not swallowed by the relocation rule', () => {
  const r = det.answer('Please confirm your current location for this remote role.', { profile: PROFILE });
  if (r) assert.notEqual(r.answer, 'Yes', 'the relocation catch-all must not answer a place question');
});

test('a genuine relocation question is still answered Yes', () => {
  const r = det.answer('Are you willing to relocate for this role?', { profile: PROFILE });
  assert.ok(r);
  assert.equal(r.answer, 'Yes');
});

// ---------------------------------------------------------------------------
// THE EXTENSION LADDER — profileFieldFor must decline boolean fields
// ---------------------------------------------------------------------------

// Sanity guard for the harness itself: if the engine cannot see fields in this document at
// all, every "nothing was filled" assertion below would pass for the wrong reason.
test('HARNESS: the engine really does see and fill fields in this document', async () => {
  const form = mountForm('<label for="c">Country</label><input id="c" name="c" type="text">');
  const engine = new autofill.AutofillEngine({
    getProfile: async () => FLAT, lookupAnswer: async () => null, recordAnswer: async () => null,
  });
  const sugg = await engine.scanFillable(form);
  assert.equal(sugg.length, 1, 'the harness must be able to fill a plain Country field');
});

test('profileFieldFor never pastes a profile string into a Yes/No field', async () => {
  // profileFieldFor is module-private; exercise it through the AutofillEngine's scanFillable.
  const form = mountForm([Q_REQUIRE_SPONSOR, Q_UNRESTRICTED, Q_AUTHORIZED, Q_LOCATED_CA]
    .map((q, i) => `<label for="f${i}">${q}</label><input id="f${i}" name="f${i}" type="text">`).join(''));
  const engine = new autofill.AutofillEngine({
    getProfile: async () => FLAT,
    lookupAnswer: async () => null,          // memory empty → only the profile ladder can fill
    recordAnswer: async () => null,
  });
  const sugg = await engine.scanFillable(form);
  for (const s of sugg) {
    assert.fail(`a boolean screening question was filled from the profile: "${s.label}" → "${s.value}"`);
  }
});

test('profileFieldFor still fills ordinary identity fields', async () => {
  const form = mountForm('<label for="c">Country</label><input id="c" name="c" type="text">'
    + '<label for="t">City</label><input id="t" name="t" type="text">');
  const engine = new autofill.AutofillEngine({
    getProfile: async () => FLAT, lookupAnswer: async () => null, recordAnswer: async () => null,
  });
  const sugg = await engine.scanFillable(form);
  const byField = Object.fromEntries(sugg.map((s) => [s.field, s.value]));
  assert.equal(byField.country, 'Canada', 'a plain "Country" field must still be filled');
  assert.equal(byField.city, 'Toronto');
});

test('a profile field that genuinely holds Yes/No still fills a boolean field', async () => {
  const form = mountForm('<label for="s">Will you require sponsorship?</label><input id="s" name="s" type="text">');
  const engine = new autofill.AutofillEngine({
    getProfile: async () => ({ ...FLAT, sponsorshipRequired: 'No' }),
    lookupAnswer: async () => null, recordAnswer: async () => null,
  });
  const sugg = await engine.scanFillable(form);
  assert.equal(sugg.length, 1);
  assert.equal(sugg[0].value, 'No');
});
