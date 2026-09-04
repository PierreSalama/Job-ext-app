// AI Apply chunk 7 — escalation, parking, and the autonomy toggle.
//
// The rule this file exists to pin: an unanswered question PARKS ONE APPLICATION and the agent
// moves on. It must never stall the run. And in Prepare mode `submit` must not click, ever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const db = require(path.join(root, 'app', 'src', 'db.js'));
const esc = require(path.join(root, 'app', 'src', 'ai', 'tools', 'escalate.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-escalate-'));
db.open(dir);
process.on('exit', () => {
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
});

function belt(opts = {}) {
  const raised = [];
  const b = esc.makeEscalateTools({
    onBlock: (x) => raised.push(x),
    context: () => ({ company: 'Acme', title: 'Developer', url: 'https://jobs.lever.co/acme/1' }),
    ...opts,
  });
  const byName = Object.fromEntries(b.tools.map((t) => [t.name, t]));
  const call = async (name, args = {}) => {
    const t = byName[name];
    if (t.guard) { const r = await t.guard(args, {}); if (r) return { refused: r }; }
    return { result: await t.run(args, {}) };
  };
  return { ...b, raised, call, byName };
}

// ---------------------------------------------------------------------------
// parking
// ---------------------------------------------------------------------------
test('ask_human parks the APPLICATION and tells the agent to move on', async () => {
  const t = belt();
  const r = await t.call('ask_human', {
    kind: 'needs_answer',
    question: 'How many years of Kubernetes experience do you have?',
  });
  assert.match(r.result, /^PARKED/);
  assert.match(r.result, /Move on to a different application/,
    'one unanswered question must never stall the whole run');
  assert.match(r.result, /Do NOT wait and do NOT guess/);
  assert.equal(t.raised.length, 1);
  assert.equal(t.raised[0].kind, 'needs_answer');
  assert.equal(t.raised[0].urgency, 'queue');
  assert.equal(t.raised[0].company, 'Acme', 'the block must carry what it was working on');
});

test('a CAPTCHA, an account wall and a password are ALERTS, not queue items', async () => {
  for (const kind of ['captcha', 'account', 'password']) {
    const t = belt();
    await t.call('ask_human', { kind, question: `blocked by ${kind} on this form` });
    assert.equal(t.raised[0].urgency, 'alert', `${kind} must interrupt him, not wait`);
  }
});

test('a vague escalation is refused — he needs to know what is wanted', async () => {
  const t = belt();
  assert.match((await t.call('ask_human', { question: 'help' })).refused, /specifically/);
  assert.match((await t.call('ask_human', { kind: 'nonsense', question: 'a real question here' })).refused, /kind must be one of/);
});

test('there is no tool for solving a CAPTCHA or making an account', () => {
  const names = belt().tools.map((t) => t.name);
  for (const forbidden of ['solve_captcha', 'create_account', 'type_password', 'sign_up', 'answer_self_id']) {
    assert.ok(!names.includes(forbidden), `${forbidden} must not exist at all`);
  }
});

test('self-ID is skipped and never escalated — it is voluntary', async () => {
  const t = belt();
  const r = await t.call('skip_self_id', { question: 'What is your gender identity?' });
  assert.match(r.result, /left blank/);
  assert.match(r.result, /voluntary/);
  assert.equal(t.raised.length, 0, 'this must not bother him — it is simply left blank');
});

// ---------------------------------------------------------------------------
// the autonomy toggle
// ---------------------------------------------------------------------------
test('PREPARE mode: submit does not click, it hands the form over', async () => {
  let clicked = false;
  const t = belt({
    autonomy: 'prepare',
    page: () => ({ readTree: async () => [], find: () => [{ ref: 'r1', name: 'Submit' }], click: async () => { clicked = true; } }),
  });
  const r = await t.call('submit', { company: 'Acme', title: 'Developer' });
  assert.equal(clicked, false, 'NOTHING may be clicked in Prepare mode');
  assert.match(r.result, /NOT SUBMITTED/);
  assert.equal(t.raised[0].kind, 'awaiting_submit');
  assert.match(t.raised[0].question, /Ready to submit: Acme/);
});

test('FULL AUTO: submit clicks, and demands confirmation before anything is logged', async () => {
  let clicked = null;
  const t = belt({
    autonomy: 'auto',
    page: () => ({
      readTree: async () => [],
      find: (q) => (/submit/i.test(q) ? [{ ref: 'r9', name: 'Submit Application' }] : []),
      click: async (ref) => { clicked = ref; },
    }),
  });
  const r = await t.call('submit', { company: 'Acme' });
  assert.equal(clicked, 'r9');
  assert.match(r.result, /CONFIRM it actually submitted/, 'a click is not proof of submission');
  assert.equal(t.raised.length, 0);
});

test('full auto with no submit button fails loudly instead of clicking something else', async () => {
  const t = belt({ autonomy: 'auto', page: () => ({ readTree: async () => [], find: () => [], click: async () => {} }) });
  await assert.rejects(() => t.byName.submit.run({ company: 'Acme' }, {}), /no submit button found/);
});

test('submit without a browser attached refuses rather than pretending', async () => {
  const t = belt({ autonomy: 'auto', page: () => null });
  await assert.rejects(() => t.byName.submit.run({ company: 'Acme' }, {}), /no browser page/);
});

// ---------------------------------------------------------------------------
// resolving
// ---------------------------------------------------------------------------
test('answering a screening question TEACHES it, so the next run does not ask again', async () => {
  const t = belt();
  await t.call('ask_human', { kind: 'needs_answer', question: 'Do you have experience with Kubernetes?' });
  const id = t.raised[0].id;

  const resolved = db.aiBlockResolve(id, 'No, my deployment stack is Docker and GitHub Actions.');
  assert.equal(resolved.status, 'resolved');
  assert.ok(resolved.resolved_at);

  const recall = db.qaLookup(db.ensureDefaultProfileId(), 'Do you have experience with Kubernetes?');
  assert.ok(recall, 'the answer must land in the bank');
  assert.match(recall.answer, /Docker and GitHub Actions/);
});

test('his own answer is never replaced by another question\'s answer', async () => {
  // Live repro: he answered "How many years of experience do you have with Kubernetes?" with
  // "None. My deploy stack is Docker and GitHub Actions". The shape gate wants a number for a
  // "how many years" question, dropped his words, and served "2" from an unrelated row instead.
  const pid = db.ensureDefaultProfileId();
  db.qaRecord({ profileId: pid, question: 'How many years of experience do you have with React?', answer: '2', lineageSource: 'user' });

  const q = 'How many years of experience do you have with Terraform?';
  db.qaRecord({ profileId: pid, question: q, answer: 'None at all, I have never used it.', lineageSource: 'user' });

  const hit = db.qaLookup(pid, q);
  if (hit) {
    assert.match(hit.answer, /None at all/, 'if anything comes back it must be HIS answer to THIS question');
  } else {
    assert.equal(hit, null, 'otherwise the honest result is "unknown", so the agent asks');
  }
  assert.notEqual(hit && hit.answer, '2', 'another question\'s answer must never be substituted');
});

test('a CAPTCHA answer is NOT learned — it would pollute the bank', async () => {
  const t = belt();
  await t.call('ask_human', { kind: 'captcha', question: 'Human check on the Hamilton ETFs form' });
  const before = db.qaList(db.ensureDefaultProfileId(), 500).length;
  db.aiBlockResolve(t.raised[0].id, 'done');
  assert.equal(db.qaList(db.ensureDefaultProfileId(), 500).length, before, 'nothing reusable was learned');
});

test('resolving needs an actual answer', async () => {
  const t = belt();
  await t.call('ask_human', { kind: 'needs_answer', question: 'What is your notice period?' });
  assert.throws(() => db.aiBlockResolve(t.raised[0].id, '   '), /answer is required/);
  assert.equal(db.aiBlockGet(t.raised[0].id).status, 'open', 'it stays open');
});

test('open blocks are listed alerts-first, and counted', async () => {
  const pid = db.ensureDefaultProfileId();
  const before = db.aiBlockCounts(pid).open;
  const t = belt();
  await t.call('ask_human', { kind: 'needs_answer', question: 'A queued question for the list test' });
  await t.call('ask_human', { kind: 'captcha', question: 'An urgent human check for the list test' });

  const counts = db.aiBlockCounts(pid);
  assert.equal(counts.open, before + 2);
  assert.ok(counts.alert >= 1);

  const list = db.aiBlockList({ profileId: pid, status: 'open' });
  assert.equal(list[0].urgency, 'alert', 'the thing that stops a run comes first');
});

test('dismissing closes a block without teaching anything', async () => {
  const t = belt();
  await t.call('ask_human', { kind: 'needs_answer', question: 'A question to be skipped entirely' });
  const d = db.aiBlockDismiss(t.raised[0].id);
  assert.equal(d.status, 'dismissed');
  assert.equal(db.aiBlockList({ status: 'open' }).some((b) => b.id === d.id), false);
});

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
const serverJs = fs.readFileSync(path.join(root, 'app', 'src', 'server.js'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'extension', 'app', 'app.js'), 'utf8');
const appCss = fs.readFileSync(path.join(root, 'extension', 'app', 'app.css'), 'utf8');
const runnerJs = fs.readFileSync(path.join(root, 'app', 'src', 'ai', 'apply-runner.js'), 'utf8');

test('the run passes ITS OWN autonomy to the submit tool', () => {
  assert.match(runnerJs, /autonomy: autonomy === 'auto' \? 'auto' : 'prepare'/,
    'a run must never inherit a different mode than the one that was chosen for it');
});

test('the block id is resolved lazily, not captured before the run exists', () => {
  assert.match(runnerJs, /getRunId: \(\) =>/, 'otherwise every block attaches to a null run');
});

test('the endpoints and the page exist', () => {
  for (const ep of ["'/ai-apply/blocks'", 'blocks\\/([^/]+)\\/answer', 'blocks\\/([^/]+)\\/dismiss']) {
    assert.ok(new RegExp(ep.replace(/'/g, "'")).test(serverJs) || serverJs.includes(ep.replace(/'/g, "'")), `server missing ${ep}`);
  }
  for (const hook of ['data-blockresolve', 'data-blockdismiss', 'data-blockanswer', 'aiBlockCard']) {
    assert.ok(appJs.includes(hook), `page missing ${hook}`);
  }
  assert.match(appJs, /'ai-apply\.block'/, 'the page must listen for new blocks');
});

test('urgency, not kind, drives the styling', () => {
  for (const u of ['alert', 'queue']) {
    assert.ok(appCss.includes(`.ai-block[data-urgency="${u}"]`), `no style for ${u}`);
  }
  const block = appCss.slice(appCss.indexOf('/* ---------- AI Apply: escalation'));
  assert.deepEqual(block.match(/#[0-9a-f]{3,8}\b/gi) || [], [], 'must theme cleanly');
});

test('the dashboard copies are byte-identical', () => {
  for (const f of ['app.js', 'app.css', 'app.html']) {
    const a = fs.readFileSync(path.join(root, 'extension', 'app', f));
    const b = fs.readFileSync(path.join(root, 'app', 'src', 'app', f));
    assert.ok(a.equals(b), `${f} drifted — run \`npm run mirror\``);
  }
});

// ---------------------------------------------------------------------------
// submit refuses to park a half-filled application
//
// Found on a real end-to-end run: the agent filled name, email and phone, left the salary box and
// the "why do you want to work here" box untouched, and called submit. Prepare mode parked it and
// what Pierre would have opened was a half-completed form with his name on it.
// ---------------------------------------------------------------------------
const pageWithEmpty = (fields) => ({ evaluate: async () => fields, readTree: async () => {}, find: () => [], click: async () => {} });

test('submit will not park a form that still has empty fields', async () => {
  const b = belt({ page: () => pageWithEmpty(['Salary expectations', 'Why do you want to work here?']) });
  const r = await b.call('submit', { company: 'Acme', title: 'Developer' });
  assert.match(r.result, /NOT SUBMITTED/);
  assert.match(r.result, /Salary expectations/);
  assert.match(r.result, /Why do you want to work here\?/);
  // It is an observation, not a refusal: the agent is expected to act and call submit again.
  assert.equal(r.refused, undefined);
  assert.equal(b.raised.length, 0, 'nothing may be handed to the human yet');
});

test('an empty voluntary self-ID field does NOT block submit', async () => {
  // Leaving these blank is the correct behaviour. Nagging the agent about them would push it into
  // answering one, which is the single thing it must never do.
  const b = belt({ page: () => pageWithEmpty([]) });
  const r = await b.call('submit', { company: 'Acme', title: 'Developer' });
  assert.match(r.result, /Prepare mode/);
  assert.equal(b.raised.length, 1);
});

test('the probe itself skips self-ID and hidden fields', () => {
  // The filter lives in page script, so assert on the source rather than a fake return value.
  const src = fs.readFileSync(path.join(root, 'app/src/ai/tools/escalate.js'), 'utf8');
  const probe = src.slice(src.indexOf('EMPTY_PROBE'), src.indexOf('async function stillEmpty'));
  for (const word of ['gender', 'race', 'veteran', 'disabilit']) assert.match(probe, new RegExp(word));
  assert.match(probe, /type=hidden/, 'hidden inputs are not the agent\'s problem');
  assert.match(probe, /el\.disabled/, 'disabled fields cannot be filled');
  assert.match(probe, /password/, 'a password field must never be counted as work to do');
});

test('a broken probe fails OPEN, so a page quirk cannot block every application', async () => {
  const b = belt({ page: () => ({ evaluate: async () => { throw new Error('detached frame'); } }) });
  const r = await b.call('submit', { company: 'Acme', title: 'Developer' });
  assert.match(r.result, /Prepare mode/);
});

test('a documents folder slug is refused as a company name', async () => {
  // It read "northbeam-robotics" off a folder and put it in front of Pierre as the employer.
  const b = belt({ page: () => pageWithEmpty([]) });
  const bad = await b.call('submit', { company: 'northbeam-robotics', title: 'Software Engineer' });
  assert.match(bad.refused, /folder slug/);
  const good = await b.call('submit', { company: 'Northbeam Robotics', title: 'Software Engineer' });
  assert.equal(good.refused, undefined);
});

// ---------------------------------------------------------------------------
// The company and the title on a block have to be real
//
// Real run: the posting said "Northbeam Robotics — Software Developer, Platform" and the agent
// handed Pierre a block for "Robotics Engineer". A block naming a role that does not exist is worse
// than no block at all.
// ---------------------------------------------------------------------------
const POSTING = 'Northbeam Robotics\nSoftware Developer, Platform\nToronto, hybrid. We build control software.';
const pageSaying = (body, empty = []) => ({ text: async () => body, evaluate: async () => empty });

test('an invented job title is not handed to the human', async () => {
  const b = belt({ page: () => pageSaying(POSTING) });
  const r = await b.call('submit', { company: 'Northbeam Robotics', title: 'Robotics Engineer' });
  assert.match(r.result, /NOT SUBMITTED/);
  assert.match(r.result, /Robotics Engineer/);
  assert.equal(b.raised.length, 0);
});

test('a title shortened from the posting is accepted', async () => {
  // Postings get reworded constantly. The check must catch invention, not paraphrase.
  const b = belt({ page: () => pageSaying(POSTING) });
  const r = await b.call('submit', { company: 'Northbeam Robotics', title: 'Software Developer' });
  assert.match(r.result, /Prepare mode/);
  assert.equal(b.raised.length, 1);
});

test('a company that appears nowhere on the page is caught', async () => {
  const b = belt({ page: () => pageSaying(POSTING) });
  const r = await b.call('submit', { company: 'Acme Widgets', title: 'Software Developer' });
  assert.match(r.result, /company "Acme Widgets"/);
});

test('punctuation and case never decide it', async () => {
  const b = belt({ page: () => pageSaying(POSTING) });
  const r = await b.call('submit', { company: 'northbeam  ROBOTICS', title: 'Software Developer, Platform' });
  assert.match(r.result, /Prepare mode/);
});

test('a page that cannot be read does not block the application', async () => {
  const b = belt({ page: () => ({ text: async () => { throw new Error('detached'); }, evaluate: async () => [] }) });
  const r = await b.call('submit', { company: 'Northbeam Robotics', title: 'Anything At All' });
  assert.match(r.result, /Prepare mode/);
});
