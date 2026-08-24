// CROSS-COMPANY ANSWER LEAK — the most damaging defect found in the live store.
//
// job_4e8a70b0-9f06-43ab-9334-98181f5f63f1 is a 1Password posting
// (jobs.ashbyhq.com/1password/…, "Senior Security Engineer, Incident Response",
// submitted 2026-08-14 01:39:35). Its stored answers contain questions belonging to
// GEOTAB and ROBINHOOD:
//
//   how_did_you_hear_about_geotab                              = 'LinkedIn'
//   do_you_currently_work_for_a_partner_or_reseller_of_geotab  = 'No'
//   what_date_would_you_be_available_to_onboard_with_geotab    = '2026-07-20'
//   have_you_ever_worked_for_robinhood…                        = 'No'
//   <robinhood bribery / government-official disclosure>       = 'Toronto, ON'
//   <robinhood conflict-of-interest disclosure>                = 'Tacel'
//
// Two defects produced that. (a) The bag-of-words fuzzy score treats the COMPANY NAME as
// just another token, so the Geotab and 1Password versions of the same question score
// 0.67–0.86 and the stored answer is served. (b) Even where the words line up, the VALUE
// is nonsense for the question type — a location string answering a yes/no compliance
// disclosure, an employer name answering a conflict-of-interest question.
//
// The question strings below are the real ones. Nothing here may ever recall across
// companies, and nothing may recall an answer whose shape does not fit the question.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));
const shape = require(path.join(here, '..', 'app', 'src', 'answer-shape.js'));

let dir, pid;
test.before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-xco-'));
  db.open(dir);
  pid = db.saveProfile({ name: 'Leak', data: {} }).id;
});
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

// ---- the real stored answers, as captured from the Geotab / Robinhood applications ----
const GEOTAB = [
  ['How did you hear about Geotab?', 'LinkedIn'],
  ['Do you currently work for a partner or reseller of Geotab?', 'No'],
  ['What date would you be available to onboard with Geotab?', '2026-07-20'],
];
const ROBINHOOD = [
  ['Have you ever worked for Robinhood or any of its subsidiaries?', 'No'],
];

test.before(() => {
  for (const [q, a] of [...GEOTAB, ...ROBINHOOD]) {
    assert.ok(db.qaRecord({ profileId: pid, question: q, answer: a, source: 'test' }), `stored: ${q}`);
  }
});

// ---------------------------------------------------------------------------
// (a) NEVER CROSS COMPANY
// ---------------------------------------------------------------------------

test('a Geotab-stored answer is never recalled for the same question about 1Password', () => {
  const asked = [
    'How did you hear about 1Password?',
    'Do you currently work for a partner or reseller of 1Password?',
    'What date would you be available to onboard with 1Password?',
  ];
  for (const q of asked) {
    const hit = db.qaLookup(pid, q);
    assert.equal(hit, null, `1Password question must not recall a Geotab answer: ${q} → ${hit && hit.answer}`);
  }
});

test("a Robinhood-stored answer is never recalled for 1Password's version of it", () => {
  const hit = db.qaLookup(pid, 'Have you ever worked for 1Password or any of its subsidiaries?');
  assert.equal(hit, null, `must not recall Robinhood's answer (${hit && hit.answer})`);
});

test('the SAME company still recalls its own answer (the gate is not a blanket refusal)', () => {
  for (const [q, a] of GEOTAB) {
    const hit = db.qaLookup(pid, q);
    assert.ok(hit, `Geotab must still answer its own question: ${q}`);
    assert.equal(hit.answer, a);
  }
  // and a light paraphrase of a Geotab question still reaches the Geotab answer
  const para = db.qaLookup(pid, 'Do you currently work for a reseller or partner of Geotab?');
  assert.ok(para, 'a paraphrase naming the same company still matches');
  assert.equal(para.answer, 'No');
});

test('a company-specific stored answer never answers the GENERIC form of the question', () => {
  // "…reseller of Geotab" is an answer about Geotab, not an answer about resellers.
  assert.equal(db.qaLookup(pid, 'Do you currently work for a partner or reseller?'), null);
});

test('brandConflict is symmetric and ignores grammar-driven sentence capitals', () => {
  assert.equal(shape.brandConflict('How did you hear about Geotab?', 'How did you hear about 1Password?'), true);
  assert.equal(shape.brandConflict('How did you hear about Geotab?', 'How did you hear about Geotab?'), false);
  assert.equal(shape.brandConflict("How did you hear about Geotab's careers page?", 'How did you hear about Geotab?'), false);
  // "Do" / "Have" / "What" lead a sentence — grammar, not identity
  assert.deepEqual([...shape.brandTokens('Do you currently work for a partner or reseller of Geotab?')], ['geotab']);
  assert.deepEqual([...shape.brandTokens('Have you ever worked for Robinhood or any of its subsidiaries?')], ['robinhood']);
  // a country is not a company — this question must stay matchable
  assert.deepEqual([...shape.brandTokens('Are you legally authorized to work in Canada?')], []);
  assert.equal(shape.brandConflict('Are you legally authorized to work in Canada?', 'Are you legally authorized to work in Canada?'), false);
});

// ---------------------------------------------------------------------------
// (b) NEVER THE WRONG SHAPE
// ---------------------------------------------------------------------------

const BRIBERY = 'Have you or any member of your immediate family ever been a government official, or provided anything of value to a government official on behalf of the Company?';
const CONFLICT = 'Please disclose any familial relationships, outside business activities, or investments that may present a conflict of interest.';

test('a location string can never answer a yes/no compliance disclosure', () => {
  assert.equal(shape.questionShape(BRIBERY), 'yesno');
  assert.equal(shape.answerFitsQuestion(BRIBERY, 'Toronto, ON'), false);
  assert.equal(shape.answerFitsQuestion(BRIBERY, 'No'), true);

  // and end-to-end: a stored location answer is not served for it
  db.qaRecord({ profileId: pid, question: 'Where are you located?', answer: 'Toronto, ON', source: 'test' });
  const hit = db.qaLookup(pid, BRIBERY);
  assert.ok(!hit || hit.answer !== 'Toronto, ON', `bribery disclosure recalled "${hit && hit.answer}"`);
});

test('an employer name can never answer a conflict-of-interest disclosure', () => {
  db.qaRecord({ profileId: pid, question: 'Current employer', answer: 'Tacel', source: 'test' });
  const hit = db.qaLookup(pid, CONFLICT);
  assert.ok(!hit || hit.answer !== 'Tacel', `conflict-of-interest recalled "${hit && hit.answer}"`);
});

test('a yes/no answer can never answer a "where are you located" question', () => {
  // The live inverse: "This is a remote position. Where are you currently located?" = 'Yes'.
  const q = 'This is a remote position. Where are you currently located?';
  assert.equal(shape.questionShape(q), 'location', 'the LAST clause is the question, not the preamble');
  assert.equal(shape.answerFitsQuestion(q, 'Yes'), false);
  assert.equal(shape.answerFitsQuestion(q, 'Toronto, Ontario, Canada'), true);

  db.qaRecord({ profileId: pid, question: 'Are you comfortable working in a fully remote position?', answer: 'Yes', source: 'test' });
  const hit = db.qaLookup(pid, q);
  assert.ok(!hit || hit.answer !== 'Yes', `location question recalled "${hit && hit.answer}"`);
});

test('the shape gate applies to an EXACT key match too (already-poisoned rows are not served)', () => {
  // This row exists in the live store because a profile string was pasted into a yes/no field.
  const q = 'Are you legally authorized to work in the region where the role is located?';
  db.qaRecord({ profileId: pid, question: q, answer: 'Authorized to work in Canada (no sponsorship required)', source: 'test' });
  const hit = db.qaLookup(pid, q);
  assert.ok(!hit || shape.looksYesNo(hit.answer),
    `a yes/no question must not be answered with a profile sentence (got "${hit && hit.answer}")`);
});

// ---------------------------------------------------------------------------
// the AI path is gated too — memory handed to the model is company-filtered
// ---------------------------------------------------------------------------

test('answerMemory withholds cross-company rows from the AI prompt', () => {
  const all = db.answerMemory(pid, 60);
  assert.ok(all.some((x) => /Geotab/i.test(x.question)), 'unfiltered memory does contain the Geotab rows');
  const forOnePassword = db.answerMemory(pid, 60, { question: 'How did you hear about 1Password?' });
  assert.equal(forOnePassword.some((x) => /Geotab|Robinhood/i.test(x.question)), false,
    'a 1Password question must not be shown another company\'s answers');
});
