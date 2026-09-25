// ONE SALARY RULE, BOTH PATHS TO A FORM.
//
// guardrails.js refuses to let the AI agent type a number below his floor. That guard is real, and
// it only wraps the agent's `fill` tool. The autofill bundle server.js ships to the extension is the
// OTHER way a number reaches a real application: those harvested fields are matched against the
// page by the extension itself, with no agent and no recall in between, and nothing checked them.
//
// Live on the laptop 2026-09-06, with autoApply.salaryFloor set to 90000 and his profile reading
// "CAD 100,000-110,000", SEVENTY-NINE harvested answers were being shipped that bottom out at
// 85,000, every one of them from the same stale value re-harvested under differently worded
// questions:
//
//     "85000"                                     what is your desired annual base salary
//     "85000-110000"                              what are your salary requirements
//     "CAD 85,000-110,000"                        what are your salary expectations
//     "Desired base salary: CAD 85,000-110,000."  to help us understand your expectations
//
// Correcting those rows by hand would not have held, because the next one harvested tomorrow ships
// again. The floor belongs on the path, not in the data.
//
// This is the same shape as the work-authorisation gap fixed on 2026-09-04, where the recall path
// learned the rule and the bundle did not. So the rule is EXPORTED and shared now rather than
// written twice: two copies of a policy are two policies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const g = require(path.join(here, '..', 'app', 'src', 'ai', 'guardrails.js'));

const FLOOR = 90000;
const below = (label, value, opts) => g.salaryBelowFloor(label, value, FLOOR, opts);

// Every string below is a real row from his profile_fields table.
test('a harvested answer under the floor is caught, in every phrasing he has stored', () => {
  for (const [label, value] of [
    ['what is your desired annual base salary', '85000'],
    ['what are your salary requirements', '85000-110000'],
    ['what are your salary expectations', 'CAD 85,000-110,000'],
    ['expected salary cad year', 'CAD 85,000–110,000'],
    ['what are your target base salary expectations', 'CAD 85,000–110,000'],
    ['what is your expected gross salary', 'CAD 85,000–110,000'],
    ['what are your compensation expectations', 'CAD 85,000 to 110,000, depending on the role'],
  ]) {
    assert.equal(below(label, value), 85000, `must be caught: ${label} = ${value}`);
  }
});

test('the label does not have to say salary, because one live row does not', () => {
  // "to help us understand your expectations please..." names no money at all. Only the VALUE does.
  assert.equal(below('to help us understand your expectations please', 'Desired base salary: CAD 85,000-110,000. I do...'), 85000);
});

test('anything at or above the floor still ships', () => {
  for (const [label, value] of [
    ['what is your annual salary expectation', '$90,000 - $99,000'],
    ['what are your salary expectations in cad', '$90,000 - $99,999 CAD'],
    ['total annual compensation desired', '90,000 - 100,000'],
    ['what is your expected annual base compensation', '$90,000 - $105,000'],
    ['what are your compensation expectations', 'CAD 120,000–136,000'],
    ['what is your expected compensation', 'CAD 115,000-140,000'],
  ]) {
    assert.equal(below(label, value), null, `must still ship: ${label} = ${value}`);
  }
});

// ---------------------------------------------------------------------------
// what must never be mistaken for money
//
// lowestSalaryIn accepts only 4-7 digit numbers between 20,000 and 1,000,000, which is what keeps
// this from eating unrelated fields. Asserted here because the bundle applies it to EVERY harvested
// field, not just the ones a human would call a salary question.
// ---------------------------------------------------------------------------
test('a number that is not a salary is left alone', () => {
  assert.equal(below('how many users did your system serve?', '50000'), null, 'no salary word in label or value');
  assert.equal(below('how many years of experience do you have?', '3'), null);
  assert.equal(below('mobile phone number', '6479637745'), null);
  assert.equal(below('what is your postal code?', 'M1B 2K9'), null);
  assert.equal(below('employee id', '85000'), null, 'a bare id is not a salary question');
});

test('a salary field with no number in it is not a violation', () => {
  assert.equal(below('what is your salary expectation', 'Negotiable'), null);
  assert.equal(below('hourly rate in the currency of the country', 'Canada'), null);
  assert.equal(below('do your compensation expectations align with the range?', 'Yes'), null);
});

test('no floor configured means no filtering at all', () => {
  assert.equal(g.salaryBelowFloor('what are your salary expectations', '85000', 0), null);
  assert.equal(g.salaryBelowFloor('what are your salary expectations', '85000', undefined), null);
});

// ---------------------------------------------------------------------------
// the agent-only case
//
// When the page could not be read, the agent has no label, so the SHAPE of the value stands in for
// it. The bundle never passes this: it always knows the field's own label.
// ---------------------------------------------------------------------------
test('an unreadable label falls back to the value shape, for the agent path only', () => {
  assert.equal(below('', '85000'), null, 'no label, no salary word, not flagged');
  assert.equal(below('', '85000', { unreadable: true }), 85000, 'unreadable page: judge by shape');
  assert.equal(below('', '3', { unreadable: true }), null, 'and years of experience still are not money');
});
