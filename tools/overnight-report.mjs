#!/usr/bin/env node
// Read back an overnight auto-apply run in one command.
//
// The run records itself on the laptop (JAT Overnight Monitor, every 5 minutes, one JSON line into
// C:\ProgramData\JAT-Remote\overnight-YYYYMMDD.jsonl). That file is the only thing that survives a
// closed session, a dropped SSH connection or a reboot — which is the whole point of writing it to
// disk instead of watching from here.
//
// Usage:
//   node tools/overnight-report.mjs              # today's run on the laptop
//   node tools/overnight-report.mjs 20260907     # a specific date
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const HOST = process.env.JAT_LAPTOP || '100.104.86.34';
const USER = process.env.JAT_LAPTOP_USER || 'laptop';
const KEY = process.env.JAT_SSH_KEY || path.join(os.homedir(), '.ssh', 'jat_nodes');
const day = process.argv[2] || new Date().toISOString().slice(0, 10).replace(/-/g, '');

const raw = execFileSync('ssh', ['-i', KEY, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no',
  `${USER}@${HOST}`, `powershell -NoProfile -Command "Get-Content 'C:\\ProgramData\\JAT-Remote\\overnight-${day}.jsonl' -Raw"`],
  { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });

const rows = raw.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'))
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

if (!rows.length) { console.error(`no samples for ${day}`); process.exit(1); }

const first = rows[0], last = rows[rows.length - 1];
const t = (s) => String(s).slice(11, 19);
const hours = ((new Date(last.ts) - new Date(first.ts)) / 3600000).toFixed(1);

console.log(`\n  ${day}   ${t(first.ts)} → ${t(last.ts)}   ${hours}h   ${rows.length} samples\n`);

// Outcomes are cumulative counters, so the last sample carries the totals.
const c = last.runCounts || {};
const order = ['dispatched', 'verified_done', 'awaiting_review', 'needs_you', 'skipped', 'flow_failed', 'site_gate', 'bot_challenge', 'in_flight'];
console.log('  OUTCOMES');
for (const k of order) if (c[k]) console.log(`    ${k.padEnd(17)} ${c[k]}`);
const denom = (c.verified_done || 0) + (c.flow_failed || 0) + (c.awaiting_review || 0);
if (denom) console.log(`    ${'eligible rate'.padEnd(17)} ${Math.round((c.verified_done || 0) / denom * 100)}%   (done / done+failed+review)`);

// A provider that dies mid-run is invisible in totals but obvious in the delta.
//
// last-minus-first IS WRONG here, and produced nonsense the first time this ran: remote came back
// as -1423 calls, and claude-cli as 364 calls with 1787 successes. The counters are lifetime sums
// over ai_log, and the app prunes that table (aiLogRetentionDays), so the totals go DOWN mid-run.
// Summing only the POSITIVE step between adjacent samples survives a prune: the prune is one
// negative step, which is skipped, instead of poisoning the whole window.
console.log('\n  AI PROVIDERS (during the run)');
const names = new Set();
for (const r of rows) for (const k of Object.keys(r.ai || {})) names.add(k);
let pruned = false;
for (const name of names) {
  let calls = 0, ok = 0, ms = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = (rows[i - 1].ai || {})[name], b = (rows[i].ai || {})[name];
    if (!a || !b) continue;
    const dc = b.calls - a.calls;
    if (dc < 0) { pruned = true; continue; }
    calls += dc;
    ok += Math.max(0, b.ok - a.ok);
    ms += Math.max(0, b.ms - a.ms);
  }
  if (!calls) continue;
  const rate = Math.round((ok / calls) * 100);
  console.log(`    ${name.padEnd(14)} calls ${String(calls).padStart(5)}  ok ${String(ok).padStart(5)}  ${String(rate).padStart(3)}%  avg ${(ms / calls / 1000).toFixed(1)}s`);
}
if (pruned) console.log('    (ai_log was pruned during this window; counts are the sum of forward steps)');

// Gaps matter more than averages: a 3-hour hole is a stall, and the totals hide it completely.
console.log('\n  CONTINUITY');
let downSamples = 0, extDown = 0, biggestGap = 0, gapAt = '';
for (let i = 1; i < rows.length; i++) {
  const gap = (new Date(rows[i].ts) - new Date(rows[i - 1].ts)) / 60000;
  if (gap > biggestGap) { biggestGap = gap; gapAt = t(rows[i].ts); }
  if (!rows[i].appUp) downSamples++;
  if (!rows[i].extConnected) extDown++;
}
console.log(`    app down at        ${downSamples} of ${rows.length} samples`);
console.log(`    extension offline  ${extDown} of ${rows.length} samples`);
console.log(`    largest gap        ${biggestGap.toFixed(0)} min (at ${gapAt})   — 5 min is normal`);
if (last.signedOut) console.log('    LINKEDIN SIGNED OUT — the latch tripped, LinkedIn work was held');

// Where the run actually spent its time. "pacing" is healthy; "safety-quiet-hours" all night is not.
const byStatus = {};
for (const r of rows) byStatus[r.status || '?'] = (byStatus[r.status || '?'] || 0) + 1;
console.log('\n  TIME BY STATUS');
for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(20)} ${String(v * 5).padStart(4)} min`);
}
console.log(`\n  extension ${last.extVersion}   dispatched ${last.dispatchedDay}/${last.dailyCap}   ${last.queuedRunnable} still runnable\n`);
