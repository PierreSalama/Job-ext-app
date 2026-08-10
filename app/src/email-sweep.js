// THE SWEEP. Walks every stored email, records a decision for each, and hands the genuinely
// ambiguous ones to Claude (Sonnet) for a real reading.
//
// Two passes, deliberately separate:
//
//   PASS 1 (rules, free)   — routes every unreviewed email into settled / escalate / ignorable and
//                            writes a ledger row. After this pass, `unreviewed` is 0 by
//                            construction: coverage becomes a fact rather than a hope.
//   PASS 2 (Sonnet, paid)  — reads the escalations in batches and returns a real category, a
//                            confidence, and a one-line justification per email.
//
// Pass 1 always completes even if Pass 2 cannot run (no CLI, not signed in, offline). That
// ordering matters: a broken AI provider must degrade the pipeline's PRECISION, never its
// COVERAGE. The old design failed the other way — anything the rules could not name simply
// vanished, and a vanished email is invisible in every report.
//
// Model: Sonnet, enforced through ai/model-policy.js. See that file for why it is a hard clamp.

const db = require('./db');
const triage = require('./email-triage');
const emailLib = require('./email');
const claudeCli = require('./ai/claude');
const policy = require('./ai/model-policy');
const { scope } = require('./logger');

const log = scope('email-sweep');

const SYSTEM = [
  'You triage a job seeker\'s email. For each message decide what it actually is, from the applicant\'s point of view.',
  'Categories: offer, rejection, interview, assessment, application_confirmation, recruiter, ignorable, other.',
  '- interview = a real invitation or scheduling request, not the word "interview" in a footer.',
  '- assessment = a coding challenge, take-home, or online test to complete.',
  '- application_confirmation = an acknowledgement that an application was received. Nothing more.',
  '- recruiter = cold outreach about a role the applicant did not apply to.',
  '- ignorable = job alerts, digests, newsletters, security notices, receipts. Not correspondence.',
  '- other = genuinely none of the above. Use it sparingly and say why in the reason.',
  'Be decisive but honest: if a message is a rejection wearing a polite subject line, call it a rejection.',
  'Never invent facts about the message. The reason must quote or paraphrase the actual text.',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          category: { type: 'string' },
          confidence: { type: 'number' },
          reason: { type: 'string' },
          company: { type: 'string' },
        },
        required: ['id', 'category', 'confidence', 'reason'],
      },
    },
  },
  required: ['results'],
};

const VALID = new Set(['offer', 'rejection', 'interview', 'assessment', 'application_confirmation', 'recruiter', 'ignorable', 'other']);

function promptFor(batch) {
  const lines = batch.map((e, i) => {
    const p = triage.forPrompt(e);
    return `[${i + 1}] id=${p.id}\nfrom: ${p.from}\ndate: ${p.date}\nsubject: ${p.subject}\nbody: ${p.body}`;
  });
  return `Triage these ${batch.length} emails. Return one result per email, using the exact id given.\n\n${lines.join('\n\n---\n\n')}`;
}

// PASS 1 — rules. Cheap, offline, and the thing that makes coverage true.
function sweepRules({ limit = 2000 } = {}) {
  const pending = db.triageUnreviewed({ limit });
  const plan = triage.planSweep(pending, { classify: emailLib.classify });
  for (const row of plan.rows) {
    db.triageRecord({
      emailId: row.emailId,
      route: row.route,
      category: row.category,
      reason: row.reason,
      decidedBy: 'rules',
      confidence: row.route === 'settled' ? 0.8 : 0,
    });
  }
  return { reviewed: plan.rows.length, counts: plan.counts };
}

// PASS 2 — Sonnet on the escalations. Returns what it managed to decide; a failure here leaves the
// ledger rows in place as 'rules'-decided escalations, so the work is simply retried next run.
async function sweepAi({ limit = 60, batchSize = triage.BATCH_SIZE, generate } = {}) {
  const pending = db.triagePendingEscalations({ limit });
  if (!pending.length) return { decided: 0, batches: 0, model: policy.SONNET_ALIAS, pending: 0 };

  const { model, overridden, reason } = policy.enforce(null);
  if (overridden) log.info(reason);

  const run = generate || ((args) => claudeCli.generate(args));
  const batches = triage.batchesFor(pending, batchSize);
  let decided = 0;
  const errors = [];

  for (const batch of batches) {
    try {
      const { json } = await run({
        prompt: promptFor(batch),
        system: SYSTEM,
        schema: SCHEMA,
        model,
        timeoutMs: 180000,
      });
      const byId = new Map(batch.map((e) => [String(e.id), e]));
      for (const r of (json && json.results) || []) {
        const em = byId.get(String(r.id));
        if (!em) continue;                                  // a hallucinated id decides nothing
        const cat = VALID.has(String(r.category)) ? String(r.category) : 'other';
        db.triageRecord({
          emailId: em.id,
          route: cat === 'ignorable' ? 'ignorable' : 'settled',
          category: cat,
          reason: String(r.reason || '').slice(0, 400),
          decidedBy: 'sonnet',
          confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0)),
        });
        decided++;
      }
    } catch (e) {
      // Do NOT mark the batch decided. Leaving it pending is what makes the sweep resumable.
      errors.push(String(e.message || e).slice(0, 200));
      log.warn(`batch failed (${batch.length} emails): ${errors[errors.length - 1]}`);
      if (/CLAUDE_MISSING|CLAUDE_AUTH/.test(e.code || '')) break;   // no point trying the rest
    }
  }
  return { decided, batches: batches.length, model, pending: pending.length, errors };
}

async function sweep({ withAi = true, ruleLimit = 2000, aiLimit = 60, generate } = {}) {
  const rules = sweepRules({ limit: ruleLimit });
  let ai = { decided: 0, batches: 0, skipped: true };
  if (withAi) ai = await sweepAi({ limit: aiLimit, generate });
  return { rules, ai, coverage: db.triageCoverage() };
}

module.exports = { sweep, sweepRules, sweepAi, promptFor, SYSTEM, SCHEMA, VALID };
