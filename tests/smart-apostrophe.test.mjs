// Real web copy uses the TYPOGRAPHIC apostrophe U+2019 ("today’s"), not ASCII U+0027.
// A regex written with a bare ' silently never matches the string it was written for.
//
// This cost a full day of production throughput on 2026-07-20. LinkedIn's daily-cap modal reads
// "You reached today’s Easy Apply limit", and EASYAPPLY_LIMIT_RX was /reached (today'?s )?easy
// apply limit/i, so the cap was NEVER detected: setEasyApplyCooldown() had never armed once, and
// after the ~50/24h cap the pool kept feeding LinkedIn jobs that could not possibly succeed, each
// burning a full run and failing as "repeated page-level action did not transfer".
//
// Verified against the live DOM before fixing: clicking the opener opened the modal (dialog
// present, cap copy in document.body.innerText) while the regex returned false.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'extension', 'content', 'executor.js'), 'utf8');

// Rebuild the executor's regexes from source so the test tracks the real definitions.
function regexFromSource(name) {
  const line = src.split('\n').find((l) => l.includes(`const ${name} =`));
  assert.ok(line, `${name} not found in executor.js`);
  const literal = line.match(/=\s*(\/.*\/[gimsuy]*);/);
  if (literal) return eval(literal[1]);                     // plain /.../ literal
  const built = line.match(/new RegExp\(`(.*)`,\s*'([gimsuy]*)'\)/);
  assert.ok(built, `${name} is neither a literal nor a template RegExp`);
  const APOS = "['’ʼ‘`´]";
  return new RegExp(built[1].replace(/\$\{APOS\}/g, APOS).replace(/\\\\/g, '\\'), built[2]);
}

// The EXACT string LinkedIn ships (curly apostrophe), captured from the live page.
const LIVE_CAP_TEXT = 'You reached today’s Easy Apply limit\n\nGreat effort applying today.';

test('the daily-cap regex matches the apostrophe LinkedIn actually ships', () => {
  const rx = regexFromSource('EASYAPPLY_LIMIT_RX');
  assert.ok(rx.test(LIVE_CAP_TEXT), 'must match the curly-apostrophe copy from the live modal');
  assert.ok(rx.test("You reached today's Easy Apply limit"), 'must still match ASCII');
  assert.ok(rx.test('You reached Easy Apply limit'), 'must still match the no-possessive variant');
});

test('the generic daily-limit fallback matches both apostrophes', () => {
  const rx = regexFromSource('DAILY_LIMIT_NEAR_EASYAPPLY_RX');
  assert.ok(rx.test('today’s Easy Apply limit'), 'curly');
  assert.ok(rx.test("today's Easy Apply limit"), 'ascii');
  assert.ok(rx.test('daily Easy Apply limit'), 'daily variant');
});

test('the captcha regex matches "you’re human", not only "you\'re human"', () => {
  const rx = regexFromSource('CAPTCHA_RX');
  assert.ok(rx.test('verify you’re human'), 'curly — a missed captcha means the run never parks for the user');
  assert.ok(rx.test("verify you're human"), 'ascii');
  assert.ok(rx.test('verify you are human'), 'spelled out');
});

test('no regex in executor.js pairs a bare ASCII apostrophe with a contraction', () => {
  // Cheap guard against reintroducing the class. Any regex constant containing an apostrophe
  // must offer the curly form too.
  const offenders = src.split('\n')
    .filter((l) => /const [A-Z_]+_RX\s*=/.test(l))
    .map((l) => l
      .replace(/\$\{APOS\}/g, '')          // the shared apostrophe class is the fix, not an offence
      .replace(/,\s*'[gimsuy]*'\s*\)/g, '')  // the RegExp flags argument is not part of the pattern
      .replace(/\[[^\]]*’[^\]]*\]/g, ''))    // an explicit ['’…] class already handles both forms
    .filter((l) => /'(?=[a-z?])/.test(l));
  assert.deepEqual(offenders, [], 'these regexes would miss real typographic copy');
});
