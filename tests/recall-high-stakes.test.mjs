// A wrong answer here is not a wrong answer. It is a false statement of fact about the candidate.
//
// Found in the live bank on 2026-09-04: "are you legally authorized to work in the united states"
// answered "Yes", and "yes i have us work authorization as a us citizen or us permanent resident
// green card holder" answered with the whole affirmative sentence. Pierre is a Canadian citizen who
// needs sponsorship for a US role. Both were captured off forms, never typed by him, and the shape
// gate waved them through because "Yes" is a perfectly good shape for a yes/no question. Meanwhile
// the TRUE Canadian answer was being refused. Exactly backwards.
//
// Answer one of these wrong and an offer can be withdrawn after it is signed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const db = require(path.join(root, 'app/src/db.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-stakes-'));
db.open(dir);
const pid = db.ensureDefaultProfileId();
process.on('exit', () => {
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
});

const remember = (question, answer, lineageSource) =>
  db.qaRecord({ profileId: pid, question, answer, source: 'test', lineageSource });

test('a HARVESTED work-authorisation answer is never served', () => {
  remember('Are you legally authorized to work in the United States?', 'Yes', 'linkedin');
  assert.equal(db.qaLookup(pid, 'Are you legally authorized to work in the United States?'), null);
});

test('his OWN answer to the same question still is', () => {
  // The rule is about provenance, not about the topic being untouchable. Park it once, he answers
  // it, and it is never asked again.
  remember('Do I require sponsorship to work in Canada?', 'No, I am a Canadian citizen', 'user');
  const hit = db.qaLookup(pid, 'Do I require sponsorship to work in Canada?');
  assert.ok(hit, 'a human answer to a high-stakes question is exactly what recall is for');
  assert.match(hit.answer, /Canadian citizen/);
});

test('every phrasing employers actually use is covered', () => {
  const phrasings = [
    'Are you authorized to work lawfully in the US for US Mobile Inc?',
    'Do you have the unrestricted right to work in the US?',
    'Will you now or in the future require visa sponsorship?',
    'Are you legally eligible to work in the country where this role is located?',
    'Do you require an H-1B visa?',
    'Are you a citizen or permanent resident?',
    'Do you hold a valid work permit?',
    'Do you have an active security clearance?',
  ];
  for (const q of phrasings) {
    remember(q, 'Yes', 'indeed');
    assert.equal(db.qaLookup(pid, q), null, `harvested answer served for: ${q}`);
  }
});

test('an ordinary question is untouched by this', () => {
  // Gating everything would park every application on its first screening question.
  remember('How many years of experience do you have with React?', '3', 'linkedin');
  remember('What are your salary expectations?', 'CAD 100,000 to 110,000', 'linkedin');
  assert.equal(db.qaLookup(pid, 'How many years of experience do you have with React?').answer, '3');
  assert.match(db.qaLookup(pid, 'What are your salary expectations?').answer, /100,000/);
});

test('the word boundary is real, not a control character', () => {
  // The first version of this pattern was written with a literal backspace where \b belonged. It is
  // invisible in a terminal, it made the rule match nothing at all, and every test of the rule
  // still passed because the rule was never reached.
  const src = fs.readFileSync(path.join(root, 'app/src/db.js'), 'utf8');
  const line = src.split('\n').find((l) => l.startsWith('const HIGH_STAKES_RECALL'));
  assert.ok(line, 'the pattern must exist');
  assert.equal(line.includes(String.fromCharCode(8)), false, 'literal backspace in the pattern');
  assert.match(line, /\b\(work authoriz/);
});

// ---------------------------------------------------------------------------
// The OTHER way an answer reaches a real form
//
// The recall gate above covers lookups. It does not cover the autofill bundle, which ships
// harvested fields to the extension and lets the extension match them against the page itself. No
// recall path is involved. That is the route auto-apply uses, and it is running on the server
// laptop right now, so a scraped "Yes" to a US work-authorisation question would be typed onto a
// real application without anything in this codebase getting a say.
// ---------------------------------------------------------------------------
test('the high-stakes predicate is exported for the bundle to use', () => {
  assert.equal(typeof db.isHighStakesQuestion, 'function');
  assert.equal(db.isHighStakesQuestion('Are you legally authorized to work in the United States?'), true);
  assert.equal(db.isHighStakesQuestion('Do you require visa sponsorship?'), true);
  assert.equal(db.isHighStakesQuestion('Do you have a security clearance?'), true);
  assert.equal(db.isHighStakesQuestion('How many years of React experience?'), false);
  assert.equal(db.isHighStakesQuestion('What are your salary expectations?'), false);
});

test('the bundle withholds them, and says how many', () => {
  const src = fs.readFileSync(path.join(root, 'app/src/server.js'), 'utf8');
  assert.match(src, /harvestedAll\.filter\(\(f\) => !db\.isHighStakesQuestion/);
  assert.match(src, /withheld \$\{withheld\} harvested work-authorisation/,
    'a silent filter is impossible to notice when it is wrong');
});

test('only the high-stakes ones are withheld', () => {
  // Withholding everything would park every application on its first screening question.
  const fields = [
    { label: 'Are you legally authorized to work in the United States?', value: 'Yes' },
    { label: 'Will you require visa sponsorship?', value: 'No' },
    { label: 'Years of experience with React', value: '3' },
    { label: 'What are your salary expectations?', value: 'CAD 100,000-110,000' },
    { label: 'Why do you want to work here?', value: 'Because of the product.' },
  ];
  const kept = fields.filter((f) => !db.isHighStakesQuestion(f.label));
  assert.deepEqual(kept.map((f) => f.label), [
    'Years of experience with React',
    'What are your salary expectations?',
    'Why do you want to work here?',
  ]);
});
