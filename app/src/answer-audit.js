'use strict';
// ============================================================================
//  JAT v11 — answer bank audit
//
//  WHY THIS EXISTS
//  On 2026-09-04 the live bank held 1000 learned answers, and a conservative check flagged roughly
//  half as malformed. Among them, captured from real forms:
//
//    "are you a canadian citizen or permanent resident of canada"        -> "37"
//    "Are you able to work on a T4 basis without sponsorship?"           -> "on"
//    "i certify that the facts set forth in this application are true"   -> "Ontario"
//    "Are you legally authorized to work in Canada or the US?"           -> "No"
//
//  Auto-apply answers screening questions out of this bank, so a wrong row is not cosmetic: it is
//  submitted, under his name, on every application that asks.
//
//  TWO AXES, NOT ONE — this is the whole design.
//
//  1. SHAPE. `answerFitsQuestion` already knows a yes/no question cannot be answered "Ontario".
//     These are objectively broken and safe to delete in bulk.
//
//  2. STAKES. The most dangerous row in the bank, that "No", PASSES the shape check — it is a
//     perfectly well-formed yes/no answer to a yes/no question. It is simply FALSE, and being
//     false on work authorization disqualifies him from the job. No automated check can know the
//     truth here, so these are surfaced for a human to read regardless of shape, and nothing about
//     them is ever bulk-anything.
//
//  Nothing in this module deletes or edits. It classifies and explains; the human decides.
// ============================================================================

const shape = require('./answer-shape');

// Questions where a wrong answer costs the application outright. Deliberately narrow: a list that
// flags everything would be ignored, and then the four rows that matter get lost in the noise.
const HIGH_STAKES = [
  { id: 'work-auth', label: 'Work authorization', rx: /\b(legally )?(authoriz|eligib)\w*\b[^?]*\bwork\b|\bright to work\b|\bwork (permit|authorization)\b/i },
  { id: 'sponsorship', label: 'Visa sponsorship', rx: /\bsponsor\w*\b|\bvisa\b|\bwork permit\b/i },
  { id: 'citizenship', label: 'Citizenship or residency', rx: /\bcitizen\w*\b|\bpermanent resident\b|\bPR status\b/i },
  { id: 'salary', label: 'Salary or compensation', rx: /\b(salary|compensation|pay|rate|wage)\b[^?]*\b(expect|desir|require|seek|range)|\bexpected (salary|compensation)\b/i },
  { id: 'clearance', label: 'Security clearance', rx: /\bsecurity clearance\b|\bclearance level\b/i },
  // Notice period and start date were here and were removed. A wrong notice period is an
  // inconvenience, not a disqualification, and including it flagged every ordinary answer — which
  // is precisely how the four rows that DO matter get lost. The bar is "costs the application".
];

const PLACEHOLDER_RX = /^\s*(--\s*no answer\s*--|select(\s+an?\s+option)?|choose(\s+one)?|please select|n\/?a|none|-{1,}|\s*)\s*$/i;

// A DOM artefact that is never a human answer, whatever the question was. `on` is the default
// value of a checked checkbox with no value attribute, which is how "Are you able to work on a T4
// basis without sponsorship?" ended up answered "on" in the live bank.
const CONTROL_VALUE_RX = /^\s*(on|off|checked|unchecked|undefined|null|\[object object\])\s*$/i;
// These ARE plausible answers to a yes/no question and junk anywhere else, so they are judged
// against the question's shape rather than blanket-rejected.
const BOOLEANISH_RX = /^\s*(true|false)\s*$/i;
// A GUID, or a long unbroken run of hex/base64-ish characters with no spaces: a widget id, never
// something a person typed into a form.
const OPAQUE_TOKEN_RX = /^\s*(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{24,})\s*$/;

function highStakes(question) {
  const q = String(question || '');
  return HIGH_STAKES.filter((c) => c.rx.test(q));
}

// One row in, one verdict out.
function auditAnswer(row = {}) {
  const question = String(row.question == null ? '' : row.question).trim();
  const answer = String(row.answer == null ? '' : row.answer).trim();
  const qShape = shape.questionShape(question);
  const stakes = highStakes(question);
  const base = {
    id: row.id, question, answer, shape: qShape,
    seenCount: Number(row.seen_count || row.seenCount || 0),
    stakes: stakes.map((s) => s.id),
    stakeLabels: stakes.map((s) => s.label),
  };

  if (!answer || PLACEHOLDER_RX.test(answer)) {
    return { ...base, verdict: 'placeholder', severity: 'junk',
      reason: 'no answer was ever given — this is a dropdown placeholder, not a value' };
  }
  if (CONTROL_VALUE_RX.test(answer)) {
    return { ...base, verdict: 'control-value', severity: 'junk',
      reason: `"${answer}" is a checkbox or widget value that got captured instead of an answer` };
  }
  // A scraped widget id or GUID. Live example: "yes i'm legally eligible to work in canada without
  // the need for sponsorship" answered "038b36c9-c68b-42a3-9671-7ab5ddf009be". Without this it is
  // classified `review` — presented to Pierre as a judgement call, when it is simply garbage.
  if (OPAQUE_TOKEN_RX.test(answer)) {
    return { ...base, verdict: 'opaque-token', severity: 'junk',
      reason: 'this is an internal id scraped off the form, not an answer anyone gave' };
  }
  if (BOOLEANISH_RX.test(answer) && qShape !== 'yesno') {
    return { ...base, verdict: 'control-value', severity: 'junk',
      reason: `"${answer}" is a raw control value, and this is a ${qShape} question` };
  }
  // Questions whose answer is LEGITIMATELY just digits. Without this, "mobile phone number" ->
  // "6479637745" is flagged as junk and lands in the bulk-delete group — deleting his own phone
  // number. Caught on the live bank before this screen ever shipped.
  const NUMERIC_OK_RX = /\b(phone|mobile|telephone|cell|fax|postal ?code|zip|extension|ext\b|number of|how many|years?\b|age\b|salary|compensation|rate|notice)\b/i;

  // A bare numeral against a worded question: "37" for a citizenship question.
  if (/^\d[\d\s()+-]*$/.test(answer) && !['number', 'salary', 'date'].includes(qShape)
      && !NUMERIC_OK_RX.test(question)) {
    return { ...base, verdict: 'bare-number', severity: 'junk',
      reason: `a ${qShape} question cannot be answered "${answer}" — a number field was captured by mistake` };
  }
  if (!shape.answerFitsQuestion(question, answer)) {
    return { ...base, verdict: 'shape-mismatch', severity: 'broken',
      reason: `this reads as a ${qShape} question, and "${answer.slice(0, 40)}" is not a ${qShape} answer` };
  }
  if (stakes.length) {
    return { ...base, verdict: 'needs-review', severity: 'review',
      reason: `${stakes.map((s) => s.label).join(' and ')} — the shape is fine, but a wrong value here `
        + 'loses the application, so this one needs your eyes' };
  }
  return { ...base, verdict: 'ok', severity: 'ok', reason: '' };
}

const ORDER = { review: 0, broken: 1, junk: 2, ok: 3 };

function auditAll(rows = []) {
  const items = rows.map(auditAnswer);
  const counts = { total: items.length, review: 0, broken: 0, junk: 0, ok: 0 };
  for (const i of items) counts[i.severity]++;
  const flagged = items
    .filter((i) => i.severity !== 'ok')
    .sort((a, b) => (ORDER[a.severity] - ORDER[b.severity]) || (b.seenCount - a.seenCount));
  return { counts, items: flagged };
}

// Exported so the write path can reject the same strings the audit would immediately flag —
// "correcting" an answer to "-- No answer --" would recreate the junk this module exists to find.
// db.isPlaceholderAnswer is deliberately narrower (it guards machine capture) and misses this one.
function isNonAnswer(value) {
  const v = String(value == null ? '' : value).trim();
  return !v || PLACEHOLDER_RX.test(v) || CONTROL_VALUE_RX.test(v);
}

module.exports = { auditAnswer, auditAll, highStakes, isNonAnswer, HIGH_STAKES };
