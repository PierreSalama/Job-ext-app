#!/usr/bin/env node
// JAT auto-apply DOCTOR — one-command live observability for the observe→diagnose→fix→verify→ship
// loop. Snapshots the LIVE desktop-app DB (read-only copy; never touches the running file) and
// prints a structured health report: build proxy, queue depth, recent-window submission rate +
// failure buckets, recovery candidates, discovery composition, and the current dominant failure
// with sample transcripts. This is the "observe" step that MUST precede any auto-apply fix
// (never debug blindly). Pairs with the harness (verify) and release.ps1/cws-publish (ship).
//
//   node tools/jat-doctor.mjs                 # default DB, last 30 min window, text report
//   node tools/jat-doctor.mjs --minutes 60    # widen the recent window
//   node tools/jat-doctor.mjs --db <path>     # explicit DB path
//   node tools/jat-doctor.mjs --json          # machine-readable (for workflows/agents)
//   node tools/jat-doctor.mjs --samples 3     # N sample transcripts for the dominant failure
//
// Run from anywhere; it resolves node-sqlite3-wasm from ../app/node_modules.

import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(here, '..', 'app');
const require = createRequire(path.join(APP_DIR, 'package.json'));

// ---- args ----
const argv = process.argv.slice(2);
const argVal = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const has = (flag) => argv.includes(flag);
const MINUTES = parseInt(argVal('--minutes', '30'), 10) || 30;
const SAMPLES = parseInt(argVal('--samples', '2'), 10) || 2;
const AS_JSON = has('--json');
const DEFAULT_DB = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'jat11-app', 'jat.db');
const DB_PATH = argVal('--db', DEFAULT_DB);

if (!fs.existsSync(DB_PATH)) {
  console.error(`[jat-doctor] DB not found: ${DB_PATH}\nPass --db <path> (the desktop app's jat.db).`);
  process.exit(1);
}

// ---- open a read-only COPY (the live file is held by the running app) ----
const snap = path.join(os.tmpdir(), `jat-doctor-${process.pid}.db`);
fs.copyFileSync(DB_PATH, snap);
let Database;
try { ({ Database } = require('node-sqlite3-wasm')); }
catch (e) { console.error('[jat-doctor] node-sqlite3-wasm not found — run `npm i` in app/ first.', e.message); process.exit(1); }
const db = new Database(snap, { readOnly: true, fileMustExist: true });
const q = (s, p = []) => { try { return db.all(s, p); } catch (e) { return [{ ERR: e.message }]; } };
const one = (s, p = []) => { const r = q(s, p); return r[0] || {}; };
const T = 'auto_apply_tasks';

// ---- R1-trustworthy verdict markers (must mirror db.js recoverVerifiedEvidenceFromTranscript) ----
const R1_LIKE = `(transcript LIKE '%evidence=verified:text-became-success%' OR transcript LIKE '%evidence=verified:new-confirmation-node%' OR transcript LIKE '%evidence=verified:confirm-signal%' OR transcript LIKE '%submitted — verified (text-became-success%' OR transcript LIKE '%submitted — verified (new-confirmation-node%' OR transcript LIKE '%submitted — verified (confirm-signal%' OR transcript LIKE '%application submitted (text-became-success%' OR transcript LIKE '%application submitted (new-confirmation-node%' OR transcript LIKE '%application submitted (confirm-signal%')`;

const nowMs = Date.now();
const cutoff = new Date(nowMs - MINUTES * 60000).toISOString();
const latest = one(`SELECT MAX(updated_at) m FROM ${T}`).m || '(none)';

// build proxy: newest learned= count in any recent transcript
let buildProxy = null;
for (const r of q(`SELECT transcript FROM ${T} WHERE updated_at>='${cutoff}' AND transcript LIKE '%learned=%' ORDER BY updated_at DESC LIMIT 1`)) {
  const m = String(r.transcript || '').match(/learned=(\d+)/); if (m) buildProxy = m[1];
}

const stateAll = q(`SELECT state, COUNT(*) n FROM ${T} GROUP BY state ORDER BY n DESC`);
const stateWin = q(`SELECT state, COUNT(*) n FROM ${T} WHERE updated_at>='${cutoff}' GROUP BY state ORDER BY n DESC`);
const errWin = q(`SELECT substr(COALESCE(last_error,'-'),1,64) e, COUNT(*) n FROM ${T} WHERE updated_at>='${cutoff}' AND state IN ('failed','skipped','awaiting_input') GROUP BY e ORDER BY n DESC LIMIT 12`);
const terminalWin = q(`SELECT COUNT(*) n FROM ${T} WHERE updated_at>='${cutoff}' AND state IN ('done','failed','skipped','awaiting_review','awaiting_input')`)[0]?.n || 0;
const doneWin = q(`SELECT COUNT(*) n FROM ${T} WHERE updated_at>='${cutoff}' AND state='done'`)[0]?.n || 0;
const schedulable = q(`SELECT state, COUNT(*) n FROM ${T} WHERE state IN ('queued','scheduled','running') GROUP BY state`);
const recoverable = q(`SELECT COUNT(*) n FROM ${T} WHERE state='awaiting_review' AND ${R1_LIKE}`)[0]?.n || 0;
const legacyAR = q(`SELECT COUNT(*) n FROM ${T} WHERE state='awaiting_review' AND last_error LIKE '%legacy/static%'`)[0]?.n || 0;

// discovery composition (best-effort: tables may not exist on older schemas)
const prov = q(`SELECT provider, COUNT(*) n FROM job_discovery_provenance GROUP BY provider`);
const cap = q(`SELECT apply_capability c, COUNT(*) n FROM job_discovery_provenance GROUP BY apply_capability ORDER BY n DESC`);
const jobsBySource = q(`SELECT source, COUNT(*) n FROM jobs GROUP BY source ORDER BY n DESC LIMIT 6`);

// dominant CURRENT failure + sample transcripts
const domFailure = errWin.filter((r) => r.e && !/^-$/.test(r.e))[0];
let samples = [];
if (domFailure) {
  const rows = q(`SELECT t.transcript tr, j.title, j.job_url url FROM ${T} t JOIN jobs j ON j.id=t.job_id
                  WHERE t.updated_at>='${cutoff}' AND substr(COALESCE(t.last_error,'-'),1,64)=? ORDER BY t.updated_at DESC LIMIT ?`,
                 [domFailure.e, SAMPLES]);
  samples = rows.map((r) => {
    let steps = []; try { steps = JSON.parse(r.tr || '[]'); } catch {}
    return { title: r.title, url: r.url, tail: steps.slice(-14).map((s) => String(s.text || s.note || s.kind || '').slice(0, 100)) };
  });
}

const rate = terminalWin ? Math.round((doneWin / terminalWin) * 100) : 0;
const report = {
  db: DB_PATH, generatedAt: new Date(nowMs).toISOString(), windowMinutes: MINUTES,
  latestActivity: latest, buildProxyLearned: buildProxy,
  submissionRateWindow: { done: doneWin, terminal: terminalWin, ratePct: rate },
  stateAllTime: stateAll, stateWindow: stateWin, errorBucketsWindow: errWin,
  schedulableQueue: schedulable,
  recoveryCandidates: recoverable, legacyAwaitingReview: legacyAR,
  discovery: { provenanceByProvider: prov, byApplyCapability: cap, jobsBySource },
  dominantFailure: domFailure || null, samples,
};

db.close();
try { fs.unlinkSync(snap); } catch {}

if (AS_JSON) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

// ---- pretty text report ----
const L = (s = '') => console.log(s);
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
L(`\n══════════ JAT AUTO-APPLY DOCTOR ══════════`);
L(`db: ${DB_PATH}`);
L(`now: ${report.generatedAt}   latest activity: ${latest}   build(learned=): ${buildProxy || '?'}`);
L(`\n── SUBMISSION RATE (last ${MINUTES} min) ──`);
L(`  done ${doneWin} / terminal ${terminalWin}  =  ${rate}%   ${rate >= 60 ? '✓ at target' : '✗ below 60% target'}`);
L(`\n── QUEUE (schedulable now) ──`);
L(schedulable.length ? schedulable.map((r) => `  ${r.state}: ${r.n}`).join('\n') : '  (empty — nothing queued/scheduled/running)');
L(`\n── STATE (all time) ──`);
const totAll = stateAll.reduce((a, r) => a + (r.n || 0), 0);
L(stateAll.map((r) => `  ${String(r.state).padEnd(16)} ${String(r.n).padStart(5)}  ${pct(r.n, totAll)}%`).join('\n'));
L(`\n── FAILURES (last ${MINUTES} min, top buckets) ──`);
L(errWin.length ? errWin.map((r) => `  ${String(r.n).padStart(4)}  ${r.e}`).join('\n') : '  (none)');
L(`\n── RECOVERY / HYGIENE ──`);
L(`  awaiting_review w/ R1 verified marker (should be ~0; >0 = downgrade bug live): ${recoverable}`);
L(`  awaiting_review legacy/static (human re-verify, expected): ${legacyAR}`);
L(`\n── DISCOVERY SUPPLY ──`);
L(`  provenance by provider: ${prov.map((r) => `${r.provider || '?'}=${r.n}`).join(', ') || '(n/a)'}`);
L(`  by applyCapability:    ${cap.map((r) => `${r.c || '?'}=${r.n}`).join(', ') || '(n/a)'}`);
L(`  jobs by source (top):  ${jobsBySource.map((r) => `${r.source}=${r.n}`).join(', ')}`);
if (domFailure) {
  L(`\n── DOMINANT CURRENT FAILURE ──`);
  L(`  "${domFailure.e}"  (${domFailure.n}× in last ${MINUTES} min)`);
  samples.forEach((s, i) => {
    L(`\n  sample ${i + 1}: ${s.title}  ${s.url || ''}`);
    s.tail.forEach((t) => L(`     ${t}`));
  });
}
L(`\n═══════════════════════════════════════════\n`);
