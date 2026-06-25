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
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-terminal-')); db.open(dir); });
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function task(n) {
  const job = db.upsertJob({ externalId: String(n), title: 'Dev ' + n, company: 'Acme', source: 'linkedin', status: 'started', jobUrl: `https://x/${n}` }).job;
  return db.queueAdd(job.id, { mode: 'auto' });
}

test('failed and skipped tasks always retain diagnostics', () => {
  const failed = db.queuePatch(task(1).id, { state: 'failed' });
  const skipped = db.queuePatch(task(2).id, { state: 'skipped' });
  assert.match(failed.lastError, /without a diagnostic/);
  assert.match(skipped.lastError, /without a diagnostic/);
});

test('a diagnostic-less skip that was a STOP reads "stopped by you", not "without a diagnostic"', () => {
  // The common case: auto-apply paused mid-run cancels in-flight tasks; older extensions emit the
  // "stopped from dashboard" transcript note but omit lastError. The server must label it honestly.
  const t = task(20);
  const r = db.queuePatch(t.id, { state: 'skipped', transcriptAppend: { note: 'stopped from dashboard' } });
  assert.match(r.lastError, /stopped by you/i);
  assert.doesNotMatch(r.lastError, /without a diagnostic/);
  // And a genuine no-signal skip still gets the honest fallback.
  const r2 = db.queuePatch(task(21).id, { state: 'skipped' });
  assert.match(r2.lastError, /without a diagnostic/);
});

test('empty user-wait states become failures', () => {
  const result = db.queuePatch(task(3).id, { state: 'awaiting_input', parkReason: 'missing information' });
  assert.equal(result.state, 'failed');
  assert.match(result.lastError, /missing information/);
});

test('done requires confirmation evidence', () => {
  const unproven = db.queuePatch(task(4).id, { state: 'done' });
  assert.equal(unproven.state, 'awaiting_review');
  const proven = db.queuePatch(task(5).id, { state: 'done', submissionEvidence: { type: 'confirmation', url: 'https://x/thank-you' } });
  assert.equal(proven.state, 'done');
  assert.equal(proven.submissionEvidence.type, 'confirmation');
});

// ---- FIX 2: a VERIFIED done must clear a stale last_error (the "looks like a false positive") ----
test('verified done CLEARS a stale last_error / park_reason / pending_questions', () => {
  const t = task(6);
  // Simulate an earlier retry attempt that left a stale "submit not confirmed" error + park.
  db.queuePatch(t.id, {
    state: 'awaiting_review',
    lastError: 'submit was reported without confirmation — please confirm',
    parkReason: 'unverified',
    pendingQuestions: [{ question: 'confirm submit', reason: 'unverified' }],
  });
  // Now the real, verified submission lands with trustworthy R1 evidence.
  const done = db.queuePatch(t.id, {
    state: 'done',
    submissionEvidence: { type: 'verified', reason: 'text-became-success', url: 'https://x/applied' },
  });
  assert.equal(done.state, 'done');
  assert.equal(done.lastError, null, 'stale last_error must be cleared on a verified done');
  assert.equal(done.parkReason, null, 'stale park_reason must be cleared on a verified done');
  assert.deepEqual(done.pendingQuestions, [], 'stale pending_questions must be cleared on a verified done');
  assert.equal(done.submissionEvidence.type, 'verified');
});

test('verified done clears the error even when this same patch carries the stale lastError', () => {
  // An old extension version could PATCH done + the stale error together — the guard must
  // still null it because the evidence IS trustworthy.
  const done = db.queuePatch(task(7).id, {
    state: 'done',
    lastError: 'submit was reported without confirmation — please confirm',
    submissionEvidence: { type: 'verified', reason: 'new-confirmation-node', url: 'https://x/ok' },
  });
  assert.equal(done.state, 'done');
  assert.equal(done.lastError, null);
});

test('evidence-LESS done is STILL downgraded to awaiting_review (R1 guard not weakened)', () => {
  const r = db.queuePatch(task(8).id, { state: 'done', lastError: null });
  assert.equal(r.state, 'awaiting_review');
  assert.match(r.lastError, /without confirmation evidence/);
});

test('done with LEGACY/untrustworthy success-signal evidence does NOT get its error cleared', () => {
  // A legacy static success-signal is NOT trustworthy → the clear must not fire. The row stays
  // done with the evidence as-is (the historical quarantine migration is what downgrades these),
  // but a same-patch lastError is preserved rather than nulled by the FIX-2 trustworthy clear.
  const r = db.queuePatch(task(9).id, {
    state: 'done',
    lastError: 'heads up — static success text only',
    submissionEvidence: { type: 'success-signal', detail: 'confirmation text', url: 'https://x/maybe' },
  });
  assert.equal(r.state, 'done');                       // evidence is present (non-null), so not downgraded here
  assert.equal(r.lastError, 'heads up — static success text only');  // untrusted → error NOT cleared
});
