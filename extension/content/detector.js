// JAT v10 — universal detector.
// Generic pipeline; no per-host adapters. Pipeline persists to DB only when
// there's real signal of investment — `started` alone (Apply click but no
// progress) stays in the panel and is NOT written to the database. Once the
// user picks a resume or fills out the form, status becomes `progressing`
// and the job is upserted. Submission elevates to `submitted`.

import { readJsonLdJobPosting } from './signals/json-ld.js';
import { detectApplyForm, detectAttachments, snapshotAnswers, findCompanyLink, findResumeFilename, inferFromApplyHeader } from './signals/forms.js';
import { isApplyClick, isSubmitClick, isStepAdvanceClick } from './signals/intent.js';
import { pageTextLooksLikeSuccess, urlLooksLikeSuccess, nodeLooksLikeSuccess } from './signals/success.js';
import { renderPanel, dismissPanel } from './panel.js';

const MIN_PAGE_SCORE = 0.35;
const TAG = '[JAT]';
const HANDOFF_KEY = 'jat10.lastJobContext';
const HANDOFF_TTL_MS = 10 * 60 * 1000;     // 10 minutes
const log = (...args) => console.log(TAG, ...args);
const send = (type, data) => new Promise((res) => chrome.runtime.sendMessage({ type, data }, res));

async function storeHandoff() {
  try {
    await chrome.storage.local.set({
      [HANDOFF_KEY]: { ctx: state.ctx, source: state.source, externalId: state.externalId, ts: Date.now(), url: location.href },
    });
    log('handoff stored', { source: state.source, externalId: state.externalId });
  } catch {}
}
async function loadHandoff() {
  try {
    const s = (await chrome.storage.local.get(HANDOFF_KEY))[HANDOFF_KEY];
    if (!s || Date.now() - s.ts > HANDOFF_TTL_MS) return null;
    return s;
  } catch { return null; }
}

const state = {
  ctx: null,
  jobId: null,
  externalId: null,
  source: null,
  stage: null,           // 'detected' | 'started' | 'progressing' | 'submitted'
  resumeName: null,
  attachments: [],
  answers: {},
  answersCount: 0,
  persisted: false,      // becomes true on first DB write
  fired: { started: false, submitted: false },
  lastUrl: location.href,
};

// ============================================================
// PHASE 1 — page recognition
// ============================================================
function detectSource() {
  const h = location.hostname.replace(/^www\./, '');
  if (/linkedin\.com$/.test(h))             return 'linkedin';
  if (/indeed\.([a-z.]+)$/.test(h))         return 'indeed';
  if (/glassdoor\.([a-z.]+)$/.test(h))      return 'glassdoor';
  if (/greenhouse\.io$/.test(h))            return 'greenhouse';
  if (/lever\.co$/.test(h))                 return 'lever';
  if (/myworkdayjobs\.com$/.test(h))        return 'workday';
  if (/ashbyhq\.com$/.test(h))              return 'ashby';
  if (/workable\.com$/.test(h))             return 'workable';
  if (/bamboohr\.com$/.test(h))             return 'bamboohr';
  if (/smartrecruiters\.com$/.test(h))      return 'smartrecruiters';
  return h;
}

function detectExternalId() {
  const u = new URL(location.href);
  const cur = u.searchParams.get('currentJobId');
  if (cur) return cur;
  const m1 = u.pathname.match(/\/jobs\/view\/(\d+)/);
  if (m1) return m1[1];
  const m2 = u.pathname.match(/\/job\/([\w-]+)/);
  if (m2) return m2[1];
  const ind = u.searchParams.get('jk') || u.searchParams.get('jobKey');
  if (ind) return ind;
  return null;
}

function urlLooksJobby() {
  // Substring match — far more permissive than the previous /-segment regex.
  // Catches `/viewjob` (Indeed listing), `/indeedapply/` (Indeed apply form),
  // `/smartapply/`, `/easy-apply/`, `/jobs/`, `/careers/`, etc. False
  // positives are filtered out by the page-score gate downstream.
  const p = location.pathname.toLowerCase();
  if (/(jobs?|career|position|opening|vacanc|apply|application|posting|hiring|recruit|smartapply|viewjob)/.test(p)) return 0.4;
  return 0;
}
function titleLooksJobby() {
  return /job|career|hiring|position|opening|apply|engineer|developer|designer|manager/i.test(document.title || '') ? 0.15 : 0;
}

function recognizePage() {
  let score = 0;
  let ctx = null;
  const jp = readJsonLdJobPosting();
  if (jp) {
    score += jp.confidence;
    ctx = jp.context;
    log('json-ld jobposting →', ctx);
  }
  const urlScore = urlLooksJobby();
  const titleScore = titleLooksJobby();
  // A high-confidence apply form on the page is itself a strong signal that
  // this is job-related — even when the URL/title look generic and JSON-LD
  // is missing (smartapply.indeed.com, greenhouse.io/apply, etc.).
  const applyFormProbe = detectApplyForm();
  const formScore = applyFormProbe?.confidence >= 0.5 ? 0.5 : 0;
  score += urlScore + titleScore + formScore;
  log('page score', { score, jsonLd: !!jp, urlScore, titleScore, formScore });
  if (score < MIN_PAGE_SCORE) return null;
  if (!ctx) ctx = ctxFromMeta();
  // Always overlay generic DOM fallbacks on top — JSON-LD is sometimes
  // partial (no company name on LinkedIn search-results view, for example).
  if (!ctx.company || ctx.company === location.hostname.replace(/^www\./, '').split('.')[0]) {
    const fromDom = findCompanyLink();
    if (fromDom) { log('company recovered from DOM /company link →', fromDom); ctx.company = fromDom; }
  }
  if (!ctx.title) {
    const h1 = document.querySelector('h1');
    if (h1) ctx.title = h1.textContent.trim().slice(0, 200);
  }
  ctx.jobUrl = ctx.jobUrl || location.href;
  return { score, ctx };
}

function ctxFromMeta() {
  const og = (p) => document.querySelector(`meta[property="og:${p}"]`)?.content || '';
  const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.content || '';
  const title = og('title') || document.title.split(/[|·-]/)[0].trim() || '';
  const company = og('site_name') || meta('author') || location.hostname.replace(/^www\./, '').split('.')[0];
  const description = (og('description') || meta('description') || '').slice(0, 4000);
  return { title, company, location: '', description, compensation: '', workMode: '', employmentType: '' };
}

// ============================================================
// PIPELINE EVENTS
// ============================================================
async function persist(stage, extra = {}) {
  if (!state.ctx) { log('persist skipped — no ctx'); return; }
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
  log('→ POST /jobs', { stage, title: payload.job.title, company: payload.job.company, attachments: state.attachments.length });
  const r = await send('pipeline-event', payload).catch((e) => ({ ok: false, error: String(e) }));
  log('← response', r);
  if (r?.ok && r?.jobId) { state.jobId = r.jobId; state.persisted = true; }
}

function paintPanel() {
  renderPanel({
    stage: state.stage,
    ctx: state.ctx,
    resumeName: state.resumeName,
    attachments: state.attachments,
    answersCount: state.answersCount,
  });
}

function captureFormState(reason) {
  const formProbe = detectApplyForm();
  const root = formProbe?.form || document;
  const attachments = detectAttachments(root);
  // Fallback: scan visible text for a resume filename when no file input has files
  if (!attachments.length) {
    const guessed = findResumeFilename(root);
    if (guessed) {
      attachments.push({ name: guessed, sizeBytes: 0, type: '', role: 'resume' });
      log('resume guessed from text →', guessed);
    }
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
  log('captureFormState', { reason, attachments: state.attachments.length, answers: state.answersCount, formScore: formProbe?.confidence });
  return { attachments, answers, hasProgress: state.attachments.length > 0 || state.answersCount > 0 };
}

// ============================================================
// Boot
// ============================================================
async function boot() {
  log('boot @', location.href);
  let probe = recognizePage();

  // ---- Cross-domain handoff fallback ----
  // If the page doesn't recognize on its own (no JSON-LD, no /jobs URL — i.e.
  // smartapply.indeed.com after Indeed opened a new tab), pull the context
  // we stored from the previous job-listing page. We use the handoff anytime
  // there's *any* apply signal — apply URL pattern, apply form on the page,
  // or success text. Without one of those signals the handoff isn't safe to
  // apply (we'd contaminate random pages).
  const applyFormHere = detectApplyForm();
  const hasApplySignal = (
    urlLooksJobby() > 0
    || pageTextLooksLikeSuccess()
    || urlLooksLikeSuccess()
    || (applyFormHere?.confidence >= 0.5)
  );
  if ((!probe || !probe.ctx.title || !probe.ctx.company) && hasApplySignal) {
    const handoff = await loadHandoff();
    if (handoff) {
      const header = inferFromApplyHeader();
      const enriched = {
        ...handoff.ctx,
        title:    probe?.ctx?.title   || header?.title   || handoff.ctx.title,
        company:  probe?.ctx?.company || header?.company || handoff.ctx.company,
      };
      probe = { score: 0.6, ctx: enriched };
      log('using handoff context from', handoff.url, '→', enriched);
      state.source = handoff.source;
      state.externalId = handoff.externalId;
    } else if (!probe) {
      const header = inferFromApplyHeader();
      if (header?.title) {
        probe = { score: 0.5, ctx: { ...ctxFromMeta(), title: header.title, company: header.company || ctxFromMeta().company } };
        log('using apply-form header alone →', probe.ctx);
      }
    }
  }

  if (!probe) { log('boot: not a job page; dormant'); return; }

  state.ctx = probe.ctx;
  if (!state.source) state.source = detectSource();
  if (!state.externalId) state.externalId = detectExternalId();
  state.stage = 'detected';
  log('boot: detected', { source: state.source, externalId: state.externalId, ctx: state.ctx });
  storeHandoff();      // cache for the next page in the apply flow
  paintPanel();
  installWatchers();
}

function installWatchers() {
  // ---- Click watcher (apply intent + submit) ----
  document.addEventListener('click', async (ev) => {
    const t = ev.target?.closest?.('button, a, [role="button"], input[type="submit"]');
    if (!t) return;
    const txt = (t.textContent || '').trim().slice(0, 80);

    if (!state.fired.started && isApplyClick(t)) {
      state.fired.started = true;
      state.stage = 'started';
      log('click: APPLY', { text: txt });
      // NO DB write yet — panel only. We persist on first progress signal.
      paintPanel();
      return;
    }
    if (isStepAdvanceClick(t)) {
      log('click: STEP', { text: txt });
      // First pass immediately, second pass after DOM settles (some sites
      // mount the resume name into the DOM only after the click takes effect).
      const cap = captureFormState('step-advance');
      setTimeout(() => {
        const cap2 = captureFormState('step-advance-delayed');
        if (cap2.hasProgress && !state.persisted) {
          state.stage = 'progressing';
          persist('progressing', { summary: 'Form progress detected (post-step)' });
        } else if (state.persisted && (cap2.attachments.length || Object.keys(cap2.answers).length)) {
          state.stage = 'progressing';
          persist('progressing', { summary: 'Step advanced (delayed catch)' });
        }
      }, 500);
      if (cap.hasProgress && !state.persisted) {
        state.stage = 'progressing';
        await persist('progressing', { summary: 'Form progress detected' });
      } else if (state.persisted) {
        state.stage = 'progressing';
        await persist('progressing', { summary: 'Step advanced' });
      } else {
        paintPanel();
      }
      return;
    }
    // Any other click inside an apply dialog → try a lightweight resume
    // re-scan. LinkedIn's "click a resume card to select" doesn't surface
    // as a step-advance or submit, but it does update the DOM with the
    // selected filename. Cheap to retry.
    if (state.fired.started && t.closest('[role="dialog"], [aria-modal="true"]')) {
      setTimeout(() => {
        const before = state.resumeName;
        captureFormState('dialog-click');
        if (state.resumeName !== before) {
          log('resume name updated post-click →', state.resumeName);
          paintPanel();
        }
      }, 250);
    }
    if (isSubmitClick(t)) {
      log('click: SUBMIT', { text: txt });
      captureFormState('submit-click');
      if (!state.fired.submitted) {
        state.fired.submitted = true;
        state.stage = 'submitted';
        await persist('submitted', { summary: 'Submit clicked' });
      }
    }
  }, true);

  // ---- DOM mutation watcher ----
  let debounce = null;
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes || []) {
        if (nodeLooksLikeSuccess(node) && !state.fired.submitted) {
          log('mutation: SUCCESS NODE');
          state.fired.submitted = true;
          state.stage = 'submitted';
          captureFormState('success-injected');
          persist('submitted', { summary: 'Success node injected' });
          return;
        }
      }
    }
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (state.fired.submitted) return;
      const cap = captureFormState('mutation-tick');
      // If we just discovered a resume/answers and haven't persisted yet,
      // upgrade to progressing.
      if (cap.hasProgress && state.fired.started && !state.persisted) {
        state.stage = 'progressing';
        log('auto-progress: resume/answers appeared post-Apply');
        persist('progressing', { summary: 'Resume / answers captured' });
      } else {
        paintPanel();
      }
    }, 350);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  // ---- SPA URL change watcher ----
  setInterval(() => {
    if (location.href === state.lastUrl) return;
    log('url changed', { from: state.lastUrl, to: location.href });
    state.lastUrl = location.href;

    // Success URL during an active flow → fire submitted
    if (!state.fired.submitted && urlLooksLikeSuccess()) {
      state.fired.submitted = true;
      state.stage = 'submitted';
      captureFormState('url-success');
      persist('submitted', { summary: 'URL → success pattern' });
      return;
    }

    // CRITICAL: never reset state mid-application. Once user has clicked
    // Apply OR we've persisted a record, every URL change is just an
    // intra-flow navigation (form step, validation page, etc.) — keep the
    // identity (source, externalId, jobId) intact so dedup works.
    if (state.fired.started || state.persisted) {
      log('url changed mid-flow — keeping state intact');
      // Refresh the captured state so the panel reflects the latest DOM
      captureFormState('url-mid-flow');
      paintPanel();
      return;
    }

    // Otherwise (only stage='detected', no apply click yet), see if it's a
    // genuinely different job and re-detect. Use normalized comparison so
    // tiny title differences (capitalization, whitespace) don't trip a reset.
    const probe = recognizePage();
    if (!probe) return;
    const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const oldKey = normalize(state.ctx?.title) + '|' + normalize(state.ctx?.company);
    const newKey = normalize(probe.ctx.title)  + '|' + normalize(probe.ctx.company);
    if (oldKey === newKey) { log('url changed but same job — keep state'); return; }
    log('genuinely new job — resetting');
    dismissPanel();
    Object.assign(state, {
      ctx: probe.ctx, jobId: null,
      externalId: detectExternalId(), source: detectSource(),
      stage: 'detected', resumeName: null, attachments: [],
      answers: {}, answersCount: 0, persisted: false,
      fired: { started: false, submitted: false },
    });
    storeHandoff();
    paintPanel();
  }, 1200);

  // ---- Load-on-success-page check ----
  if (!state.fired.submitted && (pageTextLooksLikeSuccess() || urlLooksLikeSuccess())) {
    log('boot landed on success page');
    state.fired.submitted = true;
    state.stage = 'submitted';
    persist('submitted', { summary: 'Loaded on success page' });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
