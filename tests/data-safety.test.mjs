// v11.14 data-safety + privacy: EEO answers never harvested, export/import of the
// learned memory round-trips, import validates + backs up, wipe takes a recovery
// snapshot. Runs against a temp DB.
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
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-ds-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('EEO / demographic answers are NEVER harvested into profile memory', () => {
  const pid = db.ensureDefaultProfileId();
  db.upsertJob({
    externalId: 'eeo1', title: 'Dev', company: 'Acme', source: 'linkedin', status: 'started', jobUrl: 'https://x/eeo1',
    answers: { years_of_experience: '5', gender: 'Male', 'disability status': 'No', veteran_status: 'No', first_name: 'Zed' },
  });
  const labels = db.profileFieldList(pid).map((f) => (f.label || '').toLowerCase()).join(' | ');
  assert.ok(/experience/.test(labels) || /first name/.test(labels), 'non-sensitive answers ARE harvested');
  assert.ok(!/gender|disabilit|veteran/.test(labels), 'gender / disability / veteran are NOT harvested');
});

test('export includes the learned memory and import restores it (round-trip)', () => {
  const pid = db.ensureDefaultProfileId();
  db.profileFieldUpsert({ profileId: pid, question: 'Years of Python?', value: '7', fromUser: true });
  const exp = db.exportAll();
  assert.ok(Array.isArray(exp.profileFields), 'export has a profileFields array');
  assert.ok(exp.profileFields.some((f) => /python/i.test(f.question) && f.value === '7'), 'the learned field is in the export');

  const r = db.importAll({ jobs: [], profileFields: [{ profileId: pid, question: 'Years of Rust?', value: '3' }] });
  assert.ok(r.profileFields >= 1, 'import reports restored profile fields');
  assert.ok('backup' in r, 'import returns a pre-import backup field');
  assert.ok(db.profileFieldList(pid).some((f) => /rust/i.test(f.label) && f.value === '3'), 'imported field is in memory');
});

test('import refuses sensitive fields and a non-export payload', () => {
  const pid = db.ensureDefaultProfileId();
  db.importAll({ jobs: [], profileFields: [{ profileId: pid, question: 'Gender identity', value: 'X' }] });
  assert.ok(!db.profileFieldList(pid).some((f) => /gender/i.test(f.label)), 'import drops sensitive fields too');
  assert.throws(() => db.importAll({ foo: 'bar' }), /not a JAT export/);
});

test('wipeAllData returns a recovery backup (the nuke button is reversible)', () => {
  const r = db.wipeAllData();   // last test — it clears the temp DB
  assert.equal(r.ok, true);
  assert.ok('backup' in r, 'wipe returns a backup field');
});
