// AI Apply chunk 4 — live demo. The agent loop + the browser tool belt + a real model, pointed at
// a REAL job application form.
//
//   node tools/browser-agent-demo.mjs [url]
//
// READ ONLY BY CONSTRUCTION: the goal asks it to report what the form wants, and the belt has no
// submit verb yet. Nothing is filled in and nothing is sent.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const loop = require(path.join(root, 'app/src/ai/agent-loop.js'));
const { makeBrowserTools } = require(path.join(root, 'app/src/ai/tools/browser.js'));
const providerMod = require(path.join(root, 'app/src/ai/provider.js'));
const db = require(path.join(root, 'app/src/db.js'));

const say = (s = '') => process.stdout.write(s + '\n');
const URL_ = process.argv[2] || 'https://job-boards.greenhouse.io/embed/job_app?for=knak&token=4725427005';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-browserdemo-'));
db.open(dir);

async function probe(name) {
  try {
    await providerMod.run({ kind: 'agent-step', providerOverride: name, system: 'One word.', prompt: 'Say READY.' });
    return true;
  } catch { return false; }
}

say('\n=== provider probe ===');
let chosen = null;
for (const n of ['codex', 'claude']) {
  const ok = await probe(n);
  say(`  ${n.padEnd(7)} ${ok ? 'USABLE' : 'unusable'}`);
  if (ok && !chosen) chosen = n;
}
if (!chosen) { say('\nNo usable model — cannot run the demo.'); db.close(); process.exit(1); }

const belt = makeBrowserTools({ profileId: 'demo-browser', port: 9299, headless: true });
say(`\n>>> ${chosen} driving a real Chrome at ${URL_}\n`);
say('=== transcript ===');

try {
  const r = await loop.runAgent({
    goal: `Open ${URL_} and work out what this job application form asks the candidate for. `
        + 'Read the page, then finish with a short list of the required fields. '
        + 'Do not fill anything in. Do not submit anything.',
    tools: belt.tools,
    limits: { maxSteps: 10 },
    deps: { generate: (a) => providerMod.run({ ...a, providerOverride: chosen }) },
    onStep: (s) => {
      const mark = s.refused ? 'REFUSED' : s.ok === false ? 'ERROR  ' : 'ok     ';
      say(`  [${String(s.seq).padStart(2)}] ${mark} ${String(s.tool).padEnd(12)} ${loop.clip(s.thought, 58)}`);
      const d = (s.refused || s.ok === false) ? s.error : s.result;
      if (d) say(`         -> ${loop.clip(String(d).replace(/\n/g, ' | '), 110)}`);
    },
  });

  say('\n=== outcome ===');
  say(`  status   ${r.status} (${r.stopReason})`);
  say(`  steps    ${r.stepCount}`);
  const row = db.aiRunGet(r.runId);
  say(`  cost     ${row.prompt_chars} prompt chars via ${row.provider}`);
  say(`  summary  ${r.summary}`);

  const used = db.aiRunSteps(r.runId).map((s) => s.tool);
  say(`  tools    ${[...new Set(used)].join(', ')}`);
} finally {
  await belt.close();
  db.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  say('\nbrowser closed.');
}
