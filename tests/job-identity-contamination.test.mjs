// JOB RECORDS CROSS-CONTAMINATED BY WHATEVER PAGE WAS SEEN LAST.
//
// Live on pierre-laptop 2026-08-24, after the ATS lane's first seven real submissions:
//
//   externalId   company                       title                                    url
//   -------------------------------------------------------------------------------------------
//   8715968002   job-boards                    Thank you for applying                   /gitlab/jobs/8715968002
//   8637549002   job-boards                    Thank you for applying                   /gitlab/jobs/8637549002
//   8682707002   job-boards                    Sr. Software Engineer (Hardware)         /gitlab/jobs/8682707002   ← a DIALPAD title
//   8661336002   job-boards                    Thank you for applying                   /dialpad/jobs/8661336002
//   8644572002   job-boards                    Thank you for applying                   /gitlab/jobs/8644572002
//   8451512002   job-boards                    Thank you for applying                   /gitlab/jobs/8451512002
//   8644569002   Team Member Resource Groups   Intermediate Backend Engineer…           /gitlab/jobs/8644569002
//
// Two independent causes, both exercised here.
//
//  A. The post-submit CONFIRMATION page was captured as job identity. Greenhouse renders "Thank you
//     for applying" at the same URL the posting was served from, so the passive capture that fires
//     on that document rewrote the row it matched by URL — title from the confirmation heading,
//     company from hostCompanyFallback() on "job-boards.greenhouse.io".
//
//  B. loadHandoff() ignored handoffKey() entirely and returned the newest fresh handoff from ANY
//     tab in the profile. With a warm apply tab cycling jobs and a parallel pool running several,
//     a page whose own identity looked weak adopted whichever job was last seen anywhere. GitLab
//     8682707002 and Dialpad 8661336002 finished six seconds apart.
//
// This file tests the server-side invariants (A's landing point, plus the "an untitled capture must
// never MINT a job" rule). The client-side identity rules are in detector-identity.test.mjs.
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
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-contam-')); db.open(dir); });
test.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const GITLAB_URL = 'https://job-boards.greenhouse.io/gitlab/jobs/8715968002';

test('the confirmation page credits the submission WITHOUT renaming the job', () => {
  // discovery captured the real posting…
  const created = db.upsertJob({
    externalId: 'greenhouse:8715968002', source: 'greenhouse', title: 'Senior Backend Engineer',
    company: 'gitlab', jobUrl: GITLAB_URL, status: 'started',
  });
  assert.equal(created.job.title, 'Senior Backend Engineer');

  // …and then the confirmation page fires a passive capture. With the detector fix its title and
  // company arrive EMPTY (a confirmation heading is not a job title, and "job-boards" is not a
  // company), and the URL still matches — so the row is elevated to submitted and keeps its name.
  const after = db.upsertJob({
    externalId: '8715968002', source: 'greenhouse', title: '', company: '',
    jobUrl: GITLAB_URL, status: 'submitted',
  });
  assert.equal(after.job.id, created.job.id, 'same row — matched by URL');
  assert.equal(after.job.status, 'submitted', 'the submission IS credited');
  assert.equal(after.job.title, 'Senior Backend Engineer', 'the title is NOT overwritten');
  assert.equal(after.job.company, 'gitlab', 'the company is NOT overwritten');
});

test('an untitled capture that matches nothing is REFUSED, never minted as a job', () => {
  const before = db.listJobs({ limit: 1000 }).length;
  const r = db.upsertJob({
    externalId: '', source: 'greenhouse', title: '', company: '',
    jobUrl: 'https://job-boards.greenhouse.io/somewhere/confirmation', status: 'submitted',
  });
  assert.equal(r.action, 'rejected');
  assert.equal(r.job, null);
  assert.equal(r.statusChanged, false, 'callers branch on this — it must not fire');
  assert.equal(db.listJobs({ limit: 1000 }).length, before, 'no ghost row');
});

test('a real job with a title is still created normally', () => {
  const r = db.upsertJob({
    externalId: 'greenhouse:8661336002', source: 'greenhouse', title: 'Sr. Software Engineer (Hardware)',
    company: 'dialpad', jobUrl: 'https://job-boards.greenhouse.io/dialpad/jobs/8661336002', status: 'started',
  });
  assert.equal(r.action, 'created');
  assert.equal(r.job.title, 'Sr. Software Engineer (Hardware)');
});

test('the Dialpad title can no longer land on the GitLab row', () => {
  // What actually happened: a capture carrying Dialpad's identity was written against GitLab's URL.
  // The row is matched by URL, so a WRONG title still wins if it is non-empty — which is why the
  // real fix is upstream, at the point the identity is chosen (detector-identity.test.mjs). What
  // this pins is the half the server owns: with the identity suppressed, the row survives intact.
  const gitlab = db.listJobs({ limit: 1000 }).find((j) => j.jobUrl === GITLAB_URL);
  assert.equal(gitlab.title, 'Senior Backend Engineer');
  assert.equal(gitlab.company, 'gitlab');
});
