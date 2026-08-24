// JUNK SCRAPED AS QUESTIONS.
//
// ~30 rows in the live needs-you queue are not questions. Each one parks a task and asks
// Pierre something meaningless, and because a non-question can never be answered, the
// application is stranded permanently. The exact live strings:
//
//   'required'                                  ×9   a validation word
//   'a required field'                          ×9   nativeValidationBlockers' literal fallback
//   'select...'                                      a dropdown placeholder used as a label
//   'Review'                                         a button
//   '.remix-css-1a0ro4n-requiredinput{opacity:0;…}'  a raw CSS rule out of a <style>
//   '5 results available. Use Up and Down to choose options…'   a screen-reader announcement
//   '0-4 / 5-10 / 10+ question_8901966005[]'          a checkbox group's OPTIONS + field name
//   'terraform / pulumi / cloudformation / none / aws question_31344737003[]'
//
// Filtered in BOTH places on purpose: in the extension at the point of scraping, and again on
// the server. The applier laptop runs whatever extension build is deployed there (it was three
// versions behind when this was written), so a client-only fix would not reach the live queue —
// and the server filter also releases junk ALREADY parked in the store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));

let autofill, dom;
test.before(async () => {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.com/' });
  dom.window.Element.prototype.getBoundingClientRect = function () {
    return { width: 120, height: 24, top: 0, left: 0, right: 120, bottom: 24, x: 0, y: 0 };
  };
  for (const k of ['window', 'document', 'Element', 'Node', 'HTMLElement', 'NodeFilter', 'getComputedStyle']) globalThis[k] = dom.window[k];
  globalThis.CSS = dom.window.CSS || { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') };
  autofill = await import(pathToFileURL(path.join(here, '..', 'extension', 'content', 'autofill.js')).href);
});
function mount(html) {
  dom.window.document.body.innerHTML = `<form>${html}</form>`;
  return dom.window.document.querySelector('form');
}

// The REAL junk, verbatim from the live queue.
const JUNK = [
  'required',
  'a required field',
  'required field',
  'This field is required',
  'select...',
  'Select an option',
  'Review',
  'Submit application',
  '.remix-css-1a0ro4n-requiredinput{opacity:0;position:absolute;width:1px;height:1px}',
  '5 results available. Use Up and Down to choose options, press Enter to select the currently focused option, press Escape to exit the menu.',
  '1 result available.Use Up and Down to choose options, press Enter to select.',
  '0-4 / 5-10 / 10+ question_8901966005[]',
  'terraform / pulumi / cloudformation / none / aws question_31344737003[]',
  'question_8901966005[]',
  'champ obligatoire',
  '--',
];

// REAL questions from the same live store that must keep being asked.
const REAL = [
  'Are you legally authorized to work in the region where this role is located?',
  'How many years of experience do you have with Terraform?',
  'What date would you be available to onboard?',
  'Please upload your portfolio',
  'Do you require sponsorship now or in the future?',
  'Describe a time you led an incident response.',
  'What are your salary expectations?',
  'Quel est votre niveau en Français?',
  'a required field on this form could not be identified',   // the honest last-resort park row
];

test('the extension rejects every junk string and keeps every real question', () => {
  for (const j of JUNK) assert.equal(autofill.isJunkQuestionText(j), true, `must reject: ${j.slice(0, 60)}`);
  for (const r of REAL) assert.equal(autofill.isJunkQuestionText(r), false, `must keep: ${r.slice(0, 60)}`);
});

test('the server rejects the same junk (covers older deployed extension builds)', () => {
  for (const j of JUNK) assert.equal(db.isJunkQuestionText(j), true, `server must reject: ${j.slice(0, 60)}`);
  for (const r of REAL) assert.equal(db.isJunkQuestionText(r), false, `server must keep: ${r.slice(0, 60)}`);
});

test('scanUnknown never surfaces a junk label as a question', async () => {
  // aria-label only: fieldLabel() JOINS every label source it finds (including input.name), so a
  // fixture with both a <label for> and a name would produce "required required a" rather than
  // the clean live string. fieldLabel also lowercases, hence the expectation below.
  const form = mount([
    'required',
    'Review',
    'select...',
    '5 results available. Use Up and Down to choose options, press Enter to select.',
    '.remix-css-1a0ro4n-requiredinput{opacity:0;position:absolute}',
    'How many years of experience do you have with Terraform?',
  ].map((q, i) => `<input id="i${i}" type="text" required aria-label="${q.replace(/"/g, '&quot;')}">`).join(''));
  const engine = new autofill.AutofillEngine({
    getProfile: async () => ({}), lookupAnswer: async () => null, recordAnswer: async () => null,
  });
  const unknown = await engine.scanUnknown(form);
  const labels = unknown.map((u) => u.label);
  assert.deepEqual(labels, ['how many years of experience do you have with terraform?'],
    `only the real question may be asked — got ${JSON.stringify(labels)}`);
});

// ---------------------------------------------------------------------------
// checkbox groups: ONE question with options, not the options glued into the label
// ---------------------------------------------------------------------------

test('a checkbox group resolves to ONE question carrying its options', () => {
  const form = mount(`<fieldset>
      <legend>Which infrastructure-as-code tools have you used?</legend>
      <label><input type="checkbox" name="question_31344737003[]" value="tf"> terraform</label>
      <label><input type="checkbox" name="question_31344737003[]" value="pu"> pulumi</label>
      <label><input type="checkbox" name="question_31344737003[]" value="cf"> cloudformation</label>
      <label><input type="checkbox" name="question_31344737003[]" value="no"> none</label>
      <label><input type="checkbox" name="question_31344737003[]" value="aws"> aws</label>
    </fieldset>`);
  const first = form.querySelector('input[type="checkbox"]');
  const grp = autofill.checkboxGroupLabel(first, form);
  assert.ok(grp, 'the group must resolve');
  assert.equal(grp.label, 'Which infrastructure-as-code tools have you used?');
  assert.deepEqual(grp.options, ['terraform', 'pulumi', 'cloudformation', 'none', 'aws']);
  // the failure being fixed: the options must NOT be concatenated into the label
  assert.equal(/terraform\s*\/\s*pulumi/.test(grp.label), false);
  assert.equal(/question_31344737003/.test(grp.label), false);
});

test('a checkbox group with no recoverable prompt yields NOTHING rather than junk', () => {
  const form = mount(
    '<div><label><input type="checkbox" name="question_8901966005[]" value="a"> 0-4</label>'
    + '<label><input type="checkbox" name="question_8901966005[]" value="b"> 5-10</label>'
    + '<label><input type="checkbox" name="question_8901966005[]" value="c"> 10+</label></div>');
  const first = form.querySelector('input[type="checkbox"]');
  const grp = autofill.checkboxGroupLabel(first, form);
  assert.ok(grp === null || !/question_8901966005/.test(grp.label),
    `must not fall back to the field name — got ${grp && grp.label}`);
});

// ---------------------------------------------------------------------------
// the server release path: junk must not pin a task in 'parked' forever
// ---------------------------------------------------------------------------

test('junk questions no longer keep a task from being retried', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-junkq-'));
  try {
    db.open(dir);
    const { job } = db.upsertJob({ title: 'SRE', company: 'ALTEN', source: 'linkedin', jobUrl: 'https://example.com/j1' });
    const task = db.queueAdd(job.id, 'auto');
    assert.ok(task, 'task queued');
    db.queuePatch(task.id, {
      state: 'parked',
      pendingQuestions: [
        { question: 'required', fieldType: 'text' },
        { question: 'a required field', fieldType: 'text' },
        { question: '0-4 / 5-10 / 10+ question_8901966005[]', fieldType: 'checkbox' },
      ],
    });
    const outstanding = db.queueParkedQuestions().filter((q) => q.jobId === job.id);
    assert.deepEqual(outstanding, [], `junk must not be surfaced as outstanding questions: ${JSON.stringify(outstanding.map((o) => o.question))}`);
    const requeued = db.queueRetryParked();   // returns a COUNT
    assert.ok(Number(requeued) >= 1, `a task blocked only by junk must be requeued (got ${JSON.stringify(requeued)})`);
    assert.equal(db.queueGet(task.id).state, 'queued', 'the task is released back to the queue');
  } finally { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});
