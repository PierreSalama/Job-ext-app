// ONE DEFAULT, NOT TWO THAT CONTRADICT EACH OTHER.
//
// The start-date branch answered "2 weeks" to a notice question and "Immediately" to a start-date
// one, from the same branch, on the same run. Both cannot be true: owing two weeks of notice is
// exactly what makes an immediate start impossible. Two employers asking the same thing in
// different words got different promises, and one of them was a promise he could not keep.
//
// Neither string was ever a fact about him. noticePeriod and availability are both unset on his
// profile, so both were invented defaults. His own answers are not silent though. The live bank
// holds "2 weeks from offer" five times, "2 weeks notice" twice, "2 weeks" twice and "About 2 weeks
// after accepting" twice: eleven rows in his own words, and not one of them says immediately.
//
// So the two-week reading is the one with a source, and it is now the only default here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const det = require(path.join(here, '..', 'app', 'src', 'ai', 'deterministic.js'));

const BASE = { firstName: 'Pierre', city: 'Toronto', region: 'Ontario', country: 'Canada' };
const ask = (data, q) => {
  const r = det.answer(q, { profile: { data }, resume: '' });
  return r && r.answer != null ? String(r.answer) : null;
};

test('a start-date question no longer promises an immediate start', () => {
  for (const q of [
    'When can you start?',
    'What is your earliest start date?',
    'What is your availability to start?',
    'What is your start date?',
  ]) {
    assert.equal(ask(BASE, q), '2 weeks from offer', q);
  }
});

test('a notice question still answers in notice terms', () => {
  assert.equal(ask(BASE, 'What is your notice period?'), '2 weeks');
  assert.equal(ask(BASE, 'How much notice do you need to give?'), '2 weeks');
  assert.equal(ask(BASE, 'What is your notice period with your current employer?'), '2 weeks');
});

test('the two answers agree with each other, which is the whole point', () => {
  // Asserted as a relationship rather than two literals, so a future edit to one of them cannot
  // quietly reintroduce the contradiction.
  const start = ask(BASE, 'When can you start?');
  const notice = ask(BASE, 'What is your notice period?');
  assert.ok(start.includes(notice), `a start of "${start}" must be consistent with a notice of "${notice}"`);
});

test('a profile that states the real answer still overrides the default', () => {
  assert.equal(ask({ ...BASE, noticePeriod: '4 weeks' }, 'When can you start?'), '4 weeks');
  assert.equal(ask({ ...BASE, noticePeriod: '4 weeks' }, 'What is your notice period?'), '4 weeks');
  assert.equal(ask({ ...BASE, availability: 'Available immediately' }, 'When can you start?'), 'Available immediately');
});
