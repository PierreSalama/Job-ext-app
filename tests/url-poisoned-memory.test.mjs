// A BARE URL IS NEVER THE ANSWER TO A SCREENING QUESTION.
//
// Live on pierre-laptop 2026-08-24, FOUR rows in profile_fields carried the value
// `https://birdseyeaccount.bamboohr.com/careers/280` — one BambooHR posting's "link to this job"
// field, mis-attributed onto three unrelated questions:
//
//   key_norm                                             label (truncated)
//   ----------------------------------------------------------------------------------------
//   "accordance agree application as be by candidate…"   "by selecting I agree I understand that the
//                                                         information I have provided … reddit's
//                                                         candidate privacy policy"
//   "application as before company faire familiar…"      "before seeing this job posting how familiar
//                                                         were you with faire as a company…"
//   "find job posting this url"                          "how did you find this job posting url"
//   "job link this"                                      "link to this job"
//
// profileFieldLookup matches on an EXACT key, so a poisoned row can never self-heal: reddit's
// consent checkbox would be answered with a BambooHR careers URL on every future reddit
// application, forever.
//
// The guard has to be narrow, because Pierre's memory legitimately holds several URL answers —
// his LinkedIn profile, his GitHub, his portfolio — and those must keep working. Every string
// below is real: the poisoned four, and the genuine URL answers from the same store.
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
let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-urlpoison-')); db.open(dir); });
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const BAMBOO = 'https://birdseyeaccount.bamboohr.com/careers/280';

// The four REAL poisoned rows.
const POISONED = [
  ["by selecting I agree I understand that the information I have provided as part of this job application will be processed in accordance with reddit's candidate privacy policy", BAMBOO],
  ['before seeing this job posting how familiar were you with faire as a company your response will not impact your application', BAMBOO],
  ['how did you find this job posting url', BAMBOO],
  ['link to this job', BAMBOO],
];

// REAL, legitimate URL answers from the same store — these must survive untouched.
const LEGIT = [
  ['LinkedIn Profile', 'https://www.linkedin.com/in/pierre-salama'],
  ['GitHub', 'https://github.com/PierreSalama'],
  ['Website', 'https://pierresalama.com'],
  ['Personal website / portfolio', 'https://personal-website-4j0.pages.dev'],
  ['Other links', 'https://github.com/PierreSalama'],
  ['Portfolio URL', 'https://pierresalama.com'],
];

test('every poisoned pair is refused at the write boundary', () => {
  for (const [q, v] of POISONED) {
    assert.equal(db.isMisattributedUrlAnswer(q, v), true, `should refuse: ${q.slice(0, 60)}`);
  }
});

test('every genuine URL answer is still allowed', () => {
  for (const [q, v] of LEGIT) {
    assert.equal(db.isMisattributedUrlAnswer(q, v), false, `should allow: ${q}`);
  }
});

test('a non-URL answer is never touched, whatever the question', () => {
  assert.equal(db.isMisattributedUrlAnswer('are you authorized to work in Canada?', 'Yes'), false);
  assert.equal(db.isMisattributedUrlAnswer('LinkedIn Profile', 'pierre-salama'), false);
  assert.equal(db.isMisattributedUrlAnswer('tell us about yourself', 'I build automation tools.'), false);
});

test('profileFieldUpsert refuses to store one, and the store stays clean', () => {
  const profileId = db.listProfiles()[0]?.id || db.saveProfile({ name: 'Pierre', isDefault: true }).id;
  for (const [q, v] of POISONED) {
    assert.equal(db.profileFieldUpsert({ profileId, question: q, value: v, source: 'greenhouse' }), null,
      `write boundary must refuse: ${q.slice(0, 50)}`);
  }
  const rows = db.profileFieldList(profileId);
  assert.equal(rows.filter((r) => r.value === BAMBOO).length, 0);
  // ...and a legitimate one written straight after still lands.
  const ok = db.profileFieldUpsert({ profileId, question: 'LinkedIn Profile', value: 'https://www.linkedin.com/in/pierre-salama', source: 'linkedin' });
  assert.ok(ok && ok.value === 'https://www.linkedin.com/in/pierre-salama');
});

test('reddit can self-heal: the poisoned key is gone, so a real answer takes its place', () => {
  const profileId = db.listProfiles()[0].id;
  const q = POISONED[0][0];
  const real = db.profileFieldUpsert({ profileId, question: q, value: 'I agree', fromUser: true });
  assert.ok(real, 'the real answer must be storable');
  assert.equal(db.profileFieldLookup(profileId, q, null, { ungated: true })?.value, 'I agree');
});

test('purgeMisattributedUrlAnswers sweeps rows already in the store', () => {
  const profileId = db.listProfiles()[0].id;
  // Plant them the way they got there — through qaRecord/profile_fields before the guard existed.
  // profileFieldSet bypasses the write boundary (it is the user's own edit path), which is exactly
  // how we reproduce a pre-existing poisoned row.
  const seeded = db.profileFieldUpsert({ profileId, question: 'link to this job', value: 'not a url yet', fromUser: true });
  db.profileFieldSet(seeded.id, { value: BAMBOO });
  assert.equal(db.profileFieldList(profileId).filter((r) => r.value === BAMBOO).length, 1);
  const purged = db.purgeMisattributedUrlAnswers();
  assert.ok(purged.profileFields >= 1, 'the planted row must be swept');
  assert.equal(db.profileFieldList(profileId).filter((r) => r.value === BAMBOO).length, 0);
  // Pierre's real URL answers survive the sweep.
  assert.ok(db.profileFieldList(profileId).some((r) => r.value === 'https://www.linkedin.com/in/pierre-salama'));
});
