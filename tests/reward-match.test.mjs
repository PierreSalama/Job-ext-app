// P6 (Apprenticeship Engine) — Reward Engine: lenient email→application match, confirm-and-
// train, confidence-weighted/clipped credit assignment. The north-star loop: an interview/
// offer reply matched to an application is the only signal that turns "we applied" into "this
// WORKED". This test drives the REAL path (email.matchEmailToJob + db.emailUpsert +
// db.creditOutcomeForEmail + db.confirmEmailLink) on a temp DB — no IMAP/Gmail network.
// createRequire harness mirrored from recipe-transfer.test.mjs.
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
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-reward-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

// A few days ago, so the email "arrives after the apply" inside the matcher's time window.
function daysAgoISO(n) { return new Date(Date.now() - n * 86400e3).toISOString(); }

// Create a submitted application (auto-distills a recipe) + seed its qa answers so credit can
// locate them. Returns the job.
function submittedApp({ company, jobUrl, answers, pid, submittedAt }) {
  const { job } = db.upsertJob(
    { title: 'Software Engineer', company, jobUrl, status: 'submitted', answers, source: 'greenhouse', submittedAt },
    { manual: true });
  for (const [q, a] of Object.entries(answers || {})) db.qaRecord({ profileId: pid, question: q, answer: a, source: 'greenhouse', lineageSource: 'manual' });
  return job;
}

// Upsert an email through the SAME match path the IMAP/Gmail sync uses; returns { id, assoc }.
let uidSeq = 0;
function ingest(parsed) {
  const jobs = db.jobsForMatching();
  const assoc = email.matchEmailToJob(parsed, jobs);
  const up = db.emailUpsert({ accountId: 'test', provider: 'imap', uid: ++uidSeq, ...parsed, ...assoc });
  return { id: up.id, assoc };
}

test('a recruiter reply whose sender-domain matches a recently-applied company links as auto', () => {
  const pid = db.ensureDefaultProfileId();
  submittedApp({
    company: 'Acme Robotics',
    jobUrl: 'https://boards.greenhouse.io/acmerobotics/jobs/123',
    answers: { 'Years of experience with Python': '5', 'Why do you want to work at Acme?': 'I love robots.' },
    pid, submittedAt: daysAgoISO(3),
  });

  // Sender domain (acmerobotics.com) matches the company name → strong sender-domain signal,
  // and an interview subject naming the company → a clear single winner.
  const { id, assoc } = ingest({
    from: 'recruiting@acmerobotics.com', fromName: 'Acme Talent',
    subject: 'Interview with Acme Robotics — Software Engineer',
    body: 'We would like to schedule a phone screen for the Software Engineer role.',
    sentAt: daysAgoISO(1),
  });

  assert.equal(assoc.matchSource, 'auto', 'sender-domain ↔ company + title + time window → auto');
  assert.ok(assoc.matchConfidence >= 0.7, `auto confidence is high (got ${assoc.matchConfidence})`);
  assert.equal(assoc.category, 'interview', 'classified as an interview invite');

  // Crediting an auto-linked interview reply writes a POSITIVE outcome.
  const r = db.creditOutcomeForEmail(id);
  assert.ok(r.ok, 'auto-linked, non-zero reward → credited');
  assert.ok(r.reward > 0, 'interview reply is a positive reward');
});

test('an ambiguous reply links as suggested and is NOT applied (no outcome row yet)', () => {
  const pid = db.ensureDefaultProfileId();
  // Two same-company applications with near-identical timing → the matcher cannot pick a clear
  // single winner, so the link is 'suggested' (held), not 'auto'.
  submittedApp({ company: 'Globex', jobUrl: 'https://boards.greenhouse.io/globex/jobs/1', answers: { 'Q': 'a' }, pid, submittedAt: daysAgoISO(4) });
  submittedApp({ company: 'Globex', jobUrl: 'https://boards.greenhouse.io/globex/jobs/2', answers: { 'Q': 'b' }, pid, submittedAt: daysAgoISO(4) });

  // A generic free-mail sender (no company domain, no title) → low score, two close cands.
  const { id, assoc } = ingest({
    from: 'someone@gmail.com', fromName: 'Globex',
    subject: 'A quick note from Globex',
    body: 'Thanks for your interest in Globex — a member of our team will be in touch.',
    sentAt: daysAgoISO(2),
  });

  assert.equal(assoc.matchSource, 'suggested', 'no clear single winner → suggested (held)');

  // Held: crediting a 'suggested' email is a no-op until confirmed; no ledger row is written.
  const r = db.creditOutcomeForEmail(id);
  assert.equal(r.ok, false, 'suggested reward is held');
  assert.equal(r.reason, 'held', 'reason is explicitly "held"');
  assert.equal(db.outcomesForJob(assoc.matchedJobId).length, 0, 'NO application_outcomes row yet for a suggested link');
});

test('confirming a suggested email flips it to manual, elevates status, trains, and credits', () => {
  const pid = db.ensureDefaultProfileId();
  const job = submittedApp({
    company: 'Initech',
    jobUrl: 'https://boards.greenhouse.io/initech/jobs/77',
    answers: { 'Years of experience with Go': '3', 'Why Initech?': 'Great mission.' },
    pid, submittedAt: daysAgoISO(100),   // long ago → a low time-window score keeps it 'suggested'
  });
  assert.equal(db.getJob(job.id).status, 'submitted', 'starts submitted');

  // Capture the credit targets' BEFORE state.
  const qaBefore = db.qaList(pid).filter((q) => /experience|initech/i.test(q.question));
  assert.ok(qaBefore.length >= 1, 'the application answers are in qa');
  const atsClass = db.classifyAts(job.jobUrl);
  const recipeBefore = db.getRecipe(pid, 'ats', atsClass.ats, null);
  assert.ok(recipeBefore, 'the submitted apply distilled an ATS recipe to credit');
  const recipeRewardBefore = recipeBefore.rewardScore || 0;

  // An interview email that is only borderline (free-mail sender, no title in subject, and the
  // apply was long ago → a low time-window score) → suggested, not auto.
  const { id, assoc } = ingest({
    from: 'talent@gmail.com', fromName: 'Initech',
    subject: 'Interview with Initech',
    body: 'We were impressed and would like to schedule an interview to meet the team.',
    sentAt: daysAgoISO(1),
  });
  assert.equal(assoc.matchSource, 'suggested', 'borderline interview → suggested');

  // It shows up in the confirm-this-link inbox with its candidate job.
  const inbox = db.emailsNeedingConfirm(pid);
  assert.ok(inbox.some((e) => e.id === id && e.candidate && e.candidate.id === job.id), 'surfaces in the confirm inbox with a candidate');

  const trainingBefore = (db.kvGet('matchTraining') || []).length;

  // CONFIRM → manual + forward elevation + training example + released reward.
  const res = db.confirmEmailLink(id, { confirm: true });
  assert.ok(res.ok, 'confirm succeeds');
  assert.equal(res.email.matchSource, 'manual', 'flipped suggested → manual');

  // Status elevated forward (submitted → interview_1) by the confirmed interview email.
  assert.equal(db.getJob(job.id).status, 'interview_1', 'confirm applied the forward-only status elevation');

  // A labeled training example was persisted.
  const trainingAfter = db.kvGet('matchTraining') || [];
  assert.equal(trainingAfter.length, trainingBefore + 1, 'a training example was stored');
  assert.equal(trainingAfter[trainingAfter.length - 1].decision, 'confirm', 'it is a positive (confirm) example');

  // A POSITIVE outcome row now exists, and the credited qa + recipe got their reward bumped.
  const outcomes = db.outcomesForJob(job.id);
  assert.equal(outcomes.length, 1, 'exactly one outcome row written on confirm');
  const o = outcomes[0];
  assert.ok(o.reward > 0, 'positive reward released');
  assert.ok(o.credited.qa_ids.length >= 1, 'credit fanned to the application answers');
  assert.ok(o.credited.recipe_ids.length >= 1, 'credit fanned to the recipe used');

  // The actual qa.reward_score moved.
  const qaAfter = db.qaList(pid).filter((q) => qaBefore.some((b) => b.id === q.id));
  assert.ok(qaAfter.some((q) => (q.reward_score || 0) > 0), 'a credited answer reward_score increased');

  // The recipe reward_score moved.
  const recipeAfter = db.getRecipe(pid, 'ats', atsClass.ats, null);
  assert.ok((recipeAfter.rewardScore || 0) > recipeRewardBefore, 'the credited recipe reward_score increased');
});

test('a rejection writes a MILD-NEGATIVE outcome that does NOT dock recipe/answer reward (fit-only)', () => {
  const pid = db.ensureDefaultProfileId();
  const job = submittedApp({
    company: 'Umbrella Corp',
    jobUrl: 'https://boards.greenhouse.io/umbrella/jobs/9',
    answers: { 'Years of experience with Rust': '2' },
    pid, submittedAt: daysAgoISO(3),
  });

  const atsClass = db.classifyAts(job.jobUrl);
  const recipe = db.getRecipe(pid, 'ats', atsClass.ats, null);
  const recipeRewardBefore = recipe.rewardScore || 0;
  const qaBefore = db.qaList(pid).filter((q) => /rust/i.test(q.question));
  const qaRewardBefore = (qaBefore[0]?.reward_score) || 0;

  // A rejection from the company's own domain → auto-link.
  const { id, assoc } = ingest({
    from: 'noreply@umbrellacorp.com', fromName: 'Umbrella Corp Recruiting',
    subject: 'Your application to Umbrella Corp — Software Engineer',
    body: 'Unfortunately we have decided to move forward with other candidates at this time.',
    sentAt: daysAgoISO(1),
  });
  assert.equal(assoc.category, 'rejection', 'classified as a rejection');
  assert.equal(assoc.matchSource, 'auto', 'company-domain rejection links auto');

  const r = db.creditOutcomeForEmail(id);
  assert.ok(r.ok, 'a linked rejection writes an outcome');
  assert.ok(r.reward < 0, 'rejection is a mild-negative outcome');

  const outcomes = db.outcomesForJob(job.id);
  const rej = outcomes.find((o) => o.rewardKind === 'rejection');
  assert.ok(rej, 'a rejection-kind outcome row exists');
  assert.equal(rej.credited.recipe_ids.length, 0, 'rejection fans NO mechanical recipe credit');
  assert.equal(rej.credited.qa_ids.length, 0, 'rejection fans NO mechanical answer credit');

  // The mechanical credit is preserved: the application WORKED, rejection only feeds fit-rank.
  const recipeAfter = db.getRecipe(pid, 'ats', atsClass.ats, null);
  assert.equal(recipeAfter.rewardScore || 0, recipeRewardBefore, 'the recipe reward_score is UNCHANGED by the rejection');
  const qaAfter = db.qaList(pid).filter((q) => qaBefore.some((b) => b.id === q.id));
  assert.equal((qaAfter[0]?.reward_score) || 0, qaRewardBefore, 'the answer reward_score is UNCHANGED by the rejection');
});

test('credit is fractional, confidence-weighted, and clipped to [-1, 1]', () => {
  const pid = db.ensureDefaultProfileId();
  const job = submittedApp({
    company: 'Hooli',
    jobUrl: 'https://boards.greenhouse.io/hooli/jobs/42',
    answers: { 'Years of experience with Java': '8' },
    pid, submittedAt: daysAgoISO(2),
  });

  // An OFFER (base reward 1.0) from the company's own domain → highest-confidence auto link.
  const { id, assoc } = ingest({
    from: 'offers@hooli.com', fromName: 'Hooli',
    subject: 'Job offer from Hooli — Software Engineer',
    body: 'We are pleased to offer you the position. Congratulations!',
    sentAt: daysAgoISO(0.5),
  });
  assert.equal(assoc.category, 'offer', 'classified as an offer');

  const r = db.creditOutcomeForEmail(id);
  assert.ok(r.ok, 'offer credited');
  // effectiveReward = base(1.0) * matchConfidence(<=0.96) → strictly inside (0,1], never >1.
  assert.ok(r.reward > 0 && r.reward <= 1, `clipped/weighted into (0,1] (got ${r.reward})`);
  assert.ok(r.reward < 1.0, 'confidence-weighting makes it fractional (< the raw 1.0 base)');

  for (const o of db.outcomesForJob(job.id)) {
    assert.ok(o.reward >= -1 && o.reward <= 1, `every ledger reward is clipped to [-1,1] (got ${o.reward})`);
  }

  // Direct recordOutcome with an out-of-range reward is clipped too (the guardrail).
  const out = db.recordOutcome({ jobId: job.id, profileId: pid, reward: 5, rewardKind: 'star' });
  assert.equal(out.reward, 1, 'an over-range positive reward is clipped to 1');
  const outNeg = db.recordOutcome({ jobId: job.id, profileId: pid, reward: -5, rewardKind: 'punish' });
  assert.equal(outNeg.reward, -1, 'an over-range negative reward is clipped to -1');
});
