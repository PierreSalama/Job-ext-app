// WHOSE JOB IS THIS PAGE ABOUT? — the client half of the cross-contamination fix.
//
// Two rules, both broken live on 2026-08-24:
//
//  A. A POST-SUBMIT CONFIRMATION IS NOT A JOB POSTING. Greenhouse renders "Thank you for applying"
//     at the same URL the posting was served from, so the passive capture that fires there took the
//     confirmation heading as the job title and the first hostname label of
//     "job-boards.greenhouse.io" as the employer. Six of the seven jobs the ATS lane genuinely
//     submitted ended up TITLED "Thank you for applying", at company "job-boards".
//
//  B. loadHandoff() NEVER CONSULTED handoffKey(). storeHandoff computes a per-job key and writes
//     under it; loadHandoff read `Object.values(...)`, sorted by recency, and returned the newest
//     entry from ANY tab in the profile. chrome.storage.local is profile-wide, the serial pump
//     keeps ONE warm apply tab and navigates it from job to job, and the parallel pool runs several
//     at once — so any page whose own identity looked weak adopted whichever job was seen last
//     ANYWHERE. GitLab 8682707002 and Dialpad 8661336002 finished six seconds apart, and GitLab's
//     row ended up titled "Sr. Software Engineer (Hardware)".
//
//     The replacement rule: a handoff may only be adopted when this document can be shown to
//     descend from it — same posting id in our URL, same host+path, or our referrer is the host it
//     was stored on (the genuine board → ATS handoff this mechanism exists for).
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const detectorUrl = pathToFileURL(path.join(here, '..', 'extension', 'content', 'detector.js')).href;

const GLOBALS = ['window', 'document', 'location', 'Element', 'Node', 'HTMLElement',
  'NodeFilter', 'getComputedStyle', 'MutationObserver', 'Event', 'MouseEvent', 'KeyboardEvent'];

let ctxFromMeta, handoffIsRelevant, isPlatformLabel;

// Swap the ambient document/location the detector's helpers read.
function mount({ url, referrer = '', head = '', body = '' }) {
  const opts = referrer ? { url, referrer } : { url };   // jsdom rejects an empty-string referrer
  const dom = new JSDOM(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`, opts);
  for (const k of GLOBALS) globalThis[k] = dom.window[k];
  globalThis.CSS = dom.window.CSS || { escape: (s) => String(s).replace(/[^\w-]/g, '\\$&') };
  return dom;
}

test.before(async () => {
  mount({ url: 'https://job-boards.greenhouse.io/gitlab/jobs/8715968002' });
  globalThis.chrome = { runtime: { sendMessage: () => {}, lastError: null, getURL: (p) => p } };
  ({ ctxFromMeta, handoffIsRelevant, isPlatformLabel } = await import(detectorUrl));
});

// ── A — the confirmation page ────────────────────────────────────────────────────────────────

test('THE BUG: "Thank you for applying" is refused as a job title', () => {
  mount({
    url: 'https://job-boards.greenhouse.io/gitlab/jobs/8715968002',
    head: '<title>Thank you for applying</title>',
  });
  assert.equal(ctxFromMeta().title, '', 'a confirmation heading is not a job title');
});

test('every confirmation phrasing observed on these ATS is refused', () => {
  for (const t of ['Thank you for applying', 'Thanks for applying!', 'Application submitted',
    'Application received', 'Your application has been received', 'Submission received',
    'Application Confirmation', 'Merci de votre candidature']) {
    mount({ url: 'https://job-boards.greenhouse.io/x/jobs/1', head: `<title>${t}</title>` });
    assert.equal(ctxFromMeta().title, '', t);
  }
});

test('a real job title is untouched', () => {
  for (const t of ['Senior Backend Engineer', 'Sr. Software Engineer (Hardware)',
    'Intermediate Backend Engineer, Platform Readiness', 'Thankful Inc — Staff Engineer']) {
    mount({ url: 'https://job-boards.greenhouse.io/x/jobs/1', head: `<title>${t}</title>` });
    assert.equal(ctxFromMeta().title, t, t);
  }
});

test('THE BUG: "job-boards" is refused as an employer', () => {
  mount({ url: 'https://job-boards.greenhouse.io/gitlab/jobs/8715968002', head: '<title>Senior Backend Engineer</title>' });
  assert.equal(ctxFromMeta().company, '', 'the hostname label of an ATS board is not a company');
});

test('the other ATS routing labels are refused too, real employers are not', () => {
  for (const l of ['job-boards', 'boards', 'jobs', 'apply', 'careers', 'recruiting', 'talent', 'www', 'app', 'secure']) {
    assert.equal(isPlatformLabel(l), true, l);
  }
  for (const l of ['gitlab', 'dialpad', 'affirm', 'tailscale', 'faire', 'hootsuite', 'reddit']) {
    assert.equal(isPlatformLabel(l), false, l);
  }
});

test('a page that names its employer in metadata still gets it', () => {
  mount({
    url: 'https://job-boards.greenhouse.io/gitlab/jobs/8715968002',
    head: '<title>Senior Backend Engineer</title><meta property="og:site_name" content="GitLab" />',
  });
  const ctx = ctxFromMeta();
  assert.equal(ctx.title, 'Senior Backend Engineer');
  assert.equal(ctx.company, 'GitLab');
});

// ── B — handoff relevance ────────────────────────────────────────────────────────────────────

const DIALPAD_HANDOFF = {
  url: 'https://job-boards.greenhouse.io/dialpad/jobs/8661336002',
  externalId: 'greenhouse:8661336002',
  ctx: { title: 'Sr. Software Engineer (Hardware)', company: 'dialpad', jobUrl: 'https://job-boards.greenhouse.io/dialpad/jobs/8661336002' },
  ts: Date.now(),
};

test('THE BUG: another tab\'s freshly-stored job is NOT adopted', () => {
  mount({ url: 'https://job-boards.greenhouse.io/gitlab/jobs/8682707002' });
  assert.equal(handoffIsRelevant(DIALPAD_HANDOFF), false,
    'six seconds newer is not evidence that this page is that job');
});

test('this posting\'s OWN handoff is adopted — including on the page the submit navigated to', () => {
  const own = { ...DIALPAD_HANDOFF, url: 'https://job-boards.greenhouse.io/gitlab/jobs/8682707002', externalId: 'greenhouse:8682707002' };
  mount({ url: 'https://job-boards.greenhouse.io/gitlab/jobs/8682707002' });
  assert.equal(handoffIsRelevant(own), true, 'same host + path');
  mount({ url: 'https://job-boards.greenhouse.io/gitlab/jobs/8682707002/confirmation' });
  assert.equal(handoffIsRelevant(own), true, 'the posting id is still in our URL');
});

test('the genuine board → ATS handoff still works (that is what this mechanism is FOR)', () => {
  const fromLinkedIn = {
    url: 'https://www.linkedin.com/jobs/view/4434697931',
    externalId: 'linkedin:4434697931',
    ctx: { title: 'AI Solutions Engineer', company: 'Affirm', jobUrl: 'https://www.linkedin.com/jobs/view/4434697931' },
    ts: Date.now(),
  };
  mount({
    url: 'https://job-boards.greenhouse.io/affirm/jobs/7663436003',
    referrer: 'https://www.linkedin.com/jobs/view/4434697931',
  });
  assert.equal(handoffIsRelevant(fromLinkedIn), true, 'our referrer is the host it was stored on');
  // ...but only with that referrer. A cold ATS page must not inherit LinkedIn's job.
  mount({ url: 'https://job-boards.greenhouse.io/affirm/jobs/7663436003' });
  assert.equal(handoffIsRelevant(fromLinkedIn), false);
});

test('a malformed or empty handoff is never relevant', () => {
  mount({ url: 'https://job-boards.greenhouse.io/gitlab/jobs/1' });
  assert.equal(handoffIsRelevant(null), false);
  assert.equal(handoffIsRelevant({}), false);
  assert.equal(handoffIsRelevant({ url: 'not a url', externalId: 'x' }), false);
});

test('a very short externalId cannot match by accident', () => {
  mount({ url: 'https://job-boards.greenhouse.io/gitlab/jobs/8682707002' });
  assert.equal(handoffIsRelevant({ url: 'https://elsewhere.example/x', externalId: '86', ctx: {}, ts: Date.now() }), false,
    '"86" appears in the URL, but two digits prove nothing');
});
