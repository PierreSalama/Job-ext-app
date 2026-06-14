// JAT v11 — auto-apply executor.
// Rebuilt from the v9 RPA skeleton with the pieces it lacked:
//  • answer ladder: profile → learned qa store → AI (/ai/answer-question,
//    confidence-gated, refusal-aware) → pause for the human
//  • real file uploads via DataTransfer-constructed File objects (the v9
//    hard wall — solvable now that resumes live in the desktop app)
//  • review mode (default): walks to the FINAL submit and stops for Pierre
//  • captcha / login detection → awaiting_input, never bypassed
//  • full transcript reported to the app's queue (PATCH /queue/:id)
//
// Safety invariants: explicit overlay with Pause/Stop/Esc at all times; max 25
// steps; AI answers must be grounded (refuse → pause); work-auth/EEO/legal
// questions only ever come from the profile, never the AI (enforced by the
// prompt server-side AND a local guard here).

import { AutofillEngine, setNativeValue, fieldLabel } from './autofill.js';
import { detectApplyForm } from './signals/forms.js';
import { isSubmitClick } from './signals/intent.js';
import { pageTextLooksLikeSuccess, urlLooksLikeSuccess } from './signals/success.js';
import { qsa, isProbablyVisible, compactText } from './lib/dom.js';

const MAX_STEPS = 40;
const STEP_TIMEOUT = 9000;
const LEGAL_RX = /(work.*authoriz|sponsor|visa|citizen|clearance|ethnic|race|gender|disabilit|veteran|criminal|background.*check)/i;
// Demographic / sensitive fields we NEVER auto-fill from any source (not even
// the profile) — the user must consciously answer these in the form. Work
// authorization / sponsorship / citizenship stay fillable (that's the profile's
// purpose); this list is the EEO + criminal-history subset only.
const NEVER_AUTOFILL_RX = /(ethnic|race\b|gender|\bsex\b|disabilit|veteran|criminal|background.*check|felony|conviction|pronoun)/i;
const CAPTCHA_RX = /captcha|verify (that )?you('| a)re (a )?human|unusual activity|are you a robot/i;
const ADVANCE_KEYWORDS = [
  /^submit application$/i, /^submit$/i, /^submit & continue$/i,
  /^review your application$/i, /^review$/i,
  /^next$/i, /^continue$/i, /^continue to/i, /^proceed/i,
  /^save and continue$/i, /^save & continue$/i,
  /^finish$/i, /^apply now$/i, /^apply$/i, /^easy apply/i,
  /^send application$/i, /^suivant$/i, /^continuer$/i, /^soumettre$/i, /^postuler$/i,
];
const FINAL_SUBMIT_RX = /^(submit( application)?|send( application)?|soumettre|envoyer( ma candidature)?|confirm and submit)$/i;

// ---- relevance / fit (mirror of server jobFit + a page "needs N years" scan) ----
function jobLevel(title) {
  const t = String(title || '').toLowerCase();
  if (/\b(staff|principal|architect|manager|mgr|director|head of|vp|vice president|chief)\b/.test(t)
      || /\b(?:tech|technical|team|engineering|dev|development|squad)\s+lead\b/.test(t)
      || /\blead\s+(?:software|develop|engineer|back|front|full|data|ml|devops|sdet|qa|cloud|platform)/.test(t)) return 4;
  if (/\b(senior|sr\.?|sr)\b/.test(t)) return 3;
  if (/\b(intern(ship)?|co-?op|junior|jr\.?|entry[- ]?level|new ?grad|graduate|apprentice|trainee|student)\b/.test(t)) return 1;
  return 2;
}
const SENIORITY_CAP = { any: 99, senior: 3, mid: 2, entry: 1 };
// Largest "N years of experience" the page demands (experience-context only, to
// avoid counting unrelated numbers). Returns 0 if none found.
function requiredYears(text) {
  const t = String(text || '').toLowerCase().slice(0, 16000);
  const re = /(?:(\d{1,2})\s*\+?\s*(?:years?|yrs?)\s*(?:of\s*)?(?:experience|exp\b))|(?:experience[^.\n]{0,24}?(\d{1,2})\s*\+?\s*(?:years?|yrs?))/g;
  let m, max = 0;
  while ((m = re.exec(t))) { const n = Number(m[1] || m[2]); if (n >= 1 && n <= 25 && n > max) max = n; }
  return max;
}
function checkFit(title, pageText, fit) {
  if (!fit) return null;
  const cap = SENIORITY_CAP[fit.seniorityMax] ?? 99;
  if (jobLevel(title) > cap) return `role looks above your level cap (${fit.seniorityMax})`;
  const tl = String(title || '').toLowerCase();
  for (const kw of fit.excludeKeywords || []) { const k = String(kw || '').trim().toLowerCase(); if (k && tl.includes(k)) return `excluded keyword "${k}"`; }
  const yrs = Number(fit.experienceYears) || 0;
  if (yrs > 0) { const req = requiredYears(pageText); if (req && req > yrs + 3) return `needs ~${req} yrs experience (you set ${yrs})`; }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (msg) => new Promise((res) => {
  try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); }); }
  catch { res(null); }
});

const S = {
  running: false, paused: false, cancelled: false,
  step: 0, overlay: null, task: null, context: null,
};

// ============================================================
// Overlay (v9 UX, atelier palette)
// ============================================================
function injectStyles() {
  if (document.getElementById('jat11-aa-style')) return;
  const s = document.createElement('style');
  s.id = 'jat11-aa-style';
  s.textContent = `
    #jat11-aa {
      position: fixed; bottom: 24px; left: 24px; z-index: 2147483647;
      width: 380px; padding: 16px;
      background: rgba(10,10,10,0.97);
      border: 1px solid #3a342d; border-left: 2px solid #b08a5a;
      box-shadow: 0 20px 60px rgba(0,0,0,0.55);
      color: #f4efe6; font: 500 13px "Inter", -apple-system, "Segoe UI", system-ui, sans-serif;
    }
    #jat11-aa .h { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-size: 11px; letter-spacing: 0.25em; text-transform: uppercase; color: #b08a5a; }
    #jat11-aa .h .pulse { width: 8px; height: 8px; border-radius: 50%; background: #b08a5a; animation: jat11pulse 1.4s ease-out infinite; }
    @keyframes jat11pulse { 0% { box-shadow: 0 0 0 0 rgba(176,138,90,0.6); } 100% { box-shadow: 0 0 0 12px rgba(176,138,90,0); } }
    #jat11-aa .status { font-size: 12px; color: #d9d2c6; margin-bottom: 8px; min-height: 16px; }
    #jat11-aa .log {
      font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: #8b8378;
      max-height: 110px; overflow-y: auto; background: rgba(0,0,0,0.35); padding: 6px 8px; margin-bottom: 10px;
      border: 1px solid #241f1a;
    }
    #jat11-aa .log div { margin: 2px 0; }
    #jat11-aa .log .ok { color: #7fae7f; }
    #jat11-aa .log .warn { color: #b08a5a; }
    #jat11-aa .log .err { color: #c25b5b; }
    #jat11-aa .row { display: flex; gap: 6px; }
    #jat11-aa button {
      flex: 1; padding: 8px 10px; font: inherit; font-size: 10px; font-weight: 500;
      letter-spacing: 0.2em; text-transform: uppercase; cursor: pointer;
      border: 1px solid #3a342d; background: transparent; color: #8b8378;
    }
    #jat11-aa button:hover { color: #b08a5a; border-color: #b08a5a; }
    #jat11-aa button.danger:hover { color: #c25b5b; border-color: #c25b5b; }
  `;
  document.head.appendChild(s);
}

function showOverlay(title) {
  injectStyles();
  if (S.overlay) return;
  const el = document.createElement('div');
  el.id = 'jat11-aa';
  el.innerHTML = `
    <div class="h"><span class="pulse"></span><span>JAT · Auto-apply</span></div>
    <div class="status" id="jat11-aa-status">${title || 'Starting…'}</div>
    <div class="log" id="jat11-aa-log"></div>
    <div class="row">
      <button id="jat11-aa-pause">Pause</button>
      <button class="danger" id="jat11-aa-stop">Stop</button>
    </div>
  `;
  document.body.appendChild(el);
  S.overlay = el;
  el.querySelector('#jat11-aa-stop').addEventListener('click', () => cancel('user'));
  el.querySelector('#jat11-aa-pause').addEventListener('click', (e) => {
    S.paused = !S.paused;
    e.currentTarget.textContent = S.paused ? 'Resume' : 'Pause';
  });
  if (!window.__jat11_aa_esc) {
    window.__jat11_aa_esc = (e) => { if (e.key === 'Escape' && S.running) cancel('escape'); };
    window.addEventListener('keydown', window.__jat11_aa_esc);
  }
}
function hideOverlay(afterMs = 4000) {
  setTimeout(() => { S.overlay?.remove(); S.overlay = null; }, afterMs);
}
function setStatus(s) {
  const el = S.overlay?.querySelector('#jat11-aa-status');
  if (el) el.textContent = s;
}
function logLine(level, text) {
  const log = S.overlay?.querySelector('#jat11-aa-log');
  if (log) {
    const d = document.createElement('div');
    d.className = level;
    d.textContent = `[${S.step}] ${text}`;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }
  report({ transcriptAppend: { step: S.step, level, text: String(text).slice(0, 300) } });
}
function cancel(reason) {
  if (!S.running) return;
  S.cancelled = true;
  setStatus(`Stopped (${reason})`);
  report({ state: 'skipped', transcriptAppend: { note: `stopped by ${reason}` } });
}

let reportQueue = Promise.resolve();
function report(patch) {
  if (!S.task) return;
  reportQueue = reportQueue.then(() =>
    send({ type: 'task-progress', taskId: S.task.id, patch })).catch(() => {});
}

// ============================================================
// Helpers
// ============================================================
function domHash() {
  return `${(document.body?.innerText || '').length}|${location.href}|${qsa('input,select,textarea,button').length}`;
}

async function untilUnpaused() {
  while (S.paused && !S.cancelled) await sleep(200);
}

async function waitForChange(initialHash, timeoutMs = STEP_TIMEOUT) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (S.cancelled) return false;
    if (domHash() !== initialHash) return true;
    await sleep(180);
  }
  return false;
}

function captchaOrLoginPresent() {
  const text = (document.body?.innerText || '').slice(0, 6000);
  if (CAPTCHA_RX.test(text)) return 'captcha';
  if (document.querySelector('iframe[src*="captcha" i], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i]')) return 'captcha';
  const pw = qsa('input[type="password"]').filter(isProbablyVisible);
  if (pw.length && /log\s*in|sign\s*in|se connecter/i.test(text.slice(0, 2500))) return 'login';
  return null;
}

function btnText(el) {
  // LinkedIn's modal Next/Review/Submit buttons are often icon-only with the
  // real label in aria-label, so include it.
  return compactText(el?.getAttribute?.('aria-label') || el?.textContent || el?.value || '');
}
function looksLikeAdvance(el) {
  if (!el || el.disabled || !isProbablyVisible(el)) return false;
  const text = btnText(el);
  if (!text || text.length > 40) return false;
  return ADVANCE_KEYWORDS.some((re) => re.test(text));
}

function findAdvanceButton(root) {
  for (const el of qsa('button, input[type="submit"], a[role="button"], [role="button"]', root || document)) {
    if (looksLikeAdvance(el)) return el;
  }
  return null;
}

// LinkedIn's "Easy Apply" button on the job-view page (before the modal opens).
// Matched by its known classes + an "easy apply" label so we never click an
// external "Apply" button (which leaves LinkedIn). Used to OPEN the form when the
// generic advance scan misses it (some postings render an icon/badged button).
function findEasyApplyButton() {
  const sel = 'button.jobs-apply-button, .jobs-apply-button--top-card button, [data-live-test-job-apply-button], button[aria-label*="easy apply" i], button[aria-label*="candidature simpli" i]';
  for (const el of qsa(sel)) {
    if (!el || el.disabled || !isProbablyVisible(el)) continue;
    const label = (btnText(el) + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
    if (/easy apply|candidature simpli/.test(label)) return el;
  }
  return null;
}

function isFinalSubmit(el) {
  return FINAL_SUBMIT_RX.test(btnText(el)) || isSubmitClick(el);
}

// After clicking a final submit, the application is "sent" when the page shows a
// real success confirmation (text or URL — reuses the maintained EN/FR signals in
// success.js) OR, only when we actually had a real field-bearing apply modal open,
// that modal closes with no apply form left and no captcha/login. We poll instead
// of checking once (the banner renders a beat after the click — the old single
// check missed it, mislabeling real submissions as awaiting_input). `applyModal`
// must be the verified apply dialog (never a loose fallback) so an unrelated
// modal closing — or the user X-ing the modal — can't be read as a submit.
async function confirmSubmitted(applyModal, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs && !S.cancelled) {
    if (pageTextLooksLikeSuccess(8000) || urlLooksLikeSuccess()) return 'confirmation';
    if (applyModal) {
      const stillOpen = document.contains(applyModal) && isProbablyVisible(applyModal);
      const anotherApplyForm = document.querySelector('.jobs-easy-apply-modal, [data-test-modal][role="dialog"], [data-testid="smartapply-container"]');
      if (!stillOpen && !anotherApplyForm && !captchaOrLoginPresent()) return 'apply form closed';
    }
    await sleep(400);
  }
  return null;
}

function syntheticClick(el) {
  try {
    ['pointerover', 'mouseover', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((ev) => {
      el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
    });
  } catch {
    try { el.click(); } catch {}
  }
}

// ---- resume upload (the v9 hard wall, now solvable) ----
// Returns { attempted, attached }. attempted=true means there was an empty
// resume file input on this step that we tried to fill — the caller pauses the
// run if attempted but attached===0 rather than silently submitting without it.
async function tryAttachResume(root, resume) {
  if (!resume?.id) return { attempted: false, attached: 0 };
  const allFileInputs = qsa('input[type="file"]', root || document);
  const inputs = allFileInputs
    .filter((i) => !i.files?.length)
    .filter((i) => /(resume|cv|curriculum|résumé)/i.test(fieldLabel(i)) || allFileInputs.length === 1);
  if (!inputs.length) return { attempted: false, attached: 0 };

  const r = await send({ type: 'get-document', documentId: resume.id });
  if (!r?.ok || !r.dataBase64) { logLine('warn', 'could not fetch resume bytes from app'); return { attempted: true, attached: 0 }; }

  let file;
  try {
    const bytes = Uint8Array.from(atob(r.dataBase64), (c) => c.charCodeAt(0));
    file = new File([bytes], r.name || resume.name || 'resume.pdf', { type: r.mime || 'application/pdf' });
  } catch (e) {
    logLine('err', `could not build resume file (${e.message}) — your browser may block programmatic uploads here`);
    return { attempted: true, attached: 0 };
  }

  let attached = 0;
  for (const input of inputs) {
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      attached++;
      logLine('ok', `attached ${file.name}`);
    } catch (e) {
      logLine('warn', `file attach failed: ${e.message}`);
    }
  }
  return { attempted: true, attached };
}

// ============================================================
// Main
// ============================================================
export async function run(task, context, helpers) {
  if (S.running) return { ok: false, error: 'executor already running' };
  S.running = true; S.cancelled = false; S.paused = false; S.step = 0;
  S.task = task; S.context = context;

  const { job, profile, profileId, resume, harvested, aiConfidenceMin = 0.7 } = context || {};
  const mode = task.mode || 'review';
  showOverlay(`${mode === 'review' ? 'Filling for your review' : 'Applying'} — ${job?.title || ''}`);

  // A structured profile is OPTIONAL — we also fill from harvested/learned
  // answers (qa store) and the AI ladder. Build a data object that merges the
  // structured profile with any harvested fields that map to known profile keys
  // so the autofill engine has the most to work with even with no saved profile.
  const profileData = { ...(profile?.data || {}) };
  const learnedCount = Array.isArray(harvested) ? harvested.length : 0;
  logLine('ok', `start mode=${mode} · profile=${profile ? 'loaded' : 'none'} · learned=${learnedCount} · resume=${resume?.name || 'none'}`);

  // ---- relevance gate: don't apply to roles above your level / excluded / that
  // demand far more experience than you set (re-checked against the live page). ----
  const fitReason = checkFit(job?.title || '', document.body?.innerText || '', context?.fit);
  if (fitReason) {
    logLine('warn', `skipping — ${fitReason}`);
    setStatus(`Skipped — ${fitReason}`);
    report({ state: 'skipped', lastError: fitReason, transcriptAppend: { note: 'relevance skip: ' + fitReason } });
    S.running = false;
    hideOverlay(3500);
    return { ok: true, state: 'skipped', steps: 0 };
  }

  const engine = new AutofillEngine({
    getProfile: async () => profileData,
    lookupAnswer: async (label) => {
      const r = await send({ type: 'api-call', method: 'POST', path: '/qa/lookup', body: { question: label, profileId } });
      return (r?.ok && r.match && typeof r.match.answer === 'string') ? { answer: r.match.answer } : null;
    },
    recordAnswer: async (item) => send({ type: 'qa-record', data: { ...item, source: job?.source, profileId } }),
  });

  let finished = false;
  let finalState = null;
  let everHadForm = false;     // has the apply form/modal ever appeared this run?
  let submitAttempted = false; // did we click a final submit (auto mode) at least once?
  let noChange = 0;            // consecutive advance clicks that didn't change the page (stall)

  // Self-healing park: questions we couldn't answer with HIGH confidence. We
  // NEVER submit a job with these outstanding — instead we park it (with the
  // reason) so the next run can ask the user and grow the knowledge base.
  const parked = [];
  const parkSeen = new Set();
  const onJobBoard = /linkedin|indeed/i.test(location.hostname);
  const park = (label, fieldType, options, reason) => {
    const key = String(label || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || parkSeen.has(key)) return;
    parkSeen.add(key);
    parked.push({ question: String(label).slice(0, 300), fieldType: fieldType || 'text', options: options || null, reason: reason || 'missing answer' });
  };
  const reportParked = (where) => {
    logLine('warn', `parked — ${parked.length} unanswered question(s); set aside for your input`);
    setStatus(`Set aside — needs ${parked.length} answer(s) from you`);
    report({ state: 'parked', parkReason: `needs ${parked.length} answer(s)`, pendingQuestions: parked, transcriptAppend: { note: `parked at ${where}: ` + parked.map((p) => p.question.slice(0, 40)).join('; ') } });
    finalState = 'parked';
  };

  while (S.step < MAX_STEPS && !S.cancelled && !finished) {
    S.step++;
    await untilUnpaused();
    if (S.cancelled) break;

    // ---- hard stops ----
    const blocker = captchaOrLoginPresent();
    if (blocker) {
      logLine('warn', `${blocker} detected — handing back to you`);
      setStatus(blocker === 'captcha' ? 'CAPTCHA — your move' : 'Login required — your move');
      report({ state: 'awaiting_input', lastError: blocker });
      finalState = 'awaiting_input';
      break;
    }

    const formProbe = detectApplyForm();
    // Scope the field scan STRICTLY to the apply modal/form. Prefer the tight
    // Easy-Apply dialog over detectApplyForm()'s container — the latter can fall
    // back to document.body (Workday-style SPAs), and on LinkedIn that let the scan
    // reach the page's global "Search" box, parking every job at submit with a
    // phantom "search search" question. Require the dialog to actually contain
    // fields so a cookie/consent dialog isn't mistaken for the form. NEVER fall
    // back to `document`: with no real apply container we don't scan at all — we
    // just go find the Easy-Apply button below to OPEN the form (findAdvanceButton
    // defaults to document when root is null).
    const dialog = Array.from(document.querySelectorAll('.jobs-easy-apply-modal, [data-test-modal][role="dialog"], [role="dialog"][aria-modal="true"], .ia-Modal, [data-testid="smartapply-container"]'))
      .find((d) => isProbablyVisible(d) && d.querySelector('input, textarea, select, [role="combobox"], [contenteditable="true"]')) || null;
    const root = dialog || formProbe?.form || null;
    const haveForm = !!root;
    if (haveForm) everHadForm = true;

    // ---- fill from profile + learned answers ----
    setStatus(`Step ${S.step}: ${haveForm ? 'filling fields…' : 'opening the application…'}`);
    const suggestions = haveForm ? (await engine.scanFillable(root)).filter((s) => {
      if (NEVER_AUTOFILL_RX.test(s.label)) {
        logLine('warn', `left sensitive field for you: "${s.label.slice(0, 40)}"`);
        return false;
      }
      return true;
    }) : [];
    const filled = engine.fill(suggestions);
    if (filled) logLine('ok', `filled ${filled} field(s) from profile/history`);

    // ---- resume upload ----
    const att = haveForm ? await tryAttachResume(root, resume) : { attempted: false, attached: 0 };
    if (resume?.id && att.attempted && att.attached === 0) {
      logLine('err', 'resume could not be attached — stopping for you to upload it');
      report({ state: 'awaiting_input', lastError: 'resume attachment failed' });
      finalState = 'awaiting_input';
      break;
    }

    // ---- unknown questions → AI ladder ----
    const unknown = haveForm ? (await engine.scanUnknown(root)).slice(0, 5) : [];
    for (const u of unknown) {
      if (S.cancelled) break;
      if (LEGAL_RX.test(u.label)) {
        logLine('warn', `legal/eligibility question not in profile: "${u.label.slice(0, 60)}" — leaving for you`);
        if (u.required || onJobBoard) park(u.label, u.fieldType, u.options, 'legal/eligibility — needs your answer');
        continue;
      }
      setStatus(`Step ${S.step}: thinking about "${u.label.slice(0, 40)}…"`);
      const r = await send({
        type: 'api-call', method: 'POST', path: '/ai/answer-question',
        timeoutMs: 150000,
        body: { question: u.label, fieldType: u.fieldType, options: u.options, jobId: job?.id, profileId },
      });
      // Validate the response shape — a malformed result (missing confidence,
      // non-string answer) must NEVER be treated as a confident answer.
      const a = (r?.ok && r.result && typeof r.result.answer === 'string'
                 && typeof r.result.confidence === 'number') ? r.result : null;
      if (!a || a.refuse || a.confidence < aiConfidenceMin || !a.answer.trim()) {
        logLine('warn', `no grounded answer for "${u.label.slice(0, 50)}" (${a ? 'conf ' + a.confidence : 'ai failed/malformed'})`);
        // Not highly confident → park it (don't guess). Required fields and any
        // job-board screening question must be answered before we submit.
        if (u.required || onJobBoard) park(u.label, u.fieldType, u.options, a && a.reason ? a.reason : 'no confident answer');
        continue;
      }
      const ok = engine.fill([{ input: u.input, value: a.answer }]);
      if (ok) {
        logLine('ok', `AI answered "${u.label.slice(0, 40)}" (conf ${a.confidence.toFixed(2)})`);
        await engine.recordAnswer({ question: u.label, answer: a.answer, fieldType: u.fieldType, source: 'ai', jobId: job?.id });
      }
    }

    // learn everything currently on the form
    if (haveForm) await engine.captureCurrentAnswers(root, { source: job?.source, jobId: job?.id });

    await untilUnpaused();
    if (S.cancelled) break;

    // ---- advance ----
    setStatus(`Step ${S.step}: looking for next/submit…`);
    // In-form: prefer buttons inside the modal. Not open yet: also try LinkedIn's
    // Easy-Apply button to OPEN the form (covers postings the generic scan misses).
    let btn = findAdvanceButton(root) || (!haveForm ? findEasyApplyButton() : null);
    if (!btn) {
      const opening = !everHadForm;   // the apply form has never appeared yet
      logLine('warn', opening ? 'couldn’t open the application — waiting a bit' : 'no advance button — waiting 30s for the page (or you)');
      let found = null;
      const tries = opening ? 24 : 60;   // ~12s for a slow Easy-Apply button to hydrate; 30s once in-form
      for (let i = 0; i < tries && !S.cancelled; i++) {
        await sleep(500);
        found = findAdvanceButton() || (!haveForm ? findEasyApplyButton() : null);
        if (found) break;
      }
      if (!found) {
        // If we're stuck because of unanswered questions, park (self-heal) rather
        // than a generic "needs input" — so the next run can ask + retry.
        if (parked.length) { reportParked('no-advance'); break; }
        if (submitAttempted) {
          // We clicked the final submit but couldn't auto-confirm it. Don't call it
          // failed, and don't falsely stamp it submitted — flag it for a quick look.
          logLine('ok', 'final submit clicked — confirmation not detected; flagged for your review');
          report({ state: 'awaiting_review', lastError: 'submitted but not auto-confirmed — please verify', transcriptAppend: { note: 'submit clicked; no confirmation seen' } });
          finalState = 'awaiting_review';
        } else {
          // Either the Easy-Apply form never opened (likely external/verification —
          // nothing to auto-do) or in-form validation needs a human. Leave it as
          // awaiting_input: it's in the queue de-dup set, so discovery won't churn
          // it into a re-skip loop.
          report({ state: 'awaiting_input', lastError: opening ? 'application did not open (not Easy-Apply / verification)' : 'no advance button found' });
          finalState = 'awaiting_input';
        }
        break;
      }
      continue;
    }

    const isFinal = isFinalSubmit(btn);
    if (isFinal) {
      // SAFETY NET: never submit a job that still has unanswered questions.
      if (parked.length) { reportParked('final-submit'); break; }
      if (mode === 'review') {
        logLine('ok', 'reached the final submit — stopping for your review');
        setStatus('Ready for your review — press submit yourself when happy.');
        report({ state: 'awaiting_review', transcriptAppend: { note: 'stopped at final submit (review mode)' } });
        finalState = 'awaiting_review';
        break;
      }
      logLine('ok', 'final submit (auto mode)');
    }
    // Snapshot the VERIFIED apply modal (the field-bearing `dialog`, never a loose
    // fallback) before clicking submit, so detecting it close can't be tricked by
    // an unrelated modal (cookie/consent) closing.
    const submitDialog = isFinal ? dialog : null;

    // Re-verify the button is still clickable right before acting — the DOM may
    // have changed since findAdvanceButton() above (validation re-render, etc.).
    let clickBtn = btn;
    if (clickBtn.disabled || !isProbablyVisible(clickBtn) || !document.contains(clickBtn)) {
      clickBtn = findAdvanceButton(root) || findAdvanceButton() || (!haveForm ? findEasyApplyButton() : null);
      if (!clickBtn) { logLine('warn', 'advance button became invalid before click — re-scanning'); continue; }
    }
    const label = compactText(clickBtn.textContent || clickBtn.value || '').slice(0, 30);
    logLine('ok', `clicking "${label}"`);
    setStatus(`Step ${S.step}: "${label}"…`);
    const prevHash = domHash();
    syntheticClick(clickBtn);
    const changed = await waitForChange(prevHash);
    // Stall guard: 3 advance clicks in a row with no page change → we're stuck on a
    // step (validation we can't satisfy, a dead button). Stop cleanly instead of
    // spinning to MAX_STEPS. NEVER count the final-submit click — its confirmation
    // (below) renders a beat later and must run, or a real submit gets mis-reported.
    const isFinalAuto = isFinal && mode !== 'review';
    if (!changed && !isFinalAuto) {
      logLine('warn', 'page did not change after click');
      if (++noChange >= 3) {
        if (parked.length) { reportParked('stalled'); break; }
        logLine('warn', 'stuck — the page stopped advancing; handing back to you');
        report({ state: 'awaiting_input', lastError: 'stuck on a step (page stopped advancing)' });
        finalState = 'awaiting_input';
        break;
      }
    } else if (changed) { noChange = 0; }

    // ---- confirm a real submit (auto mode) ----
    // After clicking the final submit, WAIT for the confirmation (banner or the
    // Easy-Apply modal closing) instead of checking once — the banner renders a
    // beat later, which used to make real submissions look like awaiting_input.
    if (isFinal && mode !== 'review') {
      submitAttempted = true;
      setStatus('Submitting — waiting for confirmation…');
      const how = await confirmSubmitted(submitDialog);
      if (how) {
        logLine('ok', `✓ application submitted (${how})`);
        setStatus('✓ Application submitted');
        // Mark the JOB submitted too, so it's counted even if the passive capture
        // detector misses the banner (queuePatch only updates the task).
        if (job?.id) await send({ type: 'api-call', method: 'PATCH', path: '/jobs/' + encodeURIComponent(job.id), body: { status: 'submitted' } });
        report({ state: 'done', transcriptAppend: { note: `submitted — ${how}` } });
        finalState = 'done';
        finished = true;
        continue;
      }
      logLine('warn', 'submit not confirmed yet — continuing');
    }

    // ---- success? (generic net for one-click / non-modal apply flows) ----
    if (pageTextLooksLikeSuccess(6000) || urlLooksLikeSuccess()) {
      logLine('ok', '✓ application submitted');
      setStatus('✓ Application submitted');
      if (job?.id) await send({ type: 'api-call', method: 'PATCH', path: '/jobs/' + encodeURIComponent(job.id), body: { status: 'submitted' } });
      report({ state: 'done', transcriptAppend: { note: 'success detected' } });
      finalState = 'done';
      finished = true;
    }
    await sleep(600);
  }

  if (!finalState && !S.cancelled && S.step >= MAX_STEPS) {
    if (parked.length) { reportParked('max-steps'); }
    else {
      logLine('warn', 'max steps reached — stopping for safety');
      report({ state: 'awaiting_input', lastError: 'max steps reached' });
      finalState = 'awaiting_input';
    }
  }

  S.running = false;
  hideOverlay(finalState === 'awaiting_review' || finalState === 'awaiting_input' || finalState === 'parked' ? 60000 : 4000);
  return { ok: true, state: finalState || (S.cancelled ? 'skipped' : 'unknown'), steps: S.step };
}
