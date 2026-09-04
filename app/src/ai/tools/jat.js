'use strict';
// ============================================================================
//  JAT v11 — ledger tools (AI Apply chunk 5)
//
//  What the agent may know and record about Pierre's own job search: what he has already applied
//  to, who he is, what he has answered before, and — once an application is genuinely sent — the
//  fact that it happened.
//
//  THE DEDUPE RULE IS THE POINT OF THIS FILE
//  Overnight, `Jobber` surfaced as a fresh lead AFTER it had already been hand-applied to, because
//  the check matched on COMPANY NAME and the scraper stores names decorated, translated, or simply
//  wrong ("autotradercanada", "1105 DXC Insurance Ser", "Cheil India" for a Mississauga role).
//  Keying on the ATS BOARD SLUG in the URL fixed it: measured against the live ledger, the slug
//  caught 21 employers the name check missed entirely. db.atsCompanyFromUrl already extracts that
//  slug and already blocklists generic tokens like `jobs`/`careers`/`apply`, so this reuses it
//  rather than shipping a second, drifting copy of the same regex.
//
//  AND EVERY TERMINAL STATUS COUNTS AS "APPLIED"
//  The other half of the same bug: the original check only excluded status === 'applied', so a row
//  sitting at `submitted`, `rejected` or `ghosted` read as untouched. Applying again to a company
//  that already rejected him is worse than not applying.
//
//  log_application IS THE ONLY WRITE, and it refuses a duplicate rather than asking nicely.
// ============================================================================

const db = require('../../db');

let log = { info() {}, warn() {}, error() {} };
try { log = require('../../logger').scope('ai:tools:jat'); } catch { /* usable outside the app */ }

// A row in any of these states means "we have already engaged this employer".
const ENGAGED = new Set([
  'applied', 'submitted', 'contacted', 'assessment',
  'interview_1', 'interview_2', 'interview_final',
  'offer', 'hired', 'rejected', 'withdrawn', 'ghosted',
]);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Vendors whose URL puts the EMPLOYER in the subdomain. Taking the registrable domain here gives
// the vendor instead, which is far worse than getting nothing: every Cornerstone employer would
// collapse to the single identity "csod", so after applying to ONE of them every other Cornerstone
// company would read as a duplicate and be silently skipped. Found by the first end-to-end run.
const VENDOR_SUBDOMAIN_HOSTS = /\.(csod|myworkdayjobs|applytojob|bamboohr|recruitee|breezy|workable|jazzhr|smartrecruiters|paylocity|dayforcehcm)\.(com|co\.uk|ca)$/i;
// Vendor names that must never be used as an employer identity, however they were derived.
const VENDOR_WORDS = new Set([
  'csod', 'cornerstone', 'myworkdayjobs', 'workday', 'greenhouse', 'lever', 'ashbyhq', 'ashby',
  'applytojob', 'bamboohr', 'recruitee', 'breezy', 'workable', 'jazzhr', 'smartrecruiters',
  'taleo', 'icims', 'successfactors', 'paylocity', 'dayforcehcm', 'linkedin', 'indeed',
  'jobs', 'careers', 'apply', 'job', 'boards', 'embed',
]);

// The stable identity of an employer: the ATS board slug, falling back to the company name only
// when the URL carries no slug at all (a plain careers page, say).
function employerKey({ url, company } = {}) {
  const raw = String(url || '');

  // Greenhouse's EMBED form carries the board in a query parameter, which db.atsCompanyFromUrl
  // does not read — and it is the form actually used for D2L, Coinbase and Knak by hand, and the
  // one the agent reaches for. Without this the check silently degrades to matching on company
  // NAME, which is exactly the failure that surfaced Jobber twice.
  const embed = /[?&]for=([A-Za-z0-9_-]+)/.exec(raw);
  if (embed && !VENDOR_WORDS.has(norm(embed[1]))) {
    return { key: norm(embed[1]), via: 'slug', slug: embed[1] };
  }

  // Employer-in-the-subdomain vendors.
  let host = '';
  try { host = new URL(raw).hostname.replace(/^www\./i, ''); } catch { /* not a URL */ }
  if (host && VENDOR_SUBDOMAIN_HOSTS.test(host)) {
    const sub = host.split('.')[0];
    if (sub && !VENDOR_WORDS.has(norm(sub))) return { key: norm(sub), via: 'slug', slug: sub };
  }

  const slug = db.atsCompanyFromUrl(raw);
  if (slug && !VENDOR_WORDS.has(norm(slug))) return { key: norm(slug), via: 'slug', slug };

  const c = norm(company);
  return c ? { key: c, via: 'name', slug: null } : { key: '', via: 'none', slug: null };
}

// Everything already engaged, indexed by employer key. Built once per call: the ledger is a few
// thousand rows and this runs a handful of times per application, not per step.
function engagedIndex() {
  const map = new Map();
  for (const j of db.listJobs({ limit: 5000 })) {
    const tags = Array.isArray(j.tags) ? j.tags : [];
    const engaged = ENGAGED.has(j.status) || tags.includes('hand-applied') || tags.includes('BLOCKED-ON-PIERRE');
    if (!engaged) continue;
    for (const k of [employerKey({ url: j.jobUrl, company: j.company }).key, norm(j.company)]) {
      if (!k) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(j);
    }
  }
  return map;
}

function duplicateOf({ url, company, title } = {}) {
  const { key, via, slug } = employerKey({ url, company });
  if (!key) return null;
  const idx = engagedIndex();
  const hits = idx.get(key);
  if (!hits || !hits.length) return null;
  const sameRole = hits.find((h) => norm(h.title) === norm(title));
  return {
    matchedOn: via, slug,
    company: (sameRole || hits[0]).company,
    title: (sameRole || hits[0]).title,
    status: (sameRole || hits[0]).status,
    sameRole: !!sameRole,
    count: hits.length,
  };
}

const line = (j) => `${j.company || '?'} — ${j.title || '?'} [${j.status}] ${j.location || ''}`.trim();

function makeJatTools(opts = {}) {
  const { profileId = null, allowWrites = true } = opts;
  const pid = () => profileId || db.ensureDefaultProfileId();

  const tools = [
    {
      name: 'check_duplicate',
      description: 'BEFORE writing any documents, check whether this employer has already been applied to. Pass the posting url and company.',
      args: ['url', 'company', 'title'],
      run: ({ url, company, title }) => {
        const { via, slug } = employerKey({ url, company });
        // A CHECK THAT COULD NOT RUN IS NOT A PASS. With neither a board slug nor a company name
        // there is nothing to compare, and the old wording ("fresh — checked by none") read as a
        // green light. Seen on the first end-to-end run: the agent called this before navigating,
        // got "fresh", and would have carried on with no duplicate protection at all.
        if (via === 'none') {
          return 'CANNOT CHECK — no company name and no board slug in that url, so nothing was compared. '
            + 'Open the posting first, then call this again with the employer name and the real posting url.';
        }
        const dup = duplicateOf({ url, company, title });
        if (!dup) {
          return `fresh — no engaged row for this employer (checked by ${via}${slug ? ` "${slug}"` : ''})`;
        }
        return `DUPLICATE — already engaged: ${dup.company} / ${dup.title} [${dup.status}]`
          + `, matched on ${dup.matchedOn}${dup.slug ? ` "${dup.slug}"` : ''}`
          + `${dup.sameRole ? ' (the same role)' : ` (${dup.count} row(s) for this employer)`}`
          + '. Do not apply again. Pick a different employer.';
      },
    },
    {
      name: 'search_ledger',
      description: 'Search the job ledger by company, title or keyword. Use it to see history before deciding anything.',
      args: ['query', 'limit'],
      run: ({ query, limit }) => {
        const n = Math.max(1, Math.min(25, Number(limit) || 10));
        const rows = db.listJobs({ q: String(query || ''), limit: n });
        if (!rows.length) return `no ledger rows match "${query}"`;
        return rows.map(line).join('\n');
      },
    },
    {
      name: 'my_profile',
      description: 'Read the facts about the candidate: name, contact, work authorization and other stored profile fields.',
      args: [],
      run: () => {
        // THE STRUCTURED PROFILE FIRST. Name, email, phone, city and work authorization live in
        // profiles.data, NOT in the learned-answer table. Reading only the latter meant the agent
        // could not see who it was applying as: on the first end-to-end run it got a list of
        // "how many years of WordPress" rows, correctly refused to invent an identity, and parked
        // an application whose answers were sitting in the database the whole time.
        const identity = [];
        try {
          const row = (db.listProfiles() || []).find((p) => p.id === pid()) || {};
          const data = typeof row.data === 'string' ? JSON.parse(row.data || '{}') : (row.data || {});
          const LABELS = {
            fullName: 'Full name', firstName: 'First name', lastName: 'Last name',
            email: 'Email', phone: 'Phone', address1: 'Address', city: 'City',
            state: 'Province or state', postalCode: 'Postal code', country: 'Country',
            linkedinUrl: 'LinkedIn', githubUrl: 'GitHub', portfolioUrl: 'Website',
            workAuthorization: 'Work authorization', requireSponsorship: 'Needs sponsorship',
            authorizedToWorkInCanada: 'Authorized to work in Canada',
            salaryExpectation: 'Salary expectation', yearsExperience: 'Years of experience',
            university: 'University', major: 'Field of study', headline: 'Headline',
          };
          for (const [k, label] of Object.entries(LABELS)) {
            const v = data[k];
            if (v !== undefined && v !== null && String(v).trim() !== '') identity.push(`${label}: ${v}`);
          }
        } catch { /* fall through to the learned fields below */ }

        const fields = db.profileFieldList(pid()) || [];
        if (!identity.length && !fields.length) return 'the profile is empty — ask the human rather than inventing anything';
        // FILTER THE JUNK OUT BEFORE THE MODEL SEES IT. On the first end-to-end run this returned
        // rows like "search search: 0" and "radio group rd: on" straight from the poisoned bank,
        // which is noise the agent then has to reason around — and it reasoned badly, quitting on
        // an imagined tool outage. The audit already knows which rows are not answers.
        const audit = require('../../answer-audit');
        const usable = [];
        let dropped = 0;
        for (const f of fields) {
          if (!f.label || !f.value) continue;
          const v = audit.auditAnswer({ question: f.label, answer: f.value });
          if (v.severity === 'junk') { dropped++; continue; }
          usable.push(`${f.label}: ${f.value}`);
        }
        if (!identity.length && !usable.length) {
          return 'every stored profile field looks like junk — ask the human rather than inventing anything';
        }
        const parts = [];
        if (identity.length) parts.push(`WHO THIS IS:\n${identity.join('\n')}`);
        if (usable.length) parts.push(`ALSO KNOWN:\n${usable.join('\n').slice(0, 1800)}`);
        const note = dropped ? `\n(${dropped} stored field(s) were ignored because they are not real answers)` : '';
        return parts.join('\n\n') + note;
      },
    },
    {
      name: 'recall_answer',
      description: 'Look up how this candidate answered a screening question before. Returns nothing if it has never been answered. In that case ask the human, never guess.',
      args: ['question'],
      run: ({ question }) => {
        const q = String(question || '').trim();
        if (!q) return 'ask with an actual question';
        const hit = db.qaLookup(pid(), q);
        if (!hit) return `NOT ANSWERED BEFORE — "${q}". Do not invent an answer. Escalate to the human.`;

        // ALWAYS show which question the answer actually came from. A fuzzy hit scoring 1.00 looks
        // authoritative and is frequently a different question: on the live bank, "Are you legally
        // authorized to work in Canada?" recalled a stored "No" that belongs to a US-scoped
        // sponsorship question. Answering that on a Canadian application would disqualify him.
        // The model cannot notice a mismatch it is never shown.
        const exact = hit.match === 'exact';
        const head = exact
          ? 'previous answer to THIS question'
          : `NOT the same question — closest stored match (${hit.match}, ${Number(hit.score).toFixed(2)})`;
        const body = `\n  stored question: "${String(hit.question).slice(0, 200)}"\n  stored answer:   "${String(hit.answer).slice(0, 300)}"`;
        const advice = exact ? '' :
          '\n  TREAT THIS AS A HINT, NOT A FACT. If it does not clearly answer the question actually being '
          + 'asked — especially anything about work authorization, sponsorship, citizenship or salary — '
          + 'escalate to the human instead of using it.';
        return head + body + advice;
      },
    },
    {
      name: 'log_application',
      description: 'Record an application AFTER it has actually been submitted and confirmed. Refuses duplicates.',
      args: ['company', 'title', 'url', 'location', 'notes'],
      // The write guard: a duplicate must be impossible, not merely discouraged.
      guard: ({ company, title, url }) => {
        if (!allowWrites) return 'refused: this run may not write to the ledger';
        if (!company || !title) return 'refused: an application needs at least a company and a title';
        const dup = duplicateOf({ url, company, title });
        if (dup) {
          return `refused: ${dup.company} / ${dup.title} is already [${dup.status}] `
            + `(matched on ${dup.matchedOn}${dup.slug ? ` "${dup.slug}"` : ''}) — never apply to one employer twice`;
        }
        return null;
      },
      run: ({ company, title, url, location, notes }) => {
        // 'submitted' — NOT 'applied'. There is no `applied` status in this app, and upsertJob
        // silently coerces an unknown one to 'started' rather than failing. That is exactly how 20
        // of the 56 applications sent by hand on 2026-09-03 were recorded as never sent: the write
        // "succeeded" every time and nobody read the row back. Hence the readback below.
        const ats = db.classifyAts ? db.classifyAts(url || '') : null;
        const res = db.upsertJob({
          company: String(company), title: String(title),
          jobUrl: url ? String(url) : null,
          location: location ? String(location) : null,
          status: 'submitted',
          submittedAt: new Date().toISOString(),
          source: (ats && ats.ats) || 'ai-apply',
          notes: notes ? String(notes).slice(0, 4000) : null,
          tags: ['AI-APPLY', 'hand-applied', new Date().toISOString().slice(0, 10)],
        }, { source: 'manual', manual: true });

        const job = (res && res.job) || res;
        const jobId = job && job.id;
        if (!jobId) throw new Error('the ledger write returned no row — the application was NOT recorded');
        // Read it back. A write that reports success and stores something else is the failure this
        // whole tool exists to prevent.
        const saved = db.getJob(jobId);
        if (!saved || saved.status !== 'submitted') {
          throw new Error(`the ledger stored status "${saved && saved.status}" instead of submitted — NOT recorded correctly`);
        }
        log.info(`logged application ${company} / ${title} (${jobId})`);
        return `logged ${company} / ${title} as submitted (${jobId}), verified by read-back`;
      },
    },
  ];

  return { tools, duplicateOf, employerKey };
}

module.exports = { makeJatTools, employerKey, duplicateOf, engagedIndex, ENGAGED };
