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
import { createRequire } from 'node:module';
import os from 'node:os';

const require = createRequire(import.meta.url);
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

// --- the better half: RECOVER mixed parks instead of retiring them --------------------------------
// Retiring an all-junk park is right. But the live parks were MIXED: "needs 5 answer(s)" where
// memory already answered four and the fifth was scraped screen-reader text. queueRetryParked
// requires stillMissing to reach ZERO before requeueing, and junk can never be "answered", so one
// junk string pinned the task in 'parked' permanently. Those are recoverable APPLICATIONS — the fix
// is to stop junk counting as missing, not to throw the job away.
test('a junk question does not count as a missing answer', () => {
  const isMissing = (q, answeredByMemory) =>
    !!q && !UI_NOISE.test(q) && !answeredByMemory;

  assert.equal(isMissing(NOISE, false), false, 'junk is never "missing" — it is not a question');
  assert.equal(isMissing(REAL, false), true, 'a real unanswered question still blocks');
  assert.equal(isMissing(REAL, true), false, 'answered from memory → not blocking');
});

test('the live mixed park becomes retryable once junk stops blocking', () => {
  const pend = [
    { q: 'What is your notice period?', mem: true },
    { q: 'Are you authorized to work in Canada?', mem: true },
    { q: 'Years of experience with React?', mem: true },
    { q: 'Preferred location?', mem: true },
    { q: NOISE, mem: false },
  ];
  const stillMissing = pend.filter((p) => !UI_NOISE.test(p.q) && !p.mem);
  assert.equal(stillMissing.length, 0, 'nothing real is missing → the task must requeue and retry');

  // And the guard that matters: a genuinely unanswered question must still hold it parked.
  const withReal = [...pend, { q: REAL, mem: false }];
  const missing2 = withReal.filter((p) => !UI_NOISE.test(p.q) && !p.mem);
  assert.equal(missing2.length, 1, 'a real question still keeps the task parked');
});

test('queueRetryParked runs on a schedule, not only when Pierre types an answer', () => {
  // It was wired ONLY to the intake endpoint, so a park that became answerable any other way
  // (memory learned it from a different application; its only blocker was junk) stayed parked
  // forever. That also made the junk-unblocking fix above inert by itself.
  const tick = main.slice(main.indexOf('async function pipelineWatchdogTick'));
  assert.match(tick.slice(0, 3500), /db\.queueRetryParked\(\)/,
    'recovery must not depend on the user happening to submit an answer');
});

test('queueRetryParked filters junk out of stillMissing', () => {
  const fn = db.slice(db.indexOf('function queueRetryParked'), db.indexOf('function saveIntakeAnswer'));
  assert.ok(fn.length, 'queueRetryParked must exist');
  // Was pinned to `UI_NOISE_Q_RX.test(q.question)` (combobox screen-reader text only). That check
  // is now isJunkQuestionText(), a strict SUPERSET: it still runs UI_NOISE_Q_RX first and adds
  // validation words ('required', 'a required field'), button text ('Review'), dropdown
  // placeholders ('select...'), leaked CSS rules and raw field names ('question_8901966005[]') —
  // all real strings that were pinning live tasks. Either spelling satisfies the intent.
  assert.match(fn, /(?:UI_NOISE_Q_RX|isJunkQuestionText)\.?\(?\.?test\(q\.question\)|isJunkQuestionText\(q\.question\)/,
    'junk must be excluded from stillMissing or one junk string pins the task forever');
  assert.match(fn, /stillMissing\.length === 0/, 'the zero-missing requeue condition is preserved');
});

// The safety property this whole file is about — ONE answerable question keeps the park alive — is
// asserted above as /texts\.every\(/ over db.js. That regex passes whether or not the function is
// reached, and cannot see the difference between every() applied to the right list and every()
// applied to the wrong one. Getting it wrong retires parks holding real questions Pierre could have
// answered, and they are gone: 'skipped' is terminal. retireUnanswerableParks is exported.
test('BEHAVIOUR: only an ALL-unactionable park retires, and a real question saves it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-parks-'));
  const ledger = require(path.join(here, '..', 'app', 'src', 'db.js'));
  ledger.open(dir);
  try {
    const park = (n, questions) => {
      const url = `https://job-boards.greenhouse.io/co${n}/jobs/${n}`;
      const { job } = ledger.upsertJob({ title: 'Dev', company: `Co ${n}`, jobUrl: url, status: 'started', source: 'greenhouse' }, { manual: true });
      const t = ledger.queueAdd(job.id, { mode: 'auto', force: true });
      ledger.queuePatch(t.id, { state: 'parked', parkReason: 'test', pendingQuestions: questions.map((q) => ({ question: q, reason: 'test' })) });
      return t.id;
    };

    const REAL = 'How many years of professional React experience do you have?';
    const allCaptcha = park(1, ['Please complete the CAPTCHA to continue']);
    const allNoise = park(2, ['Uploading...']);
    const mixedCaptcha = park(3, ['Please complete the CAPTCHA to continue', REAL]);
    const allReal = park(4, [REAL]);
    const freshLogin = park(5, ['Sign into this site in Chrome']);

    const retired = ledger.retireUnanswerableParks({ loginAfterDays: 7 });
    const stateOf = (id) => ledger.queueList({}).find((t) => t.id === id)?.state;

    assert.equal(stateOf(allCaptcha), 'skipped', 'a CAPTCHA-only park is not auto-solvable by policy');
    assert.equal(stateOf(allNoise), 'skipped', 'combobox screen-reader text is not a question');
    assert.equal(stateOf(mixedCaptcha), 'parked',
      'THE SAFETY PROPERTY: one answerable question keeps the whole park alive — every(), never some()');
    assert.equal(stateOf(allReal), 'parked', 'a real question is exactly what needs-you is for');
    assert.equal(stateOf(freshLogin), 'parked',
      'a sign-in gate is age-bounded: it retires after a week, not immediately');
    assert.equal(retired, 2, 'exactly the two unactionable parks');
  } finally {
    try { ledger.close(); } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
});

// queueRetryParked is the other half: it RELEASES parks that are recoverable. Its assertions above
// are /stillMissing\.length === 0/ and a regex for the junk filter, both over db.js. Getting this
// wrong is quiet in both directions — releasing a park that really does need Pierre sends the agent
// back at a form it cannot finish, and failing to release one leaves a recoverable application
// sitting in the needs-you queue for ever, which is exactly what 15 tasks were doing on 2026-09-05.
test('BEHAVIOUR: a recoverable park is released, and one that truly needs Pierre is not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-retry-'));
  const ledger = require(path.join(here, '..', 'app', 'src', 'db.js'));
  const { Database } = require(path.join(here, '..', 'app', 'node_modules', 'node-sqlite3-wasm'));
  ledger.open(dir);

  // Blank a park's question list in place, reproducing the live 2026-09-05 rows whose questions
  // were lost between the executor detecting them and the park being written.
  const loseQuestions = (taskId) => {
    const h = new Database(path.join(dir, 'jat.db'));
    try { h.run("UPDATE auto_apply_tasks SET pending_questions = '[]' WHERE id = ?", [taskId]); }
    finally { h.close(); }
  };

  const setRescueCount = (taskId, n) => {
    const h = new Database(path.join(dir, 'jat.db'));
    try { h.run('UPDATE auto_apply_tasks SET rescue_count = ? WHERE id = ?', [n, taskId]); }
    finally { h.close(); }
  };

  try {
    const park = (n, { questions, reason }) => {
      const url = `https://job-boards.greenhouse.io/rt${n}/jobs/${n}`;
      const { job } = ledger.upsertJob({ title: 'Dev', company: `RT ${n}`, jobUrl: url, status: 'started', source: 'greenhouse' }, { manual: true });
      const t = ledger.queueAdd(job.id, { mode: 'auto', force: true });
      ledger.queuePatch(t.id, { state: 'parked', parkReason: reason, pendingQuestions: questions.map((q) => ({ question: q, reason: 'test' })) });
      return t.id;
    };

    // Junk only: memory can never answer screen-reader text, and requiring it to pinned these forever.
    const junkOnly = park(1, { questions: ['1 result available.Use Up and Down to choose.'], reason: 'needs 1 answer(s)' });
    // No question recorded at all, but the reason claims there were some — the 2026-09-05 case.
    // queuePatch REFUSES to write that shape (it downgrades such a park to 'failed'), so it has to
    // be reproduced the way the live ledger actually held it: parked, with the question list blank.
    const lostQuestions = park(2, { questions: ['placeholder'], reason: 'needs 2 answer(s)' });
    loseQuestions(lostQuestions);
    // Same, but it has already been rescued the maximum number of times.
    const exhausted = park(3, { questions: ['placeholder'], reason: 'needs 2 answer(s)' });
    loseQuestions(exhausted);
    setRescueCount(exhausted, 3);
    // A real, unanswered question. This is what the needs-you queue is FOR.
    const genuinelyBlocked = park(4, { questions: ['What is your expected base salary in CAD?'], reason: 'needs 1 answer(s)' });

    ledger.queueRetryParked();
    const stateOf = (id) => ledger.queueList({}).find((t) => t.id === id)?.state;

    assert.equal(stateOf(junkOnly), 'queued', 'screen-reader noise is not a question and must not pin a task');
    assert.equal(stateOf(lostQuestions), 'queued',
      'a park that records NO question cannot be answered by anybody — retry so the executor rediscovers it');
    assert.equal(stateOf(exhausted), 'parked',
      'bounded: a task that keeps losing its questions must stop being rescued, not loop');
    assert.equal(stateOf(genuinelyBlocked), 'parked',
      'THE OTHER DIRECTION: a real unanswered question must keep the task waiting for Pierre');
  } finally {
    try { ledger.close(); } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
});
