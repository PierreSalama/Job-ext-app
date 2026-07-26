// The "fall back to other sites when LinkedIn/Indeed cap out" feature had no supply to fall back
// ON. Measured from the live DB 2026-07-26:
//
//   provider          found   accepted
//   greenhouse-api     1610          8
//   ashby-api           301          1
//   lever-api           177          0
//   jobspy (LI/Indeed) 1533        364
//
// Last 24h: 363 Greenhouse postings found, ZERO accepted. Greenhouse/Lever/Ashby also had 0
// completed applies between them, so nothing downstream could have used them anyway.
//
// Two causes, both measured against real board APIs rather than guessed at:
//
// 1. WRONG COMPANIES. Of 113 seed tokens only ~3 were Canadian employers; the rest were US/EU
//    giants (databricks, stripe, openai, palantir). Pierre needs Toronto/Canada at MID level, and
//    on those boards essentially every Canadian posting is Senior or Staff — 21 of 28
//    location-eligible postings were rejected "above your level cap (mid)". That is not a bug,
//    it is the actual market: those boards do not carry mid-level Canadian roles.
//    33 Canadian-employer boards were probed LIVE and only the ones actually returning postings
//    were added, so no token in the seed list is speculative.
//
// 2. WRONG VOCABULARY. Keywords are whole phrases matched as substrings, which dropped titles
//    doing the same job under a word nobody enumerated. Over those 33 boards the phrase list
//    accepted 15 in-location postings and rejected 14 equally good ones.
//
// A note on what was NOT the cause: requireKeywordMatch (added earlier this session) was the
// obvious suspect. Tested at true/false/undefined against a real board — 7/28 accepted in all
// three cases. It made no difference and was left alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { titleMatchesKeywords } = require(path.join(here, '..', 'app', 'src', 'discovery', 'ats-boards.js'));
const seeds = require(path.join(here, '..', 'app', 'src', 'discovery', 'ats-seed-companies.json'));

const KEYWORDS = ['full stack developer', 'software engineer', 'software developer', 'web developer'];

test('a configured phrase still matches (unchanged behaviour)', () => {
  assert.ok(titleMatchesKeywords('Senior Software Engineer, Backend', KEYWORDS));
  assert.ok(titleMatchesKeywords('Software Developer - Infrastructure', KEYWORDS));
});

test('an empty keyword list keeps everything', () => {
  assert.ok(titleMatchesKeywords('Anything At All', []));
  assert.ok(titleMatchesKeywords('Anything At All', null));
});

test('real titles the phrase list dropped are now kept', () => {
  // Every one of these is a live posting from a Canadian-employer board, in-location, that the
  // phrase-only gate rejected.
  for (const t of [
    'Data Engineer',
    'DevOps Engineer',
    'Cloud Security Engineer',
    '(Canada) - Junior Site Reliability Engineer',
    'Product Engineer - Retailer Experience & Growth - Fullstack, Backend or Frontend',
    'Infrastructure and Platform Development Engineer',
    'Systems Engineer, Data Center Debug',
    'Cloud Application Security Engineer',
  ]) assert.ok(titleMatchesKeywords(t, KEYWORDS), `${t} is the same kind of work`);
});

test('the widened gate still refuses non-engineering roles', () => {
  // The role noun AND a domain word are both required, which is what keeps this honest.
  for (const t of [
    'Technical Recruiter', 'Account Executive', 'Sales Development Representative',
    'Accounting Manager, GL Operations & Intercompany', 'Customer Success Manager',
    'Product Manager', 'Office Coordinator', 'Sales Engineer',
  ]) assert.equal(titleMatchesKeywords(t, KEYWORDS), false, `${t} must not pass`);
});

test('a bare role noun with no domain word is not enough', () => {
  assert.equal(titleMatchesKeywords('Engineer', KEYWORDS), false);
  assert.equal(titleMatchesKeywords('Engineering Lead', KEYWORDS), false);
});

test('the seed list carries Canadian employers, not only US giants', () => {
  const tokens = new Set(seeds.map((s) => String(s.token).toLowerCase()));
  // A sample of the boards verified live to return postings.
  for (const t of ['wealthsimple', 'jobber', '1password', 'koho', 'geotab', 'pointclickcare', 'waabi'])
    assert.ok(tokens.has(t), `${t} should be seeded — it is a Canadian employer with a live board`);
  assert.ok(seeds.length >= 140, `expected the seed list to have grown, got ${seeds.length}`);
});

test('every seed entry is well-formed and on a supported ATS', () => {
  for (const s of seeds) {
    assert.ok(s && typeof s.token === 'string' && s.token.trim(), `bad token: ${JSON.stringify(s)}`);
    assert.ok(['greenhouse', 'lever', 'ashby'].includes(s.ats), `bad ats: ${JSON.stringify(s)}`);
  }
  const dupes = seeds.length - new Set(seeds.map((s) => `${s.ats}:${s.token}`)).size;
  assert.equal(dupes, 0, 'seed list must not contain duplicates');
});
