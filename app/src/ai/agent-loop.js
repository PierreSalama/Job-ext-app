'use strict';
// ============================================================================
//  JAT v11 — AI Apply agent loop (chunk 2)
//
//  WHAT THIS IS
//  The existing AI layer answers ONE question and stops. An application takes hundreds of small
//  decisions in a row. This is the loop that turns the former into the latter: ask the model for
//  exactly one next action, run it through the dispatcher, feed the result back, repeat.
//
//  PROVIDER-AGNOSTIC ON PURPOSE
//  Every model call goes through `provider.run`, which already owns the order (codex → claude →
//  remote → local), the failover, the quota block and the ai_log accounting. The loop therefore
//  works identically on Codex and Claude and gains nothing from an SDK that speaks only one of
//  them. It never imports a provider directly.
//
//  ONE ACTION PER TURN
//  Not a batch. A batch cannot react to what the page actually did, and every expensive mistake
//  overnight came from acting on a stale read. One action, then look again.
//
//  THE DISPATCHER IS THE CHOKEPOINT
//  Nothing reaches a tool except through `dispatch`. Chunk 2 ships the mechanism with a deliberately
//  refused tool proving the path works; chunk 8 fills it with the real rules. A guardrail that lives
//  in a system prompt is a suggestion — this one is a function that returns `refused`.
//
//  COMPACTION IS NOT POLISH
//  `claude -p` is stateless: every turn re-sends the transcript, so a naive loop pays for its whole
//  history on every single step and an overnight run costs real money. Older steps are folded to one
//  line each here, from the first commit, because retrofitting it after the first expensive night is
//  how you find out it needed to be structural.
// ============================================================================

const provider = require('./provider');

let log = { info() {}, warn() {}, error() {} };
try { log = require('../logger').scope('ai:loop'); } catch { /* usable outside the app */ }

const DEFAULTS = {
  maxSteps: 40,
  maxChars: 400000,     // total prompt characters across the run — the money cap
  maxWallMs: 30 * 60e3,
  verbatimSteps: 6,     // most recent steps kept in full; older ones are folded to one line
  resultClip: 1200,     // a single observation never floods the window
};

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------
// A tool is { name, description, args, run(args, ctx), guard?(args, ctx) }.
// `guard` returns a string to REFUSE with that reason, or null/undefined to allow.
function makeRegistry(tools = []) {
  const byName = new Map();
  for (const t of tools) {
    if (!t || !t.name || typeof t.run !== 'function') throw new Error('bad tool definition');
    if (byName.has(t.name)) throw new Error(`duplicate tool ${t.name}`);
    byName.set(t.name, t);
  }
  return {
    has: (n) => byName.has(n),
    get: (n) => byName.get(n),
    names: () => [...byName.keys()],
    describe: () => [...byName.values()]
      .map((t) => `- ${t.name}(${(t.args || []).join(', ')}): ${t.description || ''}`)
      .join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------
function systemPrompt(registry, goal, extra = '') {
  return [
    'You are driving a job application, one small action at a time.',
    '',
    'GOAL:',
    goal,
    '',
    'TOOLS:',
    registry.describe(),
    '',
    'Reply with ONE JSON object and nothing else. No prose, no code fence.',
    'To act:      {"thought":"why, in one short sentence","tool":"<name>","args":{...}}',
    'To finish:   {"thought":"why you are done","done":true,"summary":"what you achieved"}',
    '',
    'Rules:',
    '- Exactly one action per reply. Never batch.',
    '- If a tool is refused, do not retry it. Choose a different approach or finish.',
    '- If you have the answer the goal asked for, finish immediately. Do not pad the run.',
    extra,
  ].filter(Boolean).join('\n');
}

// Fold the transcript: recent turns in full, older ones as one line each. The oldest are what the
// model needs least and what costs the most to keep re-sending.
function renderTranscript(steps, { verbatimSteps, resultClip }) {
  if (!steps.length) return '(nothing yet — this is your first action)';
  const cut = Math.max(0, steps.length - verbatimSteps);
  const older = steps.slice(0, cut);
  const recent = steps.slice(cut);
  const out = [];
  if (older.length) {
    out.push(`EARLIER (${older.length} steps, condensed):`);
    for (const s of older) {
      const verdict = s.refused ? 'REFUSED' : s.ok === false ? 'ERROR' : 'ok';
      out.push(`  ${s.seq}. ${s.tool} -> ${verdict}${s.ok === false || s.refused ? `: ${clip(s.error || '', 90)}` : ''}`);
    }
    out.push('');
  }
  out.push('RECENT:');
  for (const s of recent) {
    out.push(`  ${s.seq}. thought: ${clip(s.thought || '', 200)}`);
    out.push(`     action:  ${s.tool} ${JSON.stringify(s.args || {}).slice(0, 300)}`);
    if (s.refused) out.push(`     REFUSED: ${clip(s.error, 300)}`);
    else if (s.ok === false) out.push(`     ERROR:   ${clip(s.error, 300)}`);
    else out.push(`     result:  ${clip(s.result, resultClip)}`);
  }
  return out.join('\n');
}

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// Does the model's closing summary contradict what actually happened? Deliberately NARROW: it only
// catches claims that are flatly checkable against the step record, because a false positive here
// would put a scary contradiction notice on a perfectly good run.
function disputeSummary(summary, steps) {
  const s = String(summary || '').toLowerCase();
  if (!s) return null;
  // Only REAL tool outcomes count. `(unparsed)` and `(done-challenged)` are the loop talking to
  // itself, and counting them as tool failures made the second dispute silently not fire — the
  // challenge step became the evidence that the model's "everything failed" claim was true.
  const isTool = (x) => x.tool && !String(x.tool).startsWith('(');
  const failures = steps.filter((x) => isTool(x) && x.ok === false && !x.refused).length;
  const refusals = steps.filter((x) => isTool(x) && x.refused).length;
  const problems = [];

  const claimsToolOutage = /no such tool|tool outage|tools? (?:are |were )?(?:unavailable|missing|not available)|every (?:subsequent )?tool call failed/.test(s);
  if (claimsToolOutage && failures === 0 && refusals === 0) {
    problems.push(`the summary blames failing or missing tools, but no tool error or refusal was recorded across ${steps.length} step(s) — every one succeeded.`);
  }

  const claimsSubmitted = /\b(submitted|applied successfully|application (?:was )?sent)\b/.test(s);
  const reallySubmitted = steps.some((x) => x.tool === 'submit' && x.ok !== false && !x.refused
    && !/NOT SUBMITTED/i.test(String(x.result || '')));
  if (claimsSubmitted && !reallySubmitted) {
    problems.push('the summary says an application was submitted, but no successful submit step was recorded.');
  }

  const claimsDocs = /\b(wrote|written|prepared|tailored) (?:a |the )?(?:r[ée]sum[ée]|cover letter)/.test(s);
  const reallyWrote = steps.some((x) => /^write_(resume|cover_letter)$/.test(String(x.tool)) && x.ok !== false && !x.refused);
  if (claimsDocs && !reallyWrote) {
    problems.push('the summary says documents were written, but no successful write_resume or write_cover_letter step was recorded.');
  }

  return problems.length ? problems.join(' ') : null;
}

// Models wrap JSON in prose or a fence no matter how firmly you ask. Recover instead of failing the
// run: a parse failure is fed back as an observation so the model can correct itself.
function parseAction(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { error: 'empty reply' };
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(raw);
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(raw.slice(first, last + 1));

  for (const c of candidates) {
    let obj;
    try { obj = JSON.parse(c); } catch { continue; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    if (obj.done === true) {
      return { action: { done: true, thought: str(obj.thought), summary: str(obj.summary) } };
    }
    if (typeof obj.tool === 'string' && obj.tool) {
      const args = obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args) ? obj.args : {};
      return { action: { done: false, thought: str(obj.thought), tool: obj.tool, args } };
    }
  }
  return { error: 'reply was not a single JSON action object' };
}
const str = (v) => (v == null ? '' : String(v));

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------
// `deps` is injectable so tests can drive the loop with a scripted model and an in-memory store,
// and so the real caller passes the live provider + db without the loop importing either directly.
async function runAgent(opts = {}) {
  const {
    goal,
    tools = [],
    profileId = null,
    autonomy = 'prepare',
    limits = {},
    systemExtra = '',
    signal = null,           // { aborted: boolean } — the kill switch
    onStep = null,
    deps = {},
  } = opts;

  if (!goal) throw new Error('runAgent needs a goal');
  const cfg = { ...DEFAULTS, ...limits };
  const registry = makeRegistry(tools);
  const generate = deps.generate || ((args) => provider.run(args));
  const store = deps.db || require('../db');
  const clock = deps.now || (() => Date.now());

  const runId = store.aiRunCreate({
    profileId, goal, autonomy, maxSteps: cfg.maxSteps, maxChars: cfg.maxChars,
  });

  const system = systemPrompt(registry, goal, systemExtra);
  const steps = [];
  const startedAt = clock();
  let seq = 0;
  let promptCharsTotal = 0;
  let stopReason = null;
  let summary = '';
  let challengedOnce = false;   // a disputed `done` is challenged at most once per run
  let status = 'done';
  let lastError = null;

  const ctx = { runId, profileId, autonomy, goal };

  try {
    for (;;) {
      if (signal && signal.aborted) { stopReason = 'stopped'; status = 'stopped'; break; }
      if (seq >= cfg.maxSteps) { stopReason = 'max_steps'; status = 'stopped'; break; }
      if (promptCharsTotal >= cfg.maxChars) { stopReason = 'budget_chars'; status = 'stopped'; break; }
      if (clock() - startedAt >= cfg.maxWallMs) { stopReason = 'timeout'; status = 'stopped'; break; }

      const prompt = [
        renderTranscript(steps, cfg),
        '',
        `You have taken ${seq} of a maximum ${cfg.maxSteps} actions.`,
        'What is the single next action? Reply with one JSON object.',
      ].join('\n');
      promptCharsTotal += prompt.length + system.length;

      const t0 = clock();
      let reply;
      try {
        reply = await generate({ kind: 'agent-step', prompt, system, prose: false });
      } catch (e) {
        // Every provider failed. This is terminal for the run — the loop cannot invent an action.
        lastError = e.message || String(e);
        stopReason = 'provider_failed';
        status = 'failed';
        break;
      }
      const ms = clock() - t0;
      const text = reply && (reply.text != null ? reply.text : reply.json ? JSON.stringify(reply.json) : '');
      const meta = {
        provider: reply && reply.provider, model: reply && reply.model,
        promptChars: prompt.length + system.length,
        responseChars: String(text || '').length,
        ms,
      };

      const parsed = parseAction(text);
      if (parsed.error) {
        // Feed the failure back rather than dying. The model usually corrects on the next turn.
        const step = {
          seq: seq++, thought: '', tool: '(unparsed)', args: {}, ok: false, refused: false,
          error: `${parsed.error}. Reply with ONE JSON object, nothing else.`,
          result: null, ...meta,
        };
        steps.push(step); store.aiStepAppend(runId, step); if (onStep) onStep(step, runId);
        continue;
      }

      const action = parsed.action;
      if (action.done) {
        summary = action.summary || '';
        // CHECK THE SUMMARY AGAINST THE RECORD.
        //
        // On the first end-to-end run the model finished with "every subsequent tool call failed
        // with 'No such tool'" — while the transcript showed nine steps, zero failures and zero
        // refusals. It invented an outage and quit on it. A run that reports work it did not do,
        // or blames a failure that did not happen, is worse than one that fails honestly: the
        // whole point of the transcript is that it can be trusted afterwards.
        const disputed = disputeSummary(summary, steps);
        if (disputed && !challengedOnce) {
          // GIVE IT THE RECORD AND ONE CHANCE TO CARRY ON.
          //
          // Twice on real runs the model finished with "all the tools stopped working" after
          // seventeen consecutive successes — once with the résumé written, the form filled and
          // the PDF attached, two steps from a finished application. Simply recording the
          // contradiction is honest but wastes the work. Showing it the record instead usually
          // gets the run finished, and it happens exactly once so a stubborn model still ends.
          challengedOnce = true;
          const step = {
            seq: seq++, thought: action.thought, tool: '(done-challenged)', args: {},
            ok: false, refused: false, result: null,
            error: `That is not what happened. ${disputed} Look at the record above: if the work is `
              + 'genuinely unfinished, take the next action. If it is finished, say done again with an '
              + 'accurate summary. If something really is blocking you, use ask_human.',
            ...meta,
          };
          steps.push(step); store.aiStepAppend(runId, step); if (onStep) onStep(step, runId);
          continue;
        }
        // Shown the record and asked again, it repeated the false claim. The work is NOT done, and
        // the one thing that must not happen is a fabricated success sitting in the run list looking
        // exactly like a real one. It ends as a FAILURE, with the contradiction on the record.
        if (disputed) {
          summary = `${summary}\n\n[RECORDED FACTS DISAGREE] ${disputed}`;
          log.warn(`run summary disputed twice, recording the run as failed: ${disputed}`);
          lastError = `the summary contradicts what actually happened: ${disputed}`;
        }
        const step = {
          seq: seq++, thought: action.thought, tool: 'done', args: {}, ok: !disputed,
          result: disputed ? null : summary,
          error: disputed ? `summary contradicts the record: ${disputed}` : null,
          ...meta,
        };
        steps.push(step); store.aiStepAppend(runId, step); if (onStep) onStep(step, runId);
        stopReason = disputed ? 'disputed' : 'done';
        status = disputed ? 'failed' : 'done';
        break;
      }

      const step = await dispatch(registry, action, ctx, meta, seq++);
      steps.push(step); store.aiStepAppend(runId, step); if (onStep) onStep(step, runId);
    }
  } catch (e) {
    lastError = e.message || String(e);
    stopReason = stopReason || 'crashed';
    status = 'failed';
    log.error('agent loop crashed', lastError);
  }

  store.aiRunFinish(runId, { status, stopReason, error: lastError, summary });
  return {
    runId, status, stopReason, summary, steps,
    stepCount: steps.length, promptChars: promptCharsTotal,
    error: lastError,
  };
}

// The one place a tool can be reached. Unknown tool, guard refusal and thrown error all resolve to
// a step the model can read and react to — never an exception that kills the run.
async function dispatch(registry, action, ctx, meta, seq) {
  const base = { seq, thought: action.thought, tool: action.tool, args: action.args, ...meta };

  const tool = registry.get(action.tool);
  if (!tool) {
    return {
      ...base, ok: false, refused: true, result: null,
      error: `no such tool "${action.tool}". Available: ${registry.names().join(', ')}`,
    };
  }
  if (typeof tool.guard === 'function') {
    let reason = null;
    try { reason = await tool.guard(action.args, ctx); } catch (e) { reason = e.message || 'guard failed'; }
    if (reason) return { ...base, ok: false, refused: true, result: null, error: String(reason) };
  }
  try {
    const out = await tool.run(action.args, ctx);
    const result = typeof out === 'string' ? out : JSON.stringify(out === undefined ? null : out);
    return { ...base, ok: true, refused: false, result, error: null };
  } catch (e) {
    return { ...base, ok: false, refused: false, result: null, error: String(e.message || e).slice(0, 500) };
  }
}

module.exports = {
  runAgent, makeRegistry, parseAction, renderTranscript, systemPrompt, dispatch, clip,
  disputeSummary, DEFAULTS,
};
