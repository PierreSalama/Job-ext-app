// IS A RESUME REQUIRED HERE? ASK THE ELEMENT, NOT THE PROSE.
//
// resumeRequiredOnPage decided this from the page's TEXT alone, through pageRequiresResume(). That
// reads whatever phrasing a site happens to use and misses the one place the answer is stated
// unambiguously: the file input's own `required` attribute.
//
// Measured on a live Ashby form on 2026-09-08 by loading it in a CDP browser and reading the DOM.
// `_systemfield_resume` is `required` in the markup, labelled simply "Resume", and styled to 1x1
// pixels. The text heuristic saw nothing, the executor logged `required=false`, treated the resume
// as optional, submitted without one, and Ashby replied "Missing entry for required field: Resume".
// The task then sat in the review queue as a maybe-submitted application. 34 rows were in that
// state when this was found, every single one on an Ashby form.
//
// These are source assertions. resumeRequiredOnPage closes over DOM helpers inside a content script
// and cannot be imported under node, so the contract is pinned on the text instead: ask the element
// first, and keep the prose fallback for sites that state it in words rather than on the control.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'extension', 'content', 'executor.js'), 'utf8');
const fn = src.slice(src.indexOf('function resumeRequiredOnPage'), src.indexOf('async function waitForResumeFileInput'));

test('the file input is asked before the page text', () => {
  assert.ok(fn.length > 0, 'resumeRequiredOnPage should still exist');
  const elementCheck = fn.indexOf('findResumeFileInputs');
  const textCheck = fn.indexOf('pageRequiresResume');
  assert.ok(elementCheck > -1, 'it must look at the actual resume file inputs');
  assert.ok(textCheck > -1, 'the prose heuristic must survive as a fallback');
  assert.ok(elementCheck < textCheck,
    'the authoritative signal comes first; the heuristic is only for sites that say it in words');
});

test('both required spellings count', () => {
  // Ashby uses the property. Plenty of ATS forms mark it with aria-required on a styled control
  // whose real input is visually hidden, which is exactly the 1x1 case that started this.
  assert.match(fn, /el\.required === true/);
  assert.match(fn, /getAttribute\('aria-required'\) === 'true'/);
});

test('it can only add true cases, never remove them', () => {
  // A form that genuinely does not require a resume has no required file input to find, so the
  // element check cannot make a previously-false answer true by accident. And the text path is
  // still reached whenever the element check finds nothing, so no site regresses.
  assert.match(fn, /if \(inputs\.some\([\s\S]{0,120}\) return true;/,
    'the element check returns true only on a positive match, then falls through');
  const afterElement = fn.slice(fn.indexOf('findResumeFileInputs'));
  assert.match(afterElement, /return pageRequiresResume\(txt\);/,
    'the prose fallback must still be the final answer');
});

test('it still cannot throw, because the caller has no fallback', () => {
  // This runs inside the apply flow on arbitrary third-party DOM. A throw here would take the whole
  // step with it, so the try/catch returning false is load-bearing.
  assert.match(fn, /try \{/);
  assert.match(fn, /catch \{ return false; \}/);
});

test('selecting a saved resume is verified, not assumed', () => {
  // The select branch used to return satisfied:true the moment it had clicked something, with
  // attached:0 and no check that a resume was now selected. On Ashby that is false: there are no
  // saved-resume cards, the "saved" elements are false positives from the LinkedIn-shaped selector,
  // the click lands on nothing, and the run submits with no resume attached.
  //
  // Live on Supabase and MaintainX, 2026-09-08:
  //   trace:resume saved=7 selected=false fileInput=true -> action=select
  //   clicking "Submit Application"
  //   "Your form needs corrections. Missing entry for required field: Resume"
  //
  // Ashby then re-renders the form EMPTY, so its error names every required field including Name
  // and Email. That is why this read for hours like a filling bug rather than a resume that was
  // never attached, and why 34 applications sat in the review queue as maybe-submitted.
  const src2 = fs.readFileSync(path.join(here, '..', 'extension', 'content', 'executor.js'), 'utf8');
  const branch = src2.slice(src2.indexOf("if (decision.action === 'select')"), src2.indexOf("if (decision.action === 'attach')"));
  assert.ok(branch.length > 0, 'the select branch should still exist');

  assert.match(branch, /const after = findSavedResumeControls\(root\);/,
    'it must re-read the page after clicking rather than trusting the click');
  assert.match(branch, /if \(after\.anySelected\) return \{ acted: true, attached: 0, satisfied: true/,
    'satisfied:true is only allowed once something is actually selected');
  assert.match(branch, /tryAttachResume\(root, resume\)/,
    'a file input plus bytes is a real second chance and must be taken');
  assert.match(branch, /return \{ acted: true, attached: 0, satisfied: false, park: null \};/,
    'nothing selected and nothing attached must report satisfied:false, not success');
});
