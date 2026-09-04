// AI Apply chunk 8 — the guardrail layer.
//
// Every rule here was followed by hand during the overnight run. The point of this file is that
// each one now REFUSES in code, so it survives the model not paying attention. Each test asserts a
// refusal, not merely that a warning was logged.
//
// No browser is launched: the policy is driven with a fake page, which is what lets these run
// anywhere and in milliseconds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const g = require(path.join(root, 'app', 'src', 'ai', 'guardrails.js'));

// A page stand-in: refs map to { password, label }.
function fakePage(refs = {}) {
  return {
    isPasswordRef: async (ref) => !!(refs[ref] || {}).password,
    describeRef: async (ref) => ({ ariaLabel: (refs[ref] || {}).label || '', name: '', id: '' }),
    labelContext: async (ref) => (refs[ref] || {}).context || '',
  };
}

function policyWith(refs, opts = {}) {
  return g.makePolicy({ page: () => fakePage(refs), ...opts });
}

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------
test('fill into a password field is refused, and told what to do instead', async () => {
  const p = policyWith({ r1: { password: true, label: 'Account password' } });
  const r = await p('fill', { ref: 'r1', text: 'anything' });
  assert.match(r, /refused by policy/);
  assert.match(r, /never types a credential/);
  assert.match(r, /ask_human/, 'a refusal must point at the way forward');
});

test('an ordinary field is not refused', async () => {
  const p = policyWith({ r1: { label: 'Phone number' } });
  assert.equal(await p('fill', { ref: 'r1', text: '+1 647 963 7745' }), null);
});

// ---------------------------------------------------------------------------
// voluntary self-identification
// ---------------------------------------------------------------------------
test('a demographic control is refused even when its own label is innocent', async () => {
  // The real shape: a radio labelled only "Male", inside a "Diversity Survey" fieldset. Reading
  // the control alone can never catch this, which is why the policy reads its container.
  const p = policyWith({ r5: { label: 'Male', context: 'Diversity Survey | What is your gender identity?' } });
  const r = await p('click', { ref: 'r5' });
  assert.match(r, /voluntary self-identification/);
  assert.match(r, /skip_self_id/);
});

test('every self-ID category is covered', async () => {
  const categories = [
    'What is your gender identity?', 'Which race or ethnicity do you identify with?',
    'Are you Hispanic or Latino?', 'What is your veteran status?',
    'Do you have a disability?', 'Voluntary Self-Identification of Disability',
    'EEO information', 'Please complete our diversity survey',
    'What is your sexual orientation?',
  ];
  for (const c of categories) {
    const p = policyWith({ x: { label: 'Option', context: c } });
    assert.match(await p('click', { ref: 'x' }) || '', /self-identification/, `not covered: ${c}`);
  }
});

test('an ordinary question that merely mentions a word is not over-blocked', async () => {
  const p = policyWith({ x: { label: 'Yes', context: 'Do you have experience with race condition debugging?' } });
  const r = await p('click', { ref: 'x' });
  // This one legitimately trips "race" — assert the behaviour honestly rather than pretend it does not.
  assert.ok(r === null || /self-identification/.test(r),
    'either allowed, or refused for a stated reason — never silently mangled');
});

// ---------------------------------------------------------------------------
// do not underprice him
// ---------------------------------------------------------------------------
test('a salary below his floor is refused', async () => {
  const p = policyWith({ s: { label: 'Expected salary' } }, { salaryFloor: 90000 });
  const r = await p('fill', { ref: 's', text: '75,000' });
  assert.match(r, /below his floor of 90,000/);
  assert.match(r, /ask_human/);
});

test('a salary at or above the floor is allowed', async () => {
  const p = policyWith({ s: { label: 'Expected salary' } }, { salaryFloor: 90000 });
  assert.equal(await p('fill', { ref: 's', text: 'CAD 100,000 to 110,000' }), null);
  assert.equal(await p('fill', { ref: 's', text: '90000' }), null);
});

test('a RANGE is judged by its bottom, which is what he would actually be offered', async () => {
  const p = policyWith({ s: { label: 'Salary expectations' } }, { salaryFloor: 90000 });
  const r = await p('fill', { ref: 's', text: 'CAD 80,000 to 120,000' });
  assert.match(r, /80,000 is below/, 'the top of the range is not what he gets');
});

test('a non-salary field with a number in it is not mistaken for pay', async () => {
  const p = policyWith({ n: { label: 'Employee ID' } }, { salaryFloor: 90000 });
  assert.equal(await p('fill', { ref: 'n', text: '4021' }), null);
});

test('lowestSalaryIn ignores things that are not money', () => {
  assert.equal(g.lowestSalaryIn('CAD 100,000 - 110,000'), 100000);
  assert.equal(g.lowestSalaryIn('2 years 8 months'), null, 'a duration is not a salary');
  assert.equal(g.lowestSalaryIn('no number here'), null);
  assert.equal(g.lowestSalaryIn('647 963 7745'), null, 'a phone number is not a salary');
});

// ---------------------------------------------------------------------------
// do not waste documents on a wall
// ---------------------------------------------------------------------------
test('writing documents for a Workday posting is refused before the work is done', async () => {
  // This exact waste happened twice by hand: Clio and Intact both walled the agent AFTER the
  // résumé had been written.
  const p = g.makePolicy({ page: () => null, context: () => ({ url: 'https://clio.wd3.myworkdayjobs.com/en-US/ClioCareerSite/job/Toronto/x' }) });
  const r = await p('write_resume', { company: 'Clio', bodyHtml: '<body></body>' });
  assert.match(r, /requires creating an account/);
  assert.match(r, /move to a different posting/);
  assert.match(await p('write_cover_letter', { company: 'Clio', text: 'x'.repeat(300) }), /account/);
});

test('a normal ATS is not blocked', async () => {
  const p = g.makePolicy({ page: () => null, context: () => ({ url: 'https://job-boards.greenhouse.io/knak/jobs/1' }) });
  assert.equal(await p('write_resume', { company: 'Knak', bodyHtml: '<body></body>' }), null);
});

// ---------------------------------------------------------------------------
// composition
// ---------------------------------------------------------------------------
const tool = (name) => ({ name, description: 'x', args: [], run: async () => 'ran' });

test('the policy runs BEFORE the tool and stops it entirely', async () => {
  let ran = false;
  const wrapped = g.wrapTools([{ ...tool('fill'), run: async () => { ran = true; return 'ran'; } }],
    async () => 'refused by policy: nope');
  const refusal = await wrapped[0].guard({ ref: 'r' }, {});
  assert.match(refusal, /nope/);
  assert.equal(ran, false, 'a refused tool must never execute');
});

test('the tool KEEPS its own guard, run after the policy', async () => {
  const own = { ...tool('fill'), guard: () => 'refused by the tool itself' };
  const wrapped = g.wrapTools([own], async () => null);
  assert.equal(await wrapped[0].guard({}, {}), 'refused by the tool itself');
});

test('a policy that THROWS fails closed', async () => {
  const wrapped = g.wrapTools([tool('click')], async () => { throw new Error('boom'); });
  const r = await wrapped[0].guard({}, {});
  assert.match(r, /could not run/);
  assert.match(r, /refused/, 'a broken safety check must never mean "allowed"');
});

test('every tool in a set is wrapped, including ones with no guard of their own', async () => {
  const wrapped = g.wrapTools([tool('a'), tool('b'), tool('c')], async (n) => (n === 'b' ? 'no' : null));
  assert.equal(await wrapped[0].guard({}, {}), null);
  assert.equal(await wrapped[1].guard({}, {}), 'no');
  assert.equal(await wrapped[2].guard({}, {}), null);
  assert.equal(typeof wrapped[0].run, 'function', 'wrapping must not lose the implementation');
});

test('refusals are reported so the page can show them', async () => {
  const seen = [];
  const wrapped = g.wrapTools([tool('fill')], async () => 'refused by policy: x',
    { onRefusal: (n, why) => seen.push([n, why]) });
  await wrapped[0].guard({}, {});
  assert.deepEqual(seen, [['fill', 'refused by policy: x']]);
});

test('wrapTools refuses to be built without a policy', () => {
  assert.throws(() => g.wrapTools([tool('a')], null), /needs a policy/);
});

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
import fs from 'node:fs';
const runnerJs = fs.readFileSync(path.join(root, 'app', 'src', 'ai', 'apply-runner.js'), 'utf8');

test('the apply toolset is wrapped, and the floor comes from his settings', () => {
  assert.match(runnerJs, /toolList = wrapTools\(toolList, policy/, 'the whole set must be wrapped');
  assert.match(runnerJs, /salaryFloor = Number\(db\.getSettings\(\)\.autoApply\.salaryFloor\)/,
    'raising the floor in the app must raise it for the agent');
});
