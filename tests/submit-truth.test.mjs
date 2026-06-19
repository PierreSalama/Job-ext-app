// SUCCESS-TRUTH — the pure submit-evidence evaluator. These fixtures are the
// trustworthiness keystone: an auto-apply "done" must NEVER be a false positive.
// The two known false positives (Activision, Canada Job Bank) MUST be rejected.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(here, '..', 'extension', 'content', 'signals', 'success.js')).href);
const { evaluateSubmitEvidence } = mod;

// ---- MUST REJECT ----

test('Activision: static success text identical before & after, ungrounded, ~176ms → not verified', () => {
  // A public careers page with a search field, email-alert, "Apply Now" and STATIC
  // recruitment copy ("Thank you for your interest"). A generic Submit was clicked
  // and "confirmed" ~176ms later. No form was ever opened/filled.
  const staticText = 'Search jobs. Thank you for your interest in Activision. Sign up for job alerts. Apply Now.';
  const r = evaluateSubmitEvidence({
    before: { text: staticText, url: 'https://careers.activision.com/jobs', successText: true },
    after: { text: staticText, url: 'https://careers.activision.com/jobs', successText: true },
    formGrounded: false,
    msElapsed: 176,
    newNodes: [],
  });
  assert.equal(r.verified, false);
  // Grounding fails first — that alone is enough to reject.
  assert.equal(r.reason, 'no-grounded-form');
});

test('Activision variant: even if a form had been grounded, unchanged static text ~176ms → not verified', () => {
  const staticText = 'Thank you for your interest. Apply Now.';
  const r = evaluateSubmitEvidence({
    before: { text: staticText, url: 'https://careers.activision.com/jobs', successText: true },
    after: { text: staticText, url: 'https://careers.activision.com/jobs', successText: true },
    formGrounded: true,            // hypothetical — isolate the baseline-diff rule
    msElapsed: 176,
    newNodes: [],
  });
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'static-success-text-unchanged');
});

test('Canada Job Bank: generic submit, no grounded form, search/report controls → not verified', () => {
  const text = 'Job Bank. Search for jobs. Report a problem. Direct Apply. Show how to apply. Submit.';
  const r = evaluateSubmitEvidence({
    before: { text, url: 'https://jobbank.gc.ca/jobsearch', successText: false },
    after: { text, url: 'https://jobbank.gc.ca/jobsearch', successText: false },
    formGrounded: false,
    msElapsed: 900,
    newNodes: [],
  });
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'no-grounded-form');
});

test('grounded form but nothing changed at all → not verified', () => {
  const text = 'Application form. First name. Last name. Resume.';
  const r = evaluateSubmitEvidence({
    before: { text, url: 'https://co.com/apply', successText: false },
    after: { text, url: 'https://co.com/apply', successText: false },
    formGrounded: true,
    msElapsed: 1200,
    newNodes: [],
  });
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'no-post-click-change');
});

test('grounded form, NEW success text but implausibly fast with no network/new-node → not verified', () => {
  const r = evaluateSubmitEvidence({
    before: { text: 'Application form. Submit.', url: 'https://co.com/apply', successText: false },
    after: { text: 'Your application was submitted.', url: 'https://co.com/apply', successText: true },
    formGrounded: true,
    msElapsed: 120,           // faster than a real round-trip
    newNodes: [],             // no structural confirmation node
  });
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'confirmation-too-fast');
});

// ---- MUST ACCEPT ----

test('real Easy-Apply: a NEW "Application submitted" container appears post-click, grounded → verified', () => {
  const r = evaluateSubmitEvidence({
    before: { text: 'Easy Apply. Review your application. Submit.', url: 'https://linkedin.com/jobs/view/1', successText: false },
    after: { text: 'Your application was sent to Acme.', url: 'https://linkedin.com/jobs/view/1', successText: true },
    formGrounded: true,
    msElapsed: 1400,
    newNodes: [{ text: 'Application submitted. Your application was sent to Acme.', confirmation: false }],
  });
  assert.equal(r.verified, true);
  assert.equal(r.reason, 'new-confirmation-node');
});

test('text became success (not pre-existing) after a plausible delay, grounded → verified', () => {
  const r = evaluateSubmitEvidence({
    before: { text: 'Application form. Submit.', url: 'https://co.com/apply', successText: false },
    after: { text: 'Thank you for your application. We have received your application.', url: 'https://co.com/apply', successText: true },
    formGrounded: true,
    msElapsed: 1500,
    newNodes: [],
  });
  assert.equal(r.verified, true);
  assert.equal(r.reason, 'text-became-success');
});

test('URL navigates to a real confirmation page, grounded → verified', () => {
  const r = evaluateSubmitEvidence({
    before: { text: 'Application form. Submit.', url: 'https://co.com/apply', successText: false },
    after: { text: 'Loading…', url: 'https://co.com/apply/confirmation', successText: false },
    formGrounded: true,
    msElapsed: 800,
    newNodes: [],
  });
  assert.equal(r.verified, true);
  assert.equal(r.reason, 'url-confirmation');
});

test('URL change to a LOGIN page is NOT a confirmation', () => {
  const r = evaluateSubmitEvidence({
    before: { text: 'Application form. Submit.', url: 'https://co.com/apply', successText: false },
    after: { text: 'Sign in', url: 'https://co.com/login', successText: false },
    formGrounded: true,
    msElapsed: 800,
    newNodes: [],
  });
  assert.equal(r.verified, false);
});

test('correlated network POST proves the submit even without a visible banner, grounded → verified', () => {
  const r = evaluateSubmitEvidence({
    before: { text: 'Application form. Submit.', url: 'https://co.com/apply', successText: false },
    after: { text: 'Application form.', url: 'https://co.com/apply', successText: false },
    formGrounded: true,
    msElapsed: 700,
    newNodes: [],
    networkPost: true,
  });
  assert.equal(r.verified, true);
  assert.equal(r.reason, 'network-post');
});
