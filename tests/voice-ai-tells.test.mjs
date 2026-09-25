// THE GATE HAS TO CATCH SLOP AND STILL LET PIERRE THROUGH.
//
// The point of these applications is interviews. A recruiter who reads a letter as machine-written
// stops reading, so the voice gate is the difference between a submitted application and a wasted
// one. Pierre named eight tells himself; these are the ones that actually give a document away.
//
// The gate REFUSES the document, which makes a false positive expensive: not a warning, a lost
// application. So this file asserts BOTH directions, and the second half matters more than the
// first. Words like "robust", "seamless", "scalable" and "optimise" are deliberately NOT rules —
// they are ordinary engineering vocabulary in an engineering resume, and banning them would refuse
// honest sentences about real work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { voiceCheck, report } = require(path.join(here, '..', 'app', 'src', 'ai', 'voice-check.js'));

// A violation carries `rule` (the id), not `id` — I asserted the wrong field first and every
// positive case failed while the gate itself was working perfectly.
const ids = (text) => voiceCheck(text).violations.map((v) => v.rule);

// ---------------------------------------------------------------------------
// caught
// ---------------------------------------------------------------------------
const TELLS = [
  ['delve', 'Let me delve into the details of that project.'],
  ['testament', 'The result was a testament to careful planning.'],
  ['writing-to', 'I am writing to express my interest in the role.'],
  ['track-record', 'I have a proven track record of shipping software.'],
  ['seasoned', 'As a seasoned developer I know the tradeoffs.'],
  ['fast-paced', 'I thrive in a fast-paced environment.'],
  ['wealth', 'I bring a wealth of experience to the team.'],
  ['ground-running', 'I can hit the ground running on day one.'],
  ['synergy', 'There are real synergies between the teams.'],
  ['spearhead', 'I spearheaded the migration to Postgres.'],
  ['worth-noting', "It's worth noting that the API was undocumented."],
  ['confident-that', 'I am confident that I can do this work.'],
  ['align-resonate', 'My background aligns well with your requirements.'],
  ['cutting-edge', 'We used cutting-edge tooling throughout.'],
  ['formal-connective', 'Furthermore, the deploy time dropped by half.'],
  ['not-only', 'I not only wrote the parser but also shipped the CLI.'],
  ['tapestry', 'In an ever-evolving landscape, adaptability matters.'],
  ['todays', "In today's competitive market, speed wins."],
];

for (const [id, sentence] of TELLS) {
  test(`catches: ${id}`, () => {
    const found = ids(sentence);
    assert.ok(found.includes(id), `"${sentence}" should trip ${id}, got [${found.join(', ')}]`);
  });
}

test('a letter built out of tells is refused outright', () => {
  const slop = 'I am writing to express my strong interest. I bring a proven track record and a wealth of '
    + 'experience thriving in fast-paced environments. Furthermore, I spearheaded cutting-edge initiatives, '
    + 'a testament to my ability to hit the ground running. I am confident that my skills align well with your needs.';
  const v = voiceCheck(slop);
  assert.equal(v.ok, false);
  assert.ok(v.violations.length >= 8, `expected a pile of findings, got ${v.violations.length}`);
});

// ---------------------------------------------------------------------------
// NOT caught — the half that protects real applications
// ---------------------------------------------------------------------------
test('Pierre writing plainly about his own work passes clean', () => {
  const real = 'I built an auto-apply system for my own job search. It runs unattended on a spare laptop '
    + 'and has filed over 400 applications, answering screening questions from my real history rather than '
    + 'guessing. I would like to build tools like that for you.';
  const v = voiceCheck(real);
  assert.equal(v.ok, true, report(v));
});

test('ordinary engineering vocabulary is NOT a violation', () => {
  // Every one of these is a word a real developer writes about real work. Banning them would refuse
  // honest resumes, which costs an application each time.
  const engineering = 'I wrote robust error handling around a flaky upstream API, made the sync '
    + 'seamless for the user, and kept the queue scalable to a few hundred thousand rows. I optimise '
    + 'the slow paths only after measuring them.';
  const v = voiceCheck(engineering);
  assert.equal(v.ok, true, report(v));
});

test('a technical use of "landscape" or "align" survives', () => {
  // 'align' alone is fine — CSS aligns, data aligns. Only "aligns with your" is the tell.
  const v = voiceCheck('I aligned the columns in the report and surveyed the tooling landscape before choosing.');
  assert.equal(v.ok, true, report(v));
});

test('the original eight rules Pierre named still fire', () => {
  const found = ids('I wanted to reach out; I am passionate about this and excited to leverage my skills — really.');
  for (const id of ['reach-out', 'semicolon', 'passionate', 'excited', 'leverage', 'em-dash']) {
    assert.ok(found.includes(id), `original rule ${id} stopped firing, got [${found.join(', ')}]`);
  }
});

test('the refusal tells the model WHERE and WHAT to change', () => {
  // A gate that only says "no" makes the model guess. Each finding carries the phrase, a concrete
  // fix, and the surrounding text.
  const r = report(voiceCheck('I am writing to express interest in your fast-paced team.'));
  assert.match(r, /voice check FAILED/);
  assert.match(r, /I am writing to/);
  assert.match(r, /open with what you did/);
  assert.match(r, /line \d+/);
});

test('HTML is decoded before checking, so entities are not false positives', () => {
  // &middot; ends in a semicolon. The old check reported that as a violation and the workaround was
  // to disable the semicolon rule for HTML entirely.
  const v = voiceCheck('<p>Toronto &middot; Remote &amp; hybrid</p>', { html: true });
  assert.equal(v.ok, true, report(v));
});
