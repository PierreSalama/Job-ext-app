// French-language coverage for the ask_human motivation guard.
//
// WHY THIS FILE EXISTS. The guard refuses to park a MOTIVATION question, because motivation is
// something the agent can write from the posting. That guard was English-only until 2026-09-05, so
// on a French posting "Pourquoi voulez-vous travailler ici?" sailed past it, got escalated, and
// PARKED THE APPLICATION. Same failure the guard was built to prevent, in the other language.
//
// The four French strings below are not invented. They are real questions from Pierre's own live
// answer bank (4,543 rows on the laptop), which is how the gap was found. One of them is bilingual,
// which is what Quebec postings actually look like.
//
// The English cases are not padding either. The first attempt at this fix REPLACED "cover letter"
// with the French alternation instead of adding to it, silently dropping ten live questions. A
// hand-written test agreed with the edit because it had been written from the edit. The live bank
// caught it. The cover-letter cases below are pinned so that particular mistake cannot come back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const db = require(path.join(root, 'app', 'src', 'db.js'));
const esc = require(path.join(root, 'app', 'src', 'ai', 'tools', 'escalate.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-escalate-fr-'));
db.open(dir);
process.on('exit', () => {
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
});

// Drive the real tool through its real guard, exactly as the agent loop does. Asserting on the
// regex directly would only prove the regex matches itself.
function askHuman(question) {
  const b = esc.makeEscalateTools({
    onBlock: () => {},
    context: () => ({ company: 'Acme', title: 'Developpeur', url: 'https://jobs.lever.co/acme/1' }),
  });
  const tool = b.tools.find((t) => t.name === 'ask_human');
  return tool.guard({ kind: 'needs_answer', question }, {});
}

const refused = (q) => String(askHuman(q) || '').startsWith('refused:');

// ---------------------------------------------------------------------------
// must refuse: motivation, in either language
// ---------------------------------------------------------------------------
const MOTIVATION = [
  // straight from the live bank
  "Pourquoi souhaitez-vous faire partie de l'equipe Beem?",
  "Qu'est-ce qui vous motive a appliquer sur ce role ? / What is motivating you to apply for this role?",
  'Lettre de motivation (facultatif)',
  // ordinary French phrasings the same postings use
  'Pourquoi voulez-vous travailler ici?',
  "Qu'est-ce qui vous attire dans ce poste?",
  'Parlez-nous de vous',
  'Pourquoi ce poste vous interesse-t-il?',
  // English, including the cover-letter forms a bad edit dropped once already
  'Why do you want to work here?',
  'Tell us a bit about yourself',
  'Write a cover letter',
  'Add cover letter',
  'Cover letter (optional)',
  'Cover letter or additional information',
];

for (const q of MOTIVATION) {
  test(`motivation is refused, not parked: ${q.slice(0, 52)}`, () => {
    assert.equal(refused(q), true, `should have been refused as motivation: ${q}`);
  });
}

// ---------------------------------------------------------------------------
// must NOT refuse: a FACT about the candidate still parks, in either language
//
// This is the direction that matters most. Over-matching here would make the agent refuse to
// escalate a real factual question and answer it instead, which is how a wrong claim gets typed
// into a form. FACT_RX is checked first for exactly this reason.
// ---------------------------------------------------------------------------
const FACTS = [
  'Quelles sont vos attentes salariales?',
  'Etes-vous legalement autorise a travailler au Canada?',
  'Avez-vous besoin de parrainage pour un permis de travail?',
  "Combien d'annees d'experience avez-vous avec Rust?",
  'What are your salary expectations?',
  'Do you require sponsorship to work in Canada?',
];

for (const q of FACTS) {
  test(`a fact still parks, never refused: ${q.slice(0, 52)}`, () => {
    assert.equal(refused(q), false, `should have parked, not been refused: ${q}`);
  });
}

// ---------------------------------------------------------------------------
// the bilingual case, spelled out
//
// A Quebec posting often asks once in French and once in English on the same line. Whichever half
// the pattern recognises, the verdict has to be the same, or the behaviour depends on word order.
// ---------------------------------------------------------------------------
test('a bilingual motivation question is refused from either half', () => {
  const fr = "Qu'est-ce qui vous motive a postuler?";
  const en = 'What is motivating you to apply for this role?';
  assert.equal(refused(fr), true, 'French half alone');
  assert.equal(refused(en), true, 'English half alone');
  assert.equal(refused(`${fr} / ${en}`), true, 'French first');
  assert.equal(refused(`${en} / ${fr}`), true, 'English first');
});

// ---------------------------------------------------------------------------
// the English gap the bilingual row exposed
//
// Chasing the French half of "Qu'est-ce qui vous motive a appliquer sur ce role ? / What is
// motivating you to apply for this role?" showed the ENGLISH half was not matched either. Diffing
// the guard against the whole live bank then turned up twenty more. Every string below is a real
// question from that bank, trimmed. Before this fix each one ESCALATED and parked the application.
// ---------------------------------------------------------------------------
const LIVE_ENGLISH = [
  'why railway? why railway? why railway? type here...',
  'why wealthsimple? why wealthsimple? why wealthsimple? type here...',
  'why elevenlabs, and why now?',
  'why planet? why planet?',
  'in one short paragraph please describe why your qualifications and experience make you a strong fit for this position',
  'what motivates you to do what you do?',
  'what motivates you to apply for this position?',
  'what is motivating you to apply for this role?',
  "tell us something about yourself that we wouldn't find on your resume.",
  'tell us why you are specifically interested in this role with our organization?',
  'tell us why you would like to work with us?',
  'tell us why you want to join noibu!',
  'tell us why you would be the ideal candidate for this role?',
  'please tell us why you are interested in this exciting position and how it fits with your career goals',
  'please share two lines on your motivation to join sardine',
  'please share your top 2 reasons why you think you would be an amazing fit for this role',
  'describe to me why you enjoy working in a fast paced start-up environment',
  'provide a short overview of the technical skills that make you a good fit for this position',
];

for (const q of LIVE_ENGLISH) {
  test(`live bank, was parked before the fix: ${q.slice(0, 46)}`, () => {
    assert.equal(refused(q), true, `should be answered by the agent, not escalated: ${q}`);
  });
}

// ---------------------------------------------------------------------------
// the neighbours these clauses sit next to in the same bank
//
// The bank is full of work-authorization and salary questions whose wording brushes up against the
// clauses above: "are you legally authorized to work in the country to which you are applying",
// "what annual salary would make you excited to sign an offer". Those must keep escalating. This is
// the assertion that would fail if a clause were ever widened carelessly.
// ---------------------------------------------------------------------------
const NEIGHBOURS = [
  'are you legally authorized to work in the country to which you are applying?',
  'will you now or in the future require employer sponsorship or other employer assistance?',
  'to which country are you applying?',
  'what annual salary (in cad) would make you excited to sign an offer for this role?',
  'what are your compensation expectations for the role you are applying for?',
  'does the role you are applying for include managing direct reports?',
  'if you do not live in the location you are applying to, are you willing to relocate?',
];

for (const q of NEIGHBOURS) {
  test(`near miss must still escalate: ${q.slice(0, 46)}`, () => {
    assert.equal(refused(q), false, `should have parked, not been refused: ${q}`);
  });
}
