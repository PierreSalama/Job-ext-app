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
