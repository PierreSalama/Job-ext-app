// "HAVE YOU PREVIOUSLY WORKED HERE?" — 17 of 26 live answers were junk.
//
// Pierre, 2026-09-08: "I have only been employed by the microemployers, so if any of these
// questions come up you should have the answer automatically." It was not being answered
// automatically, and what filled the gap was a harvested answer from whatever widget happened to be
// on the form. Measured on his live bank:
//
//     "have you previously worked for Linamar or any of its subsidiaries"  -> "300000126828332"
//     "have you previously been employed by coinbase in any capacity"      -> "Toronto, ON"
//     "have you previously worked with Questrade Financial Group?"         -> "21"
//     "are you currently employed by or have you previously worked for..." -> "on"
//
// An option id, a city, a row number and a checkbox value, sitting where a recruiter reads an
// answer. 14 were deleted; this rule is what stops them coming back.
//
// THE HALF THAT MATTERS MOST is the refusal. A blanket "No" would be a guess dressed as a fact and
// would be wrong the day he applies back somewhere he has worked, so a company he HAS worked for
// must escalate to a human instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pe = require(path.join(here, '..', 'app', 'src', 'ai', 'prior-employment.js'));

const profile = { data: { workHistory: [{ company: 'Legacy Delta Technologies' }, { company: 'Tacel' }] } };
const resume = 'Legacy Delta Technologies | Toronto, ON\nSoftware Developer  2024 to Present\nTacel, Mississauga';
const ask = (q, ctx = {}) => pe.answerPriorEmployment(q, { profile, resume, ...ctx });

// ---------------------------------------------------------------------------
// answered, because he has not worked there
// ---------------------------------------------------------------------------
const NEVER_WORKED = [
  'Have you previously worked for Linamar or any of its subsidiaries?',
  'have you previously been employed by coinbase in any capacity',
  'Have you previously worked with Questrade Financial Group?',
  'Are you currently employed by or have you previously worked for Autodesk?',
  'have you previously worked at samsara',
  'Have you previously been employed at Affirm?',
  'Are you a current or former employee or contractor of Newmont?',
  'Have you ever been employed by this company?',
  'Were you previously employed by Corpay or a subsidiary of Corpay?',
];
for (const q of NEVER_WORKED) {
  test(`answers No: ${q.slice(0, 52)}`, () => {
    const r = ask(q);
    assert.ok(r, 'must produce an answer rather than falling through to a harvested one');
    assert.equal(r.answer, 'No');
    assert.ok(r.confidence >= 0.9);
  });
}

test('the company can come from the job being applied to, not just the question text', () => {
  const r = ask('Were you previously employed by RB Global?', { job: { company: 'RB Global' } });
  assert.equal(r.answer, 'No');
});

// ---------------------------------------------------------------------------
// REFUSED, because he HAS worked there — the half that protects him
// ---------------------------------------------------------------------------
test('a company he actually worked for escalates instead of being denied', () => {
  for (const q of [
    'Have you previously worked at Legacy Delta Technologies?',
    'Were you previously employed by Tacel?',
    'Are you a former employee of Legacy Delta Technologies?',
  ]) {
    assert.equal(ask(q), null, `${q} must go to a human, not be answered "No"`);
  }
});

test('the job context cannot make it deny a real employer either', () => {
  assert.equal(ask('Have you previously worked here?', { job: { company: 'Tacel' } }), null);
});

// ---------------------------------------------------------------------------
// stays quiet on everything else
// ---------------------------------------------------------------------------
test('does not fire on questions that merely contain "work"', () => {
  for (const q of [
    'How many years of work experience do you have?',
    'What is your current employment status?',
    'Are you authorized to work in Canada?',
    'What is your preferred work arrangement?',
    'Describe a time you worked on a difficult team.',
  ]) {
    assert.equal(ask(q), null, `should not have fired on: ${q}`);
  }
});

test('empty input is not an answer', () => {
  assert.equal(ask(''), null);
  assert.equal(ask('   '), null);
});

// ---------------------------------------------------------------------------
// the employer list itself
// ---------------------------------------------------------------------------
test('employers are read from the profile and the resume', () => {
  const known = pe.knownEmployers(profile, resume);
  assert.ok(known.has('legacy delta technologies'));
  assert.ok(known.has('tacel'));
});

test('a one or two character token is never treated as a company', () => {
  // Otherwise a stray initial in a resume line would match half the companies on earth by substring
  // and silently turn every "have you worked here" into an escalation.
  const known = pe.knownEmployers({ data: { employer: 'AB' } }, 'X | Toronto, ON\nQ, 2024');
  for (const e of known) assert.ok(e.length > 2, `too short to be a company: ${e}`);
});
