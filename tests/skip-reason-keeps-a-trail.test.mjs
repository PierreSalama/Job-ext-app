// THE TRANSCRIPT IS DELETED THREE DAYS LATER, SO THE REASON HAS TO CARRY ITSELF.
//
// `maintenance.transcriptClearDays` is 3. A maintenance pass nulls the transcript of every TERMINAL
// task — skipped, failed, done — after that. Measured on the applier 2026-09-06: all 668 done tasks
// and all 59 "auto-apply skipped without a diagnostic" have an empty transcript, while parked and
// awaiting_review (not terminal, never pruned) keep theirs.
//
// So those 59 are permanently undiagnosable. Their last_error was written when the transcript still
// existed, the fallback said only "without a diagnostic", and the evidence is gone.
//
// last_error is NOT pruned. Carrying 140 characters of the trail into it, at the moment the reason
// is derived, is the difference between "we can find out" and "that is gone".
//
// An empty trail is worth recording too, and says something different: the skip arrived carrying
// nothing at all, which points at the reporter rather than the run.
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

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-skiptrail-'));
  db.open(dir);
  try { return fn(); } finally {
    try { db.close(); } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

const newTask = (n) => {
  const { job } = db.upsertJob({ title: 'Developer', company: `Acme ${n}`, source: 'linkedin', jobUrl: `https://example.com/${n}` });
  return db.queueAdd(job.id, 'auto');
};

test('a skip with no reason keeps a fragment of the trail', () => {
  withDb(() => {
    const t = newTask('trail');
    db.queuePatch(t.id, { state: 'skipped', transcriptAppend: { note: 'executor gave up: opener never appeared after 12s' } });
    const err = String(db.queueGet(t.id).lastError || '');
    assert.match(err, /skipped without a diagnostic/, 'still says what happened');
    assert.match(err, /trail:/, 'and carries the trail');
    assert.match(err, /opener never appeared/, 'including the part that explains it');
  });
});

test('an empty trail says so, which is itself the diagnosis', () => {
  withDb(() => {
    const t = newTask('empty');
    db.queuePatch(t.id, { state: 'skipped' });
    const err = String(db.queueGet(t.id).lastError || '');
    assert.match(err, /no transcript either/, 'the skip arrived carrying nothing');
  });
});

test('a deliberate stop is still reported as a stop, not as a mystery', () => {
  withDb(() => {
    const t = newTask('stop');
    // The REAL strings, taken from the code rather than from a note about it: app.js writes
    // 'stopped from dashboard — ...' and executor.js writes `stopped by ${reason}`. The first
    // draft of this test used 'stop-all from dashboard', a phrase from a project note, which
    // matches neither and made the pattern look broken when it is not.
    db.queuePatch(t.id, { state: 'skipped', transcriptAppend: { note: 'stopped from dashboard — returned to the queue, not skipped' } });
    const err = String(db.queueGet(t.id).lastError || '');
    assert.match(err, /stopped by you/);
    assert.doesNotMatch(err, /without a diagnostic/, 'a pause is not a failure');
  });
});

test("and the executor own stop wording is recognised too", () => {
  withDb(() => {
    const t = newTask('stop2');
    db.queuePatch(t.id, { state: 'skipped', transcriptAppend: { note: 'stopped by teardown' } });
    assert.match(String(db.queueGet(t.id).lastError || ''), /stopped by you/);
  });
});

test('a skip that already has its own reason is left alone', () => {
  withDb(() => {
    const t = newTask('own');
    db.queuePatch(t.id, { state: 'skipped', lastError: 'external posting — no Easy Apply on this job' });
    assert.equal(db.queueGet(t.id).lastError, 'external posting — no Easy Apply on this job');
  });
});

test('the fragment is bounded, so a huge transcript cannot bloat the row', () => {
  withDb(() => {
    const t = newTask('big');
    db.queuePatch(t.id, { state: 'skipped', transcriptAppend: { note: 'x'.repeat(5000) } });
    const err = String(db.queueGet(t.id).lastError || '');
    assert.ok(err.length < 260, `must stay short, got ${err.length}`);
    assert.match(err, /trail:/);
  });
});
