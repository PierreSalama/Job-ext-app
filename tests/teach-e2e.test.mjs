// T8 (Teach & Correct) — END-TO-END crown-jewel proof of the Apprenticeship Engine v2 loop.
//
// Drives the FULL teach → distill → correct → replay path with REAL functions only (no mocks):
//   a. RECORD     — db.recordDemonstration: a Workday/Rogers apply step is observed at full
//                   fidelity (label, WRONG selector '#yoe-wrong', value, inter-step delay).
//   b. DISTILL    — distiller.distillDemonstrations folds the demo into an enriched recipe step;
//                   db.resolveRecipe surfaces it (with the recorded — still wrong — selector).
//   c. CORRECT    — db.recordRecipeCorrection rewrites that step authoritatively to the CORRECT
//                   element ('#yoe-right') + corrected value, source 'correction', confidence high.
//   d. REPLAY     — resolveLocator (the REAL pure replay decision fn) on the corrected step now
//                   targets the CORRECTED element — i.e. the next auto-apply hits the right field.
//   e. RAIL       — a credential correction (Password) keeps the locator but NEVER stores a value.
//
// db is loaded via the createRequire harness (mirrors teach-correct.test.mjs); replay.js is a
// pure browser ESM module so resolveLocator imports cleanly under node. Temp DB, fully isolated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveLocator } from '../extension/content/replay.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));
const distiller = require(path.join(here, '..', 'app', 'src', 'distiller.js'));

test('teach → distill → correct → replay targets the CORRECTED element (full v2 loop)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-e2e-'));
  try {
    db.open(dir);
    const pid = db.ensureDefaultProfileId();
    const LABEL = 'Years of experience with Java';
    const norm = db.normalizeQuestion(LABEL);

    // ---- a. RECORD: a Workday/Rogers apply step, observed with the WRONG selector. ----
    db.recordDemonstration({
      profileId: pid, ats: 'workday', companyKey: 'rogers', sessionId: 'sess-e2e', jobId: 'job-e2e',
      stepIndex: 0, action: 'fill', label: LABEL, fieldType: 'number',
      selector: '#yoe-wrong', xpath: '//*[@id="yoe-wrong"]', attrs: { id: 'yoe-wrong', name: 'yoe' },
      html: '<input id="yoe-wrong">', value: '4', delayMs: 800, source: 'teach',
    });

    // ---- b. DISTILL: fold the demo into an enriched recipe step. ----
    const out = distiller.distillDemonstrations(pid, { sessionId: 'sess-e2e', jobId: 'job-e2e' });
    assert.ok(out.steps >= 1, 'distillation wrote at least one enriched step');

    const resolved = db.resolveRecipe('workday', 'rogers', pid);
    assert.ok(resolved && resolved.steps && resolved.steps.length, 'resolveRecipe returns steps');
    const distilledStep = resolved.steps.find((s) => s.labelPattern === norm);
    assert.ok(distilledStep, 'the demonstrated field is present in the resolved recipe');
    assert.equal(distilledStep.selector, '#yoe-wrong', 'recipe initially carries the RECORDED (wrong) selector');
    assert.equal(distilledStep.defaultValue, '4', 'invariant demo value became the learned default');

    // 'Years of experience' is GENERIC → it lives on the ATS-scope recipe; that's the recipe we
    // correct. Resolve the concrete recipeId from resolveRecipe and confirm via getRecipe.
    const recipeId = resolved.atsRecipeId;
    assert.ok(recipeId, 'the ats-scope recipe holds the generic field');
    const recipe = db.getRecipe(pid, 'ats', 'workday', null);
    assert.equal(recipe.id, recipeId, 'getRecipe + resolveRecipe agree on the recipeId');

    // ---- c. CORRECT: Pierre picks the RIGHT element + fixes the value. Authoritative rewrite. ----
    const corrected = db.recordRecipeCorrection(recipeId, {
      labelPattern: distilledStep.labelPattern, selector: '#yoe-right', xpath: '//*[@id="yoe-right"]',
      attrs: { id: 'yoe-right', name: 'yoe' }, html: '<input id="yoe-right">',
      value: '5', fieldType: 'number', action: 'fill',
    });
    assert.ok(corrected, 'correction returned the updated recipe');

    const step = db.recipeSteps(recipeId).find((s) => s.labelPattern === norm);
    assert.ok(step, 'the step still exists (rewritten in place, not duplicated)');
    assert.equal(db.recipeSteps(recipeId).filter((s) => s.labelPattern === norm).length, 1, 'no duplicate step');
    assert.equal(step.selector, '#yoe-right', 'selector rewritten to the CORRECTED element');
    assert.equal(step.defaultValue, '5', 'default value rewritten to the corrected value');
    assert.equal(step.source, 'correction', 'source flagged as a correction');
    assert.ok(step.confidence >= 0.9, `corrected step confidence is high/authoritative (got ${step.confidence})`);

    // ---- d. REPLAY-TARGETS-CORRECTED: the REAL replay locator now points at the right element. ----
    assert.deepEqual(
      resolveLocator(step),
      { by: 'selector', value: '#yoe-right' },
      'replay would now target the CORRECTED element (#yoe-right), not the original #yoe-wrong',
    );

    // ---- e. RAIL: a credential correction keeps the locator but NEVER stores a value. ----
    const credNorm = db.normalizeQuestion('Password');
    db.recordRecipeCorrection(recipeId, {
      labelPattern: credNorm, selector: '#pw', xpath: '//*[@id="pw"]',
      value: 'hunter2', fieldType: 'password', action: 'fill',
    });
    const credStep = db.recipeSteps(recipeId).find((s) => s.labelPattern === credNorm);
    assert.ok(credStep, 'the credential locator is recorded (we know WHERE the field is)');
    assert.equal(credStep.selector, '#pw', 'the credential locator is kept');
    assert.equal(credStep.defaultValue, null, 'the credential value is NEVER stored (privacy rail)');
  } finally {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
