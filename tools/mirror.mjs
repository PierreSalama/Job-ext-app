#!/usr/bin/env node
// JAT v11 — dashboard mirror.
// The dashboard SPA is authored in extension/app/** and must be byte-identical
// in app/src/app/** (Pierre's mirror rule). This script copies and verifies.
//
//   node tools/mirror.mjs          copy extension/app → app/src/app, then verify
//   node tools/mirror.mjs --check  verify only (CI gate; exits 1 on mismatch)

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'extension', 'app');
const DST = path.join(root, 'app', 'src', 'app');
const checkOnly = process.argv.includes('--check');

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

function sha(p) {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

if (!fs.existsSync(SRC)) {
  console.error(`source missing: ${SRC}`);
  process.exit(1);
}

if (!checkOnly) {
  fs.rmSync(DST, { recursive: true, force: true });
  fs.mkdirSync(DST, { recursive: true });
  for (const rel of walk(SRC)) {
    const to = path.join(DST, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(SRC, rel), to);
  }
  console.log(`copied ${walk(SRC).length} file(s) → app/src/app`);
}

// verify
const srcFiles = new Set(walk(SRC));
const dstFiles = new Set(fs.existsSync(DST) ? walk(DST) : []);
let bad = 0;
for (const rel of srcFiles) {
  if (!dstFiles.has(rel)) { console.error(`MISSING in app: ${rel}`); bad++; continue; }
  if (sha(path.join(SRC, rel)) !== sha(path.join(DST, rel))) {
    console.error(`DIFFERS: ${rel}`); bad++;
  }
}
for (const rel of dstFiles) {
  if (!srcFiles.has(rel)) { console.error(`EXTRA in app: ${rel}`); bad++; }
}

if (bad) {
  console.error(`mirror check FAILED (${bad} problem(s))`);
  process.exit(1);
}
console.log(`mirror verified ✓ (${srcFiles.size} files identical)`);
