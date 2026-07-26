// Multi-node dashboard — Chunk 3: Dashboard / Applications / Pipeline are ALWAYS every machine
// combined (regardless of the Auto-Apply switcher).
//
// Verified live against the real laptop + dad nodes: combined submitted = 23 (laptop) + 194 (dad)
// = 217 on the Dashboard; Applications + Pipeline showed 638 rows (656 raw across both machines,
// 18 duplicates deduped by URL). These guard the wiring + the merge contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appJs = fs.readFileSync(path.join(here, '..', 'extension', 'app', 'app.js'), 'utf8');
const mirror = fs.readFileSync(path.join(here, '..', 'app', 'src', 'app', 'app.js'), 'utf8');

test('the two dashboard copies are still byte-identical', () => {
  assert.equal(appJs, mirror);
});

test('fetchAllNodes hits THIS machine plus every remote node', () => {
  const fn = appJs.slice(appJs.indexOf('function allTargets()'));
  assert.match(fn.slice(0, 300), /const list = \[selfTarget\(\)\];/, 'self is always included');
  assert.match(fn.slice(0, 300), /for \(const n of \(state\.nodes \|\| \[\]\)\)/, 'plus each remote node');
});

test('an unreachable node is skipped, not fatal (combined view still renders)', () => {
  const fn = appJs.slice(appJs.indexOf('async function fetchAllNodes'));
  assert.match(fn.slice(0, 400), /Promise\.allSettled/, 'must not reject the whole merge if one node is down');
});

test('merged jobs dedupe by URL, keeping the most-advanced status', () => {
  const fn = appJs.slice(appJs.indexOf('async function mergedJobs'));
  const body = fn.slice(0, 800);
  assert.match(body, /String\(j\.jobUrl \|\| j\.id \|\| ''\)\.toLowerCase\(\)/, 'dedupe key is the job URL');
  assert.match(body, /_STATUS_RANK\[j\.status\] \|\| 0\) > \(_STATUS_RANK\[ex\.status\] \|\| 0\)/, 'keep the higher-ranked status');
  // and it tags each row with its machine
  assert.match(body, /_node: node\.name/);
});

test('merged stats sum the totals and the funnel across machines', () => {
  const fn = appJs.slice(appJs.indexOf('async function mergedStats'));
  const body = fn.slice(0, 1400);
  assert.match(body, /'submittedTotal'/, 'submitted totals are summed');
  assert.match(body, /out\.byStatus\[k\] = \(out\.byStatus\[k\] \|\| 0\) \+ data\.byStatus\[k\]/, 'byStatus summed per key');
  assert.match(body, /out\.funnel\.responseRate = out\.funnel\.submitted \?/, 'response rate recomputed on the combined funnel');
});

test('the three combined pages are wired to the merged fetchers', () => {
  // Dashboard
  assert.match(appJs, /mergedStats\(\),\s*\/\/ headline totals/);
  assert.match(appJs, /mergedJobs\('limit=50'\)/);
  // Applications
  assert.match(appJs, /mergedJobs\(q\.slice\(q\.indexOf\('\?'\) \+ 1\)\)/);
  // Pipeline
  assert.match(appJs, /const r = await mergedJobs\('limit=500'\);   \/\/ pipeline board/);
});

test('the Auto-Apply switcher is unaffected — combined pages never target a single node', () => {
  // navigate() only points apiTarget at a node for /queue; the combined routes always use
  // fetchAllNodes (every node), so the switcher and the combined view stay independent.
  assert.match(appJs, /apiTarget = \(path === '\/queue'\) \?/);
});
