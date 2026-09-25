#!/usr/bin/env node
// IS THE MACHINE THAT APPLIES RUNNING THE BUILD YOU THINK IT IS?
//
// Found 2026-09-06: the applier laptop was running extension 11.127.0 while the working tree was on
// 11.154.0. Thirty-one commits touching extension/ had never executed there, among them a8384ee,
// whose own message calls it "the dominant live failure on the laptop" and which matched 12 of 14
// captured stalls. It is the fix for the 52x "Easy Apply did not transfer" bucket, and it had never
// run on the machine producing that bucket.
//
// server.js already carries the warning, written when the gap was THREE versions:
//
//     "a silent version gap is the failure that hides every other fix"
//
// Nothing ever compared the two numbers, so it drifted to twenty-seven. That is the whole reason
// this file exists. It is one HTTP GET per node and it would have caught this at version 128.
//
// The damage is not only the missing fixes. It invalidates conclusions: every judgement about
// whether an extension-side change worked, made by watching that laptop, was measuring the old
// build.
//
//   node tools/check-extension-live.mjs --node URL --token T   check one node explicitly
//   node tools/check-extension-live.mjs --json              machine-readable
//
// Exits 1 when any reachable node is behind, so it can gate a release. Strictly read-only: it GETs
// one status endpoint and writes nothing anywhere.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const ARG = (n) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : null; };
const JSON_OUT = process.argv.includes('--json');

const built = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8')).version;

// Compare as version numbers, not strings: "11.99.0" is not newer than "11.127.0".
function cmp(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
}

// WHERE THE NODES COME FROM, AND WHY NOT FROM THE DATABASE.
//
// The obvious version of this read settings.nodes by calling db.open() on the live user-data
// directory. That is not read-only: opening the ledger runs migrations, and this is a diagnostic
// pointed at a machine that is mid-job-search. A tool whose header promises it touches nothing must
// not quietly upgrade a schema to save one command-line flag.
//
// So the node is passed in. The list lives in Settings under `nodes`, each entry carrying its own
// baseUrl and token.
function nodesFromArgs() {
  const explicit = ARG('node') || process.env.JAT_NODE;
  if (!explicit) return [];
  return [{ name: explicit.replace(/^https?:\/\//, ''), baseUrl: explicit, token: ARG('token') || process.env.JAT_TOKEN || '' }];
}

async function liveVersion(node) {
  const url = `${String(node.baseUrl).replace(/\/+$/, '')}/auto-apply/live`;
  const ctl = AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined;
  const r = await fetch(url, { headers: { 'x-jat-token': node.token }, signal: ctl });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const ext = j.ext || j.extLink || {};
  return { version: ext.version || '', connected: !!ext.connected, seenAt: ext.seenAt || '' };
}

const nodes = nodesFromArgs();
if (!nodes.length) {
  if (JSON_OUT) console.log(JSON.stringify({ built, nodes: [], note: 'no nodes configured' }));
  else console.log(`built extension: ${built}

Name the node to check:
  node tools/check-extension-live.mjs --node http://HOST:7744 --token TOKEN
or set JAT_NODE and JAT_TOKEN. Both values are in Settings, under nodes.`);
  process.exit(0);
}

const rows = [];
for (const n of nodes) {
  try {
    const live = await liveVersion(n);
    rows.push({ name: n.name, ...live, behind: live.version ? cmp(live.version, built) < 0 : null });
  } catch (e) {
    rows.push({ name: n.name, version: '', connected: false, error: e.message, behind: null });
  }
}

const behind = rows.filter((r) => r.behind === true);

if (JSON_OUT) {
  console.log(JSON.stringify({ built, rows, behind: behind.length }, null, 2));
} else {
  console.log(`built extension: ${built}\n`);
  for (const r of rows) {
    if (r.error) { console.log(`  ?        ${r.name}: unreachable (${r.error})`); continue; }
    if (!r.version) { console.log(`  ?        ${r.name}: connected extension has not reported a version yet`); continue; }
    const tag = r.behind ? 'BEHIND ' : 'current';
    const conn = r.connected ? '' : '  (extension not currently connected)';
    console.log(`  ${tag}  ${r.name}: ${r.version}${r.behind ? ` — built is ${built}` : ''}${conn}`);
  }
  if (behind.length) {
    console.log(`\n${behind.length} node(s) running an older extension than the tree.`);
    console.log('That copy is loaded UNPACKED and does not come from the Chrome Web Store, so this is');
    console.log('not blocked on the store review. Update the unpacked folder on that machine, then');
    console.log('POST /ext/reload to make it pick the new files up.');
  }
}

process.exit(behind.length ? 1 : 0);
