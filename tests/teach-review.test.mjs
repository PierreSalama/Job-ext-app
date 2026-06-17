// T5 (Teach & Correct) — Review / Audit dashboard "Taught Procedures" db surface.
//
// Covers the read/edit/delete/reorder helpers the dashboard drives:
//   • listRecipesWithSteps(profileId) → recipes (ats + company) grouped, each with its
//     ordered steps (the full bundle) + a per-step needsAttention flag.
//   • updateRecipeStepFields → edits a step's value; reorder changes step_index; and the
//     CREDENTIAL RAIL refuses to set a value on a 'Password'-labeled step.
//   • deleteRecipeStep → removes the step.
//
// db is loaded via the createRequire harness (mirrors teach-correct.test.mjs); temp DB per
// the seeded test so nothing touches the user's real store.
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

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-review-'));
  try {
    db.open(dir);
    fn(db.ensureDefaultProfileId());
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- listRecipesWithSteps: grouped bundle + needsAttention ----------
test('listRecipesWithSteps returns recipes grouped with their ordered steps + needsAttention', () => {
  withDb((pid) => {
    // An ATS recipe with two steps — one confident, one low-confidence (→ attention).
    const ats = db.upsertRecipe({ profileId: pid, scope: 'ats', ats: 'workday' });
    db.upsertRecipeStep({ recipeId: ats.id, stepIndex: 0, action: 'fill', labelPattern: 'first name', fieldType: 'text', defaultValue: 'Pierre', confidence: 0.9, source: 'distilled' });
    db.upsertRecipeStep({ recipeId: ats.id, stepIndex: 1, action: 'select', labelPattern: 'authorized to work', fieldType: 'radio', defaultValue: 'Yes', confidence: 0.3, source: 'distilled' });

    // A company overlay on the same ATS.
    const co = db.upsertRecipe({ profileId: pid, scope: 'company', ats: 'workday', companyKey: 'acme' });
    db.upsertRecipeStep({ recipeId: co.id, stepIndex: 0, action: 'fill', labelPattern: 'why acme', fieldType: 'textarea', defaultValue: 'Great team', confidence: 0.8, source: 'teach' });

    const recipes = db.listRecipesWithSteps(pid);
    assert.equal(recipes.length, 2, 'both recipes returned');

    const atsBundle = recipes.find((r) => r.scope === 'ats');
    const coBundle = recipes.find((r) => r.scope === 'company');
    assert.ok(atsBundle && coBundle, 'ats + company recipes present');
    assert.equal(atsBundle.company, null, 'ATS recipe has no company');
    assert.equal(coBundle.company, 'acme', 'company recipe exposes its company key');

    // Ordered steps (step_index ascending).
    assert.deepEqual(atsBundle.steps.map((s) => s.labelPattern), ['first name', 'authorized to work']);

    // needsAttention: the low-confidence step is flagged, the confident one is not.
    const low = atsBundle.steps.find((s) => s.labelPattern === 'authorized to work');
    const hi = atsBundle.steps.find((s) => s.labelPattern === 'first name');
    assert.equal(low.needsAttention, true, 'confidence < 0.5 → needs attention');
    assert.equal(hi.needsAttention, false, 'confident step does not need attention');
    assert.equal(atsBundle.attentionCount, 1, 'attentionCount counts the flagged step');
  });
});

test('a recently-corrected step is surfaced as needsAttention', () => {
  withDb((pid) => {
    const r = db.upsertRecipe({ profileId: pid, scope: 'ats', ats: 'greenhouse' });
    // A correction sets source='correction' + high confidence + fresh updated_at.
    db.recordRecipeCorrection(r.id, { labelPattern: 'salary', selector: '#sal', value: '120000', fieldType: 'text', action: 'fill' });
    const bundle = db.listRecipesWithSteps(pid).find((x) => x.scope === 'ats');
    const step = bundle.steps.find((s) => s.labelPattern === 'salary');
    assert.equal(step.source, 'correction');
    assert.equal(step.needsAttention, true, 'a recent correction is surfaced for verification');
  });
});

// ---------- updateRecipeStepFields: edit value ----------
test('updateRecipeStepFields edits a step value', () => {
  withDb((pid) => {
    const r = db.upsertRecipe({ profileId: pid, scope: 'ats', ats: 'lever' });
    const step = db.upsertRecipeStep({ recipeId: r.id, action: 'fill', labelPattern: 'phone', fieldType: 'tel', defaultValue: '111', confidence: 0.8 });

    const updated = db.updateRecipeStepFields(step.id, { defaultValue: '555-1234' });
    assert.equal(updated.defaultValue, '555-1234', 'value updated');
    // Persisted.
    assert.equal(db.recipeSteps(r.id)[0].defaultValue, '555-1234');
  });
});

// ---------- credential rail ----------
test('updateRecipeStepFields REFUSES to set a value on a Password step (rail)', () => {
  withDb((pid) => {
    const r = db.upsertRecipe({ profileId: pid, scope: 'ats', ats: 'workday' });
    const step = db.upsertRecipeStep({ recipeId: r.id, action: 'fill', labelPattern: 'Password', fieldType: 'password', selector: '#pw', confidence: 0.9 });

    const updated = db.updateRecipeStepFields(step.id, { defaultValue: 'hunter2' });
    assert.equal(updated.defaultValue, null, 'credential value is NEVER stored (rail holds)');
    assert.equal(updated.selector, '#pw', 'the locator is untouched');
  });
});

test('the rail also holds when a step is RENAMED to a sensitive label', () => {
  withDb((pid) => {
    const r = db.upsertRecipe({ profileId: pid, scope: 'ats', ats: 'workday' });
    const step = db.upsertRecipeStep({ recipeId: r.id, action: 'fill', labelPattern: 'nickname', fieldType: 'text', confidence: 0.9 });
    // Rename to a sensitive label AND try to set a value in the same edit.
    const updated = db.updateRecipeStepFields(step.id, { labelPattern: 'SSN', defaultValue: '123-45-6789' });
    assert.equal(updated.labelPattern, 'SSN', 'label renamed');
    assert.equal(updated.defaultValue, null, 'value refused because the new label is sensitive');
  });
});

// ---------- reorder ----------
test('updateRecipeStepFields reorders by changing step_index', () => {
  withDb((pid) => {
    const r = db.upsertRecipe({ profileId: pid, scope: 'ats', ats: 'lever' });
    const a = db.upsertRecipeStep({ recipeId: r.id, stepIndex: 0, action: 'fill', labelPattern: 'a', confidence: 0.8 });
    const b = db.upsertRecipeStep({ recipeId: r.id, stepIndex: 1, action: 'fill', labelPattern: 'b', confidence: 0.8 });
    assert.deepEqual(db.recipeSteps(r.id).map((s) => s.labelPattern), ['a', 'b']);

    // Swap their indices → order flips.
    db.updateRecipeStepFields(a.id, { stepIndex: 1 });
    db.updateRecipeStepFields(b.id, { stepIndex: 0 });
    assert.deepEqual(db.recipeSteps(r.id).map((s) => s.labelPattern), ['b', 'a'], 'reorder took effect');
  });
});

// ---------- scope flip ----------
test('updateRecipeStepFields flips a step scope ats→company (moves it to the sibling recipe)', () => {
  withDb((pid) => {
    const ats = db.upsertRecipe({ profileId: pid, scope: 'ats', ats: 'workday' });
    const step = db.upsertRecipeStep({ recipeId: ats.id, action: 'fill', labelPattern: 'why us', fieldType: 'textarea', defaultValue: 'x', confidence: 0.8 });

    const updated = db.updateRecipeStepFields(step.id, { scope: 'company' });
    assert.notEqual(updated.recipeId, ats.id, 'the step moved to a different (company) recipe');
    assert.equal(db.recipeSteps(ats.id).length, 0, 'gone from the ATS recipe');

    const bundle = db.listRecipesWithSteps(pid);
    const co = bundle.find((r) => r.scope === 'company');
    assert.ok(co, 'a company recipe now exists');
    assert.ok(co.steps.find((s) => s.labelPattern === 'why us'), 'the step lives in the company recipe');
  });
});

// ---------- delete ----------
test('deleteRecipeStep removes the step', () => {
  withDb((pid) => {
    const r = db.upsertRecipe({ profileId: pid, scope: 'ats', ats: 'lever' });
    const step = db.upsertRecipeStep({ recipeId: r.id, action: 'fill', labelPattern: 'phone', confidence: 0.8 });
    assert.equal(db.recipeSteps(r.id).length, 1);

    assert.equal(db.deleteRecipeStep(step.id), true, 'delete reports success');
    assert.equal(db.recipeSteps(r.id).length, 0, 'the step is gone');
    assert.equal(db.deleteRecipeStep(step.id), false, 'deleting again is a no-op');
  });
});

test('getTeachScreenshotPath returns the stored file path', () => {
  withDb((pid) => {
    const id = db.recordTeachScreenshot({ profileId: pid, path: '/tmp/shot-x.png', w: 10, h: 10, bytes: 99 });
    assert.equal(db.getTeachScreenshotPath(id), '/tmp/shot-x.png');
    assert.equal(db.getTeachScreenshotPath('nope'), null);
  });
});
