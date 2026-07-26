// The CPU/lag report has survived several attempts because nothing measured anything. Two
// hypotheses were tested this round and BOTH were wrong:
//   • "orphaned Python discovery workers pin the CPU" — the long-lived python processes on this
//     machine (272 CPU-seconds, ~19h old) belong to a Claude Desktop MCP extension. JAT was not
//     even running.
//   • "child.kill() leaks the py→python grandchild on Windows" — there IS a grandchild, but the
//     direct kill cleaned it up. Measured.
// So the deliverable is measurement, not another guess. What matters is that the sample NAMES the
// process type responsible, rather than blaming "the app".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { createPerfSampler, summarizeMetrics } = require(path.join(here, '..', 'app', 'src', 'perf.js'));

// Shaped exactly like Electron's app.getAppMetrics(): percentCPUUsage is percent of ONE core,
// workingSetSize is KB.
const METRICS = [
  { type: 'Browser', cpu: { percentCPUUsage: 12.5 }, memory: { workingSetSize: 204800 } },
  { type: 'Tab', cpu: { percentCPUUsage: 78.4 }, memory: { workingSetSize: 512000 } },
  { type: 'Tab', cpu: { percentCPUUsage: 6.1 }, memory: { workingSetSize: 102400 } },
  { type: 'GPU', cpu: { percentCPUUsage: 3.0 }, memory: { workingSetSize: 51200 } },
];

test('the breakdown names the process type actually burning CPU', () => {
  const s = summarizeMetrics(METRICS);
  assert.equal(s.topType, 'Tab', 'renderers dominate here — that is the diagnostic');
  assert.equal(s.procCount, 4);
  assert.equal(s.totalCpu, 100);
  const tab = s.byType.find((p) => p.type === 'Tab');
  assert.equal(tab.count, 2, 'same-type processes are aggregated');
  assert.equal(tab.cpu, 84.5);
});

test('memory is reported in MB from Electron KB', () => {
  const s = summarizeMetrics(METRICS);
  assert.equal(s.totalMemMB, 200 + 500 + 100 + 50);
});

test('malformed or empty metrics never throw', () => {
  for (const bad of [null, undefined, [], [{}], [{ type: 'X' }], 'nope', [{ cpu: null, memory: null }]]) {
    const s = summarizeMetrics(bad);
    assert.equal(typeof s.totalCpu, 'number');
    assert.ok(Number.isFinite(s.totalCpu));
  }
});

test('a sample records the worker count and what the app was doing', () => {
  const rows = [];
  const s = createPerfSampler({
    getAppMetrics: () => METRICS,
    record: (r) => rows.push(r),
    activeChildCount: () => 3,
    applyState: () => 'applying',
  });
  const row = s.sampleOnce();
  assert.equal(rows.length, 1);
  assert.equal(row.workers, 3, 'a worker count that only ever rises is the orphan signature');
  assert.equal(row.state, 'applying', 'CPU is only meaningful next to what the app was doing');
  assert.equal(row.topType, 'Tab');
  assert.ok(row.at && !Number.isNaN(Date.parse(row.at)));
  assert.deepEqual(JSON.parse(row.detail).map((p) => p.type), ['Tab', 'Browser', 'GPU']);
});

test('a throwing metrics source is swallowed — sampling must never break the app', () => {
  const warns = [];
  const s = createPerfSampler({
    getAppMetrics: () => { throw new Error('boom'); },
    record: () => { throw new Error('should not be reached'); },
    log: { warn: (...a) => warns.push(a.join(' ')) },
  });
  assert.equal(s.sampleOnce(), null);
  assert.equal(warns.length, 1);
});

test('missing dependencies degrade instead of throwing', () => {
  const s = createPerfSampler({ getAppMetrics: () => METRICS });   // no record/activeChildCount/applyState
  const row = s.sampleOnce();
  assert.equal(row.workers, 0);
  assert.equal(row.state, '');
});

test('start is idempotent, stop is clean, and the timer never holds the process open', () => {
  const s = createPerfSampler({ getAppMetrics: () => METRICS, record: () => {}, intervalMs: 50 });
  assert.equal(s.running, false);
  s.start(); const first = s.running;
  s.start();                                  // must not stack a second interval
  assert.equal(first, true);
  s.stop();
  assert.equal(s.running, false);
  s.stop();                                   // stopping twice is not an error
});
