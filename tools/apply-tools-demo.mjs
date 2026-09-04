// AI Apply chunk 5 — live demo of the ledger tools against Pierre's REAL application history.
//
//   node tools/apply-tools-demo.mjs
//
// Works on a COPY of the live database, so `log_application` cannot touch the real one. The point
// is to show the duplicate guard refusing employers he has genuinely already applied to, using the
// real rows rather than fixtures.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);

const say = (s = '') => process.stdout.write(s + '\n');

// --- copy the live DB somewhere safe ---------------------------------------
const live = path.join(process.env.APPDATA, 'jat11-app', 'jat.db');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-tooldemo-'));
fs.copyFileSync(live, path.join(dir, 'jat.db'));
say(`working on a COPY of the live ledger (${(fs.statSync(live).size / 1e6).toFixed(0)} MB) — the real one is untouched\n`);

const db = require(path.join(root, 'app/src/db.js'));
const jat = require(path.join(root, 'app/src/ai/tools/jat.js'));
db.open(dir);

const belt = jat.makeJatTools({});
const byName = Object.fromEntries(belt.tools.map((t) => [t.name, t]));
const call = async (name, args) => {
  const t = byName[name];
  if (t.guard) { const r = await t.guard(args, {}); if (r) return `REFUSED: ${r}`; }
  return t.run(args, {});
};

const engaged = db.listJobs({ limit: 5000 }).filter((j) => jat.ENGAGED.has(j.status));
say(`ledger: ${db.listJobs({ limit: 5000 }).length} rows, ${engaged.length} already engaged\n`);

// --- 1. employers he really has applied to ----------------------------------
say('=== check_duplicate against employers he HAS applied to ===');
const real = [
  { url: 'https://boards.greenhouse.io/knak/jobs/999', company: 'Knak Inc.', title: 'Senior Software Developer' },
  { url: 'https://jobs.ashbyhq.com/zip/other-role', company: 'Zip HQ', title: 'Frontend Engineer' },
  { url: 'https://jobs.ashbyhq.com/maintainx/another', company: 'MaintainX', title: 'Platform Developer' },
];
for (const c of real) {
  say(`\n  ${c.company} — ${c.title}`);
  say(`    ${await call('check_duplicate', c)}`);
}

// --- 2. an employer he has not touched --------------------------------------
say('\n=== check_duplicate against a genuinely new employer ===');
const fresh = { url: 'https://jobs.lever.co/some-company-he-never-saw/abc', company: 'Some Company He Never Saw', title: 'Developer' };
say(`  ${await call('check_duplicate', fresh)}`);

// --- 3. the write guard -----------------------------------------------------
say('\n=== log_application on a duplicate (must refuse) ===');
say(`  ${await call('log_application', { company: 'Knak', title: 'Anything At All', url: 'https://boards.greenhouse.io/knak/jobs/1' })}`);

say('\n=== log_application on the fresh one (must succeed and read back) ===');
say(`  ${await call('log_application', { ...fresh, location: 'Toronto, ON', notes: 'demo run' })}`);
const saved = db.listJobs({ q: 'Some Company He Never Saw', limit: 3 })[0];
say(`  read back: status="${saved.status}" submittedAt=${saved.submittedAt ? 'set' : 'MISSING'} source=${saved.source}`);

// --- 4. what it knows about him ---------------------------------------------
say('\n=== recall_answer ===');
for (const q of ['Are you legally authorized to work in Canada?', 'What is your favourite bridge?']) {
  say(`  Q: ${q}`);
  say(`     ${String(await call('recall_answer', { question: q })).slice(0, 150)}`);
}

db.close();
fs.rmSync(dir, { recursive: true, force: true });
say('\ncopy discarded. the live ledger was never opened for writing.');
