// Pierre's standing rules, carried on every real application.
//
// They used to live in whatever goal text happened to be typed into the box, which meant they were
// only as reliable as the last person to retype them. The first real run went out with a goal that
// told the agent to write a cover letter whether or not anything asked for one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { APPLY_RULES } = require(path.join(root, 'app/src/ai/apply-runner.js'));

test('the rules cover every line Pierre has actually drawn', () => {
  for (const [what, re] of [
    ['no duplicates, on any machine', /twice, on any machine/],
    ['never invent experience', /Never invent experience/],
    ['tailor wording, not facts', /wording only, never in facts/i],
    ['cover letter only on request', /ONLY if the form or the posting asks/],
    // A real Ritual run asked Pierre for a degree that was written in his own résumé, because the
    // Greenhouse Degree field is a dropdown and it had no way to operate one.
    ['re-read the résumé before escalating a fact', /re-read my_resume/],
    ['a dropdown is not a missing answer', /dropdown is not a missing answer/],
    // The real Ritual run refused University of Toronto (correct) and parked, while the résumé in
    // its hands said "(formerly Ryerson University)" and the search offered exactly that.
    ['try the former name before escalating', /FORMER name/],
    ['never the closest wrong institution', /Never pick a different institution/],
    // On the real Ritual form the only country widget IS the phone-code picker, and "Canada +1"
    // was the right pick. A rule saying otherwise would have sent the agent looking for a field
    // that does not exist.
    ['Canada +1 is a correct pick in a phone-code picker', /Choosing "Canada \+1" there/],
    ['self-ID left blank', /voluntary diversity questions blank/],
    ['no CAPTCHA, account or password', /human check, make an account, or type/],
  ]) assert.match(APPLY_RULES, re, `missing rule: ${what}`);
});

test('the rules obey the rules', () => {
  // They are part of the prompt, and the model copies the punctuation it is shown.
  for (const ch of ['\u2014', '\u2013', ';']) {
    assert.equal(APPLY_RULES.includes(ch), false, `the rules must not contain ${JSON.stringify(ch)}`);
  }
});

test('they are attached to real runs and NOT to the sandbox self-test', () => {
  const src = fs.readFileSync(path.join(root, 'app/src/ai/apply-runner.js'), 'utf8');
  assert.match(src, /systemExtra: toolset === 'sandbox' \? '' : APPLY_RULES/);
});

test('the resume tool demands tailoring and forbids inventing', () => {
  const { makeDocumentTools } = require(path.join(root, 'app/src/ai/tools/documents.js'));
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-rules-'));
  const tools = makeDocumentTools({ root: docs }).tools;
  const resume = tools.find((t) => t.name === 'write_resume');
  assert.match(resume.description, /ALWAYS tailor/);
  assert.match(resume.description, /words the posting/);
  assert.match(resume.description, /WORDING ONLY/);
  assert.match(resume.description, /Never add a skill/);

  const letter = tools.find((t) => t.name === 'write_cover_letter');
  assert.match(letter.description, /ONLY do this when/);
  assert.match(letter.description, /skip this tool entirely/);
});

test('an apply run with no target is refused, not quietly turned into the sandbox', async () => {
  // Seen on the real AI Apply page: the goal box is optional and blank fell through to DEMO_GOAL,
  // the sandbox self-test. Pick "Apply", leave it empty, and the run opens Chrome, applies to
  // nothing, and reports success.
  const runner = require(path.join(root, 'app/src/ai/apply-runner.js'));
  await assert.rejects(
    () => runner.start({ toolset: 'apply', goal: '   ' }),
    (e) => { assert.equal(e.code, 'NO_GOAL'); assert.match(e.message, /which posting/i); return true; },
  );
});

test('the sandbox self-test still runs with no goal, because that is its whole point', () => {
  const src = fs.readFileSync(path.join(root, 'app/src/ai/apply-runner.js'), 'utf8');
  assert.match(src, /\['browser', 'apply'\]\.includes\(toolset\)/);
});

test('a missing goal is a 400, not a 500', () => {
  const src = fs.readFileSync(path.join(root, 'app/src/server.js'), 'utf8');
  assert.match(src, /e\.code === 'NO_GOAL' \? 400/);
});
