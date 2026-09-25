// WHOSE THREE YEARS? THE FLOOR DID NOT ASK.
//
// estimateYears() takes a profile and a resume and returns ONE number. It takes no subject at all,
// so the years branch handed that number to every "how many years of X" question whatever X was.
// Reproduced 2026-09-05 against Pierre's real profile (yearsExperience '3') and his real resume:
//
//     "How many years of anesthesiology experience do you have?"        -> 3
//     "How many years of relevant structural engineering experience..." -> 3
//     "How many years of work experience do you have with COBOL?"       -> 3
//
// Three years of anesthesiology is a false statement typed into a real application, produced by
// the one rail whose whole job is to answer only what it can ground.
//
// Measured across the 793 distinct years-questions in his live answer bank, the gate withholds 294
// that were previously answered "3": SAP ABAP, SharePoint, WordPress, Unreal, PHP, Objective-C,
// embedded firmware, Informatica, Angular, Kafka, Shopify Liquid, and so on. Every question string
// in this file is a real row from that bank.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const det = require(path.join(here, '..', 'app', 'src', 'ai', 'deterministic.js'));

// Shaped like his real resume, trimmed to the parts this gate reads.
const RESUME = [
  'Pierre Salama. Full-Stack Software Engineer, Web & Desktop. Toronto, ON. Bilingual EN/FR.',
  'SUMMARY Full-Stack Software Engineer shipping production JavaScript/TypeScript, React,',
  'Node.js, Python, and Rust end-to-end, from database migration to CI/CD release to a live UI.',
  'Primary developer of a 15+-app operations platform (Electron/React on a shared template).',
  'PostgreSQL, SQL, Tauri, Java. Toronto Metropolitan University, BSc Computer Science.',
].join(' ');
const PROFILE = { data: { yearsExperience: '3', fullName: 'Pierre Salama', major: 'Computer Science' } };

const ask = (q) => {
  const r = det.answer(q, { profile: PROFILE, resume: RESUME });
  return r && r.answer != null ? String(r.answer) : null;
};

// ---------------------------------------------------------------------------
// answered: the question is generic, or names a subject the resume evidences
// ---------------------------------------------------------------------------
for (const q of [
  'How many years of professional software development experience do you have?',
  'how many years of experience do you have in software development?',
  'how many years of software engineering industry experience do you have excluding internships',
  'how many years of javascript typescript experience do you have',
  'how many years of work experience do you have with react js',
  'How many years of experience do you have working with React in a professional setting',
  'how many years of nodejs experience do you have',
  'how many years of hands-on experience do you have with python backend development?',
  'how many years of experience do you have working with sql',
  'how many years of frontend development experience do you have?',
  'how many years of professional backend engineering experience do you have',
  'how many years of experience do you have a full stack developer?',
]) {
  test(`answers from the number: ${q.slice(0, 56)}`, () => {
    assert.equal(ask(q), '3', `he can be shown to have this: ${q}`);
  });
}

// ---------------------------------------------------------------------------
// withheld: a named subject with nothing behind it
//
// null, not "0". null defers to the AI, which reads the whole resume and can tell "he has never
// done this" apart from "the resume does not spell it out". Guessing 0 would understate real
// experience exactly as readily as 3 overstates it.
// ---------------------------------------------------------------------------
for (const q of [
  'How many years of anesthesiology experience do you have?',
  'how many years of relevant structural engineering experience do you have',
  'how many years of work experience do you have with cobol',
  'how many years of abap experience do you have',
  'how many years of sap crm experience do you have?',
  'how many years of work experience do you have with sharepoint?',
  'how many years of work experience do you have with objective-c?',
  'how many years of php experience do you have',
  'how many years of wordpress experience do you have',
  'how many years of work experience do you have with angular?',
  'how many years of work experience do you have with pytorch',
  'how many years of professional unreal development experience do you have',
  'how many years of work experience do you have with solidworks?',
  'how many years of embedded c c experience do you have',
]) {
  test(`withholds, nothing evidences it: ${q.slice(0, 56)}`, () => {
    assert.equal(ask(q), null, `nothing on file supports this: ${q}`);
  });
}

// ---------------------------------------------------------------------------
// A FIELD ID IS NOT A SUBJECT
//
// Forms leave their own element names in the scraped label. Both of these are real rows, and both
// are the plainest generic question there is.
// ---------------------------------------------------------------------------
test('a trailing field id does not turn a generic question into a specific one', () => {
  assert.equal(ask('how many years of software development experience do you have? * q_e7eba7a812f508e6f7df4be1fa0c394'), '3');
  assert.equal(ask('how many years of experience do you have in software development? type here... question_14259385004'), '3');
});

test('but a real subject beside a field id is still a subject', () => {
  assert.equal(ask('how many years of nosql databases experience do you have? * q_20ee9b7e3563c3b260227889b06de347'), null);
});

// ---------------------------------------------------------------------------
// punctuation is not identity, and a one-letter stem is not evidence
// ---------------------------------------------------------------------------
test('"nodejs" matches a resume that writes "Node.js"', () => {
  assert.equal(ask('how many years of nodejs experience do you have'), '3');
  assert.equal(ask('how many years of node.js experience do you have'), '3');
});

test('"C#" is not evidenced by every resume containing the letter c', () => {
  // The stem rule requires 3+ characters precisely so these stay null.
  assert.equal(ask('how many years of work experience do you have with c#?'), null);
  assert.equal(ask('how many years of work experience do you have with c++?'), null);
});

test('with no years on file at all the branch still declines, exactly as before', () => {
  const r = det.answer('How many years of React experience do you have?', { profile: { data: {} }, resume: '' });
  assert.equal(r && r.answer != null ? String(r.answer) : null, null);
});
