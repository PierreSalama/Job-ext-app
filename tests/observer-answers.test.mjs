// P1 (Apprenticeship Engine) — the always-on Observer records every manual application's
// answers, stamped with `answer_lineage` (source 'manual'), independent of the auto-apply
// queue, with the credential rail still excluding sensitive fields. Fixtures model what
// snapshotAnswers() posts for a Workday + a Greenhouse manual apply. Temp DB.
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
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-ob-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('a manually-observed Workday apply harvests answers stamped with manual lineage', () => {
  const pid = db.ensureDefaultProfileId();
  db.upsertJob({
    externalId: 'wd1', title: 'Software Engineer', company: 'Rogers', source: 'workday', status: 'submitted',
    jobUrl: 'https://rogers.wd3.myworkdayjobs.com/job/wd1',
    answers: {
      'Years of experience with Java': '4',
      'Are you legally authorized to work in Canada?': 'Yes',
      password: 'secret',                 // credential — must be excluded
    },
  });
  const m = db.qaLookup(pid, 'Years of experience with Java');
  assert.ok(m && m.answer === '4', 'the answer was harvested');
  const lineage = JSON.parse(m.answer_lineage || '[]');
  assert.ok(Array.isArray(lineage) && lineage.length >= 1, 'answer_lineage was recorded');
  assert.equal(lineage[lineage.length - 1].source, 'manual', 'stamped as manually observed');
  assert.ok('ts' in lineage[0] && 'matched_label' in lineage[0], 'lineage carries ts + matched_label');
  assert.equal(db.qaLookup(pid, 'password'), null, 'credential never reaches qa memory');
});

test('capture is independent of the auto-apply queue (works with queue never started)', () => {
  // harvest gates on settings.harvest, NOT on auto-apply being enabled — observing a
  // manual apply records memory even though no auto-apply run ever happened in this DB.
  const pid = db.ensureDefaultProfileId();
  db.upsertJob({
    externalId: 'gh1', title: 'Frontend Dev', company: 'Shopify', source: 'greenhouse', status: 'submitted',
    jobUrl: 'https://boards.greenhouse.io/shopify/jobs/gh1',
    answers: { 'Preferred pronouns': 'n/a', 'How many years of React?': '3' },   // pronouns dropped by rail
  });
  const m = db.qaLookup(pid, 'How many years of React?');
  assert.ok(m && m.answer === '3', 'observed answer stored with the queue off');
  assert.equal(JSON.parse(m.answer_lineage)[0].source, 'manual', 'manual lineage');
});

test('re-observing the same question appends to lineage (capped trail, answer updated)', () => {
  const pid = db.ensureDefaultProfileId();
  db.upsertJob({ externalId: 'wd1b', title: 'SWE', company: 'Rogers', source: 'workday', status: 'submitted',
    jobUrl: 'https://rogers.wd3.myworkdayjobs.com/job/wd1b',
    answers: { 'Years of experience with Java': '5' } });
  const m = db.qaLookup(pid, 'Years of experience with Java');
  assert.equal(m.answer, '5', 'newest observation wins');
  assert.ok(JSON.parse(m.answer_lineage).length >= 2, 'lineage grew across observations');
});
