// A DROPDOWN PLACEHOLDER IS NOT AN ANSWER.
//
// 'Select an option' is recorded as the submitted answer on 5 live jobs — ALTEN, Aptino (×4),
// NLB (×2), BuzzClan (×2) and Astra-North. A placeholder means the dropdown was NEVER SET, so
// recording it claims an answer that was never given and makes an unset required field read
// as handled.
//
// fillCombobox already treats a react-select it cannot commit as a failure and reverts the
// field ("blank is honest"). This extends the same rule to native <select>s and to the capture
// path, and adds a server-side write boundary so no client build can persist one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
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

// Real placeholder strings seen across the ATSs in the live store.
const PLACEHOLDERS = [
  'Select an option', 'Select...', 'Select', 'Choose...', 'Choose one', 'Please select',
  'Please select an option', '--', '—', '...', 'Sélectionner', 'Veuillez choisir', 'N/A',
  'None selected', 'Start typing',
];
const REAL_OPTIONS = ['Yes', 'No', 'Bachelor\'s Degree', '5-10 years', 'Canada', 'Selected for review', 'Choose Health Plan B'];

test('placeholder-shaped option text is recognised; real option text is not', () => {
  for (const p of PLACEHOLDERS) assert.equal(autofill.isPlaceholderOptionText(p), true, `placeholder: ${p}`);
  for (const r of REAL_OPTIONS) assert.equal(autofill.isPlaceholderOptionText(r), false, `real option: ${r}`);
});

test('an option with an EMPTY value attribute is a placeholder whatever its text says', () => {
  mount('<select id="s"><option value="">Pick your country</option><option value="CA">Canada</option></select>');
  const sel = dom.window.document.getElementById('s');
  assert.equal(autofill.isPlaceholderOption(sel.options[0]), true, 'empty value = nothing chosen');
  assert.equal(autofill.isPlaceholderOption(sel.options[1]), false);
});

test('matchOption never returns the placeholder — not even for an exact text match', () => {
  mount('<select id="s"><option value="">Select an option</option><option value="y">Yes</option><option value="n">No</option></select>');
  const sel = dom.window.document.getElementById('s');
  // a poisoned learned answer of literally "Select an option" used to match the placeholder EXACTLY
  assert.equal(autofill.matchOption(sel, 'Select an option'), null);
  assert.equal(autofill.matchOption(sel, 'Yes').value, 'y');
});

test('fill() reports a placeholder commit as a FAILURE, not as filled', async () => {
  const form = mount('<label for="s">Do you have a valid work permit?</label>'
    + '<select id="s" name="s"><option value="">Select an option</option><option value="maybe">Maybe</option></select>');
  const sel = dom.window.document.getElementById('s');
  const engine = new autofill.AutofillEngine({
    getProfile: async () => ({}), lookupAnswer: async () => null, recordAnswer: async () => null,
  });
  const outcomes = [];
  const n = await engine.fill([{ input: sel, label: 'Do you have a valid work permit?', value: 'Select an option' }],
    (o) => outcomes.push(o.outcome));
  assert.equal(n, 0, 'nothing was filled');
  assert.ok(!outcomes.includes('filled'), `outcomes: ${outcomes.join(',')}`);
  assert.equal(sel.value, '', 'the select is left on its unset state');
  assert.ok(form);
});

test('captureCurrentAnswers never records an untouched dropdown', async () => {
  const form = mount('<label for="s">How did you hear about us?</label>'
    + '<select id="s" name="s"><option value="">Select an option</option><option value="li">LinkedIn</option></select>');
  const sel = dom.window.document.getElementById('s');
  const recorded = [];
  const engine = new autofill.AutofillEngine({
    getProfile: async () => ({}), lookupAnswer: async () => null,
    recordAnswer: async (item) => { recorded.push(item); return item; },
  });

  await engine.captureCurrentAnswers(form, { source: 'test' });
  assert.deepEqual(recorded, [], 'an unset dropdown is not an answer');

  // …but a real selection IS captured
  sel.value = 'li';
  await engine.captureCurrentAnswers(form, { source: 'test2' });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].answer, 'LinkedIn');
});

// ---------------------------------------------------------------------------
// server-side write boundary — no client build can persist a placeholder
// ---------------------------------------------------------------------------

test('a job\'s answers blob is scrubbed of placeholders on write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-ph-'));
  try {
    db.open(dir);
    const { job } = db.upsertJob({
      title: 'Cloud Engineer', company: 'ALTEN', source: 'linkedin',
      jobUrl: 'https://example.com/alten-1', status: 'submitted',
      answers: {
        'how did you hear about us': 'Select an option',
        'what is your notice period': '2 weeks',
        'preferred locations': ['Select an option', 'Toronto'],
        'security clearance': '--',
      },
    });
    const stored = db.getJob(job.id).answers || {};
    assert.equal(stored['how did you hear about us'], undefined, 'placeholder dropped');
    assert.equal(stored['security clearance'], undefined, '"--" dropped');
    assert.equal(stored['what is your notice period'], '2 weeks', 'real answers kept');
    assert.deepEqual(stored['preferred locations'], ['Toronto'], 'placeholder removed from a multi-select');
  } finally { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
});

test('stripPlaceholderAnswers returns null when nothing real is left', () => {
  assert.equal(db.stripPlaceholderAnswers({ a: 'Select an option', b: '--' }), null);
  assert.deepEqual(db.stripPlaceholderAnswers({ a: 'Select an option', b: 'Yes' }), { b: 'Yes' });
  assert.equal(db.stripPlaceholderAnswers(null), null);
});
