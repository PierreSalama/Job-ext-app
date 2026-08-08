// A1 — LinkedIn Easy Apply daily-cap (~50/24h): detect → cooldown → learn threshold →
// pivot. Tests the db helpers + the candidate-eligibility logic queueNext uses, against
// a real temp DB.
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
const server = require(path.join(here, '..', 'app', 'src', 'server.js'));

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-eatest-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

// Helper: seed a "done" Easy-Apply task (counts toward the rolling-24h submit total).
function seedEasyApplyDone(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const job = db.upsertJob({ title: `EA ${Math.random()}`, company: 'Co', source: 'linkedin', status: 'started', jobUrl: `https://x/ea/${Math.random()}` }).job;
    const t = db.queueAdd(job.id, { mode: 'review' });
    db.queuePatch(t.id, { state: 'done', applyRoute: 'easy-apply', submissionEvidence: { type: 'test-confirmation' } });
    ids.push(t.id);
  }
  return ids;
}

test('setEasyApplyCooldown → cooledDown true; expires to false', () => {
  assert.equal(db.easyApplyCooledDown(), false, 'not cooled down initially');
  db.setEasyApplyCooldown({ hours: 24 });
  assert.equal(db.easyApplyCooledDown(), true, 'cooled down after setting');

  // Back-date the kv so the cooldown is in the past → expires to false.
  db.kvSet('easyApplyLimitUntil', new Date(Date.now() - 1000).toISOString());
  assert.equal(db.easyApplyCooledDown(), false, 'expired cooldown reads false');

  // A 0-hour cooldown is immediately expired.
  db.setEasyApplyCooldown({ hours: 0 });
  assert.equal(db.easyApplyCooledDown(), false, '0h cooldown is already expired');
});

test('observed-limit learning keeps the MAX ever observed', () => {
  // First observation: seed some Easy-Apply dones, then trip the cooldown → records count.
  seedEasyApplyDone(7);
  const first = db.setEasyApplyCooldown();
  assert.ok(first.submitted24h >= 7, 'counts the 7 easy-apply dones');
  assert.equal(db.easyApplyStatus().observedLimit, first.submitted24h, 'observed = first count');

  // Now PRE-SEED a higher observed value, then trip again with a *lower* live count:
  // it must KEEP the larger (our best estimate of the real cap).
  const higher = first.submitted24h + 50;
  db.kvSet('easyApplyObservedLimit', higher);
  const second = db.setEasyApplyCooldown();
  assert.ok(second.submitted24h < higher, 'live 24h count is below the pre-seeded max');
  assert.equal(db.easyApplyStatus().observedLimit, higher, 'keeps the larger observed limit');
});

test('queueNext pivot: cooled down skips LinkedIn Easy-Apply, still allows external', () => {
  const li = db.upsertJob({ title: 'LI Dev', company: 'Acme', source: 'linkedin', status: 'started', jobUrl: 'https://www.linkedin.com/jobs/view/123' }).job;
  const wd = db.upsertJob({ title: 'WD Dev', company: 'Beta', source: 'workday', status: 'started', jobUrl: 'https://beta.wd5.myworkdayjobs.com/careers/job/123' }).job;

  // Not cooled down → BOTH eligible (purely additive).
  db.kvSet('easyApplyLimitUntil', new Date(Date.now() - 1000).toISOString());
  assert.equal(db.easyApplyCooledDown(), false);
  assert.equal(db.easyApplyEligible(li), true, 'LinkedIn eligible when not cooled down');
  assert.equal(db.easyApplyEligible(wd), true, 'Workday eligible when not cooled down');

  // Cooled down → LinkedIn NOT eligible, Workday still eligible.
  db.kvSet('easyApplyObservedLimit', db.easyApplySubmitted24h());   // simulate: cap hit AT the current count (no headroom)
  db.setEasyApplyCooldown({ hours: 24 });
  assert.equal(db.easyApplyCooledDown(), true);
  assert.equal(db.easyApplyEligible(li), false, 'LinkedIn Easy-Apply deferred during cooldown');
  assert.equal(db.easyApplyEligible(wd), true, 'external/company-site (Workday) still flows');

  // A LinkedIn job detected purely by URL (no source) is also deferred.
  const liByUrl = { jobUrl: 'https://www.linkedin.com/jobs/view/999', source: '' };
  assert.equal(db.easyApplyEligible(liByUrl), false, 'LinkedIn-by-URL deferred too');

  // Reset for any later tests.
  db.kvSet('easyApplyLimitUntil', new Date(Date.now() - 1000).toISOString());
});

// COOLDOWN FALLBACK (intake side): while Easy-Apply is cooled down, ingestDiscoveredJobs must relax
// easyApplyOnly so external/ATS supply enters the queue (the dispatch pivot then flows it). Without
// this the queue starved to LinkedIn-only during a cooldown and the node idled until the cap reset.
test('cooldown fallback: intake ingests external jobs while Easy-Apply is cooled down', () => {
  db.patchSettings({ autoApply: { easyApplyOnly: true } });
  db.kvSet('easyApplyLimitUntil', new Date(Date.now() - 1000).toISOString());   // ensure NOT cooled down
  assert.equal(db.easyApplyCooledDown(), false);

  const extJob = () => ({ title: 'Software Engineer', company: 'ExtCo', source: 'ziprecruiter', location: 'Toronto, ON', jobUrl: `https://ext.example/${Math.random()}` });

  // NOT cooled down + easyApplyOnly ON → a pure-aggregator external source is rejected (not enqueued).
  const r1 = server.ingestDiscoveredJobs('ziprecruiter', [extJob()], { providerName: 'test' });
  assert.equal(r1.enqueued, 0, 'external rejected under easyApplyOnly when not cooled down');

  // Cooled down → easyApplyOnly relaxes at intake → the external job is ingested.
  db.kvSet('easyApplyObservedLimit', db.easyApplySubmitted24h());   // simulate: cap hit AT the current count (no headroom)
  db.setEasyApplyCooldown({ hours: 24 });
  assert.equal(db.easyApplyCooledDown(), true);
  const r2 = server.ingestDiscoveredJobs('ziprecruiter', [extJob()], { providerName: 'test' });
  assert.equal(r2.enqueued, 1, 'external ingested while cooled down (fallback keeps the node working)');

  db.kvSet('easyApplyLimitUntil', new Date(Date.now() - 1000).toISOString());   // reset for later tests
});

// EARLY RESET DETECTION: while the fixed 24h timer is still running, the cooldown must CLEAR the
// instant the rolling-24h count drops a margin below the observed cap (headroom = the cap effectively
// reset). This is what auto-switches back to Easy-Apply right away instead of waiting out the timer.
test('early reset: cooldown clears once rolling-24h count is a margin below the observed limit', () => {
  const now24 = db.easyApplySubmitted24h();
  db.kvSet('easyApplyLimitUntil', new Date(Date.now() + 24 * 3600 * 1000).toISOString());   // fresh 24h timer
  // The early reset is only consulted OUTSIDE the post-refusal blackout (see easyApplyCooledDown:
  // an explicit easyapply-limit from LinkedIn outranks this node's local count, because the cap is
  // per-account and a second node's usage is invisible here). This test exercises the early-reset
  // heuristic itself, so place the last refusal well in the past. The blackout has its own coverage
  // in easyapply-multinode-cap.test.mjs.
  db.kvSet('easyApplyLimitSeenAt', Date.now() - 6 * 3600 * 1000);

  // Observed limit well ABOVE the current count → real headroom → cap treated as reset → NOT cooled.
  db.kvSet('easyApplyObservedLimit', now24 + 50);
  assert.equal(db.easyApplyCooledDown(), false, 'headroom below the cap → resume Easy-Apply right away');

  // ...but a FRESH refusal outranks that headroom, even with the same counts.
  db.kvSet('easyApplyLimitSeenAt', Date.now());
  assert.equal(db.easyApplyCooledDown(), true, 'LinkedIn just refused us → hold, whatever the local count says');
  db.kvSet('easyApplyLimitSeenAt', Date.now() - 6 * 3600 * 1000);

  // Observed limit == current count → sitting AT the cap → stay cooled (external mode).
  db.kvSet('easyApplyObservedLimit', now24);
  assert.equal(db.easyApplyCooledDown(), true, 'at the cap → stay in external mode');

  // The fixed timer is still the outer safety net: expired timer → not cooled regardless of count.
  db.kvSet('easyApplyLimitUntil', new Date(Date.now() - 1000).toISOString());
  assert.equal(db.easyApplyCooledDown(), false, 'expired 24h timer always clears');
});
