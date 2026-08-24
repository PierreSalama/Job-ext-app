// JAT v11 — answer SHAPE + BRAND identity, the two gates on learned-answer recall.
//
// WHY THIS EXISTS (both defects are from the live store, both reached real applications):
//
//  1. CROSS-COMPANY LEAK. db.qaLookup / db.profileFieldLookup score a stored question
//     against the asked one by SORTED-BAG-OF-WORDS overlap. Two screening questions that
//     differ ONLY in the company name are therefore near-identical:
//
//        stored  "Do you currently work for a partner or reseller of Geotab?"
//        asked   "Do you currently work for a partner or reseller of 1Password?"
//        score    0.833   → served
//
//     Measured on job_4e8a70b0 (a 1Password posting, submitted 2026-08-14): its stored
//     answers contain Geotab's "how did you hear", "partner or reseller" and "onboard
//     with" questions, plus Robinhood's "have you ever worked for" question. The company
//     token is the ONLY discriminating token in each pair and it carried no more weight
//     than "you". That puts factually wrong statements about employment relationships
//     onto real applications.
//
//  2. SHAPE MISMATCH. Even when a match is plausible by words, the VALUE can be nonsense
//     for the question. Live: Robinhood's bribery / government-official disclosure — a
//     yes/no question — answered "Toronto, ON"; its conflict-of-interest question answered
//     "Tacel"; "will you require sponsorship" answered "Canada"; and, inverted, "where are
//     you currently located" answered "Yes".
//
// The rule both gates serve is the codebase's own: PARK RATHER THAN GUESS. A question that
// recalls nothing is surfaced to the user and costs one queued task. A question that
// recalls the wrong company's answer is a false statement signed in Pierre's name.
//
// Pure functions, no DB and no DOM, so both the server recall path and the deterministic
// answering floor can share them and both are directly testable.

// ---------------------------------------------------------------------------
// BRAND / COMPANY IDENTITY
// ---------------------------------------------------------------------------

// Capitalized words that are NEVER a company identity in a screening question. Without
// this list "Canada" in "are you legally authorized to work in Canada?" would read as a
// brand and stop that question from ever matching its own stored answer.
const NON_BRAND = new Set([
  // countries / regions / demonyms that really do appear in screening questions
  'canada', 'canadian', 'america', 'american', 'usa', 'us', 'united', 'states', 'kingdom',
  'britain', 'british', 'england', 'ireland', 'irish', 'france', 'french', 'germany', 'german',
  'spain', 'spanish', 'mexico', 'mexican', 'india', 'indian', 'china', 'chinese', 'japan',
  'japanese', 'australia', 'australian', 'zealand', 'brazil', 'europe', 'european', 'african',
  'america', 'latin', 'asia', 'asian', 'emea', 'apac', 'latam', 'nato', 'eu', 'uk', 'ca',
  // provinces / states + the abbreviations that show up in addresses
  'ontario', 'quebec', 'alberta', 'manitoba', 'saskatchewan', 'nova', 'scotia', 'brunswick',
  'newfoundland', 'labrador', 'prince', 'edward', 'island', 'columbia', 'yukon', 'nunavut',
  'northwest', 'territories', 'toronto', 'montreal', 'vancouver', 'ottawa', 'calgary',
  'edmonton', 'winnipeg', 'halifax', 'victoria', 'mississauga', 'hamilton', 'ontarian',
  'on', 'qc', 'bc', 'ab', 'mb', 'sk', 'ns', 'nb', 'nl', 'pe', 'pei', 'nt', 'yt', 'nu',
  'ny', 'nyc', 'sf', 'la', 'dc', 'tx', 'wa', 'or',
  // languages
  'english', 'francais', 'spanish', 'mandarin', 'cantonese', 'arabic', 'hindi', 'punjabi',
  'portuguese', 'italian', 'russian', 'german', 'dutch', 'korean',
  // calendar
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
  'saturday', 'sunday',
  // acronyms that are categories, not companies
  'hr', 'it', 'ai', 'ml', 'qa', 'ux', 'ui', 'pr', 'eeo', 'nda', 'ndas', 'id', 'ids', 'ceo',
  'cto', 'cfo', 'vp', 'phd', 'mba', 'bsc', 'msc', 'ba', 'bs', 'ms', 'gpa', 'sin', 'ssn',
  'pto', 'rrsp', 'tfsa', 'gst', 'hst', 'fte', 'ic', 'poc', 'lgbtq', 'bipoc',
  // pronoun / sentence words that are capitalized for reasons other than being a name
  'i', 'we', 'you', 'your', 'our', 'my',
  // job-title words that are routinely title-cased mid-sentence
  'engineer', 'engineering', 'manager', 'developer', 'analyst', 'designer', 'director',
  'senior', 'junior', 'staff', 'principal', 'lead', 'intern', 'security', 'incident',
  'response', 'software', 'data', 'product', 'project', 'program', 'cloud', 'platform',
  // form/legal words often title-cased in ATS copy
  'yes', 'no', 'n', 'a', 'true', 'false', 'select', 'other', 'none', 'company', 'employer',
  'position', 'role', 'job', 'application', 'resume', 'cv', 'linkedin', 'github',
]);

// Does this token look like a company/brand NAME rather than an ordinary word?
//   • mixed letters+digits  → 1Password, S1, 3M, C3
//   • otherwise it must be capitalized MID-SENTENCE and not in NON_BRAND
// Sentence-initial capitals are excluded by the caller, which knows the position.
function isBrandToken(tok) {
  const t = String(tok || '');
  if (t.length < 2 || t.length > 40) return false;
  const lower = t.toLowerCase();
  if (NON_BRAND.has(lower)) return false;
  if (/^\d+$/.test(t)) return false;                       // a bare number is not a brand
  if (/\d/.test(t) && /[a-z]/i.test(t)) return true;       // 1Password, 3M, C3, S1
  if (!/^[A-Z]/.test(t)) return false;                     // must be capitalized
  if (/^[A-Z]{2,6}$/.test(t)) return true;                 // IBM, AWS, SAP, RBC
  return /^[A-Z][a-z]/.test(t);                            // Geotab, Robinhood, Shopify
}

// The set of company/brand names a question is ABOUT.
//
// Only mid-sentence capitals count: the first word after a sentence boundary is capitalized
// by grammar, not by identity ("Do you currently work for…" must not yield the brand "Do").
// A possessive/plural suffix is stripped so "Geotab's" and "Geotab" are the same identity.
function brandTokens(text) {
  const out = new Set();
  const s = String(text == null ? '' : text);
  if (!s.trim()) return out;
  // Split into sentences so we know which token is sentence-initial. A leading bullet,
  // number or quote is chrome, not the first word.
  for (const sentence of s.split(/(?<=[.!?;:])\s+|\n+/)) {
    const toks = sentence.match(/[A-Za-z0-9][A-Za-z0-9'’&.-]*/g) || [];
    for (let i = 0; i < toks.length; i++) {
      const raw = toks[i].replace(/['’]s$/i, '').replace(/[.'’-]+$/, '');
      if (i === 0 && !/\d/.test(raw)) continue;            // sentence-initial word: grammar, not identity
      if (isBrandToken(raw)) out.add(raw.toLowerCase());
    }
  }
  return out;
}

// Do these two questions talk about the SAME company?
//
// Any brand named by one and not the other is a conflict — in BOTH directions:
//   • asked names 1Password, stored names Geotab      → different companies
//   • asked names 1Password, stored names nobody      → a generic answer must not be
//     presented as an answer about a specific company
//   • asked names nobody, stored names Geotab         → a Geotab-specific answer is not a
//     generic answer ("do you work for a reseller of Geotab" ≠ "do you work for a reseller")
// Returns TRUE when a recall between these two must be refused.
function brandConflict(askedQuestion, storedQuestion) {
  const a = brandTokens(askedQuestion);
  const b = brandTokens(storedQuestion);
  if (!a.size && !b.size) return false;
  if (a.size !== b.size) return true;
  for (const t of a) if (!b.has(t)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// QUESTION SHAPE — what KIND of answer does this question expect?
// ---------------------------------------------------------------------------

// A yes/no question opens with an auxiliary or modal. Anchored to the START of the
// operative clause, because that is what makes a question boolean in English.
const AUX_RX = /^(?:do|does|did|are|is|was|were|have|has|had|will|would|can|could|should|shall|may|must|am|any)\b/i;
const YESNO_PHRASE_RX = /\b(?:do you|does your|did you|are you|is your|are there|is there|have you|has your|had you|will you|would you|can you|could you|should you|may we|are we|do we|would your)\b/i;
const WH_RX = /^(?:what|which|where|when|who|whom|whose|how|why)\b/i;

const DATE_RX = /\b(?:what date|which date|date would|start date|available to (?:start|onboard)|earliest (?:start|date)|when (?:could|can|would|will) you (?:start|begin|join)|date of|dd\/mm|mm\/dd|yyyy)\b/i;
const NUMBER_RX = /\b(?:how many|how much|number of|years? of experience|total years|quantity|combien)\b/i;
const SALARY_RX = /\b(?:salary|compensation|pay|rate|remuneration|salaire|wage|hourly rate)\b/i;
const LOCATION_RX = /\b(?:city|province|state|country|located|location|based|reside|residing|address|postal|zip|where are you|where do you)\b/i;

// The operative clause of a prompt is its LAST sentence. ATS prompts routinely lead with a
// statement — "This is a remote position. Where are you currently located?" — and reading the
// whole string as one blob is exactly how that question came to be answered "Yes": the
// preamble's "remote" won over the actual interrogative.
function operativeClause(question) {
  const s = String(question == null ? '' : question).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const parts = s.split(/(?<=[.!?])\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return s;
  // Prefer the last part that actually reads like a question/prompt; else the last part.
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (/\?$/.test(p) || WH_RX.test(p) || YESNO_PHRASE_RX.test(p) || AUX_RX.test(p)) return p;
  }
  return parts[parts.length - 1];
}

// questionShape(q) → 'yesno' | 'date' | 'number' | 'salary' | 'location' | 'text'
//
// Order matters. A wh-interrogative ("where are you located?") is NEVER yes/no even though
// it contains "are you"; and a date/number question is checked before the generic buckets.
function questionShape(question) {
  const full = String(question == null ? '' : question).replace(/\s+/g, ' ').trim();
  if (!full) return 'text';
  const clause = operativeClause(full);
  const isWh = WH_RX.test(clause);

  // Explicit "(Yes/No)" markers beat everything — the form is telling us the shape.
  if (/\(\s*y(?:es)?\s*\/\s*n(?:o)?\s*\)/i.test(full)) return 'yesno';

  if (!isWh && (AUX_RX.test(clause) || YESNO_PHRASE_RX.test(clause))) return 'yesno';

  if (DATE_RX.test(clause) || DATE_RX.test(full)) return 'date';
  if (SALARY_RX.test(clause) && (isWh || /expect|desire|require|seeking/i.test(full))) return 'salary';
  if (NUMBER_RX.test(clause)) return 'number';
  if (isWh && LOCATION_RX.test(clause)) return 'location';
  return 'text';
}

// ---------------------------------------------------------------------------
// ANSWER SHAPE
// ---------------------------------------------------------------------------

const YES_ANSWER_RX = /^\s*(?:yes|y|true|oui|si|sí|ja|1|i (?:do|am|have|will|can|agree)|agree|accept|confirmed?)\b/i;
const NO_ANSWER_RX = /^\s*(?:no|n|false|non|nein|0|i (?:do not|don'?t|am not|have not|haven'?t|will not|won'?t|cannot|can'?t)|not applicable|n\/a|none|decline)\b/i;

function looksYesNo(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return false;
  return YES_ANSWER_RX.test(s) || NO_ANSWER_RX.test(s);
}
function isYes(v) { return YES_ANSWER_RX.test(String(v == null ? '' : v).trim()); }
function isNo(v) { return NO_ANSWER_RX.test(String(v == null ? '' : v).trim()); }

function looksDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return false;
  if (/\b\d{4}-\d{1,2}-\d{1,2}\b/.test(s)) return true;
  if (/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/.test(s)) return true;
  if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i.test(s)) return true;
  if (/\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s)) return true;
  // Relative availability answers are legitimate answers to a date question.
  if (/\b(?:immediately|asap|right away|two weeks|2 weeks|one month|1 month|\d+\s*(?:days?|weeks?|months?)|notice|negotiable|flexible|upon offer)\b/i.test(s)) return true;
  return false;
}
function looksNumeric(v) {
  return /\d/.test(String(v == null ? '' : v));
}

// A location answer names a place. Deliberately loose — a place name is open-ended — but it
// must NOT be a bare yes/no, which is the exact live failure ("where are you located" → "Yes").
function looksLocation(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return false;
  if (looksYesNo(s) && s.split(/\s+/).length <= 2) return false;
  return true;
}

// answerFitsQuestion(question, answer, options?) → boolean
//
// The gate applied to EVERY recalled answer, exact match included. An exact key match is
// not a guarantee of sanity: memory already holds rows poisoned by the profile-string bug
// ("are you legally authorized to work…" → "Authorized to work in Canada (no sponsorship
// required)"), and serving those back is how the wrong shape keeps reaching forms. Gating on
// READ fixes them without a destructive migration of the live store.
//
// Conservative on purpose: 'text' questions are never gated, and an answer that is verbatim
// one of the field's own options is always allowed (the form itself defined that vocabulary).
function answerFitsQuestion(question, answer, options) {
  const a = String(answer == null ? '' : answer).trim();
  if (!a) return false;
  if (Array.isArray(options) && options.some((o) => String(o).trim().toLowerCase() === a.toLowerCase())) return true;
  switch (questionShape(question)) {
    case 'yesno':   return looksYesNo(a);
    case 'date':    return looksDate(a);
    case 'number':  return looksNumeric(a);
    case 'salary':  return looksNumeric(a);
    case 'location': return looksLocation(a);
    default:        return true;
  }
}

// recallAllowed(askedQuestion, storedQuestion, storedAnswer, options?)
// The single predicate the recall path calls: same company AND a sane shape.
function recallAllowed(askedQuestion, storedQuestion, storedAnswer, options) {
  if (brandConflict(askedQuestion, storedQuestion)) return false;
  return answerFitsQuestion(askedQuestion, storedAnswer, options);
}

module.exports = {
  brandTokens, brandConflict, isBrandToken,
  questionShape, operativeClause,
  looksYesNo, isYes, isNo, looksDate, looksNumeric, looksLocation,
  answerFitsQuestion, recallAllowed,
};
