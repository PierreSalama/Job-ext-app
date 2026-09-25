'use strict';
// ============================================================================
//  "HAVE YOU PREVIOUSLY WORKED HERE?" — answered from his real history.
//
//  Pierre, 2026-09-08: "I have only been employed by the microemployers, so if any of these
//  questions come up you should have the answer automatically." Every large employer asks it, and
//  the honest answer is No for every company except the handful he has actually worked for.
//
//  It was NOT being answered automatically, and the answer bank shows what filled the gap instead.
//  Of 28 prior-employment rows recorded live, several are junk that was replayed onto real
//  applications:
//
//      "have you previously worked for Linamar or any of its subsidiaries"  -> "300000126828332"
//      "have you previously been employed by coinbase in any capacity"      -> "Toronto, ON"
//      "have you previously worked for tucows or any of its subsidiaries"   -> "0"
//      "are you currently employed by or have you previously worked for..." -> "on"
//
//  An option id, a city, and a checkbox value, sitting where a recruiter reads an answer.
//
//  GROUNDED, NOT BLANKET. A flat "No" would be a guess dressed as a fact, and it would be wrong the
//  day he applies back somewhere he has worked. So the company named in the question is matched
//  against his real history: a match returns null and the question goes to a human, rather than the
//  floor asserting something it cannot know. Refusing to answer is cheap; a false "No" to a former
//  employer is the kind of thing that ends an application.
//
//  It lives in its own file because the rule is regex-heavy, and building these patterns through a
//  shell here-doc corrupted them four separate times in one session.
// ============================================================================

// The shapes this question actually takes on real forms.
const PRIOR_EMPLOYMENT_RX = new RegExp(
  [
    '(?:previously|ever|formerly|in the past)[^?]{0,40}?(?:employed|worked|work)',
    '(?:employed|worked)[^?]{0,30}(?:previously|before|in the past)',
    "former(?:ly)? (?:an? )?(?:employee|worker|contractor|intern)",
    '(?:are you|were you) (?:currently )?(?:employed by|an employee of)',
    'have you (?:ever )?(?:been )?(?:employed|worked)',
  ].join('|'),
  'i',
);

const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every employer we can name, from the structured profile and from the resume text.
function knownEmployers(profile, resume) {
  const d = (profile && (profile.data || profile)) || {};
  const out = new Set();
  const add = (v) => {
    const t = String(v == null ? '' : v).trim().toLowerCase();
    // Two characters is not a company name, it is an initial or a stray cell.
    if (t.length > 2) out.add(t);
  };

  for (const k of ['employer', 'employers', 'currentEmployer', 'previousEmployer', 'company', 'companies']) add(d[k]);

  for (const key of ['workHistory', 'experience', 'employment', 'jobs', 'positions']) {
    const hist = d[key];
    if (Array.isArray(hist)) {
      for (const e of hist) add(e && (e.company || e.employer || e.organization || e.name));
    }
  }

  // The resume is the fullest record we hold and it is plain text. Pull lines that look like an
  // employer line rather than parsing a document format we do not control.
  const lines = String(resume || '').split(/\r?\n/).slice(0, 400);
  for (const line of lines) {
    const m = /^\s*([A-Z][\w&.,'-]*(?:\s+[A-Z][\w&.,'-]*){0,4})\s*(?:[|–—-]|,)\s*(?:[A-Z]|\d{4})/.exec(line);
    if (m) add(m[1]);
  }
  return out;
}

// Which company is the question about? Prefer the job we are applying to, because the question is
// nearly always "have you worked HERE"; otherwise take the name after at/for/by/with.
function companyInQuestion(question, ctx = {}) {
  const q = String(question || '');
  const named = String((ctx.job && (ctx.job.company || ctx.job.employer)) || '').trim();
  if (named) {
    const firstWord = named.split(/\s+/)[0];
    if (firstWord.length > 2 && new RegExp('\\b' + escapeRx(firstWord) + '\\b', 'i').test(q)) return named;
  }
  // "of" belongs here. Without it "Are you a former employee OF Legacy Delta Technologies?" yielded
  // no company at all, and the rule then answered a confident "No" about a company he really worked
  // for — the single worst outcome this module can produce. Caught by its own test.
  const m = /\b(?:at|for|by|with|of|from)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/.exec(q);
  if (m) return m[1].trim();
  return named;
}

// null  = not this kind of question, or we must not answer it
// {...} = a grounded answer
function answerPriorEmployment(question, ctx = {}) {
  const q = String(question || '');
  if (!q.trim() || !PRIOR_EMPLOYMENT_RX.test(q)) return null;

  const company = companyInQuestion(q, ctx);
  const known = knownEmployers(ctx.profile, ctx.resume);
  const lc = String(company || '').toLowerCase();

  // Names somewhere he HAS worked: not a question the floor may answer.
  if (lc) {
    for (const e of known) {
      if (e.includes(lc) || lc.includes(e)) return null;
    }
  }
  return { answer: 'No', confidence: 0.95, source: 'deterministic:prior-employment' };
}

module.exports = { answerPriorEmployment, knownEmployers, companyInQuestion, PRIOR_EMPLOYMENT_RX };
