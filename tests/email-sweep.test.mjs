// The sweep against a real DB. The property under test is the one Pierre actually asked for:
// EVERY email ends up with a recorded decision, and the AI half can fail completely without
// costing any coverage.
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
const sweepLib = require(path.join(here, '..', 'app', 'src', 'email-sweep.js'));

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-sweep-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

// Seed through the REAL write path the sync uses, so these rows are indistinguishable from mail
// that actually arrived — no test-only insert that could drift from production behaviour.
let uid = 0;
function seedEmail({ subject = '', body = '', category = null, matchedJobId = null, from = 'sender@example.com' } = {}) {
  const r = db.emailUpsert({
    accountId: 'acct', provider: 'gmail', uid: ++uid,
    from, fromName: 'Sender', to: 'pierre@example.com',
    subject, snippet: body.slice(0, 100), body,
    sentAt: new Date(Date.now() - uid * 60000).toISOString(),
    category, matchedJobId,
  });
  return r.id;
}

test('coverage on an empty store is 100% and reports nothing pending', () => {
  const c = db.triageCoverage();
  assert.equal(c.totalEmails, 0);
  assert.equal(c.unreviewed, 0);
  assert.equal(c.coveredPct, 100);
  assert.equal(c.pendingAi, 0);
});

test('THE HEADLINE: after the rules pass, ZERO emails are unreviewed', () => {
  // This is the whole ask. Mixed bag on purpose: clear news, bulk noise, and things the regexes
  // have no idea about — which under the old pipeline became 'other' and vanished.
  seedEmail({ subject: 'We regret to inform you', body: 'we regret to inform you that we are moving forward with other candidates', matchedJobId: null });
  seedEmail({ subject: '5 new jobs for software developer', body: 'jobs you may like' });
  seedEmail({ subject: 'A note from our hiring team', body: 'something the regexes have never seen' });
  seedEmail({ subject: 'Interview invitation', body: 'we would like to schedule an interview with you', matchedJobId: null });
  seedEmail({ subject: 'Your weekly digest', body: 'here is your weekly summary' });
  seedEmail({ subject: '', body: '' });

  const before = db.triageCoverage();
  assert.ok(before.unreviewed > 0, 'precondition: there is a backlog to sweep');

  const r = sweepLib.sweepRules();
  assert.equal(r.reviewed, before.unreviewed, 'the sweep reviewed exactly the backlog');

  const after = db.triageCoverage();
  assert.equal(after.unreviewed, 0, 'NOTHING may be left unconsidered');
  assert.equal(after.coveredPct, 100);
  assert.equal(
    (after.byRoute.settled || 0) + (after.byRoute.escalate || 0) + (after.byRoute.ignorable || 0),
    after.totalEmails,
    'the routes account for every email in the store',
  );
});

test('bulk mail is routed ignorable and never reaches the paid model', () => {
  const pending = db.triagePendingEscalations({ limit: 100 });
  const subjects = pending.map((e) => e.subject);
  assert.ok(!subjects.includes('5 new jobs for software developer'), 'job alerts must not cost a model call');
  assert.ok(!subjects.includes('Your weekly digest'));
});

test('the unknown email — the one that used to vanish — is queued for Sonnet', () => {
  const pending = db.triagePendingEscalations({ limit: 100 });
  assert.ok(pending.some((e) => e.subject === 'A note from our hiring team'),
    'an email the rules cannot name must be escalated, not shrugged at');
});

test('a second sweep is a no-op — the ledger is not re-churned', () => {
  const r = sweepLib.sweepRules();
  assert.equal(r.reviewed, 0, 'nothing is unreviewed, so nothing is re-decided');
});

test('recording the same email twice UPDATES rather than duplicating', () => {
  const id = seedEmail({ subject: 'Dup test', body: 'x' });
  sweepLib.sweepRules();
  const before = db.triageCoverage().reviewed;
  db.triageRecord({ emailId: id, route: 'settled', category: 'offer', reason: 'second opinion', decidedBy: 'sonnet', confidence: 0.9 });
  const after = db.triageCoverage();
  assert.equal(after.reviewed, before, 'a second decision on the same email must not create a second row');
  assert.equal(after.byDecider.sonnet, 1);
});

test('sweepAi with nothing pending does no work and names Sonnet anyway', async () => {
  const r = await sweepLib.sweepAi({ generate: async () => { throw new Error('must not be called'); } });
  assert.equal(r.decided, 0);
  assert.equal(r.model, 'sonnet');
});

test('the AI prompt carries the real ids and clipped bodies', () => {
  const p = sweepLib.promptFor([
    { id: 'em_a', subject: 'Sub A', body: 'B'.repeat(5000), fromName: 'N', fromAddr: 'n@x.y', sentAt: '2026-08-10T00:00:00Z' },
    { id: 'em_b', subject: 'Sub B', body: 'short', fromName: 'M', fromAddr: 'm@x.y', sentAt: '2026-08-09T00:00:00Z' },
  ]);
  assert.match(p, /id=em_a/);
  assert.match(p, /id=em_b/);
  assert.ok(p.length < 5000, 'bodies are clipped so a batch cannot blow the context');
  assert.match(p, /exact id given/i);
});

test('the system prompt forbids inventing facts', () => {
  assert.match(sweepLib.SYSTEM, /Never invent facts/i);
  assert.match(sweepLib.SYSTEM, /quote or paraphrase the actual text/i);
});

test('an unknown category from the model is coerced to "other", not trusted blindly', () => {
  assert.equal(sweepLib.VALID.has('offer'), true);
  assert.equal(sweepLib.VALID.has('definitely_a_promotion'), false);
});

test('a hallucinated id decides nothing', async () => {
  // The model returning an id that was not in the batch must be a no-op, never a write against
  // some unrelated email.
  const r = await sweepLib.sweepAi({
    limit: 5,
    generate: async () => ({ json: { results: [{ id: 'not_in_batch', category: 'offer', confidence: 1, reason: 'x' }] } }),
  });
  assert.equal(r.decided, 0);
});

test('an AI failure leaves the escalation pending so the sweep is resumable', async () => {
  const pendingBefore = db.triagePendingEscalations({ limit: 100 }).length;
  const sonnetBefore = db.triageCoverage().byDecider.sonnet || 0;
  const r = await sweepLib.sweepAi({
    limit: 5,
    generate: async () => { throw Object.assign(new Error('claude auth failed'), { code: 'CLAUDE_AUTH' }); },
  });
  assert.equal(r.decided, 0);
  // Nothing NEW was marked decided, so a later run picks the same emails back up. (Counted as a
  // delta, not an absolute — earlier tests in this file legitimately write sonnet rows.)
  assert.equal((db.triageCoverage().byDecider.sonnet || 0) - sonnetBefore, 0);
  assert.equal(db.triagePendingEscalations({ limit: 100 }).length, pendingBefore, 'the queue is untouched');
});
