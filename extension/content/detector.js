// JAT v11 — capture engine (orchestrator).
// Loaded lazily by content/loader.js. Exports: init(), reboot(reason),
// captureNow({manual}), runTask(task, context).
//
// Differences from v10 that matter:
//  • Watchers install in init() unconditionally — detection is re-evaluated on
//    every SPA navigation (loader/webNavigation call reboot()), so landing on
//    a non-job page no longer blinds the extension forever.       (fix C1)
//  • Runs in iframes too (Greenhouse/Lever embeds); the panel renders only in
//    the top frame, capture works everywhere.                     (fix C2)
//  • Shadow-DOM-piercing scans + composedPath click targets.      (fix C6)
//  • Handoff is keyed per job and keeps the last 5.               (fix C7)
//  • Success re-scan ticker + characterData-tolerant checks.      (fix C8)
//  • Panel is SILENT until an Apply click by default.             (fix C10)
//  • Persist feedback (saved/queued/failed) painted on the panel. (fix C11)
//  • High-confidence submits persist on pointerdown + a
//    visibilitychange flush.                                      (fix C12)
//  • Mid-confidence pages ask once ("Track this application?") and "Not a job"
//    suppresses the host permanently — no more un-dismissable cards on
//    unrelated signup forms.

import { readJsonLdJobPosting } from './signals/json-ld.js';
import { detectApplyForm, detectAttachments, snapshotAnswers, findCompanyLink, findResumeFilename, inferFromApplyHeader } from './signals/forms.js';
import { isApplyClick, isSubmitClick, isStepAdvanceClick, hasApplyAction } from './signals/intent.js';
import { pageTextLooksLikeSuccess, urlLooksLikeSuccess, nodeLooksLikeSuccess } from './signals/success.js';
import { sitePack, detectSource } from './sites/index.js';
import { eventTarget, closestThroughShadow, compactText } from './lib/dom.js';
import { renderPanel, dismissPanel, promptUnsure } from './panel.js';

const TAG = '[JAT v11]';
const IS_TOP = window === window.top;
const MIN_PAGE_SCORE = 0.35;
const UNSURE_FLOOR = 0.20;
const HANDOFF_KEY = 'jat11.handoff';
const HANDOFF_TTL_MS = 10 * 60 * 1000;
const SUPPRESS_KEY = 'jat11.suppressHosts';
// Third-party ATS hosts a board's "Apply" hands off to. On these, the on-page
// company/title is usually the VENDOR (or a tenant alias), not the employer —
// so the job identity carried over from the board (the handoff) is canonical.
const ATS_HOST_RX = /(myworkdayjobs|myworkdaysite|greenhouse\.io|boards\.greenhouse|lever\.co|ashbyhq|smartrecruiters|workable|bamboohr|icims|taleo|jobvite|breezy\.hr|recruitee|teamtailor|jazzhr|paylocity|dayforcehcm|successfactors|brassring|avature|eightfold|phenom|oraclecloud|wd\d?\.myworkday)/i;
const PLATFORM_LABEL_RX = /^(linkedin|indeed|glassdoor|greenhouse|lever|workday|myworkdayjobs|ashby|workable|bamboohr|smartrecruiters|ziprecruiter|talentmanagementsolution|workforcenow|icims|taleo)$/i;
const JOB_HEADING_RX = /\b(engineer|developer|designer|manager|analyst|specialist|coordinator|director|administrator|consultant|architect|scientist|recruiter|writer|producer|lead|intern|associate|technician|job|position|role|opening)\b/i;
const JOB_DETAIL_TEXT_RX = /\b(job description|responsibilit(?:y|ies)|qualifications?|requirements?|preferred qualifications|benefits|compensation|salary|pay range|employment type|work authorization|visa sponsorship|remote|hybrid|on-site|hours per week|description du poste|exigences)\b/i;
// URL shapes that mean "this is an application page" (vs. a job posting).
const APPLY_URL_RX = /(\/apply(\/|$|\?|manually)|\/application(s)?(\/|$|\?|\/new)|applymanually|smartapply|indeedapply|easy-?apply|\/candidate|submit-application|gh_src=|\/postings?\/[\w-]+\/(apply|application)|workday.*\/apply)/i;

const log = (...args) => console.log(TAG, ...args);
const send = (type, data) => new Promise((res) => {
  try { chrome.runtime.sendMessage({ type, data }, (r) => {
    void chrome.runtime.lastError;
    res(r);
  }); } catch { res(null); }
});

const state = {
  ctx: null,
  jobId: null,
  externalId: null,
  source: null,
  stage: null,                 // null | 'detected' | 'started' | 'progressing' | 'submitted'
  resumeName: null,
  attachments: [],
  answers: {},
  answersCount: 0,
  persisted: false,
  fired: { started: false, submitted: false },
  autoApplyDriven: false,      // true while the EXECUTOR drives this tab — passive capture must
                               // NOT mark the job submitted then (the executor's confirmed
                               // outcome is authoritative; otherwise a clicked-but-failed
                               // Easy-Apply/external flow gets falsely stamped "submitted").
  lastUrl: location.href,
  lastPersistFingerprint: null,
  inflight: null,
  saveState: null,             // 'saved' | 'queued' | 'failed'
  settings: { panelOnDetect: false, askWhenUnsure: true, successRescanMs: 2000 },
  asked: false,
  initialized: false,
  lastProgressAt: 0,
  recognitionDone: false,      // true once the page is classified (stop re-trying)
  recognitionAttempts: 0,      // bounded re-recognition while a SPA hydrates
  autofillBundle: undefined,   // undefined=not fetched, null=off/empty, obj=ready
};

// ============================================================
// Settings (via SW; fall back to silent defaults)
// ============================================================
async function loadSettings() {
  try {
    const r = await new Promise((res) => chrome.runtime.sendMessage(
      { type: 'api-call', method: 'GET', path: '/settings' }, (x) => { void chrome.runtime.lastError; res(x); }));
    if (r?.ok && r.settings?.capture) state.settings = { ...state.settings, ...r.settings.capture };
  } catch {}
}

// ============================================================
// Page recognition (generic pipeline + site-pack overlay)
// ============================================================
function detectExternalId() {
  const u = new URL(location.href);
  const params = ['currentJobId', 'jobId', 'jobID', 'job_id', 'jk', 'jobKey', 'gh_jid', 'ashby_jid'];
  for (const name of params) {
    const value = u.searchParams.get(name);
    if (value) return value;
  }
  const patterns = [
    /\/jobs\/view\/(\d+)/i,
    /\/job\/([\w-]{4,})/i,
    /\/jobs\/([\w-]{4,})/i,
    /\/(openings?|positions?|roles?)\/([\w-]{4,})/i,
  ];
  for (const pattern of patterns) {
    const match = u.pathname.match(pattern);
    if (!match) continue;
    const last = match[match.length - 1];
    if (last) return last;
  }
  return null;
}

function urlLooksJobby() {
  const u = new URL(location.href);
  const p = u.pathname.toLowerCase();
  let score = 0;
  if (/\/(viewjob|indeedapply|smartapply|easy-apply)(\/|$)/.test(p)) score = 0.42;
  else if (/\/(apply|application)(\/|$)/.test(p)) score = 0.38;
  else if (/\/jobs\/view\/\d+/.test(p) || /\/job\/[\w-]{4,}/.test(p) || /\/(openings?|positions?|roles?)\/[\w-]{4,}/.test(p)) score = 0.34;
  else if (/\/(jobs?|vacanc(?:y|ies)|postings?|requisitions?)(\/|$)/.test(p)) score = 0.24;
  else if (/\/careers?(\/|$)/.test(p)) score = 0.10;
  if (['currentJobId', 'jobId', 'job_id', 'jk', 'jobKey', 'gh_jid', 'ashby_jid'].some((key) => u.searchParams.get(key))) score += 0.12;
  if (/apply|application/.test((u.hash || '').toLowerCase())) score += 0.08;
  return Math.min(score, 0.52);
}

function titleLooksJobby() {
  const title = document.title || '';
  if (/\b(apply|job application|easy apply|postuler)\b/i.test(title)) return 0.18;
  if (/\b(job|position|opening|role|engineer|developer|designer|manager|analyst|specialist|coordinator|intern)\b/i.test(title)) return 0.14;
  if (/\b(careers?|hiring|opportunities|join us)\b/i.test(title)) return 0.08;
  return 0;
}

function scoreDomContext() {
  let score = 0;
  const heading = readPrimaryHeading();
  if (JOB_HEADING_RX.test(heading)) score += 0.12;
  const text = (document.body?.innerText || document.body?.textContent || '').slice(0, 8000);
  if (JOB_DETAIL_TEXT_RX.test(text)) score += 0.14;
  if (/\b(upload\s+(?:a\s+)?resume|cover\s*letter|work\s*authorization|years?\s+of\s+experience)\b/i.test(text)) score += 0.10;
  if (findCompanyLink()) score += 0.08;
  return Math.min(score, 0.28);
}

function recognizePage() {
  let score = 0;
  let ctx = null;

  const jp = readJsonLdJobPosting();
  if (jp) { score += jp.confidence; ctx = jp.context; }

  const urlScore = urlLooksJobby();
  const titleScore = titleLooksJobby();
  const domScore = scoreDomContext();
  const applyActionScore = hasApplyAction() ? 0.22 : 0;
  const applyFormProbe = detectApplyForm();
  const formScore = applyFormProbe ? Math.min(0.5, Math.max(0.22, applyFormProbe.confidence * 0.55)) : 0;

  score += urlScore + titleScore + domScore + applyActionScore + formScore;

  // Site-pack overlay: precise selectors beat heuristics when they hit.
  const pack = sitePack();
  const packCtx = pack?.getContext?.() || null;
  if (packCtx && (packCtx.title || packCtx.company)) {
    score = Math.max(score, 0.5);
    ctx = { ...(ctx || ctxFromMeta()), ...stripEmpty(packCtx) };
  }

  log('page score', { score: +score.toFixed(2), jsonLd: !!jp, pack: pack?.id, urlScore, titleScore, domScore, applyActionScore, formScore });
  if (score < UNSURE_FLOOR) return null;

  if (!ctx) ctx = ctxFromMeta();

  const hostFallback = hostCompanyFallback();
  if (!ctx.company || isPlatformLabel(ctx.company) || normalizeKey(ctx.company) === normalizeKey(hostFallback)) {
    const fromDom = findCompanyLink();
    if (fromDom) ctx.company = fromDom;
  }
  if (!ctx.title || isGenericTitle(ctx.title)) {
    const heading = readPrimaryHeading();
    if (heading) ctx.title = heading;
  }
  const header = (!ctx.title || !ctx.company) ? inferFromApplyHeader() : null;
  if (header) {
    if (header.title && !ctx.title) ctx.title = header.title;
    if (header.company && (!ctx.company || isPlatformLabel(ctx.company))) ctx.company = header.company;
  }
  ctx.jobUrl = ctx.jobUrl || location.href;
  return { score, ctx };
}

function stripEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v) out[k] = v;
  return out;
}

function ctxFromMeta() {
  const og = (p) => document.querySelector(`meta[property="og:${p}"]`)?.content || '';
  const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.content || '';
  const rawTitle = og('title') || meta('twitter:title') || document.title || '';
  const title = cleanTitle(rawTitle.split(/[|·•]/)[0].trim() || rawTitle);
  const companyCandidate = compactText(og('site_name') || meta('application-name') || meta('author') || '');
  const company = companyCandidate && !isPlatformLabel(companyCandidate) ? companyCandidate : hostCompanyFallback();
  const description = (og('description') || meta('description') || '').slice(0, 4000);
  return { title, company, location: '', description, compensation: '', workMode: '', employmentType: '' };
}

function cleanTitle(raw) {
  return compactText(String(raw || '')
    .replace(/\s+[|·•]\s+(LinkedIn|Indeed|Glassdoor|Greenhouse|Lever|Workday|SmartRecruiters|BambooHR|Workable|Ashby|ZipRecruiter)\b.*$/i, '')
    .replace(/\s+-\s+(LinkedIn|Indeed|Glassdoor|Greenhouse|Lever|Workday|SmartRecruiters|BambooHR|Workable|Ashby|ZipRecruiter)\b.*$/i, ''));
}

function readPrimaryHeading() {
  const headings = document.querySelectorAll('h1, h2, [role="heading"]');
  for (const h of headings) {
    const text = cleanTitle((h.textContent || '').slice(0, 200));
    if (!text) continue;
    if (/^(jobs?|careers?|apply|application)$/i.test(text)) continue;
    return text;
  }
  return '';
}

function hostCompanyFallback() {
  return location.hostname.replace(/^www\./, '').split('.')[0];
}
function isPlatformLabel(value) { return PLATFORM_LABEL_RX.test(compactText(value)); }
function isGenericTitle(value) {
  return /^(jobs?|careers?|apply|application|job application)$/i.test(compactText(value));
}
function normalizeKey(value) {
  return compactText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ============================================================
// Handoff — per-job keyed, last 5 kept (fix C7)
// ============================================================
function handoffKey() {
  return `${state.source || detectSource()}|${state.externalId || normalizeKey(state.ctx?.title || '') + ':' + normalizeKey(state.ctx?.company || '')}`;
}

async function storeHandoff() {
  if (!state.ctx) return;
  try {
    const cur = (await chrome.storage.local.get(HANDOFF_KEY))[HANDOFF_KEY] || {};
    cur[handoffKey()] = {
      ctx: state.ctx, source: state.source, externalId: state.externalId,
      ts: Date.now(), url: location.href,
    };
    const entries = Object.entries(cur)
      .filter(([, v]) => Date.now() - v.ts < HANDOFF_TTL_MS)
      .sort(([, a], [, b]) => b.ts - a.ts)
      .slice(0, 5);
    await chrome.storage.local.set({ [HANDOFF_KEY]: Object.fromEntries(entries) });
  } catch {}
}

async function loadHandoff() {
  try {
    const cur = (await chrome.storage.local.get(HANDOFF_KEY))[HANDOFF_KEY] || {};
    const fresh = Object.values(cur)
      .filter((v) => Date.now() - v.ts < HANDOFF_TTL_MS)
      .sort((a, b) => b.ts - a.ts);
    return fresh[0] || null;
  } catch { return null; }
}

// ============================================================
// Persist
// ============================================================
async function persist(stage, extra = {}) {
  if (!state.ctx) return;

  paintPanel();

  // Throttle 'progressing' re-posts — typing into a form fires many mutations,
  // and each distinct field value is a new fingerprint. The final state is
  // always captured on submit (unthrottled), so a 4s floor here just trims the
  // timeline/network spam without losing the outcome.
  if (stage === 'progressing') {
    const now = Date.now();
    if (now - (state.lastProgressAt || 0) < 4000) { paintPanel(); return; }
    state.lastProgressAt = now;
  }

  const fingerprint = buildFingerprint(stage);
  if (fingerprint === state.lastPersistFingerprint || fingerprint === state.inflight) {
    return;
  }
  state.inflight = fingerprint;

  const payload = {
    stage,
    job: {
      externalId: state.externalId,
      source: state.source,
      status: stage === 'submitted' ? 'submitted' : 'started',
      title: state.ctx.title,
      company: state.ctx.company,
      location: state.ctx.location,
      jobUrl: state.ctx.jobUrl,
      description: state.ctx.description,
      compensation: state.ctx.compensation,
      workMode: state.ctx.workMode,
      employmentType: state.ctx.employmentType,
      attachments: state.attachments,
      answers: Object.keys(state.answers).length ? state.answers : undefined,
    },
    eventType: stage,
    summary: extra.summary || '',
  };
  log('→ pipeline', stage, payload.job.title, '@', payload.job.company);
  const r = await send('pipeline-event', payload);
  if (state.inflight === fingerprint) state.inflight = null;

  if (r?.ok && r.jobId) {
    state.jobId = r.jobId;
    state.persisted = true;
    state.lastPersistFingerprint = fingerprint;
    state.saveState = 'saved';
  } else if (r?.queued) {
    state.saveState = 'queued';
    state.lastPersistFingerprint = fingerprint;   // queue will deliver it
  } else {
    state.saveState = 'failed';
    log('persist failed', r);
  }
  paintPanel();
  return r;
}

function buildFingerprint(stage) {
  const attachments = [...state.attachments]
    .map((a) => `${a.role || 'attachment'}:${a.name || ''}:${a.sizeBytes || 0}`)
    .sort();
  const answers = Object.entries(state.answers || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${String(v).slice(0, 120)}`);
  return JSON.stringify({
    stage,
    source: state.source || '',
    externalId: state.externalId || '',
    title: normalizeKey(state.ctx?.title),
    company: normalizeKey(state.ctx?.company),
    resumeName: normalizeKey(state.resumeName),
    attachments, answers,
  });
}

function paintPanel() {
  if (!IS_TOP) return;
  const show = state.stage && (state.stage !== 'detected' || state.settings.panelOnDetect);
  if (!show) return;
  renderPanel({
    stage: state.stage,
    ctx: state.ctx,
    resumeName: state.resumeName,
    attachments: state.attachments,
    answersCount: state.answersCount,
    saveState: state.saveState,
  }, {
    onDismiss: () => {},
  });
}

function captureFormState(reason) {
  const formProbe = detectApplyForm();
  const root = formProbe?.form || document;
  const attachments = detectAttachments(root);
  if (!attachments.length) {
    const pack = sitePack();
    let guessed = '';
    for (const sel of pack?.resumeNameSelectors || []) {
      const el = document.querySelector(sel);
      if (el?.textContent?.trim()) { guessed = compactText(el.textContent); break; }
    }
    if (!guessed) guessed = findResumeFilename(root);
    if (guessed) attachments.push({ name: guessed, sizeBytes: 0, type: '', role: 'resume' });
  }
  const answers = snapshotAnswers(root);
  if (attachments.length) {
    state.attachments = attachments;
    const resume = attachments.find((a) => a.role === 'resume') || attachments[0];
    state.resumeName = resume?.name || state.resumeName;
  }
  if (Object.keys(answers).length) {
    state.answers = { ...state.answers, ...answers };
    state.answersCount = Object.keys(state.answers).length;
  }
  return { attachments, answers, hasProgress: state.attachments.length > 0 || state.answersCount > 0 };
}

// Fire-and-forget persist with rejection handling (used in timers/observers
// where awaiting isn't possible). Dedup in persist() guards against doubles.
function persistFnf(stage, extra) {
  persist(stage, extra).catch((e) => log('persist failed', e));
}

// Success re-scan ticker — armed when the user clicks Apply, stopped on submit
// and on page teardown, re-armed for a fresh job. Avoids a setInterval that
// runs for the page's whole lifetime.
let successTickerId = null;
let urlTickerId = null;
function startSuccessTicker() {
  if (successTickerId) return;
  successTickerId = setInterval(() => {
    if (!state.ctx || state.fired.submitted || !state.fired.started) return;
    if (pageTextLooksLikeSuccess() || urlLooksLikeSuccess()) {
      log('ticker: success text appeared');
      fireSubmitted('Success text detected');
    }
  }, Math.max(1000, state.settings.successRescanMs || 2000));
}
function stopSuccessTicker() {
  if (successTickerId) { clearInterval(successTickerId); successTickerId = null; }
}

function fireSubmitted(summary) {
  if (state.fired.submitted) return;
  // In an executor-driven (auto-apply) tab, ONLY the executor may mark the job
  // submitted — and only when it actually confirms a submit. Passive success
  // detection here would falsely stamp jobs whose Easy-Apply/external flow was
  // clicked but never completed (the "I never applied to that" bug).
  if (state.autoApplyDriven) { log('passive submit suppressed — executor-driven tab'); return; }
  state.fired.submitted = true;
  state.stage = 'submitted';
  stopSuccessTicker();
  captureFormState('submit');
  persistFnf('submitted', { summary });
}

// ============================================================
// Evaluation / lifecycle
// ============================================================
async function evaluate(reason) {
  // Different job on the same board → reset before anything else.
  if (switchedToDifferentJob()) {
    const p = recognizePage();
    if (p) { resetForNewJob(p); return; }
    hardReset();   // navigated off jobs entirely → fall through to fresh detection
  }

  // Mid-flow: never reset (intra-application navigation within the SAME job).
  if (state.fired.started || state.persisted) {
    const cap = captureFormState('re-eval-mid-flow');
    if (!state.fired.submitted && (pageTextLooksLikeSuccess() || urlLooksLikeSuccess())) {
      fireSubmitted('Success detected after navigation');
      return;
    }
    if (state.persisted && cap.hasProgress) {
      state.stage = 'progressing';
      persistFnf('progressing', { summary: 'Navigated within application' });
    } else {
      paintPanel();
    }
    return;
  }

  let probe = recognizePage();

  // Cross-domain / ATS handoff. The board's "Apply" hands off to a third-party
  // ATS (Workday, Greenhouse, Lever, …) whose on-page metadata is the vendor or
  // a tenant alias — NOT the employer. So when we land on an ATS host (or the
  // probe lacks a real title/company), the job identity carried from the board
  // (the handoff) is the source of truth.
  const applyFormHere = detectApplyForm();
  const hasApplySignal = (
    urlLooksJobby() > 0 || hasApplyAction() || pageTextLooksLikeSuccess()
    || urlLooksLikeSuccess() || !!applyFormHere
  );
  const weakCompany = !probe?.ctx?.company || isPlatformLabel(probe.ctx.company)
    || (onAtsHost() && normalizeKey(probe.ctx.company) === normalizeKey(hostCompanyFallback()));
  if ((!probe || !probe.ctx.title || weakCompany) && hasApplySignal) {
    const handoff = await loadHandoff();
    if (handoff) {
      const header = inferFromApplyHeader();
      let crossDomain = true;
      try { crossDomain = new URL(handoff.url).hostname !== location.hostname; } catch {}
      // Cross-domain (board → ATS): trust the board's job identity first.
      const enriched = crossDomain
        ? {
            ...(probe?.ctx || ctxFromMeta()),
            ...handoff.ctx,
            title: handoff.ctx.title || probe?.ctx?.title || header?.title || '',
            company: handoff.ctx.company || probe?.ctx?.company || header?.company || '',
            jobUrl: handoff.ctx.jobUrl || probe?.ctx?.jobUrl || location.href,
          }
        : {
            ...handoff.ctx,
            title: probe?.ctx?.title || header?.title || handoff.ctx.title,
            company: probe?.ctx?.company || header?.company || handoff.ctx.company,
          };
      probe = { score: 0.6, ctx: enriched };
      state.source = handoff.source;
      state.externalId = handoff.externalId;
      log('using handoff from', handoff.url, '(crossDomain=' + crossDomain + ')');
    } else if (!probe) {
      const header = inferFromApplyHeader();
      if (header?.title) {
        probe = { score: 0.5, ctx: { ...ctxFromMeta(), title: header.title, company: header.company || ctxFromMeta().company } };
      }
    }
  }

  if (!probe) { log('not a job page (', reason, ')'); return; }

  // Active application FORM on this page → create the entry now and track it
  // through to submit. Works on any ATS/board, in a fresh tab opened by a
  // board's "Apply", with no Apply-click required on this page.
  if (await isApplyPageNow()) {
    enterApplyFlow(probe);
    return;
  }

  // Mid-confidence: ask once instead of silently tracking or silently missing.
  if (probe.score < MIN_PAGE_SCORE) {
    if (!state.settings.askWhenUnsure || state.asked || !IS_TOP) return;
    if (sessionStorage.getItem('jat11.unsureAsked')) return;
    if (!hasApplySignal) return;
    state.asked = true;
    sessionStorage.setItem('jat11.unsureAsked', '1');
    promptUnsure(probe.ctx, {
      onYes: () => acceptContext(probe),
      onNo: async () => {
        try {
          const cur = (await chrome.storage.local.get(SUPPRESS_KEY))[SUPPRESS_KEY] || [];
          if (!cur.includes(location.hostname)) cur.push(location.hostname);
          await chrome.storage.local.set({ [SUPPRESS_KEY]: cur.slice(-200) });
          log('suppressed host', location.hostname);
        } catch {}
      },
    });
    return;
  }

  acceptContext(probe);
}

function acceptContext(probe) {
  state.ctx = probe.ctx;
  if (!state.source) state.source = detectSource();
  if (!state.externalId) state.externalId = detectExternalId();
  if (!state.stage) state.stage = 'detected';
  state.recognitionDone = true;
  log('detected (posting)', { source: state.source, externalId: state.externalId, title: state.ctx.title, company: state.ctx.company });
  storeHandoff();
  paintPanel();   // silent unless panelOnDetect or stage>=started

  if (!state.fired.submitted && (pageTextLooksLikeSuccess() || urlLooksLikeSuccess())) {
    state.fired.started = true;
    fireSubmitted('Loaded on success page');
  }
}

// Is THIS page an active application form (vs. just a job posting we view)?
// Generic across every ATS/board: a real apply form present, or an apply URL
// plus a form, or a board-referred apply URL (fresh handoff).
async function isApplyPageNow() {
  const form = detectApplyForm();
  const onApplyUrl = APPLY_URL_RX.test((location.pathname + location.search + location.hash).toLowerCase());
  if (form && (form.confidence >= 0.45 || (onApplyUrl && form.confidence >= 0.3))) return true;
  if (onApplyUrl) {
    // Board's Apply handed off here recently → trust it even before the SPA
    // form is detectable.
    const h = await loadHandoff();
    if (h && Date.now() - h.ts < 5 * 60 * 1000) return true;
  }
  return false;
}

// Landed on an application page (commonly a fresh tab opened by a board's
// "Apply", e.g. LinkedIn → Workday). There was no Apply click on THIS tab, so
// treat arrival itself as "started" and create the entry immediately — then
// keep capturing through to submit. This is the fix for external-site capture.
function enterApplyFlow(probe) {
  state.ctx = probe.ctx;
  if (!state.source) state.source = detectSource();
  if (!state.externalId) state.externalId = detectExternalId();
  state.recognitionDone = true;

  if (!state.fired.started) {
    state.fired.started = true;
    state.stage = 'started';
    startSuccessTicker();
    storeHandoff();
  }
  log('apply page → entering flow', { source: state.source, externalId: state.externalId, title: state.ctx.title, company: state.ctx.company });

  // Already on a confirmation page?
  if (!state.fired.submitted && (pageTextLooksLikeSuccess() || urlLooksLikeSuccess())) {
    fireSubmitted('Loaded on success page');
    return;
  }
  // Snapshot whatever's already filled, then create/update the entry now.
  const cap = captureFormState('apply-arrival');
  state.stage = cap.hasProgress ? 'progressing' : 'started';
  persistFnf(state.stage, { summary: 'Application page opened' });
  paintPanel();
  setTimeout(() => runProfileAutofill('apply-arrival'), 800);
}

function resetForNewJob(probe) {
  dismissPanel();
  stopSuccessTicker();
  Object.assign(state, {
    ctx: probe.ctx,
    jobId: null,
    externalId: detectExternalId(),
    source: detectSource(),
    stage: 'detected',
    resumeName: null,
    attachments: [],
    answers: {},
    answersCount: 0,
    persisted: false,
    fired: { started: false, submitted: false },
    lastPersistFingerprint: null,
    inflight: null,
    saveState: null,
    lastProgressAt: 0,
    asked: false,
    recognitionDone: true,        // already recognized the new job
    recognitionAttempts: 0,
    autofillBundle: undefined,
  });
  storeHandoff();
  paintPanel();
}

// Clear all state back to dormant (e.g. navigated off jobs entirely).
function hardReset() {
  dismissPanel();
  stopSuccessTicker();
  Object.assign(state, {
    ctx: null, jobId: null, externalId: null, source: null, stage: null,
    resumeName: null, attachments: [], answers: {}, answersCount: 0,
    persisted: false, fired: { started: false, submitted: false },
    lastPersistFingerprint: null, inflight: null, saveState: null,
    lastProgressAt: 0, asked: false,
    recognitionDone: false, recognitionAttempts: 0,
    autofillBundle: undefined,
  });
}

function onAtsHost() { return ATS_HOST_RX.test(location.hostname); }

// True when the URL now points at a DIFFERENT job on the SAME board (e.g. a
// different LinkedIn/Indeed search-result card). This is the fix for the
// "latched onto the first job and never let go" bug — switching cards must
// reset even mid-application, or the new job (and any external apply page it
// opens) gets misfiled under the old one.
function switchedToDifferentJob() {
  if (!state.externalId) return false;
  const newId = detectExternalId();
  return !!newId && newId !== state.externalId && detectSource() === state.source;
}

// ============================================================
// Document harvest — when the user picks a resume/cover-letter file during an
// apply flow, read its bytes and save it into the app's Documents library so it
// shows up on the Documents page. Best-effort: only fires for files the user
// uploads while JAT is watching (an already-uploaded file on an SPA exposes its
// NAME but not its bytes, so those are captured as the resume name only).
// ============================================================
const DOC_FILE_RX = /\.(pdf|docx?|rtf|odt|txt|pages)$/i;
const MAX_HARVEST_BYTES = 8 * 1024 * 1024;   // 8 MB — skip oversized uploads
const HARVEST_KEY = 'jat11.harvestedDocs';   // dedup across sessions (name:size)
const harvestedDocs = new Set();             // dedup within this page

// Persistent dedup: one copy of a given file in the Documents library, even if
// the same resume is uploaded across dozens of applications over many sessions.
async function alreadyHarvested(key) {
  if (harvestedDocs.has(key)) return true;
  try {
    const cur = (await chrome.storage.local.get(HARVEST_KEY))[HARVEST_KEY] || [];
    return cur.includes(key);
  } catch { return false; }
}
async function markHarvested(key) {
  harvestedDocs.add(key);
  try {
    const cur = (await chrome.storage.local.get(HARVEST_KEY))[HARVEST_KEY] || [];
    if (!cur.includes(key)) {
      cur.push(key);
      await chrome.storage.local.set({ [HARVEST_KEY]: cur.slice(-100) });
    }
  } catch {}
}

function uploadFieldContext(input) {
  const bits = [
    input?.name, input?.id,
    input?.getAttribute?.('aria-label'),
    input?.getAttribute?.('data-automation-id'),
    input?.getAttribute?.('title'),
  ];
  try {
    const lab = input?.labels?.[0]?.textContent
      || input?.closest?.('label')?.textContent
      || input?.closest?.('[role="group"], section, fieldset, div')
          ?.querySelector?.('label, h1, h2, h3, [class*="label" i], [class*="title" i]')?.textContent
      || '';
    bits.push(lab);
  } catch {}
  return compactText(bits.filter(Boolean).join(' ')).toLowerCase();
}

async function maybeHarvestDoc(file, input) {
  if (!file || !file.name || !DOC_FILE_RX.test(file.name)) return;
  if (file.size > MAX_HARVEST_BYTES) { log('harvest skip (too big)', file.name, file.size); return; }
  const key = `${file.name}:${file.size}`;

  const ctx = `${uploadFieldContext(input)} ${file.name.toLowerCase()}`;
  const role = /(cover|lettre|motivation)/i.test(ctx) ? 'cover_letter'
    : /(resume|cv|curriculum|résumé)/i.test(ctx) ? 'resume'
    : 'other';

  // Reflect the resume name on the panel regardless of whether we re-save the
  // bytes — the user should always see "which resume" was picked.
  if (role === 'resume') state.resumeName = file.name;
  state.attachments = state.attachments || [];
  if (!state.attachments.some((a) => a.name === file.name)) {
    state.attachments.push({ name: file.name, sizeBytes: file.size, type: file.type || '', role });
  }
  paintPanel();

  // Only push the bytes into the Documents library once per distinct file.
  if (await alreadyHarvested(key)) return;
  await markHarvested(key);

  let dataBase64 = '';
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const CHUNK = 0x7e00;
    for (let i = 0; i < buf.length; i += CHUNK) {
      dataBase64 += btoa(String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK)));
    }
  } catch (e) { log('harvest read failed', e); return; }

  log('harvesting doc →', file.name, `(${role})`);
  send('save-document', {
    name: file.name, role, mime: file.type || '',
    dataBase64, jobUrl: state.ctx?.jobUrl || location.href,
  });
}

// ============================================================
// Reverse autofill — pre-fill a NEW application from the harvested profile.
// Gated by the app's autofill setting (OFF by default). Fills EMPTY fields
// only and NEVER clicks submit. The bundle is fetched once per flow.
// ============================================================
const AUTOFILL_SKIP_RX = /(ethnic|race\b|gender|\bsex\b|disabilit|veteran|criminal|background.*check|felony|conviction|pronoun|ssn|social.?security|date.?of.?birth)/i;

function clientTokens(s) {
  return new Set(String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter((t) => t.length > 2));
}
function matchHarvested(label, fields, minConf) {
  const want = clientTokens(label);
  if (!want.size) return null;
  const floor = minConf || 0.6;
  let best = null, bestScore = 0;
  for (const f of fields) {
    if (!f.value) continue;
    const have = String(f.keyNorm || '').split(' ').filter(Boolean);
    if (!have.length) continue;
    let hit = 0; for (const t of have) if (want.has(t)) hit++;
    if (!hit) continue;
    const covHave = hit / have.length;   // how much of the stored question the field covers
    const covWant = hit / want.size;     // how much of the field IS the stored question
    // Single-token stored keys ("supervisor", "referral") are dangerous: any page
    // label merely containing that word would match. Require the page field to be
    // dominated by it. Multi-token keys need ≥2 shared tokens (mirrors qaLookup).
    const ok = have.length === 1 ? covWant >= 0.6 : (hit >= 2 && covHave >= floor);
    if (!ok) continue;
    const score = (covHave + covWant) / 2;
    if (score > bestScore) { bestScore = score; best = f; }
  }
  return best ? best.value : null;
}
function matchStructured(label, profile, patterns) {
  for (const [rx, field] of patterns) {
    if (rx.test(label) && profile[field] != null && profile[field] !== '') return String(profile[field]);
  }
  return null;
}

async function runProfileAutofill(reason) {
  if (state.fired.submitted) return;
  // Fetch once per flow; undefined = not fetched, null = fetched-but-off/empty.
  // NOTE: the 'api-call' background handler reads method/path at the TOP level of
  // the message (not under .data), so we must NOT use the send(type,data) helper
  // here — send it raw, exactly like loadSettings() does.
  if (state.autofillBundle === undefined) {
    try {
      const r = await new Promise((res) => {
        try {
          chrome.runtime.sendMessage({
            type: 'api-call', method: 'GET',
            path: '/autofill/bundle?source=' + encodeURIComponent(state.source || location.hostname),
          }, (x) => { void chrome.runtime.lastError; res(x); });
        } catch { res(null); }
      });
      state.autofillBundle = (r?.ok && r.enabled) ? r : null;
    } catch { state.autofillBundle = null; }
  }
  const bundle = state.autofillBundle;
  if (!bundle) return;
  const af = bundle.settings || {};
  const profile = bundle.profile?.data || {};
  const fields = bundle.fields || [];
  try {
    const mod = await import(chrome.runtime.getURL('content/autofill.js'));
    const root = detectApplyForm()?.form || document.body || document;
    const engine = new mod.AutofillEngine({});
    const filled = [];
    for (const input of engine.fields(root)) {
      if (!mod.isFillable(input)) continue;
      if (input.tagName === 'SELECT') { if (input.selectedIndex > 0) continue; }
      else if (input.type === 'checkbox' || input.type === 'radio') continue;   // never auto-toggle consents
      else if (input.value && String(input.value).trim()) continue;             // empty fields only
      const label = mod.fieldLabel(input);
      if (!label) continue;
      if (af.skipSensitive !== false && AUTOFILL_SKIP_RX.test(label)) continue;
      let value = (af.fillProfile !== false) ? matchStructured(label, profile, mod.PROFILE_PATTERNS) : null;
      if (value == null && af.fillLearned !== false) value = matchHarvested(label, fields, af.minConfidence);
      if (value == null || value === '') continue;
      try {
        if (input.tagName === 'SELECT') {
          const opt = mod.matchOption(input, String(value));
          if (!opt) continue;
          mod.setNativeValue(input, opt.value);
        } else {
          mod.setNativeValue(input, String(value));
        }
        filled.push(input);
      } catch {}
    }
    if (filled.length) {
      if (af.highlight !== false) flashFilled(filled);
      log('autofill: filled', filled.length, 'field(s) (' + reason + ')');
    }
  } catch (e) { log('autofill failed', e); }
}

function flashFilled(inputs) {
  for (const el of inputs) {
    try {
      const prevOutline = el.style.outline, prevOffset = el.style.outlineOffset;
      el.style.outline = '2px solid #4f9dff';
      el.style.outlineOffset = '1px';
      setTimeout(() => { try { el.style.outline = prevOutline; el.style.outlineOffset = prevOffset; } catch {} }, 1800);
    } catch {}
  }
}

// ============================================================
// Watchers — installed ONCE in init(), active regardless of detection state
// ============================================================
function installWatchers() {
  // ---- clicks (capture phase, shadow-aware) ----
  document.addEventListener('click', async (ev) => {
    const raw = eventTarget(ev);
    const t = closestThroughShadow(raw, 'button, a, [role="button"], input[type="submit"]');
    if (!t) return;
    const txt = (t.textContent || '').trim().slice(0, 80);

    if (!state.ctx && isApplyClick(t)) {
      // Apply clicked on a page we hadn't recognized. Only accept if there's a
      // real job signal here — a recognized page, an actual apply form, or a
      // job-ish URL. Otherwise this is likely an "Apply"/sign-up button on an
      // unrelated page and accepting it would capture noise.
      const probe = recognizePage();
      if (probe) acceptContext(probe);
      else if (detectApplyForm() || urlLooksJobby() > 0) acceptContext({ score: 0.4, ctx: ctxFromMeta() });
    }
    if (!state.ctx) return;

    if (!state.fired.started && isApplyClick(t)) {
      state.fired.started = true;
      state.stage = 'started';
      log('click: APPLY', txt);
      storeHandoff();
      startSuccessTicker();
      paintPanel();   // first visible moment in silent mode
      setTimeout(() => runProfileAutofill('apply-click'), 900);
      return;
    }
    if (isStepAdvanceClick(t)) {
      const cap = captureFormState('step-advance');
      if (cap.hasProgress) {
        state.stage = 'progressing';
        await persist('progressing', { summary: 'Form progress detected' }).catch((e) => log('persist failed', e));
      }
      // Some sites mount the resume/answer DOM only after the click settles —
      // a second pass catches that. Dedup in persist() drops it if unchanged.
      setTimeout(() => {
        const cap2 = captureFormState('step-advance-delayed');
        if (cap2.hasProgress) {
          state.stage = 'progressing';
          persistFnf('progressing', { summary: 'Step settled' });
        } else {
          paintPanel();
        }
        runProfileAutofill('step-advance');   // fill fields revealed by the new step
      }, 500);
      return;
    }
    if (state.fired.started && closestThroughShadow(raw, '[role="dialog"], [aria-modal="true"]')) {
      setTimeout(() => {
        const before = state.resumeName;
        const cap = captureFormState('dialog-click');
        if (cap.hasProgress) {
          state.stage = 'progressing';
          persistFnf('progressing', { summary: 'Dialog interaction captured progress' });
        } else if (state.resumeName !== before) {
          paintPanel();
        }
      }, 250);
    }
    if (isSubmitClickWithPack(t, txt)) {
      log('click: SUBMIT', txt);
      fireSubmitted('Submit clicked');
    }
  }, true);

  // ---- pointerdown: persist high-confidence submits before navigation (C12) ----
  document.addEventListener('pointerdown', (ev) => {
    if (!state.ctx || state.fired.submitted) return;
    const raw = eventTarget(ev);
    const t = closestThroughShadow(raw, 'button, a, [role="button"], input[type="submit"]');
    if (!t) return;
    const txt = (t.textContent || '').trim().slice(0, 80);
    if (isSubmitClickWithPack(t, txt)) {
      log('pointerdown: SUBMIT (early persist)', txt);
      fireSubmitted('Submit pressed');
    }
  }, true);

  // ---- file picks: harvest resume/cover-letter into the Documents library ----
  document.addEventListener('change', (ev) => {
    const input = eventTarget(ev);
    if (!input || input.tagName !== 'INPUT') return;
    if ((input.type || '').toLowerCase() !== 'file' || !input.files || !input.files.length) return;
    // Only while an application is genuinely in progress — avoids hoovering up
    // unrelated uploads on random pages.
    if (!state.ctx && !state.fired.started) return;
    for (const f of input.files) maybeHarvestDoc(f, input).catch((e) => log('harvest failed', e));
  }, true);

  // ---- mutations ----
  let debounce = null;
  let reEvalDebounce = null;
  const obs = new MutationObserver((records) => {
    if (!state.ctx) {
      // Page not classified yet — an ATS SPA may still be rendering its form.
      // Re-attempt recognition as content appears (bounded). This is what lets
      // us catch Workday/Greenhouse/etc. that hydrate after initial load.
      if (!state.recognitionDone && state.recognitionAttempts < 80) {
        clearTimeout(reEvalDebounce);
        reEvalDebounce = setTimeout(() => {
          if (state.ctx || state.recognitionDone) return;
          state.recognitionAttempts++;
          evaluate('mutation-hydrate');
        }, 400);
      }
      return;
    }
    for (const r of records) {
      for (const node of r.addedNodes || []) {
        if (nodeLooksLikeSuccess(node) && !state.fired.submitted && state.fired.started) {
          log('mutation: SUCCESS NODE');
          fireSubmitted('Success node injected');
          return;
        }
      }
    }
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (state.fired.submitted || !state.fired.started) return;
      const cap = captureFormState('mutation-tick');
      if (cap.hasProgress) {
        state.stage = 'progressing';
        persistFnf('progressing', { summary: state.persisted ? 'Form state updated' : 'Resume / answers captured' });
      } else {
        paintPanel();
      }
    }, 350);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  // ---- success re-scan ticker (C8) — armed on Apply, stopped on submit ----
  // (started lazily; see startSuccessTicker / stopSuccessTicker)

  // ---- URL changes (loader + webNavigation both call reboot; this is local) ----
  // Event-driven for back/forward + hash changes (instant + free at rest); a slow
  // 2.5s backstop catches SPA pushState the events miss — instead of a 1.2s poll
  // running forever in every job-board tab the user has open.
  const onUrlMaybeChanged = () => {
    if (location.href === state.lastUrl) return;
    state.lastUrl = location.href;
    onUrlChanged();
  };
  window.addEventListener('popstate', onUrlMaybeChanged);
  window.addEventListener('hashchange', onUrlMaybeChanged);
  urlTickerId = setInterval(onUrlMaybeChanged, 2500);

  // ---- flush state when the tab goes away mid-flow (C12) ----
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    if (!state.ctx || !state.fired.started || state.fired.submitted) return;
    const cap = captureFormState('visibility-flush');
    if (cap.hasProgress) persistFnf('progressing', { summary: 'Tab hidden mid-application' });
  });

  // ---- stop timers when the page is torn down ----
  window.addEventListener('pagehide', () => {
    stopSuccessTicker();
    if (urlTickerId) { clearInterval(urlTickerId); urlTickerId = null; }
  }, { once: true });
}

function isSubmitClickWithPack(el, txt) {
  if (isSubmitClick(el)) return true;
  const pack = sitePack();
  return !!pack?.isSubmitHint?.(txt || '', el);
}

function onUrlChanged() {
  if (!state.ctx) { evaluate('url-change'); return; }

  if (!state.fired.submitted && urlLooksLikeSuccess()) {
    fireSubmitted('URL → success pattern');
    return;
  }

  // Switched to a different job on the same board → reset, even if we'd already
  // started the previous one (it's saved server-side). Without this, browsing
  // from job A to job B on LinkedIn keeps A's identity and misfiles B (and any
  // external apply page B opens) under A.
  if (switchedToDifferentJob()) {
    log('switched to a different job on the board — resetting', { from: state.externalId, to: detectExternalId() });
    const probe = recognizePage();
    if (probe) { resetForNewJob(probe); }
    else { hardReset(); evaluate('switched-job'); }
    return;
  }

  if (state.fired.started || state.persisted) {
    // Same job, or an apply sub-page with no distinct id → intra-application nav.
    const cap = captureFormState('url-mid-flow');
    if (state.persisted && cap.hasProgress) {
      state.stage = 'progressing';
      persistFnf('progressing', { summary: 'Navigated within application' });
    } else {
      paintPanel();
    }
    return;
  }

  // Only 'detected' so far → maybe a different job now (no distinct id case).
  const probe = recognizePage();
  if (!probe || probe.score < MIN_PAGE_SCORE) return;
  const oldKey = normalizeKey(state.ctx?.title) + '|' + normalizeKey(state.ctx?.company);
  const newKey = normalizeKey(probe.ctx.title) + '|' + normalizeKey(probe.ctx.company);
  if (oldKey === newKey) return;
  log('genuinely new job — resetting');
  resetForNewJob(probe);
}

// ============================================================
// Public API (used by loader.js)
// ============================================================
export async function init() {
  if (state.initialized) return;
  state.initialized = true;
  log('engine init @', location.href, IS_TOP ? '(top)' : '(frame)');
  await loadSettings();
  installWatchers();
  await evaluate('init');
  // ATS/job SPAs render their form AFTER document_idle. Re-attempt recognition
  // on a backoff until the page is classified (bounded by recognitionDone).
  for (const delay of [600, 1300, 2600, 5000, 9000, 14000]) {
    setTimeout(() => {
      if (state.ctx || state.recognitionDone) return;
      state.recognitionAttempts++;
      evaluate('retry');
    }, delay);
  }
}

export async function reboot(reason) {
  if (!state.initialized) { await init(); return; }
  if (location.href !== state.lastUrl) {
    state.lastUrl = location.href;
    onUrlChanged();
  } else {
    await evaluate(reason || 'reboot');
  }
}

// Live snapshot for the popup's "this page" card.
export function getPageState() {
  return {
    loaded: true,
    detected: !!state.ctx,
    stage: state.stage || null,
    title: state.ctx?.title || '',
    company: state.ctx?.company || '',
    source: state.source || '',
    persisted: state.persisted,
    saveState: state.saveState,
  };
}

// Manual capture: popup button / context menu. Always persists something.
export async function captureNow({ manual } = {}) {
  const probe = recognizePage() || { score: 0.3, ctx: ctxFromMeta() };
  if (!state.ctx) acceptContext(probe);
  if (!state.stage || state.stage === 'detected') state.stage = 'started';
  state.fired.started = true;
  captureFormState('manual-capture');

  const submitted = pageTextLooksLikeSuccess() || urlLooksLikeSuccess();
  if (submitted) state.fired.submitted = true;
  const stage = submitted ? 'submitted' : 'progressing';
  state.stage = stage;
  const r = await persist(stage, { summary: manual ? 'Manually tracked' : 'Captured' });
  paintPanel();
  return r?.ok
    ? { ok: true, jobId: r.jobId, title: state.ctx?.title, company: state.ctx?.company, stage }
    : { ok: false, queued: !!r?.queued, error: r?.error || 'persist failed' };
}

// Auto-apply executor entry (top frame only; loader enforces).
export async function runTask(task, context) {
  // From here on, the EXECUTOR owns this tab — suppress passive submit detection so a
  // clicked-but-incomplete apply can't be falsely stamped submitted (executor.run does
  // the authoritative PATCH only on a confirmed submit).
  state.autoApplyDriven = true;
  stopSuccessTicker();
  try {
    const mod = await import(chrome.runtime.getURL('content/executor.js'));
    return await mod.run(task, context, {
      captureFormState,
      persist,
      getState: () => state,
    });
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// Auto-apply discovery — scrape an Easy-Apply search-results page for jobs.
export async function runDiscover(opts) {
  try {
    const mod = await import(chrome.runtime.getURL('content/discover.js'));
    return await mod.run(opts);
  } catch (e) {
    return { ok: false, error: String(e?.message || e), jobs: [] };
  }
}
