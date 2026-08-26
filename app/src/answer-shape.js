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
  // FORM FIELD LABELS. An ATS labels its fields in Title Case -- "Street Address",
  // "Location (City)", "First Name", "Postal Code" -- and every capital after the first word
  // read as a company identity. The stored question is lowercase and names no brand, so the
  // sizes differed and brandConflict refused the recall. Measured on the real database: this
  // was the single largest source of parked applications, with "Location (City)*" the most
  // parked question of all. These nouns are never the company a question is ABOUT.
  'address', 'street', 'city', 'town', 'province', 'state', 'country', 'postal', 'zip',
  'code', 'name', 'first', 'last', 'middle', 'preferred', 'legal', 'full', 'line',
  'number', 'phone', 'mobile', 'email', 'date', 'birth', 'gender', 'pronouns', 'title',
  'level', 'salary', 'website', 'portfolio', 'url', 'link', 'file', 'upload', 'required',
  'optional', 'question', 'answer', 'resident', 'residence', 'citizenship', 'status',
  'downtown', 'export', 'control', 'region', 'location', 'apartment', 'unit', 'suite',
  // TECHNOLOGIES. "How would you rate your proficiency in Python?" names a language, not an
  // employer -- but Python/React/Java are capitalized mid-sentence exactly like Geotab, so
  // every skills question was locked out of its own stored answer. Vendor-named products
  // whose company Pierre could plausibly be ASKED about (Oracle, Salesforce, MongoDB,
  // Docker, Redis, Atlassian) are deliberately NOT here -- there the brand reading is right.
  'python', 'java', 'javascript', 'typescript', 'react', 'angular', 'vue', 'svelte',
  'node', 'nodejs', 'deno', 'spring', 'boot', 'rails', 'django', 'flask', 'laravel',
  'golang', 'rust', 'kotlin', 'swift', 'scala', 'perl', 'php', 'ruby', 'dart', 'flutter',
  'sql', 'nosql', 'graphql', 'grpc', 'rest', 'api', 'apis', 'json', 'xml', 'yaml', 'html',
  'css', 'sass', 'scss', 'jquery', 'redux', 'webpack', 'vite', 'babel', 'jest', 'cypress',
  'aws', 'azure', 'gcp', 'linux', 'unix', 'ubuntu', 'bash', 'powershell', 'git',
  'kubernetes', 'k8s', 'terraform', 'ansible', 'jenkins', 'kafka', 'spark', 'hadoop',
  'net', 'asp', 'mvc', 'wpf', 'xamarin', 'unity', 'android', 'ios', 'kb', 'ide',
  'node.js', 'ci', 'cd', 'ci/cd',
  // CORPORATE SUFFIXES. "Acme Inc" and "Acme" are the same employer, but as token SETS they
  // differ in size, which brandConflict reads as two different companies. The identity lives
  // in the name, never in the suffix.
  'inc', 'inc.', 'ltd', 'ltd.', 'llc', 'llp', 'corp', 'corp.', 'corporation', 'limited',
  'plc', 'gmbh', 'ag', 'nv', 'bv', 'srl', 'pty', 'co', 'co.', 'holdings', 'group',
  // LEGAL / CONSENT BOILERPLATE. "Please review the Privacy Notice" names no employer -- and
  // where it does ("the Robinhood Applicant Privacy Notice") the real brand still survives.
  'privacy', 'notice', 'policy', 'consent', 'disclaimer', 'statement', 'agreement',
  'terms', 'conditions', 'acknowledgement', 'acknowledgment', 'applicant', 'candidate',
  // MISCELLANEOUS SCRAPE NOISE seen in the real corpus: a tax form, a truncated accented
  // place name (Montreal/Quebec lose their accented letter upstream and split), and ordinary
  // words that happen to be title-cased mid-label.
  't4', 'expv2', 'montr', 'qu', 'are', 'greater', 'mi', 'am', 'is', 'the', 'and', 'or',
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
  // A hex fragment is not a brand. The mixed letters+digits rule below exists for 1Password
  // and S1, but it also fired on every UUID and DOM id that leaks into a scraped field label
  // -- "7a08ec2d", "b470", "ae77", "id62". Each became a phantom company name that no stored
  // question could match, so the recall was refused and the application parked. Measured on
  // the real database, these were a third of the most frequent "brands" in Pierre's data.
  if (/^[0-9a-f]{3,}$/i.test(t) && /\d/.test(t)) return false;
  if (/^id\d+$/i.test(t)) return false;                     // id0, id62, id101
  // Digits followed by LOWERCASE letters is a scrape artifact, not a name. Real brands that
  // open with a digit capitalize the next letter -- 1Password, 3M, 7-Eleven. A run like
  // "355algeria" is a phone country-code <option> harvested into the field label; Pierre's
  // database holds a whole dropdown of them, each one a phantom company.
  if (/^\d+[a-z]/.test(t)) return false;
  if (/\d/.test(t) && /[a-z]/i.test(t)) return true;       // 1Password, 3M, C3, S1
  if (!/^[A-Z]/.test(t)) return false;                     // must be capitalized
  if (/^[A-Z]{2,6}$/.test(t)) return true;                 // IBM, SAP, RBC (AWS/GCP are in NON_BRAND: technologies)
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
// A string with no capital letter anywhere carries no case information, so brandTokens()
// -- which finds names BY their mid-sentence capital -- can never find anything in it.
const CASELESS_RX = /[A-Z]/;
const WORD_RX = /[a-z0-9][a-z0-9'’&.-]*/g;
// "worked AT geotab", "hear ABOUT d2l", "sponsor FOR stripe" -- in a caseless question the
// company still sits after one of these prepositions. It is the only handle left.
// The word after a preposition is USUALLY not a company. Ranked over every caseless stored
// question in the real database, the head of the distribution is entirely generic -- "work"
// (538), "this" (145), "the" (139), "experience" (112) -- while actual employers sit far down
// the tail (microsoft 16, tailscale 8, robinhood 7, shopify 7). Without this set the rule
// below reads "relocate for this role" as a company called "this" and refuses the recall,
// which is the very mass-refusal this whole change exists to end.
const COMMON_AFTER = new Set([
  'work', 'working', 'works', 'this', 'that', 'these', 'those', 'the', 'a', 'an', 'any',
  'your', 'our', 'their', 'my', 'his', 'her', 'its', 'you', 'us', 'we', 'them', 'it',
  'experience', 'stay', 'date', 'dates', 'professional', 'relocate', 'relocation', 'start',
  'residence', 'employment', 'employer', 'be', 'been', 'hands', 'hands-on', 'education',
  'receive', 'proficiency', 'how', 'which', 'what', 'who', 'when', 'where', 'why',
  'least', 'most', 'all', 'both', 'each', 'every', 'some', 'none', 'no', 'not',
  'someone', 'anyone', 'people', 'person', 'contact', 'make', 'future', 'travel', 'web',
  'sign', 'embedded', 'capital', 'commute', 'commuting', 'home', 'office', 'remote',
  'onsite', 'on-site', 'hybrid', 'team', 'teams', 'time', 'times', 'year', 'years',
  'month', 'months', 'week', 'weeks', 'day', 'days', 'more', 'less', 'other', 'others',
  'here', 'there', 'then', 'than', 'same', 'such', 'if', 'and', 'or', 'but', 'so',
  'me', 'i', 'he', 'she', 'they', 'one', 'two', 'three', 'new', 'current', 'previous',
  'past', 'recent', 'this-role', 'role', 'roles', 'position', 'positions', 'job', 'jobs',
]);
const NAMED_AFTER_RX = /\b(?:at|for|about|with|by|from|to|of|joining|join)\s+([a-z0-9][a-z0-9'’&.-]{1,30})/g;

function brandConflict(askedQuestion, storedQuestion) {
  const a = brandTokens(askedQuestion);
  const b = brandTokens(storedQuestion);

  // THE STORED SIDE IS USUALLY CASELESS. Measured on Pierre's real database: 3,570 of 4,601
  // remembered questions (78%) hold no capital letter at all, because they were flattened
  // upstream before being stored. Against those rows brandTokens() returns an empty set, so
  // every properly-capitalized form question that named a company -- which is how real ATS
  // forms write them -- had a.size=1 against b.size=0, read as "two different companies",
  // and its own remembered answer was refused. That was the single largest cause of parked
  // applications: eleven copies of "have you previously been employed at Affirm" sat waiting
  // for a human next to the stored answer to that exact question.
  //
  // When the stored side is caseless, compare by WORD PRESENCE instead of by capitalization.
  if (!b.size && !CASELESS_RX.test(String(storedQuestion == null ? '' : storedQuestion))) {
    const words = new Set(String(storedQuestion == null ? '' : storedQuestion).toLowerCase().match(WORD_RX) || []);
    // Every company the asked question names must actually be mentioned in the stored one.
    for (const t of a) if (!words.has(t)) return true;
    if (a.size) return false;
    // The reverse direction still has to hold: a generic question must not be answered from
    // a company-specific memory ("why do you want to work here?" answered from "why do you
    // want to work at geotab?"). With no capitals to read, the preposition is the only clue.
    const asked = String(askedQuestion == null ? '' : askedQuestion).toLowerCase();
    const askedWords = new Set(asked.match(WORD_RX) || []);
    const stored = String(storedQuestion == null ? '' : storedQuestion).toLowerCase();
    let mm; NAMED_AFTER_RX.lastIndex = 0;
    while ((mm = NAMED_AFTER_RX.exec(stored))) {
      const cand = mm[1].replace(/[.'’-]+$/, '');
      if (cand.length < 2 || NON_BRAND.has(cand) || COMMON_AFTER.has(cand)) continue;
      if (/^\d+$/.test(cand)) continue;
      if (!askedWords.has(cand)) return true;   // stored names someone the asked does not
    }
    return false;
  }

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
// "Years of React?" is a counting question just as much as "years of experience" is -- ATS
// forms ask it about a named technology far more often than in the abstract. It used to fall
// through to 'text', which mattered the moment a bare numeral stopped being an acceptable
// answer to a text question: the honest answer "5" was refused.
const NUMBER_RX = /\b(?:how many|how much|number of|years? of|years? experience|how long|total years|quantity|combien)\b/i;
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
// An ATTESTATION is not a free-text question. "I have read and understand the Export Control
// statement", "Please review and acknowledge the Applicant Privacy Notice" -- these are
// checkboxes, and the only answer they take is an affirmation. Pierre's memory held the
// province "Ontario" against that exact Export Control question, and once the brand guard
// stopped masking it, the recall path was about to send "Ontario" to an employer as his
// acknowledgement of an export-control statement.
const ACK_Q_RX = /^(?:i\s+(?:have\s+read|acknowledge|agree|confirm|understand|consent|certify|accept|declare)|please\s+(?:read|review|confirm|acknowledge|indicate\s+your\s+agreement)|by\s+(?:checking|clicking|submitting)|do\s+you\s+(?:agree|acknowledge|consent))/i;
const ACK_A_RX = /^(?:yes|y|true|on|1|checked|agree[d]?|i\s+agree|acknowledged?|i\s+acknowledge|accept(?:ed)?|confirm(?:ed)?|understood|i\s+have\s+read|consent(?:ed)?|ok(?:ay)?)\b/i;

// A bare numeral answers a counting question and nothing else. "0" was stored against "How
// did you first learn about Affirm as an employer?" -- an exact-match hit, so it would have
// been submitted verbatim.
const BARE_NUMERAL_RX = /^-?\d+(?:\.\d+)?$/;

function looksAcknowledgement(a) { return ACK_A_RX.test(String(a || '').trim()); }
function isAttestation(question) { return ACK_Q_RX.test(operativeClause(question)); }

function answerFitsQuestion(question, answer, options) {
  const a = String(answer == null ? '' : answer).trim();
  if (!a) return false;
  if (Array.isArray(options) && options.some((o) => String(o).trim().toLowerCase() === a.toLowerCase())) return true;
  const shape = questionShape(question);
  if (isAttestation(question) && shape !== 'date' && shape !== 'number' && shape !== 'salary') {
    return looksAcknowledgement(a);
  }
  if (BARE_NUMERAL_RX.test(a) && shape !== 'number' && shape !== 'salary' && shape !== 'date') {
    return false;   // a naked number is not an answer to a worded question
  }
  switch (shape) {
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
  answerFitsQuestion, recallAllowed, isAttestation, looksAcknowledgement,
};
