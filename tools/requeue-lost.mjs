// Put back the applications that were thrown away for reasons that had nothing to do with fit.
//
//   node tools/requeue-lost.mjs                      # DRY RUN against the laptop, changes nothing
//   node tools/requeue-lost.mjs --apply              # actually requeue
//   node tools/requeue-lost.mjs --base http://127.0.0.1:7744 --token <t>
//
// WHY THIS EXISTS
// Two buckets of terminally 'skipped' tasks were never a judgement about the job (measured
// 2026-09-05 on the PC ledger):
//
//   59  "auto-apply skipped without a diagnostic"   — every one has an EMPTY transcript, so the
//                                                     executor never ran. They were not attempted,
//                                                     yet 'skipped' is a verdict and is terminal.
//   48  "retired: ... (atsBoards off)"              — a discovery source was off for a single day.
//                                                     `atsBoardsEnabled` is true again and nothing
//                                                     ever reconsidered them.
//
// Of those, 40 and 16 still passed his filters. Coinbase, Dialpad, Tenstorrent, Warner Bros.
// Discovery among them.
//
// DRY RUN BY DEFAULT, ON PURPOSE. Requeueing writes to the live queue on the machine that applies,
// and those applications go out the moment auto-apply is switched back on. That ordering is
// deliberate: release the safety fixes FIRST (see docs/agent/READ-ME-FIRST.md), then requeue.
import process from 'node:process';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const APPLY = process.argv.includes('--apply');
const BASE = arg('base', 'http://100.104.86.34:7744');
const TOKEN = arg('token', process.env.JAT_TOKEN || '');
const LIMIT = Number(arg('limit', '0')) || 0;

const REASONS = [
  { label: 'never attempted (no diagnostic, empty transcript)', test: (t) => /without a diagnostic/i.test(String(t.lastError || '')) },
  { label: 'retired while a discovery source was off', test: (t) => /atsBoards off/i.test(String(t.lastError || '')) },
];

const get = async (p) => {
  const r = await fetch(`${BASE}${p}`, { headers: TOKEN ? { 'x-jat-token': TOKEN } : {} });
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return r.json();
};

const say = (s = '') => process.stdout.write(`${s}\n`);

const queue = await get('/queue');
const tasks = (queue.items || []).filter((t) => t.state === 'skipped');
say(`${BASE}`);
say(`skipped tasks: ${tasks.length}`);
say('');

const picked = [];
for (const r of REASONS) {
  const hits = tasks.filter(r.test);
  say(`${String(hits.length).padStart(4)}  ${r.label}`);
  picked.push(...hits);
}
say('');
say(`total recoverable: ${picked.length}`);

if (!picked.length) process.exit(0);

const todo = LIMIT ? picked.slice(0, LIMIT) : picked;

if (!APPLY) {
  say('');
  say('DRY RUN. Nothing was changed. Pass --apply to requeue.');
  say('Do that AFTER releasing the safety fixes, not before: these go out as soon as');
  say('auto-apply is switched back on.');
  for (const t of todo.slice(0, 10)) say(`   would requeue  ${t.id}  ${String(t.lastError || '').slice(0, 60)}`);
  if (todo.length > 10) say(`   ...and ${todo.length - 10} more`);
  process.exit(0);
}

let ok = 0;
let failed = 0;
for (const t of todo) {
  try {
    const r = await fetch(`${BASE}/queue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(TOKEN ? { 'x-jat-token': TOKEN } : {}) },
      body: JSON.stringify({ jobId: t.jobId, mode: 'auto' }),
    });
    if (r.ok) ok++; else failed++;
  } catch { failed++; }
}
say('');
say(`requeued ${ok}, failed ${failed}`);
