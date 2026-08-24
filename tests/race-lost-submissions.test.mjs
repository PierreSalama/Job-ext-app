// EVERY REAL SUBMISSION WAS RECORDED AS UNVERIFIED.
//
// 2026-08-24 the external-ATS lane submitted 7 applications for the first time (GitLab ×6,
// Dialpad ×1). All 7 landed in `awaiting_review` with "interrupted AFTER the final submit was
// clicked", and NONE reached `done` — five of them with a visible "Thank you for applying" on
// screen. The transcripts end, to the line, at:
//
//     trace:button isFinalSubmit("Submit application")=true [ats-pack hint] mode=auto
//
// and nothing follows. Everything that PROVES a submit runs AFTER the click (confirmSubmitted
// waits up to 15s for the confirmation to settle, then report() sends the evidence), so a submit
// whose confirmation is a NEW DOCUMENT destroys the content world before any of it can run. The
// server's stale-run reconciler then finds a `running` row 8 minutes later, sees the pre-click
// marker, and files it as an interruption of unknown outcome.
//
// That is not just bookkeeping: the "the ATS lane has never submitted anything" conclusion was
// drawn from `done` counts these rows were missing from.
//
// Three changes, one test each:
//   1. reconcileStaleRunning degrades a grounded race-loss to "PROBABLY submitted" with `probable`
//      evidence, instead of to an outcome we claim to know nothing about.
//   2. `probable` is explicitly NOT trustworthy evidence — it must never let a row hold `done`.
//   3. recoverRaceLostSubmissions promotes on the `post-nav-confirmation` marker, which
//      detector.js writes from the document the submit navigated to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));
let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-racelost-')); db.open(dir); });
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let n = 0;
// Seed a task left in 'running' with the given transcript notes, exactly as an executor that died
// mid-run would leave it.
function runningTask(notes) {
  n++;
  const job = db.upsertJob({
    externalId: 'gh' + n, title: 'Senior Backend Engineer ' + n, company: 'GitLab',
    source: 'greenhouse', status: 'started', jobUrl: `https://job-boards.greenhouse.io/gitlab/jobs/${8000000 + n}`,
  }).job;
  const t = db.queueAdd(job.id, { mode: 'auto' });
  for (const note of notes) db.queuePatch(t.id, { transcriptAppend: { note } });
  db.queuePatch(t.id, { state: 'running' });
  return t.id;
}
const reload = (id) => db.queueGet(id);

// The REAL final three transcript lines from task_430e2cb0 (GitLab 8682707002), plus the
// submit-intent marker the fixed executor now writes and awaits before the click.
const REAL_TAIL = [
  'trace:button chose "Submit application" tier=in-form-advance',
  'trace:button isFinalSubmit("Submit application")=true [ats-pack hint] mode=auto',
];

test('a grounded race-loss degrades to PROBABLY submitted, with probable evidence', () => {
  const id = runningTask([
    ...REAL_TAIL,
    'submit-intent url=/gitlab/jobs/8682707002 grounded=true pack=greenhouse',
  ]);
  db.reconcileStaleRunning({ olderThanMinutes: -1, scheduledOlderThanMinutes: -1 });
  const t = reload(id);
  assert.equal(t.state, 'awaiting_review', 'still needs a human — `done` requires proof');
  assert.match(t.lastError, /probably submitted/i,
    'the old text claimed we knew nothing; a grounded submit-intent means we know quite a lot');
  assert.ok(t.submissionEvidence, 'a race-loss must carry evidence saying WHICH KIND of unknown it is');
  assert.equal(t.submissionEvidence.type, 'probable');
  assert.equal(t.submissionEvidence.reason, 'race-lost-after-submit-click');
});

test('without the pre-click marker it stays an honest unknown', () => {
  // Only the button recogniser fired — no submit-intent, so we cannot say the click ever happened
  // on a grounded form. This must NOT be upgraded to "probably submitted".
  const id = runningTask(REAL_TAIL);
  db.reconcileStaleRunning({ olderThanMinutes: -1, scheduledOlderThanMinutes: -1 });
  const t = reload(id);
  assert.equal(t.state, 'awaiting_review');
  assert.match(t.lastError, /interrupted AFTER the final submit/i);
  assert.equal(t.submissionEvidence, null, 'no marker → no claim');
});

test('an UNgrounded submit-intent is not upgraded either', () => {
  const id = runningTask([
    ...REAL_TAIL,
    'submit-intent url=/acme/jobs/1 grounded=false',
  ]);
  db.reconcileStaleRunning({ olderThanMinutes: -1, scheduledOlderThanMinutes: -1 });
  const t = reload(id);
  assert.match(t.lastError, /interrupted AFTER the final submit/i);
  assert.equal(t.submissionEvidence, null);
});

test('`probable` is NEVER trustworthy evidence — it cannot hold a `done`', () => {
  assert.equal(db.isTrustworthyEvidence({ type: 'probable', reason: 'race-lost-after-submit-click' }), false);
  // and the real proofs still are
  assert.equal(db.isTrustworthyEvidence({ type: 'verified', reason: 'post-nav-confirmation' }), true);
  assert.equal(db.isTrustworthyEvidence({ type: 'verified', reason: 'new-confirmation-node' }), true);
});

test('recoverRaceLostSubmissions promotes on the post-nav confirmation marker', () => {
  // detector.js patched state+evidence from the confirmation document, but only the state-only
  // reconcile landed and the evidence-bearing half was dropped (the pre-existing race this
  // function exists for). The transcript still carries the proof.
  const id = runningTask([
    ...REAL_TAIL,
    'submit-intent url=/gitlab/jobs/8715968002 grounded=true pack=greenhouse',
    'submitted — verified (post-nav-confirmation) — confirmation read on the page the submit navigated to',
  ]);
  db.reconcileStaleRunning({ olderThanMinutes: -1, scheduledOlderThanMinutes: -1 });
  assert.equal(reload(id).state, 'awaiting_review');
  const promoted = db.recoverRaceLostSubmissions();
  assert.ok(promoted >= 1);
  const t = reload(id);
  assert.equal(t.state, 'done');
  assert.equal(t.submissionEvidence.type, 'verified');
  assert.equal(t.submissionEvidence.reason, 'post-nav-confirmation');
  assert.equal(t.lastError, null, 'a recovered done must carry no contradictory failure text');
});

// The pre-click success-truth baseline is the SAME class of marker and is already on live rows.
// These four transcripts are the real ones from 2026-08-24: three carry the baseline line, and the
// rest lost even that to the teardown (report() is fire-and-forget, so the last PATCHes simply
// never went out — which is exactly why the intent marker is awaited).
test('the pre-click success-truth baseline counts as a grounded marker too', () => {
  const id = runningTask([
    ...REAL_TAIL,
    'trace:submit baseline url=/tailscale/jobs/4721713005 successTextAlready=false nodeSig=0 formGrounded=true',
  ]);
  db.reconcileStaleRunning({ olderThanMinutes: -1, scheduledOlderThanMinutes: -1 });
  const t = reload(id);
  assert.match(t.lastError, /probably submitted/i);
  assert.equal(t.submissionEvidence.type, 'probable');
});

test('a baseline with formGrounded=FALSE claims nothing', () => {
  const id = runningTask([...REAL_TAIL, 'trace:submit baseline url=/x/1 successTextAlready=false nodeSig=0 formGrounded=false']);
  db.reconcileStaleRunning({ olderThanMinutes: -1, scheduledOlderThanMinutes: -1 });
  assert.equal(reload(id).submissionEvidence, null);
});

test('creditRaceLostBacklog credits rows the OLD code already filed, and only those it can', () => {
  // Reproduce two live rows filed before the evidence existed: one with a grounded marker, one
  // whose transcript lost everything after the button decision.
  const withMarker = runningTask([...REAL_TAIL, 'trace:submit baseline url=/gitlab/jobs/8451512002 successTextAlready=false nodeSig=0 formGrounded=true']);
  const bare = runningTask([...REAL_TAIL]);
  for (const id of [withMarker, bare]) {
    db.queuePatch(id, {
      state: 'awaiting_review',
      lastError: 'interrupted AFTER the final submit was clicked — confirm whether this went through (not retried, to avoid a duplicate application)',
    });
  }
  assert.equal(reload(withMarker).submissionEvidence, null, 'starts with no evidence, like the live rows');

  const n = db.creditRaceLostBacklog();
  assert.ok(n >= 1);
  const a = reload(withMarker);
  assert.equal(a.state, 'awaiting_review', 'still awaiting a human — state is never changed');
  assert.equal(a.submissionEvidence.type, 'probable');
  assert.match(a.lastError, /probably submitted/i);

  const b = reload(bare);
  assert.equal(b.submissionEvidence, null, 'no marker → still an honest unknown');
  assert.match(b.lastError, /interrupted AFTER/i);

  assert.equal(db.creditRaceLostBacklog(), 0, 'idempotent — a second pass credits nothing');
});

test('recovery still refuses the legacy static success signal', () => {
  const id = runningTask([...REAL_TAIL, 'application submitted (confirmation)']);
  db.reconcileStaleRunning({ olderThanMinutes: -1, scheduledOlderThanMinutes: -1 });
  const before = reload(id).state;
  db.recoverRaceLostSubmissions();
  assert.equal(reload(id).state, before, 'the pre-R1 static signal is exactly what quarantine exists to reject');
});
