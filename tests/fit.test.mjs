// Deterministic fit scorer — sanity bounds and overlap behaviour.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fit = require('../app/src/fit.js');

const JOB = {
  title: 'Senior React Developer',
  description: 'We need React, TypeScript, Node.js, GraphQL and CSS experience. Docker a plus.',
};

test('empty profile scores zero', () => {
  assert.equal(fit.score(JOB, { data: {} }, '').score, 0);
});

test('strong overlap scores higher than weak overlap', () => {
  const strong = fit.score(JOB, { data: { skills: ['React', 'TypeScript', 'Node.js', 'GraphQL', 'CSS', 'Docker'] } }, '');
  const weak = fit.score(JOB, { data: { skills: ['Photoshop'] } }, '');
  assert.ok(strong.score > weak.score, `${strong.score} should beat ${weak.score}`);
  assert.ok(strong.score <= 100 && strong.score >= 0);
});

test('resume text contributes to the match', () => {
  const withResume = fit.score(JOB, { data: {} }, 'Built React and GraphQL apps with TypeScript for 5 years.');
  assert.ok(withResume.score > 0);
  assert.ok(withResume.matched.includes('react'));
});

test('score is bounded 0-100', () => {
  const r = fit.score(JOB, { data: { skills: JOB.description.split(' ') } }, JOB.description);
  assert.ok(r.score >= 0 && r.score <= 100);
});
