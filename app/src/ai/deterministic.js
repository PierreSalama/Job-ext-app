// JAT v11 — deterministic no-model answer floor (Apprenticeship Engine P4).
//
// The engine must still apply on a machine with NO AI model at all (Dad's
// GPU-less laptop, or a brand-new offline box before the first-run pull). This
// module mirrors — in pure regex/profile-derivation, zero model — the
// "ANSWER THESE COMMON QUESTIONS WITH HIGH CONFIDENCE" grounding block in
// ai/prompts.js answerQuestion(). It is the floor UNDER `local` in provider.js:
// when the local model is unavailable/weak/errors, the answer-question path
// falls back here before the executor parks the question for the user.
//
// CONTRACT (matches the prompt's JSON result shape):
//   answer(question, ctx) where ctx = { profile, resume, options }
//     → { answer, confidence, source:'deterministic' }   (confident)
//     → null                                              (not confident — caller parks)
//
// Truthfulness over coverage: when a question matches none of the high-confidence
// rules we return null rather than guess, and we NEVER fabricate a credential or
// emit a URL/link for a years/quantity question.

const db = require('../db');
const fit = require('../fit');

// ---- profile field access (mirror prompts.js profileBlock's d = profile.data || profile) ----
function pdata(profile) {
  return (profile && (profile.data || profile)) || {};
}
function firstNonEmpty(...vals) {
  for (const v of vals) { if (v != null && String(v).trim() !== '') return String(v).trim(); }
  return '';
}

// ---- Canadian province / territory canonicalization (residency / which-location) ----
// Maps every common spelling + 2-letter code to a canonical province name so a
// "Toronto, Ontario" profile correctly answers "residing in BC?" = No.
const PROVINCES = {
  ontario: 'Ontario', on: 'Ontario',
  quebec: 'Quebec', qc: 'Quebec', 'québec': 'Quebec',
  'british columbia': 'British Columbia', bc: 'British Columbia',
  alberta: 'Alberta', ab: 'Alberta',
  manitoba: 'Manitoba', mb: 'Manitoba',
  saskatchewan: 'Saskatchewan', sk: 'Saskatchewan',
  'nova scotia': 'Nova Scotia', ns: 'Nova Scotia',
  'new brunswick': 'New Brunswick', nb: 'New Brunswick',
  'newfoundland and labrador': 'Newfoundland and Labrador', newfoundland: 'Newfoundland and Labrador', nl: 'Newfoundland and Labrador',
  'prince edward island': 'Prince Edward Island', pei: 'Prince Edward Island', pe: 'Prince Edward Island',
  'northwest territories': 'Northwest Territories', nt: 'Northwest Territories',
  yukon: 'Yukon', yt: 'Yukon',
  nunavut: 'Nunavut', nu: 'Nunavut',
};
// City → province, so a profile that only carries a city still derives residency.
const CITY_PROVINCE = {
  toronto: 'Ontario', ottawa: 'Ontario', mississauga: 'Ontario', hamilton: 'Ontario', london: 'Ontario', kitchener: 'Ontario', waterloo: 'Ontario', markham: 'Ontario', brampton: 'Ontario', windsor: 'Ontario',
  montreal: 'Quebec', 'montréal': 'Quebec', quebec: 'Quebec', 'québec': 'Quebec', laval: 'Quebec', gatineau: 'Quebec',
  vancouver: 'British Columbia', victoria: 'British Columbia', burnaby: 'British Columbia', surrey: 'British Columbia', richmond: 'British Columbia', kelowna: 'British Columbia',
  calgary: 'Alberta', edmonton: 'Alberta',
  winnipeg: 'Manitoba',
  saskatoon: 'Saskatchewan', regina: 'Saskatchewan',
  halifax: 'Nova Scotia',
};
const BC_ALIASES = /\b(b\.?c\.?|british columbia)\b/i; // "BC" both as a province abbrev and a phrase

function canonProvince(raw) {
  const k = String(raw || '').toLowerCase().trim();
  if (PROVINCES[k]) return PROVINCES[k];
  // try a contained match (e.g. "Ontario, Canada")
  for (const key of Object.keys(PROVINCES)) {
    if (key.length > 3 && k.includes(key)) return PROVINCES[key];
  }
  return '';
}

// Pull a usable {city, province, country} out of whatever the profile carries —
// structured fields first, then a free-text "location" string.
function profileLocation(profile) {
  const d = pdata(profile);
  let city = firstNonEmpty(d.city);
  let province = canonProvince(firstNonEmpty(d.region, d.state, d.province));
  let country = firstNonEmpty(d.country);
  const free = firstNonEmpty(d.location);
  if (free) {
    const parts = free.split(',').map((s) => s.trim()).filter(Boolean);
    if (!city && parts[0]) city = parts[0];
    if (!province) { for (const p of parts) { const c = canonProvince(p); if (c) { province = c; break; } } }
    if (!country && /canada/i.test(free)) country = 'Canada';
  }
  if (!province && city) province = CITY_PROVINCE[city.toLowerCase()] || '';
  if (!country && province) country = 'Canada'; // a recognized CA province implies Canada
  return { city, province, country };
}

// ---- option matching: when the form is a choice field, the returned answer MUST
// be exactly one of the options (verbatim). Map a yes/no/value intent onto them. ----
const YES_RX = /^\s*(yes|y|true|oui|i (do|am|have)|agree|accept)\b/i;
const NO_RX = /^\s*(no|n|false|non|i (do not|don'?t|am not|have not|haven'?t))\b/i;

function pickOption(options, want) {
  if (!Array.isArray(options) || !options.length) return want; // free-text: return as-is
  const norm = (s) => String(s).toLowerCase().trim();
  const w = norm(want);
  // 1) exact / contained text match against an option
  let hit = options.find((o) => norm(o) === w) || options.find((o) => norm(o).includes(w) && w.length > 1);
  if (hit) return hit;
  // 2) yes/no intent → the yes/no-looking option
  if (YES_RX.test(want)) hit = options.find((o) => YES_RX.test(o));
  else if (NO_RX.test(want)) hit = options.find((o) => NO_RX.test(o));
  if (hit) return hit;
  return null; // can't honor "answer must be one of options" → not confident
}

function result(answer, confidence, options) {
  if (answer == null) return null;
  const final = pickOption(options, String(answer));
  if (final == null) return null; // options given but none matched → park, don't guess
  return { answer: String(final), confidence, source: 'deterministic' };
}

// ---- years-of-experience estimate (NEVER a URL; always a number) ----
function estimateYears(profile, resume) {
  const d = pdata(profile);
  const ye = firstNonEmpty(d.yearsExperience);
  if (ye) { const m = ye.match(/\d{1,2}/); if (m) return parseInt(m[0], 10); }
  // Fall back to the earliest 4-digit year mentioned in the resume's work history.
  const text = String(resume || '');
  const years = (text.match(/\b(19|20)\d{2}\b/g) || []).map((y) => parseInt(y, 10)).filter((y) => y >= 1970 && y <= new Date().getFullYear());
  if (years.length) {
    const span = new Date().getFullYear() - Math.min(...years);
    if (span >= 0 && span <= 50) return span;
  }
  return null;
}

// ---- education level ordering (hold-this-or-higher → Yes) ----
const EDU_RANK = [
  { rx: /\b(ph\.?d|doctorate|doctoral)\b/i, rank: 5 },
  { rx: /\b(master'?s?|m\.?s\.?c?|m\.?eng|mba|graduate degree)\b/i, rank: 4 },
  { rx: /\b(bachelor'?s?|b\.?s\.?c?|b\.?eng|b\.?a\.?|undergraduate|baccalaur)\b/i, rank: 3 },
  { rx: /\b(associate|diploma|college)\b/i, rank: 2 },
  { rx: /\b(high school|secondary|ged|diplôme d'études secondaires)\b/i, rank: 1 },
];
function eduRank(text) {
  let best = 0;
  for (const e of EDU_RANK) if (e.rx.test(text)) best = Math.max(best, e.rank);
  return best;
}
function profileEduRank(profile, resume) {
  const d = pdata(profile);
  return eduRank(`${firstNonEmpty(d.highestDegree, d.degree)} ${firstNonEmpty(d.major)} ${String(resume || '')}`);
}

// ---- the floor: answer(question, ctx) ----
function answer(question, ctx = {}) {
  const q = String(question || '');
  if (!q.trim()) return null;
  const profile = ctx.profile;
  const resume = ctx.resume || '';
  const options = ctx.options;
  const qn = db.normalizeQuestion(q);           // EN+FR canonical bag-of-words
  const lc = q.toLowerCase();

  // HARD RAIL: never let the floor emit a credential/sensitive answer — these route
  // to the user (mirrors the prompt's "ONLY answer if the profile explicitly contains").
  if (db.isSensitiveKey(q)) return null;

  // ---------- EDUCATION (check before YEARS so "years of post-secondary education"
  // about a *degree* resolves as education, and before residency) ----------
  if (/\b(degree|bachelor|master|phd|doctorate|diploma|education|graduat|undergrad|post.?secondary|qualification)\b/.test(lc)) {
    const have = profileEduRank(profile, resume);
    if (have > 0) {
      const asked = eduRank(lc);
      if (asked > 0) {
        // "have you completed / do you hold a <X> or higher?" → Yes if we hold ≥ asked.
        return result(have >= asked ? 'Yes' : 'No', 0.9, options);
      }
      // "highest level of education?" — answer with the held level label.
      const label = ['', 'High school', 'Associate / Diploma', "Bachelor's", "Master's", 'PhD'][have];
      return result(label, 0.85, options);
    }
    return null; // no education on file → don't guess
  }

  // ---------- YEARS OF EXPERIENCE (must be a NUMBER, never a URL) ----------
  if (/\b(years?|how long|how many)\b/.test(lc) && /\b(experience|exp|worked|using|with|of)\b/.test(lc)) {
    const n = estimateYears(profile, resume);
    if (n != null && Number.isFinite(n)) return result(String(n), 0.75, options);
    return null;
  }

  // ---------- AUTHORIZED TO WORK ----------
  if (/\b(authori[sz]ed|eligible|legally|right to work|permitted)\b/.test(lc) && /\b(work|employ)\b/.test(lc)) {
    const d = pdata(profile);
    const wa = firstNonEmpty(d.workAuthorization, d.citizenship);
    if (wa) {
      if (/\b(not authorized|no\b|require|need.*visa|sponsor)\b/i.test(wa)) return result('No', 0.85, options);
      return result('Yes', 0.85, options); // a stated authorization (citizen/PR/authorized) → Yes
    }
    return null; // legal/work-auth: answer ONLY from profile, else park
  }

  // A which/what/where interrogative is a FILL-IN location question, not a yes/no
  // residency one — route it to WHICH-LOCATION first so "what city are you based in?"
  // returns the city, not a null residency.
  const isInterrogative = /\b(what|which|where)\b/.test(lc);

  // ---------- WHICH-LOCATION (fill-in / choice: country / province / city) ----------
  if (isInterrogative && /\b(country|province|state|city|located|based|location|region|reside|live)\b/.test(lc)) {
    const loc = profileLocation(profile);
    if (/\bcountry\b/.test(lc) && loc.country) return result(loc.country, 0.9, options);
    if (/\b(province|state|region)\b/.test(lc) && loc.province) return result(loc.province, 0.9, options);
    if (/\bcity\b/.test(lc) && loc.city) return result(loc.city, 0.9, options);
    // "where are you based/located?" — most specific available
    if (loc.city || loc.province || loc.country) {
      return result([loc.city, loc.province, loc.country].filter(Boolean).join(', '), 0.85, options);
    }
    return null;
  }

  // ---------- RESIDENCY (yes/no about a place) ----------
  if (!isInterrogative && /\b(residing|reside|resident|located|based|live|living|commuting distance|located in|based in)\b/.test(lc)) {
    const loc = profileLocation(profile);
    // Province residency, e.g. "are you currently residing in BC?"
    let askedProv = '';
    if (BC_ALIASES.test(q)) askedProv = 'British Columbia';
    if (!askedProv) for (const [key, name] of Object.entries(PROVINCES)) {
      if (key.length <= 3) { if (new RegExp(`\\b${key}\\b`, 'i').test(q)) { askedProv = name; break; } }
      else if (lc.includes(key)) { askedProv = name; break; }
    }
    if (askedProv && loc.province) return result(loc.province === askedProv ? 'Yes' : 'No', 0.9, options);
    // Country residency, e.g. "are you a resident of Canada?"
    if (/\bcanada\b/i.test(q) && loc.country) return result(/canada/i.test(loc.country) ? 'Yes' : 'No', 0.9, options);
    // City residency
    if (loc.city && new RegExp(`\\b${loc.city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(q)) return result('Yes', 0.85, options);
    return null; // can't tell which place is being asked about → park
  }

  // ---------- PREFERRED LANGUAGE ----------
  if (/\blanguage\b/.test(lc) && /\b(prefer|correspondence|communicat|speak|fluent)\b/.test(lc)) {
    const d = pdata(profile);
    const lang = firstNonEmpty(d.preferredLanguage, d.language);
    return result(lang || 'English', lang ? 0.9 : 0.85, options);
  }

  // ---------- RELOCATION / REMOTE / ONSITE ----------
  // No trailing \b: `relocat` is a stem so it matches relocate/relocation; the other
  // alternatives are whole words and don't need it.
  if (/\b(relocat|remote|onsite|on-site|hybrid|work from home|wfh|willing to move|commute)/.test(lc)) {
    const d = pdata(profile);
    const pref = firstNonEmpty(d.relocation, d.openToRelocation, d.remotePreference);
    if (pref) {
      if (NO_RX.test(pref) || /\bnot\b/i.test(pref)) return result('No', 0.8, options);
      return result('Yes', 0.8, options);
    }
    // Default: an applicant is presumed open to the job's arrangement (~0.8).
    return result('Yes', 0.8, options);
  }

  // ---------- START DATE / NOTICE PERIOD (reasonable defaults) ----------
  if (/\b(start date|available to start|availability|when can you start|notice period|how much notice|earliest start)\b/.test(lc)) {
    const d = pdata(profile);
    const np = firstNonEmpty(d.noticePeriod, d.availability);
    if (np) return result(np, 0.8, options);
    if (/\bnotice\b/.test(lc)) return result('2 weeks', 0.75, options);
    return result('Immediately', 0.7, options); // available to start
  }

  // Matched no high-confidence rule → null so the caller parks rather than guessing.
  return null;
}

// ---- thin fitScore so relevance still works with no model (delegates to fit.js) ----
function fitScore(job, profile, resumeText) {
  return fit.score(job, profile, resumeText);
}

module.exports = { answer, fitScore };
