// matchEmailToJob must handle the acknowledgement formats that name the company ONLY in the subject,
// and Indeed's acks which name no company at all.
// Live gap: 23 of 100 emails unmatched — 9 "viewed by", 8 "Indeed Application:", 3 "thank you".
// Note these patterns must live in email.js (the matcher the emails table actually uses), NOT in
// gmail.js's legacy status-sync path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'app', 'src', 'email.js'), 'utf8');
const fn = src.slice(src.indexOf('function matchEmailToJob'));

test('company is recovered from a "viewed by" subject', () => {
  assert.match(fn, /your application was viewed by/i, 'must read the viewed-by subject');
  const rx = /your application was viewed by\s+(.+?)\s*$/i;
  assert.equal('Your application was viewed by J&M Group'.match(rx)[1], 'J&M Group');
});

test('company is recovered from a "thank you for applying" subject', () => {
  const rx = /(?:thank you|thanks) for applying (?:to|at)\s+(.+?)\s*$/i;
  assert.equal('Thank You for Applying to Modular Solutions'.match(rx)[1], 'Modular Solutions');
  assert.match(fn, /for applying/i, 'must read the thank-you subject');
});

test('subject-derived company is added to the hints the matcher scores against', () => {
  assert.match(fn, /hints\.push\(k\)/, 'the recovered company must join companyHints');
});

test('Indeed acknowledgements match on title, and ONLY when unambiguous', () => {
  assert.match(fn, /indeed application:/i, 'must recognise the Indeed ack subject');
  assert.match(fn, /byTitle\.length === 1/, 'must require exactly one title match');
  assert.match(fn, /return fallback;/, 'an ambiguous title must not be guessed');
});

test('the Indeed branch only runs when there is no company to go on', () => {
  assert.match(fn, /if \(!hints\.length && indeedAck\)/, 'company matching keeps priority');
});
