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
  // Assert the ESCAPE SEQUENCE, not the surrounding structure. This used to match
  // `\\b(work authoriz`, which tied it to one arrangement of the alternation and broke the moment
  // the pattern was restructured to fix the trailing-boundary bug.
  assert.ok(line.includes(String.fromCharCode(92) + 'b'), 'a real two-character \\b must be present');
  // And the trailing boundary must NOT come back: it silently killed every prefix branch.
  assert.doesNotMatch(line, /authoriz\|/, 'a bare `authoriz|` stem cannot complete into "authorization"');
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
// THE TRAILING WORD BOUNDARY. The predicate was written `(work authoriz|...)`, and that closing
//  cannot be satisfied by "work authorization" — the next character after "authoriz" is a word
// character. So the `work authoriz` and `legally authoriz` branches were DEAD and
// isHighStakesQuestion('Do you have work authorization in the US?') returned false, which means the
// autofill bundle would have shipped a scraped answer to it. Found 2026-09-05 from a live laptop
// park: "Will you require our assistance with work authorization now or in the future?".
//
// Every phrasing below is one a real form uses. They are listed individually rather than as one
// happy case because the old pattern passed the common phrasing ("legally authorized to work") on
// a DIFFERENT branch, which is exactly how a dead branch stays hidden.
test('every real phrasing of a work-authorisation question is high stakes', () => {
  for (const q of [
    'Will you require our assistance with work authorization now or in the future?',
    'What is your work authorization status?',
    'Do you have work authorization in the US?',
    'Please describe your work authorisation.',
    'Are you legally authorized to work in Canada?',
    'Are you legally authorised to work in the UK?',
    'Do you require visa sponsorship?',
    'Will you now or in the future require sponsorship?',
    'Are you sponsoring anyone?',
    'Are you a Canadian citizen?',
    'Do you hold citizenship in the EU?',
    'Are you a permanent resident?',
    'Do you have a green card?',
    'Do you hold a security clearance?',
    'Do you have the right to work in Ireland?',
    'Are you eligible to work in Canada?',
    'Do you have a valid work permit?',
    'Are you on an H1B?',
  ]) assert.equal(db.isHighStakesQuestion(q), true, `must be withheld: ${q}`);
});

// RESIDENCY DURATION IS THE SAME CLASS. "Have you lived in Canada for 10+ years?" is the standard
// prerequisite question for a Canadian federal security clearance — and `security clearance` was
// already high-stakes while this was not. Found 2026-09-05 in the LIVE laptop bank, which held TWO
// contradictory scraped answers, neither typed by him:
//   "how many years have you lived in canada?"      -> "6"   (scraped from LinkedIn)
//   "Have you lived in Canada for 10+ years?*"      -> "on"  (a raw checkbox value, i.e. yes)
// Both were reachable by a live lookup. 6 years and "yes, 10+ years" cannot both be true.
test('residency duration is high stakes — it gates clearance and he must answer it himself', () => {
  for (const q of [
    'how many years have you lived in canada?',
    'Have you lived in Canada for 10+ years?',
    'How long have you resided in Canada?',
    'Have you lived outside the country in the last 5 years?',
    'What is your residency status?',
  ]) assert.equal(db.isHighStakesQuestion(q), true, `must be withheld: ${q}`);

  // Location is NOT residency. Parking every "where are you" question would strand applications on
  // the single most common ATS field there is.
  for (const q of ['Where are you located?', 'Location (City)', 'What city do you work from?']) {
    assert.equal(db.isHighStakesQuestion(q), false, `must stay answerable: ${q}`);
  }
});

// FRENCH. Montreal is his second location priority and Quebec postings ask in French only. Measured
// 2026-09-05 in the live bank: French right-to-work questions were almost entirely UNPROTECTED, and
// the few that passed did so only because they carried English text alongside. The worst was
// "Avez-vous la citoyennete canadienne, une residence permanente..." asked 192 times.
test('French right-to-work questions are high stakes too', () => {
  for (const q of [
    'Avez-vous la citoyennete canadienne, une residence permanente au Canada?',
    'Etes-vous legalement autorise a travailler au Canada?',
    'es-tu legalement autorise(e) a travailler au canada ?',
    'Avez-vous besoin de parrainage pour travailler au Canada actuellement?',
    'Possedez-vous un permis de travail valide pour le Canada?',
    'Etes-vous legalement autorise a travailler dans le lieu ou se trouve ce poste?',
  ]) assert.equal(db.isHighStakesQuestion(q), true, `must be withheld: ${q}`);
});

test('but a French LOCATION question stays answerable', () => {
  // "residence" alone is about where he lives, not his right to work. Parking those would strand
  // the most common field on any form. Only "residence permanente" is the status claim.
  for (const q of [
    'quelle est votre ville de residence',
    'please select your current province of residence',
    'what is your current country of residence',
    'are you currently a resident of ontario canada',
  ]) assert.equal(db.isHighStakesQuestion(q), false, `must stay answerable: ${q}`);
});

test('and ordinary screening questions are still answerable', () => {
  // Over-withholding is the safe direction but not a free one: every false positive parks an
  // application on a question the agent could have answered.
  for (const q of [
    'How many years of React experience do you have?',
    'What are your salary expectations?',
    'Why do you want to work here?',
    'Are you comfortable working fully on-site in our Downtown Montreal office?',
    'Location (City)',
    'Do you have experience with visual design?',
    'Have you worked at a card payments company?',
  ]) assert.equal(db.isHighStakesQuestion(q), false, `must stay answerable: ${q}`);
});

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
  assert.match(src, /withheld \$\{withheld\} harvested answer\(s\)/,
    'a silent filter is impossible to notice when it is wrong');
  // The bundle gained a SECOND rail on 2026-09-06: the salary floor, which guarded the agent's
  // `fill` tool and not this path, so 79 harvested answers bottoming out at 85,000 were being
  // shipped against a floor of 90,000. Same rule, exported from guardrails rather than copied,
  // because two copies of a policy are two policies. Real assertions in
  // salary-floor-both-paths.test.mjs; this only pins that the bundle still calls it.
  assert.match(src, /!belowFloor\(f\)/, 'the salary rail must stay wired into the same filter');
  assert.match(src, /guardrails\.salaryBelowFloor/, 'and must use the shared rule, not a second copy');
});

// The test above greps server.js. It passes whether or not the filter it names is ever REACHED —
// and this is the rail that stops a scraped "Yes" to a US work-authorisation question being typed
// onto a real application. So dispatch a real task and read what actually comes out.
test('BEHAVIOUR: a dispatched bundle really does leave the work-authorisation answer behind', async () => {
  const server = require(path.join(root, 'app/src/db.js')) && require(path.join(root, 'app/src/server.js'));

  const platforms = {};
  for (const plat of ['linkedin', 'indeed', 'glassdoor', 'google', 'zip_recruiter']) {
    platforms[plat] = {
      role: 'primary',
      searchesPerDay: 100000, searchesPerHour: 100000, minSearchGapMinutes: 0,
      appliesPerDay: 100000, appliesPerHour: 100000, minApplyGapMinutes: 0,
      quietStart: '00:00', quietEnd: '00:00',
    };
  }
  // Enabled ONLY in this throwaway temp ledger, which is what db.open(dir) above created. The real
  // install's setting is untouched; without this queueNext answers {reason:'disabled'} and the rail
  // under test is never reached.
  db.patchSettings({ autoApply: { enabled: true, safety: { enabled: true, platforms } } });

  const HARMLESS = 'How many years of React experience do you have?';
  const STAKES = 'Are you legally authorized to work in the United States?';
  db.profileFieldUpsert({ profileId: pid, question: HARMLESS, value: '3', fromUser: true });
  db.profileFieldUpsert({ profileId: pid, question: STAKES, value: 'Yes', fromUser: true });

  const url = 'https://www.linkedin.com/jobs/view/9900000001/';
  const job = db.upsertJob({ externalId: url, title: 'Developer', company: 'Acme', source: 'linkedin', status: 'started', jobUrl: url }).job;
  db.queueAdd(job.id, { mode: 'auto' });

  const sent = await server.queueNext(true);
  assert.ok(sent && sent.task, 'a task must have been dispatched');
  assert.ok(Array.isArray(sent.context && sent.context.harvested), 'and it must carry a harvested bundle');

  const labels = sent.context.harvested.map((f) => String(f.label || f.key || ''));
  assert.ok(labels.some((l) => l.includes('React')), 'the ordinary harvested answer must still ship');
  assert.ok(!labels.some((l) => /authoriz/i.test(l)),
    'the work-authorisation answer must NOT reach the page: ' + JSON.stringify(labels));
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

// ---------------------------------------------------------------------------
// SELF-IDENTIFICATION IS HIGH STAKES TOO
//
// Found in the live bank 2026-09-05, and every string below is a real row from it. The rail above
// refuses to serve a HARVESTED work-authorisation answer, because a value scraped off some form is
// not Pierre saying something about himself. The identical argument applies to a protected
// characteristic, and none of them were in the gate:
//
//     "Do you identify as an Indigenous person in Canada?"      "1"       lineage: indeed
//     "do you identify as a member of the 2slgbtqia community"  "0"       recorded 26 times
//     "preferred pronouns"                                      "He/Him"  lineage: indeed
//
// Of those, only the pronoun rows were actually reaching forms: the shape gate passes "He/Him" for
// a text question and refuses a bare "1" or "0" for a yes/no one. So the other two were stopped by
// a shape check, not by policy, and would have been served had the form stored "Yes". Depending on
// that is not a rail. These tests pin the policy instead.
// ---------------------------------------------------------------------------
test('a self-identification question is high stakes', () => {
  for (const q of [
    'Do you identify as an Indigenous person in Canada?',
    'do you identify as a member of the 2slgbtqia community',
    'preferred pronouns',
    'Pronouns *',
    'What gender identity do you most closely identify with?',
    'What sexual orientation do you most closely identify with?',
    'Are you a person of transgender experience?',
    'Do you identify as a member of a visible minority?',
    'Are you a protected veteran?',
    'Do you have a disability?',
    'Voluntary self-identification',
    "Quelle est l’identité de genre qui te correspond le mieux ?",
    'Quelle est votre origine ethnique?',
    'Êtes-vous autochtone?',
  ]) assert.equal(db.isHighStakesQuestion(q), true, `must require a human answer: ${q}`);
});

// Over-matching costs a real answer. Each of these is a question Pierre has a source for and
// wants filled, and the last four are live rows whose stored answer is correctly "pierre".
test('and an ordinary question is still answerable from memory', () => {
  for (const q of [
    'How do we pronounce your name?',
    'Name pronunciation',
    'Name pronunciation (optional)',
    "It's important for us to know how to pronounce everyone's names. How would we pronounce your name?",
    'What is your phone number?',
    'What are your salary expectations?',
    'How many years of React experience do you have?',
    'Location (City)',
    'What is your postal code?',
  ]) assert.equal(db.isHighStakesQuestion(q), false, `must stay answerable: ${q}`);
});
