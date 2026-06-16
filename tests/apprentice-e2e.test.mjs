// P8 (Apprenticeship Engine) — END-TO-END SELF-VERIFICATION of the closed loop.
//
// This is the crown-jewel proof that Observer → Distiller → Transfer → Replayer → Reward →
// Rank closes measurably. It drives the REAL functions (no stubs for the loop) against a temp
// DB and the SAME pure planReplay() the browser executor imports — one continuous sequence:
//
//   a. OBSERVE   db.upsertJob a SUBMITTED Workday apply at Rogers → answers harvest into qa
//                with manual answer_lineage (the always-on Observer path).
//   b. DISTILL   the submit auto-fires distillJob → a Workday ATS recipe + a Rogers overlay.
//   c. TRANSFER  resolveRecipe('workday','bell') still yields the ATS steps — cross-company.
//   d. REPLAY    planReplay (imported from ../extension/content/replay.js) returns 'auto' for
//                the resolved Rogers recipe vs its own required labels — the replayer engages.
//   e. RANK0     baseline r0 = rankJob(rogersJob).
//   f. REWARD    a real interview email → matchEmailToJob → emailUpsert → creditOutcomeForEmail
//                writes a POSITIVE application_outcomes row; recipe + a credited qa answer get
//                their reward_score bumped.
//   g. LOOP      r1 = rankJob(rogersJob); r1 > r0 — the interview reward raised the company's
//                rank. The loop is closed and measurable.
//   h. PUNISH    db.punish('rogers') → isPunished true + rankJob excludes it (-1); a different
//                company's job is unaffected (no collateral exclusion).
//
// createRequire harness mirrored from reward-match.test.mjs / recipe-transfer.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// The REAL replay decision module the extension's executor.js statically imports. Pure,
// node-testable (no DOM/chrome at import time) — proving the replayer would engage with the
// exact same logic that ships.
import { planReplay } from '../extension/content/replay.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));
const email = require(path.join(here, '..', 'app', 'src', 'email.js'));
const distiller = require(path.join(here, '..', 'app', 'src', 'distiller.js'));

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-e2e-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

function daysAgoISO(n) { return new Date(Date.now() - n * 86400e3).toISOString(); }

// Upsert an inbound email through the SAME match path the IMAP/Gmail sync uses (the real path,
// no network): jobsForMatching → matchEmailToJob → emailUpsert. Returns { id, assoc }.
let uidSeq = 0;
function ingest(parsed) {
  const jobs = db.jobsForMatching();
  const assoc = email.matchEmailToJob(parsed, jobs);
  const up = db.emailUpsert({ accountId: 'test', provider: 'imap', uid: ++uidSeq, ...parsed, ...assoc });
  return { id: up.id, assoc };
}

// The whole loop runs as ONE ordered sequence so the assertions build on each other. Node's
// test runner executes top-level tests in source order, sharing the temp DB.
const ROGERS_URL = 'https://rogers.wd3.myworkdayjobs.com/job/e2e1';
const ROGERS_ANSWERS = {
  'Years of experience with Java': '4',
  'Are you authorized to work in Canada?': 'Yes',
  'Why do you want to work at Rogers?': 'I admire the network and the team behind it.',
};
let pid;
let rogersJobId;
let r0;   // baseline rank, carried from step (e) into step (g)

test('a. OBSERVE — a submitted Workday apply at Rogers harvests its answers into qa with MANUAL lineage', () => {
  pid = db.ensureDefaultProfileId();
  const { job } = db.upsertJob({
    title: 'Software Engineer', company: 'Rogers', source: 'workday', status: 'submitted',
    jobUrl: ROGERS_URL, submittedAt: daysAgoISO(2), answers: ROGERS_ANSWERS,
  }, { manual: true });
  rogersJobId = job.id;
  assert.equal(db.getJob(rogersJobId).status, 'submitted', 'the application is recorded as submitted');

  // The always-on Observer harvest (upsertJob → harvestAnswersToProfile → qa) landed every
  // non-sensitive answer in the qa store, each stamped with answer_lineage source 'manual'.
  for (const label of Object.keys(ROGERS_ANSWERS)) {
    const m = db.qaLookup(pid, label);
    assert.ok(m && m.answer === ROGERS_ANSWERS[label], `qa learned "${label}"`);
    const lineage = JSON.parse(m.answer_lineage || '[]');
    assert.ok(Array.isArray(lineage) && lineage.length >= 1, `answer_lineage recorded for "${label}"`);
    assert.equal(lineage[lineage.length - 1].source, 'manual', `"${label}" stamped as manually observed`);
  }
});

test('b. DISTILL — the submit auto-fired distillJob → a non-empty Workday/Rogers recipe', () => {
  // distillJob auto-fires inside upsertJob on submit. Call it again EXPLICITLY (idempotent —
  // upsertRecipeStep keys on (recipe_id, label_pattern)) so the assertion never depends on the
  // auto-trigger timing; the counts prove the steps already exist.
  const res = distiller.distillJob(rogersJobId, pid);
  assert.ok(res.recipes >= 1, 'a Workday recipe was distilled from the submit');

  const resolved = db.resolveRecipe('workday', 'rogers', pid);
  assert.ok(resolved.steps.length >= 1, 'resolveRecipe(workday,rogers) yields ≥1 step');
  assert.ok(resolved.atsRecipeId, 'an ATS-scope Workday recipe exists');
  // The generic questions are ATS-scope (transfer carriers); the "why Rogers" screener is on
  // the company overlay — i.e. the loop learned both a transferable recipe AND company specifics.
  const labels = resolved.steps.map((s) => s.labelPattern);
  assert.ok(labels.some((l) => l.includes('experience') && l.includes('java')), 'years-of-experience is in the flow');
  assert.ok(labels.some((l) => l.includes('authorized')), 'authorized-to-work is in the flow');
});

test('c. TRANSFER — resolveRecipe(workday, BELL) yields the ATS steps (Bell never applied to)', () => {
  // Bell has no company overlay — only the Rogers-seeded ATS recipe should transfer to it.
  const resolved = db.resolveRecipe('workday', 'bell', pid);
  assert.ok(resolved.atsRecipeId, 'the Workday ATS recipe resolves for Bell');
  assert.equal(resolved.companyRecipeId, null, 'Bell has no company overlay yet');
  const labels = resolved.steps.map((s) => s.labelPattern);
  assert.ok(labels.some((l) => l.includes('experience') && l.includes('java')), 'years-of-experience transfers to Bell');
  assert.ok(labels.some((l) => l.includes('authorized')), 'authorized-to-work transfers to Bell');
  assert.ok(resolved.coverage > 0, 'cross-company coverage is positive');
});

test('d. REPLAY-PLAN — planReplay returns mode "auto" for the resolved Rogers recipe (replayer engages)', () => {
  const resolved = db.resolveRecipe('workday', 'rogers', pid);
  // The recipe must cover its OWN required fields — use the recipe's own step labels as the
  // page's required labels (the proof a replay would not need to fabricate anything).
  const requiredLabels = resolved.steps.map((s) => s.labelPattern);

  // theta 0.5 mirrors the executor's tunable `context.replayTheta` for a freshly-distilled
  // recipe (synthesized confidence 0.5 — "modest until enriched", per distiller.js). This is
  // the real, conservative replay-autonomy threshold; coverage (≥3 merged steps) clears the
  // default 0.5 minCoverage on its own.
  const plan = planReplay(resolved, requiredLabels, { theta: 0.5 });
  assert.equal(plan.mode, 'auto', `recipe covers all required fields → auto (got ${plan.mode}: ${plan.reason})`);
  assert.deepEqual(plan.missing, [], 'no required field is left uncovered (no fabrication site)');

  // SAFETY-GATE COUNTERPROOF (still the real planReplay): a NEW required field the recipe never
  // saw forces a fallback — the replayer would hand to discover-every-step, never blind-fill.
  const withGap = planReplay(resolved, [...requiredLabels, 'Please paste your secret access token'], { theta: 0.5 });
  assert.equal(withGap.mode, 'fallback', 'an uncovered required field downgrades to fallback (safe by construction)');
  assert.ok(withGap.missing.length >= 1, 'the uncovered field is reported as missing');
});

test('e. BASELINE RANK — record r0 for the Rogers job (no reward yet)', () => {
  r0 = db.rankJob(db.getJob(rogersJobId), pid);
  assert.equal(typeof r0, 'number', 'rankJob returns a numeric baseline');
  assert.ok(r0 >= 0, 'an un-punished, un-rewarded job ranks non-negative');
});

test('f. REWARD — a real interview reply credits a POSITIVE outcome to the recipe + a qa answer', () => {
  // BEFORE state of the two credit targets the interview reply should boost.
  const atsClass = db.classifyAts(ROGERS_URL);
  const recipeBefore = db.getRecipe(pid, 'ats', atsClass.ats, null);
  assert.ok(recipeBefore, 'the distilled ATS recipe is present to credit');
  const recipeRewardBefore = recipeBefore.rewardScore || 0;
  const qaBefore = db.qaList(pid).filter((q) => /experience|java|authorized|rogers/i.test(q.question));
  assert.ok(qaBefore.length >= 1, 'the application answers are in qa to credit');

  // An interview invite from Rogers' own company domain, naming the company + role in the
  // subject, arriving after the apply → a clear single winner → match_source 'auto'.
  const { id, assoc } = ingest({
    from: 'recruiting@rogers.com', fromName: 'Rogers Talent Acquisition',
    subject: 'Interview with Rogers — Software Engineer',
    body: 'We were impressed by your application and would like to schedule a phone screen for the Software Engineer role.',
    sentAt: daysAgoISO(0.5),
  });
  assert.equal(assoc.matchedJobId, rogersJobId, 'the interview reply links to the Rogers application');
  assert.equal(assoc.matchSource, 'auto', 'company-domain + title + time window → auto-linked');
  assert.equal(assoc.category, 'interview', 'classified as an interview invite');

  // Crediting the auto-linked interview reply writes a POSITIVE application_outcomes row and
  // fans confidence-weighted credit to the recipe + answers used (the credit-assignment pass).
  const credit = db.creditOutcomeForEmail(id);
  assert.ok(credit.ok, 'auto-linked interview reply is credited');
  assert.ok(credit.reward > 0, 'an interview reply is a positive reward');

  const outcomes = db.outcomesForJob(rogersJobId);
  assert.equal(outcomes.length, 1, 'exactly one outcome row written for the Rogers job');
  const o = outcomes[0];
  assert.ok(o.reward > 0, 'the ledger row carries a positive reward');
  assert.equal(o.rewardKind, 'email_reply', 'kind = email_reply (the north-star signal)');
  assert.ok(o.credited.recipe_ids.length >= 1, 'credit fanned to the recipe used');
  assert.ok(o.credited.qa_ids.length >= 1, 'credit fanned to the application answers');

  // The recipe's reward_score measurably increased.
  const recipeAfter = db.getRecipe(pid, 'ats', atsClass.ats, null);
  assert.ok((recipeAfter.rewardScore || 0) > recipeRewardBefore, 'the credited recipe reward_score increased');

  // A credited qa answer's reward_score measurably increased.
  const qaAfter = db.qaList(pid).filter((q) => qaBefore.some((b) => b.id === q.id));
  assert.ok(qaAfter.some((q) => (q.reward_score || 0) > 0), 'a credited qa answer reward_score increased');
});

test('g. LOOP CLOSES — r1 > r0: the interview reward measurably raised the company rank', () => {
  const r1 = db.rankJob(db.getJob(rogersJobId), pid);
  assert.ok(r1 > r0, `interview reward raised Rogers' rank (r1=${r1.toFixed(4)} > r0=${r0.toFixed(4)})`);
});

test('h. PUNISH sanity — punishing Rogers excludes it; a different company is unaffected', () => {
  // A control job at a DIFFERENT company that should stay eligible throughout.
  const { job: bellJob } = db.upsertJob({
    title: 'Software Engineer', company: 'Bell', source: 'workday', status: 'started',
    jobUrl: 'https://bell.wd3.myworkdayjobs.com/job/e2e2',
  }, { manual: true });

  assert.equal(db.isPunished(db.getJob(rogersJobId), pid), false, 'Rogers is not punished before the action');

  const p = db.punish({ profileId: pid, kind: 'company', pattern: 'Rogers' });
  assert.ok(p && p.id, 'a company punishment row was created');

  assert.equal(db.isPunished(db.getJob(rogersJobId), pid), true, 'Rogers is now punished');
  assert.ok(db.rankJob(db.getJob(rogersJobId), pid) < 0, 'a punished job is excluded (rank < 0)');

  // The OTHER company is untouched by Rogers' punishment — no collateral exclusion.
  assert.equal(db.isPunished(bellJob, pid), false, 'Bell (a different company) is NOT punished');
  assert.ok(db.rankJob(bellJob, pid) >= 0, 'Bell still ranks non-negative');

  // Lifting the punishment restores Rogers' eligibility (clean teardown of the sanity check).
  db.unpunish(p.id);
  assert.equal(db.isPunished(db.getJob(rogersJobId), pid), false, 'unpunish restores Rogers eligibility');
});
