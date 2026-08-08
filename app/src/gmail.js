// JAT v11 — Gmail status sync.
// Dependency-free port of the proven Python design from
// ai-pc-assistant/src/integrations/{gmail_service.py, job_tracker_service.py}:
//   • Google OAuth desktop flow via loopback redirect (shell.openExternal)
//   • incremental sync with an internalDate watermark
//   • LinkedIn notification-email parsers (subject/body regexes)
//   • ordered keyword classifier (rejection checked FIRST — "congratulations"
//     appears in interview invites too)
//   • forward-only status ladder: emails can never demote a job
// Optional second stage: non-LinkedIn recruiter mail → /ai/classify-email.
//
// Requires user-supplied Google OAuth desktop-app credentials in settings
// (gmail.clientId / gmail.clientSecret) — one-time setup in Google Cloud
// Console with the gmail.readonly scope.

const http = require('http');
const crypto = require('crypto');
const db = require('./db');
const { scope } = require('./logger');

const log = scope('gmail');

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

let lastResult = null;
let syncing = false;
// When the CURRENT sync started, so a wedged one can be detected. `syncing` is cleared in a
// finally, which only runs if the promise settles — a fetch that never resolves (no timeout on the
// Gmail calls) leaves the flag true for the life of the process and EVERY later sync returns
// "sync already running". Live 2026-08-06: a sync began at 04:30 and never finished, so Gmail went
// 47h without a single successful run and no employer mail was ingested. Nothing surfaced it,
// because the flag is in-memory and the health record only advances on a completed run.
let syncStartedAt = 0;
// A real sync (backfill, SCAN_CAP 1200) finishes in minutes. Past this, assume the previous run is
// dead and let a new one take over rather than staying wedged forever.
const SYNC_STALE_MS = 15 * 60 * 1000;

// ---------- health ----------
// EVERY sync outcome — success or failure — is persisted here. Before this existed,
// syncNow() returned early on "disabled" / "not authorized" without writing anything,
// and the catch block only set the in-memory `lastResult`, so `gmailLastResult` in the
// DB advanced ONLY on success. A dead sync was therefore indistinguishable from a sync
// that simply hadn't run yet. Google started rejecting the refresh token at
// 2026-06-30 18:59, and it failed 1,828 consecutive times over 31 days with nothing
// surfaced anywhere. Nothing in this module may now fail without recording why.
const HEALTH_KEY = 'gmailHealth';

function blankHealth() {
  return {
    lastSuccessAt: null, lastFailureAt: null, lastError: null,
    consecutiveFailures: 0, needsAuth: false, lastNotifiedAt: null,
  };
}

function health() { return db.kvGet(HEALTH_KEY) || blankHealth(); }

function recordSuccess(result) {
  db.kvSet(HEALTH_KEY, {
    ...health(),
    lastSuccessAt: result.at,
    lastError: null,
    consecutiveFailures: 0,
    needsAuth: false,
  });
}

function recordFailure(error, { needsAuth = false } = {}) {
  const h = health();
  const at = new Date().toISOString();
  const rec = {
    ...h,
    lastFailureAt: at,
    lastError: String(error || 'unknown').slice(0, 300),
    consecutiveFailures: (h.consecutiveFailures || 0) + 1,
    needsAuth: needsAuth || h.needsAuth,
  };
  db.kvSet(HEALTH_KEY, rec);
  // The DB-visible result must reflect the failure too, so neither the dashboard nor
  // any external reader can mistake a broken sync for a quiet one.
  const failed = {
    at, error: rec.lastError, needsAuth: rec.needsAuth,
    consecutiveFailures: rec.consecutiveFailures,
  };
  lastResult = failed;
  db.kvSet('gmailLastResult', failed);
  return rec;
}

// Called by the scheduler once it has actually told the user, so the warning repeats
// on a slow cadence instead of once per tick.
function markNotified() {
  db.kvSet(HEALTH_KEY, { ...health(), lastNotifiedAt: new Date().toISOString() });
}

// ---------- OAuth ----------
function tokens() { return db.kvGet('gmailTokens'); }

async function refreshAccessToken() {
  const t = tokens();
  const s = db.getSettings().gmail;
  if (!t?.refresh_token || !s.clientId || !s.clientSecret) {
    recordFailure('Gmail is not connected — missing refresh token or OAuth client credentials.', { needsAuth: true });
    return null;
  }
  // The refresh happens BEFORE syncNow()'s try block, so a transport-level throw here
  // (offline, DNS, TLS) would escape syncNow entirely and persist nothing — the same
  // silent-death class of bug this module is being hardened against. Contain it.
  let r;
  try {
    r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: s.clientId, client_secret: s.clientSecret,
        refresh_token: t.refresh_token, grant_type: 'refresh_token',
      }),
    });
  } catch (e) {
    log.warn('token refresh request failed', e.message);
    recordFailure(`Could not reach Google to refresh the token: ${e.message}`);
    return null;
  }
  if (!r.ok) {
    // Google's body names WHICH failure this is: `invalid_grant` (the refresh token was
    // revoked or expired → the user must re-consent) vs `invalid_client` (the clientId/
    // secret no longer match the Cloud project → Settings need fixing, re-auth won't
    // help). Logging only the bare status code is what made this undiagnosable.
    let detail = '';
    try {
      const b = await r.json();
      detail = b.error ? `${b.error}${b.error_description ? ': ' + b.error_description : ''}` : '';
    } catch {
      try { detail = (await r.text()).slice(0, 200); } catch {}
    }
    log.warn('token refresh failed', r.status, detail || '(no body)');
    recordFailure(
      `Google rejected the refresh token (HTTP ${r.status})${detail ? ' — ' + detail : ''}`,
      { needsAuth: r.status === 400 || r.status === 401 },
    );
    return null;
  }
  const body = await r.json();
  const next = { ...t, access_token: body.access_token, expires_at: Date.now() + (body.expires_in - 60) * 1000 };
  db.kvSet('gmailTokens', next);
  return next.access_token;
}

async function accessToken() {
  const t = tokens();
  if (!t) return null;
  if (t.expires_at && Date.now() < t.expires_at) return t.access_token;
  return refreshAccessToken();
}

// Open the consent page in the default browser and catch the loopback redirect.
async function startAuth() {
  const s = db.getSettings().gmail;
  if (!s.clientId || !s.clientSecret) {
    return { ok: false, error: 'Set gmail.clientId and gmail.clientSecret in Settings first (Google Cloud Console → OAuth desktop app).' };
  }
  return new Promise((resolve) => {
    const state = crypto.randomBytes(16).toString('hex');
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const code = u.searchParams.get('code');
      const gotState = u.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="font-family:sans-serif"><h2>JAT connected to Gmail ✓</h2>You can close this tab.</body></html>');
      srv.close();
      clearTimeout(timer);
      if (!code || gotState !== state) return resolve({ ok: false, error: 'auth was cancelled or invalid' });
      try {
        const port = srv.address()?.port || boundPort;
        const r = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: s.clientId, client_secret: s.clientSecret,
            code, grant_type: 'authorization_code',
            redirect_uri: `http://127.0.0.1:${boundPort}/callback`,
          }),
        });
        const body = await r.json();
        if (!r.ok || !body.access_token) return resolve({ ok: false, error: body.error_description || 'token exchange failed' });
        db.kvSet('gmailTokens', {
          access_token: body.access_token,
          refresh_token: body.refresh_token || tokens()?.refresh_token,
          expires_at: Date.now() + (body.expires_in - 60) * 1000,
        });
        db.kvSet(HEALTH_KEY, blankHealth());   // a fresh grant clears the broken-auth state
        log.info('gmail authorized');
        resolve({ ok: true });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
    let boundPort = 0;
    const timer = setTimeout(() => { try { srv.close(); } catch {} resolve({ ok: false, error: 'auth timed out (5 min)' }); }, 300000);
    srv.listen(0, '127.0.0.1', () => {
      boundPort = srv.address().port;
      const url = AUTH_URL + '?' + new URLSearchParams({
        client_id: s.clientId,
        redirect_uri: `http://127.0.0.1:${boundPort}/callback`,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        state,
      });
      try { require('electron').shell.openExternal(url); } catch { log.warn('open browser manually:', url); }
    });
  });
}

// ---------- message fetch ----------
async function gmailGet(pathAndQuery, token) {
  const r = await fetch(`${API}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  if (r.status === 401) throw Object.assign(new Error('gmail unauthorized'), { code: 'GMAIL_AUTH' });
  if (!r.ok) throw new Error(`gmail HTTP ${r.status}`);
  return r.json();
}

function header(msg, name) {
  return (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

// Split a raw RFC822 From header ("Jane Doe <jane@acme.com>" / "jane@acme.com") into
// { address, name } so it can feed the shared emailUpsert/matchEmailToJob path.
function parseFrom(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), address: m[2].trim().toLowerCase() };
  if (s.includes('@')) return { name: '', address: s.replace(/[<>]/g, '').trim().toLowerCase() };
  return { name: s, address: '' };
}

function bodyText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  for (const part of payload.parts || []) {
    const t = bodyText(part);
    if (t) return t;
  }
  // fall back to html stripped
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  }
  return '';
}

// ---------- parsing & classification (ported from Python, order matters) ----------
const SUBJ_APPLIED_RX = /your application (?:to|for) (.+?) at (.+?)\s*$/i;
const SUBJ_UPDATE_RX = /your update from (.+?)\s*$/i;
// Formats the original parser missed entirely, so these emails stayed unmatched and the job never
// advanced. Measured live: 23 of 100 emails unlinked — 9 "viewed by", 8 Indeed acknowledgements.
//  - "Your application was viewed by <COMPANY>"  → company only (engagement signal)
//  - "Thank you for applying to <COMPANY>"       → company only
//  - "Indeed Application: <JOB TITLE>"           → TITLE only; Indeed never names the company
const SUBJ_VIEWED_RX = /your application was viewed by\s+(.+?)\s*$/i;
const SUBJ_THANKS_RX = /(?:thank you|thanks) for applying (?:to|at)\s+(.+?)\s*$/i;
const SUBJ_INDEED_RX = /^\s*indeed application:\s*(.+?)\s*$/i;

const BUCKETS = [
  ['rejected', /not (?:be )?moving forward|unfortunately|not selected|decided to (?:pursue|proceed with) other|no longer under consideration|position has been filled/i],
  ['offer', /\boffer\b|we are pleased to (?:offer|extend)|congratulations.*offer/i],
  ['interview_1', /\binterview\b|schedule a (?:call|chat|conversation)|next round|meet the team|phone screen/i],
  ['interview_1_assessment', /\bassessment\b|coding challenge|take[- ]home|online test|hackerrank|codility/i],
  ['contacted', /reviewing your application|application is being reviewed|recruiter|talent (?:team|partner)/i],
  ['submitted', /application (?:was )?(?:sent|submitted|received)|applied on/i],
];

function classify(subject, body) {
  const text = `${subject}\n${body}`.toLowerCase();
  for (const [status, rx] of BUCKETS) {
    if (rx.test(text)) return status === 'interview_1_assessment' ? 'interview_1' : status;
  }
  return null;
}

function parseLinkedIn(subject, body) {
  let m = subject.match(SUBJ_APPLIED_RX);
  if (m) return { title: m[1].trim(), company: m[2].trim() };
  m = subject.match(SUBJ_UPDATE_RX);
  if (m) {
    const company = m[1].trim();
    const bm = body.match(/(.+?)\n.*applied on/i);
    return { title: bm ? bm[1].trim() : '', company };
  }
  m = subject.match(SUBJ_VIEWED_RX);
  if (m) return { title: '', company: m[1].trim() };
  m = subject.match(SUBJ_THANKS_RX);
  if (m) return { title: '', company: m[1].trim() };
  m = subject.match(SUBJ_INDEED_RX);
  if (m) return { title: m[1].trim(), company: '' };
  return null;
}

function matchJob({ title, company }) {
  const all = db.listJobs({ limit: 2000 });
  // TITLE-ONLY match. Indeed's acknowledgement ("Indeed Application: <role>") never names the
  // company, so requiring one dropped every single one of them on the floor. Match on an exact
  // normalised title instead, and ONLY when it is unambiguous — if two different jobs share the
  // title we cannot tell which was applied to, so we decline rather than guess and mis-advance a job.
  if (!company) {
    const tk0 = db.normKey(title);
    if (!tk0) return null;
    const byTitle = all.filter((j) => db.normKey(j.title) === tk0);
    return byTitle.length === 1 ? byTitle[0] : null;
  }
  const ck = db.normKey(company);
  const tk = db.normKey(title);
  // exact title+company → company + fuzzy title → company only if unique
  let hit = all.find((j) => db.normKey(j.company) === ck && db.normKey(j.title) === tk && tk);
  if (hit) return hit;
  const sameCo = all.filter((j) => db.normKey(j.company) === ck);
  if (tk) {
    hit = sameCo.find((j) => db.normKey(j.title).includes(tk) || tk.includes(db.normKey(j.title)));
    if (hit) return hit;
  }
  return sameCo.length === 1 ? sameCo[0] : null;
}

// ---------- sync ----------
async function syncNow() {
  if (syncing && (Date.now() - syncStartedAt) < SYNC_STALE_MS) {
    return { ok: false, error: 'sync already running' };
  }
  if (syncing) {
    // Previous run is wedged past SYNC_STALE_MS — take the flag over instead of blocking forever.
    recordFailure(`previous sync wedged for ${Math.round((Date.now() - syncStartedAt) / 60000)} min — starting a new one`);
  }
  const s = db.getSettings().gmail;
  if (!s.enabled) {
    const e = 'Gmail sync is turned off in Settings.';
    recordFailure(e);
    return { ok: false, error: e };
  }
  const token = await accessToken();
  if (!token) {
    // accessToken()/refreshAccessToken() already recorded the specific reason; only
    // record a generic one if something upstream returned null without saying why.
    const h = health();
    if (!h.lastError) recordFailure('Not authorized — reconnect Gmail in Settings.', { needsAuth: true });
    return { ok: false, error: h.lastError || 'not authorized — connect Gmail in Settings', needsAuth: true };
  }

  syncing = true;
  syncStartedAt = Date.now();
  const started = Date.now();
  let scanned = 0, matched = 0, updated = 0, emailsWritten = 0;
  // Bound the AI second-stage per sync run (mirrors email.js AI_DISAMBIGUATE_CAP). On a backfill
  // (SCAN_CAP=1200) an uncapped per-message AI call would fire hundreds of serial provider/subprocess
  // calls and make a sync run for many minutes; the deterministic parser handles the bulk regardless.
  let aiCalls = 0; const AI_CLASSIFY_CAP = 25;
  try {
    const watermark = db.kvGet('gmailWatermark') || 0;   // internalDate ms
    const afterSec = watermark ? Math.floor(watermark / 1000) : Math.floor((Date.now() - 30 * 86400000) / 1000);
    const q = `${s.query} after:${afterSec}`;
    // The job set the lenient matcher associates inbound mail to (same source IMAP uses).
    let jobsForMatch = [];
    try { jobsForMatch = db.jobsForMatching(); } catch {}

    let pageToken = '';
    let newWatermark = watermark;
    const ids = [];
    // BACKFILL vs INCREMENTAL cap. A reset/zero watermark means a full re-scan of the 30-day window
    // (after a query upgrade) — the broad query's LinkedIn volume crowds out employer status emails,
    // so a low cap (300) only reached ~2 weeks and missed older rejection/assessment mail. Use a high
    // cap for the backfill so the whole window is covered; the incremental tick (watermark set) only
    // ever sees a sync-interval's worth of NEW mail, so 300 is plenty there.
    const SCAN_CAP = watermark ? 300 : 1200;
    do {
      const page = await gmailGet(`/messages?q=${encodeURIComponent(q)}&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ''}`, token);
      for (const m of page.messages || []) ids.push(m.id);
      pageToken = page.nextPageToken || '';
    } while (pageToken && ids.length < SCAN_CAP);

    for (const id of ids) {
      const msg = await gmailGet(`/messages/${id}?format=full`, token);
      const internal = Number(msg.internalDate || 0);
      if (internal <= watermark) continue;      // already processed
      newWatermark = Math.max(newWatermark, internal);
      scanned++;

      const subject = header(msg, 'Subject');
      const from = header(msg, 'From');
      const body = bodyText(msg.payload).slice(0, 8000);

      // P6 — populate the `emails` table through the SAME lenient path IMAP email.js uses, so
      // Gmail feeds the reward loop (match_confidence + match_source + category). This is
      // ADDITIVE to the legacy status-sync below; it must never crash the sync if anything in
      // the email module / db is unavailable.
      try {
        const emailMod = require('./email');
        const f = parseFrom(from);
        let sentAt;
        try { sentAt = new Date(internal || Date.now()).toISOString(); } catch { sentAt = new Date().toISOString(); }
        const parsedEmail = {
          messageId: header(msg, 'Message-ID') || id,
          threadId: msg.threadId || null,
          from: f.address, fromName: f.name, to: '',
          subject: subject || '(no subject)',
          snippet: body.replace(/\s+/g, ' ').trim().slice(0, 220),
          body: body.slice(0, 8000),
          sentAt,
        };
        // associate(): match, and auto-create a tracked job for an unmatched confirmation so
        // every application lands in the pipeline (LinkedIn reposts / staffing agencies included).
        const assoc = emailMod.associate(parsedEmail, jobsForMatch);
        const up = db.emailUpsert({ accountId: 'gmail', provider: 'gmail', uid: id, ...parsedEmail, ...assoc });
        emailsWritten++;
        // Auto-linked email → release its reward now AND elevate the job's pipeline stage from the
        // email category (forward-only). 'suggested' is held until the user confirms.
        if (assoc.matchSource === 'auto') {
          try { db.creditOutcomeForEmail(up.id); } catch (e) { log.warn('credit failed:', e.message); }
          try { db.elevateJobFromEmail(up.id); } catch (e) { log.warn('elevate failed:', e.message); }
        }
      } catch (e) { log.warn('emails-table write failed:', e.message); }

      let parsed = parseLinkedIn(subject, body);
      let status = classify(subject, body);

      // Second stage: AI classification for non-LinkedIn recruiter mail (bounded per run — see cap).
      if ((!parsed || !status) && s.includeRecruiterMail && aiCalls < AI_CLASSIFY_CAP) {
        aiCalls++;
        try {
          const provider = require('./ai/provider');
          const prompts = require('./ai/prompts');
          const r = await provider.run(prompts.classifyEmail({ subject, from, body }));
          const c = r.json;
          if (c.confidence >= 0.7 && c.company) {
            parsed = parsed || { title: c.jobTitle || '', company: c.company };
            status = status || ({
              application_confirmation: 'submitted', recruiter_reply: 'contacted',
              interview_request: 'interview_1', assessment_request: 'interview_1',
              offer: 'offer', rejection: 'rejected', status_update: null,
            })[c.category] || null;
          }
        } catch (e) { log.warn('ai classify failed:', e.message); }
      }

      if (!parsed || !status) continue;
      const job = matchJob(parsed);
      if (!job) continue;
      matched++;

      // Forward-only: upsert path enforces elevation; never demote via email.
      const cur = db.STATUS_ORDER[job.status] || 0;
      const inc = db.STATUS_ORDER[status] || 0;
      if (inc > cur && !db.TERMINAL.has(job.status) || (status === 'rejected' && !db.TERMINAL.has(job.status))) {
        const r = db.patchJob(job.id, { status });
        if (r?.statusChanged) {
          updated++;
          db.recordEvent({
            jobId: job.id, type: 'status_changed', source: 'gmail',
            summary: `${r.previousStatus} → ${status} (email: "${subject.slice(0, 80)}")`,
            data: { from: r.previousStatus, to: status, emailSubject: subject.slice(0, 200), emailFrom: from.slice(0, 120) },
          });
        }
      } else {
        db.recordEvent({
          jobId: job.id, type: 'email', source: 'gmail',
          summary: `Email: "${subject.slice(0, 80)}"`,
          data: { classified: status, emailFrom: from.slice(0, 120) },
        });
      }
    }

    if (newWatermark > (db.kvGet('gmailWatermark') || 0)) db.kvSet('gmailWatermark', newWatermark);
    lastResult = { at: new Date().toISOString(), scanned, matched, updated, emailsWritten, ms: Date.now() - started };
    db.kvSet('gmailLastResult', lastResult);
    recordSuccess(lastResult);
    log.info('sync done', lastResult);
    return { ok: true, ...lastResult };
  } catch (e) {
    log.error('sync failed', e.message);
    // recordFailure persists to the DB — the old code set only the in-memory copy here,
    // so a throwing sync left `gmailLastResult` frozen at its last success forever.
    recordFailure(e.message, { needsAuth: e.code === 'GMAIL_AUTH' });
    return { ok: false, error: e.message, needsAuth: e.code === 'GMAIL_AUTH' };
  } finally {
    syncing = false;
  }
}

function status() {
  const s = db.getSettings().gmail;
  const h = health();
  return {
    enabled: s.enabled,
    configured: !!(s.clientId && s.clientSecret),
    authorized: !!tokens()?.refresh_token,
    lastResult: lastResult || db.kvGet('gmailLastResult'),
    watermark: db.kvGet('gmailWatermark'),
    health: h,
    // A single field the UI/scheduler can act on: sync is enabled but hasn't succeeded
    // in a long time, whatever the reason.
    stale: staleness(h, s).stale,
    staleHours: staleness(h, s).hours,
  };
}

// How long since the last SUCCESSFUL sync. Deliberately independent of the failure
// counter: if the scheduler itself dies (interval cleared, ticks never fire) there are
// no failures to count, yet mail silently stops flowing — that is exactly the 31-day
// blind spot. Age-since-success catches every cause, known or not.
const STALE_AFTER_HOURS = 6;

function staleness(h = health(), s = db.getSettings().gmail) {
  if (!s.enabled) return { stale: false, hours: 0 };
  const since = h.lastSuccessAt ? Date.parse(h.lastSuccessAt) : null;
  if (!since) return { stale: !!h.lastFailureAt, hours: Infinity };
  const hours = (Date.now() - since) / 3600000;
  return { stale: hours >= STALE_AFTER_HOURS, hours };
}

module.exports = { startAuth, syncNow, status, health, staleness, markNotified, STALE_AFTER_HOURS };
