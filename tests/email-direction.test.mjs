// Direction, and the pipeline movement it guards.
//
// Chunk 1 found 12 rejections, 7 assessments and 6 interviews — and then left every one of those
// applications showing its old stage. This chunk turns verdicts into movement, which means the
// question "who actually said this?" now changes data. Three of the six "interviews" were Pierre's
// own replies; the sharp failure is not the miscount but Pierre replying to a rejection and the
// quoted text marking the job rejected on his own say-so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dir_ = require(path.join(here, '..', 'app', 'src', 'email-direction.js'));
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));

const SELF = ['pierresalama115@gmail.com'];

// ---- direction ---------------------------------------------------------------------------------

test('mail from the user is outbound; mail from anyone else is inbound', () => {
  assert.equal(dir_.directionOf({ fromAddr: 'pierresalama115@gmail.com' }, SELF), 'outbound');
  assert.equal(dir_.directionOf({ fromAddr: 'adorxb@syntronic.com' }, SELF), 'inbound');
});

test('a display-name wrapper does not hide the address', () => {
  assert.equal(dir_.directionOf({ fromAddr: 'Pierre Salama <pierresalama115@gmail.com>' }, SELF), 'outbound');
  assert.equal(dir_.directionOf({ fromAddr: 'Adam Ortner <adorxb@syntronic.com>' }, SELF), 'inbound');
});

test('gmail dots and +tags still resolve to the same person', () => {
  // A reply sent from an alias is still Pierre, and must not read as an employer.
  for (const a of ['pierre.salama115@gmail.com', 'pierresalama115+jobs@gmail.com', 'Pierre.Salama115+x@GMail.com']) {
    assert.equal(dir_.directionOf({ fromAddr: a }, SELF), 'outbound', `${a} is Pierre`);
  }
});

test('dot-stripping applies to gmail only — other domains keep their local part', () => {
  assert.equal(dir_.canonical('first.last@fastmail.com'), 'first.last@fastmail.com');
  assert.equal(dir_.canonical('first.last@gmail.com'), 'firstlast@gmail.com');
});

test('with NO known self-addresses everything is inbound — it fails to the OLD behaviour', () => {
  // A misconfigured address list must not silently stop the pipeline from ever elevating again.
  assert.equal(dir_.directionOf({ fromAddr: 'pierresalama115@gmail.com' }, []), 'inbound');
  assert.equal(dir_.directionOf({ fromAddr: 'anyone@example.com' }, undefined), 'inbound');
});

test('an email with no sender at all is inbound rather than dropped', () => {
  assert.equal(dir_.directionOf({}, SELF), 'inbound');
  assert.equal(dir_.directionOf({ fromAddr: '' }, SELF), 'inbound');
});

test('canElevate reads the same at every call site', () => {
  assert.equal(dir_.canElevate('inbound'), true);
  assert.equal(dir_.canElevate('outbound'), false);
});

// ---- verdicts move the pipeline ----------------------------------------------------------------

let tmp;
test.before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-dir-')); db.open(tmp); });
test.after(() => { try { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

let n = 0;
function seed({ category, confidence = 0.95, from = 'hr@company.com', status = 'submitted', matchSource = 'auto', subject = 'Update' }) {
  const job = db.upsertJob({ title: `Role ${++n}`, company: `Co${n}`, source: 'linkedin', status, jobUrl: `https://x/j/${n}` }).job;
  const em = db.emailUpsert({
    accountId: 'a', provider: 'gmail', uid: n, from, fromName: 'Sender',
    subject, snippet: subject, body: subject, sentAt: new Date().toISOString(),
    matchedJobId: job.id, matchSource, matchConfidence: 0.9,
  });
  db.triageRecord({ emailId: em.id, route: 'settled', category, reason: 'test', decidedBy: 'sonnet', confidence });
  return { jobId: job.id, emailId: em.id };
}

test('a Sonnet-found rejection actually moves the application to rejected', () => {
  const { jobId } = seed({ category: 'rejection' });
  const r = db.applyTriageVerdicts({ selfAddresses: SELF });
  assert.equal(db.getJob(jobId).status, 'rejected');
  assert.ok(r.applied.some((a) => a.jobId === jobId && a.to === 'rejected'));
});

test('an interview and an assessment each move to their own stage', () => {
  const iv = seed({ category: 'interview' });
  const as = seed({ category: 'assessment' });
  db.applyTriageVerdicts({ selfAddresses: SELF });
  assert.equal(db.getJob(iv.jobId).status, 'interview_1');
  assert.equal(db.getJob(as.jobId).status, 'assessment');
});

test("PIERRE'S OWN REPLY never moves a job — the failure this chunk exists to prevent", () => {
  const { jobId } = seed({ category: 'rejection', from: 'pierresalama115@gmail.com', subject: 'Re: your decision' });
  const before = db.getJob(jobId).status;
  const r = db.applyTriageVerdicts({ selfAddresses: SELF });
  assert.equal(db.getJob(jobId).status, before, 'a quoted rejection in his own reply is not news');
  assert.ok(r.skipped.outbound >= 1);
});

test('a low-confidence verdict is a question, not news', () => {
  const { jobId } = seed({ category: 'rejection', confidence: 0.4 });
  const before = db.getJob(jobId).status;
  const r = db.applyTriageVerdicts({ selfAddresses: SELF, minConfidence: 0.7 });
  assert.equal(db.getJob(jobId).status, before);
  assert.ok(r.skipped.lowConfidence >= 1);
});

test('elevation is forward-only and never demotes', () => {
  const { jobId } = seed({ category: 'application_confirmation', status: 'interview_1' });
  db.applyTriageVerdicts({ selfAddresses: SELF });
  assert.equal(db.getJob(jobId).status, 'interview_1', 'a late confirmation cannot pull a job backwards');
});

test('a terminal job is left alone', () => {
  const { jobId } = seed({ category: 'interview', status: 'rejected' });
  db.applyTriageVerdicts({ selfAddresses: SELF });
  assert.equal(db.getJob(jobId).status, 'rejected');
});

test('a merely SUGGESTED match does not move anything', () => {
  const { jobId } = seed({ category: 'rejection', matchSource: 'suggested' });
  const before = db.getJob(jobId).status;
  const r = db.applyTriageVerdicts({ selfAddresses: SELF });
  assert.equal(db.getJob(jobId).status, before, 'an unconfirmed guess must not rewrite the pipeline');
  assert.ok(r.skipped.unmatchedSource >= 1);
});

test('applying twice changes nothing the second time', () => {
  const first = db.applyTriageVerdicts({ selfAddresses: SELF });
  const second = db.applyTriageVerdicts({ selfAddresses: SELF });
  assert.equal(second.applied.length, 0, 'idempotent — forward-only makes the second pass a no-op');
  assert.ok(first.applied.length >= 0);
});

test('a stage change is written to the job timeline, with the email that caused it', () => {
  const { jobId } = seed({ category: 'offer', subject: 'We are pleased to offer you the role' });
  db.applyTriageVerdicts({ selfAddresses: SELF });
  const events = db.listEvents(jobId) || [];
  assert.ok(events.some((e) => /email triage read/i.test(String(e.summary || ''))),
    'a status change with no visible cause is the thing that made this hard to debug before');
});

// ---- orphans: high-value verdicts with no application behind them -------------------------------

test('a rejection that matches no job is surfaced, not silently dropped', () => {
  const em = db.emailUpsert({
    accountId: 'a', provider: 'gmail', uid: 9001, from: 'hr@mystery.com', fromName: 'Mystery',
    subject: 'Regarding your application', snippet: 'x', body: 'x', sentAt: new Date().toISOString(),
  });
  db.triageRecord({ emailId: em.id, route: 'settled', category: 'rejection', reason: 'clear rejection', decidedBy: 'sonnet', confidence: 0.95 });
  const orphans = db.triageOrphans({ selfAddresses: SELF });
  assert.ok(orphans.some((o) => o.id === em.id), 'the matcher missing something must reach a human');
});

test("the user's own unmatched mail is not reported as an orphan", () => {
  const em = db.emailUpsert({
    accountId: 'a', provider: 'gmail', uid: 9002, from: 'pierresalama115@gmail.com', fromName: 'Pierre',
    subject: 'Re: interview', snippet: 'x', body: 'x', sentAt: new Date().toISOString(),
  });
  db.triageRecord({ emailId: em.id, route: 'settled', category: 'interview', reason: 'his own reply', decidedBy: 'sonnet', confidence: 0.95 });
  const orphans = db.triageOrphans({ selfAddresses: SELF });
  assert.ok(!orphans.some((o) => o.id === em.id), 'his own reply is not a lead to chase');
});

test('only the high-value categories become orphans — confirmations are not chores', () => {
  const em = db.emailUpsert({
    accountId: 'a', provider: 'gmail', uid: 9003, from: 'noreply@board.com', fromName: 'Board',
    subject: 'Application received', snippet: 'x', body: 'x', sentAt: new Date().toISOString(),
  });
  db.triageRecord({ emailId: em.id, route: 'settled', category: 'application_confirmation', reason: 'ack', decidedBy: 'sonnet', confidence: 0.99 });
  assert.ok(!db.triageOrphans({ selfAddresses: SELF }).some((o) => o.id === em.id));
});

// ---- self-address discovery --------------------------------------------------------------------

test('the user\'s address is discovered from what the app already knows', () => {
  // Deliberately not a new setting: autofill has already written this into dozens of forms, so the
  // harvested profile is where it reliably lives. A setting nobody fills in would mean direction
  // detection silently never engages.
  const pid = db.ensureDefaultProfileId();
  db.profileFieldUpsert({ profileId: pid, question: 'Email address', value: 'pierresalama115@gmail.com', locale: 'en' });
  const found = db.selfEmailAddresses();
  assert.ok(found.includes('pierresalama115@gmail.com'), `expected the profile email among ${JSON.stringify(found)}`);
});
