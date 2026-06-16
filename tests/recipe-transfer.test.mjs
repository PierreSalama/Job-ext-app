// P3 (Apprenticeship Engine) — Recipe Store + Distiller + Transfer Engine.
// A completed manual application is distilled (distiller.js) into ats_recipes + recipe_steps:
// generic questions land on the cross-company ATS recipe, company-specific screening on the
// company overlay. resolveRecipe(ats, company, profile) then TRANSFERS the ATS recipe to a
// company never seen, and the company overlay wins on label conflict. Credentials never
// become a step. Temp DB; createRequire harness mirrored from observer-nav.test.mjs.
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
const distiller = require(path.join(here, '..', 'app', 'src', 'distiller.js'));

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-recipe-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

// Helper: create a submitted job with the given answers and distill it.
function submitAndDistill({ company, jobUrl, answers, pid }) {
  // skipHarvest keeps the test focused on the recipe path (harvest is exercised elsewhere);
  // we call distillJob explicitly so the assertions don't depend on the auto-trigger timing.
  const { job } = db.upsertJob(
    { title: 'Engineer', company, jobUrl, status: 'submitted', answers, source: 'workday' },
    { manual: true, skipHarvest: true });
  return distiller.distillJob(job.id, pid);
}

test('distilling a submitted Workday apply at Rogers builds an ATS recipe + a company overlay', () => {
  const pid = db.ensureDefaultProfileId();
  const res = submitAndDistill({
    company: 'Rogers',
    jobUrl: 'https://rogers.wd3.myworkdayjobs.com/en-US/careers/job/Toronto/Engineer_R-1',
    answers: {
      'Years of experience with Java': '4',
      'Are you authorized to work in Canada?': 'Yes',
      'Why do you want to work at Rogers?': 'I admire the network and the team.',
      'Account password': 'hunter2',                 // credential — must be dropped
    },
    pid,
  });

  // Two recipes (ats + company), and the password is NOT among the steps.
  assert.equal(res.recipes, 2, 'an ATS recipe and a Rogers company overlay were written');

  const atsRecipe = db.getRecipe(pid, 'ats', 'workday', null);
  assert.ok(atsRecipe, 'a scope=ats Workday recipe exists (company-agnostic)');
  assert.equal(atsRecipe.companyKey, null, 'the ATS recipe is not keyed to a company');
  assert.ok(atsRecipe.successCount >= 1, 'a distilled (completed) apply marks mechanical success');

  const companyRecipe = db.getRecipe(pid, 'company', 'workday', 'rogers');
  assert.ok(companyRecipe, 'a scope=company Rogers overlay exists');

  // Generic questions are on the ATS recipe; the "why Rogers" screener is on the overlay.
  const atsLabels = db.recipeSteps(atsRecipe.id).map((s) => s.labelPattern);
  const coLabels = db.recipeSteps(companyRecipe.id).map((s) => s.labelPattern);
  assert.ok(atsLabels.some((l) => l.includes('experience') && l.includes('java')), 'years-of-experience is ATS-scope');
  assert.ok(atsLabels.some((l) => l.includes('authorized')), 'authorized-to-work is ATS-scope');
  assert.ok(coLabels.some((l) => l.includes('rogers')), 'the "why Rogers" screener is company-scope');
});

test('the credential answer never becomes a recipe_step on any recipe', () => {
  const pid = db.ensureDefaultProfileId();
  const allLabels = [];
  for (const scope of ['ats', 'company']) {
    const r = db.getRecipe(pid, scope, 'workday', scope === 'company' ? 'rogers' : null);
    if (r) for (const s of db.recipeSteps(r.id)) allLabels.push(s.labelPattern || '');
  }
  assert.ok(!allLabels.some((l) => /password|hunter2/i.test(l)), 'no password step was ever stored');
});

test('resolveRecipe transfers the ATS recipe to Bell (a Workday company never applied to)', () => {
  const pid = db.ensureDefaultProfileId();
  // Bell has NO company overlay yet — only the Rogers-seeded ATS recipe should resolve.
  const resolved = db.resolveRecipe('workday', 'bell', pid);
  assert.ok(resolved.atsRecipeId, 'the ATS recipe resolves for Bell');
  assert.equal(resolved.companyRecipeId, null, 'Bell has no company overlay yet');

  const labels = resolved.steps.map((s) => s.labelPattern);
  assert.ok(labels.some((l) => l.includes('experience') && l.includes('java')),
    'years-of-experience transfers from the ATS recipe to Bell');
  assert.ok(labels.some((l) => l.includes('authorized')),
    'authorized-to-work transfers from the ATS recipe to Bell');
  assert.ok(resolved.coverage > 0, 'coverage is positive when an ATS recipe resolves');
});

test('a Bell company overlay adds its screener AND wins an ATS-vs-company label conflict', () => {
  const pid = db.ensureDefaultProfileId();
  // Distill a Bell/Workday apply that has BOTH a company-specific screener and a generic
  // question whose label collides with an ATS-recipe label, but a DIFFERENT value.
  submitAndDistill({
    company: 'Bell',
    jobUrl: 'https://bell.wd3.myworkdayjobs.com/en-US/careers/job/Montreal/Engineer_R-2',
    answers: {
      'Why do you want to work at Bell?': 'I want to build great networks at Bell.',
      // Same generic label as Rogers but a company-specific value — forced onto the overlay
      // below so we can prove company precedence on conflict.
    },
    pid,
  });

  // Force a conflicting step onto the Bell COMPANY overlay with the same label_pattern as an
  // ATS-recipe step ("authorized to work"), but a company-specific value/action, to prove
  // the merge picks the company step on conflict.
  const companyRecipe = db.getRecipe(pid, 'company', 'workday', 'bell');
  assert.ok(companyRecipe, 'distilling the Bell apply created a Bell company overlay');
  const conflictLabel = db.normalizeQuestion('Are you authorized to work in Canada?');
  db.upsertRecipeStep({
    recipeId: companyRecipe.id,
    action: 'select',
    labelPattern: conflictLabel,
    fieldType: 'text',
    strategy: 'matchOption',
    confidence: 0.9,
  });

  const resolved = db.resolveRecipe('workday', 'bell', pid);
  assert.ok(resolved.companyRecipeId, 'Bell now has a company overlay');

  const labels = resolved.steps.map((s) => s.labelPattern);
  assert.ok(labels.some((l) => l.includes('bell')), 'the Bell company screener is in the merged flow');

  // The conflicting label resolves to the COMPANY step (scope=company, confidence 0.9),
  // not the ATS one.
  const conflictStep = resolved.steps.find((s) => s.labelPattern === conflictLabel);
  assert.ok(conflictStep, 'the conflicting label is present exactly once');
  assert.equal(conflictStep.scope, 'company', 'company overlay wins the label conflict');
  assert.equal(conflictStep.confidence, 0.9, 'the company step (not the ATS default) is the survivor');

  // No duplicate of the conflicting label across the merged steps.
  const dupes = labels.filter((l) => l === conflictLabel);
  assert.equal(dupes.length, 1, 'the conflicting label is merged, not duplicated');
});

test('distillJob is a no-op when there are no answers', () => {
  const pid = db.ensureDefaultProfileId();
  const { job } = db.upsertJob(
    { title: 'Engineer', company: 'NoAnswers Inc', jobUrl: 'https://acme.wd3.myworkdayjobs.com/job/1', status: 'submitted' },
    { manual: true, skipHarvest: true });
  const res = distiller.distillJob(job.id, pid);
  assert.deepEqual(res, { recipes: 0, steps: 0 }, 'no answers → nothing distilled');
});
