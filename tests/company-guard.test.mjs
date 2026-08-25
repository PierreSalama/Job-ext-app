// THE OTHER HALF OF THE v11.125.0 CROSS-CONTAMINATION FIX (defect 3b).
//
// That release stopped a post-submit confirmation heading from being accepted as a TITLE in
// ctxFromMeta, and stopped the ATS ROUTING LABEL ("job-boards") from being accepted as an
// EMPLOYER. Neither guard was complete, and the first two Affirm runs after it proved both:
//
//   task_58b8b766   company: "affirm" -> "What You'll Do"       (a job-description heading)
//   task_3f9cf09d   company: "affirm" -> "What you’ll do"
//   task_b7c16686   company: "affirm" -> "Growth)"              (the tail of its own title,
//                   "Senior Software Engineer, Backend (PBA - Growth)", split on " - ")
//   job_84e2b208    title:   "Senior Software Engineer, Fullstack (Consumer Engineering)"
//                         -> "Thank you for applying to Affirm."   -- on a VERIFIED submission,
//                   because probePage calls readPrimaryHeading() precisely WHEN the ctxFromMeta
//                   refusal has emptied the title, so the heading walked back in the side door.
//
// Every assertion below is written against one of those measured values.
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

const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const declLine = (src, name) => src.split(/\r?\n/).find((l) => l.startsWith(`const ${name} =`));

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-companyguard-')); db.open(dir); });
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// ── 1. the predicate ─────────────────────────────────────────────────────────────────────────
test('isImplausibleCompany refuses every employer value the live corruption produced', () => {
  for (const v of [
    "What You'll Do", 'What you’ll do',        // JD section heading (both apostrophes)
    'Growth)',                                  // unbalanced fragment cut out of a title
    'About Tailscale', 'Back to jobs',          // page chrome
    'Team Member Resource Groups',
    'We champion every identity.',              // marketing sentence
    'Learn. Develop. Succeed',                  // internal sentence breaks
    'job-boards', 'boards', 'smartapply', 'embed', 'careers', 'apply', 'greenhouse', 'lever',
  ]) {
    assert.equal(db.isImplausibleCompany(v), true, `should refuse ${JSON.stringify(v)}`);
  }
});

test('isImplausibleCompany accepts real employers, including the awkward ones', () => {
  for (const v of [
    'affirm', 'Affirm', 'gitlab', 'faire', 'Geotab', 'robinhood', 'tenstorrent',
    'Delos Data Inc', '8090 Solutions Inc',     // both live rows a naive URL-token check flags
    'Later', 'Owner',                           // real companies whose names are common words
    'Booking.com',                              // a period that is not a sentence break
    'Ernst & Young', 'Hootsuite', 'Ping Identity', 'Wellfound (formerly AngelList)',
  ]) {
    assert.equal(db.isImplausibleCompany(v), false, `should accept ${JSON.stringify(v)}`);
  }
  // Absent is not implausible — an empty company is the honest outcome the guard aims for.
  assert.equal(db.isImplausibleCompany(''), false);
  assert.equal(db.isImplausibleCompany(null), false);
});

// ── 2. the regression, at the storage boundary ───────────────────────────────────────────────
test('upsertJob keeps the real employer when a page heading arrives (the Affirm regression)', () => {
  const jobUrl = 'https://job-boards.greenhouse.io/affirm/jobs/7663436003';
  const first = db.upsertJob({
    externalId: 'gh-7663436003', source: 'greenhouse', status: 'started', jobUrl,
    title: 'Senior Software Engineer, Fullstack (Consumer Engineering)', company: 'affirm',
  });
  assert.equal(first.job.company, 'affirm');

  // The capture that ran on the Affirm application page, verbatim.
  const second = db.upsertJob({
    externalId: 'gh-7663436003', source: 'greenhouse', status: 'started', jobUrl,
    title: 'Senior Software Engineer, Fullstack (Consumer Engineering)', company: "What You'll Do",
  });
  assert.equal(second.job.company, 'affirm', 'the row must keep the employer it already had');
});

test('upsertJob keeps the real title when a confirmation heading arrives', () => {
  const jobUrl = 'https://job-boards.greenhouse.io/affirm/jobs/7806920003';
  db.upsertJob({
    externalId: 'gh-7806920003', source: 'greenhouse', status: 'started', jobUrl,
    title: 'Senior Machine Learning Engineer (Fraud)', company: 'affirm',
  });
  // The post-submit capture: a confirmation page at the posting's own URL.
  const after = db.upsertJob({
    externalId: 'gh-7806920003', source: 'greenhouse', status: 'submitted', jobUrl,
    title: 'Thank you for applying to Affirm.', company: 'affirm',
  });
  assert.equal(after.job.title, 'Senior Machine Learning Engineer (Fraud)');
  assert.equal(after.job.status, 'submitted', 'the submission must still be credited');
});

test('a brand-new capture carrying only a heading creates no employer rather than a wrong one', () => {
  const r = db.upsertJob({
    externalId: 'gh-newrow-1', source: 'greenhouse', status: 'started',
    jobUrl: 'https://job-boards.greenhouse.io/someco/jobs/1',
    title: 'Staff Engineer', company: 'Back to jobs',
  });
  assert.equal(r.action, 'created');
  assert.equal(r.job.company, '', 'blank is honest; "Back to jobs" is not');
});

// ── 3. the repair ────────────────────────────────────────────────────────────────────────────
test('atsCompanyFromUrl reads the employer an ATS board states in its own path', () => {
  assert.equal(db.atsCompanyFromUrl('https://job-boards.greenhouse.io/affirm/jobs/7663436003'), 'affirm');
  assert.equal(db.atsCompanyFromUrl('https://boards.greenhouse.io/faire/jobs/8465041002?gh_jid=1'), 'faire');
  assert.equal(db.atsCompanyFromUrl('https://jobs.lever.co/someco/abc-123'), 'someco');
  assert.equal(db.atsCompanyFromUrl('https://jobs.ashbyhq.com/otherco/xyz'), 'otherco');
  // Greenhouse's iframe route names no company, and a non-ATS URL names none either.
  assert.equal(db.atsCompanyFromUrl('https://boards.greenhouse.io/embed/job_app?token=1'), '');
  assert.equal(db.atsCompanyFromUrl('https://www.linkedin.com/jobs/view/4440016720/'), '');
});

test('repairImplausibleCompanies restores only what the URL states, and is idempotent', () => {
  const rows = [
    ['rp-1', 'https://job-boards.greenhouse.io/affirm/jobs/9000001', "What You'll Do", 'affirm'],
    ['rp-2', 'https://job-boards.greenhouse.io/gitlab/jobs/9000002', 'job-boards', 'gitlab'],
    ['rp-3', 'https://job-boards.greenhouse.io/dialpad/jobs/9000003', 'Back to jobs', 'dialpad'],
  ];
  for (const [ext, jobUrl, company] of rows) {
    db.upsertJob({ externalId: ext, source: 'greenhouse', status: 'started', jobUrl, title: 'Dev ' + ext, company: 'placeholder' });
    // Write the corruption the way the un-guarded build did — straight onto the row.
    const id = db.listJobs({}).find((j) => j.externalId === ext).id;
    db.patchJob(id, { company });
  }
  // A row that merely LOOKS odd is not evidence of corruption and must be left alone.
  db.upsertJob({
    externalId: 'rp-keep', source: 'greenhouse', status: 'started',
    jobUrl: 'https://job-boards.greenhouse.io/delosdata/jobs/9000004',
    title: 'System Software Engineer - AI', company: 'Delos Data Inc',
  });

  const fixed = db.repairImplausibleCompanies();
  const byExt = Object.fromEntries(db.listJobs({}).map((j) => [j.externalId, j]));
  for (const [ext, , , expected] of rows) {
    assert.equal(byExt[ext].company, expected, `${ext} should be repaired to ${expected}`);
  }
  assert.equal(byExt['rp-keep'].company, 'Delos Data Inc', 'a plausible employer is never overwritten');
  assert.ok(fixed.length >= rows.length);

  assert.deepEqual(db.repairImplausibleCompanies(), [], 'a second run must find nothing left to do');
});

// ── 4. the two copies of each rule must not drift ────────────────────────────────────────────
// The guard exists twice on purpose: the extension copy stops the value at the source, the db.js
// copy protects the store from extension builds already deployed. Two copies of a rule is a
// drift hazard, so pin them byte-for-byte.
test('db.js and the extension enforce byte-identical rules', () => {
  const server = read('app', 'src', 'db.js');
  const forms = read('extension', 'content', 'signals', 'forms.js');
  const detector = read('extension', 'content', 'detector.js');

  for (const name of ['COMPANY_ROUTING_RX', 'JD_SECTION_HEADING_RX', 'SENTENCE_OPENER_RX', 'INTERNAL_SENTENCE_BREAK_RX']) {
    const a = declLine(server, name);
    const b = declLine(forms, name);
    assert.ok(a, `${name} missing from db.js`);
    assert.ok(b, `${name} missing from forms.js`);
    assert.equal(a, b, `${name} has drifted between db.js and forms.js`);
  }
  const t1 = declLine(server, 'CONFIRMATION_TITLE_RX');
  const t2 = declLine(detector, 'CONFIRMATION_TITLE_RX');
  assert.ok(t1 && t2);
  assert.equal(t1, t2, 'CONFIRMATION_TITLE_RX has drifted between db.js and detector.js');
});

// ── 5. the extension side, at the two functions that manufacture a company ───────────────────
test('the extension filters every company it guesses, and never re-reads a confirmation heading', () => {
  const forms = read('extension', 'content', 'signals', 'forms.js');
  const detector = read('extension', 'content', 'detector.js');

  // inferFromApplyHeader produces a company three ways — the "apply for X at Y" match, the
  // "Title — Company" heading split, and findNearbyCompanyText. Every one must go through
  // keepCompany, so assert on the SOURCES of the value rather than counting return shapes
  // (the third path returns `company` by shorthand).
  const start = forms.indexOf('export function inferFromApplyHeader()');
  assert.ok(start > 0, 'inferFromApplyHeader not found');
  const body = forms.slice(start, forms.indexOf('\n  return null;\n}', start));
  assert.match(body, /company: keepCompany\(match\[2\]\)/, 'the "apply for X at Y" path is unguarded');
  assert.match(body, /company: keepCompany\(parts\[1\]\)/, 'the heading-split path is unguarded');
  assert.match(body, /keepCompany\(findNearbyCompanyText\(h\)\)/, 'the nearby-text path is unguarded');
  // and nothing else in the body may hand back a raw value.
  const raw = (body.match(/company:\s*[^,}\n]+/g) || []).filter((r) => !/keepCompany\(/.test(r));
  assert.deepEqual(raw, [], `unguarded company path(s): ${raw.join(' | ')}`);

  // findCompanyLink must reject page chrome rather than return it.
  assert.match(forms, /if \(isImplausibleCompany\(text\)\) continue;/);

  // readPrimaryHeading is the side door the confirmation heading used.
  const rphStart = detector.indexOf('function readPrimaryHeading()');
  assert.ok(rphStart > 0, 'readPrimaryHeading not found');
  const rph = detector.slice(rphStart, detector.indexOf("\n  return '';\n}", rphStart));
  assert.match(rph, /CONFIRMATION_TITLE_RX\.test\(text\)\) continue;/);
});

// ── 6. the answer the AI-answer pass tried to write on its first working run ─────────────────
// "JAT AI Answers" had returned HTTP 500 for every question since it was written (an object
// schema without `additionalProperties: false`, which OpenAI structured outputs reject). With
// that fixed it produced, for Hootsuite's Salesforce screening question, the option string
// LinkedIn actually ships — the answer text with its form-element URN glued on.
test('a scraped LinkedIn form-element URN is never stored as an answer', () => {
  const urnOption = 'no no urn:li:fsd_formelement:urn:li:jobs_applyformcommon_easyapplyformelement:(4440016720,34185170082,multiplechoice)';
  assert.equal(db.isOpaqueTokenAnswer(urnOption), true);

  const pid = db.ensureDefaultProfileId();
  const q = 'Do you have at least 5 years hands on experience with Salesforce?';
  assert.equal(db.profileFieldUpsert({ profileId: pid, question: q, value: urnOption, fromUser: true, confidence: 1 }), null);
  assert.equal(db.profileFieldLookup(pid, q), null, 'nothing may have been written');

  // The real answer behind it still stores fine — the guard rejects the identifier, not the verdict.
  assert.ok(db.profileFieldUpsert({ profileId: pid, question: q, value: 'No', fromUser: true, confidence: 1 }));
  assert.equal(db.profileFieldLookup(pid, q)?.value, 'No');

  // qa is the other half of memory and must refuse it too.
  assert.equal(db.qaRecord({ profileId: pid, question: q + ' (qa)', answer: urnOption }), null);

  // Ordinary answers, including ones with colons and brackets, are untouched.
  for (const v of ['No', 'Ontario', 'Toronto, Ontario, Canada', 'Wellfound (formerly AngelList)', 'Available: immediately']) {
    assert.equal(db.isOpaqueTokenAnswer(v), false, `should accept ${JSON.stringify(v)}`);
  }
});

test('the AI-answer pass refuses the same value before it claims a save', () => {
  const src = read('tools', 'ai-answer-parked.mjs');
  assert.match(src, /additionalProperties: false/, 'the schema fix must stay — without it every call is HTTP 500');
  // additionalProperties:false requires EVERY property to be listed in `required`.
  const props = (src.match(/properties: \{([\s\S]*?)\n    \},/) || [])[1] || '';
  const declared = [...props.matchAll(/^\s{6}(\w+):/gm)].map((m) => m[1]);
  const required = JSON.parse((src.match(/required: (\[[^\]]*\])/) || [])[1].replace(/'/g, '"'));
  assert.deepEqual(declared.sort(), [...required].sort(), 'every declared property must also be required');
  assert.match(src, /JUNK \(\$\{conf\.toFixed\(2\)\}\)/, 'a URN answer must be reported, not silently dropped');
});

// A stylesheet is not an employer. Both strings below are VERBATIM from Pierre's own database
// (2 rows in 1500, both Indeed) — Indeed inlines a <style> block beside the company element and
// the scraper's fallback selector swallowed the whole rule. Caught server-side on ingest so the
// fix protects every source and needs no extension reload to take effect.
test('a CSS rule scraped in place of the employer is refused', () => {
  const real = ".css-1h4l2d7{font-family:'Indeed Sans','Noto Sans','Helvetica Neue',Helvetica,Arial,'Liberation Sans',Roboto,Noto,sans-serif;-webkit-text-decoration:underline solid currentcolor 0.06em;text-decoration:underline solid currentcolor 0.06em;text-decoration-skip-ink:none;text-underline-offset:0.25em;text";
  assert.equal(db.isImplausibleCompany(real), true, 'the real Indeed stylesheet must be refused');

  for (const v of [
    '.css-1h4l2d7{font-family:Arial}',
    'display:flex',
    '-webkit-text-decoration:underline',
    'a{text-decoration:none}',
  ]) {
    assert.equal(db.isImplausibleCompany(v), true, `should refuse ${JSON.stringify(v)}`);
  }

  // ...and it must not start refusing real employers. These are all genuine companies from the
  // same dataset, including the awkward ones with punctuation, taglines and long legal names.
  for (const v of [
    'Fortify Services', 'Picton Mahoney Asset Management', 'gitlab', 'faire', 'robinhood',
    'Wenco (a Hitachi Construction Machinery subsidiary)',
    'Delta Intelligent Building Technologies (Canada) Inc.',
    'Btech Studio', 'Amaris Consulting', 'Hootsuite', 'AYHAN’S Barbershop',
    'Display Technologies Inc.', 'Sans Serif Media', 'Text Inc.',
  ]) {
    assert.equal(db.isImplausibleCompany(v), false, `should accept ${JSON.stringify(v)}`);
  }
});
