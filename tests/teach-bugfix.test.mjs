// Teach & Correct v1 live-test bug fixes (B1, B2, B4) — pure, node-importable helpers.
//
//   B1 — decideConnectionState(): the popup must stay "connected" through a TRANSIENT
//        health blip when a token exists and the app was healthy recently; it only
//        re-prompts to pair on a genuine no-token state or a real 401.
//   B2 — isJobPageUrl(): Watch & Teach supervises the ACTIVE tab when it's a job /
//        application page; this predicate decides "is this tab a job page?".
//   B4 — isResumeFileInput(): broadened résumé-upload detection so it fires on Glassdoor
//        / external company sites (affordance text or document-typed accept attr).
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideConnectionState } from '../extension/lib/api.js';
import { isJobPageUrl } from '../extension/lib/jobpage.js';
import { isResumeFileInput } from '../extension/content/autofill.js';

// duck-typed file input: only getAttribute('accept') is touched by isResumeFileInput.
const fileInput = (accept = '') => ({ getAttribute: (n) => (n === 'accept' ? accept : null) });

// ---------------- B1: connection resilience ----------------
test('B1: no token → setup prompt (never paired)', () => {
  const s = decideConnectionState({ paired: false, healthOk: false, lastHealthyAt: 0 });
  assert.equal(s.connected, false);
  assert.equal(s.setupNeeded, true);
  assert.equal(s.reason, 'no-app');
});

test('B1: no token but app answering → "connect to finish" (still setup, app up)', () => {
  const s = decideConnectionState({ paired: false, healthOk: true, lastHealthyAt: 0 });
  assert.equal(s.connected, false);
  assert.equal(s.setupNeeded, true);
  assert.equal(s.reason, 'connect');
});

test('B1: paired + healthy now → connected', () => {
  const s = decideConnectionState({ paired: true, healthOk: true, lastHealthyAt: Date.now() });
  assert.equal(s.connected, true);
  assert.equal(s.setupNeeded, false);
});

test('B1: paired + health blip but healthy 5s ago → STAY connected (the bug)', () => {
  const now = 1_000_000;
  const s = decideConnectionState({ paired: true, healthOk: false, lastHealthyAt: now - 5000, now });
  assert.equal(s.connected, true, 'a 1.2s/2.5s health blip must not drop a paired popup to Connect');
  assert.equal(s.setupNeeded, false);
  assert.equal(s.reason, 'grace');
});

test('B1: paired + health silent past the grace window → app-closed (NOT a re-pair)', () => {
  const now = 1_000_000;
  const s = decideConnectionState({ paired: true, healthOk: false, lastHealthyAt: now - 5 * 60_000, now });
  assert.equal(s.connected, false);
  assert.equal(s.setupNeeded, false, 'token is still good — this is "open the app", not "re-pair"');
  assert.equal(s.appInstalledButClosed, true);
});

test('B1: a real 401 → re-pair, even if the app is up', () => {
  const s = decideConnectionState({ paired: true, healthOk: true, lastHealthyAt: Date.now(), unauthorized: true });
  assert.equal(s.connected, false);
  assert.equal(s.setupNeeded, true, 'token rejected → must re-pair');
  assert.equal(s.reason, 'unauthorized');
});

// ---------------- B2: active-tab job-page predicate ----------------
test('B2: known boards + ATS hosts are job pages', () => {
  for (const u of [
    'https://www.linkedin.com/jobs/view/123',
    'https://uk.indeed.com/viewjob?jk=abc',
    'https://www.glassdoor.com/Job/jobs.htm?sc.keyword=engineer',
    'https://acme.wd5.myworkdayjobs.com/careers',
    'https://boards.greenhouse.io/acme/jobs/42',
    'https://jobs.lever.co/acme/abc-def',
    'https://acme.ashbyhq.com/jobs',
  ]) assert.equal(isJobPageUrl(u), true, u);
});

test('B2: company-site apply/job paths qualify off the big boards', () => {
  assert.equal(isJobPageUrl('https://careers.acme.com/apply/12345'), true);
  assert.equal(isJobPageUrl('https://acme.com/careers/positions/lead-engineer'), true);
  assert.equal(isJobPageUrl('https://acme.com/job-application?gh_jid=99'), true);
});

test('B2: non-job pages are rejected', () => {
  for (const u of [
    'https://news.ycombinator.com/',
    'https://mail.google.com/mail/u/0',
    'https://www.acme.com/about',
    'chrome://extensions',
    'about:blank',
    '',
    null,
  ]) assert.equal(isJobPageUrl(u), false, String(u));
});

// ---------------- B4: résumé upload detection (Glassdoor / external sites) ----------------
test('B4: matches Glassdoor "Upload resume" affordance text even with no input label', () => {
  // Custom widget: the real input is hidden + label-less; the affordance text sits nearby.
  assert.equal(isResumeFileInput(fileInput(''), 'upload resume'), true);
  assert.equal(isResumeFileInput(fileInput(''), 'attach resume / cv'), true);
  assert.equal(isResumeFileInput(fileInput(''), 'joindre votre cv'), true);
});

test('B4: matches a document-typed accept attribute regardless of text', () => {
  assert.equal(isResumeFileInput(fileInput('.pdf,.doc,.docx'), ''), true);
  assert.equal(isResumeFileInput(fileInput('application/pdf'), ''), true);
  assert.equal(isResumeFileInput(fileInput('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), ''), true);
});

test('B4: does NOT match a photo/image upload (so a résumé never lands in an ID/photo field)', () => {
  assert.equal(isResumeFileInput(fileInput('image/*'), 'upload a profile photo'), false);
  assert.equal(isResumeFileInput(fileInput('.png,.jpg'), 'headshot'), false);
});
