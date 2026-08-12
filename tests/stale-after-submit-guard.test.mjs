// A run that died AFTER clicking the final submit must never be silently retried.
//
// reconcileStaleRunning flips any stale running/scheduled task to retriable 'failed'. That assumes
// nothing happened — but a run can die between clicking the final submit and reading the
// confirmation (hung tab, MV3 evicting the service worker). The executor never reports, so the only
// surviving evidence is the transcript.
//
// Live 2026-08-09, a Greenhouse task on the laptop, verbatim:
//   trace:button chose "Submit application" tier=in-form-advance
//   trace:button isFinalSubmit("Submit application")=true [ats-pack hint] mode=auto
//   scheduled (mode=auto)          ← requeued as "timed out / interrupted — will retry"
//
// Re-applying to a job Pierre may already have applied to is worse for him than a missed
// application: the employer sees a duplicate and neither of us ever finds out. We cannot PROVE it
// submitted — that is exactly why the verified-evidence rule exists — so we must not claim it did
// either. awaiting_review already means "submit was clicked, outcome unknown, confirm it".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const db = fs.readFileSync(path.join(here, '..', 'app', 'src', 'db.js'), 'utf8');
const RX = new RegExp(db.match(/const CLICKED_FINAL_SUBMIT_RX = \/(.+)\/i;/)[1], 'i');

// Mirror the reconciler's routing decision.
const route = (transcript) => (RX.test(String(transcript || '')) ? 'awaiting_review' : 'failed');

test('the live Greenhouse transcript routes to review, not retry', () => {
  const live = 'trace:button chose "Submit application" tier=in-form-advance '
    + 'trace:button isFinalSubmit("Submit application")=true [ats-pack hint] mode=auto';
  assert.equal(route(live), 'awaiting_review');
});

test('a verified submit that lost its report is also protected', () => {
  assert.equal(route('submitted — verified (new-confirmation-node)'), 'awaiting_review');
});

test('a run that never reached submit is still retried — throughput must not regress', () => {
  const early = 'trace:page step=1 vis=visible route=linkedin_easy_apply_modal '
    + 'trace:scan fillable=3 trace:button chose "Next" tier=in-form-advance';
  assert.equal(route(early), 'failed', 'no submit was clicked — retrying is correct and necessary');
});

test('a REFUSED AI final-submit is not mistaken for a click', () => {
  // The rescue path logs that it refused to press submit. That is the opposite of having clicked it.
  const refused = 'trace:rescue REFUSED AI final-submit "Submit application" — submit stays on the verified path';
  assert.equal(route(refused), 'failed', 'refusing to click must not block a legitimate retry');
});

test('isFinalSubmit=false does not trip the guard', () => {
  assert.equal(route('trace:button isFinalSubmit("Next")=false mode=auto'), 'failed');
});

test('an empty or missing transcript retries as before', () => {
  assert.equal(route(''), 'failed');
  assert.equal(route(null), 'failed');
  assert.equal(route(undefined), 'failed');
});

test('the reconciler reads the transcript and routes both ways', () => {
  const fn = db.slice(db.indexOf('function reconcileStaleRunning'), db.indexOf('// One-shot cleanup'));
  assert.match(fn, /SELECT [^;]*transcript[^;]*FROM auto_apply_tasks/,
    'it cannot check for a submit click without selecting the transcript');
  assert.match(fn, /CLICKED_FINAL_SUBMIT_RX\.test/, 'must consult the guard');
  assert.match(fn, /state='awaiting_review'/, 'possible-submit → confirm, never silently retry');
  assert.match(fn, /state='failed'/, 'everything else still retries');
});

test('it never CLAIMS the job was submitted — only that it needs confirming', () => {
  const fn = db.slice(db.indexOf('function reconcileStaleRunning'), db.indexOf('// One-shot cleanup'));
  assert.doesNotMatch(fn, /state='done'/,
    'marking it done would violate the verified-evidence rule and inflate the ledger');
  assert.match(fn, /confirm whether this went through/i, 'the reason must say what is uncertain');
});
