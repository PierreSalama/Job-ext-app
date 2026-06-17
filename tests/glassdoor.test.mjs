// T7 — Glassdoor support + external/company-site learning is first-class.
//
// All pure / temp-DB so it runs under `node --test`:
//   • classifyAts recognizes the glassdoor host as ats:'glassdoor' (board; companyKey from
//     the URL slug when derivable, else null — the caller supplies job.company).
//   • a glassdoor job round-trips through upsertJob and is queryable by source like any other
//     board, proving sources aren't hard-coded to linkedin/indeed at the storage layer.
//   • the recipe machinery is NOT LinkedIn-only: distilling a glassdoor (and a direct) apply's
//     demonstrations produces a resolvable recipe — external/company-site learning works the
//     same as LinkedIn. This is the C/D confirmation the phase calls for.
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
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-gd-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('classifyAts recognizes a Glassdoor job URL as ats:glassdoor', () => {
  const c = db.classifyAts('https://www.glassdoor.com/job-listing/senior-engineer-acme-JV_IC1147401_KO0,15_KE16,20.htm?jl=123');
  assert.equal(c.ats, 'glassdoor', 'glassdoor host → ats:glassdoor');
  assert.ok('companyKey' in c, 'returns a companyKey field (null or derived)');
  // The overview shape exposes an employer slug → companyKey derivable.
  const o = db.classifyAts('https://www.glassdoor.com/Overview/Working-at-Acme-EI_IE12345.11,15.htm');
  assert.equal(o.ats, 'glassdoor');
  assert.equal(o.companyKey, 'acme', 'employer slug derived from the Overview URL');
  // A bare search URL with no derivable employer → null (caller supplies job.company).
  const s = db.classifyAts('https://www.glassdoor.com/Job/jobs.htm?sc.keyword=engineer');
  assert.equal(s.ats, 'glassdoor');
  assert.equal(s.companyKey, null);
});

test('a Glassdoor job upserts and is queryable by source like any other board', () => {
  const r = db.upsertJob({
    externalId: 'gd-999', source: 'glassdoor', title: 'Platform Engineer', company: 'Acme',
    location: 'Remote', jobUrl: 'https://www.glassdoor.com/job-listing/platform-engineer-acme-JV_IC1.htm?jl=999',
    status: 'started',
  });
  assert.equal(r.action, 'created');
  assert.equal(r.job.source, 'glassdoor');

  const got = db.getJob(r.job.id);
  assert.ok(got, 'job round-trips');
  assert.equal(got.title, 'Platform Engineer');
  assert.equal(got.company, 'Acme');

  const bySource = db.listJobs({ source: 'glassdoor' });
  assert.ok(bySource.some((j) => j.id === r.job.id), 'glassdoor job listed when filtering by source');
});

test('external-site learning works for a glassdoor application (not LinkedIn-only)', () => {
  const pid = db.ensureDefaultProfileId();
  // A demonstrated Glassdoor apply: a generic field (lives on the ats recipe) with real
  // locator bundle + invariant value.
  [600, 800, 1000].forEach((delayMs, i) => {
    db.recordDemonstration({
      profileId: pid, ats: 'glassdoor', companyKey: 'acme', sessionId: 'gd-sess', jobId: 'gd-job',
      stepIndex: i, action: 'fill', label: 'Years of experience', fieldType: 'number',
      selector: '#yoe', xpath: '//*[@id="yoe"]', attrs: { id: 'yoe' },
      html: '<input id="yoe">', value: '5', delayMs, source: 'manual',
    });
  });
  // A company-specific field → company overlay.
  db.recordDemonstration({
    profileId: pid, ats: 'glassdoor', companyKey: 'acme', sessionId: 'gd-sess', jobId: 'gd-job',
    stepIndex: 3, action: 'fill', label: 'Why do you want to work at Acme?',
    selector: '#why', value: 'Mission fit', delayMs: 700, source: 'manual',
  });

  const out = distiller.distillDemonstrations(pid, { sessionId: 'gd-sess', jobId: 'gd-job' });
  assert.ok(out.steps >= 2, 'glassdoor demonstrations distilled into steps');

  const resolved = db.resolveRecipe('glassdoor', 'acme', pid);
  assert.ok(resolved && resolved.steps && resolved.steps.length, 'resolveRecipe returns glassdoor steps');

  const yoeNorm = db.normalizeQuestion('Years of experience');
  const yoe = resolved.steps.find((s) => s.labelPattern === yoeNorm);
  assert.ok(yoe, 'the demonstrated generic field is in the resolved recipe');
  assert.equal(yoe.selector, '#yoe', 'real selector folded in (selector-first replay can target it)');
  assert.equal(yoe.defaultValue, '5', 'invariant value learned as the default');

  const whyNorm = db.normalizeQuestion('Why do you want to work at Acme?');
  assert.ok(resolved.steps.find((s) => s.labelPattern === whyNorm), 'company-specific field present via the company overlay');
});

test('a direct (company career site) application also learns + resolves', () => {
  const pid = db.ensureDefaultProfileId();
  db.recordDemonstration({
    profileId: pid, ats: 'direct', companyKey: 'globex', sessionId: 'dir-sess', jobId: 'dir-job',
    stepIndex: 0, action: 'fill', label: 'Authorized to work in Canada?', fieldType: 'text',
    selector: '#auth', value: 'Yes', delayMs: 500, source: 'manual',
  });
  const out = distiller.distillDemonstrations(pid, { sessionId: 'dir-sess', jobId: 'dir-job' });
  assert.ok(out.steps >= 1, 'direct-site demonstration distilled');
  const resolved = db.resolveRecipe('direct', 'globex', pid);
  const norm = db.normalizeQuestion('Authorized to work in Canada?');
  assert.ok(resolved.steps.find((s) => s.labelPattern === norm), 'direct/company-site step resolvable');
});
