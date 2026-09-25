// A SOURCE STILL BEING SEARCHED THAT HAS STOPPED RETURNING ANYTHING.
//
// This is the failure that hid for six days. LinkedIn discovery produced 12 to 50 jobs a day until
// 2026-09-02 and exactly zero on every day after, because LinkedIn moved job search to an AI-powered
// results page and the scraper's selectors stopped matching. It reported `found: 0`, which is
// precisely what a search legitimately finds when its freshness window is quiet, so a dead scraper
// and a slow week were indistinguishable. Meanwhile the lane kept spending 8 searches an hour of the
// budget that exists to protect an account restricted in August: account risk for zero return.
//
// The detector needs BOTH facts, and neither is sufficient alone. A source nobody searches any more
// is not broken, it is off. A source that has produced nothing for an hour is not broken either.
// Still spending searches AND silent for days is the combination that means something is wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const db = require_(path.join(here, '..', 'app', 'src', 'db.js'));

let dir;
test.before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-dead-')); db.open(dir); });
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

const addJob = (source, title) => db.upsertJob({
  source, title, company: `${source} co`, jobUrl: `https://example.test/${source}/${title}`,
  status: 'started', tags: ['auto-apply'],
});

test('a platform being searched with no jobs for days is reported', () => {
  db.recordPlatformTouch('linkedin', 'search');
  db.recordPlatformTouch('linkedin', 'search');
  // No linkedin job has ever been created in this database, which is the extreme of "silent".
  const dead = db.deadSources({ quietHours: 48 });
  const li = dead.find((d) => d.platform === 'linkedin');
  assert.ok(li, 'a searched platform producing nothing must be reported');
  assert.equal(li.searchesLast24h, 2);
  assert.equal(li.lastJobAt, null);
});

test('a platform that is still producing is not reported', () => {
  db.recordPlatformTouch('indeed', 'search');
  addJob('indeed', 'Backend Developer');       // created now, well inside the quiet window
  const dead = db.deadSources({ quietHours: 48 });
  assert.equal(dead.find((d) => d.platform === 'indeed'), undefined,
    'a source that produced a job today is healthy, however few it found');
});

test('a platform nobody searches any more is silent, not broken', () => {
  // glassdoor has role 'none' by default: never touched, so it must never be flagged. Otherwise
  // every deliberately disabled board would raise an alarm forever.
  const dead = db.deadSources({ quietHours: 48 });
  assert.equal(dead.find((d) => d.platform === 'glassdoor'), undefined);
});

test('the quiet window is what decides it, and it is adjustable', () => {
  // indeed produced a job seconds ago. With a quiet window of essentially zero it still should not
  // trip, because its last job is newer than any cutoff we can express here.
  const strict = db.deadSources({ quietHours: 1 });
  assert.equal(strict.find((d) => d.platform === 'indeed'), undefined);
  // linkedin has never produced one, so it trips at every window.
  assert.ok(db.deadSources({ quietHours: 1 }).find((d) => d.platform === 'linkedin'));
  assert.ok(db.deadSources({ quietHours: 720 }).find((d) => d.platform === 'linkedin'));
});

test('pipelineHealth carries it, so it reaches the dashboard and the overnight monitor', () => {
  const h = db.pipelineHealth();
  assert.ok(Array.isArray(h.deadSources), 'pipelineHealth must expose deadSources');
  assert.ok(h.deadSources.find((d) => d.platform === 'linkedin'));
});

test('it reports and never disables anything by itself', () => {
  // Turning a source off is a judgement about someone's job search. The detector says "this looks
  // dead" and stops there; the decision stays with Pierre.
  const src = fs.readFileSync(path.join(here, '..', 'app', 'src', 'db.js'), 'utf8');
  const fn = src.slice(src.indexOf('function deadSources'), src.indexOf('function pipelineHealth'));
  assert.doesNotMatch(fn, /patchSettings|UPDATE settings|boards/,
    'deadSources must not change configuration, only report');
});

test('a review queue full of rows the page already rejected is counted, not hidden', () => {
  // awaiting_review means "submitted but unproven" - the honest maybe. For some rows it is not a
  // maybe: the page answered "Your form needs corrections. Missing entry for required field: ..."
  // and the executor filed it as a maybe anyway. Fixed going forward on 2026-09-08, but the backlog
  // remained: 112 rows awaiting review, 34 carrying an explicit rejection, all on Ashby forms.
  // Those are applications the candidate believes are pending and which never went out.
  const job = db.upsertJob({
    source: 'ashby', title: 'Frontend Engineer', company: 'supabase',
    jobUrl: 'https://jobs.ashbyhq.com/supabase/false-maybe', status: 'started', tags: ['auto-apply'],
  }).job;
  const task = db.queueAdd(job.id, { mode: 'auto' });
  db.queuePatch(task.id, {
    state: 'awaiting_review',
    lastError: 'submit was clicked but could not be verified (no-post-click-change)',
    transcriptAppend: { note: 'trace:submit reject-detail nodes={conf=false "Your form needs corrections Missing entry for required field: Name"}' },
  });

  assert.equal(db.falseMaybes(), 1, 'a rejected row sitting in the review queue must be counted');
  assert.equal(db.pipelineHealth().falseMaybes, 1, 'and it must reach the dashboard');
});

test('a genuinely unproven submit is left as the honest maybe', () => {
  // The whole value of awaiting_review is that it does NOT overclaim. A row with no rejection text
  // is exactly what it says it is, and must not be swept into the rejected count.
  const before = db.falseMaybes();
  const job = db.upsertJob({
    source: 'greenhouse', title: 'Backend Engineer', company: 'someco',
    jobUrl: 'https://boards.greenhouse.io/someco/real-maybe', status: 'started', tags: ['auto-apply'],
  }).job;
  const task = db.queueAdd(job.id, { mode: 'auto' });
  db.queuePatch(task.id, {
    state: 'awaiting_review',
    lastError: 'submit was clicked but could not be verified (static-success-text-unchanged)',
    transcriptAppend: { note: 'trace:submit reject-detail nodes=(none)' },
  });
  assert.equal(db.falseMaybes(), before, 'no rejection text means it stays an honest maybe');
});
