// HIS AUTHORIZATION IS CANADIAN. THE QUESTION IS NOT ALWAYS ABOUT CANADA.
//
// parseAuthorization() reads authorizedToWorkInCanada / needSponsorship / country from the profile
// and returns one authorized/needsSponsorship pair. Both work-authorisation branches then applied
// that pair to whatever jurisdiction the question named. Reproduced 2026-09-05 against his real
// profile (authorizedToWorkInCanada 'Yes', needSponsorship 'No', country 'Canada'):
//
//     "Are you legally authorized to work in the United States?"          -> Yes
//     "Are you legally authorized to work in the US without sponsorship?" -> Yes
//     "Do you require sponsorship to work in the United States?"          -> No
//     "Are you authorized to work in the UK?"                             -> Yes
//
// He is a Canadian citizen and needs sponsorship for a US role. Every one of those is false, and
// the wrong-signed ones ("No, I do not require sponsorship") are the kind a company finds out about
// after making an offer.
//
// The RECALL path learned this on 2026-09-04, which is why HIGH_STAKES_RECALL refuses a harvested
// work-authorisation answer. That stopped an old wrong answer being replayed. It could not stop
// this one, because the floor generates it fresh every time it is asked.
//
// Measured across his live bank: 22 answers change, and every one is a genuine foreign-jurisdiction
// question that was being answered wrongly, including "will you require visa sponsorship at Hyundai
// America" (was No) and "do you require sponsorship for employment visa status (e.g. h-1b)" (was No).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const det = require(path.join(here, '..', 'app', 'src', 'ai', 'deterministic.js'));

// His real profile shape.
const PROFILE = {
  data: {
    firstName: 'Pierre', city: 'Toronto', region: 'Ontario', country: 'Canada',
    // THE FIELD THAT ACTUALLY DRIVES THIS. parseAuthorization reads workAuthorization,
    // citizenship and sponsorshipRequired, and nothing else. His profile also holds
    // authorizedToWork, authorizedToWorkInCanada, needSponsorship, requireSponsorship and
    // visaSponsorship, none of which the floor looks at. The first draft of this fixture set
    // those and every assertion came back null, which is how that was found.
    workAuthorization: 'Authorized to work in Canada (no sponsorship required)',
    authorizedToWork: 'Yes', authorizedToWorkInCanada: 'Yes', needSponsorship: 'No',
  },
};
const ask = (q) => {
  const r = det.answer(q, { profile: PROFILE, resume: '' });
  return r && r.answer != null ? String(r.answer) : null;
};

// ---------------------------------------------------------------------------
// Canada: unchanged, and it must stay that way. This is most of his search.
// ---------------------------------------------------------------------------
test('a Canadian work-authorisation question is still answered from the profile', () => {
  assert.equal(ask('Are you legally authorized to work in Canada?'), 'Yes');
  assert.equal(ask('Are you legally authorized to work in Canada without sponsorship?'), 'Yes');
  assert.equal(ask('Do you require sponsorship to work in Canada?'), 'No');
  assert.equal(ask('Will you now or in the future require sponsorship to work in Canada?'), 'No');
  assert.equal(ask('Are you legally eligible to work in Canada?'), 'Yes');
});

// ---------------------------------------------------------------------------
// Anywhere else: not answered here at all.
//
// null parks it and asks him. Nothing on file says whether he holds any status outside Canada, so
// "No" would be a guess in the other direction rather than an honest answer.
// ---------------------------------------------------------------------------
for (const q of [
  'Are you legally authorized to work in the United States?',
  'are you currently authorized to work in the usa',
  'Are you legally authorized to work in the US without sponsorship?',
  'Do you require sponsorship to work in the United States?',
  'do you require or will you require sponsorship for employment visa status (e.g., h-1b visa status)',
  'Are you authorized to work in the UK?',
  'Are you legally eligible to work in the United Kingdom?',
  'Are you currently able to legally work for any employer in either France, Belgium or Spain?',
  'Are you authorized to work in Australia?',
  'Are you legally authorized to work in India?',
]) {
  test(`a foreign jurisdiction is never answered from a Canadian profile: ${q.slice(0, 48)}`, () => {
    assert.equal(ask(q), null, `nothing on file covers this jurisdiction: ${q}`);
  });
}

test('naming Canada AND somewhere else is still parked', () => {
  // The profile supports exactly one of the two, so answering either way misstates the other.
  assert.equal(ask('Are you legally authorized to work in Canada or the United States?'), null);
  assert.equal(ask('Are you legally authorized to work in Canada or the US for any employer?'), null);
});

// ---------------------------------------------------------------------------
// THE TWO TRAPS IN THE WORD "US"
//
// A bare "us" is the pronoun far more often than the country, and forms shout their labels. Both of
// these were live failures of earlier drafts of this gate, caught before it shipped.
// ---------------------------------------------------------------------------
test('the pronoun "us" is not the United States', () => {
  assert.equal(ask('Do you have the legal right to work here? Tell us about your status.'), 'Yes');
  assert.equal(ask('Are you legally authorized to work in Canada? Please tell us.'), 'Yes');
});

test('the "US" inside a shouted "STATUS" is not the United States', () => {
  assert.equal(ask('WILL YOU REQUIRE SPONSORSHIP FOR YOUR EMPLOYMENT STATUS IN CANADA?'), 'No');
  assert.equal(ask('WHAT IS YOUR WORK STATUS IN CANADA? ARE YOU AUTHORIZED TO WORK?'), 'Yes');
});

// ---------------------------------------------------------------------------
// KNOWN AND ACCEPTED
// ---------------------------------------------------------------------------
test('a question naming NO jurisdiction is left exactly as it was', () => {
  // The floor cannot see the job, so it cannot know where the role is. Parking every unnamed
  // question would strand most of a Canadian search to guard against the minority of US postings.
  // That residual is real, and it is Pierre's to weigh, not this gate's to decide.
  assert.equal(ask('Are you legally authorized to work in the country in which you are applying for a position?'), 'Yes');
});

test('a company whose NAME contains a country parks too, and that is the safe direction', () => {
  // "Are you authorized to work lawfully in Canada for US Mobile Inc?" is a Canadian question that
  // this gate parks, because the company is called US Mobile. Both of that employer's questions are
  // in the live bank and the sibling one genuinely needed parking. Pinned so the behaviour is a
  // known trade rather than a surprise.
  assert.equal(ask('Are you authorized to work lawfully in Canada for US Mobile Inc?'), null);
});
