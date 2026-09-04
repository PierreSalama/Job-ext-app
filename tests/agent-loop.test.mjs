// AI Apply chunk 2 — the agent loop.
//
// Most of this runs against a SCRIPTED model so the mechanism is tested deterministically: dispatch,
// refusal, error recovery, malformed JSON, the caps and the kill switch, and that the transcript is
// persisted in order. The last block runs the same loop against the REAL provider chain (Codex then
// Claude) and is skipped when no CLI is logged in, because the loop must be proven provider-agnostic
// before any real tool is wired to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const loop = require(path.join(here, '..', 'app', 'src', 'ai', 'agent-loop.js'));
const sandbox = require(path.join(here, '..', 'app', 'src', 'ai', 'tools', 'sandbox.js'));

// ---- an in-memory stand-in for the db writes, with the same surface ----------
function memStore() {
  const runs = new Map();
  const steps = [];
  return {
    steps,
    runs,
    aiRunCreate({ profileId, goal, autonomy, maxSteps, maxChars }) {
      const id = `run_${runs.size + 1}`;
      runs.set(id, { id, profileId, goal, autonomy, maxSteps, maxChars, status: 'running', steps: 0 });
      return id;
    },
    aiStepAppend(runId, step) {
      const dup = steps.find((s) => s.runId === runId && s.seq === step.seq);
      if (dup) throw new Error('duplicate seq — UNIQUE(run_id, seq) would reject this');
      steps.push({ runId, ...step });
      runs.get(runId).steps++;
    },
    aiRunFinish(runId, patch) { Object.assign(runs.get(runId), patch); },
  };
}

// A model that replays a fixed list of replies, and records the prompts it was given.
function scripted(replies) {
  const prompts = [];
  let i = 0;
  const fn = async ({ prompt, system }) => {
    prompts.push({ prompt, system });
    const r = replies[Math.min(i, replies.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return { text: typeof r === 'string' ? r : JSON.stringify(r), provider: 'scripted', model: 'test' };
  };
  fn.prompts = prompts;
  return fn;
}

const act = (tool, args, thought = 't') => JSON.stringify({ thought, tool, args });
const fin = (summary) => JSON.stringify({ thought: 'finished', done: true, summary });

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------
test('parses a bare JSON action', () => {
  const { action } = loop.parseAction('{"thought":"x","tool":"echo","args":{"text":"hi"}}');
  assert.equal(action.tool, 'echo');
  assert.equal(action.args.text, 'hi');
});

test('parses JSON wrapped in a code fence, which models emit constantly', () => {
  const { action } = loop.parseAction('```json\n{"tool":"add","args":{"a":1,"b":2}}\n```');
  assert.equal(action.tool, 'add');
});

test('parses JSON buried in prose', () => {
  const { action } = loop.parseAction('Sure! Here you go:\n{"tool":"echo","args":{"text":"z"}}\nHope that helps.');
  assert.equal(action.tool, 'echo');
});

test('recognises the finish action', () => {
  const { action } = loop.parseAction('{"done":true,"summary":"all set"}');
  assert.equal(action.done, true);
  assert.equal(action.summary, 'all set');
});

test('reports an error for a non-action reply instead of guessing', () => {
  assert.ok(loop.parseAction('I think we should click the button.').error);
  assert.ok(loop.parseAction('').error);
  assert.ok(loop.parseAction('[1,2,3]').error);
});

// ---------------------------------------------------------------------------
// dispatch + the loop
// ---------------------------------------------------------------------------
test('runs tools in order and finishes, persisting the transcript', async () => {
  const db = memStore();
  const r = await loop.runAgent({
    goal: 'add two numbers',
    tools: sandbox.safe,
    deps: { db, generate: scripted([act('add', { a: 2, b: 3 }), fin('the sum is 5')]) },
  });
  assert.equal(r.status, 'done');
  assert.equal(r.stopReason, 'done');
  assert.equal(r.summary, 'the sum is 5');
  assert.equal(db.steps.length, 2);
  assert.equal(db.steps[0].tool, 'add');
  assert.equal(db.steps[0].result, '5');
  assert.equal(db.steps[1].tool, 'done');
  assert.deepEqual(db.steps.map((s) => s.seq), [0, 1], 'seq must be dense and ordered');
  assert.equal(db.runs.get(r.runId).status, 'done');
});

test('a guarded tool is REFUSED and the run continues', async () => {
  const db = memStore();
  const r = await loop.runAgent({
    goal: 'try the drawer',
    tools: sandbox.all,
    deps: { db, generate: scripted([act('locked_drawer', { reason: 'curious' }), fin('gave up on the drawer')]) },
  });
  assert.equal(r.status, 'done');
  const refused = db.steps[0];
  assert.equal(refused.refused, true);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /off limits/);
  assert.equal(refused.result, null, 'a refused tool must produce no result at all');
});

test('an unknown tool is refused, and the model is told what does exist', async () => {
  const db = memStore();
  await loop.runAgent({
    goal: 'x',
    tools: sandbox.safe,
    deps: { db, generate: scripted([act('rm_rf', {}), fin('done')]) },
  });
  assert.equal(db.steps[0].refused, true);
  assert.match(db.steps[0].error, /no such tool "rm_rf"/);
  assert.match(db.steps[0].error, /echo/, 'must list the real tools');
});

test('a tool that throws is recorded as an error but does NOT kill the run', async () => {
  const db = memStore();
  const r = await loop.runAgent({
    goal: 'x',
    tools: sandbox.all,
    deps: { db, generate: scripted([act('explode', {}), act('echo', { text: 'recovered' }), fin('ok')]) },
  });
  assert.equal(r.status, 'done');
  assert.equal(db.steps[0].ok, false);
  assert.equal(db.steps[0].refused, false, 'a crash is not a refusal — they mean different things');
  assert.match(db.steps[0].error, /blew up on purpose/);
  assert.equal(db.steps[1].result, 'recovered');
});

test('a malformed reply is fed back and the model can recover', async () => {
  const db = memStore();
  const gen = scripted(['I would click the Apply button now.', act('echo', { text: 'ok' }), fin('done')]);
  const r = await loop.runAgent({ goal: 'x', tools: sandbox.safe, deps: { db, generate: gen } });
  assert.equal(r.status, 'done');
  assert.equal(db.steps[0].tool, '(unparsed)');
  assert.match(db.steps[0].error, /ONE JSON object/);
  assert.match(gen.prompts[1].prompt, /ONE JSON object/, 'the correction must reach the next prompt');
});

test('the step cap stops a runaway loop', async () => {
  const db = memStore();
  const r = await loop.runAgent({
    goal: 'loop forever',
    tools: sandbox.safe,
    limits: { maxSteps: 5 },
    deps: { db, generate: scripted([act('echo', { text: 'again' })]) },
  });
  assert.equal(r.status, 'stopped');
  assert.equal(r.stopReason, 'max_steps');
  assert.equal(db.steps.length, 5, 'must stop exactly at the cap');
});

test('the character budget stops the run before it spends more', async () => {
  const db = memStore();
  const r = await loop.runAgent({
    goal: 'x',
    tools: sandbox.safe,
    limits: { maxSteps: 100, maxChars: 1 },
    deps: { db, generate: scripted([act('echo', { text: 'hi' })]) },
  });
  assert.equal(r.stopReason, 'budget_chars');
  assert.ok(db.steps.length <= 1);
});

test('the kill switch stops the run at the next turn', async () => {
  const db = memStore();
  const signal = { aborted: false };
  const gen = async () => { signal.aborted = true; return { text: act('echo', { text: 'x' }), provider: 'p', model: 'm' }; };
  const r = await loop.runAgent({ goal: 'x', tools: sandbox.safe, signal, deps: { db, generate: gen } });
  assert.equal(r.status, 'stopped');
  assert.equal(r.stopReason, 'stopped');
});

test('a total provider failure fails the run honestly instead of inventing an action', async () => {
  const db = memStore();
  const r = await loop.runAgent({
    goal: 'x',
    tools: sandbox.safe,
    deps: { db, generate: scripted([new Error('All AI providers failed: codex(QUOTA), claude(AUTH)')]) },
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.stopReason, 'provider_failed');
  assert.match(r.error, /All AI providers failed/);
  assert.equal(db.runs.get(r.runId).status, 'failed');
});

test('onStep sees every step as it happens, for the live view', async () => {
  const db = memStore();
  const seen = [];
  await loop.runAgent({
    goal: 'x', tools: sandbox.safe, onStep: (s) => seen.push(s.tool),
    deps: { db, generate: scripted([act('echo', { text: 'a' }), fin('done')]) },
  });
  assert.deepEqual(seen, ['echo', 'done']);
});

// ---------------------------------------------------------------------------
// the summary must match the record
// ---------------------------------------------------------------------------
test('FOUND BY THE FIRST E2E RUN: a summary blaming missing tools is disputed', async () => {
  // The real thing: the model finished with "every subsequent tool call failed with 'No such
  // tool'" while the transcript showed nine steps and zero failures. It invented an outage.
  const db2 = memStore();
  const r = await loop.runAgent({
    goal: 'x',
    tools: sandbox.safe,
    deps: {
      db: db2,
      generate: scripted([act('echo', { text: 'fine' }),
        fin("Blocked by a tool outage: every subsequent tool call failed with 'No such tool'.")]),
    },
  });
  // Challenged once, then it repeats the same false claim, so the dispute is recorded.
  assert.match(r.summary, /RECORDED FACTS DISAGREE/);
  assert.match(r.summary, /every one succeeded/);
  assert.match(r.summary, /tool outage/, 'the original claim is kept, not silently rewritten');
  assert.ok(db2.steps.some((s) => s.tool === '(done-challenged)'), 'it must have been challenged first');
});

test('a disputed `done` is CHALLENGED once, and a corrected run finishes properly', async () => {
  // Twice on real runs the model quit claiming every tool had stopped working, after seventeen
  // consecutive successes and two steps from a finished application. Showing it the record gets
  // the work finished instead of throwing it away.
  const db2 = memStore();
  const r = await loop.runAgent({
    goal: 'x',
    tools: sandbox.safe,
    deps: {
      db: db2,
      generate: scripted([
        act('echo', { text: 'working' }),
        fin('Blocked by a tool outage: no such tool for everything I tried.'),
        act('echo', { text: 'actually fine' }),          // it carries on after being shown the record
        fin('Finished properly after checking the record.'),
      ]),
    },
  });
  assert.equal(r.status, 'done');
  assert.match(r.summary, /Finished properly/);
  assert.doesNotMatch(r.summary, /RECORDED FACTS DISAGREE/, 'the corrected summary is not flagged');
  const challenge = db2.steps.find((s) => s.tool === '(done-challenged)');
  assert.ok(challenge, 'the false claim must have been challenged');
  assert.match(challenge.error, /That is not what happened/);
  assert.match(challenge.error, /use ask_human/, 'and it must offer the honest way out');
});

test('the challenge happens at most ONCE, so a stubborn model still ends', async () => {
  const db2 = memStore();
  const r = await loop.runAgent({
    goal: 'x',
    tools: sandbox.safe,
    limits: { maxSteps: 12 },
    deps: { db: db2, generate: scripted([fin('Blocked by a tool outage, nothing worked.')]) },
  });
  assert.equal(db2.steps.filter((s) => s.tool === '(done-challenged)').length, 1);
  // And it must NOT be filed as a success. Found on a real run: shown the record, the model
  // repeated "all the tools stopped working" and the run was stored as `done` with that as its
  // summary, indistinguishable in the run list from an application that actually got prepared.
  assert.equal(r.status, 'failed');
  assert.equal(r.stopReason, 'disputed');
  assert.match(r.summary, /RECORDED FACTS DISAGREE/);
  const last = db2.steps[db2.steps.length - 1];
  assert.equal(last.tool, 'done');
  assert.equal(last.ok, false, 'a fabricated finish is not an ok step');
  assert.match(last.error, /contradicts the record/);
  assert.equal(last.result, null, 'the false summary must not be stored as a result');
});

test('an honest `done` is never challenged', async () => {
  const db2 = memStore();
  await loop.runAgent({
    goal: 'x',
    tools: sandbox.safe,
    deps: { db: db2, generate: scripted([act('echo', { text: 'a' }), fin('Echoed the text and finished.')]) },
  });
  assert.equal(db2.steps.some((s) => s.tool === '(done-challenged)'), false);
});

test('a summary claiming a submission that never happened is disputed', () => {
  const steps = [{ seq: 0, tool: 'fill', ok: true, refused: false }];
  const d = loop.disputeSummary('Application submitted to Acme successfully.', steps);
  assert.match(d, /no successful submit step/);
});

test('a PREPARE-mode park is not mistaken for a submission', () => {
  const steps = [{ seq: 0, tool: 'submit', ok: true, refused: false, result: 'NOT SUBMITTED — you are in Prepare mode. Block raised.' }];
  const d = loop.disputeSummary('Application submitted.', steps);
  assert.match(d, /no successful submit step/, 'parking is not submitting');
});

test('a real submission is NOT disputed', () => {
  const steps = [{ seq: 0, tool: 'submit', ok: true, refused: false, result: 'clicked "Submit Application".' }];
  assert.equal(loop.disputeSummary('Application submitted to Acme.', steps), null);
});

test('claiming documents that were never written is disputed', () => {
  const steps = [{ seq: 0, tool: 'read_page', ok: true, refused: false }];
  assert.match(loop.disputeSummary('I wrote a tailored resume for them.', steps), /no successful write_resume/);
  const wrote = [{ seq: 0, tool: 'write_resume', ok: true, refused: false }];
  assert.equal(loop.disputeSummary('I wrote a tailored resume for them.', wrote), null);
});

test('an honest summary of a run WITH failures is left alone', () => {
  // The dispute check must not fire when the model is telling the truth about a bad run.
  const steps = [{ seq: 0, tool: 'navigate', ok: false, refused: false, error: 'timeout' }];
  assert.equal(loop.disputeSummary('Every tool call failed, I could not get the page to load.', steps), null);
});

test('an ordinary summary is never disputed', () => {
  const steps = [{ seq: 0, tool: 'echo', ok: true, refused: false }];
  assert.equal(loop.disputeSummary('Found the code and finished.', steps), null);
});

// ---------------------------------------------------------------------------
// compaction — the cost control
// ---------------------------------------------------------------------------
test('old steps are folded to one line while recent ones stay verbatim', () => {
  const steps = Array.from({ length: 20 }, (_, i) => ({
    seq: i, thought: 'thinking about it '.repeat(10), tool: 'echo',
    args: { text: 'x'.repeat(200) }, ok: true, refused: false, result: 'y'.repeat(2000),
  }));
  const rendered = loop.renderTranscript(steps, { verbatimSteps: 3, resultClip: 1200 });
  assert.match(rendered, /EARLIER \(17 steps, condensed\)/);
  assert.ok(rendered.includes('17. thought:'), 'the last three must still be verbatim');
  assert.ok(!rendered.includes('2. thought:'), 'old steps must NOT keep their thoughts');
});

test('compaction actually bounds the prompt as a run grows long', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({
    seq: i, thought: 't'.repeat(300), tool: 'echo', args: { text: 'a'.repeat(500) },
    ok: true, refused: false, result: 'r'.repeat(3000),
  }));
  const cfg = { verbatimSteps: 6, resultClip: 1200 };
  const at10 = loop.renderTranscript(mk(10), cfg).length;
  const at200 = loop.renderTranscript(mk(200), cfg).length;
  const naive200 = mk(200).reduce((n, s) => n + s.thought.length + s.result.length, 0);
  assert.ok(at200 < naive200 / 10, `compacted ${at200} must be far below naive ${naive200}`);
  assert.ok(at200 - at10 < 20000, 'growth from 10 to 200 steps must stay small and linear-ish');
});

test('a refused step keeps its reason after compaction, because it changes what to do next', () => {
  const steps = Array.from({ length: 10 }, (_, i) => ({
    seq: i, thought: 't', tool: 'locked_drawer', args: {}, ok: false, refused: true,
    error: 'the locked drawer is off limits',
  }));
  const rendered = loop.renderTranscript(steps, { verbatimSteps: 2, resultClip: 200 });
  assert.match(rendered, /REFUSED/);
  assert.match(rendered, /off limits/);
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------
test('the registry rejects a duplicate or malformed tool at build time', () => {
  assert.throws(() => loop.makeRegistry([sandbox.echo, sandbox.echo]), /duplicate tool/);
  assert.throws(() => loop.makeRegistry([{ name: 'x' }]), /bad tool definition/);
});

test('the system prompt lists every tool with its arguments', () => {
  const sys = loop.systemPrompt(loop.makeRegistry(sandbox.safe), 'do the thing');
  assert.match(sys, /do the thing/);
  assert.match(sys, /- echo\(text\)/);
  assert.match(sys, /- add\(a, b\)/);
  assert.match(sys, /- lookup_code\(room\)/);
});

// ---------------------------------------------------------------------------
// REAL providers — the provider-agnostic proof
// ---------------------------------------------------------------------------
// The loop must behave identically on Codex and Claude. This asks the model to do something it
// cannot fake: retrieve a code it has never seen and report it back. A correct summary proves it
// executed a real tool call rather than talking its way to a plausible answer.
const providerMod = require(path.join(here, '..', 'app', 'src', 'ai', 'provider.js'));
const realDb = require(path.join(here, '..', 'app', 'src', 'db.js'));
const fs = require('node:fs');
const os = require('node:os');

// ---------------------------------------------------------------------------
// the REAL tables — proves the migration and the helpers, not just the loop
// ---------------------------------------------------------------------------
test('ai_runs / ai_steps persist a transcript in the real database', () => {
  {
    const runId = realDb.aiRunCreate({ goal: 'test goal', autonomy: 'auto', maxSteps: 9 });
    realDb.aiStepAppend(runId, { seq: 0, tool: 'echo', args: { text: 'a' }, result: 'a', promptChars: 100, responseChars: 20, provider: 'codex', model: 'gpt-5.4' });
    realDb.aiStepAppend(runId, { seq: 1, tool: 'locked_drawer', ok: false, refused: true, error: 'off limits', promptChars: 50, responseChars: 10 });
    realDb.aiRunFinish(runId, { status: 'done', stopReason: 'done', summary: 'finished' });

    const row = realDb.aiRunGet(runId);
    assert.equal(row.status, 'done');
    assert.equal(row.autonomy, 'auto');
    assert.equal(row.steps, 2, 'the run must count its own steps');
    assert.equal(row.prompt_chars, 150, 'token cost must SUM from the steps');
    assert.equal(row.response_chars, 30);
    assert.equal(row.provider, 'codex');

    const steps = realDb.aiRunSteps(runId);
    assert.deepEqual(steps.map((s) => s.seq), [0, 1], 'steps come back in order');
    assert.equal(steps[1].refused, 1);
    assert.deepEqual(JSON.parse(steps[0].args), { text: 'a' });

    assert.throws(() => realDb.aiStepAppend(runId, { seq: 0, tool: 'echo' }),
      /UNIQUE|constraint/i, 'a resumed run must not be able to double-write a step');
    assert.throws(() => realDb.aiStepAppend(runId, { tool: 'echo' }), /integer seq/);

    assert.ok(realDb.aiRunList({ limit: 5 }).some((r) => r.id === runId));
  }
});

// Do NOT trust status(). A quota-exhausted account is still "logged in" and still reports
// available:true — that exact pair is what let both nodes sit dead for hours on 2026-09-03. The
// only honest check is to actually ask the model something and read what comes back.
//
// An environment problem (no CLI, no login, quota spent) SKIPS with the real reason printed.
// Anything else is a genuine failure and must not be swallowed.
const ENV_FAIL = /quota|usage limit|not supported when using|CODEX_AUTH|CLAUDE_.*ERR|not found|needsLogin|no provider|NO_PROVIDER|AI_DISABLED/i;

// ONE database for every provider-touching test in this file. Opening and closing per probe raced
// with codex.js's internal retry, whose ai_log write landed after the close and surfaced as a
// bogus "database is closed" that looked like an environment failure. One open, closed at exit.
const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jat-loop-live-'));
realDb.open(liveDir);
process.on('exit', () => {
  try { realDb.close(); } catch { /* already closed */ }
  try { fs.rmSync(liveDir, { recursive: true, force: true }); } catch { /* temp */ }
});

async function probe(name) {
  try {
    await providerMod.run({
      kind: 'agent-step', prose: false, providerOverride: name,
      system: 'Reply with one word.', prompt: 'Say READY and nothing else.',
    });
    return { name, ok: true };
  } catch (e) {
    // provider.run's MESSAGE is deliberately a terse roll-up ("codex(CODEX_EXIT)"); the per-provider
    // text lives on e.details. Reading only the message is how a diagnosable failure looks opaque.
    const detail = Array.isArray(e.details)
      ? e.details.map((d) => `${d.provider}: ${d.message || d.code}`).join(' | ')
      : '';
    return { name, ok: false, reason: `${e.message || e}${detail ? ` — ${detail}` : ''}`.slice(0, 300) };
  }
}

const probes = [await probe('codex'), await probe('claude')];
for (const p of probes) {
  if (!p.ok) console.log(`[agent-loop] ${p.name} UNUSABLE on this machine: ${p.reason}`);
}
const live = probes.filter((p) => p.ok).map((p) => p.name);
const reasonFor = (n) => (probes.find((p) => p.name === n) || {}).reason || 'unavailable';

for (const name of ['codex', 'claude']) {
  test(`REAL ${name}: completes a two-step task through the loop`, {
    skip: live.includes(name) ? false : `${name} unusable here — ${reasonFor(name)}`,
    timeout: 180000,
  }, async () => {
    // The real database too: provider.run reads settings and writes ai_log, and this also proves
    // the loop's own transcript survives a genuine end-to-end run rather than an in-memory stub.
    {
      const r = await loop.runAgent({
        goal: 'Find the access code for the room called "vault" and then finish, putting the code in your summary.',
        tools: sandbox.safe,
        limits: { maxSteps: 6 },
        deps: { generate: (a) => providerMod.run({ ...a, providerOverride: name }) },
      });
      // A provider can be usable at probe time and out of quota ninety seconds later — Codex did
      // exactly that on 2026-09-03, which turned a healthy suite into a coin flip. An environment
      // failure MID-RUN is not a product failure, so report it and stop rather than fail. Anything
      // else still fails loudly, which is the whole point of this test.
      if (r.status === 'failed' && ENV_FAIL.test(String(r.error || ''))) {
        console.log(`[agent-loop] ${name} became unusable DURING the run: ${String(r.error).slice(0, 160)}`);
        return;
      }
      assert.equal(r.status, 'done', `run ended ${r.stopReason}: ${r.error || ''}`);
      const steps = realDb.aiRunSteps(r.runId);
      const used = steps.find((s) => s.tool === 'lookup_code');
      assert.ok(used, 'the model must actually call lookup_code');
      assert.equal(used.result, sandbox.SECRETS.vault);
      assert.match(r.summary, /ELDERFLOWER-22/, 'the code must reach the summary — proof the tool ran');
      assert.equal(realDb.aiRunGet(r.runId).status, 'done');
      assert.ok(realDb.aiRunGet(r.runId).prompt_chars > 0, 'real token cost must be recorded');
    }
  });
}

// Not skipped: this is the honest report of what this machine can actually do. It fails only if a
// provider broke for a reason that is NOT an environment problem, which is a real regression.
test('provider availability is reported honestly, not assumed', () => {
  for (const p of probes) {
    if (p.ok) continue;
    assert.match(p.reason, ENV_FAIL,
      `${p.name} failed for a non-environment reason, which is a real bug: ${p.reason}`);
  }
  if (!live.length) {
    console.log('[agent-loop] NOTE: no usable model on this machine, so the live loop test could not run.');
  }
});
