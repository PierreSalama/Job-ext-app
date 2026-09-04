// AI Apply — the first real end-to-end run.
//
//   node tools/apply-e2e.mjs [postingUrl]
//
// The whole pipeline against a live posting: browser + ledger + documents + escalation, with the
// guardrail layer in front of every tool.
//
// SAFE BY CONSTRUCTION
//   · Prepare mode, so `submit` never clicks — it parks the application for a human.
//   · A COPY of the live database, so `log_application` cannot touch the real ledger.
//   · Documents are written to a scratch folder, not the real applications directory.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);

const say = (s = '') => process.stdout.write(s + '\n');
const arg = process.argv[2] || '';
// `--fixture` serves a realistic ATS form locally, from an employer that is genuinely not in the
// ledger. It exercises the half of the pipeline a live posting cannot: writing documents, filling
// the fields, and submit PARKING instead of clicking. Filling a real employer's form with a test
// run and abandoning it half-completed is not a thing to do to someone's application system.
const USE_FIXTURE = arg === '--fixture' || !arg;
const URL_ARG = USE_FIXTURE ? '' : arg;

// --- isolate everything -----------------------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-e2e-'));
fs.copyFileSync(path.join(process.env.APPDATA, 'jat11-app', 'jat.db'), path.join(work, 'jat.db'));
const docsDir = path.join(work, 'documents');

const db = require(path.join(root, 'app/src/db.js'));
const loop = require(path.join(root, 'app/src/ai/agent-loop.js'));
const providerMod = require(path.join(root, 'app/src/ai/provider.js'));
const { makeBrowserTools } = require(path.join(root, 'app/src/ai/tools/browser.js'));
const { makeJatTools } = require(path.join(root, 'app/src/ai/tools/jat.js'));
const { makeDocumentTools } = require(path.join(root, 'app/src/ai/tools/documents.js'));
const { makeEscalateTools } = require(path.join(root, 'app/src/ai/tools/escalate.js'));
const { makePolicy, wrapTools } = require(path.join(root, 'app/src/ai/guardrails.js'));
const browserTools = require(path.join(root, 'app/src/ai/tools/browser.js'));
// This run writes its documents to a scratch folder instead of the real applications directory, so
// that scratch folder has to be uploadable too — otherwise the agent is refused for attaching a
// file it just created, which is a property of the TEST rig, not of the system.
browserTools.allowUploadRoot(docsDir);

db.open(work);
say(`working on a COPY of the ledger — the real one is untouched\ndocuments -> ${docsDir}\n`);

// --- pick a model -----------------------------------------------------------
async function probe(n) {
  try { await providerMod.run({ kind: 'agent-step', providerOverride: n, system: 'One word.', prompt: 'Say READY.' }); return true; }
  catch { return false; }
}
let chosen = null;
say('=== provider probe ===');
for (const n of ['codex', 'claude']) {
  const ok = await probe(n);
  say(`  ${n.padEnd(7)} ${ok ? 'USABLE' : 'unusable'}`);
  if (ok && !chosen) chosen = n;
}
if (!chosen) { say('\nno usable model'); db.close(); process.exit(1); }

// --- assemble the real toolset ----------------------------------------------
const belt = makeBrowserTools({ profileId: 'e2e', port: 9288, headless: true });
const blocks = [];
const refusals = [];

let tools = [
  ...belt.tools,
  ...makeJatTools({}).tools,
  ...makeDocumentTools({ root: docsDir }).tools,
  ...makeEscalateTools({
    autonomy: 'prepare',
    page: () => belt.page(),
    context: () => ({ url: belt.lastUrl() }),
    onBlock: (b) => blocks.push(b),
  }).tools,
];
tools = wrapTools(tools, makePolicy({
  page: () => belt.page(),
  salaryFloor: Number(db.getSettings().autoApply.salaryFloor) || 0,
  context: () => ({ url: belt.lastUrl() }),
}), { onRefusal: (t, why) => refusals.push({ tool: t, why }) });

// --- the target ------------------------------------------------------------
let server = null;
let URL_ = URL_ARG;
if (USE_FIXTURE) {
  const http = await import('node:http');
  const FORM = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Northbeam Robotics</title></head>
<body>
  <h1>Northbeam Robotics</h1>
  <h2>Software Developer, Platform</h2>
  <p>Toronto, hybrid. We build control software for warehouse robots. You will work across a
  Python and Node backend, a React front end, and the PostgreSQL layer under both. We ask for
  2+ years of professional experience. Bonus: experience integrating an ERP, and CI/CD you built
  yourself. Base salary CAD 105,000 to 130,000.</p>
  <form>
    <label for="name">Full name</label><input id="name" aria-label="Full name" type="text" />
    <label for="email">Email</label><input id="email" aria-label="Email" type="email" />
    <label for="phone">Phone number</label><input id="phone" aria-label="Phone number" type="text" />
    <label for="cv">Resume</label>
    <input id="cv" type="file" class="hidden" aria-hidden="true" style="display:none" />
    <button type="button" id="cvbtn">Upload resume</button>
    <label for="why">Why do you want to work here?</label>
    <textarea id="why" aria-label="Why do you want to work here?"></textarea>
    <label for="salary">Salary expectations</label><input id="salary" aria-label="Salary expectations" type="text" />
    <fieldset><legend>Voluntary Self-Identification</legend>
      <label><input type="radio" name="gender" value="m" aria-label="Male" /> Male</label>
      <label><input type="radio" name="gender" value="f" aria-label="Female" /> Female</label>
    </fieldset>
    <button type="button" id="go">Submit Application</button>
  </form>
  <p id="status">not submitted</p>
  <script>document.getElementById('go').onclick=()=>{document.getElementById('status').textContent='SUBMITTED';};</script>
</body></html>`;
  server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(FORM); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  URL_ = `http://127.0.0.1:${server.address().port}/apply`;
  say(`fixture employer: Northbeam Robotics (deliberately not in the ledger) at ${URL_}`);
}

say(`\n>>> ${chosen} · Prepare mode · ${tools.length} tools · ${URL_}\n`);
say('=== transcript ===');

try {
  const r = await loop.runAgent({
    goal: `Prepare a job application at ${URL_} for the candidate.\n`
      + 'Work in this order:\n'
      + '1. check_duplicate FIRST, using the posting url. If it is a duplicate, finish immediately and say so.\n'
      + '2. Read the posting and the form.\n'
      + '3. Use my_profile and recall_answer for anything about the candidate. NEVER invent a fact.\n'
      + '4. Write a tailored resume with write_resume and a cover letter with write_cover_letter.\n'
      + '5. Fill the form fields you can, attaching the rendered PDF.\n'
      + '6. Call submit when the form is complete. Do not click any submit button yourself.\n'
      + 'If anything needs a human, use ask_human and finish.',
    tools,
    // The product default is 40. The rig used to cap at 26, which was fine until runs started
    // reading the real résumé and occasionally rewriting an answer the voice check rejected:
    // the application would be fully prepared and parked, then the run would be recorded as
    // `stopped (max_steps)` because it had no step left to say so.
    limits: { maxSteps: 40, maxChars: 400000 },
    deps: { generate: (a) => providerMod.run({ ...a, providerOverride: chosen }) },
    onStep: (s) => {
      const mark = s.refused ? 'REFUSED' : s.ok === false ? 'ERROR  ' : 'ok     ';
      say(`  [${String(s.seq).padStart(2)}] ${mark} ${String(s.tool).padEnd(18)} ${loop.clip(s.thought, 52)}`);
      const d = (s.refused || s.ok === false) ? s.error : s.result;
      if (d) say(`         -> ${loop.clip(String(d).replace(/\s+/g, ' '), 130)}`);
    },
  });

  say('\n=== outcome ===');
  const row = db.aiRunGet(r.runId);
  say(`  status    ${r.status} (${r.stopReason})`);
  say(`  steps     ${r.stepCount}`);
  say(`  cost      ${row.prompt_chars} prompt chars via ${row.provider}`);
  say(`  summary   ${loop.clip(r.summary, 300)}`);
  say(`  tools     ${[...new Set(db.aiRunSteps(r.runId).map((s) => s.tool))].join(', ')}`);

  say(`\n  policy refusals: ${refusals.length}`);
  for (const x of refusals) say(`    ${x.tool}: ${String(x.why).slice(0, 110)}`);

  say(`\n  blocks raised: ${blocks.length}`);
  for (const b of blocks) say(`    [${b.kind}] ${String(b.question).slice(0, 100)}`);

  say('\n  documents written:');
  const walk = (d, ind = '    ') => {
    if (!fs.existsSync(d)) return say(`${ind}(none)`);
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) { say(`${ind}${f}/`); walk(p, ind + '  '); }
      else say(`${ind}${f} (${fs.statSync(p).size} bytes)`);
    }
  };
  walk(docsDir);
} catch (e) {
  say(`\n!! ${e.stack || e.message}`);
} finally {
  await belt.close();
  if (server) await new Promise((r) => server.close(r));
  db.close();
  say(`\nscratch kept for inspection: ${work}`);
}
