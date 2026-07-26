// Turning the engine OFF is not a decision about any job.
//
// The dashboard Stop button used to patch every queued / scheduled / running task to 'skipped' --
// terminal, never re-dispatched -- so pressing Stop threw the whole backlog away. Live 2026-07-20:
// 73 rows carried the "stopped from dashboard" note, 70 of them still skipped and 67 never
// attempted. That is the single most destructive control in the app, and it is the one Pierre
// presses every time he wants to look at the results.
//
// Queued/scheduled tasks are now left untouched (autoApply.enabled is already false, so nothing
// dispatches them). A running task is returned to 'queued' so it is retried, not lost.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = fs.readFileSync(path.join(here, '..', 'extension', 'app', 'app.js'), 'utf8');
const mirror = fs.readFileSync(path.join(here, '..', 'app', 'src', 'app', 'app.js'), 'utf8');

// The stop handler: from the autoApply disable PATCH to the tab teardown.
const stopBlock = (() => {
  const i = ext.indexOf("await api('/settings', { method: 'PATCH', body: { autoApply: { enabled: false } } });");
  assert.ok(i > -1, 'stop handler not found');
  return ext.slice(i, ext.indexOf('stopAutoApplyTabs()', i));
})();

test('stopping does not skip anything', () => {
  assert.doesNotMatch(stopBlock, /state: 'skipped'/,
    "regression: Stop must never write a terminal 'skipped' — that discards the backlog");
});

test('queued and scheduled tasks are left alone entirely', () => {
  assert.doesNotMatch(stopBlock, /'queued', 'scheduled', 'running'/,
    'the old sweep patched every pending task; queued/scheduled must not be touched at all');
  assert.match(stopBlock, /t\.state === 'running'/, 'only a running task needs standing down');
});

test('a running task goes back to the queue, not to a terminal state', () => {
  assert.match(stopBlock, /state: 'queued'/, 'the interrupted task must be retried later');
  assert.match(stopBlock, /returned to the queue, not skipped/, 'and say so in its history');
});

test('the dashboard mirror stays byte-identical', () => {
  // extension/app/* and app/src/app/* must not drift: the extension and the desktop app serve the
  // same dashboard, and a fix applied to one only is a fix the other silently lacks.
  assert.equal(ext, mirror, 'run tools/mirror.mjs — the dashboard copies have diverged');
});
