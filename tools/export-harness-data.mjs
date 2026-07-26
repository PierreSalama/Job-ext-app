// Snapshot the LIVE desktop app's profile + learned answers into harness/real-data.json so the
// harness can run against the SAME data production uses.
//
// Why this exists: two fixtures in a row failed to reproduce live failures because the mock app
// served a hand-written profile that is RICHER than the real one (it has a `location` key the
// real profile lacks, yearsExperience '6' vs the real '2') and answered every /qa/lookup with
// null while the real store holds thousands of learned answers. A harness that is easier than
// production cannot reproduce production bugs.
//
// Reads a COPY of the DB (never touches the live file) and writes nothing back.
// The output contains personal data and is gitignored.
//
// Usage:  node tools/export-harness-data.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIVE = path.join(process.env.APPDATA || '', 'jat11-app', 'jat.db');
const OUT = path.join(here, '..', 'harness', 'real-data.json');

if (!fs.existsSync(LIVE)) {
  console.error('live DB not found at', LIVE);
  process.exit(1);
}
const tmp = path.join(os.tmpdir(), `jat-harness-snap-${Date.now()}.db`);
fs.copyFileSync(LIVE, tmp);

try {
  const db = new DatabaseSync(tmp, { readOnly: true });

  const prof = db.prepare('SELECT id, name, data FROM profiles WHERE is_default = 1 LIMIT 1').get()
    || db.prepare('SELECT id, name, data FROM profiles LIMIT 1').get();
  if (!prof) throw new Error('no profile row');
  let data = {};
  try { data = JSON.parse(prof.data || '{}'); } catch {}

  const qa = db.prepare('SELECT question, answer FROM qa').all()
    .filter((r) => r && r.question && r.answer != null)
    .map((r) => ({ question: String(r.question), answer: String(r.answer) }));

  const fields = db.prepare('SELECT * FROM profile_fields LIMIT 1').all().length
    ? db.prepare('SELECT * FROM profile_fields').all()
    : [];

  const payload = {
    exportedAt: new Date().toISOString(),
    note: 'REAL data snapshot for harness fidelity. Personal — gitignored, never commit.',
    profile: { id: prof.id, name: prof.name, data },
    qa,
    profileFieldCount: fields.length,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
  console.log('wrote', OUT);
  console.log('  profile keys :', Object.keys(data).length);
  console.log('  saved answers:', qa.length);
  const has = (k) => (data[k] === undefined ? 'MISSING' : JSON.stringify(data[k]).slice(0, 30));
  for (const k of ['city', 'location', 'yearsExperience', 'workAuthorization', 'phone', 'email']) {
    console.log('   ', k.padEnd(18), has(k));
  }
} finally {
  try { fs.rmSync(tmp, { force: true }); } catch {}
}
