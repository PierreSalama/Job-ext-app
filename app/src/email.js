// JAT v11 — email integration.
// Connect a mailbox over IMAP with an App Password (the baby-simple, universal path:
// works for Gmail / Outlook / Yahoo / any IMAP host), sync it incrementally + resumably,
// classify each message, and associate it to the right job (company + time-window +
// title). Pure-JS deps only (imapflow, mailparser) — no native build risk.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const db = require('./db');
const { scope } = require('./logger');
const log = scope('email');

// ---------- provider presets + the hand-holding setup steps ----------
const PRESETS = {
  gmail: {
    label: 'Gmail', host: 'imap.gmail.com', port: 993, secure: true,
    appPwUrl: 'https://myaccount.google.com/apppasswords',
    steps: [
      { t: 'Turn ON 2-Step Verification — App Passwords don’t exist without it.', url: 'https://myaccount.google.com/signinoptions/two-step-verification' },
      { t: 'Open Google App Passwords (sign in if asked).', url: 'https://myaccount.google.com/apppasswords' },
      { t: 'Type a name like “JAT” and press Create.' },
      { t: 'Google shows a 16-character password — copy it (the spaces don’t matter).' },
      { t: 'Paste it in the App Password box below with your Gmail address, then click Test.' },
    ],
  },
  outlook: {
    label: 'Outlook / Hotmail', host: 'outlook.office365.com', port: 993, secure: true,
    appPwUrl: 'https://account.microsoft.com/security',
    steps: [
      { t: 'Open Microsoft account security and turn on Two-step verification.', url: 'https://account.microsoft.com/security' },
      { t: 'Go to “Advanced security options” → “App passwords” → “Create a new app password”.' },
      { t: 'Copy the password it generates.' },
      { t: 'Paste it below with your Outlook/Hotmail address, then click Test.' },
    ],
  },
  yahoo: {
    label: 'Yahoo Mail', host: 'imap.mail.yahoo.com', port: 993, secure: true,
    appPwUrl: 'https://login.yahoo.com/account/security',
    steps: [
      { t: 'Open Yahoo Account Security.', url: 'https://login.yahoo.com/account/security' },
      { t: 'Turn on 2-step verification, then choose “Generate app password” / “Manage app passwords”.' },
      { t: 'Pick “Other app”, name it JAT, and Generate.' },
      { t: 'Copy the password, paste it below with your Yahoo address, then click Test.' },
    ],
  },
  imap: {
    label: 'Other (IMAP)', host: '', port: 993, secure: true, appPwUrl: '',
    steps: [
      { t: 'Find your provider’s IMAP server + port (usually port 993, SSL).' },
      { t: 'If your provider requires it, generate an app-specific password.' },
      { t: 'Enter the host/port + your email + password below, then click Test.' },
    ],
  },
};
function presetsPublic() {
  return Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, { label: v.label, host: v.host, port: v.port, secure: v.secure, appPwUrl: v.appPwUrl, steps: v.steps }]));
}

// ---------- accounts (kv-backed; the password never leaves the server) ----------
function listAccounts() { return db.kvGet('emailAccounts') || []; }
function saveAccounts(list) { db.kvSet('emailAccounts', list); }
function publicAccount(a) { const { password, ...rest } = a; return { ...rest, hasPassword: !!password }; }
function getAccount(id) { return listAccounts().find((a) => a.id === id) || null; }
function addAccount({ provider, email, password, host, port, secure }) {
  const p = PRESETS[provider] || PRESETS.imap;
  const acct = {
    id: 'mail_' + Math.random().toString(36).slice(2, 10),
    provider: provider || 'imap', email: String(email || '').trim(), password: password || '',
    host: host || p.host, port: Number(port) || p.port || 993, secure: secure !== false,
    enabled: true, addedAt: new Date().toISOString(),
  };
  const list = listAccounts(); list.push(acct); saveAccounts(list);
  return acct;
}
function removeAccount(id) { saveAccounts(listAccounts().filter((a) => a.id !== id)); }
function setEnabled(id, enabled) { const l = listAccounts(); const a = l.find((x) => x.id === id); if (a) { a.enabled = !!enabled; saveAccounts(l); } return a; }

// ---------- connection ----------
function clientFor(a) {
  return new ImapFlow({
    host: a.host, port: a.port || 993, secure: a.secure !== false,
    auth: { user: a.email, pass: a.password }, logger: false, emitLogs: false,
  });
}
function humanizeImapError(e) {
  const m = String(e?.message || e);
  if (/auth|credential|login|invalid|AUTHENTICATIONFAILED/i.test(m)) return 'Login failed — use the 16-character App Password (NOT your normal password), and make sure 2-Step Verification + IMAP are on.';
  if (/timeout|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|getaddrinfo/i.test(m)) return 'Couldn’t reach the mail server — check the host/port and your connection.';
  return m.slice(0, 200);
}
async function testConnection(a) {
  const client = clientFor(a);
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    const total = client.mailbox && client.mailbox.exists || 0;
    lock.release();
    await client.logout();
    return { ok: true, total };
  } catch (e) {
    try { await client.logout(); } catch {}
    return { ok: false, error: humanizeImapError(e) };
  }
}

// ---------- classify (category for the UI) ----------
const CATEGORY_RX = [
  ['offer', /job offer|offer letter|pleased to offer|like to offer|offer(?:ing)? you (?:the |a |this )?(?:role|position|job|opportunity)|extend(?:ing)? an offer|congratulations[^.]*offer/i],
  ['rejection', /unfortunately|we regret|not (?:moving|move) forward|decided (?:not to|to not)|other candidates|will not be proceeding|position (?:has been|is) filled|no longer under consideration/i],
  // Checked BEFORE interview so a coding challenge / take-home / online test is its OWN stage
  // ('assessment') rather than being lumped into 'interview' — the user wants this surfaced.
  ['assessment', /online assessment|coding (?:challenge|assessment|test|exercise)|take[- ]?home|hackerrank|codility|codesignal|\bkattis\b|technical (?:assessment|test|exercise)|complete (?:the |a |an )?(?:assessment|test|challenge|exercise)|skills?(?: |-)?(?:test|assessment)|aptitude test/i],
  ['interview', /interview|schedule (?:a |your )?(?:call|chat|meeting|time)|your availability|phone screen|technical screen|next (?:round|step|stage)|hiring manager|meet (?:the|our) team/i],
  ['application_confirmation', /thank you for applying|application (?:was |has been )?(?:received|submitted|sent)|we(?:'| ha)ve received your application|successfully applied|application (?:confirmation|received)|your application to/i],
  ['recruiter', /recruiter|talent (?:team|acquisition|partner)|sourcer|reaching out|came across your (?:profile|background)|opportunity (?:at|with)|interested in your/i],
];
function classify(subject, body) {
  const t = `${subject || ''}\n${(body || '').slice(0, 2500)}`.toLowerCase();
  for (const [cat, rx] of CATEGORY_RX) if (rx.test(t)) return cat;
  return 'other';
}

// classifyEmailReward — map an email's category (or, if not supplied, its subject/body) to a
// reward SIGN for the north-star loop (P6). This is the only place the category→reward
// policy lives, so credit assignment in db.js stays mechanical.
//   interview / assessment / phone-screen invite / OFFER → POSITIVE reward (the signal we
//      optimize for); offers weigh more than a first interview.
//   acknowledgement / "application received"            → small positive (it went through).
//   rejection / "moved forward with other candidates"    → MILD-NEGATIVE (FIT only — see
//      recordOutcome: this never docks recipe/answer mechanical credit, only ranks fit).
//   recruiter outreach                                   → neutral (0) — cold inbound, no
//      application outcome to credit yet.
// Returns { kind, reward } where reward is the *base* (pre confidence-weight, pre clip).
function classifyEmailReward(categoryOrSubject, body) {
  // Accept either an already-classified category or a raw (subject[, body]) pair.
  const KNOWN = new Set(['offer', 'rejection', 'interview', 'assessment', 'application_confirmation', 'recruiter', 'other']);
  const cat = KNOWN.has(categoryOrSubject) ? categoryOrSubject : classify(categoryOrSubject, body);
  switch (cat) {
    case 'offer':                   return { kind: 'email_reply', reward: 1.0 };
    case 'interview':               return { kind: 'email_reply', reward: 0.7 };
    case 'assessment':              return { kind: 'email_reply', reward: 0.5 };
    case 'application_confirmation': return { kind: 'email_reply', reward: 0.1 };
    case 'rejection':               return { kind: 'rejection', reward: -0.3 };
    case 'recruiter':               return { kind: 'neutral', reward: 0 };
    default:                        return { kind: 'neutral', reward: 0 };
  }
}

// ---------- association: which job does this email belong to? ----------
// Sender domains that DON'T identify the company (job boards / ATS / generic mailers).
const NON_COMPANY_DOMAIN = /(greenhouse|lever|workday|myworkday|icims|smartrecruiters|ashby|jobvite|taleo|successfactors|bamboohr|recruitee|workable|breezy|linkedin|indeed|ziprecruiter|glassdoor|gmail|outlook|hotmail|yahoo|googlemail|sendgrid|mailgun|amazonses|notification|noreply|no-reply)/i;
// Known ATS mail systems — a sender from one of these is highly likely to be a recruiting
// email *about an application* even though the domain isn't the company itself. We use this
// as a distinct signal: an ATS sender + a company hint that resolves a recently-applied job
// is a strong "this answers an application" signal (P6 sender-domain signal).
const ATS_SENDER_DOMAIN = /(greenhouse\.io|grnh\.se|lever\.co|hire\.lever\.co|myworkday(?:jobs)?\.com|workday\.com|ashbyhq\.com|icims\.com|smartrecruiters\.com|smartrecruiters\.io|jobvite\.com|successfactors\.(?:com|eu)|taleo\.net|bamboohr\.com|recruitee\.com|workable\.com|breezy\.hr)/i;
function senderDomain(from) { return (String(from || '').split('@')[1] || '').toLowerCase(); }
// Free webmail — matched as a whole domain LABEL (so "acme.com" isn't read as "me.com").
const FREE_MAIL = /(?:^|\.)(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|aol|proton|protonmail|gmx)\./i;
function companyHints({ from, fromName, subject }) {
  const hints = new Set();
  const domain = (String(from || '').split('@')[1] || '').toLowerCase();
  const isFree = FREE_MAIL.test(domain);
  // A real company domain → the domain root + the sender name are good company hints.
  if (domain && !NON_COMPANY_DOMAIN.test(domain) && !isFree) {
    const root = domain.split('.').slice(-2, -1)[0];
    if (root && root.length > 1) hints.add(root);
    if (fromName) hints.add(String(fromName).toLowerCase());
  }
  // The subject often names the company even for ATS / free-mail senders.
  const s = String(subject || '');
  const m = s.match(/(?:applying to|application (?:to|for|at)|apply(?:ing)? (?:to|at)|interview (?:with|at)|join|from)\s+([A-Za-z][\w&.'\- ]{1,40})/i)
    || s.match(/^([A-Za-z][\w&.'\- ]{1,40})\s*[-—:|]/);
  if (m) {
    const cand = m[1].trim().replace(/\b(received|confirmation|application|applications|update|team|careers|recruiting|recruitment|talent|hiring|inc|llc|ltd|corp|co)\b.*$/i, '').trim();
    if (cand.length > 1) hints.add(cand.toLowerCase());
  }
  return [...hints].map((h) => db.normKey(h)).filter((h) => h && h.length > 1);
}
function matchEmailToJob(email, jobs) {
  const category = classify(email.subject, email.body);
  // THREAD-FIRST ("trace the reply back to the original submission"): if this message continues a
  // conversation we already linked — same provider thread, or it replies to a Message-ID we
  // matched — inherit that job with high confidence, EVEN IF the sender/subject no longer name the
  // company or role (a recruiter replying from a personal address, a bare "Re: your application").
  try {
    const t = db.findJobByThread({ threadId: email.threadId, inReplyTo: email.inReplyTo, references: email.references });
    if (t && t.jobId) return { matchedJobId: t.jobId, matchConfidence: 0.95, matchSource: 'auto', category, via: t.via };
  } catch {}
  const fallback = { matchedJobId: null, matchConfidence: 0, matchSource: null, category };
  const hints = companyHints(email);
  if (!hints.length) return fallback;
  const sentMs = Date.parse(email.sentAt) || Date.now();
  let cands = jobs.filter((j) => { const ck = db.normKey(j.company || ''); return ck && hints.some((h) => ck.includes(h) || h.includes(ck)); });
  if (!cands.length) return fallback;
  const tkOf = (j) => db.normKey(j.title || '');
  const subjKey = db.normKey(email.subject || '');
  const bodyKey = db.normKey((email.body || '').slice(0, 1500));
  // SENDER-DOMAIN ↔ COMPANY-DOMAIN signal (P6). The from-address domain is parsed once;
  // a job earns a boost when (a) the sender is a known ATS mail system (greenhouse/workday/
  // lever/ashby/icims/smartrecruiters/…) — recruiting mail about an application — or (b) the
  // sender's own domain root matches that job's company name (the company emailed directly).
  const domain = senderDomain(email.from);
  const isAtsSender = !!domain && ATS_SENDER_DOMAIN.test(domain);
  const domainRoot = db.normKey(domain.split('.').slice(-2, -1)[0] || '');
  const score = (j) => {
    const applied = Date.parse(j.submittedAt || j.createdAt) || 0;
    const dt = sentMs - applied;                       // email AFTER apply = positive
    if (dt < -2 * 86400e3) return -1;                  // email well before the apply → not it
    const days = Math.abs(dt) / 86400e3;
    let s = 1 - Math.min(days, 120) / 120;             // closer in time → higher
    const tk = tkOf(j);
    if (tk && (subjKey.includes(tk) || bodyKey.includes(tk))) s += 0.35;   // title appears → strong
    const ck = db.normKey(j.company || '');
    // sender-domain boost: company's own domain matching its name is the strongest single
    // signal; a generic ATS sender (no company domain) is a solid secondary one.
    if (domainRoot && ck && (ck.includes(domainRoot) || domainRoot.includes(ck))) s += 0.3;
    else if (isAtsSender) s += 0.18;
    return s;
  };
  cands = cands.map((j) => ({ j, s: score(j) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s);
  if (!cands.length) return fallback;
  const best = cands[0], second = cands[1];
  const clear = !second || (best.s - second.s) > 0.25;   // one obvious winner among same-company jobs
  if (best.s >= 0.6 && clear) return { matchedJobId: best.j.id, matchConfidence: Number(Math.min(0.96, 0.7 + best.s * 0.25).toFixed(2)), matchSource: 'auto', category };
  return { matchedJobId: best.j.id, matchConfidence: Number(Math.min(0.69, 0.4 + best.s * 0.3).toFixed(2)), matchSource: 'suggested', category };
}

// ---------- parse one fetched message ----------
async function parseMessage(msg) {
  const env = msg.envelope || {};
  let body = '', inReplyTo = null, references = null, parsedMsgId = null;
  try {
    if (msg.source) {
      const p = await simpleParser(msg.source);
      body = String(p.text || p.html || '');
      // RFC 5322 reply chain — the headers that let us trace a reply back to its thread even when
      // the body/sender no longer name the company. references can be a string or an array.
      inReplyTo = p.inReplyTo || null;
      references = Array.isArray(p.references) ? p.references.join(' ') : (p.references || null);
      parsedMsgId = p.messageId || null;
    }
  } catch {}
  const fromObj = (env.from && env.from[0]) || {};
  let sentAt;
  try { const d = env.date || msg.internalDate; sentAt = (d instanceof Date ? d : new Date(d)).toISOString(); } catch { sentAt = new Date().toISOString(); }
  return {
    messageId: parsedMsgId || env.messageId || null,
    inReplyTo, references, threadId: null,   // IMAP has no Gmail thread id; the reply headers carry the chain
    from: fromObj.address || '', fromName: fromObj.name || '',
    to: (env.to && env.to[0] && env.to[0].address) || '',
    subject: env.subject || '(no subject)',
    snippet: body.replace(/\s+/g, ' ').trim().slice(0, 220),
    body: body.slice(0, 8000),
    sentAt,
  };
}

// ---------- sync one account (incremental + resumable by IMAP UID) ----------
async function syncAccount(a, { firstRunMax = 150, perRunMax = 400 } = {}) {
  const res = { account: a.id, email: a.email, fetched: 0, created: 0, matched: 0, suggested: 0, error: null };
  if (!a.password) { res.error = 'not connected (no app password)'; return res; }
  const client = clientFor(a);
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const cursor = db.emailCursor(a.id);
      let lastUid = cursor.uid || 0;
      // IMAP UIDs are only stable while UIDVALIDITY is unchanged (RFC 3501). If the
      // server reset it (mailbox migration/recreation), old UIDs are meaningless and
      // could be LOWER than our cursor → we'd skip all new mail forever. Detect the
      // change and re-seed from scratch (emailUpsert dedups + keeps manual matches).
      const uidValidity = (client.mailbox && client.mailbox.uidValidity != null) ? String(client.mailbox.uidValidity) : null;
      if (cursor.uidValidity && uidValidity && cursor.uidValidity !== uidValidity) {
        log.warn('UIDVALIDITY changed for', a.email, '— re-seeding from the newest messages');
        lastUid = 0;
      }
      const jobs = db.jobsForMatching();
      let uids = [];
      try {
        if (lastUid > 0) uids = await client.search({ uid: `${lastUid + 1}:*` }, { uid: true }) || [];
        else uids = (await client.search({ all: true }, { uid: true }) || []).slice(-firstRunMax);
      } catch (e) { uids = []; }
      uids = uids.filter((u) => u > lastUid).slice(0, perRunMax);
      for (const uid of uids) {
        let msg = null;
        try { msg = await client.fetchOne(uid, { uid: true, envelope: true, internalDate: true, source: true }, { uid: true }); } catch { continue; }
        if (!msg) continue;
        res.fetched++;
        const parsed = await parseMessage(msg);
        const assoc = matchEmailToJob(parsed, jobs);
        const up = db.emailUpsert({ accountId: a.id, provider: a.provider, uid, ...parsed, ...assoc });
        if (up.action === 'created') res.created++;
        if (assoc.matchSource === 'auto') res.matched++; else if (assoc.matchSource === 'suggested') res.suggested++;
        // North-star reward (P6): an auto-linked email releases its credit immediately;
        // 'suggested' rewards are HELD until the user confirms the link. Guard so a bad row
        // never breaks the sync.
        if (assoc.matchSource === 'auto') { try { db.creditOutcomeForEmail(up.id); } catch (e) { log.warn('credit failed:', e.message); } }
        if (uid > lastUid) lastUid = uid;
      }
      db.setEmailCursor(a.id, { uid: lastUid, uidValidity, syncedAt: new Date().toISOString(), lastResult: { fetched: res.fetched, created: res.created } });
    } finally { lock.release(); }
    await client.logout();
  } catch (e) {
    res.error = humanizeImapError(e);
    try { await client.logout(); } catch {}
    log.warn('sync failed for', a.email, '—', res.error);
  }
  return res;
}

// ---------- AI disambiguation (used ONLY when deterministic matching is ambiguous) ----------
// `runFn` is injected for testability (defaults to the real provider chain). Returns
// { jobId, confidence } or null. The model may return -1 (none) — we never force a wrong link,
// and we require a healthy confidence before upgrading a 'suggested' guess to a confirmed match.
const AI_PICK_MIN_CONFIDENCE = 0.7;
async function aiPickJob(email, candidates, runFn) {
  if (!candidates || !candidates.length) return null;
  const run = runFn || (async (p) => require('./ai/provider').run(p));
  try {
    const prompts = require('./ai/prompts');
    const p = prompts.pickEmailJob({ email, candidates });
    const out = await run({ kind: p.kind, system: p.system, prompt: p.prompt, schema: p.schema });
    const j = (out && out.json) || out;
    if (!j || typeof j.index !== 'number' || j.index < 0 || j.index >= candidates.length) return null;
    if ((j.confidence ?? 0) < AI_PICK_MIN_CONFIDENCE) return null;
    return { jobId: candidates[j.index].id, confidence: j.confidence, reason: j.reason || '' };
  } catch { return null; }
}

// Bounded post-pass: after a deterministic sync, ask the AI to resolve a few of the AMBIGUOUS
// ('suggested') high-value emails (interview/offer/assessment) — capped so token use stays
// moderate. A confident pick upgrades the link to 'auto' + elevates the job stage; otherwise the
// email stays 'suggested' for one-click human confirm. The deterministic ladder + threading
// already handle the bulk, so this only breaks genuine ties.
const AI_DISAMBIGUATE_CAP = 6;
async function aiDisambiguateSuggested({ runFn } = {}) {
  let upgraded = 0;
  let suggested = [];
  try { suggested = db.listEmails({ unmatchedOnly: false, limit: 500 }).filter((e) => e.matchSource === 'suggested'); } catch { return { upgraded: 0 }; }
  const highValue = suggested.filter((e) => ['interview', 'offer', 'assessment'].includes(e.category)).slice(0, AI_DISAMBIGUATE_CAP);
  if (!highValue.length) return { upgraded: 0 };
  const jobs = db.jobsForMatching();
  for (const e of highValue) {
    const hints = companyHints(e);
    const candidates = jobs.filter((j) => { const ck = db.normKey(j.company || ''); return ck && hints.some((h) => ck.includes(h) || h.includes(ck)); })
      .slice(0, 8).map((j) => ({ id: j.id, company: j.company, title: j.title, appliedAt: j.submittedAt || j.createdAt }));
    if (candidates.length < 2) continue;   // a single candidate is already the suggestion; nothing to disambiguate
    const pick = await aiPickJob(e, candidates, runFn);
    if (pick && pick.jobId) {
      try {
        db.setEmailMatch(e.id, { jobId: pick.jobId, source: 'auto', confidence: Math.min(0.95, pick.confidence) });
        db.creditOutcomeForEmail(e.id);
        upgraded++;
      } catch (err) { log.warn('ai disambiguation upgrade failed:', err.message); }
    }
  }
  return { upgraded };
}

let syncing = false;
async function syncAll({ accountId, disambiguate = true } = {}) {
  if (syncing) return { ok: false, error: 'a sync is already running' };
  syncing = true;
  try {
    const accts = listAccounts().filter((a) => a.enabled && a.password && (!accountId || a.id === accountId));
    const results = [];
    for (const a of accts) results.push(await syncAccount(a).catch((e) => ({ account: a.id, error: humanizeImapError(e) })));
    // AI tie-break the ambiguous high-value emails (bounded). Guarded — never breaks the sync.
    let ai = { upgraded: 0 };
    if (disambiguate) { try { ai = await aiDisambiguateSuggested(); } catch (e) { log.warn('ai disambiguation pass failed:', e.message); } }
    return { ok: true, results, aiUpgraded: ai.upgraded };
  } finally { syncing = false; }
}

module.exports = {
  PRESETS, presetsPublic, listAccounts, publicAccount, getAccount, addAccount, removeAccount, setEnabled,
  testConnection, syncAccount, syncAll, classify, classifyEmailReward, matchEmailToJob, companyHints, senderDomain,
  aiPickJob, aiDisambiguateSuggested, isSyncing: () => syncing,
};
