// Test runner for the v11 root suite.
//
// `npm test` used to be a hand-written list of 53 filenames. tests/ had grown to 83, so THIRTY
// test files were never executed — including every regression guard added during the 2026-07-25/26
// auto-apply work (park-label, searchable-select, eligibility-status-list, ai-rescue-park-fields,
// keyword-relevance-gate, host-breaker-persist, submitted-is-forever, ats-supply, …). They passed
// when run by hand and were silently absent from the number the suite reported.
//
// A manual list drifts by default: nothing fails when you forget to add a file, so nobody notices.
// This globs tests/ instead, so a new test file is in the suite the moment it exists, and anything
// deliberately excluded has to be named here with a reason.
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const testsDir = path.join(root, 'tests');

// Files excluded from the automatic run. Keep this list SHORT and always say why.
const DENYLIST = new Map([
  // Hangs indefinitely rather than failing an assertion (never completes, no output). It needs a
  // real browser/electron context the plain node test runner does not provide. Left out so it
  // cannot wedge the suite; run it directly if you are working on the detector.
  ['detector-flow.test.mjs', 'hangs without a browser context — run directly'],
]);

const all = readdirSync(testsDir).filter((f) => f.endsWith('.test.mjs')).sort();
const run = all.filter((f) => !DENYLIST.has(f));
const skipped = all.filter((f) => DENYLIST.has(f));

if (skipped.length) {
  for (const f of skipped) console.log(`[run-tests] SKIPPED ${f} — ${DENYLIST.get(f)}`);
}
console.log(`[run-tests] ${run.length} test file(s) from ${path.relative(root, testsDir)}/\n`);

const child = spawn(process.execPath, ['--test', ...run.map((f) => path.join(testsDir, f))], {
  cwd: root,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
