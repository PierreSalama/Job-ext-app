// JAT v11 — FIX 1: advance-blocked screening questions (the #1 remaining cap on the rate).
//
// ROOT CAUSE (confirmed live, Webisoft new full-page Easy Apply): on the "Additional
// Questions" page a REQUIRED screening field (a Yes/No radio, a dropdown, or a text field)
// was left UNANSWERED, so LinkedIn refused to advance (Review → page did not change) and the
// executor just re-clicked Review and gave up "stuck — page stopped advancing". The fix
// re-scans the page for the unanswered required field, ANSWERS it (profile/qa → AI → grounded
// eligibility default), retries the advance, and PARKS honestly only what it can't answer.
//
// These tests pin the PURE pieces that decide answer-vs-park and ground the well-known
// work-eligibility screening questions. All pure — no browser/DOM needed (so they run in the
// wired suite + CI without jsdom).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groundedEligibilityAnswer,
  isEligibilityScreeningQuestion,
  decideAnswerOrPark,
} from '../extension/content/lib/linkedin-apply.js';

// ---- isEligibilityScreeningQuestion: recognises the determinable work-auth/sponsorship Qs ----
test('isEligibilityScreeningQuestion: matches the well-known work-eligibility screening questions', () => {
  for (const q of [
    'Are you legally authorized to work in Canada?',
    'Are you authorized to work in the United States?',
    'Do you have the right to work in the UK?',
    'Are you eligible to work in this country?',
    'Will you now or in the future require sponsorship for employment visa status?',
    'Do you require visa sponsorship to work here?',
  ]) {
    assert.equal(isEligibilityScreeningQuestion(q), true, `expected eligibility: "${q}"`);
  }
});

// i18n: Indeed smartapply screening questions are often French (or Spanish). Once the prompt is
// recovered, the grounded default must still recognise + answer them across language.
test('isEligibilityScreeningQuestion: matches French + Spanish work-eligibility questions', () => {
  for (const q of [
    'Êtes-vous légalement autorisé à travailler au Canada?',
    'Êtes-vous autorisée à travailler au Canada pour tout employeur?',
    'Avez-vous le droit de travailler au Canada?',
    'Aurez-vous besoin d’un parrainage pour un visa de travail, maintenant ou à l’avenir?',
    'Avez-vous besoin de parrainage?',
    '¿Está autorizado para trabajar en este país?',
    '¿Tiene derecho a trabajar aquí?',
  ]) {
    assert.equal(isEligibilityScreeningQuestion(q), true, `expected eligibility: "${q}"`);
  }
});

test('groundedEligibilityAnswer: French — authorized user answers Oui to "autorisé à travailler", Non to "parrainage"', () => {
  assert.equal(
    groundedEligibilityAnswer('Êtes-vous autorisé à travailler au Canada?', { authorizedToWork: true, yesText: 'Oui', noText: 'Non' }),
    'Oui',
  );
  assert.equal(
    groundedEligibilityAnswer('Aurez-vous besoin d’un parrainage pour un visa de travail?', { authorizedToWork: true, yesText: 'Oui', noText: 'Non' }),
    'Non',
  );
});

test('isEligibilityScreeningQuestion: does NOT match non-eligibility questions (left to profile/qa/AI)', () => {
  for (const q of [
    'Are you comfortable commuting to this job’s location?',
    'How many years of experience do you have with React?',
    'What is your notice period?',
    'What is your expected salary?',
    'Why do you want to work here?',
    '',
  ]) {
    assert.equal(isEligibilityScreeningQuestion(q), false, `expected NOT eligibility: "${q}"`);
  }
});

// ---- groundedEligibilityAnswer: truthful defaults from the user's stated authorization ----
test('groundedEligibilityAnswer: authorized user → Yes to "authorized to work", No to "require sponsorship"', () => {
  assert.equal(groundedEligibilityAnswer('Are you authorized to work in Canada?', { authorizedToWork: true }), 'Yes');
  assert.equal(groundedEligibilityAnswer('Will you now or in the future require sponsorship?', { authorizedToWork: true }), 'No');
});

test('groundedEligibilityAnswer: NOT authorized → No to "authorized to work"; sponsorship left to AI/park', () => {
  assert.equal(groundedEligibilityAnswer('Are you legally authorized to work in the US?', { authorizedToWork: false }), 'No');
  // We never ASSUME sponsorship is required from "not authorized" (could be relocating) → null.
  assert.equal(groundedEligibilityAnswer('Do you require visa sponsorship?', { authorizedToWork: false }), null);
});

test('groundedEligibilityAnswer: UNKNOWN authorization never guesses (returns null)', () => {
  assert.equal(groundedEligibilityAnswer('Are you authorized to work here?', { authorizedToWork: null }), null);
  assert.equal(groundedEligibilityAnswer('Are you authorized to work here?', {}), null);
  assert.equal(groundedEligibilityAnswer('Will you require sponsorship?', { authorizedToWork: null }), null);
});

// "Able to perform the duties of the job (with or without reasonable accommodation)?" is a standard
// ability screen — truthful Yes for any applicant, NOT a disability disclosure. The AI refuses it
// ("accommodation" reads disability-adjacent) → it parked + blocked the smartapply form. Ground it.
test('groundedEligibilityAnswer: ability-to-perform-the-duties → Yes (independent of work auth)', () => {
  const a = 'Are you able to perform the specific duties of this position with or without reasonable accommodation?';
  assert.equal(isEligibilityScreeningQuestion(a), true, 'recognised as groundable');
  assert.equal(groundedEligibilityAnswer(a, { authorizedToWork: true }), 'Yes');
  assert.equal(groundedEligibilityAnswer(a, { authorizedToWork: null }), 'Yes', 'always Yes — not auth-gated');
  assert.equal(groundedEligibilityAnswer('Can you perform the essential functions of the role?', {}), 'Yes');
  assert.equal(groundedEligibilityAnswer('Are you able to perform the job?', { authorizedToWork: true, yesText: 'Yes, I can' }), 'Yes, I can');
});

test('the ability RX must NOT fire on disability/accommodation-NEED or experience questions (those are NOT auto-Yes)', () => {
  for (const qq of [
    'Do you have a disability?',
    'Do you require a reasonable accommodation?',
    'Will you need any accommodations during the hiring process?',
    'How many years have you performed these duties?',
    'Are you willing to work weekends?',
  ]) {
    assert.notEqual(groundedEligibilityAnswer(qq, { authorizedToWork: true }), 'Yes', `must NOT auto-Yes: "${qq}"`);
  }
});

test('groundedEligibilityAnswer: NEVER answers a non-eligibility question (no fabrication)', () => {
  assert.equal(groundedEligibilityAnswer('Are you comfortable commuting to this location?', { authorizedToWork: true }), null);
  assert.equal(groundedEligibilityAnswer('How many years of Python experience?', { authorizedToWork: true }), null);
  assert.equal(groundedEligibilityAnswer('', { authorizedToWork: true }), null);
});

test('groundedEligibilityAnswer: emits the field’s own option text (select/radio "Yes, I am" / "No")', () => {
  // A dropdown/radio whose options read "Yes, I am authorized" / "No, I am not" — the grounded
  // answer must use those literal strings so matchOption/pickRadioInGroup can select them.
  assert.equal(
    groundedEligibilityAnswer('Are you authorized to work in Canada?', { authorizedToWork: true, yesText: 'Yes, I am authorized', noText: 'No, I am not' }),
    'Yes, I am authorized',
  );
  assert.equal(
    groundedEligibilityAnswer('Will you require sponsorship?', { authorizedToWork: true, yesText: 'Yes', noText: 'No, I will not' }),
    'No, I will not',
  );
});

// ---- decideAnswerOrPark: partition the blocking required fields into answer vs park ----
test('decideAnswerOrPark: fields WITH a grounded answer go to toAnswer; unanswerable parkable ones to toPark', () => {
  const out = decideAnswerOrPark([
    { label: 'Authorized to work?', answer: 'Yes', parkable: true },
    { label: 'Why do you want this job?', answer: null, parkable: true, reason: 'needs your answer: Why do you want this job?' },
    { label: 'Years with Rust?', answer: '3', parkable: true },
  ]);
  assert.equal(out.toAnswer.length, 2);
  assert.deepEqual(out.toAnswer.map((f) => f.label).sort(), ['Authorized to work?', 'Years with Rust?']);
  assert.equal(out.toPark.length, 1);
  assert.equal(out.toPark[0].label, 'Why do you want this job?');
  assert.match(out.toPark[0].reason, /needs your answer/);
  assert.equal(out.allHandled, true);
});

test('decideAnswerOrPark: an empty/whitespace answer is treated as no answer (parked, never filled)', () => {
  const out = decideAnswerOrPark([
    { label: 'Q1', answer: '   ', parkable: true },
    { label: 'Q2', answer: '', parkable: true },
  ]);
  assert.equal(out.toAnswer.length, 0);
  assert.equal(out.toPark.length, 2);
});

test('decideAnswerOrPark: an unanswerable, NON-parkable field leaves allHandled false (genuine stall)', () => {
  // No answer AND not parkable (e.g. a labelless control we cannot describe to the user) →
  // neither answered nor parked → allHandled false, so the caller keeps the honest stall path.
  const out = decideAnswerOrPark([
    { label: '', answer: null, parkable: false },
  ]);
  assert.equal(out.toAnswer.length, 0);
  assert.equal(out.toPark.length, 0);
  assert.equal(out.allHandled, false);
});

test('decideAnswerOrPark: empty / non-array input is safe', () => {
  assert.deepEqual(decideAnswerOrPark([]), { toAnswer: [], toPark: [], allHandled: true });
  assert.deepEqual(decideAnswerOrPark(undefined), { toAnswer: [], toPark: [], allHandled: true });
  assert.deepEqual(decideAnswerOrPark(null), { toAnswer: [], toPark: [], allHandled: true });
});
