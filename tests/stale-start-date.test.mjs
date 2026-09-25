// A START DATE IN THE PAST IS ALWAYS WRONG.
//
// Live in his bank on 2026-09-06: FOURTEEN start-date answers holding dates already gone, and every
// one of them would have been served.
//
//     2026-07-11   "date you can start"
//     2026-07-20   "what date would you be available to onboard with geotab"
//     2026-07-23   "earliest start date"
//     2026-08-26   "what is your desired start date"
//
// Each was true on the day it was captured, which is exactly why nothing caught it. The shape gate
// asks whether a date answers a date question, and it does. An application saying he can start two
// months ago reads as carelessness to a recruiter, and a form that validates the field rejects it
// outright.
//
// Found by running the app's OWN answer audit (GET /qa/audit) against the live bank rather than
// writing another ad-hoc one. It classifies 4,545 rows as 3,055 ok, 965 junk, 277 broken, 248
// needing review. Of the 277 it calls broken, ZERO would be served: the shape gate already contains
// every one. These fourteen it did not call broken at all, because the shape is genuinely fine.
//
// The rule lives in answer-shape because two paths need it and only one has recall in it: recallOk
// covers qaLookup, profileFieldLookup and /qa/lookup; the autofill bundle has no recall and gets it
// wired separately. That split is the same one that let the salary floor miss two paths tonight.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const shape = require(path.join(here, '..', 'app', 'src', 'answer-shape.js'));

const TODAY = new Date('2026-09-06T12:00:00Z');
const stale = (q, a) => shape.staleStartDate(q, a, TODAY);

// Every question here is a real row from his bank.
test('a start date that has already passed is refused', () => {
  for (const [q, a] of [
    ['date you can start', '2026-07-11'],
    ['date you can start * yyyy-mm-dd', '2026-07-11'],
    ['ideal start date', '2026-07-11'],
    ['what is your first available date to start training', '2026-07-11'],
    ['what is your your first available start date', '2026-07-11'],
    ['earliest start date', '2026-07-23'],
    ['earliest start date?* * yyyy-mm-dd', '2026-07-23'],
    ['what is your earliest available start date? * yyyy-mm-dd', '2026-07-22'],
    ['what is your desired start date', '2026-08-26'],
    ['date available * yyyy-mm-dd', '2026-08-26'],
    ['what date would you be available to onboard with geotab', '2026-07-20'],
  ]) {
    assert.equal(stale(q, a), true, `already gone: ${q} = ${a}`);
  }
});

test('a start date still ahead is fine, and so is today', () => {
  assert.equal(stale('earliest start date', '2026-12-01'), false);
  assert.equal(stale('what is your desired start date', '2027-01-15'), false);
  assert.equal(stale('date available', '2026-09-06'), false, 'today is not the past');
});

// ---------------------------------------------------------------------------
// dates that are CORRECTLY in the past
//
// This is the half that decides whether the rule is safe to apply at all. Widen the question
// pattern carelessly and it starts refusing his degree and his date of birth.
// ---------------------------------------------------------------------------
test('a date that is supposed to be in the past is untouched', () => {
  for (const [q, a] of [
    ['what is your date of birth', '1999-04-02'],
    ['date of birth * yyyy-mm-dd', '1999-04-02'],
    ['when did you graduate', '2023-06-01'],
    ['graduation date', '2023-06-01'],
    ['what date did you start your current role', '2024-02-01'],
    ['end date of your last position', '2025-11-30'],
    // Live rows. A past "today's date" is a stale capture, not a claim about when he can start,
    // and this rule is about availability.
    ["today's date * yyyy-mm-dd", '2026-07-11'],
    ['select date', '2026-07-11'],
    ['date * yyyy-mm-dd', '2026-07-11'],
  ]) {
    assert.equal(stale(q, a), false, `must stay answerable: ${q} = ${a}`);
  }
});

test('only ISO dates are judged, because anything else is ambiguous', () => {
  // "03/04/2026" is March or April depending on the form's locale. Guessing wrong turns a valid
  // answer into a refused one, so those are left alone entirely.
  assert.equal(stale('date available', '03/04/2026'), false);
  assert.equal(stale('earliest start date', '11/07/2026'), false);
  assert.equal(stale('earliest start date', '2 weeks from offer'), false, 'prose is not a date');
  assert.equal(stale('earliest start date', 'Immediately'), false);
  assert.equal(stale('earliest start date', ''), false);
  assert.equal(stale('earliest start date', null), false);
});

test('a question that is not about starting is never judged', () => {
  assert.equal(stale('how many years of experience do you have?', '2026-07-11'), false);
  assert.equal(stale('what is your postal code?', '2026-07-11'), false);
});
