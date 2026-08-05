// The Gmail parser must recognise the acknowledgement formats that actually arrive.
// Live gap this guards: 23 of 100 emails were unlinked — 9 "your application was viewed by X"
// and 8 "Indeed Application: <role>" — so those jobs never advanced past submitted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'app', 'src', 'gmail.js'), 'utf8');

const rx = (name) => {
  const m = src.match(new RegExp(`const ${name} = (/.*?/i);`));
  assert.ok(m, `${name} must exist`);
  return eval(m[1]);
};

test('parses LinkedIn "application was viewed by <company>"', () => {
  const m = 'Your application was viewed by J&M Group'.match(rx('SUBJ_VIEWED_RX'));
  assert.equal(m[1].trim(), 'J&M Group');
});

test('parses "Thank you for applying to <company>"', () => {
  assert.equal('Thank You for Applying to Modular Solutions'.match(rx('SUBJ_THANKS_RX'))[1].trim(), 'Modular Solutions');
});

test('parses "Indeed Application: <title>" (company is never present)', () => {
  const m = 'Indeed Application: Backend Focused Full-Stack Developer'.match(rx('SUBJ_INDEED_RX'));
  assert.equal(m[1].trim(), 'Backend Focused Full-Stack Developer');
});

test('a title-only email matches ONLY when the title is unambiguous', () => {
  // Guessing between two same-titled jobs would advance the wrong application.
  const fn = src.slice(src.indexOf('function matchJob'));
  assert.match(fn, /byTitle\.length === 1 \? byTitle\[0\] : null/, 'must decline on an ambiguous title');
});

test('company-based matching is unchanged', () => {
  const fn = src.slice(src.indexOf('function matchJob'));
  assert.match(fn, /sameCo\.length === 1 \? sameCo\[0\] : null/, 'existing company path must remain');
});
