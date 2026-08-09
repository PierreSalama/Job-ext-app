// "Needs you" must stay a real signal.
//
// reclaimDeadParks retires parks with NO question. The worse case is parks that LOOK answerable but
// aren't: they sit in the needs-you queue looking like work, and the questions Pierre could actually
// answer hide among them. Measured live 2026-08-09 on the laptop: 86 parked jobs, largest buckets
// 13 × "Sign into this site in Chrome", 6 × combobox screen-reader text, 2 × CAPTCHA — several
// dating to Aug 3. The queue had stopped meaning anything.
//
// The safety property that matters: ONE genuinely answerable question keeps the whole park alive,
// because answering it is what unblocks the application. Only an ALL-unactionable park is retired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const db = read('app', 'src', 'db.js');
const main = read('app', 'src', 'main.js');

const rx = (name) => new RegExp(db.match(new RegExp(`const ${name} = /(.+)/i;`))[1], 'i');
const UI_NOISE = rx('UI_NOISE_Q_RX');
const CAPTCHA = rx('CAPTCHA_Q_RX');
const LOGIN = rx('SITE_LOGIN_Q_RX');

const DAY = 86400000;
function retires(questions, updatedAt, now, loginAfterDays = 7) {
  const t = questions.map(String);
  if (!t.length) return false;
  if (t.every((x) => UI_NOISE.test(x))) return true;
  if (t.every((x) => CAPTCHA.test(x))) return true;
  if (t.every((x) => LOGIN.test(x)) && updatedAt < now - loginAfterDays * DAY) return true;
  return false;
}

const NOISE = '1 result available.Use Up and Down to choose options, press Enter to select the currently focused option, press Escape to exit the menu, press Tab to select the option and exit the menu.';
const CAP = 'Complete the site CAPTCHA, then retry this application.';
const LOGIN_Q = 'Sign into this site in Chrome, then retry this application.';
const REAL = 'How many years of React experience do you have?';

test('the three live unactionable buckets are recognised', () => {
  assert.equal(UI_NOISE.test(NOISE), true, 'combobox screen-reader text');
  assert.equal(UI_NOISE.test('72 results available.Use Up and Down to choose options'), true, 'plural form too');
  assert.equal(CAPTCHA.test(CAP), true, 'CAPTCHA gate');
  assert.equal(LOGIN.test(LOGIN_Q), true, 'site sign-in gate');
});

test('a REAL question is never treated as unactionable', () => {
  for (const q of [REAL, 'Pronouns', 'Are you legally authorized to work in Canada?', 'Notice period?']) {
    assert.equal(UI_NOISE.test(q) || CAPTCHA.test(q) || LOGIN.test(q), false, `must stay answerable: ${q}`);
  }
});

test('ONE answerable question keeps the whole park alive', () => {
  const now = Date.now();
  assert.equal(retires([NOISE, REAL], now - 30 * DAY, now), false,
    'answering the real one unblocks the job — the park must survive');
  assert.equal(retires([CAP, REAL], now - 30 * DAY, now), false);
  assert.equal(retires([LOGIN_Q, REAL], now - 30 * DAY, now), false);
});

test('all-noise and all-CAPTCHA parks retire with no age bound', () => {
  const now = Date.now();
  assert.equal(retires([NOISE], now, now), true, 'not a question at any age');
  assert.equal(retires([CAP], now, now), true, 'policy is never to auto-solve, so it is dead on arrival');
});

test('a site sign-in gate is given a week before being retired', () => {
  const now = Date.now();
  assert.equal(retires([LOGIN_Q], now - 2 * DAY, now), false, 'Pierre could still action this');
  assert.equal(retires([LOGIN_Q], now - 8 * DAY, now), true, 'after a week the posting is stale anyway');
});

test('an empty question list is left to reclaimDeadParks, not double-handled', () => {
  assert.equal(retires([], Date.now() - 30 * DAY, Date.now()), false);
});

test('the implementation requires EVERY question to be unactionable', () => {
  const fn = db.slice(db.indexOf('function retireUnanswerableParks'), db.indexOf('// EXPIRE TASKS STUCK'));
  assert.ok(fn.length, 'retireUnanswerableParks must exist');
  assert.match(fn, /texts\.every\(/, 'must use every(), not some() — some() would discard real questions');
  assert.match(fn, /state='skipped'/, 'retire terminally');
  assert.match(fn, /loginAfterDays/, 'the sign-in bucket must be age-bounded');
});

test('it runs unattended in the pipeline watchdog', () => {
  assert.match(main, /db\.retireUnanswerableParks\(/,
    'otherwise it is another manual chore, which is the bug');
});
