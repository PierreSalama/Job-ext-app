// An application he actually made must always be matchable, however old.
//
// `jobsForMatching` used to be "the 2000 newest rows". That was fine when the ledger held
// applications. It stopped being fine once discovery started adding thousands of untouched
// postings: the window filled with jobs nobody had applied to and pushed the real applications out.
// Measured on the server laptop on 2026-09-04, 51 of 396 submitted rows were outside it, so a
// rejection or an interview invitation for any of them could never be matched to anything at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const db = require(path.join(root, 'app/src/db.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-matchwin-'));
db.open(dir);
process.on('exit', () => {
  try { db.close(); } catch { /* already closed */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
});

// The oldest row in the ledger, and the only one he ever actually applied to.
const OLD = db.upsertJob({
  company: 'Oldcorp', title: 'Software Developer', status: 'submitted',
  jobUrl: 'https://jobs.lever.co/oldcorp/1',
}).job;

test('a real application older than 2000 discovery rows is still matchable', () => {
  // Bury it, exactly the way discovery buries things.
  for (let i = 0; i < 2100; i++) {
    db.upsertJob({ company: `Discovered ${i}`, title: 'Engineer', status: 'started', jobUrl: `https://jobs.lever.co/d${i}/1` });
  }
  const ids = new Set(db.jobsForMatching().map((j) => j.id));
  assert.equal(ids.has(OLD.id), true, 'the one job he applied to must not fall out of the window');
});

test('recent untouched postings are still candidates', () => {
  // A confirmation email often arrives before the row has been marked anything at all.
  const fresh = db.upsertJob({ company: 'Freshco', title: 'Engineer', status: 'started', jobUrl: 'https://jobs.lever.co/freshco/1' }).job;
  assert.equal(db.jobsForMatching().some((j) => j.id === fresh.id), true);
});

test('every engaged state counts, not only submitted', () => {
  const made = [];
  for (const status of ['rejected', 'ghosted', 'interview_1', 'offer', 'contacted']) {
    made.push(db.upsertJob({ company: `${status}corp`, title: 'Engineer', status, jobUrl: `https://jobs.lever.co/${status}/1` }).job);
  }
  // Bury them too.
  for (let i = 0; i < 2100; i++) {
    db.upsertJob({ company: `Later ${i}`, title: 'Engineer', status: 'started', jobUrl: `https://jobs.lever.co/l${i}/1` });
  }
  const ids = new Set(db.jobsForMatching().map((j) => j.id));
  for (const j of made) assert.equal(ids.has(j.id), true, `${j.status} must stay matchable`);
});

test('no job is offered twice', () => {
  // It is a UNION of two overlapping sets, and a duplicate candidate would skew every match score.
  const rows = db.jobsForMatching();
  assert.equal(new Set(rows.map((j) => j.id)).size, rows.length);
});
