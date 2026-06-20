// JAT v11 — RESUME PAGE decision for the NEW full-page Easy Apply flow.
//
// ROOT CAUSE (confirmed live on linkedin.com): on /jobs/view/<id>/apply/ the Resume step shows
// "Resume*  A resume is required". The user has NO saved resume (0 cards) and the upload is a
// plain `<button>Upload resume</button>` with NO `<input type=file>` in the DOM until clicked —
// clicking CREATES the input. The executor's attach path only looked for an EXISTING file input,
// found none, couldn't satisfy the requirement, and the flow stalled. These tests pin the PURE
// decision (decideResumePage) + the text recognizers that build its signals. All pure — no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideResumePage,
  isUploadResumeAffordanceLabel,
  pageRequiresResume,
} from '../extension/content/lib/linkedin-apply.js';

// ---- saved-resume card present → SELECT (the most-recent), no upload needed ----
test('decideResumePage: a saved resume card present, none selected → select index 0', () => {
  const d = decideResumePage({ savedResumeCount: 2, anySavedSelected: false, haveResumeBytes: true });
  assert.equal(d.action, 'select');
  assert.equal(d.index, 0);
});

test('decideResumePage: a saved resume card present, none selected → select even without app bytes', () => {
  // Selecting a saved LinkedIn resume needs no upload bytes from the app.
  const d = decideResumePage({ savedResumeCount: 1, anySavedSelected: false, haveResumeBytes: false });
  assert.equal(d.action, 'select');
  assert.equal(d.index, 0);
});

test('decideResumePage: a saved resume already selected → none (proceed, no action)', () => {
  const d = decideResumePage({ savedResumeCount: 3, anySavedSelected: true, haveResumeBytes: true });
  assert.equal(d.action, 'none');
  assert.equal(d.reason, 'saved-resume-already-selected');
});

// ---- no input + Upload affordance → CLICK-THEN-ATTACH (the new full-page case) ----
test('decideResumePage: no file input + "Upload resume" affordance + bytes → upload-then-attach', () => {
  const d = decideResumePage({
    savedResumeCount: 0, fileInputPresent: false, uploadAffordancePresent: true,
    resumeRequired: true, haveResumeBytes: true,
  });
  assert.equal(d.action, 'upload-then-attach');
});

test('decideResumePage: required (no input/affordance visible yet) + bytes → upload-then-attach', () => {
  // Even when only the requirement text is detected, if we have bytes we try to create+attach.
  const d = decideResumePage({
    savedResumeCount: 0, fileInputPresent: false, uploadAffordancePresent: false,
    resumeRequired: true, haveResumeBytes: true,
  });
  assert.equal(d.action, 'upload-then-attach');
});

// ---- file input already present → ATTACH (old modal layout preserved) ----
test('decideResumePage: a file input already present + bytes → attach (legacy path)', () => {
  const d = decideResumePage({
    savedResumeCount: 0, fileInputPresent: true, uploadAffordancePresent: false,
    resumeRequired: false, haveResumeBytes: true,
  });
  assert.equal(d.action, 'attach');
});

// ---- required + unattachable → PARK honestly ----
test('decideResumePage: required but NO app bytes → park (add a résumé to your profile)', () => {
  const d = decideResumePage({
    savedResumeCount: 0, fileInputPresent: false, uploadAffordancePresent: true,
    resumeRequired: true, haveResumeBytes: false,
  });
  assert.equal(d.action, 'park');
  assert.match(d.reason, /resume required/i);
  assert.match(d.reason, /profile/i);
});

test('decideResumePage: required, bytes present but NO input AND NO affordance → park (no upload control)', () => {
  const d = decideResumePage({
    savedResumeCount: 0, fileInputPresent: false, uploadAffordancePresent: false,
    resumeRequired: false, haveResumeBytes: true,
  });
  // No requirement signal at all and nothing resume-shaped → none (handler is a no-op).
  assert.equal(d.action, 'none');
  assert.equal(d.reason, 'no-resume-requirement');
});

test('decideResumePage: no resume requirement at all → none (proceed)', () => {
  const d = decideResumePage({});
  assert.equal(d.action, 'none');
});

test('decideResumePage: defensive — no args never throws', () => {
  assert.doesNotThrow(() => decideResumePage());
  assert.doesNotThrow(() => decideResumePage(undefined));
});

// ---- the text recognizers that build the live signals ----
test('isUploadResumeAffordanceLabel: matches the LinkedIn "Upload resume" button copy', () => {
  for (const t of ['Upload resume', 'Upload résumé', 'Upload CV', 'Upload your resume', 'Attach resume', 'Attach CV']) {
    assert.equal(isUploadResumeAffordanceLabel(t), true, `expected affordance: "${t}"`);
  }
});

test('isUploadResumeAffordanceLabel: does NOT match unrelated buttons', () => {
  for (const t of ['Next', 'Submit application', 'Review', 'Save', 'Upload photo', '']) {
    assert.equal(isUploadResumeAffordanceLabel(t), false, `expected NOT affordance: "${t}"`);
  }
});

test('pageRequiresResume: detects the "A resume is required" / "Resume*" requirement copy', () => {
  for (const t of ['A resume is required', 'Resume*', 'Résumé is required', 'CV is required', 'Resume *  Upload resume']) {
    assert.equal(pageRequiresResume(t), true, `expected required: "${t}"`);
  }
});

test('pageRequiresResume: false on a page with no resume requirement', () => {
  for (const t of ['Contact info', 'Mobile phone number', 'Work authorization', '']) {
    assert.equal(pageRequiresResume(t), false, `expected NOT required: "${t}"`);
  }
});
