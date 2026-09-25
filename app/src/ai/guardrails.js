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
  // CANADA. The list above is written for US forms. "Visible minority" is the term the Employment
  // Equity Act uses, it is on Canadian applications constantly, and none of the equity groups it
  // names were here. Measured 2026-09-05: "Do you identify as a member of a visible minority?" was
  // NOT caught by this pattern.
  'visible minorit', 'employment equity', '\\baboriginal\\b', '\\bindigenous\\b',
  'first nations', '\\bmétis\\b', '\\bmetis\\b', '\\binuit\\b',
  // FRENCH. Montreal is his second location priority and Quebec forms ask in French only. Every
  // one of these returned false before.
  'origine ethnique', 'appartenance ethnique', 'minorité visible', 'auto[- ]?identif',
  'identification volontaire', '\\bautochtone', '\\bhandicap', '\\bgenre\\b',
  'équité en matière d', 'orientation sexuelle', '\\bvétéran',
  // PRONOUNS. Found 2026-09-05 in the live parked queue, not by reading this list: three tasks
  // on the laptop were STRANDED on 'Preferred pronouns', 'Pronouns *' and a long opt-in blurb,
  // and ten distinct pronoun fields sit in the answer bank. A pronoun field is a voluntary
  // identity disclosure like every other entry here, and nothing on file says what his are, so
  // the agent has no source to fill it from. Matching it turns a stranded application into a
  // submitted one with the field left blank, which is what skip_self_id is for.
  //
  // The word boundaries are load-bearing. 'pronoun' is a prefix of 'pronounce', and 'how do we
  // pronounce your name?' is a real question on four live postings that the agent SHOULD answer,
  // his name being a fact about him. Verified against the bank: 10 pronoun fields matched, all
  // four name-pronunciation questions left alone.
  '\\bpronouns?\\b', '\\bpronoms?\\b',
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

// THE ONE SALARY RULE, SHARED BY BOTH PATHS TO A FORM.
//
// The agent's `fill` tool is one way a number reaches a real application. The autofill bundle that
// server.js ships to the extension is the other, and it had no floor check at all: live on
// 2026-09-06, with the floor set to 90,000 and his profile reading "CAD 100,000-110,000", **79**
// harvested answers were being shipped that bottom out at 85,000.
//
// Exported rather than reimplemented there, because two copies of a policy are two policies.
// That is exactly how the work-authorisation gate came to cover recall but not the bundle.
//
// `unreadable` is the agent-only case: when the page could not be read at all, the SHAPE of the
// value has to stand in for the label. lowestSalaryIn accepts only 4-7 digit numbers between
// 20,000 and 1,000,000, so years of experience, dates, counts and phone numbers return null and
// are never touched by this.
function salaryBelowFloor(label, value, floor, { unreadable = false } = {}) {
  if (!(Number(floor) > 0)) return null;
  const looksSalary = SALARY_FIELD_RX.test(String(label || '')) || SALARY_FIELD_RX.test(String(value || ''));
  if (!looksSalary && !unreadable) return null;
  const low = lowestSalaryIn(value);
  return low !== null && low < Number(floor) ? low : null;
}

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

  // Returns the label text, or NULL when the page could not be asked at all. The difference
  // matters for the salary floor below: "this field is not a salary field" and "we could not tell
  // what this field is" must not be treated the same way, or the money guard fails open on any
  // detached node or CDP hiccup.
  async function labelFor(ref) {
    const p = page();
    if (!p || !ref) return null;
    try {
      let asked = 0;
      const own = await p.describeRef(String(ref)).then((v) => { asked++; return v; }).catch(() => ({}));
      const ctx = await p.labelContext(String(ref)).then((v) => { asked++; return v; }).catch(() => '');
      if (!asked) return null;                       // both lookups failed — we know nothing
      return `${own.ariaLabel || ''} ${own.name || ''} ${own.id || ''} ${ctx}`;
    } catch { return null; }
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
      // A null label means the page could not be read. Fall back to the SHAPE of the value:
      // lowestSalaryIn only accepts 4-7 digit numbers between 20,000 and 1,000,000, so years of
      // experience, dates, counts and phone numbers all return null and are unaffected. Refusing
      // here is the safe direction — it escalates to a human instead of naming a number.
      const unreadable = label === null;
      {
        const low = salaryBelowFloor(label, args.text, salaryFloor, { unreadable });
        if (low !== null) {
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

module.exports = { makePolicy, wrapTools, lowestSalaryIn, salaryBelowFloor, SELF_ID_RX, ACCOUNT_WALL_RX, SALARY_FIELD_RX };
