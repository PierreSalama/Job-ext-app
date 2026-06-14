#!/usr/bin/env node
// Version-sync gate. The extension manifest + the Electron app package.json (and,
// in the dev tree, the workspace-root package.json) must all carry the SAME 11.x.y
// version. A divergence here is how a release ends up tagged v11.8.0 while the app
// reports v11.4.3 — so CI fails fast on it.
//
//   node tools/validate-versions.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readVer = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')).version;

const sources = [
  ['extension/manifest.json', readVer('extension/manifest.json')],
  ['app/package.json', readVer('app/package.json')],
];

// The workspace-root package.json exists in the dev tree but is NOT synced to the
// publish repo — check it only when it's present.
const rootPkg = path.join(root, 'package.json');
if (fs.existsSync(rootPkg)) {
  const v = JSON.parse(fs.readFileSync(rootPkg, 'utf8')).version;
  if (v) sources.push(['package.json', v]);
}

let bad = 0;
const semver = /^11\.\d+\.\d+$/;
for (const [f, v] of sources) {
  if (!semver.test(String(v || ''))) { console.error(`FAIL ${f}: version "${v}" is not 11.x.y`); bad++; }
}
const distinct = new Set(sources.map(([, v]) => v));
if (distinct.size > 1) {
  console.error('FAIL versions diverge:');
  for (const [f, v] of sources) console.error(`  ${f} = ${v}`);
  bad++;
}

if (bad) { console.error(`\nversion sync FAILED (${bad} problem(s))`); process.exit(1); }
console.log(`version sync OK — all ${sources.length} source(s) at ${[...distinct][0]}`);
