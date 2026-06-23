import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.location = { href: 'https://www.linkedin.com/jobs/view/123' };
const route = await import('../extension/content/route.js');
const { classifyInterstitial } = await import('../extension/content/lib/interstitial.js');

function el({ text = '', aria = '', href = '', target = '' } = {}) {
  const attrs = { 'aria-label': aria, href, target };
  return {
    textContent: text, value: '', href,
    getAttribute(name) { return attrs[name] || ''; },
  };
}

test('LinkedIn Easy Apply is never classified as external handoff', () => {
  const r = route.classifyApplyControl(el({ text: 'Apply', aria: 'Easy Apply to this job' }));
  assert.equal(r.state, 'linkedin_easy_apply_modal');
  assert.equal(route.applyRouteForState(r.state), 'easy-apply');
});

test('external routes require explicit off-origin or company-site evidence', () => {
  assert.equal(route.classifyApplyControl(el({ text: 'Apply' })).state, 'unknown');
  assert.equal(route.classifyApplyControl(el({ text: 'Company homepage', href: 'https://acme.com' })).state, 'unknown');
  assert.equal(route.classifyApplyControl(el({ text: 'Apply', href: 'https://jobs.acme.com/42', target: '_blank' })).state, 'external_new_tab');
  assert.equal(route.classifyApplyControl(el({ text: 'Apply on company website' })).state, 'external_same_tab');
});

test('observed transitions distinguish modal, child tab, and same-tab navigation', () => {
  assert.equal(route.observeRoute({ dialogOpen: true }).state, 'linkedin_easy_apply_modal');
  assert.equal(route.observeRoute({ childCaptured: true }).state, 'external_new_tab');
  assert.equal(route.observeRoute({ beforeUrl: 'https://linkedin.com/jobs/1', afterUrl: 'https://jobs.acme.com/apply' }).state, 'external_same_tab');
});

test('service worker owns same-tab external navigation before the source executor unloads', () => {
  const src = fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  assert.match(src, /waitForExternalTarget/);
  // The host-OR-path transfer decision now lives in the shared, node-tested externalTargetFromNav
  // helper (EXT-2) — it catches slow same-host path-only redirects the old host-only check missed.
  assert.match(src, /externalTargetFromNav\(\{ initialUrl: handoff\.initialUrl, currentUrl: source\?\.url \}\)/);
  assert.match(src, /host-OR-path change on the source tab/i);
});

test('a LinkedIn resume-choice interstitial advances (picks most-recent resume, clicks Continue)', () => {
  const d = classifyInterstitial({
    onLinkedIn: true, present: true, hasAnswerableFields: false,
    dialogText: 'Be sure to include an updated resume',
    buttons: [{ label: 'Continue', index: 0 }],
    resumeChoices: [
      { label: 'resume_2023.pdf', index: 0, recent: false },
      { label: 'resume_latest.pdf most recent', index: 1, recent: true },
    ],
  });
  assert.equal(d.isInterstitial, true);
  assert.equal(d.advanceIndex, 0);
  assert.equal(d.pickResumeIndex, 1);   // most-recent preferred
});

test('a "Continue applying" interstitial with no resume choices still advances', () => {
  const d = classifyInterstitial({
    onLinkedIn: true, present: true, hasAnswerableFields: false,
    dialogText: 'Continue applying to this job',
    buttons: [{ label: 'Continue applying', index: 2 }],
    resumeChoices: [],
  });
  assert.equal(d.isInterstitial, true);
  assert.equal(d.advanceIndex, 2);
  assert.equal(d.pickResumeIndex, null);
});

test('a field-bearing apply form is NOT treated as an interstitial', () => {
  const d = classifyInterstitial({
    onLinkedIn: true, present: true, hasAnswerableFields: true,
    dialogText: 'Phone number', buttons: [{ label: 'Next', index: 0 }],
  });
  assert.equal(d.isInterstitial, false);
});

test('the final submit is never treated as an interstitial advance', () => {
  const d = classifyInterstitial({
    onLinkedIn: true, present: true, hasAnswerableFields: false,
    dialogText: 'Review your application before you submit',
    buttons: [{ label: 'Submit application', index: 0 }],
  });
  assert.equal(d.isInterstitial, false);
});

test('an unrelated modal (cookie consent) is not advanced as an interstitial', () => {
  const d = classifyInterstitial({
    onLinkedIn: true, present: true, hasAnswerableFields: false,
    dialogText: 'We use cookies to improve your experience',
    buttons: [{ label: 'Got it', index: 0 }],
    resumeChoices: [],
  });
  assert.equal(d.isInterstitial, false);
});

test('interstitial handling is LinkedIn-scoped only', () => {
  const d = classifyInterstitial({
    onLinkedIn: false, present: true, hasAnswerableFields: false,
    dialogText: 'Continue applying', buttons: [{ label: 'Continue', index: 0 }],
  });
  assert.equal(d.isInterstitial, false);
});

test('login URLs can never count as submission confirmation', async () => {
  const success = await import('../extension/content/signals/success.js');
  assert.equal(success.urlLooksLikeSuccess('https://careers.example.com/applied?stepname=login'), false);
  assert.equal(success.urlLooksLikeSuccess('https://careers.example.com/application/thank-you'), true);
});
