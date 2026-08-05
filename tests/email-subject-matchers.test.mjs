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

test('title-only matching is NOT gated on empty company hints', () => {
  // This assertion originally required `!hints.length && indeedAck` — which WAS the bug: the sender
  // indeedapply@indeed.com produces a bogus "indeed" company hint, so the branch never ran and all
  // 8 acknowledgements stayed unmatched. A job board's domain is not the employer.
  assert.ok(!/!hints\.length && (indeedAck|titleOnly)/.test(fn),
    'must not require empty hints — the job-board sender always supplies one');
  assert.match(fn, /if \(titleOnly\) \{/, 'title-only branch runs on subject shape alone');
});

// --- Regression cases taken VERBATIM from Pierre's inbox (the ones that stayed unmatched) ---

test('Indeed acknowledgements are matched by title even though the sender yields an "indeed" hint', () => {
  // The bug: the branch was gated on `!hints.length`, but indeedapply@indeed.com produces a bogus
  // company hint, so it never ran and all 8 acks were dropped. A job board is not the employer.
  assert.ok(!/if \(!hints\.length && (indeedAck|titleOnly)\)/.test(fn),
    'title-only matching must NOT be gated on empty hints');
  assert.match(fn, /const titleOnly = /, 'must have a title-only branch');
});

test('bilingual Indeed titles try each side of the slash', () => {
  assert.match(fn, /raw\.split\('\/'\)/, 'must try each half of "Développeur X / Developer X"');
});

test('"We Got It: Thanks for applying for <role>" is treated as title-only', () => {
  const rx = /^\s*we got it:\s*thanks for applying for\s+(.+?)\s*$/i;
  assert.equal('We Got It: Thanks for applying for Software Engineer, Testing'.match(rx)[1], 'Software Engineer, Testing');
  assert.match(fn, /we got it:/i);
});

test('"applying for the <role> position at <company>" recovers the company', () => {
  const rx = /for applying for the .+? position at\s+(.+?)\s*$/i;
  assert.equal('Thank you for applying for the Software Engineer, Testing position at Push Operations'.match(rx)[1], 'Push Operations');
  assert.match(fn, /position at/i);
});
