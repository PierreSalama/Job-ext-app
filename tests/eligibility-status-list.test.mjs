// A Yes/No grounded answer is only meaningful if the control can EXPRESS Yes/No.
//
// Work-authorization screens are often a STATUS LIST — "Canadian Citizen / Permanent Resident /
// Open Work Permit / Other" — with no yes-or-no option. The executor derives yesText from the
// options and falls back to the literal 'Yes', so groundedEligibilityAnswer would return "Yes" for
// a group that has no such option: a wrong answer to a LEGAL question about a real person, where a
// fuzzy match could land on an arbitrary immigration status.
//
// Live 2026-07-25 on Pierre's machine, "Work authorization in Canada*" resolved to "Yes" against
// exactly such a list. Knowing someone is authorized to work does NOT tell us WHICH status they
// hold — the honest outcome is to park and let the user answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { groundedEligibilityAnswer, isEligibilityScreeningQuestion } from '../extension/content/lib/linkedin-apply.js';

const AUTH = { authorizedToWork: true, yesText: 'Yes', noText: 'No' };

test('a status list is NEVER answered with Yes/No — it parks for the user', () => {
  const statusOptions = ['Canadian Citizen', 'Permanent Resident', 'Open Work Permit', 'Other'];
  assert.equal(
    groundedEligibilityAnswer('Work authorization in Canada*', { ...AUTH, options: statusOptions }),
    null,
    'we know they are authorized, but not WHICH status — must not guess',
  );
  assert.equal(
    groundedEligibilityAnswer('Are you legally authorized to work?', { ...AUTH, options: ['Citizen', 'PR', 'Work Permit'] }),
    null,
  );
});

test('a real Yes/No control still gets the grounded answer', () => {
  assert.equal(groundedEligibilityAnswer('Are you legally authorized to work in Canada?',
    { ...AUTH, options: ['Yes', 'No'] }), 'Yes');
  assert.equal(groundedEligibilityAnswer('Will you now or in the future require sponsorship?',
    { ...AUTH, options: ['Yes', 'No'] }), 'No');
});

test('localized Yes/No options are recognised as answerable', () => {
  assert.equal(groundedEligibilityAnswer('Avez-vous le droit de travailler au Canada ?',
    { authorizedToWork: true, yesText: 'Oui', noText: 'Non', options: ['Oui', 'Non'] }), 'Oui');
  assert.equal(groundedEligibilityAnswer('¿Está autorizado a trabajar?',
    { authorizedToWork: true, yesText: 'Sí', noText: 'No', options: ['Sí', 'No'] }), 'Sí');
});

test('a free-text field (no options) keeps the previous behaviour', () => {
  // No options to inspect → the guard must not block the answer.
  assert.equal(groundedEligibilityAnswer('Are you authorized to work in Canada?', AUTH), 'Yes');
});

test('the French NOUN phrasing is recognised (not just "autorisé à travailler")', () => {
  // Real blocking question from the live queue — the regex only covered the verb form.
  const q = "Avez-vous l'autorisation légale de travailler au Canada ?";
  assert.ok(isEligibilityScreeningQuestion(q), 'must be detected as an eligibility question');
  assert.equal(groundedEligibilityAnswer(q, { ...AUTH, options: ['Oui', 'Non'], yesText: 'Oui' }), 'Oui');
});

test('ability-to-perform is also gated by the status-list guard', () => {
  // It normally answers Yes regardless of work auth, but not into a list that cannot express Yes.
  assert.equal(groundedEligibilityAnswer('Are you able to perform the duties of this position?',
    { ...AUTH, options: ['Full-time', 'Part-time', 'Contract'] }), null);
  assert.equal(groundedEligibilityAnswer('Are you able to perform the duties of this position?',
    { ...AUTH, options: ['Yes', 'No'] }), 'Yes');
});
