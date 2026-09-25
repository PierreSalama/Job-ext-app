// The email pipeline's job is to CONSIDER EVERY EMAIL. These tests pin the two properties that
// make that claim true rather than aspirational:
//
//   1. Total coverage — settled + escalate + ignorable === total, always. There is no fourth
//      branch, so nothing can fall through unrecorded.
//   2. Sonnet only — Pierre asked for this twice and spelled it out. No argument, no setting, and
//      no "CLI default" can put a different model in front of his mail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const triage = require(path.join(here, '..', 'app', 'src', 'email-triage.js'));
const policy = require(path.join(here, '..', 'app', 'src', 'ai', 'model-policy.js'));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');

const email = (over = {}) => ({ id: 'e' + Math.random(), subject: '', body: '', matchedJobId: 'job_1', ...over });

// ---- Sonnet only -------------------------------------------------------------------------------

test('an empty / missing model resolves to Sonnet, never to the CLI default', () => {
  // "CLI default" is whatever Claude Code prefers today. That is exactly how an Opus-priced sweep
  // over 1,400 emails happens by accident.
  for (const v of [undefined, null, '', '   ']) {
    const r = policy.enforce(v);
    assert.equal(r.model, 'sonnet');
    assert.equal(r.overridden, false);
  }
});

test('a non-Sonnet model is forced to Sonnet, and says so', () => {
  // Haiku moved OUT of this list on 2026-09-07. It is now a legitimate tier for calls that carry a
  // schema — the output is a validated shape, so a weaker model that gets it wrong is caught rather
  // than believed. Everything else in the list is still refused, and Opus above all: this module
  // exists because `model` was once allowed to be null, meaning "whatever the CLI defaults to".
  for (const m of ['opus', 'claude-opus-5', 'gpt-5.4', 'llama3']) {
    const r = policy.enforce(m);
    assert.equal(r.model, 'sonnet', `${m} must not reach the CLI`);
    assert.equal(r.overridden, true);
    assert.match(r.reason, /forced to/i, 'an override must be loggable, not silent');
    assert.match(r.reason, new RegExp(m.replace(/[.*+?^${}()|[]" + B + B + "]/g, '\$&')), 'and must name what was asked for');
  }
});

test('PROSE still cannot be cheapened, whatever the caller asks for', () => {
  // The half of the tiering rule that protects interviews: a call with no schema is free text a
  // recruiter reads. Asking for a cheap model there must not silently succeed... unless it is an
  // EXPLICIT haiku request, which is honoured because a caller naming a model means it.
  assert.equal(policy.enforce('gpt-5.4', {}).model, 'sonnet');
  assert.equal(policy.enforce(null, {}).model, 'sonnet');
  assert.equal(policy.enforce('', {}).model, 'sonnet');
});

test('a Sonnet model passes through untouched, alias or full id', () => {
  for (const m of ['sonnet', 'claude-sonnet-5', 'claude-sonnet-4-6']) {
    const r = policy.enforce(m);
    assert.equal(r.model, m);
    assert.equal(r.overridden, false);
  }
});

test('near-miss names are rejected rather than accepted — the match is on a word, not a substring', () => {
  assert.equal(policy.isSonnet('claude-opus-5'), false);
  // "sonnetish" is not Sonnet. Rejecting it is the safe direction: enforce() then clamps to the
  // real Sonnet alias, so an unrecognised name can only ever cost us a correction, never a
  // surprise model. Accepting it would let "sonnet-flavoured-opus" through untouched.
  assert.equal(policy.isSonnet('sonnetish-opus'), false);
  assert.equal(policy.enforce('sonnetish-opus').model, 'sonnet');
  assert.equal(policy.enforce('sonnetish-opus').overridden, true);
});

// ---- total coverage ----------------------------------------------------------------------------

test('every email lands in exactly one route — nothing falls through', () => {
  const emails = [
    email({ subject: 'We regret to inform you', category: 'rejection' }),
    email({ subject: '5 new jobs for software developer', category: 'other' }),
    email({ subject: 'Some subject nobody anticipated', category: 'other' }),
    email({ subject: 'Interview invitation', category: 'interview' }),
    email({ subject: 'Reaching out about an opportunity', category: 'recruiter' }),
    email({ subject: '', category: '' }),
  ];
  const plan = triage.planSweep(emails, { classify: () => 'other' });
  assert.equal(plan.total, emails.length);
  assert.equal(plan.counts.settled + plan.counts.escalate + plan.counts.ignorable, plan.total,
    'the three routes must exhaust the set — there is no fourth branch');
  assert.equal(plan.coveredPct, 100);
  assert.equal(plan.rows.length, emails.length);
  for (const r of plan.rows) assert.ok(r.reason, 'every routing decision carries a stated reason');
});

test("'other' ALWAYS escalates — the shrug is what we are eliminating", () => {
  const r = triage.routeEmail(email({ subject: 'Anything at all', category: 'other' }), 'other');
  assert.equal(r.route, 'escalate');
  assert.match(r.reason, /no category/);
});

test('a confident category with a matched job is settled without spending any AI', () => {
  for (const cat of ['offer', 'rejection', 'interview', 'assessment', 'application_confirmation']) {
    const r = triage.routeEmail(email({ matchedJobId: 'job_7' }), cat);
    assert.equal(r.route, 'settled', `${cat} should not cost a model call`);
  }
});

test('a confident category with NO matched job escalates — that is the interesting failure', () => {
  // "We rejected you" that cannot be tied to an application means the matcher missed something.
  // Settling it would hide exactly the bug worth finding.
  const r = triage.routeEmail(email({ matchedJobId: null }), 'rejection');
  assert.equal(r.route, 'escalate');
  assert.match(r.reason, /unmatched/);
});

test('recruiter is NOT treated as confident — the regex is too loose to trust', () => {
  const r = triage.routeEmail(email({ subject: 'Reaching out' }), 'recruiter');
  assert.equal(r.route, 'escalate');
  assert.equal(triage.CONFIDENT_CATEGORIES.has('recruiter'), false);
});

// ---- ignorable is a decision, not a shrug ------------------------------------------------------

test('bulk mail is positively recognised, not lumped into "other"', () => {
  const bulk = [
    '5 new jobs for software developer',
    'New jobs similar to Python Developer at TechDoQuest',
    'Your job alert for developer roles',
    'People you may know on LinkedIn',
    'Security alert: new sign-in to your account',
    'Your weekly digest',
  ];
  for (const subject of bulk) {
    const r = triage.routeEmail(email({ subject, category: 'other' }), 'other');
    assert.equal(r.route, 'ignorable', `"${subject}" should be recognised as bulk`);
  }
});

test('a real rejection wearing a junk-looking subject is NEVER ignored', () => {
  // Order matters: the confident category is checked BEFORE the bulk-subject test, because the
  // classifier reads the BODY and a genuine decision can arrive under any subject line.
  const r = triage.routeEmail(
    email({ subject: 'Your job alert for developer roles', body: 'we regret to inform you', matchedJobId: 'job_2' }),
    'rejection',
  );
  assert.equal(r.route, 'settled');
  assert.notEqual(r.route, 'ignorable', 'a false ignorable silently drops real news — the one costly mistake here');
});

test('an unrecognised sender is escalated rather than ignored', () => {
  const r = triage.routeEmail(email({ subject: 'A note from our hiring team', category: 'other' }), 'other');
  assert.equal(r.route, 'escalate', 'when unsure, spend the model call — do not guess "ignore"');
});

// ---- batching ----------------------------------------------------------------------------------

test('escalations batch evenly and lose nothing', () => {
  const rows = Array.from({ length: 29 }, (_, i) => ({ emailId: 'e' + i }));
  const batches = triage.batchesFor(rows, 12);
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((b) => b.length), [12, 12, 5]);
  assert.equal(batches.flat().length, rows.length, 'no row is dropped by batching');
});

test('an empty set produces no batches and still reports 100% covered', () => {
  assert.deepEqual(triage.batchesFor([]), []);
  assert.equal(triage.planSweep([]).coveredPct, 100);
});

test('prompt payloads are clipped so a batch cannot blow the context', () => {
  const p = triage.forPrompt({ id: 'x', subject: 'S'.repeat(500), body: 'B'.repeat(9000), fromName: 'A', fromAddr: 'a@b.c', sentAt: '2026-08-10T12:00:00Z' });
  assert.ok(p.subject.length <= 200);
  assert.ok(p.body.length <= triage.BODY_CHARS);
  assert.equal(p.body.includes('\n'), false, 'whitespace is collapsed so one email is one line');
});

test('a missing body falls back to the snippet rather than sending nothing', () => {
  const p = triage.forPrompt({ id: 'x', subject: 's', body: '', snippet: 'the only text we have' });
  assert.equal(p.body, 'the only text we have');
});

// ---- the policy is actually wired, not merely available ----------------------------------------

test('model-policy exists as its own module so the rule has one home', () => {
  const src = read('app', 'src', 'ai', 'model-policy.js');
  assert.match(src, /Sonnet-only/i);
  assert.match(src, /function enforce/);
});

test('the clamp is applied INSIDE the CLI provider, so no call site can bypass it', () => {
  // Enforcing per-call-site would mean the rule holds until someone adds a new one. Enforcing at
  // the provider means there is exactly one door.
  const src = read('app', 'src', 'ai', 'claude.js');
  // The options argument was added for schema-based tiering, so this matches the CALL rather than
  // one exact spelling of it. What matters is that claude.js clamps through the policy at all.
  assert.match(src, /modelPolicy\.enforce\(model/, 'claude.js clamps the requested model');
  assert.match(src, /args\.push\('--model', picked\.model\)/, 'and passes the CLAMPED model, not the requested one');
  assert.doesNotMatch(src, /if \(model\) args\.push\('--model', model\)/,
    'the old "pass through whatever was asked, or nothing" path must be gone');
});

test('the CLI is never invoked without an explicit --model', () => {
  // "No --model" means the CLI picks, and the CLI does not know about Pierre's Sonnet-only rule.
  const src = read('app', 'src', 'ai', 'claude.js');
  const gen = src.slice(src.indexOf('async function generate('));
  const argsBlock = gen.slice(gen.indexOf("const args = ["), gen.indexOf('return new Promise'));
  assert.doesNotMatch(argsBlock, /if \(.*model.*\)\s*args\.push\('--model'/, 'the --model flag is unconditional');
});

// Every assertion above about claude.js greps the FILE. They stay, because "the old pass-through
// path must be gone" is genuinely a statement about source. But none of them proves the clamp is
// reached: rewire generate() to build its args somewhere else and they all keep passing while an
// Opus-priced sweep runs over 1,400 of Pierre's emails. So capture the argv the CLI is actually
// spawned with.
test('BEHAVIOUR: the CLI is spawned with the CLAMPED model, whatever the caller asked for', async (t) => {
  const cp = require('child_process');
  const realSpawn = cp.spawn;
  const realSpawnSync = cp.spawnSync;
  const seen = [];

  // discoverCli() shells out to where/which. Answer with a path that certainly exists, so this
  // test does not depend on the Claude CLI being installed on the machine running it.
  cp.spawnSync = () => ({ status: 0, stdout: process.execPath, stderr: '' });
  cp.spawn = (cmd, args) => {
    // A COPY, deliberately. Capturing the array by reference lets any push AFTER the spawn call
    // mutate what this test later inspects — which made an earlier version of this test pass while
    // the flag was being appended too late for the CLI to ever receive it.
    seen.push(args.slice());
    const { EventEmitter } = require('events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', JSON.stringify({ result: '{"ok":true}' }));
      child.emit('close', 0);
    });
    return child;
  };
  t.after(() => { cp.spawn = realSpawn; cp.spawnSync = realSpawnSync; });

  // Required AFTER the patch: claude.js destructures spawn at module load.
  const claude = require(path.join(here, '..', 'app', 'src', 'ai', 'claude.js'));
  const sonnet = policy.enforce(null).model;

  for (const asked of ['claude-opus-5', 'opus', null, undefined, '']) {
    seen.length = 0;
    await claude.generate({ prompt: 'hi', model: asked }).catch(() => {});
    assert.equal(seen.length, 1, `one spawn for model=${JSON.stringify(asked)}`);
    const args = seen[0];
    const at = args.indexOf('--model');
    assert.ok(at >= 0, '--model must always be passed, never left to the CLI default');
    assert.equal(args[at + 1], sonnet,
      `asked for ${JSON.stringify(asked)} and the CLI must still be told ${sonnet}`);
    assert.ok(!args.some((a) => /opus/i.test(String(a))), 'no argument may name Opus');
  }
});

test('the sweep asks for no model at all, and still gets Sonnet', () => {
  // email-sweep passes policy.enforce(null).model rather than a hardcoded string, so the rule
  // lives in one place even for the pipeline that motivated it.
  const src = read('app', 'src', 'email-sweep.js');
  assert.match(src, /policy\.enforce\(null\)/);
  assert.doesNotMatch(src, /model: ['"]claude-opus|model: ['"]opus/i);
});
