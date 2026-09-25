// A BARE YES/NO IS NOT AN ANSWER TO A QUESTION THAT WANTS PROSE.
//
// Measured against the live bank 2026-09-05: 63 real questions were answered "Yes" or "No" by the
// deterministic floor although their shape is free text. Most were merely useless. Some were not:
//
//   "this role requires you to already be eligible to work in canada.
//    what is your current work status in canada"                           -> "No"
//   "What is your preferred work arrangement (remote, hybrid, or onsite)?"  -> "Yes"
//   "please explain your immigration/work authorization status in canada."  -> "Yes"
//   "current location, we use this to determine whether we can legally
//    employ you in the entity where you are located"                        -> "Yes"
//
// The first types "No" into a box asking for his work status, which reads as a man saying he is not
// eligible to work in Canada. The last types "Yes" into a location field.
//
// The mechanism is worth naming: these questions reach branches like RELOCATION or SPONSORSHIP on a
// keyword ("remote", "hybrid", "sponsorship", "status"), and those branches emit a yes/no because
// that is all they know how to say. Nothing downstream asked whether the question wanted one.
//
// null here is cheap. It means the floor declines and the AI answers instead, which is what a FLOOR
// being a floor means. It is not a park.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const det = require(path.join(here, '..', 'app', 'src', 'ai', 'deterministic.js'));

const PROFILE = {
  data: {
    firstName: 'Pierre', city: 'Toronto', region: 'Ontario', country: 'Canada',
    workAuthorization: 'Authorized to work in Canada (no sponsorship required)',
  },
};
const ask = (q, options) => {
  const r = det.answer(q, { profile: PROFILE, resume: '', options });
  return r && r.answer != null ? String(r.answer) : null;
};

// Every string below is a real question from his bank.
for (const q of [
  'this role requires you to already be eligible to work in canada. what is your current work status in canada',
  'What is your preferred work arrangement (remote, hybrid, or onsite)?',
  'please explain your immigration/work authorization status in canada.',
  'current locationwe use this to determine whether we can legally employ you in the entity where you are located',
  'What best describes your interest in hybrid work at Homebase?',
  'if you do require employee sponsorship or assistance for work authorization please list the type of support',
  'which engineering degree or diploma did you complete and at which institution',
  'please indicate the program you are/were enrolled in for your post-secondary education',
]) {
  test(`no bare yes/no for a question wanting prose: ${q.slice(0, 52)}`, () => {
    assert.equal(ask(q), null, `must decline and let the model answer: ${q}`);
  });
}

// ---------------------------------------------------------------------------
// and the questions that really are yes/no keep working, which is the constraint
// ---------------------------------------------------------------------------
test('a genuine yes/no question is still answered', () => {
  assert.equal(ask('Are you willing to relocate?'), 'Yes');
  assert.equal(ask('Are you legally authorized to work in Canada?'), 'Yes');
  assert.equal(ask('Do you require sponsorship to work in Canada?'), 'No');
  assert.equal(ask('Are you comfortable working in a hybrid setting?'), 'Yes');
  assert.equal(ask('Are you willing to work onsite?'), 'Yes');
});

// ---------------------------------------------------------------------------
// only the OPTION-LESS case is guarded
//
// When the field offers options, result() has already refused anything that did not match one, and
// answer()'s verbatim-option check has already returned. A form that defines "Yes" as a choice has
// told us a yes/no belongs there, whatever the label reads like.
// ---------------------------------------------------------------------------
test('a field that offers Yes as an option still gets Yes', () => {
  assert.equal(ask('What best describes your interest in hybrid work at Homebase?', ['Yes', 'No']), 'Yes');
  assert.equal(ask('What is your preferred work arrangement (remote, hybrid, or onsite)?', ['Yes', 'No']), 'Yes');
});

test('but an option list without a yes/no in it still refuses', () => {
  // pickOption already covered this; asserted here so the two guards are visibly independent.
  assert.equal(ask('What is your preferred work arrangement (remote, hybrid, or onsite)?', ['Remote', 'Hybrid', 'Onsite']), null);
});
