// T4 (Teach & Correct) — Live Teach & Correct: authoritative recipe correction + run-mode picker.
//
// Covers:
//   • db.recordRecipeCorrection with a REPLACEMENT bundle → the matching step is REWRITTEN
//     (right selector + value), source 'correction', confidence high — the user is
//     authoritative. The recipe's own confidence is bumped (a confirmed fix is a positive
//     signal), not decayed.
//   • the credential rail: a correction on a sensitive label (Password) keeps the locator
//     but NEVER stores a value.
//   • a correction with NO replacement still just DECAYS (today's P5 behavior).
//   • replay.pickRunMode — new/low-confidence recipe → 'step'; trusted recipe → 'run'.
//
// replay.js is a PURE browser ESM module (no browser globals at import time) so pickRunMode
// imports cleanly under node. db is loaded via the createRequire harness (mirrors
// recipe-replay.test.mjs); temp DB per the seeded test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pickRunMode } from '../extension/content/replay.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));

// ---------- db: recordRecipeCorrection AUTHORITATIVE REWRITE ----------
test('recordRecipeCorrection with a replacement bundle rewrites the step authoritatively', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-teach-'));
  try {
    db.open(dir);
    const pid = db.ensureDefaultProfileId();
    const recipe = db.upsertRecipe({ profileId: pid, scope: 'ats', ats: 'workday' });
    const labelPattern = db.normalizeQuestion('Are you authorized to work in Canada?');

    // Seed a step with a WRONG selector + value so we can prove the correction overwrites it.
    db.upsertRecipeStep({
      recipeId: recipe.id, action: 'select', labelPattern, fieldType: 'radio',
      selector: '#wrong', xpath: '//*[@id="wrong"]', defaultValue: 'No', confidence: 0.5, source: 'distilled',
    });

    const before = db.getRecipe(pid, 'ats', 'workday', null);
    assert.equal(before.confidence, 0.5, 'fresh recipe starts at 0.5');

    // The user picked the correct element (#right) and the correct value ("Yes").
    const after = db.recordRecipeCorrection(recipe.id, {
      labelPattern, selector: '#right', xpath: '//*[@id="right"]',
      attrs: { id: 'right', role: 'radio' }, html: '<input id="right">',
      value: 'Yes', fieldType: 'radio', action: 'click',
    });

    const step = db.recipeSteps(recipe.id).find((s) => s.labelPattern === labelPattern);
    assert.ok(step, 'the step still exists (rewritten in place, not duplicated)');
    assert.equal(db.recipeSteps(recipe.id).length, 1, 'no duplicate step created');
    assert.equal(step.selector, '#right', 'selector rewritten to the picked element');
    assert.equal(step.xpath, '//*[@id="right"]', 'xpath rewritten');
    assert.equal(step.defaultValue, 'Yes', 'default value rewritten to the corrected value');
    assert.equal(step.source, 'correction', 'source flagged as a correction');
    assert.ok(step.confidence >= 0.9, `step confidence is high/user-authoritative (got ${step.confidence})`);

    // A confirmed correction is a POSITIVE signal → the recipe confidence goes UP, not down.
    assert.ok(after.confidence > before.confidence, 'recipe confidence bumped, not decayed');
    assert.ok(after.confidence >= 0.5);
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a correction that names a brand-new label CREATES the step', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-teach-'));
  try {
    db.open(dir);
    const pid = db.ensureDefaultProfileId();
    const recipe = db.upsertRecipe({ profileId: pid, scope: 'ats', ats: 'greenhouse' });
    const labelPattern = db.normalizeQuestion('Preferred start date');

    assert.equal(db.recipeSteps(recipe.id).length, 0, 'recipe starts with no steps');
    db.recordRecipeCorrection(recipe.id, { labelPattern, selector: '#start', value: '2026-07-01', fieldType: 'date', action: 'fill' });

    const steps = db.recipeSteps(recipe.id);
    assert.equal(steps.length, 1, 'the absent step was created');
    assert.equal(steps[0].selector, '#start');
    assert.equal(steps[0].defaultValue, '2026-07-01');
    assert.equal(steps[0].source, 'correction');
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- db: credential rail on corrections ----------
test('a correction on a credential label keeps the locator but NEVER stores a value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-teach-'));
  try {
    db.open(dir);
    const pid = db.ensureDefaultProfileId();
    const recipe = db.upsertRecipe({ profileId: pid, scope: 'ats', ats: 'workday' });
    const labelPattern = db.normalizeQuestion('Password');

    db.recordRecipeCorrection(recipe.id, {
      labelPattern, selector: '#pw', xpath: '//*[@id="pw"]', value: 'hunter2', fieldType: 'password', action: 'fill',
    });

    const step = db.recipeSteps(recipe.id).find((s) => s.labelPattern === labelPattern);
    assert.ok(step, 'the locator step is recorded (we know WHERE the field is)');
    assert.equal(step.selector, '#pw', 'the locator is kept');
    assert.equal(step.defaultValue, null, 'the credential value is NEVER stored (rail)');
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- db: no-replacement correction still decays (today's behavior) ----------
test('a correction with NO replacement still just decays (confidence drops, no value written)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-teach-'));
  try {
    db.open(dir);
    const pid = db.ensureDefaultProfileId();
    const recipe = db.upsertRecipe({ profileId: pid, scope: 'ats', ats: 'workday' });
    const labelPattern = db.normalizeQuestion('Are you authorized to work in Canada?');
    db.upsertRecipeStep({ recipeId: recipe.id, action: 'select', labelPattern, fieldType: 'radio', confidence: 0.9 });

    const after = db.recordRecipeCorrection(recipe.id, { labelPattern });   // no bundle
    assert.ok(Math.abs(after.confidence - 0.4) < 1e-9, '0.5 * 0.8 = 0.4 (decayed, not bumped)');
    assert.equal(after.failCount, 1, 'fail_count bumped (a divergence, not a fix)');

    const step = db.recipeSteps(recipe.id).find((s) => s.labelPattern === labelPattern);
    assert.ok(Math.abs(step.confidence - 0.72) < 1e-9, 'the step confidence decayed (0.9*0.8)');
    assert.equal(step.defaultValue, null, 'no value written on a plain "this was wrong"');
    assert.equal(step.selector, null, 'no locator written either');
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- replay.pickRunMode ----------
test('pickRunMode → step for a new/low-confidence recipe, run for a trusted one', () => {
  // New: no steps → step (the first teach of an ATS is fully watched).
  assert.equal(pickRunMode({ confidence: 0.9, steps: [] }), 'step', 'no steps → step');
  assert.equal(pickRunMode(null), 'step', 'no recipe → step');

  // Low confidence even with steps → step.
  assert.equal(pickRunMode({ confidence: 0.5, steps: [{ labelPattern: 'a' }] }), 'step', 'confidence < trust → step');

  // Trusted: has steps AND confidence ≥ trust → run.
  assert.equal(pickRunMode({ confidence: 0.8, steps: [{ labelPattern: 'a' }] }), 'run', 'trusted → run');
  assert.equal(pickRunMode({ confidence: 0.7, steps: [{ labelPattern: 'a' }] }), 'run', 'exactly at the default trust → run');

  // The trust threshold is tunable.
  assert.equal(pickRunMode({ confidence: 0.8, steps: [{ labelPattern: 'a' }] }, { trust: 0.9 }), 'step', 'a higher trust bar keeps it in step');
});
