// SUBMIT-REJECTION — the page telling us in words that it did NOT accept the form.
//
// Found live 2026-09-08 on an Ashby posting: the run clicked "Submit Application", the page
// answered "Your form needs corrections. Missing entry for required field…", and the task was
// filed as awaiting_review — the bucket that means "probably submitted, please confirm". Pierre
// was away for eight hours, so it sat in a review queue nobody was reading instead of retrying.
//
// The dangerous direction here is the OPPOSITE of the success evaluator's. There, a false positive
// invents a submission that never happened. Here, a false positive turns a REAL submission into a
// retry and Pierre applies to the same job twice under his own name. Most of these cases are
// therefore about what must NOT match.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(here, '..', 'extension', 'content', 'signals', 'success.js')).href);
const { submitRejectionInNewNodes } = mod;

// db.js is CommonJS and classifyQueueFailure is a PURE function over a task row, so it needs no
// open database - require it directly rather than standing up a temp DB for two assertions.
const require_ = createRequire(import.meta.url);
const classify = require_(path.join(here, '..', 'app', 'src', 'db.js')).classifyQueueFailure;

// ---- MUST DETECT ----

test('the live Ashby rejection is recognised', () => {
  // Verbatim from the transcript of task_90c386ed on 2026-09-08, as captured by reject-detail.
  const nodes = [{ text: 'Your form needs corrections Missing entry for required field', confirmation: false }];
  const hit = submitRejectionInNewNodes(nodes);
  assert.ok(hit, 'expected the complaint to be recognised');
  assert.match(hit, /needs corrections/i);
});

test('inline field validation that appears after the click counts', () => {
  assert.ok(submitRejectionInNewNodes([{ text: 'This field is required' }]));
});

test('a generic error summary counts', () => {
  assert.ok(submitRejectionInNewNodes([{ text: 'Please correct the errors below and try again.' }]));
  assert.ok(submitRejectionInNewNodes([{ text: 'There were problems with your submission.' }]));
});

test('French validation copy counts', () => {
  assert.ok(submitRejectionInNewNodes([{ text: 'Veuillez corriger les erreurs ci-dessous.' }]));
  assert.ok(submitRejectionInNewNodes([{ text: 'Ce champ est obligatoire' }]));
});

test('the rejection is found even when it is not the first new node', () => {
  const nodes = [{ text: 'Salary expectations' }, { text: 'Your form needs corrections' }];
  assert.ok(submitRejectionInNewNodes(nodes));
});

// ---- MUST NOT DETECT (a false positive here makes Pierre apply twice) ----

test('a real confirmation is never called a rejection', () => {
  assert.equal(submitRejectionInNewNodes([{ text: 'Thank you for your application!', confirmation: true }]), null);
  assert.equal(submitRejectionInNewNodes([{ text: 'Your application has been submitted.' }]), null);
});

test('a node carrying BOTH a success phrase and the word required stays ambiguous', () => {
  // Real confirmation pages often keep the form's legend visible. Ambiguity must fall back to the
  // honest maybe, never to a confident rejection.
  const nodes = [{ text: 'Thank you for your application. * Required fields were completed.' }];
  assert.equal(submitRejectionInNewNodes(nodes), null);
});

test('the bare word "required" is not a rejection', () => {
  // This is on virtually every ATS form, before any click.
  assert.equal(submitRejectionInNewNodes([{ text: '* Required' }]), null);
  assert.equal(submitRejectionInNewNodes([{ text: 'Required' }]), null);
  assert.equal(submitRejectionInNewNodes([{ text: 'Resume/CV required' }]), null);
});

test('a whole-page dump is ignored rather than scanned for a stray phrase', () => {
  const huge = 'lorem '.repeat(300) + 'this field is required';
  assert.equal(submitRejectionInNewNodes([{ text: huge }]), null);
});

test('no new nodes, empty nodes and bad input are all null, never a throw', () => {
  assert.equal(submitRejectionInNewNodes([]), null);
  assert.equal(submitRejectionInNewNodes(null), null);
  assert.equal(submitRejectionInNewNodes(undefined), null);
  assert.equal(submitRejectionInNewNodes([null, {}, { text: '' }]), null);
});

// ---- THE QUEUE MUST RETRY IT, NOT PARK IT ----

test('a rejected submit classifies as retriable, not as a question for the user', (t) => {
  if (typeof classify !== 'function') return t.skip('classifyQueueFailure is not exported');
  const r = classify({
    state: 'failed',
    lastError: 'the site rejected the submission: Your form needs corrections Missing entry for required field',
    transcript: [],
  });
  assert.equal(r.failureClass, 'submit_rejected');
  // The whole point: it re-dispatches instead of waiting on a human who is not there.
  assert.equal(r.action, 'retry');
});

test('the site wording "missing entry for required field" does not fall through to missing_info', (t) => {
  if (typeof classify !== 'function') return t.skip('classifyQueueFailure is not exported');
  // Without the ordering fix this parked the task as "needs your answer" with NO question attached
  // for anyone to answer — a row pipelineHealth already counts as a defect (invalidWaits).
  const r = classify({
    state: 'failed',
    lastError: 'the site rejected the submission: Missing entry for required field',
    transcript: [],
  });
  assert.notEqual(r.failureClass, 'missing_info');
  assert.equal(r.action, 'retry');
});

test('a genuine parked question is still missing_info', (t) => {
  if (typeof classify !== 'function') return t.skip('classifyQueueFailure is not exported');
  const r = classify({
    state: 'parked',
    pendingQuestions: [{ question: 'What are your salary expectations?' }],
    transcript: [],
  });
  assert.equal(r.failureClass, 'missing_info');
});
