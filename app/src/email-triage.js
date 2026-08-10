// EVERY EMAIL GETS A VERDICT.
//
// The old pipeline had two holes, and both are the same shape: something decided an email wasn't
// worth looking at, and nothing recorded that decision.
//
//   1. FETCH-TIME. settings.gmail.query only pulls mail matching a keyword list. Anything the query
//      missed never entered the database, so it could not be classified, matched, or counted. This
//      is why employer rejections sat unseen for weeks (v11.48 widened the query — widening is not
//      the same as covering).
//   2. CLASSIFY-TIME. `classify()` returns 'other' for anything its regexes don't recognise, and
//      'other' is indistinguishable from "looked at and genuinely nothing". A pipeline cannot tell
//      you what it missed if missing leaves no trace.
//
// This module closes hole 2 and makes hole 1 measurable. Every stored email is routed to exactly
// one of three outcomes, and the outcome is WRITTEN DOWN:
//
//   • settled   — the rules matched something specific and are trusted. No AI, no cost.
//   • escalate  — the rules were unsure. Goes to Claude (Sonnet) for a real reading.
//   • ignorable — positively recognised as not about Pierre's job search (newsletters, job alerts,
//                 security notices). NOT the same as 'other': this is a decision, not a shrug.
//
// The invariant the tests pin: for any set of emails, settled + escalate + ignorable === total.
// No email can fall through, because there is no fourth branch.

// Senders and subjects that are definitively not application correspondence. Kept narrow and
// evidence-shaped: each entry is something seen in Pierre's actual 1,427-email store. A false
// 'ignorable' is the one genuinely costly mistake here (a real rejection silently dropped), so
// anything not clearly on this list escalates instead.
const IGNORABLE_SUBJECT_RX = [
  /^\d+ new jobs? (?:for|in|matching)\b/i,
  /^(?:new )?jobs? similar to\b/i,
  /\bjob alert\b/i,
  /^your job alert\b/i,
  /\bpeople you may know\b/i,
  /\bwho'?s viewed your profile\b/i,
  /\byour weekly\b.*\b(?:digest|summary|update)\b/i,
  /\bnewsletter\b/i,
  /\bsecurity alert\b|\bnew sign-?in\b|\bpassword (?:was )?changed\b|\bverify your email\b/i,
  /\bunsubscribe\b/i,
  /\binvoice\b|\breceipt\b|\byour order\b/i,
];

// A category the rules produced with real evidence. 'other' is explicitly NOT here — that is the
// shrug we are trying to eliminate. 'recruiter' is not here either: the recruiter regex fires on
// phrases as loose as "reaching out", which is exactly the kind of guess worth a second opinion.
const CONFIDENT_CATEGORIES = new Set([
  'offer', 'rejection', 'interview', 'assessment', 'application_confirmation',
]);

function text(v) { return String(v == null ? '' : v); }

function looksIgnorable(email) {
  const subject = text(email.subject);
  for (const rx of IGNORABLE_SUBJECT_RX) if (rx.test(subject)) return true;
  return false;
}

// Route ONE email. `category` is what the deterministic classifier said (email.js classify()).
//
// Order matters and is deliberate:
//   1. A confident category wins outright — even on a "5 new jobs" subject, because a real
//      rejection can carry a junk-looking subject and the body is what classify() reads.
//   2. Then ignorable, so bulk noise never reaches the AI budget.
//   3. Everything else escalates. 'other' ALWAYS escalates: that is the whole point.
function routeEmail(email, category) {
  const cat = text(category || email.category);
  if (CONFIDENT_CATEGORIES.has(cat)) {
    // One exception: a confident category with NO job match is still worth a look, because the
    // interesting failure ("we rejected you" that we cannot tie to an application) lives here.
    if (!email.matchedJobId) {
      return { route: 'escalate', reason: `${cat} but unmatched to any application`, category: cat };
    }
    return { route: 'settled', reason: `rules matched ${cat}`, category: cat };
  }
  if (looksIgnorable(email)) {
    return { route: 'ignorable', reason: 'bulk mail (alert/digest/notice), not application correspondence', category: 'ignorable' };
  }
  return {
    route: 'escalate',
    reason: cat === 'other' ? 'rules produced no category' : `rules guessed "${cat}" without strong evidence`,
    category: cat || 'other',
  };
}

// Route a whole set and report coverage. The caller passes emails already joined with the category
// the deterministic classifier produced.
function planSweep(emails, { classify } = {}) {
  const rows = [];
  const counts = { settled: 0, escalate: 0, ignorable: 0 };
  for (const e of emails || []) {
    const cat = e.category != null && e.category !== ''
      ? e.category
      : (typeof classify === 'function' ? classify(e.subject, e.body) : 'other');
    const r = routeEmail(e, cat);
    counts[r.route]++;
    rows.push({ emailId: e.id, ...r });
  }
  const total = rows.length;
  return {
    total,
    counts,
    rows,
    // The number that answers "is the pipeline thorough": how much of the inbox a human or a model
    // has actually reached a decision about, as opposed to shrugged at.
    coveredPct: total ? Math.round(((counts.settled + counts.ignorable + counts.escalate) / total) * 100) : 100,
  };
}

// Escalations go to Claude in batches. Batch size trades round-trips against the chance of the
// model losing track; 12 short emails is comfortably inside a Sonnet context with room for bodies.
const BATCH_SIZE = 12;
const BODY_CHARS = 1200;   // enough for the decision sentence, which is near the top of real mail

function batchesFor(rows, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

// Compact an email for the prompt. Bodies are clipped hard: the classification signal in job mail
// is almost always in the first paragraph, and full bodies would blow the batch size for no gain.
function forPrompt(email) {
  return {
    id: text(email.id),
    from: `${text(email.fromName)} <${text(email.fromAddr)}>`.trim(),
    subject: text(email.subject).slice(0, 200),
    date: text(email.sentAt).slice(0, 19),
    body: text(email.body || email.snippet).replace(/\s+/g, ' ').slice(0, BODY_CHARS),
  };
}

module.exports = {
  routeEmail,
  planSweep,
  batchesFor,
  forPrompt,
  looksIgnorable,
  CONFIDENT_CATEGORIES,
  IGNORABLE_SUBJECT_RX,
  BATCH_SIZE,
  BODY_CHARS,
};
