// The learned-answer store must never be keyed by junk. Measured on the LIVE store:
// 143 of 2,576 saved answers (6%) are keyed by React element ids ("rn", "r1s", "r20"),
// bare field names ("name", "email", "city") or option text ("yes", "oui", "easy apply").
// They get written when a control has no resolvable label and fieldLabel() falls back to
// input.name / the element id.
//
// Why it matters: the server's qaLookup is FUZZY, so a key like "city" or "name" can later
// match a real screening question and answer it with the WRONG value on a real application —
// a junk-keyed store is worse than an empty one.
//
// The strings below are REAL samples taken from the live store, plus real questions from the
// same store that must keep being learned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const autofillUrl = pathToFileURL(path.join(here, '..', 'extension', 'content', 'autofill.js')).href;

let isJunkQuestionKey;
test.before(async () => {
  // autofill.js touches DOM globals at import time via its transitive lib/dom import.
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.com/' });
  for (const k of ['window', 'document', 'Element', 'Node', 'HTMLElement', 'NodeFilter', 'getComputedStyle']) {
    globalThis[k] = dom.window[k];
  }
  globalThis.CSS = dom.window.CSS || { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') };
  ({ isJunkQuestionKey } = await import(autofillUrl));
});

// REAL junk keys observed in the live store.
const JUNK = [
  'rn', 'r1s', 'r1t', 'r1u', 'r1v', 'r20', 'r2c', 'r10', 'r23', 'r2g',
  'easy apply', 'name', 'email', 'city', 'oui',
  'yes', 'no', 'submit', 'continue', 'next',
  '«rj»', '«r9»',
  'q_1a2b3c4d5e6f7a8b',
];

// REAL questions from the same store — these MUST still be learned.
const REAL = [
  'have you previously worked at stackadapt',
  'are you willing to relocate',
  'do you have understanding of object oriented programming concepts and design patterns',
  'do you have understanding of rest over http',
  'are you comfortable with a hybrid work arrangement requiring 1 2 days per week in the office',
  'how many years of experience do you have as a software engineer',
  'what is your annual gross salary expectation?',
  'are you legally authorized to work in canada?',
  'combien d’années d’expérience avez-vous dans un rôle similaire ?',
];

test('junk keys from the live store are refused', () => {
  for (const k of JUNK) {
    assert.equal(isJunkQuestionKey(k), true, `should be refused as a question key: ${JSON.stringify(k)}`);
  }
});

test('real screening questions from the live store are still learned', () => {
  for (const q of REAL) {
    assert.equal(isJunkQuestionKey(q), false, `must remain learnable: ${JSON.stringify(q)}`);
  }
});

test('blank / whitespace / null are refused', () => {
  for (const k of ['', '   ', null, undefined]) {
    assert.equal(isJunkQuestionKey(k), true, `should be refused: ${JSON.stringify(k)}`);
  }
});
