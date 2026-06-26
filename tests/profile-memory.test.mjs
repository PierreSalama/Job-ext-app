// Per-profile memory: isolation between profiles, the profile↔memory bridges, and
// source-routed harvest. Runs against a real temp DB (the v6 migration scopes
// profile_fields + qa to a profile and seeds a default home).
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
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-pm-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('a default profile + memory home always exists', () => {
  const pid = db.ensureDefaultProfileId();
  assert.ok(pid, 'default profile id');
  assert.ok(db.listProfiles().some((p) => p.id === pid));
});

test('memory is isolated per profile (fields + qa)', () => {
  const a = db.saveProfile({ name: 'A', data: { firstName: 'Ann' } });
  const b = db.saveProfile({ name: 'B', data: { firstName: 'Bob' } });
  db.profileFieldUpsert({ profileId: a.id, question: 'Years of React?', value: '5', fromUser: true });
  assert.equal(db.profileFieldList(a.id).length, 1, 'A has the field');
  assert.equal(db.profileFieldList(b.id).length, 0, "B does not see A's memory");
  assert.ok(db.qaLookup(a.id, 'Years of React?'), 'A qa lookup hits');
  assert.equal(db.qaLookup(b.id, 'Years of React?'), null, 'B qa lookup misses');
});

test('dropdown PLACEHOLDERS ("Select an option") are never stored or served as answers', () => {
  const p = db.saveProfile({ name: 'PH', data: {} });
  // write-side: placeholders are rejected (profile_fields + the mirrored qa)
  for (const junk of ['Select an option', 'Choose...', 'Select', '--', 'Sélectionner', 'Please select an option']) {
    assert.equal(db.profileFieldUpsert({ profileId: p.id, question: `Q ${junk}?`, value: junk, fromUser: true }), null, `rejected: ${junk}`);
    assert.equal(db.qaRecord({ profileId: p.id, question: `Q ${junk}?`, answer: junk }), null, `qa rejected: ${junk}`);
  }
  assert.equal(db.profileFieldList(p.id).length, 0, 'no placeholder fields stored');
  // real answers — including ones that merely START with select/choose — ARE stored
  for (const real of ['Yes', 'Selected for the role', 'Choose Health Plan B', 'None', '5 years']) {
    assert.ok(db.profileFieldUpsert({ profileId: p.id, question: `R ${real}?`, value: real, fromUser: true }), `kept: ${real}`);
  }
  assert.equal(db.profileFieldList(p.id).length, 5, 'all real answers stored');
  // read-side: even a directly-saved placeholder is not served by lookup/answerMemory
  assert.equal(db.qaLookup(p.id, 'R Yes?')?.answer, 'Yes', 'real answer still served');
});

test('the same question holds DIFFERENT values in two profiles', () => {
  const a = db.listProfiles().find((p) => p.name === 'A');
  const b = db.listProfiles().find((p) => p.name === 'B');
  db.profileFieldUpsert({ profileId: a.id, question: 'Willing to relocate?', value: 'Yes', fromUser: true });
  db.profileFieldUpsert({ profileId: b.id, question: 'Willing to relocate?', value: 'No', fromUser: true });
  assert.equal(db.profileFieldLookup(a.id, 'Willing to relocate?').value, 'Yes');
  assert.equal(db.profileFieldLookup(b.id, 'Willing to relocate?').value, 'No');
});

test('bridge: push profile → memory, then derive memory → profile', () => {
  const c = db.saveProfile({ name: 'C', data: {} });
  const r = db.pushProfileDataToMemory(c.id, {
    firstName: 'Cara', email: 'cara@x.io', skills: ['js'], summary: 'hi',
    workHistory: [{ title: 'Dev', company: 'X' }], educationHistory: [{ degree: 'BSc' }],
  });
  assert.equal(r.pushed, 2, 'only firstName + email pushed (skills/summary/work/education arrays skipped)');
  const derived = db.memoryToProfileData(c.id);
  assert.equal(derived.firstName, 'Cara');
  assert.equal(derived.email, 'cara@x.io');
  assert.equal(db.profileFieldList(c.id).some((f) => /summary/i.test(f.label)), false, 'summary not pushed to memory');
  assert.equal(db.profileFieldList(c.id).some((f) => /\[object Object\]/.test(f.value)), false, 'no array-as-text leaked into memory');
});

test('harvest routes a job\'s answers to the source-matched profile', () => {
  const lp = db.saveProfile({ name: 'LinkedInProf', sourceAssignments: ['linkedin'], data: {} });
  db.upsertJob({ title: 'Dev', company: 'Acme', source: 'linkedin', status: 'started', jobUrl: 'https://x/h1', answers: { first_name: 'Zed' } });
  const got = db.profileFieldList(lp.id).find((f) => /first name/i.test(f.label));
  assert.ok(got && got.value === 'Zed', 'job answer harvested into the source-matched profile');
});

test('deleting a profile cascades away its memory; siblings untouched', () => {
  const x = db.saveProfile({ name: 'Temp', data: {} });
  db.profileFieldUpsert({ profileId: x.id, question: 'Temp question?', value: 'v', fromUser: true });
  assert.equal(db.profileFieldList(x.id).length, 1);
  db.deleteProfile(x.id);
  assert.equal(db.profileFieldList(x.id).length, 0, "deleted profile's memory cascaded away");
  const a = db.listProfiles().find((p) => p.name === 'A');
  assert.ok(db.profileFieldList(a.id).length >= 1, 'sibling profile memory untouched');
});
