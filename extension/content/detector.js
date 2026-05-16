// JAT v10 — universal detector.
// Generic pipeline that works on every site (no per-host adapters):
//
//   PHASE 1 — page recognition
//     Score the page against JSON-LD JobPosting + URL/title heuristics.
//     If score >= MIN_PAGE_SCORE, this is "probably a job page" — wake up.
//     Otherwise stay dormant; re-check on SPA URL changes.
//
//   PHASE 2 — apply intent
//     Click handler at document level. Click on element matching the apply
//     vocabulary → fire 'started' to background, render panel.
//
//   PHASE 3 — in-progress capture
//     While the apply form/dialog is open, snapshot attachments + answers
//     on every step-advance click. Each snapshot upserts the job (forward-
//     only) so the database always reflects the latest known state.
//
//   PHASE 4 — submitted
//     Three independent detectors: success text in DOM, success URL pattern,
//     submit-button click. Any one fires 'submitted' once.
//
// All sends go through chrome.runtime.sendMessage({ type: 'pipeline-event' })
// to background.js, which proxies to localhost:7744.

import { readJsonLdJobPosting } from './signals/json-ld.js';
import { detectApplyForm, detectAttachments, snapshotAnswers } from './signals/forms.js';
import { isApplyClick, isSubmitClick, isStepAdvanceClick } from './signals/intent.js';
import { pageTextLooksLikeSuccess, urlLooksLikeSuccess, nodeLooksLikeSuccess } from './signals/success.js';
import { renderPanel, dismissPanel } from './panel.js';

const MIN_PAGE_SCORE = 0.35;
const send = (type, data) => new Promise((res) => chrome.runtime.sendMessage({ type, data }, res));

// Track state per page-load. SPA URL changes reset some of it.
const state = {
  ctx: null,
  jobId: null,           // set after first upsert
  externalId: null,
  source: null,
  stage: null,           // 'detected' | 'started' | 'progressing' | 'submitted'
  resumeName: null,
  attachments: [],
  answersCount: 0,
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
  return h; // unknown ATS / company career page — keep the hostname as source
}

function detectExternalId() {
  const u = new URL(location.href);
  // LinkedIn job-id patterns
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
  const p = location.pathname;
  if (/\/(jobs?|career|careers|position|opening|vacancies|apply|application)(\/|$)/i.test(p)) return 0.4;
  return 0;
}
function titleLooksJobby() {
  const t = document.title || '';
  if (/job|career|hiring|position|opening|apply|engineer|developer|designer|manager/i.test(t)) return 0.15;
  return 0;
}

function recognizePage() {
  let score = 0;
  let ctx = null;
  const jp = readJsonLdJobPosting();
  if (jp) { score += jp.confidence; ctx = jp.context; }
  score += urlLooksJobby();
  score += titleLooksJobby();

  if (score < MIN_PAGE_SCORE) return null;

  if (!ctx) {
    // No JSON-LD — fall back to <title> + heuristic metadata
    ctx = ctxFromMeta();
  }
  ctx.jobUrl = ctx.jobUrl || location.href;
  return { score, ctx };
}

function ctxFromMeta() {
  const og = (p) => document.querySelector(`meta[property="og:${p}"]`)?.content || '';
  const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.content || '';
  const title = og('title') || document.title.split(/[|·-]/)[0].trim() || '';
  // Best-effort company name: <meta og:site_name>, then domain
  const company = og('site_name') || meta('author') || location.hostname.replace(/^www\./, '').split('.')[0];
  const description = (og('description') || meta('description') || '').slice(0, 4000);
  return { title, company, location: '', description, compensation: '', workMode: '', employmentType: '' };
}

// ============================================================
// PHASE 2/3/4 — pipeline events
// ============================================================
async function firePipelineEvent(stage, extra = {}) {
  if (!state.ctx) return;
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
      answers: extra.answers || undefined,
    },
    eventType: stage,
    summary: extra.summary || '',
  };
  const r = await send('pipeline-event', payload).catch(() => null);
  if (r?.ok && r?.jobId) state.jobId = r.jobId;
  renderPanel({
    stage,
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
  const answers = snapshotAnswers(root);
  if (attachments.length) {
    state.attachments = attachments;
    const resume = attachments.find((a) => a.role === 'resume') || attachments[0];
    state.resumeName = resume?.name || state.resumeName;
  }
  if (Object.keys(answers).length) state.answersCount = Object.keys(answers).length;
  return { attachments, answers };
}

// ============================================================
// Boot
// ============================================================
function boot() {
  const probe = recognizePage();
  if (!probe) return; // not a job page — stay dormant
  state.ctx = probe.ctx;
  state.source = detectSource();
  state.externalId = detectExternalId();
  state.stage = 'detected';
  renderPanel({
    stage: 'detected',
    ctx: state.ctx,
    resumeName: null,
    attachments: [],
    answersCount: 0,
  });
  installWatchers();
}

function installWatchers() {
  // ---- Click watcher (apply intent + submit) ----
  document.addEventListener('click', async (ev) => {
    const t = ev.target?.closest?.('button, a, [role="button"], input[type="submit"]');
    if (!t) return;

    if (!state.fired.started && isApplyClick(t)) {
      state.fired.started = true;
      state.stage = 'started';
      await firePipelineEvent('started', { summary: 'Apply clicked' });
      return;
    }
    if (isStepAdvanceClick(t)) {
      const { answers } = captureFormState('step-advance');
      state.stage = 'progressing';
      await firePipelineEvent('progressing', { answers, summary: 'Step advanced' });
      return;
    }
    if (isSubmitClick(t)) {
      const { answers } = captureFormState('submit-click');
      if (!state.fired.submitted) {
        state.fired.submitted = true;
        state.stage = 'submitted';
        await firePipelineEvent('submitted', { answers, summary: 'Submit clicked' });
      }
    }
  }, true);

  // ---- DOM mutation watcher (success node injection + late-loading apply forms) ----
  let debounce = null;
  const obs = new MutationObserver((records) => {
    // Fast path: a success node just appeared
    for (const r of records) {
      for (const node of r.addedNodes || []) {
        if (nodeLooksLikeSuccess(node) && !state.fired.submitted) {
          state.fired.submitted = true;
          state.stage = 'submitted';
          firePipelineEvent('submitted', { summary: 'Success node injected' });
          return;
        }
      }
    }
    // Slow path: maybe an apply form just rendered (modal). Recapture file inputs.
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (state.fired.submitted) return;
      const { attachments } = captureFormState('mutation');
      if (attachments.length && state.stage === 'started') {
        state.stage = 'progressing';
        firePipelineEvent('progressing', { summary: 'Resume attached' });
      } else if (state.stage === 'detected' || state.stage === 'started') {
        // Just update the panel with the current state without re-firing.
        renderPanel({
          stage: state.stage,
          ctx: state.ctx,
          resumeName: state.resumeName,
          attachments: state.attachments,
          answersCount: state.answersCount,
        });
      }
    }, 250);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  // ---- URL change watcher (SPA navigation) ----
  setInterval(() => {
    if (location.href === state.lastUrl) return;
    state.lastUrl = location.href;
    // If URL flipped to a success pattern, fire submitted
    if (!state.fired.submitted && urlLooksLikeSuccess()) {
      state.fired.submitted = true;
      state.stage = 'submitted';
      firePipelineEvent('submitted', { summary: 'URL → success pattern' });
      return;
    }
    // Otherwise, re-recognize. Different job → reset state.
    const probe = recognizePage();
    if (probe && (probe.ctx.title !== state.ctx?.title || probe.ctx.company !== state.ctx?.company)) {
      // New job: reset and fire 'detected' again
      dismissPanel();
      Object.assign(state, {
        ctx: probe.ctx, jobId: null,
        externalId: detectExternalId(), source: detectSource(),
        stage: 'detected', resumeName: null, attachments: [], answersCount: 0,
        fired: { started: false, submitted: false },
      });
      renderPanel({
        stage: 'detected', ctx: state.ctx,
        resumeName: null, attachments: [], answersCount: 0,
      });
    }
  }, 1200);

  // ---- One-time check: maybe the page already shows a success state (e.g. refresh after submit) ----
  if (!state.fired.submitted && (pageTextLooksLikeSuccess() || urlLooksLikeSuccess())) {
    state.fired.submitted = true;
    state.stage = 'submitted';
    firePipelineEvent('submitted', { summary: 'Loaded on success page' });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
