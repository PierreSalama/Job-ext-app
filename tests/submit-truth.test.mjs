// SUCCESS-TRUTH — the pure submit-evidence evaluator. These fixtures are the
// trustworthiness keystone: an auto-apply "done" must NEVER be a false positive.
// The two known false positives (Activision, Canada Job Bank) MUST be rejected.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(here, '..', 'extension', 'content', 'signals', 'success.js')).href);
const { evaluateSubmitEvidence, SUCCESS_TEXT_RX } = mod;

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

// ---- FIX 2: the NEW full-page Easy Apply post-submit confirmation must verify ----
// The new layout (/jobs/view/<id>/apply/) shows a full-page/section confirmation AFTER the
// Submit click: "Your application was sent" / "Application sent" / "Your application was
// submitted" (EN) or "Votre candidature a bien été envoyée" / "Candidature envoyée" (FR).
// These must (a) be recognised by SUCCESS_TEXT_RX, and (b) verify as a NEW-after-submit
// change — while pre-existing static copy of the SAME text is still rejected (R1 not weakened).

test('FIX 2: the new full-page confirmation phrases are recognised by SUCCESS_TEXT_RX (EN + FR)', () => {
  for (const p of [
    'Your application was sent',
    'Application sent',
    'Your application was sent to Acme Corp',
    'Your application was submitted',
    'Votre candidature a bien été envoyée',
    'Candidature envoyée',
  ]) {
    assert.equal(SUCCESS_TEXT_RX.test(p), true, `expected success phrase: "${p}"`);
  }
  // A bare apply CTA / advance label must NOT look like success.
  for (const p of ['Easy Apply', 'Apply now', 'Next', 'Review your application', 'Submit application']) {
    assert.equal(SUCCESS_TEXT_RX.test(p), false, `must NOT be success: "${p}"`);
  }
});

test('FIX 2: new full-page submit — /apply/ form closes to "Application sent" (text became success) → verified', () => {
  // Before: on the /apply/ form (no success text). After: the form closed and the page now
  // shows the confirmation (success text appeared AFTER the click, after a plausible delay).
  const r = evaluateSubmitEvidence({
    before: { text: 'Review your application. Submit application.', url: 'https://www.linkedin.com/jobs/view/42/apply/', successText: false },
    after: { text: 'Application sent. Your application was sent to Acme Corp.', url: 'https://www.linkedin.com/jobs/view/42', successText: true },
    formGrounded: true,
    msElapsed: 1300,
    urlBefore: 'https://www.linkedin.com/jobs/view/42/apply/',
    urlAfter: 'https://www.linkedin.com/jobs/view/42',
    newNodes: [],
  });
  assert.equal(r.verified, true);
  // The /apply/ → job-view URL change isn't a SUCCESS_URL, so this verifies via text-became-success.
  assert.equal(r.reason, 'text-became-success');
});

test('FIX 2: new full-page submit — a NEW "Your application was submitted" confirmation node → verified', () => {
  const r = evaluateSubmitEvidence({
    before: { text: 'Review your application. Submit application.', url: 'https://www.linkedin.com/jobs/view/42/apply/', successText: false },
    after: { text: 'Your application was submitted.', url: 'https://www.linkedin.com/jobs/view/42/apply/', successText: true },
    formGrounded: true,
    msElapsed: 1500,
    newNodes: [{ text: 'Your application was submitted.', confirmation: false }],
  });
  assert.equal(r.verified, true);
  assert.equal(r.reason, 'new-confirmation-node');
});

test('FIX 2: R1 NOT weakened — pre-existing static "Application sent" copy (unchanged) → still rejected', () => {
  // The exact new-layout phrase, but it was ALREADY on the page before the click and nothing
  // changed. This is the false-positive guard: static success text must never mint a done.
  const staticText = 'Application sent. Your application was sent. Browse more jobs.';
  const r = evaluateSubmitEvidence({
    before: { text: staticText, url: 'https://www.linkedin.com/jobs/view/42', successText: true },
    after: { text: staticText, url: 'https://www.linkedin.com/jobs/view/42', successText: true },
    formGrounded: true,
    msElapsed: 1500,
    newNodes: [],
  });
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'static-success-text-unchanged');
});

test('FIX 2: R1 NOT weakened — new-layout phrase but ungrounded form → still rejected', () => {
  const r = evaluateSubmitEvidence({
    before: { text: 'Apply on company website.', url: 'https://www.linkedin.com/jobs/view/42', successText: false },
    after: { text: 'Your application was sent.', url: 'https://www.linkedin.com/jobs/view/42', successText: true },
    formGrounded: false,            // never opened/filled a real apply form
    msElapsed: 1500,
    newNodes: [{ text: 'Your application was sent.', confirmation: false }],
  });
  assert.equal(r.verified, false);
  assert.equal(r.reason, 'no-grounded-form');
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
