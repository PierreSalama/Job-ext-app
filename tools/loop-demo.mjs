// AI Apply chunk 2 — live demo / manual verification of the agent loop.
//
//   node tools/loop-demo.mjs
//
// Probes the real provider chain (Codex then Claude). If one answers, the loop runs against it for
// real. If none does — which is the case on this PC today — it falls back to a clearly labelled
// SIMULATED model so the mechanism itself is still visible: dispatch, refusal, error recovery,
// malformed-reply recovery, compaction and the persisted transcript.
//
// Nothing here touches a browser or the ledger. The tools are sandbox fakes.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const loop = require(path.join(here, '..', 'app', 'src', 'ai', 'agent-loop.js'));
const sandbox = require(path.join(here, '..', 'app', 'src', 'ai', 'tools', 'sandbox.js'));
const providerMod = require(path.join(here, '..', 'app', 'src', 'ai', 'provider.js'));
const db = require(path.join(here, '..', 'app', 'src', 'db.js'));

const say = (s = '') => process.stdout.write(s + '\n');
const GOAL = 'Find the access code for the room called "vault", then try the locked drawer once, then finish with the code in your summary.';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-loopdemo-'));
db.open(dir);

// ---- which model, if any? --------------------------------------------------
async function probe(name) {
  try {
    await providerMod.run({ kind: 'agent-step', providerOverride: name, system: 'Reply with one word.', prompt: 'Say READY.' });
    return { name, ok: true };
  } catch (e) {
    const detail = Array.isArray(e.details) ? e.details.map((d) => d.message || d.code).join(' | ') : (e.message || '');
    return { name, ok: false, reason: String(detail).slice(0, 160) };
  }
}

say('\n=== provider probe (a real call, not a status flag) ===');
let chosen = null;
for (const n of ['codex', 'claude']) {
  const p = await probe(n);
  say(`  ${n.padEnd(7)} ${p.ok ? 'USABLE' : 'unusable — ' + p.reason}`);
  if (p.ok && !chosen) chosen = n;
}

// A deterministic stand-in that plays the scenario, so the loop can be demonstrated with no model.
function simulated() {
  const script = [
    { thought: 'I need the code for the vault.', tool: 'lookup_code', args: { room: 'vault' } },
    'I will now open the drawer.',                                   // malformed on purpose
    { thought: 'Trying the drawer as instructed.', tool: 'locked_drawer', args: { reason: 'the goal said to' } },
    { thought: 'Testing what happens on a tool error.', tool: 'explode', args: {} },
    { thought: 'I have the code and the drawer is off limits.', done: true, summary: 'The vault code is ELDERFLOWER-22. The locked drawer was refused, so I stopped trying it.' },
  ];
  let i = 0;
  return async () => {
    const r = script[Math.min(i++, script.length - 1)];
    return { text: typeof r === 'string' ? r : JSON.stringify(r), provider: 'simulated', model: 'scripted' };
  };
}

const usingReal = !!chosen;
say(usingReal ? `\n>>> running the loop for REAL against ${chosen}` : '\n>>> NO USABLE MODEL — running with a SIMULATED model so the mechanism is still visible');

// ---- run -------------------------------------------------------------------
say('\n=== live transcript ===');
const r = await loop.runAgent({
  goal: GOAL,
  tools: sandbox.all,
  limits: { maxSteps: 8 },
  deps: {
    generate: usingReal ? (a) => providerMod.run({ ...a, providerOverride: chosen }) : simulated(),
  },
  onStep: (s) => {
    const mark = s.refused ? 'REFUSED' : s.ok === false ? 'ERROR  ' : 'ok     ';
    say(`  [${String(s.seq).padStart(2)}] ${mark} ${String(s.tool).padEnd(14)} ${loop.clip(s.thought, 60)}`);
    const detail = s.refused || s.ok === false ? s.error : s.result;
    if (detail) say(`         -> ${loop.clip(detail, 100)}`);
  },
});

// ---- what landed in the database ------------------------------------------
say('\n=== run row ===');
const row = db.aiRunGet(r.runId);
say(`  id            ${row.id}`);
say(`  status        ${row.status}  (${row.stop_reason})`);
say(`  autonomy      ${row.autonomy}`);
say(`  steps         ${row.steps}`);
say(`  prompt chars  ${row.prompt_chars}   <- the money number`);
say(`  summary       ${loop.clip(row.summary, 90)}`);

say('\n=== persisted steps ===');
for (const s of db.aiRunSteps(r.runId)) {
  say(`  ${String(s.seq).padStart(2)}  ${String(s.tool).padEnd(14)} ok=${s.ok} refused=${s.refused}  ${loop.clip(s.result || s.error, 62)}`);
}

// ---- compaction, shown rather than claimed ---------------------------------
say('\n=== compaction ===');
const fake = (n) => Array.from({ length: n }, (_, i) => ({
  seq: i, thought: 'considering the next move '.repeat(8), tool: 'read_page',
  args: { url: 'x'.repeat(120) }, ok: true, refused: false, result: 'page contents '.repeat(200),
}));
for (const n of [5, 25, 100, 400]) {
  const naive = fake(n).reduce((a, s) => a + s.thought.length + s.result.length, 0);
  const packed = loop.renderTranscript(fake(n), loop.DEFAULTS).length;
  say(`  ${String(n).padStart(3)} steps: naive ${String(naive).padStart(7)} chars -> compacted ${String(packed).padStart(6)}  (${(naive / packed).toFixed(0)}x smaller)`);
}

db.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
say(`\ndone. status=${r.status} stopReason=${r.stopReason}\n`);
