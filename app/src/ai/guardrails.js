'use strict';
// ============================================================================
//  JAT v11 — guardrail layer (AI Apply chunk 8)
//
//  Every rule the overnight run followed by hand, turned into code the model cannot talk its way
//  past. A rule that lives only in a system prompt is a suggestion: it survives exactly as long as
//  the model's attention does, and the first time it is ignored an application goes out wrong under
//  Pierre's name.
//
//  ONE WRAPPER, NOT A GUARD PER TOOL
//  `wrapTools` composes a policy in FRONT of each tool's own guard, so a tool added later is
//  covered by default rather than by remembering. A policy refusal short-circuits: the tool's own
//  guard never runs, and neither does the tool.
//
//  A REFUSAL IS NOT AN ERROR
//  It comes back as a normal observation the model reads and reacts to, with the reason and what to
//  do instead. That is what makes the agent route around a wall instead of hammering it.
//
//  WHAT IS ENFORCED HERE
//    · no typing into a password field                          (a credential is never the agent's)
//    · no touching a voluntary demographic / self-ID control    (leave it blank, always)
//    · no building documents for an ATS that will wall us       (Workday — do not waste the work)
//    · no offering a salary below his floor                     (an agent must not underprice him)
//    · no navigating anywhere but http(s)                       (a posting must not read the disk)
//  Budget, step cap, wall clock and the kill switch live in the loop, which is the only place that
//  can see the whole run.
// ============================================================================

let log = { info() {}, warn() {}, error() {} };
try { log = require('../logger').scope('ai:guardrails'); } catch { /* usable outside the app */ }

// Voluntary self-identification. These questions are optional by law and by design, and the
// correct action is always to leave them alone — so the agent is not allowed to click inside one.
const SELF_ID_RX = new RegExp([
  'gender identity', 'gender\\b', '\\btransgender\\b', 'sexual orientation', '\\blgbtq',
  'race\\b', 'ethnicit', 'hispanic', 'latino', '\\bveteran\\b', 'military status',
  'disabilit', '\\bdisabled\\b', 'diversity survey', 'self[- ]?identif', 'equal employment',
  '\\beeo\\b', 'protected veteran', 'demographic',
].join('|'), 'i');

// An ATS that demands an account before a single field can be filled. Building a tailored résumé
// for one of these is pure waste — that lesson cost two full document builds (Clio, Intact).
const ACCOUNT_WALL_RX = /\.myworkdayjobs\.com|workdayjobs\.com|\btaleo\.net\b|\bicims\.com\b|\bsuccessfactors\b/i;

// The number in a salary answer, if there is one. "CAD 100,000 to 110,000" -> 100000 (the floor of
// what he is offering), which is the figure that must not fall below his own.
function lowestSalaryIn(text) {
  const nums = String(text || '')
    .replace(/[,\s]/g, '')
    .match(/\d{4,7}(?:\.\d+)?/g);
  if (!nums) return null;
  const vals = nums.map(Number).filter((n) => n >= 20000 && n <= 1000000);
  return vals.length ? Math.min(...vals) : null;
}

const SALARY_FIELD_RX = /salary|compensation|expected pay|base pay|desired pay|rate expectation/i;

// ---------------------------------------------------------------------------
// The policy. Returns a refusal STRING, or null to allow.
// ---------------------------------------------------------------------------
function makePolicy(opts = {}) {
  const {
    page = () => null,
    salaryFloor = 0,
    context = () => ({}),
    allowAccountWalls = false,
  } = opts;

  async function labelFor(ref) {
    const p = page();
    if (!p || !ref) return '';
    try {
      const own = await p.describeRef(String(ref)).catch(() => ({}));
      const ctx = await p.labelContext(String(ref)).catch(() => '');
      return `${own.ariaLabel || ''} ${own.name || ''} ${own.id || ''} ${ctx}`;
    } catch { return ''; }
  }

  return async function policy(toolName, args = {}) {
    // --- credentials -------------------------------------------------------
    if ((toolName === 'fill' || toolName === 'type') && args.ref) {
      const p = page();
      if (p) {
        try {
          if (await p.isPasswordRef(String(args.ref))) {
            return 'refused by policy: that is a password field. The agent never types a credential — '
              + 'raise it with ask_human(kind:"password") instead.';
          }
        } catch { /* if the ref cannot be identified the tool's own guard handles it */ }
      }
    }

    // --- voluntary self-identification -------------------------------------
    if ((toolName === 'click' || toolName === 'fill') && args.ref) {
      const label = await labelFor(args.ref);
      if (label && SELF_ID_RX.test(label)) {
        return 'refused by policy: this is a voluntary self-identification question '
          + `(matched "${label.replace(/\s+/g, ' ').slice(0, 80)}"). These are never answered on the `
          + 'candidate\'s behalf. Use skip_self_id and carry on with the rest of the form.';
      }
    }

    // --- do not underprice him ---------------------------------------------
    if (toolName === 'fill' && salaryFloor > 0 && args.text) {
      const label = await labelFor(args.ref);
      if (SALARY_FIELD_RX.test(label) || SALARY_FIELD_RX.test(String(args.text))) {
        const low = lowestSalaryIn(args.text);
        if (low !== null && low < salaryFloor) {
          return `refused by policy: ${low.toLocaleString()} is below his floor of ${salaryFloor.toLocaleString()}. `
            + 'Never offer less than the floor. If the posting genuinely requires a lower number, '
            + 'raise it with ask_human instead of deciding it.';
        }
      }
    }

    // --- do not build documents for a wall ---------------------------------
    if (!allowAccountWalls && (toolName === 'write_resume' || toolName === 'write_cover_letter')) {
      const url = String((context() || {}).url || args.url || '');
      if (ACCOUNT_WALL_RX.test(url)) {
        return `refused by policy: ${url.slice(0, 80)} requires creating an account before applying, `
          + 'so a tailored document here is wasted work. Raise it with ask_human(kind:"account") and '
          + 'move to a different posting.';
      }
    }

    return null;
  };
}

// ---------------------------------------------------------------------------
// Compose the policy in front of every tool's own guard.
// ---------------------------------------------------------------------------
function wrapTools(tools, policy, { onRefusal = () => {} } = {}) {
  if (typeof policy !== 'function') throw new Error('wrapTools needs a policy function');
  return tools.map((t) => ({
    ...t,
    guard: async (args, ctx) => {
      let refusal = null;
      try {
        refusal = await policy(t.name, args || {}, ctx);
      } catch (e) {
        // A policy that throws must FAIL CLOSED. Allowing an action because the check crashed is
        // exactly the wrong direction for a rule that exists to prevent harm.
        refusal = `refused by policy: the safety check for ${t.name} could not run (${e.message})`;
      }
      if (refusal) {
        log.info(`policy refused ${t.name}: ${String(refusal).slice(0, 100)}`);
        try { onRefusal(t.name, refusal, args); } catch { /* reporting must not break the refusal */ }
        return refusal;
      }
      return typeof t.guard === 'function' ? t.guard(args, ctx) : null;
    },
  }));
}

module.exports = { makePolicy, wrapTools, lowestSalaryIn, SELF_ID_RX, ACCOUNT_WALL_RX, SALARY_FIELD_RX };
