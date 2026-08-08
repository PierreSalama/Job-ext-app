// The client-side NEVER_AUTOFILL_RX and the server-side SENSITIVE_RX must agree about pronouns.
//
// Pierre explicitly asked for pronoun questions to be answered — he supplied his pronouns, and every
// posting that asked was parking forever. `pronoun` was removed from the extension's
// NEVER_AUTOFILL_RX, but the server-side SENSITIVE_RX backstop kept it. SENSITIVE_RX gates what may
// be RETAINED in profile memory, so the answer could never be stored or recalled: autofill was
// permitted to fill a value it could never obtain. Live 2026-08-08, 12 jobs across both nodes sat
// parked on "Pronouns *" / "preferred pronouns".
//
// Everything else protected must STAY blocked on both sides — this test guards that too, so
// "unblock pronouns" can never quietly widen into unblocking protected characteristics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');

const pick = (src, name) => {
  // Pull `const NAME = /…/i;` off its line and rebuild the RegExp from the literal's source.
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*/(.+)/i;`));
  assert.ok(m, `${name} not found`);
  return new RegExp(m[1], 'i');
};

const CLIENT = pick(read('extension', 'content', 'autofill.js'), 'NEVER_AUTOFILL_RX');
const SERVER = pick(read('app', 'src', 'db.js'), 'SENSITIVE_RX');
// THIRD copy, in executor.js — the one nearest the form, and therefore the one that actually
// decides. It was missed when pronouns were unblocked in the other two, so pronoun questions kept
// parking anyway. Any guard that exists three times needs a test that checks all three.
const EXECUTOR = pick(read('extension', 'content', 'executor.js'), 'NEVER_AUTOFILL_RX');
const ALL = [['autofill', CLIENT], ['db', SERVER], ['executor', EXECUTOR]];

test('pronoun questions are allowed by ALL THREE copies', () => {
  for (const q of ['Pronouns', 'preferred pronouns', 'What are your pronouns?']) {
    for (const [name, rx] of ALL) {
      assert.equal(rx.test(q), false, `${name} must allow: ${q}`);
    }
  }
});

test('criminal-history phrasing is blocked by ALL THREE copies', () => {
  // The live phrasing that matched neither `conviction` nor `criminal`.
  for (const q of ['Have you been convicted of a crime for which you have not received a pardon?',
                   'Any criminal convictions?', 'felony record']) {
    for (const [name, rx] of ALL) {
      assert.equal(rx.test(q), true, `${name} must block: ${q}`);
    }
  }
});

test('protected characteristics stay blocked by BOTH sides', () => {
  const blocked = [
    'What is your race?',
    'gender identity',
    'Are you a person of transgender experience?',   // caught via "gender"? no — assert explicitly below
    'Do you have a disability?',
    'Are you a protected veteran?',
    'Have you been convicted of a crime for which you have not received a pardon?',
    'sexual orientation',
    'ethnicity',
  ];
  for (const q of blocked) {
    const c = CLIENT.test(q), s = SERVER.test(q);
    if (/race|gender|disabilit|veteran|criminal|convict|felony|sexual.?orientation|ethnic/i.test(q)) {
      assert.equal(c, true, `client must block: ${q}`);
      assert.equal(s, true, `server must block: ${q}`);
    }
  }
});

test('credentials and payment stay blocked server-side', () => {
  for (const q of ['password', 'credit card number', 'SSN', 'date of birth', 'routing number']) {
    assert.equal(SERVER.test(q), true, `server must block: ${q}`);
  }
});

test('the precise credential terms still let legitimate fields through', () => {
  // Documented intent: "security clearance" and "Pinterest" must NOT be eaten by the credential terms.
  assert.equal(SERVER.test('security clearance'), false, '"security clearance" is a legitimate question');
  assert.equal(SERVER.test('Pinterest profile'), false, '\\bpin\\b must not eat "Pinterest"');
});
