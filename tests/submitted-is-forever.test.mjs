// A SUBMITTED APPLICATION CANNOT BECOME UNSUBMITTED.
//
// Live 2026-07-20: pausing auto-apply patched in-flight rows to 'skipped', and a recovery script
// requeued rows by their skip reason. Between them, five real applications — dcbel Inc, Intégral,
// Systematix, Farber Debt Solutions, and one smartapply job — were rewritten from 'done' to
// 'skipped'. The submissions had genuinely happened (each row still carried its verified evidence);
// only the ledger was wrong. The day read 50 submissions instead of 55, and those employers were
// eligible to be applied to a second time.
//
// The rule is enforced at the STORAGE boundary rather than in each caller, because the callers that
// broke it were unrelated: the executor's cancel(), background's teardown reconcile, and an ad-hoc
// maintenance script. db.js already guarded the opposite direction (done without evidence gets
// downgraded); this is the missing half.
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
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-sub-')); db.open(dir); });
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const VERIFIED = { type: 'verified', reason: 'url-confirmation', detail: 'confirmation', url: 'https://x/apply/done' };

function submittedTask(tag) {
  const job = db.upsertJob({ externalId: String(tag), title: 'Engineer ' + tag, company: 'Co ' + tag, source: 'indeed', status: 'started', jobUrl: 'https://ca.indeed.com/viewjob?jk=' + tag }).job;
  const t = db.queueAdd(job.id, { mode: 'auto' });
  db.queuePatch(t.id, { state: 'done', submissionEvidence: VERIFIED });
  const after = db.queueGet(t.id);
  assert.equal(after.state, 'done', 'precondition: the task is a verified submission');
  return t.id;
}

test('pausing auto-apply cannot un-submit an application', () => {
  const id = submittedTask('pause');
  // Exactly what the pause path did: patch to skipped with no diagnostic.
  db.queuePatch(id, { state: 'skipped' });
  assert.equal(db.queueGet(id).state, 'done', 'a verified submission must survive a stop/pause');
});

test('a recovery script cannot requeue an application that was already sent', () => {
  const id = submittedTask('requeue');
  db.queuePatch(id, { state: 'queued', lastError: null, parkReason: null });
  const t = db.queueGet(id);
  assert.equal(t.state, 'done', 'requeuing a sent application would re-apply to that employer');
});

test('neither can a failure, a park, or a bare skip', () => {
  for (const state of ['failed', 'parked', 'skipped', 'awaiting_review']) {
    const id = submittedTask('st-' + state);
    db.queuePatch(id, { state, lastError: 'something went wrong' });
    assert.equal(db.queueGet(id).state, 'done', `must survive a patch to ${state}`);
  }
});

test('the evidence and the refusal are both preserved', () => {
  const id = submittedTask('trail');
  db.queuePatch(id, { state: 'skipped', transcriptAppend: { note: 'caller note that must survive' } });
  const t = db.queueGet(id);
  const ev = typeof t.submissionEvidence === 'string' ? JSON.parse(t.submissionEvidence) : t.submissionEvidence;
  assert.equal(ev.type, 'verified', 'evidence must be untouched');
  const trail = JSON.stringify(t.transcript || []);
  assert.match(trail, /refused to move a VERIFIED submission out of done/, 'the refusal is recorded');
  assert.match(trail, /caller note that must survive/, "the caller's own note is not erased");
});

test('an UNPROVEN done is still downgradable — the guard is not a blanket lock', () => {
  // Only type:"verified" is protected. A done row without trustworthy evidence must still be
  // correctable, otherwise this guard would freeze bad data in place.
  const job = db.upsertJob({ externalId: 'weak', title: 'Engineer weak', company: 'Weak Co', source: 'indeed', status: 'started', jobUrl: 'https://ca.indeed.com/viewjob?jk=weak' }).job;
  const t = db.queueAdd(job.id, { mode: 'auto' });
  db.queuePatch(t.id, { state: 'done', submissionEvidence: { type: 'reported', reason: 'legacy' } });
  db.queuePatch(t.id, { state: 'skipped', lastError: 'not actually submitted' });
  assert.notEqual(db.queueGet(t.id).state, 'done', 'unverified done rows must remain correctable');
});
