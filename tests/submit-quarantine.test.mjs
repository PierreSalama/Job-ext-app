// SUCCESS-TRUTH quarantine — historical `done` rows minted from the old static
// success-signal evidence (or with no evidence) must be downgraded to
// awaiting_review so they are re-verified, never silently trusted. Trustworthy
// rows (the new `verified` type, a real `confirmation`) must survive untouched.
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
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-quarantine-')); db.open(dir); });
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function doneTask(n, evidence) {
  const job = db.upsertJob({ externalId: String(n), title: 'Dev ' + n, company: 'Acme', source: 'linkedin', status: 'started', jobUrl: `https://x/${n}` }).job;
  const t = db.queueAdd(job.id, { mode: 'auto' });
  // queuePatch will keep state=done only when evidence is PRESENT (the existing guard
  // downgrades evidence-less done → awaiting_review). To seed a legacy evidence-less
  // `done`, pass undefined so the guard leaves whatever is stored... so for that case
  // we seed a non-empty evidence and then null it via a direct patch path below.
  return db.queuePatch(t.id, { state: 'done', submissionEvidence: evidence });
}

test('legacy static success-signal done → quarantined to awaiting_review', () => {
  const legacy = doneTask(1, { type: 'success-signal', detail: 'confirmation text', url: 'https://x/1' });
  assert.equal(legacy.state, 'done');             // the old code path let this through
  const n = db.quarantineUntrustworthyDone();
  assert.ok(n >= 1);
  const after = db.queueList().find((t) => t.id === legacy.id);
  assert.equal(after.state, 'awaiting_review');
  assert.match(after.lastError, /not trustworthy/);
});

test('trustworthy verified done survives quarantine', () => {
  const good = doneTask(2, { type: 'verified', reason: 'new-confirmation-node', url: 'https://x/2/confirmation' });
  assert.equal(good.state, 'done');
  db.quarantineUntrustworthyDone();
  const after = db.queueList().find((t) => t.id === good.id);
  assert.equal(after.state, 'done');
});

test('real confirmation (modal-close) done survives quarantine', () => {
  const good = doneTask(3, { type: 'confirmation', url: 'https://x/3/thank-you' });
  assert.equal(good.state, 'done');
  db.quarantineUntrustworthyDone();
  const after = db.queueList().find((t) => t.id === good.id);
  assert.equal(after.state, 'done');
});

test('quarantine is idempotent', () => {
  doneTask(4, { type: 'success-signal', detail: 'confirmation URL', url: 'https://x/4' });
  const first = db.quarantineUntrustworthyDone();
  assert.ok(first >= 1);
  const second = db.quarantineUntrustworthyDone();
  assert.equal(second, 0);
});

// ---- race-lost VERIFIED submission recovery (evidence dropped on tab-teardown) ----

// Seed a task carrying a transcript marker but NO evidence object, in a given state, WITHOUT
// tripping the queuePatch 'done' recovery (so we can test the migration independently).
function seedWithTranscript(n, markerText, state) {
  const job = db.upsertJob({ externalId: 'r' + n, title: 'Dev ' + n, company: 'Acme', source: 'linkedin', status: 'started', jobUrl: `https://x/r${n}` }).job;
  const t = db.queueAdd(job.id, { mode: 'auto' });
  db.queuePatch(t.id, { transcriptAppend: { text: markerText } });
  db.queuePatch(t.id, { state, lastError: 'submit was reported without confirmation evidence — please verify' });
  return t.id;
}

test('recoverVerifiedEvidenceFromTranscript: R1 reasons recover, legacy "(confirmation)" does not', () => {
  const okA = db.recoverVerifiedEvidenceFromTranscript([{ text: 'trace:submit → DONE evidence=verified:text-became-success' }]);
  assert.equal(okA?.type, 'verified'); assert.equal(okA?.reason, 'text-became-success');
  const okC = db.recoverVerifiedEvidenceFromTranscript('[{"text":"✓ application submitted (new-confirmation-node)"}]');
  assert.equal(okC?.reason, 'new-confirmation-node');
  const okD = db.recoverVerifiedEvidenceFromTranscript([{ note: 'submitted — verified (confirm-signal:lever)' }]);
  assert.equal(okD?.reason, 'confirm-signal:lever');
  // legacy static signal must NOT be recovered
  assert.equal(db.recoverVerifiedEvidenceFromTranscript([{ text: '✓ application submitted (confirmation)' }]), null);
  assert.equal(db.recoverVerifiedEvidenceFromTranscript([{ note: 'submitted — confirmation' }]), null);
  // apply-form-closed is intentionally NOT auto-recovered (borderline when evidence is lost)
  assert.equal(db.recoverVerifiedEvidenceFromTranscript([{ note: 'submitted — verified (apply-form-closed)' }]), null);
  assert.equal(db.recoverVerifiedEvidenceFromTranscript([{ text: 'nothing relevant here' }]), null);
});

test('queuePatch: a done that loses its evidence is RECOVERED from an R1 transcript marker (not downgraded)', () => {
  const job = db.upsertJob({ externalId: 'rp1', title: 'Dev rp1', company: 'Acme', source: 'linkedin', status: 'started', jobUrl: 'https://x/rp1' }).job;
  const t = db.queueAdd(job.id, { mode: 'auto' });
  db.queuePatch(t.id, { transcriptAppend: { text: 'trace:submit → DONE evidence=verified:text-became-success' } });
  const after = db.queuePatch(t.id, { state: 'done' });   // NO submissionEvidence (the race)
  assert.equal(after.state, 'done', 'verified submit must survive the storage guard');
  assert.equal(after.submissionEvidence?.reason, 'text-became-success');
  assert.equal(after.submissionEvidence?.detail, 'recovered-from-transcript');
});

test('queuePatch: a done with ONLY the legacy "(confirmation)" marker is still downgraded', () => {
  const job = db.upsertJob({ externalId: 'rp2', title: 'Dev rp2', company: 'Acme', source: 'linkedin', status: 'started', jobUrl: 'https://x/rp2' }).job;
  const t = db.queueAdd(job.id, { mode: 'auto' });
  db.queuePatch(t.id, { transcriptAppend: { text: '✓ application submitted (confirmation)' } });
  const after = db.queuePatch(t.id, { state: 'done' });   // legacy static signal — untrustworthy
  assert.equal(after.state, 'awaiting_review');
  assert.match(after.lastError, /without confirmation evidence/);
});

test('recoverRaceLostSubmissions: promotes R1-verified awaiting_review → done, leaves legacy + genuine-unverified', () => {
  const verifiedId = seedWithTranscript(101, 'submitted — verified (text-became-success)', 'awaiting_review');
  const legacyId = seedWithTranscript(102, '✓ application submitted (confirmation)', 'awaiting_review');
  const unverifiedId = seedWithTranscript(103, 'submit unverified — no-confirmation', 'awaiting_review');
  const n = db.recoverRaceLostSubmissions();
  assert.ok(n >= 1);
  const list = db.queueList();
  assert.equal(list.find((t) => t.id === verifiedId).state, 'done', 'R1-verified must be recovered');
  assert.equal(list.find((t) => t.id === legacyId).state, 'awaiting_review', 'legacy static stays for human re-verify');
  assert.equal(list.find((t) => t.id === unverifiedId).state, 'awaiting_review', 'genuinely-unverified stays');
  // idempotent
  assert.equal(db.recoverRaceLostSubmissions(), 0);
});
