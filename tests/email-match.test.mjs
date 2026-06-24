// Robust email→job matching: thread/reply-chain inheritance ("trace the reply back to the
// original submission" even when the sender/subject no longer name the company/role), the
// no-bad-guess-propagation guard, and the new 'assessment' stage.
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
const email = require(path.join(here, '..', 'app', 'src', 'email.js'));

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-em-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

let n = 0;
function makeJob(company, title) {
  return db.upsertJob({ externalId: 'u' + (++n), title, company, source: 'linkedin', status: 'submitted', jobUrl: 'https://x/' + n }).job;
}
const iso = () => new Date().toISOString();

test('thread inheritance: a reply in a matched thread inherits the job even with NO company hint', () => {
  const job = makeJob('Acme Robotics', 'Software Engineer');
  db.emailUpsert({ accountId: 'a1', uid: 1, messageId: '<conf-1@acme.com>', threadId: 'TH-1',
    from: 'jobs@acme.com', subject: 'Application received', body: 'thanks for applying', sentAt: iso(),
    matchedJobId: job.id, matchConfidence: 0.9, matchSource: 'auto', category: 'application_confirmation' });
  // A later reply: SAME thread, personal recruiter address + opaque subject → no company/title hint.
  const reply = { threadId: 'TH-1', from: 'jane@gmail.com', fromName: 'Jane', subject: 'Re: next steps', body: 'Can you do a call Tuesday?', sentAt: iso() };
  const m = email.matchEmailToJob(reply, db.jobsForMatching());
  assert.equal(m.matchedJobId, job.id, 'inherits the threaded job');
  assert.equal(m.matchSource, 'auto');
  assert.equal(m.via, 'thread');
});

test('reply-chain inheritance: In-Reply-To a matched Message-ID inherits the job (IMAP, no thread id)', () => {
  const job = makeJob('Globex', 'Backend Developer');
  db.emailUpsert({ accountId: 'a1', uid: 2, messageId: '<globex-conf@globex.io>',
    from: 'no-reply@globex.io', subject: 'We received your application', body: 'x', sentAt: iso(),
    matchedJobId: job.id, matchConfidence: 0.9, matchSource: 'auto', category: 'application_confirmation' });
  const reply = { inReplyTo: '<globex-conf@globex.io>', from: 'recruiter@personal-mail.com', subject: 'Re:', body: 'hi', sentAt: iso() };
  const m = email.matchEmailToJob(reply, db.jobsForMatching());
  assert.equal(m.matchedJobId, job.id);
  assert.equal(m.via, 'reply-chain');
});

test('does NOT inherit from an unconfirmed (suggested) match — no bad-guess propagation down a thread', () => {
  const job = makeJob('Initech', 'QA Engineer');
  db.emailUpsert({ accountId: 'a1', uid: 3, messageId: '<sug@initech.com>', threadId: 'TH-S',
    from: 'hr@initech.com', subject: 'maybe', body: 'x', sentAt: iso(),
    matchedJobId: job.id, matchConfidence: 0.5, matchSource: 'suggested', category: 'other' });
  const reply = { threadId: 'TH-S', from: 'someone@gmail.com', subject: 'Re:', body: 'opaque', sentAt: iso() };
  const m = email.matchEmailToJob(reply, db.jobsForMatching());
  assert.notEqual(m.via, 'thread');
  assert.equal(m.matchedJobId, null, 'a suggested (unconfirmed) match is not trusted to seed a thread');
});

test('deterministic company match still works (no thread) — regression', () => {
  const job = makeJob('Wayne Enterprises', 'Platform Engineer');
  const e = { from: 'careers@wayne-enterprises.com', subject: 'Your application to Wayne Enterprises — Platform Engineer', body: 'received', sentAt: iso() };
  const m = email.matchEmailToJob(e, db.jobsForMatching());
  assert.equal(m.matchedJobId, job.id);
});

test("'assessment' is its own category + a forward pipeline stage (between contacted and interview)", () => {
  assert.equal(email.classify('Complete your online coding assessment', 'Please finish the HackerRank challenge.'), 'assessment');
  assert.equal(email.classify('Take-home exercise for the role', 'Codility link inside'), 'assessment');
  // a true interview invite is still 'interview', not 'assessment'
  assert.equal(email.classify('Phone screen with the hiring manager', 'pick a time'), 'interview');
  assert.equal(db.gmailStatusFromCategory('assessment'), 'assessment');
  assert.equal(db.gmailStatusFromCategory('interview'), 'interview_1');
  const r = email.classifyEmailReward('assessment');
  assert.ok(r.reward > 0 && r.reward < 0.7, 'assessment is positive but below interview');
});

test('AI disambiguation (pickEmailJob): picks the model index, respects confidence, never forces a match', async () => {
  const cands = [{ id: 'jA', company: 'Acme', title: 'SWE' }, { id: 'jB', company: 'Acme Labs', title: 'Backend' }];
  // confident pick of index 1 → that job
  const a = await email.aiPickJob({ from: 'x@acme.com', subject: 'Re:', body: '' }, cands, async () => ({ json: { index: 1, confidence: 0.9 } }));
  assert.equal(a.jobId, 'jB');
  // model says none (-1) → null (no forced link)
  const b = await email.aiPickJob({ from: 'x@acme.com' }, cands, async () => ({ json: { index: -1, confidence: 0.9 } }));
  assert.equal(b, null);
  // low confidence → null
  const c = await email.aiPickJob({ from: 'x@acme.com' }, cands, async () => ({ json: { index: 0, confidence: 0.4 } }));
  assert.equal(c, null);
  // a model/provider error degrades gracefully → null (never throws into the sync)
  const d = await email.aiPickJob({ from: 'x@acme.com' }, cands, async () => { throw new Error('provider down'); });
  assert.equal(d, null);
});

test('classification precedence: a LinkedIn "application was sent to X" is a confirmation, not an interview', () => {
  // The live bug: 240/300 of these were mis-tagged 'interview' because the body footer says
  // "interview tips" and interview was checked before application_confirmation.
  assert.equal(email.classify('pierre, your application was sent to Crossing Hurdles', 'Thanks! Here are some interview tips to help you prepare.'), 'application_confirmation');
  assert.equal(email.classify('Your application to Python Developer at Maxim', 'we received it'), 'application_confirmation');
  // bare "interview" in a newsletter/body must NOT classify as interview (no invite language)
  assert.equal(email.classify('Weekly digest: ace your next interview', 'top interview tips and tricks inside'), 'other');
  // a REAL interview invite still classifies as interview
  assert.equal(email.classify('Interview invitation — Software Engineer', 'please pick a time'), 'interview');
  assert.equal(email.classify('Next steps', "We'd like to schedule a call with you"), 'interview');
});

test('companyHints parses LinkedIn "application was sent to X" so confirmations can match a job', () => {
  const hints = email.companyHints({ from: 'jobs-noreply@linkedin.com', subject: 'pierre, your application was sent to Crossing Hurdles' });
  assert.ok(hints.some((h) => h.includes('crossing') || 'crossinghurdles'.includes(h)), `expected a Crossing Hurdles hint, got ${JSON.stringify(hints)}`);
});

test('email match ELEVATES the job stage (forward-only) so the pipeline reflects the inbox', () => {
  // a confirmation on a 'started' job → submitted
  const j1 = db.upsertJob({ externalId: 'el1', title: 'Dev', company: 'Stark Industries', source: 'linkedin', status: 'started', jobUrl: 'https://x/el1' }).job;
  const up1 = db.emailUpsert({ accountId: 'a1', uid: 901, from: 'jobs@stark.com', subject: 'Your application to Dev at Stark Industries', body: 'received', sentAt: iso(), matchedJobId: j1.id, matchConfidence: 0.9, matchSource: 'auto', category: 'application_confirmation' });
  assert.equal(db.elevateJobFromEmail(up1.id), 'submitted');
  assert.equal(db.getJob(j1.id).status, 'submitted');
  // an interview email → interview_1
  const j2 = db.upsertJob({ externalId: 'el2', title: 'Dev', company: 'Wayne Tech', source: 'linkedin', status: 'submitted', jobUrl: 'https://x/el2' }).job;
  const up2 = db.emailUpsert({ accountId: 'a1', uid: 902, from: 'hr@waynetech.com', subject: 'Interview invitation', body: 'lets schedule', sentAt: iso(), matchedJobId: j2.id, matchConfidence: 0.9, matchSource: 'auto', category: 'interview' });
  assert.equal(db.elevateJobFromEmail(up2.id), 'interview_1');
  // forward-only: a confirmation must NOT demote an interview-stage job
  const up3 = db.emailUpsert({ accountId: 'a1', uid: 903, from: 'jobs@waynetech.com', subject: 'Your application to Dev at Wayne Tech', body: 'x', sentAt: iso(), matchedJobId: j2.id, matchConfidence: 0.9, matchSource: 'auto', category: 'application_confirmation' });
  assert.equal(db.elevateJobFromEmail(up3.id), null);
  assert.equal(db.getJob(j2.id).status, 'interview_1');
  // terminal job is never touched
  const j4 = db.upsertJob({ externalId: 'el4', title: 'Dev', company: 'Oscorp', source: 'linkedin', status: 'rejected', jobUrl: 'https://x/el4' }).job;
  const up4 = db.emailUpsert({ accountId: 'a1', uid: 904, from: 'hr@oscorp.com', subject: 'Interview invitation at Oscorp', body: 'x', sentAt: iso(), matchedJobId: j4.id, matchConfidence: 0.9, matchSource: 'auto', category: 'interview' });
  assert.equal(db.elevateJobFromEmail(up4.id), null);
  assert.equal(db.getJob(j4.id).status, 'rejected');
});

test('associate() auto-creates a tracked submitted job from an unmatched confirmation', () => {
  const jobs = db.jobsForMatching();
  const before = jobs.length;
  const a = email.associate({ from: 'jobs-noreply@linkedin.com', subject: 'pierre, your application was sent to Nimbus Robotics Inc.', body: 'sent', sentAt: iso() }, jobs);
  assert.ok(a.matchedJobId, 'creates + links a job');
  assert.equal(a.via, 'auto-created');
  assert.equal(jobs.length, before + 1, 'pushed into the run job list (dedupes subsequent emails)');
  assert.equal(db.getJob(a.matchedJobId).status, 'submitted');
  assert.equal(db.getJob(a.matchedJobId).source, 'email');
  // a second confirmation for the SAME company+role dedupes to the same job (no duplicate)
  const b = email.associate({ from: 'x@y.com', subject: 'pierre, your application was sent to Nimbus Robotics Inc.', body: 'sent', sentAt: iso() }, jobs);
  assert.equal(b.matchedJobId, a.matchedJobId, 'deduped, not duplicated');
});

test('pickEmailJob prompt carries a strict schema and the none (-1) option', () => {
  const prompts = require(path.join(here, '..', 'app', 'src', 'ai', 'prompts.js'));
  const p = prompts.pickEmailJob({ email: { from: 'a@b.com', subject: 's', body: 'b' }, candidates: [{ company: 'C', title: 'T' }] });
  assert.equal(p.kind, 'pick-email-job');
  assert.deepEqual(p.schema.required, ['index', 'confidence', 'reason']);
  assert.match(p.prompt, /-1 \(none\)|index -1/i, 'instructs the model it may return none');
});
