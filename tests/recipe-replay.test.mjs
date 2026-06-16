// P5 (Apprenticeship Engine) — Recipe Replayer decision module + correction decay.
//
// replay.js is a PURE ESM browser module with no browser-global access at import
// time, so it imports cleanly under `node --test` (verified by this file running).
// We exercise the four exported decision functions directly:
//   • planReplay — the AUTO gate (confidence, coverage, every-required-field-covered)
//     and its FALLBACK reasons (+ which required label is missing).
//   • resolveStepAnswer — the answer ladder order, and the never-a-URL-for-a-quantity
//     guard (a github URL from qa must NOT fill a "how many years" field).
//   • paceDelay — jittered, clamped to [150,6000], brackets the median, default base.
//   • classifyDivergence — input → divergence kind mapping.
// Plus a db test: recordRecipeCorrection decays confidence (*0.8, floor 0.1) + bumps
// fail_count (createRequire harness mirrored from recipe-transfer.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planReplay, resolveStepAnswer, paceDelay, classifyDivergence } from '../extension/content/replay.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));

// A recipe whose steps cover the two generic required labels.
function recipeCovering(labels, over = {}) {
  return {
    confidence: 0.8, coverage: 0.8,
    atsRecipeId: 'r_ats', companyRecipeId: null,
    steps: labels.map((l, i) => ({ stepIndex: i, action: 'fill', labelPattern: l, fieldType: 'text' })),
    ...over,
  };
}

// ---------- planReplay ----------
test('planReplay → auto when a high-confidence recipe covers all required labels', () => {
  const recipe = recipeCovering(['years experience java', 'authorized work canada']);
  const plan = planReplay(recipe, ['experience java years', 'authorized canada work']);
  assert.equal(plan.mode, 'auto', 'token-overlap ≥0.6 covers both required labels');
  assert.deepEqual(plan.missing, []);
});

test('planReplay → fallback when confidence < theta', () => {
  const recipe = recipeCovering(['years experience java'], { confidence: 0.4 });
  const plan = planReplay(recipe, ['years experience java']);
  assert.equal(plan.mode, 'fallback');
  assert.match(plan.reason, /confidence/);
});

test('planReplay → fallback when coverage < minCoverage', () => {
  const recipe = recipeCovering(['years experience java'], { coverage: 0.3 });
  const plan = planReplay(recipe, ['years experience java']);
  assert.equal(plan.mode, 'fallback');
  assert.match(plan.reason, /coverage/);
});

test('planReplay → fallback and REPORTS the missing label when a required field is uncovered', () => {
  const recipe = recipeCovering(['years experience java', 'authorized work canada']);
  // A brand-new company screener the recipe has never seen.
  const plan = planReplay(recipe, ['years experience java', 'criminal record disclosure consent']);
  assert.equal(plan.mode, 'fallback');
  assert.ok(plan.missing.includes('criminal record disclosure consent'), 'the uncovered required label is reported');
  assert.match(plan.reason, /not covered/);
});

test('planReplay → fallback when the recipe has no steps', () => {
  assert.equal(planReplay({ confidence: 0.9, coverage: 0.9, steps: [] }, ['x']).mode, 'fallback');
  assert.equal(planReplay(null, ['x']).mode, 'fallback');
});

// ---------- resolveStepAnswer (ladder order) ----------
test('resolveStepAnswer follows the ladder: profile → qa → recipe-default → ai → deterministic', () => {
  const step = { labelPattern: 'preferred language' };
  // profile wins when present.
  assert.equal(resolveStepAnswer(step, {
    profileGet: () => 'English', qaGet: () => 'French', aiGet: () => 'German', deterministicGet: () => 'Spanish',
  }), 'English');
  // qa is next when profile misses.
  assert.equal(resolveStepAnswer(step, {
    profileGet: () => null, qaGet: () => 'French', aiGet: () => 'German',
  }), 'French');
  // recipe default beats AI/deterministic.
  assert.equal(resolveStepAnswer({ ...step, defaultValue: 'Italian' }, {
    profileGet: () => null, qaGet: () => null, aiGet: () => 'German', deterministicGet: () => 'Spanish',
  }), 'Italian');
  // AI before deterministic.
  assert.equal(resolveStepAnswer(step, {
    profileGet: () => null, qaGet: () => null, aiGet: () => 'German', deterministicGet: () => 'Spanish',
  }), 'German');
  // deterministic floor.
  assert.equal(resolveStepAnswer(step, {
    profileGet: () => null, qaGet: () => null, aiGet: () => null, deterministicGet: () => 'Spanish',
  }), 'Spanish');
  // nothing grounded → null (never fabricate).
  assert.equal(resolveStepAnswer(step, { profileGet: () => null }), null);
});

test('resolveStepAnswer NEVER returns a URL for a "how many years" label (the GitHub-URL bug)', () => {
  const step = { labelPattern: 'how many years of experience with github' };
  // qa returns a github URL — it must be SKIPPED (quantity question), and the
  // deterministic numeric value (or null) wins instead.
  const v = resolveStepAnswer(step, {
    profileGet: () => null,
    qaGet: () => 'https://github.com/pierre',
    aiGet: () => null,
    deterministicGet: () => '4',
  });
  assert.equal(v, '4', 'the URL candidate is skipped; the deterministic number is used');

  // If EVERY rung only offers a URL for the quantity question, the result is null
  // (skip — never emit a URL into a number field), not the URL.
  const v2 = resolveStepAnswer(step, {
    profileGet: () => 'www.example.com/me',
    qaGet: () => 'https://github.com/pierre',
    aiGet: () => null,
    deterministicGet: () => null,
  });
  assert.equal(v2, null, 'no number anywhere on the ladder → null, never a URL');
});

// ---------- paceDelay ----------
test('paceDelay jitters within [150,6000] and brackets the median', () => {
  const lo = paceDelay(800, () => 0);        // factor 0.6 → 480
  const hi = paceDelay(800, () => 0.999);    // factor ~1.6 → ~1278
  assert.ok(lo >= 150 && lo <= 6000, `lo in range (${lo})`);
  assert.ok(hi >= 150 && hi <= 6000, `hi in range (${hi})`);
  assert.ok(lo < 800 && hi > 800, `the jitter brackets the median (lo=${lo} < 800 < hi=${hi})`);
});

test('paceDelay clamps extreme medians and uses the default base for 0', () => {
  assert.ok(paceDelay(0, () => 0.5) >= 150, 'medianMs=0 uses the ~700 default base (≈ 770), above min');
  assert.ok(paceDelay(0, () => 0.5) <= 6000);
  assert.equal(paceDelay(999999, () => 0.999), 6000, 'a huge median is clamped to the 6000 ceiling');
  assert.equal(paceDelay(1, () => 0), 150, 'a tiny median is clamped up to the 150 floor');
});

// ---------- classifyDivergence ----------
test('classifyDivergence maps inputs to the right kind (priority: field > validation > stall)', () => {
  assert.equal(classifyDivergence({ unexpectedRequiredField: true }), 'unexpected_field');
  assert.equal(classifyDivergence({ validationError: 'Please select an option' }), 'validation_error');
  assert.equal(classifyDivergence({ noChangeCount: 3 }), 'stalled');
  assert.equal(classifyDivergence({ noChangeCount: 2 }), null, '2 no-change advances is not yet a stall');
  assert.equal(classifyDivergence({}), null);
  // an unexpected field outranks a co-occurring stall.
  assert.equal(classifyDivergence({ unexpectedRequiredField: true, noChangeCount: 9 }), 'unexpected_field');
});

// ---------- db: recordRecipeCorrection decays confidence + bumps fail_count ----------
test('recordRecipeCorrection decays the recipe confidence (*0.8, floor 0.1) and bumps fail_count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-replay-'));
  try {
    db.open(dir);
    const pid = db.ensureDefaultProfileId();
    const recipe = db.upsertRecipe({ profileId: pid, scope: 'ats', ats: 'workday' });
    // Seed a step so we can prove the step's confidence is decayed too.
    const labelPattern = db.normalizeQuestion('Are you authorized to work in Canada?');
    db.upsertRecipeStep({ recipeId: recipe.id, action: 'select', labelPattern, fieldType: 'radio', confidence: 0.9 });

    const before = db.getRecipe(pid, 'ats', 'workday', null);
    assert.equal(before.confidence, 0.5, 'fresh recipes start at confidence 0.5');
    assert.equal(before.failCount, 0);

    const after = db.recordRecipeCorrection(recipe.id, { labelPattern });
    assert.ok(Math.abs(after.confidence - 0.4) < 1e-9, '0.5 * 0.8 = 0.4');
    assert.equal(after.failCount, 1, 'fail_count bumped');

    // The named step's confidence is decayed too (0.9 * 0.8 = 0.72).
    const step = db.recipeSteps(recipe.id).find((s) => s.labelPattern === labelPattern);
    assert.ok(Math.abs(step.confidence - 0.72) < 1e-9, 'the divergent step confidence is decayed');

    // Floor: repeated corrections never push confidence below 0.1.
    for (let i = 0; i < 20; i++) db.recordRecipeCorrection(recipe.id, {});
    const floored = db.getRecipe(pid, 'ats', 'workday', null);
    assert.ok(floored.confidence >= 0.1, 'confidence is floored at 0.1, never zero');
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
