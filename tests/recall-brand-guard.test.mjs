// THE RECALL GATE WAS REFUSING ANSWERS IT ALREADY HAD.
//
// brandConflict() decides whether a remembered answer may be reused for the question being
// asked. It finds company names by their MID-SENTENCE CAPITAL -- "have you worked at Geotab"
// names Geotab, and reusing that answer on a 1Password form would be wrong.
//
// Three separate defects made it refuse ordinary, correct recalls. All three were measured
// against the real database (4,601 remembered questions, 96 parked applications):
//
//  1. TITLE-CASE FIELD LABELS. An ATS writes its labels "Street Address", "First Name",
//     "Location (City)". Every capital after the first word was read as a company, so the
//     label conflicted with its own lowercase memory. "Location (City)*" was the single most
//     parked question in the queue -- thirteen copies, with "Toronto, ON" sitting in memory.
//
//  2. HEX AND ID FRAGMENTS. The mixed letters+digits rule exists for 1Password and S1, but it
//     also matched "7a08ec2d", "b470", "ae77", "id62" -- UUIDs and DOM ids that leak into
//     scraped labels. Each became a phantom company no memory could ever match. A phone
//     country-code dropdown contributed a whole run of them ("355algeria", "376angola").
//
//  3. THE CASELESS STORED SIDE -- the big one. 3,570 of 4,601 remembered questions (78%) hold
//     no capital letter at all. brandTokens() can find nothing in a caseless string, so ANY
//     properly-capitalized question naming a company conflicted with its own memory. Eleven
//     copies of "have you previously been employed at Affirm" sat parked next to the stored
//     answer to that exact question.
//
// Opening the gate then exposed junk the gate had been hiding, so two answer-shape guards
// ship with it -- see the bottom of this file. Without them this change would have put
// "Ontario" on an employer's export-control attestation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const S = require(path.join(here, '..', 'app', 'src', 'answer-shape.js'));

const brands = (q) => [...S.brandTokens(q)].sort();

// ---------------------------------------------------------------------------------------
// 1. Title-case field labels
// ---------------------------------------------------------------------------------------
test('an ATS field label names no company', () => {
  for (const label of [
    'Street Address', 'Address Line 1', 'First Name', 'Last Name', 'Postal Code',
    'Phone Number', 'Email Address', 'Location (City)*', 'Preferred Name',
  ]) {
    assert.deepEqual(brands(label), [], label + ' must not read as a company name');
  }
});

test('a label recalls against its own lowercase memory', () => {
  // The failure exactly as it happened: the label as the form writes it, against the
  // question as the database stored it.
  for (const [asked, stored] of [
    ['Location (City)*', 'location city'],
    ['Street Address', 'street address'],
    ['Address Line 1', 'address line 1'],
    ['First Name', 'first name'],
  ]) {
    assert.equal(S.brandConflict(asked, stored), false, asked + ' must reuse ' + stored);
  }
});

test('a technology is a skill, not an employer', () => {
  // "How would you rate your proficiency in Python?" was locked out of its own answer,
  // because Python is capitalized mid-sentence exactly like Geotab is.
  for (const q of [
    'How would you rate your proficiency in Python?',
    'Rate your experience with React and TypeScript',
    'Do you have experience with SQL and REST APIs?',
  ]) {
    assert.deepEqual(brands(q), [], q + ' names a technology, not a company');
  }
});

test('but a vendor that could actually be an EMPLOYER keeps its brand', () => {
  // The line is drawn deliberately: Oracle/Salesforce/MongoDB/Docker/Redis are companies he
  // might be asked "have you worked at" -- there the brand reading is the correct one.
  assert.deepEqual(brands('Have you ever worked at Oracle?'), ['oracle']);
  assert.deepEqual(brands('Do you use Salesforce today?'), ['salesforce']);
});

// ---------------------------------------------------------------------------------------
// 2. Hex and id fragments
// ---------------------------------------------------------------------------------------
test('a UUID fragment or DOM id is not a company', () => {
  for (const tok of ['7a08ec2d', 'b470', '4fd5', 'ae77', '978bdebe8b68', 'id0', 'id62', 'id101']) {
    assert.equal(S.isBrandToken(tok), false, tok + ' is scrape noise, not a name');
  }
});

test('digits followed by lowercase is a scrape artifact', () => {
  // A whole phone country-code dropdown, harvested into one label.
  assert.deepEqual(brands('phone 355algeria 376angola 54armenia 61austria'), []);
});

test('THE LINE: a real digit-leading brand still reads as one', () => {
  // The rule that distinguishes them is capitalization of the letter after the digits.
  // If this ever fails, the fix above has swallowed genuine company names.
  assert.deepEqual(brands('How did you hear about 1Password?'), ['1password']);
  assert.deepEqual(brands('Have you worked at 3M before?'), ['3m']);
  assert.equal(S.isBrandToken('F5'), true, 'F5 Networks is a company');
});

// ---------------------------------------------------------------------------------------
// 3. The caseless stored side
// ---------------------------------------------------------------------------------------
test('THE BUG: a capitalized question recalls its own lowercase memory', () => {
  for (const [asked, stored] of [
    ['Have you previously been employed at Affirm for any length of time?',
      'have you previously been employed at affirm for any length of time?*'],
    ['What date would you be available to onboard with Geotab?',
      'what date would you be available to onboard with geotab'],
    ['Have you previously worked for D2L in any capacity?',
      'have you previously worked for d2l in any capacity if yes please select'],
  ]) {
    assert.equal(S.brandConflict(asked, stored), false,
      'the same question in two letter-cases is the same question');
  }
});

test('THE PROTECTION: a caseless memory about ANOTHER company is still refused', () => {
  // The expensive direction. If this fails, an answer about one employer starts appearing on
  // another employer's form, which is the whole reason this guard exists.
  assert.equal(S.brandConflict('How did you hear about 1Password?',
    'how did you hear about geotab?'), true);
  assert.equal(S.brandConflict('Have you previously been employed at Affirm?',
    'have you previously been employed at shopify?'), true);
});

test('THE PROTECTION, other direction: a generic question refuses a company-specific memory', () => {
  // With no capitals to read on the stored side, the preposition is the only handle left:
  // "work AT geotab", "hear ABOUT d2l", "sponsor FOR stripe".
  assert.equal(S.brandConflict('Why do you want to work here?',
    'why do you want to work at geotab?'), true);
  assert.equal(S.brandConflict('Do you work for a reseller?',
    'do you work for a reseller of geotab'), true);
});

test('two caseless generic questions still recall each other', () => {
  // The preposition rule must not fire on ordinary words, or it re-creates the mass refusal
  // it was written to fix.
  assert.equal(S.brandConflict('are you willing to relocate?',
    'are you willing to relocate for this role'), false);
  assert.equal(S.brandConflict('are you authorized to work in canada?',
    'are you authorized to work in canada'), false);
});

// ---------------------------------------------------------------------------------------
// The two guards that had to ship WITH the fix
// ---------------------------------------------------------------------------------------
test('an attestation takes an affirmation and nothing else', () => {
  // Measured: memory held "Ontario" against the Export Control attestation, an exact question
  // match. The moment the brand guard stopped masking it, it was one recall away from an
  // employer.
  const q = 'I have read and understand the Export Control statement included in the job description';
  assert.equal(S.recallAllowed(q, q.toLowerCase(), 'Ontario'), false,
    'a province is not an acknowledgement');
  assert.equal(S.recallAllowed(q, q.toLowerCase(), 'I agree'), true);
  assert.equal(S.recallAllowed(q, q.toLowerCase(), 'Yes'), true);
  assert.equal(S.isAttestation('Please review and acknowledge the Applicant Privacy Notice'), true);
  assert.equal(S.isAttestation('What is your current city?'), false);
});

test('a bare numeral does not answer a worded question', () => {
  // "0" was stored against "How did you first learn about Affirm as an employer?" and matched
  // EXACTLY, so nothing else would have stopped it.
  const q = 'How did you first learn about Affirm as an employer?';
  assert.equal(S.recallAllowed(q, q.toLowerCase(), '0'), false);
  // ...but it is the right answer to a counting question, and must stay allowed there.
  const n = 'How many years of experience do you have with Java?';
  assert.equal(S.recallAllowed(n, n.toLowerCase(), '0'), true, 'zero years is a real answer');
  assert.equal(S.recallAllowed(n, n.toLowerCase(), '3'), true);
});

test('the net effect on the real parked queue, recorded', () => {
  // Measured against a copy of the live database, 96 parked questions:
  //   before this change  ..  0 answerable
  //   brand fix alone     .. 25 answerable, 12 of them WRONG (junk memory the gate had hidden)
  //   with both guards    .. 13 answerable, 0 wrong
  // Fewer answers, and every one of them correct. That trade is the point of the two guards
  // above, and this test exists so a future change that "improves" the number has to argue
  // with the second column.
  const q = 'Location (City)*';
  assert.equal(S.recallAllowed(q, 'location city', 'Toronto, ON'), true,
    'the most-parked question in the queue, and its answer was in memory the whole time');
});
