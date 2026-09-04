'use strict';
// ============================================================================
//  JAT v11 — AI Apply runner (chunk 3)
//
//  Owns the LIFECYCLE of an agent run: start it, stream its steps, stop it. The loop itself
//  (agent-loop.js) is deliberately stateless and knows nothing about HTTP, SSE or who is watching.
//  This is the thin layer between it and the server.
//
//  ONE RUN PER PROFILE, not one globally. Chunk 10 runs Pierre and Dad at the same time on the
//  server laptop, so the registry is keyed by profile from the start — making it global now would
//  guarantee a rewrite later.
//
//  THE KILL SWITCH IS A FLAG, NOT A PROCESS SIGNAL. The loop checks `signal.aborted` at the top of
//  every turn, so Stop lands between actions rather than halfway through one. A run killed mid-tool
//  would leave a half-filled form and a step we never recorded.
//
//  Chunk 3 wires SANDBOX tools only. No browser, no ledger writes. The page is being proven before
//  anything that can touch a real application is attached to it.
// ============================================================================

const crypto = require('crypto');
const { runAgent } = require('./agent-loop');
const sandbox = require('./tools/sandbox');
const { makeBrowserTools } = require('./tools/browser');
const { makeJatTools, ENGAGED } = require('./tools/jat');
const { makeDocumentTools } = require('./tools/documents');
const { makeEscalateTools } = require('./tools/escalate');
const { makePolicy, wrapTools } = require('./guardrails');
const db = require('../db');

const TOOLSETS = new Set(['sandbox', 'browser', 'apply']);

let log = { info() {}, warn() {}, error() {} };
try { log = require('../logger').scope('ai:apply-runner'); } catch { /* usable outside the app */ }

const DEMO_GOAL =
  'Find the access code for the room called "vault", then try the locked drawer exactly once, '
  + 'then finish with the code in your summary.';

// profileId -> { runId, signal, startedAt, autonomy, goal, steps, done, promise, belt }
const active = new Map();

// A STABLE, DISTINCT debug port per person. Derived from the profile id rather than handed out in
// sequence, so Pierre is always on the same port across restarts and can never collide with Dad —
// two runs sharing a port would silently drive the same window.
const PORT_BASE = 9230;
const PORT_SPAN = 60;
function portFor(profileId) {
  const h = crypto.createHash('sha1').update(String(profileId || 'default')).digest();
  return PORT_BASE + (h.readUInt16BE(0) % PORT_SPAN);
}

let emit = () => {};
// Does this base URL point back at us? Compared against every address this machine answers on,
// because the node is configured by its Tailscale address, not by "localhost".
function isSelfUrl(baseUrl) {
  let host;
  try { host = new URL(String(baseUrl)).hostname.toLowerCase(); } catch { return false; }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  const os = require('os');
  for (const list of Object.values(os.networkInterfaces() || {})) {
    for (const ni of list || []) if (String(ni.address).toLowerCase() === host) return true;
  }
  return false;
}

// Ask the other machines whether an employer has already been applied to.
//
// Kept here rather than in tools/jat.js so that module stays free of transport and can be tested
// without a network, the same arrangement the alert bridge uses.
function makePeers() {
  const get = async (node, path) => {
    const res = await fetch(`${String(node.baseUrl).replace(/\/$/, '')}${path}`, {
      headers: { 'X-JAT-Token': node.token || '' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    return res.json();
  };
  return {
    nodes: async () => {
      try {
        const me = new Set([require('os').hostname().toLowerCase()]);
        return (db.getSettings().nodes || [])
          .filter((n) => n && n.baseUrl && n.token)
          // A node pointing at this very machine is this machine. Marking it keeps the sweep from
          // asking itself the question it just answered.
          .map((n) => ({ ...n, self: me.has(String(n.name || '').toLowerCase()) || isSelfUrl(n.baseUrl) }));
      } catch { return []; }
    },
    engaged: async (node, { url, company, title }) => {
      const q = `company=${encodeURIComponent(company || '')}&url=${encodeURIComponent(url || '')}`
        + `&title=${encodeURIComponent(title || '')}`;
      try {
        const body = await get(node, `/ai-apply/engaged?${q}`);
        return body.items || [];
      } catch (e) {
        // A node on an older build has no /ai-apply/engaged. Fall back to the jobs search it does
        // have, and decide engagement here. Weaker matching (company name only, no board slug), so
        // it is a stopgap for the update window, not a substitute.
        if (e.status !== 404) throw e;
        const body = await get(node, `/jobs?q=${encodeURIComponent(company || '')}&limit=50`);
        return (body.items || [])
          .filter((j) => ENGAGED.has(j.status) || (Array.isArray(j.tags) && j.tags.includes('hand-applied')))
          .map((j) => ({ company: j.company, title: j.title, status: j.status, matchedOn: 'company name' }));
      }
    },
  };
}

function setEmitter(fn) { emit = typeof fn === 'function' ? fn : () => {}; }

function publicView(r) {
  if (!r) return null;
  return {
    runId: r.runId, profileId: r.profileId, autonomy: r.autonomy, goal: r.goal,
    toolset: r.toolset || 'sandbox', browserOpen: !!(r.belt && r.belt.isOpen && r.belt.isOpen()),
    startedAt: r.startedAt, steps: r.steps, running: !r.done,
    stopping: !!(r.signal && r.signal.aborted && !r.done),
  };
}

function isRunning(profileId) {
  const r = active.get(profileId || '');
  return !!(r && !r.done);
}

function activeRuns() {
  return [...active.values()].filter((r) => !r.done).map(publicView);
}

function getActive(profileId) { return publicView(active.get(profileId || '')); }


// The standing rules for a real application, carried on EVERY apply run whatever goal was typed
// into the box. They are Pierre's, stated in his own terms, and they belong here rather than in a
// goal string because a goal string is something a person retypes and quietly drops half of.
const APPLY_RULES = [
  'House rules for every application:',
  '- Check for a duplicate BEFORE writing anything. Never apply to an employer twice, on any machine.',
  '- Never invent experience. Every claim traces to the stored profile or a previous answer. If the',
  '  posting wants something the candidate does not have, leave it out or say so plainly.',
  '- check_fit before writing anything. If the posting requires something he has no record of,',
  '  say so in one clause or pick a different job. Never write a missing skill onto the resume.',
  '- Read my_resume BEFORE writing a resume. It is the only source of his work history and',
  '  projects. Every line of a tailored resume traces back to it or to my_profile.',
  '- Always tailor the resume to this posting, in wording only, never in facts.',
  '- Write a cover letter ONLY if the form or the posting asks for one.',
  '- Before escalating a FACT, re-read my_resume. It carries his degree, dates, GPA, employers',
  '  and projects. A real run asked the human for a degree that was written in it.',
  '- A dropdown is not a missing answer. Use choose_option. If nothing fits, THEN escalate.',
  '- A school or employer search that returns nothing: try the FORMER name if my_resume gives',
  '  one. His university was Ryerson University until 2022 and some boards still list it that way.',
  '  Never pick a different institution because it is the closest offered.',
  '- A country picker that offers "Canada +1" is the phone-code picker. Choosing "Canada +1" there',
  '  is correct, by that exact name. If the form also has a separate Country field, fill that too.',
  '- "Why do you want to work here" is WRITING, not a fact. Answer it yourself from the posting',
  '  and his real history. Escalate only questions asking for a FACT you have no source for.',
  '- Leave voluntary diversity questions blank. Never solve a human check, make an account, or type',
  '  a password. Raise those for the human and move on to a different application.',
].join('\n');

// Starts a run and returns as soon as it HAS an id — the caller must not wait for the agent to
// finish, which can take many minutes. Progress arrives over SSE.
async function start({
  profileId = '', autonomy = 'prepare', goal = '', limits = {},
  toolset = 'sandbox', headless = false, tools = null, deps = {},
} = {}) {
  const key = profileId || '';
  // A BLANK GOAL IS NOT A REAL APPLICATION.
  //
  // The goal box on the AI Apply page is optional, and blank fell through to DEMO_GOAL, which is
  // the sandbox self-test: find a code, try a locked drawer. Pick "Apply", leave the box empty, and
  // the run opens Chrome, applies to nothing, and reports success. Say what is missing instead.
  // Only the toolsets that actually touch a posting. An unrecognised name falls back to the
  // sandbox below, so demanding a goal for it would refuse a run that is about to be harmless.
  if (['browser', 'apply'].includes(toolset) && !String(goal || '').trim()) {
    const e = new Error('an apply run needs a goal saying WHICH posting to apply to, with its url');
    e.code = 'NO_GOAL';
    throw e;
  }
  if (isRunning(key)) {
    const e = new Error('a run is already in progress for this profile');
    e.code = 'RUN_IN_PROGRESS';
    throw e;
  }

  // The browser belt is created here but Chrome is NOT launched — it opens lazily on the first
  // tool that needs a page, and is always torn down in the finally below, including when the run
  // crashes or is stopped. A leaked Chrome would hold the profile lock and block the next run.
  let belt = null;
  let toolList = tools;
  if (!toolList) {
    const openBelt = () => {
      belt = makeBrowserTools({ profileId: key || 'default', port: portFor(key), headless });
      return belt.tools;
    };
    if (toolset === 'apply') {
      // The real thing: a browser to work in, and the ledger so it knows who it is applying as and
      // what has already been done. Ledger tools come SECOND so a name collision could never let a
      // browser verb be shadowed by one that writes.
      const browserTools = openBelt();
      toolList = [
        ...browserTools,
        ...makeJatTools({ profileId: key || null, peers: makePeers() }).tools,
        ...makeDocumentTools().tools,
        // Escalation last so it can reach the live page for the auto-submit branch, and so the
        // autonomy mode chosen for THIS run is what `submit` obeys.
        ...makeEscalateTools({
          profileId: key || null,
          autonomy: autonomy === 'auto' ? 'auto' : 'prepare',
          getRunId: () => (rec ? rec.runId : null),
          page: () => (belt ? belt.page() : null),
          // So a block records WHICH posting stopped the agent, not just what it wanted.
          context: () => ({ url: belt ? belt.lastUrl() : '' }),
          onBlock: (b) => emit('ai-apply.block', { profileId: key, block: b }),
        }).tools,
      ];

      // EVERY tool goes through the policy, including ones added later. The floor comes from his
      // own settings rather than a constant here, so raising it in the app raises it for the agent.
      let salaryFloor = 0;
      try { salaryFloor = Number(db.getSettings().autoApply.salaryFloor) || 0; } catch { /* default 0 */ }
      const policy = makePolicy({
        page: () => (belt ? belt.page() : null),
        salaryFloor,
        context: () => ({ url: belt ? belt.lastUrl() : '' }),
      });
      toolList = wrapTools(toolList, policy, {
        onRefusal: (tool, reason) => emit('ai-apply.refusal', { profileId: key, tool, reason }),
      });
    } else if (toolset === 'browser') {
      toolList = openBelt();
    } else {
      toolList = sandbox.all;
    }
  }

  const signal = { aborted: false };
  const rec = {
    runId: null, profileId: key, autonomy: autonomy === 'auto' ? 'auto' : 'prepare',
    goal: goal || DEMO_GOAL, startedAt: new Date().toISOString(), steps: 0,
    signal, done: false, belt, toolset: TOOLSETS.has(toolset) ? toolset : 'sandbox',
  };
  active.set(key, rec);

  // Resolve the runId as soon as the loop reports its first step, so the UI can attach.
  let resolveId;
  const idReady = new Promise((res) => { resolveId = res; });

  // WHAT A REAL APPLICATION COSTS.
  //
  // The 400,000-character default was set when every observation was clipped to 1,200. Reference
  // material changed that: his résumé and profile are pinned in view, together about 7,300
  // characters in every prompt, which is the price of the agent actually knowing his work history.
  // Measured on the real Ritual form: the run reached step 30 with the résumé written, attached,
  // and name, email, phone, LinkedIn and website filled, then stopped at 401,235 characters with
  // three fields left. It ran out of budget, not out of ability.
  //
  // A finished application is worth the extra. The sandbox self-test is not, and keeps the default.
  const APPLY_CHARS = 750000;
  const limitsForRun = ['browser', 'apply'].includes(toolset)
    ? { maxChars: APPLY_CHARS, ...limits }
    : limits;

  rec.promise = runAgent({
    goal: rec.goal,
    // Sandbox runs are a self-test with no employer and no documents, so the application rules
    // would be noise there. Every other toolset touches a real posting.
    systemExtra: toolset === 'sandbox' ? '' : APPLY_RULES,
    tools: toolList,
    profileId: profileId || null,
    autonomy: rec.autonomy,
    limits: limitsForRun,
    signal,
    deps,
    onStep: (step, runId) => {
      rec.steps++;
      if (!rec.runId && runId) { rec.runId = runId; resolveId(runId); }
      emit('ai-apply.step', { profileId: key, runId: rec.runId, step });
    },
  }).then((result) => {
    rec.done = true;
    rec.runId = result.runId;
    resolveId(result.runId);
    emit('ai-apply.run', { profileId: key, ...result, steps: undefined, stepCount: result.stepCount });
    log.info(`run ${result.runId} ${result.status} (${result.stopReason}) after ${result.stepCount} steps`);
    return result;
  }).catch((e) => {
    rec.done = true;
    resolveId(null);
    emit('ai-apply.run', { profileId: key, status: 'failed', error: e.message });
    log.error('run crashed', e.message);
    throw e;
  }).finally(async () => {
    // ALWAYS close the browser — done, stopped, crashed, capped. A leaked Chrome keeps a lock on
    // the profile directory, so the very next Start for this person would fail to launch.
    rec.done = true;
    if (belt) {
      try { await belt.close(); } catch (e) { log.warn('browser close failed', e.message); }
      rec.belt = null;
    }
  }).catch(() => {
    // Terminal. The failure was already emitted to the page and written to the log above; nobody
    // awaits rec.promise, so without this the rethrow becomes an unhandled rejection that can take
    // the whole app down mid-run.
  });

  // runAgent creates its row synchronously before the first await resolves, but we do not depend
  // on that: give the caller whatever id exists now and let SSE carry the rest.
  await Promise.race([idReady, new Promise((r) => setTimeout(r, 250))]);
  emit('ai-apply.run', { profileId: key, ...publicView(rec), status: 'running' });
  return publicView(rec);
}

// Requests a stop. Returns whether there was anything to stop. The run ends at its next turn
// boundary, so the caller sees `stopping: true` until then.
function stop(profileId = '') {
  const rec = active.get(profileId || '');
  if (!rec || rec.done) return { ok: false, reason: 'no run in progress' };
  rec.signal.aborted = true;
  emit('ai-apply.run', { profileId: profileId || '', ...publicView(rec), status: 'stopping' });
  return { ok: true, runId: rec.runId, stopping: true };
}

// Test seam: forget finished runs so a suite can start a fresh one.
function _reset() { active.clear(); }

module.exports = {
  start, stop, isRunning, activeRuns, getActive, setEmitter, _reset, DEMO_GOAL, APPLY_RULES,
  _portFor: portFor,
};
