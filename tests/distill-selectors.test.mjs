// T3 (Teach & Correct) — distiller enrichment + selector-first replay.
//
// Two halves, both pure/temp-DB so they run under `node --test`:
//   • distillDemonstrations folds RAW high-fidelity demonstrations (real elements + real
//     inter-step timing) into enriched recipe_steps carrying the locator bundle
//     (selector/xpath/attrs) + a learned median delay. The credential rail holds: a
//     'Password' demonstration never becomes a recipe step with a value.
//   • resolveLocator (pure, imported from replay.js) returns selector → xpath → label in
//     precedence order.
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

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-ds-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('distillDemonstrations enriches a recipe step with the real selector/xpath + median delay', () => {
  const pid = db.ensureDefaultProfileId();
  // A few demonstrations for the SAME Workday/Rogers field, varying the delay, invariant value.
  const delays = [600, 800, 1000];
  delays.forEach((delayMs, i) => {
    db.recordDemonstration({
      profileId: pid, ats: 'workday', companyKey: 'rogers', sessionId: 'sess-1', jobId: 'job-1',
      stepIndex: i, action: 'fill', label: 'Years of experience with Java', fieldType: 'number',
      selector: '#yoe', xpath: '//*[@id="yoe"]', attrs: { id: 'yoe', name: 'yoe' },
      html: '<input id="yoe">', value: '4', delayMs, source: 'teach',
    });
  });

  const out = distiller.distillDemonstrations(pid, { sessionId: 'sess-1', jobId: 'job-1' });
  assert.ok(out.steps >= 1, 'at least one enriched step written');

  // 'Years of experience' is a GENERIC question → it lives on the ats-scope recipe.
  const resolved = db.resolveRecipe('workday', 'rogers', pid);
  assert.ok(resolved && resolved.steps && resolved.steps.length, 'resolveRecipe returns steps');
  const norm = db.normalizeQuestion('Years of experience with Java');
  const step = resolved.steps.find((s) => s.labelPattern === norm);
  assert.ok(step, 'the demonstrated field is present in the resolved recipe');
  assert.equal(step.selector, '#yoe', 'real CSS selector folded into the recipe step');
  assert.equal(step.xpath, '//*[@id="yoe"]', 'real XPath folded into the recipe step');
  assert.ok(Number(step.medianDelayMs) > 0, 'median delay learned from the demos');
  assert.equal(Number(step.medianDelayMs), 800, 'median of [600,800,1000] is 800');
  assert.ok(String(step.attrs || '').includes('yoe'), 'attribute signature carried');
  // Invariant value → learned default_value.
  assert.equal(step.defaultValue, '4', 'invariant value becomes the learned default');
});

test('a credential demonstration NEVER becomes a recipe step with a value (rail)', () => {
  const pid = db.ensureDefaultProfileId();
  db.recordDemonstration({
    profileId: pid, ats: 'workday', companyKey: 'rogers', sessionId: 'sess-2', jobId: 'job-2',
    stepIndex: 0, action: 'fill', label: 'Password', selector: '#pw',
    value: 'hunter2', html: '<input type=password>', source: 'teach',
  });
  distiller.distillDemonstrations(pid, { sessionId: 'sess-2', jobId: 'job-2' });

  const norm = db.normalizeQuestion('Password');
  const atsRecipe = db.getRecipe(pid, 'ats', 'workday', null);
  const coRecipe = db.getRecipe(pid, 'company', 'workday', 'rogers');
  const steps = []
    .concat(atsRecipe ? db.recipeSteps(atsRecipe.id) : [])
    .concat(coRecipe ? db.recipeSteps(coRecipe.id) : []);
  const pwStep = steps.find((s) => s.labelPattern === norm);
  assert.ok(!pwStep, 'no recipe step is created for a credential field');
});

test('a per-application (non-invariant) value does NOT become a learned default', () => {
  const pid = db.ensureDefaultProfileId();
  ['I love Rogers', 'Rogers is great'].forEach((v, i) => {
    db.recordDemonstration({
      profileId: pid, ats: 'greenhouse', companyKey: 'acme', sessionId: 'sess-3', jobId: 'job-3',
      stepIndex: i, action: 'fill', label: 'Why do you want to work here?',
      selector: '#why', value: v, delayMs: 500, source: 'teach',
    });
  });
  distiller.distillDemonstrations(pid, { sessionId: 'sess-3', jobId: 'job-3' });
  // Company-specific question → company overlay.
  const coRecipe = db.getRecipe(pid, 'company', 'greenhouse', 'acme');
  assert.ok(coRecipe, 'company overlay recipe created for the specific question');
  const norm = db.normalizeQuestion('Why do you want to work here?');
  const step = db.recipeSteps(coRecipe.id).find((s) => s.labelPattern === norm);
  assert.ok(step, 'company-scoped step written');
  assert.equal(step.selector, '#why', 'selector folded');
  assert.equal(step.defaultValue, null, 'varying values → no learned default_value');
});

test('resolveLocator precedence: selector → xpath → label', () => {
  assert.deepEqual(
    resolveLocator({ selector: '#yoe', xpath: '//*[@id="yoe"]', labelPattern: 'years java' }),
    { by: 'selector', value: '#yoe' }, 'selector wins when present');
  assert.deepEqual(
    resolveLocator({ xpath: '//*[@id="yoe"]', labelPattern: 'years java' }),
    { by: 'xpath', value: '//*[@id="yoe"]' }, 'xpath when no selector');
  assert.deepEqual(
    resolveLocator({ labelPattern: 'years java' }),
    { by: 'label', value: 'years java' }, 'label when neither selector nor xpath');
  // A blank selector is treated as absent → falls through.
  assert.deepEqual(
    resolveLocator({ selector: '  ', xpath: '//*[@id="x"]' }),
    { by: 'xpath', value: '//*[@id="x"]' }, 'blank selector ignored');
});
