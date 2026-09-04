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
const fit = require('../../fit');

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

// One wording for a duplicate wherever it was found, so a hit on another machine reads exactly as
// seriously as a hit on this one.
function sayDuplicate(dup, where) {
  return `DUPLICATE — already engaged on ${where}: ${dup.company} / ${dup.title} [${dup.status}]`
    + `, matched on ${dup.matchedOn}${dup.slug ? ` "${dup.slug}"` : ''}`
    + `${dup.sameRole ? ' (the same role)' : ` (${dup.count} row(s) for this employer)`}`
    + '. Do not apply again. Pick a different employer.';
}

// Ask every peer node the same question this machine just asked itself. A node that errors is
// reported, never silently treated as "nothing there".
async function sweepPeers(peers, { url, company, title }) {
  const hits = [];
  const unreachable = [];
  let list = [];
  try { list = (await peers.nodes()) || []; }
  catch (e) { return { hits, unreachable: [{ name: 'the other machines', why: e.message }] }; }

  // WHOSE LEDGER IS THAT?
  //
  // The node list is every machine this one can talk to, and they are not all the same person. The
  // laptop's list holds itself and DAD'S node. Asking Dad's machine whether PIERRE has applied
  // somewhere is not a duplicate check, it is a different question with the same shape, and both
  // ways of getting it wrong hurt: a false duplicate quietly stops him applying to a job Dad went
  // for, and a false all-clear is the double application this whole mechanism exists to prevent.
  //
  // So a node counts only when it is explicitly marked as the same applicant. Anything else is
  // left alone rather than guessed at, and `self` is dropped because asking this machine what this
  // machine already answered is pure latency.
  list = list.filter((n) => n && n.sameApplicant === true && !n.self);
  await Promise.all(list.map(async (node) => {
    try {
      const rows = await peers.engaged(node, { url, company, title });
      for (const r of rows || []) {
        const sameRole = norm(r.title) === norm(title);
        hits.push({
          node: node.name || node.id || 'another machine',
          company: r.company, title: r.title, status: r.status,
          matchedOn: r.matchedOn || 'company', slug: r.slug || null,
          sameRole, count: (rows || []).length,
        });
      }
    } catch (e) {
      unreachable.push({ name: node.name || node.id || 'a peer node', why: e.message });
    }
  }));
  // A hit on the exact same role is the one most worth showing him first.
  hits.sort((a, b) => Number(b.sameRole) - Number(a.sameRole));
  return { hits, unreachable };
}

function makeJatTools(opts = {}) {
  const {
    profileId = null,
    allowWrites = true,
    // Injected so this module never learns about HTTP, and so the peer sweep can be tested with no
    // network at all. Returns [{ name, engaged: [{company,title,status}] }] or throws per node.
    peers = null,
  } = opts;
  const pid = () => profileId || db.ensureDefaultProfileId();

  const tools = [
    {
      name: 'check_duplicate',
      description: 'BEFORE writing any documents, check whether this employer has already been applied to. Pass the posting url and company.',
      args: ['url', 'company', 'title'],
      run: async ({ url, company, title }) => {
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
        if (dup) return sayDuplicate(dup, 'this machine');

        // ASK THE OTHER MACHINES.
        //
        // Found the first time a real run went out from the server laptop: the laptop and the PC
        // keep separate ledgers and neither can see the other. Every one of the 56 applications
        // made by hand from the PC was invisible to the laptop, so `check_duplicate` would have
        // said "fresh" for employers Pierre had already applied to, and in one case interviewed
        // with. A duplicate application cannot be taken back.
        const remote = peers ? await sweepPeers(peers, { url, company, title }) : { hits: [], unreachable: [] };
        if (remote.hits.length) return sayDuplicate(remote.hits[0], remote.hits[0].node);

        // A PEER THAT DID NOT ANSWER IS NOT A CLEAN BILL OF HEALTH. Same rule as the no-key case
        // above: a check that could not run must never read as a green light.
        if (remote.unreachable.length) {
          return `NOT FULLY CHECKED — nothing found here (by ${via}${slug ? ` "${slug}"` : ''}), but `
            + `${remote.unreachable.map((u) => `${u.name} (${u.why})`).join(', ')} could not be reached. `
            + 'Applications made on that machine would not show up. Ask the human before applying, '
            + 'or pick an employer you can check.';
        }
        return `fresh — no engaged row for this employer on any machine `
          + `(checked by ${via}${slug ? ` "${slug}"` : ''})`;
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
      name: 'my_resume',
      // Reference, not an observation: the loop keeps this whole and keeps it in view. At the
      // ordinary 1,200-character observation clip his 4,749-character résumé stopped mid skills
      // list, so the agent wrote one with no Experience and no Education section.
      reference: true,
      // THE SOURCE MATERIAL, WHICH WAS SITTING RIGHT THERE.
      //
      // Read what the agent actually produced on run 11 and the problem was obvious: a three line
      // resume saying "build and maintain full-stack web applications", because `my_profile` hands
      // over an identity and some learned screening answers and nothing else. His real resume, all
      // 4,717 characters of it with the ERP integration, the Tauri rebuild, the 479-case suite, was
      // already in the documents table being used by fit-score and nothing else.
      //
      // Tailoring needs something to tailor FROM. Without this the agent was not writing a weak
      // resume, it was writing the only resume the facts available to it could support.
      description: 'Read the candidate REAL resume on file. Do this BEFORE write_resume, every '
        + 'time. It is the only source of his work history, projects and achievements. Everything '
        + 'you put on a tailored resume must come from here or from my_profile. Choose what to '
        + 'lead with and how to word it for this posting. Invent nothing.',
      args: [],
      run: () => {
        let doc = null;
        try { doc = db.defaultDocument('resume'); } catch { /* reported below */ }
        if (!doc) {
          return 'NO RESUME ON FILE. Do not write one from the profile alone, it will be three lines '
            + 'of nothing. Use ask_human to say a resume needs uploading in Documents.';
        }
        let full = null;
        try { full = db.getDocument(doc.id, { withText: true }); } catch { /* reported below */ }
        const text = (full && full.textContent) || '';
        if (!text.trim()) {
          return `The resume on file (${doc.name}) has no extracted text, so there is nothing to `
            + 'work from. Use ask_human rather than writing from the profile alone.';
        }
        return `--- ${doc.name} ---
${text}`;
      },
    },
    {
      name: 'check_fit',
      // WHAT HE DOES NOT HAVE, NAMED.
      //
      // Pierre's rule has always been that if a posting needs something he lacks, say so plainly in
      // one clause or skip the job. The agent had no way to know: it read a posting, read his
      // résumé, and applied. The overnight run needed a human to catch a furniture manufacturer
      // whose "Product Engineer" turned out to be mechanical.
      //
      // The score is the least interesting part of this. `missing` is the point: the posting's own
      // vocabulary that appears nowhere in his history. It is a crude signal and it is named that
      // way on purpose, because the judgement belongs to the agent and not to a token count.
      description: 'Compare this posting against the candidate real history BEFORE writing anything. '
        + 'Pass the job title and the posting text. Returns what genuinely overlaps and what the '
        + 'posting asks for that he has no record of. Use it to decide whether to apply at all, and '
        + 'to keep the résumé honest. NEVER write a missing item onto the résumé.',
      args: ['title', 'description'],
      run: ({ title, description }) => {
        const text = String(description || '').trim();
        if (text.length < 80) return 'give me the posting text, not a summary of it';
        let resumeText = '';
        try {
          const doc = db.defaultDocument('resume');
          if (doc) resumeText = (db.getDocument(doc.id, { withText: true }) || {}).textContent || '';
        } catch { /* handled below */ }
        if (!resumeText.trim()) return 'NO RESUME ON FILE, so there is nothing to compare against. Use ask_human.';
        let profile = {};
        try { profile = (db.listProfiles() || []).find((p) => p.id === pid()) || {}; } catch { /* identity only */ }
        const r = fit.score({ title: String(title || ''), description: text }, profile, resumeText);
        // The scorer's tokens keep trailing punctuation and ordinary English, so the raw list reads
        // "hybrid., robots., under, both., ask" and buries the one word that matters. Cleaned HERE
        // rather than in fit.js, because that scorer also drives job ranking and this is a
        // presentation problem, not a scoring one.
        const NOISE = new Set(('the a an and or of to in on for with at by from as is are be will you your we our '
          + 'this that these those it its they them their has have had do does did can could should would may might '
          + 'about into over under both ask asks asked include includes including such via per across within also '
          + 'more most other others any all each every some no not new work works working role position job team '
          + 'years year experience professional bonus plus strong good great excellent required require requires '
          + 'responsibilities responsibility skills skill ability able seeking looking candidate candidates').split(' '));
        const clean = (list) => (list || [])
          // Trailing dots go, internal ones stay, so "node.js" and "c#" survive but "robots." does not.
          .map((t) => String(t).replace(/[^a-z0-9+#.]+$/i, '').replace(/\.+$/, '').replace(/^[^a-z0-9]+/i, ''))
          .filter((t) => t.length > 1 && !NOISE.has(t.toLowerCase()))
          .filter((t, i, a) => a.indexOf(t) === i);
        const missing = clean(r.missing).slice(0, 14);
        const matched = clean(r.matched).slice(0, 14);
        return `overlap score ${r.score}/100 (a crude token overlap, not a verdict)
`
          + `  he has a record of: ${matched.join(', ') || '(nothing recognisable)'}
`
          + `  the posting mentions, with no match in his history: ${missing.join(', ') || '(nothing)'}
`
          + 'Judge it yourself. A low score on a role he can plainly do is fine. If the posting '
          + 'requires something in that second list, say so in one clause or pick a different job. '
          + 'Do NOT put anything from that list on the résumé.';
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

module.exports = { makeJatTools, employerKey, duplicateOf, engagedIndex, sweepPeers, ENGAGED };
