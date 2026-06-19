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

import { AutofillEngine, setNativeValue, fieldLabel, fillCombobox, pickRadioInGroup, matchOption, isResumeFileInput } from './autofill.js';
import { detectApplyForm } from './signals/forms.js';
import { isSubmitClick } from './signals/intent.js';
import { pageTextLooksLikeSuccess, urlLooksLikeSuccess, evaluateSubmitEvidence } from './signals/success.js';
import { qsa, isProbablyVisible, compactText } from './lib/dom.js';
import { planReplay, resolveStepAnswer, paceDelay, classifyDivergence, resolveLocator, recoveryFingerprint } from './replay.js';
import { classifyApplyControl, observeRoute, applyRouteForState } from './route.js';
import { classifyInterstitial } from './lib/interstitial.js';
import { detectBotChallenge, botChallengeLastError } from './lib/challenge.js';
import { ADVANCE_KEYWORDS, isAdvanceLabel } from './lib/advance.js';
import { sitePack } from './sites/index.js';
import { confirmSignalsMatched } from './lib/ats-drive.js';

const MAX_STEPS = 40;
const STEP_TIMEOUT = 9000;
const LEGAL_RX = /(work.*authoriz|sponsor|visa|citizen|clearance|ethnic|race|gender|disabilit|veteran|criminal|background.*check)/i;
// Demographic / sensitive fields we NEVER auto-fill from any source (not even
// the profile) — the user must consciously answer these in the form. Work
// authorization / sponsorship / citizenship stay fillable (that's the profile's
// purpose); this list is the EEO + criminal-history subset only.
const NEVER_AUTOFILL_RX = /(ethnic|race\b|gender|\bsex\b|disabilit|veteran|criminal|background.*check|felony|conviction|pronoun)/i;
// Optional, non-text-answerable fields (a profile photo/headshot URL, etc.) — leave
// them BLANK and move on instead of parking the whole job. They're almost always
// optional, and the AI correctly refuses to invent a photo URL.
const OPTIONAL_SKIP_RX = /(head\s?shot|profile (photo|picture|image)|upload (a )?(photo|picture|image)|\bphoto\b|\bavatar\b|picture of you|middle name|middle initial)/i;
const CAPTCHA_RX = /captcha|verify (that )?you('| a)re (a )?human|unusual activity|are you a robot/i;
// LinkedIn caps Easy Apply at ~50 submissions / rolling 24h. When hit it shows a modal
// "You reached today's Easy Apply limit." Detect it so the server can cool down the
// route and PIVOT to external/company-site jobs instead of wasting the cooldown trying.
const EASYAPPLY_LIMIT_RX = /reached (today'?s )?easy apply limit/i;
const DAILY_LIMIT_NEAR_EASYAPPLY_RX = /(daily|today'?s)[^.]{0,40}\blimit\b/i;
const LOGIN_APPLY_RX = /(?:sign\s*in|log\s*in|connectez[- ]vous|se connecter|connexion)[^.!?\n]{0,80}(?:apply|postuler)|(?:apply|postuler)[^.!?\n]{0,80}(?:sign\s*in|log\s*in|connectez[- ]vous|se connecter|connexion)/i;
const EXTERNAL_APPLY_RX = /apply on (?:the )?(?:company|employer)|apply externally|on company (?:site|website)|apply on .* website|postuler sur le site (?:de l['’]employeur|employeur|de l['’]entreprise|entreprise)|site (?:de l['’]employeur|employeur|de l['’]entreprise|entreprise)/i;
// ADVANCE_KEYWORDS / OPEN_KEYWORDS / isAdvanceLabel are the pure advance-vs-opener
// decision (BUG-1), in ./lib/advance.js so they're node-testable without a DOM.
const FINAL_SUBMIT_RX = /^(submit( application)?|send( application)?|soumettre|envoyer( ma candidature)?|confirm and submit)$/i;
const APPLY_DIALOG_SEL = '.jobs-easy-apply-modal, .jobs-easy-apply-content, .jobs-easy-apply-content__wrapper, .jobs-easy-apply-modal-content, [data-test-modal][role="dialog"], [role="dialog"][aria-modal="true"], .ia-Modal, [data-testid="smartapply-container"]';

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
  const company = String(fit.company || '').toLowerCase();
  for (const kw of fit.excludeCompanies || []) { const k = String(kw || '').trim().toLowerCase(); if (k && company.includes(k)) return `excluded company "${k}"`; }
  const location = String(fit.location || '').toLowerCase();
  for (const kw of fit.excludeLocations || []) { const k = String(kw || '').trim().toLowerCase(); if (k && location.includes(k)) return `excluded location "${k}"`; }
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
  step: 0, overlay: null, task: null, context: null, supervisor: null,
  sessionSettings: { pace: 1, confidence: 0.7, stallLimit: 3 }, nextRequested: false,
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
  try { S.supervisor?.setStep({ text: s }); } catch {}
  const el = S.overlay?.querySelector('#jat11-aa-status');
  if (el) el.textContent = s;
}
function logLine(level, text) {
  try { S.supervisor?.log(level, `[${S.step}] ${text}`); } catch {}
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
function reportSeen(root, phase) {
  try {
    const scope = root || document;
    const fields = qsa('input, textarea, select, [role="combobox"], [contenteditable="true"]', scope)
      .filter(isProbablyVisible)
      .map((el) => compactText(fieldLabel(el) || el.getAttribute?.('aria-label') || el.getAttribute?.('placeholder') || el.name || el.id || el.tagName || 'field'))
      .filter(Boolean)
      .slice(0, 10);
    const buttons = qsa('button, [role="button"], input[type="submit"], a[role="button"]', scope)
      .filter(isProbablyVisible)
      .map((el) => compactText(el.getAttribute?.('aria-label') || el.textContent || el.value || ''))
      .filter(Boolean)
      .slice(0, 10);
    const text = compactText(scope.innerText || document.body?.innerText || '').slice(0, 260);
    const sig = `${phase}|${location.href}|${fields.join('|')}|${buttons.join('|')}`;
    if (S.lastSeenSig === sig) return;
    S.lastSeenSig = sig;
    try { S.supervisor?.setTelemetry({ stage: phase, step: S.step, fields: fields.length, seen: `${text} | Fields: ${fields.join(', ')} | Buttons: ${buttons.join(', ')}` }); } catch {}
    report({ transcriptAppend: {
      kind: 'seen',
      step: S.step,
      level: 'info',
      text: `sees ${phase}: ${text}`,
      fields,
      buttons,
      url: location.href,
    } });
  } catch {}
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
  // Ad-hoc supervised run (Watch & Teach on the active tab, B2): there's no queue row
  // backing it, so there's nothing to PATCH. The teach capture still flows via the
  // recorder's /observe posts — we just skip the queue progress report here.
  if (S.task.id == null) return;
  S.lastReport = { ...(S.lastReport || {}), ...(patch || {}) };
  // Stamp the apply ROUTE on real outcome transitions so the dashboard chart can
  // split the "easy / in-page apply" route from "external": an apply form that
  // never opened in-page means the posting bounced us to an external ATS or a
  // verification wall we can't auto-drive. Skips (relevance) get no route.
  if (patch && ROUTE_STATES.has(patch.state) && patch.applyRoute === undefined) {
    patch.applyRoute = applyRouteForState(S.routeState || (S.externalRoute ? 'external_new_tab' : (S.everHadForm ? 'same_tab_application' : 'unknown')));
    patch.routeState = S.routeState || 'unknown';
  }
  reportQueue = reportQueue.then(() =>
    send({ type: 'task-progress', taskId: S.task.id, patch })).catch(() => {});
}
const ROUTE_STATES = new Set(['done', 'awaiting_review', 'awaiting_input', 'parked', 'failed']);

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

// Bot-challenge / Cloudflare circuit-breaker probe. Builds a DOM-free description of the
// live page and hands it to the pure detector in lib/challenge.js. Returns the detector
// verdict; the executor uses `blocked` to bail TERMINALLY-but-honestly (a site gate, not an
// occlusion miss and not a failure of our flow). Best-effort structural hints (a cf ray-id
// marker, challenge widgets) are gathered cheaply and guarded so a hostile DOM can't throw.
function detectBotChallengeOnPage() {
  try {
    const bodyText = (document.body?.innerText || '').slice(0, 20000);
    let hasRayId = false;
    try {
      hasRayId = !!document.querySelector(
        '[data-ray], .cf-ray, #cf-wrapper, #challenge-running, #challenge-form, '
        + 'script[src*="/cdn-cgi/challenge"], script[src*="challenge-platform"], '
        + 'iframe[src*="/cdn-cgi/"], .cf-turnstile, [class*="cf-turnstile"]'
      );
    } catch {}
    return detectBotChallenge({
      url: location.href,
      title: document.title,
      bodyText,
      hasRayId,
    });
  } catch {
    return { blocked: false, kind: null, reason: 'probe-error' };
  }
}

// Detect LinkedIn's "You reached today's Easy Apply limit" modal. Narrow + guarded:
// only fires on linkedin.com, and only on the explicit copy OR a generic "daily limit"
// phrase that co-occurs with "Easy Apply" on the page. Returns true when the cap is hit.
function easyApplyLimitHit() {
  if (!/(^|\.)linkedin\.com$/i.test(location.hostname)) return false;
  const text = (document.body?.innerText || '').slice(0, 8000);
  if (EASYAPPLY_LIMIT_RX.test(text)) return true;
  if (DAILY_LIMIT_NEAR_EASYAPPLY_RX.test(text) && /easy apply/i.test(text)) return true;
  return false;
}

function btnText(el) {
  // LinkedIn's modal Next/Review/Submit buttons are often icon-only with the
  // real label in aria-label, so include it.
  return compactText(el?.getAttribute?.('aria-label') || el?.textContent || el?.value || '');
}
// Structural guard: is this candidate the LinkedIn Easy Apply page-level OPENER (the
// top-card "Easy Apply to this job" button)? We must NEVER return it from the in-form
// advance scan — re-clicking it is exactly the multi-page stall. Belt-and-suspenders:
// matched by its known opener container/aria signature OR route.js's classifier, so even
// a broad root can't select it during the in-form advance path.
function isEasyApplyOpener(el) {
  if (!el) return false;
  try {
    if (el.closest?.('.jobs-apply-button, .jobs-apply-button--top-card, [data-live-test-job-apply-button]')) return true;
    const aria = (el.getAttribute?.('aria-label') || '').toLowerCase();
    if (/easy apply|candidature simpli/.test(aria)) return true;
  } catch {}
  try { if (classifyApplyControl(el).state === 'linkedin_easy_apply_modal') return true; } catch {}
  return false;
}

function looksLikeAdvance(el, { allowOpen = false } = {}) {
  if (!el || el.disabled || !isProbablyVisible(el)) return false;
  // The page-level Easy Apply opener is never an in-form advance, regardless of keywords.
  if (!allowOpen && isEasyApplyOpener(el)) return false;
  return isAdvanceLabel(btnText(el), { allowOpen });
}

function findAdvanceButton(root, { allowOpen = false } = {}) {
  for (const el of qsa('button, input[type="submit"], a[role="button"], [role="button"]', root || document)) {
    if (looksLikeAdvance(el, { allowOpen })) return el;
  }
  return null;
}

function findApplyDialog({ requireFields = false } = {}) {
  for (const d of qsa(APPLY_DIALOG_SEL)) {
    // LinkedIn sometimes gives the stable outer Easy Apply shell no measurable box
    // during a Next-step React transition while its children are already visible.
    const childVisible = qsa('input, textarea, select, button, [role="button"]', d).some(isProbablyVisible);
    if (!isProbablyVisible(d) && !childVisible) continue;
    const hasField = !!d.querySelector?.('input, textarea, select, [role="combobox"], [contenteditable="true"]');
    if (requireFields && !hasField) continue;
    const branded = !!d.matches?.('.jobs-easy-apply-modal, [data-testid="smartapply-container"]');
    if (branded) return d;
    const text = compactText(`${d.getAttribute?.('aria-label') || ''} ${d.innerText || d.textContent || ''}`).slice(0, 2500);
    const buttons = qsa('button, input[type="submit"], a[role="button"], [role="button"]', d).map(btnText).filter(Boolean);
    const hasAdvance = buttons.some((t) => ADVANCE_KEYWORDS.some((re) => re.test(t)));
    if ((hasField || hasAdvance) && /apply|application|candidature|resume|résumé|\bcv\b|contact info|review/i.test(text)) return d;
  }
  return null;
}

async function waitForStickyLinkedInDialog(timeoutMs = 6500) {
  if (!/(^|\.)linkedin\.com$/i.test(location.hostname)) return null;
  const started = Date.now();
  while (Date.now() - started < timeoutMs && !S.cancelled) {
    const dialog = findApplyDialog();
    if (dialog) return dialog;
    await sleep(150);
  }
  return null;
}

// LinkedIn shows intermediate modals between the Easy-Apply opener and the real
// field-bearing form — a resume picker, a "Continue applying" confirmation, a review
// interstitial — that carry no answerable fields. The generic form scan reports
// haveForm=false on these, so without a handler the loop would re-click the underlying
// opener and the duplicate-opener breaker would terminal-fail. This advances THROUGH the
// interstitial (selecting the most-recent resume if asked, clicking continue/next/review)
// so the flow reaches the real Easy-Apply form. Pure decision lives in lib/interstitial.js;
// this only builds the live description and acts on it. Returns true iff it advanced.
async function handleLinkedInInterstitial() {
  if (!/(^|\.)linkedin\.com$/i.test(location.hostname)) return false;
  const dialog = findApplyDialog();
  if (!dialog) return false;
  // A field-bearing apply form is owned by the normal fill path, not this handler.
  const hasAnswerableFields = !!dialog.querySelector?.('input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]), textarea, select, [role="combobox"], [contenteditable="true"], input[type="file"]');
  const controls = qsa('button, input[type="submit"], a[role="button"], [role="button"]', dialog)
    .filter((el) => el && !el.disabled && isProbablyVisible(el));
  const buttons = controls.map((el, index) => ({ el, index, label: btnText(el) }));
  // Resume choices: LinkedIn renders them as radios or selectable cards. "recent" is a
  // best-effort signal from the option text/badge.
  const resumeEls = qsa('input[type="radio"], [role="radio"], [data-test-resume-card], .jobs-resume-picker__resume', dialog)
    .filter((el) => el && isProbablyVisible(el));
  const resumeChoices = resumeEls.map((el, index) => {
    const around = compactText(`${el.getAttribute?.('aria-label') || ''} ${el.closest?.('label, li, .jobs-resume-picker__resume')?.innerText || el.parentElement?.innerText || ''}`);
    return { el, index, label: around.slice(0, 80), recent: /most recent|recently|last used|updated/i.test(around) };
  });
  const dialogText = compactText(`${dialog.getAttribute?.('aria-label') || ''} ${dialog.innerText || dialog.textContent || ''}`).slice(0, 2500);

  const decision = classifyInterstitial({
    onLinkedIn: true,
    present: true,
    hasAnswerableFields,
    dialogText,
    buttons: buttons.map(({ label, index }) => ({ label, index })),
    resumeChoices: resumeChoices.map(({ label, index, recent }) => ({ label, index, recent })),
  });
  if (!decision.isInterstitial) return false;

  if (decision.pickResumeIndex != null) {
    const choice = resumeChoices[decision.pickResumeIndex];
    if (choice?.el) { logLine('ok', `interstitial: selecting resume "${choice.label.slice(0, 40)}"`); syntheticClick(choice.el); await sleep(250); }
  }
  const advance = buttons[decision.advanceIndex];
  if (!advance?.el) return false;
  logLine('ok', `interstitial: advancing past "${btnText(advance.el).slice(0, 30)}"`);
  const prevHash = domHash();
  syntheticClick(advance.el);
  await waitForChange(prevHash);
  return true;
}

// LinkedIn's "Easy Apply" button on the job-view page (before the modal opens).
// Matched by its known classes + an "easy apply" label so we never click an
// external "Apply" button (which leaves LinkedIn). Used to OPEN the form when the
// generic advance scan misses it (some postings render an icon/badged button).
function findEasyApplyButton() {
  const sel = 'button.jobs-apply-button, .jobs-apply-button--top-card button, [data-live-test-job-apply-button], button[aria-label*="easy apply" i], button[aria-label*="candidature simpli" i]';
  const candidates = [...qsa(sel), ...qsa('button, a[role="button"], [role="button"]')];
  for (const el of [...new Set(candidates)]) {
    if (!el || el.disabled || !isProbablyVisible(el)) continue;
    if (classifyApplyControl(el).state === 'linkedin_easy_apply_modal') return el;
  }
  return null;
}

function isFinalSubmit(el) {
  return FINAL_SUBMIT_RX.test(btnText(el)) || isSubmitClick(el);
}

// Positive evidence the posting is EXTERNAL — a visible CTA that sends you off to the
// company's own ATS rather than an in-page Easy-Apply. Lets us bail in ~0s instead of
// spinning ~12s waiting for a form that will never open.
function externalApplyPresent() {
  for (const el of qsa('a, button')) {
    if (!isProbablyVisible(el)) continue;
    const t = btnText(el).toLowerCase();
    if (!t) continue;
    if (EXTERNAL_APPLY_RX.test(t)) return true;
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href) && !/linkedin\.com|indeed\.com/i.test(href) && /\bapply\b/.test(t)) return true;
    }
  }
  return false;
}
function loginApplyPresent() {
  for (const el of qsa('a, button, [role="button"]')) {
    if (!isProbablyVisible(el)) continue;
    const t = btnText(el);
    if (t && LOGIN_APPLY_RX.test(t)) return true;
  }
  const text = compactText(document.body?.innerText || '').slice(0, 12000);
  return LOGIN_APPLY_RX.test(text);
}
function looksExternalApplyButton(el) {
  if (!el || !isProbablyVisible(el)) return false;
  return classifyApplyControl(el).state.startsWith('external_');
}
function findExternalApplyButton() {
  try {
    for (const el of qsa('a, button, [role="button"]')) {
      if (looksExternalApplyButton(el)) return el;
    }
  } catch {}
  return null;
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

// SUCCESS-TRUTH baseline snapshot. Captured IMMEDIATELY before the final-submit
// click, then again after the settle. `scope` is the verified apply dialog when
// we have one (so we diff the application surface, not unrelated page chrome),
// else document.body. We record normalized text, the URL, a boolean of whether
// the text ALREADY looks like success (pre-existing static copy must not count),
// and a structural signature so a fresh confirmation container is detectable.
function submitSnapshot(scope) {
  const el = (scope && document.contains(scope)) ? scope : document.body;
  const text = compactText(el?.innerText || el?.textContent || '').slice(0, 8000);
  return {
    text,
    url: location.href,
    successText: pageTextLooksLikeSuccess(8000),
    nodeSig: new Set(qsa('[role="alert"], [role="status"], [class*="confirm" i], [class*="success" i], [class*="thank" i], [id*="post-apply" i]')
      .filter(isProbablyVisible).map((n) => `${n.tagName}.${n.className}#${n.id}`)),
  };
}

// Confirmation containers that are present AFTER the click but were NOT in the
// baseline signature — the "diff, not absolute match" requirement.
function newConfirmationNodes(before) {
  const seen = before?.nodeSig || new Set();
  const out = [];
  for (const n of qsa('[role="alert"], [role="status"], [class*="confirm" i], [class*="success" i], [class*="thank" i], [id*="post-apply" i]')) {
    if (!isProbablyVisible(n)) continue;
    const key = `${n.tagName}.${n.className}#${n.id}`;
    if (seen.has(key)) continue;
    out.push({ text: compactText(n.innerText || n.textContent || '').slice(0, 800), confirmation: false });
  }
  return out;
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

// Best-effort context around a (possibly hidden, custom-widget) file input: its own
// attrs + accept, plus nearby button / label / dropzone text. Glassdoor and many ATS
// hide the real <input type=file> behind a styled "Upload resume" button, so the input
// itself often has NO resume-ish label — the affordance text sits on a sibling.
function fileInputContext(input) {
  const bits = [
    fieldLabel(input),
    input.getAttribute?.('name'), input.getAttribute?.('id'),
    input.getAttribute?.('accept'),
    input.getAttribute?.('aria-label'), input.getAttribute?.('data-test'),
    input.getAttribute?.('data-automation-id'),
  ];
  try {
    const scope = input.closest?.('[class*="upload" i], [class*="resume" i], [class*="attach" i], [data-test], [role="group"], fieldset, section, form, div');
    if (scope) {
      const near = scope.querySelector?.('label, button, [role="button"], [class*="label" i], [class*="title" i], [class*="dropzone" i], [class*="filename" i]');
      if (near?.textContent) bits.push(compactText(near.textContent).slice(0, 120));
      const al = scope.getAttribute?.('aria-label'); if (al) bits.push(al);
    }
  } catch {}
  return compactText(bits.filter(Boolean).join(' ')).toLowerCase();
}

// Find the file input(s) to drop the résumé into. Broadened for Glassdoor / external
// company sites: matches by accept-type and nearby affordance text (not just label),
// and INCLUDES hidden inputs (custom upload widgets keep the real input display:none).
// Falls back to the whole document when the form root has none. Best-effort + guarded.
function findResumeFileInputs(root) {
  try {
    let all = qsa('input[type="file"]', root || document);
    // Custom widgets often mount the real input outside the detected form root → widen.
    if (!all.length && root && root !== document) all = qsa('input[type="file"]', document);
    if (!all.length) return [];
    const empty = all.filter((i) => !i.files?.length);
    if (!empty.length) return [];
    // 1) Strong matches: resume-ish context OR a document-typed accept attr.
    const matched = empty.filter((i) => isResumeFileInput(i, fileInputContext(i)));
    if (matched.length) return matched;
    // 2) Only one empty file input on the page → it's the upload, attach to it.
    if (empty.length === 1) return empty;
    // 3) Otherwise don't guess (avoid dropping a résumé into a photo/ID upload).
    return [];
  } catch { return []; }
}

// ---- resume upload (the v9 hard wall, now solvable) ----
// Returns { attempted, attached }. attempted=true means there was an empty
// resume file input on this step that we tried to fill — the caller pauses the
// run if attempted but attached===0 rather than silently submitting without it.
async function tryAttachResume(root, resume) {
  if (!resume?.id) return { attempted: false, attached: 0 };
  const inputs = findResumeFileInputs(root);
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
  S.task = task; S.context = context; S.everHadForm = false; S.externalRoute = !!context?.externalHandoff;
  S.routeState = context?.externalHandoff ? 'external_new_tab' : 'unknown';
  S.lastReport = null;
  S.lastSeenSig = ''; S.supervisor = null; S.nextRequested = false;

  const { job, profile, profileId, resume, harvested, aiConfidenceMin = 0.7 } = context || {};
  S.sessionSettings = { pace: 1, confidence: aiConfidenceMin, stallLimit: 3 };
  const mode = task.mode || 'review';
  const allowExternal = context?.easyApplyOnly === false;
  // ---- per-ATS adapter (external/company-site driving) ----
  // A recognised external ATS contributes an adapter pack (sites/index.js). It only
  // engages when we are NOT on LinkedIn (BUG-1/F1 own the LinkedIn Easy-Apply path).
  // `account:'required'` packs (Workday/iCIMS/Taleo) → PARK honestly instead of the
  // old generic 40× loop. `account:'none'` packs (Lever/Greenhouse/Ashby/BambooHR) →
  // drive the adapter flow to completion (BambooHR fills then parks for the CAPTCHA).
  const onLinkedInHost = /(^|\.)linkedin\.com$/i.test(location.hostname);
  const atsPack = (() => { try { return onLinkedInHost ? null : sitePack(location.hostname); } catch { return null; } })();
  // Only drive a pack that declares the full account-less contract (formSelector +
  // account:'none'); a bare legacy hint pack (no `account`) falls through to today's
  // generic flow unchanged.
  const driveablePack = atsPack && atsPack.account === 'none' && atsPack.formSelector ? atsPack : null;
  const walledPack = atsPack && atsPack.account === 'required' ? atsPack : null;
  showOverlay(`${mode === 'review' ? 'Filling for your review' : 'Applying'} — ${job?.title || ''}`);

  // A structured profile is OPTIONAL — we also fill from harvested/learned
  // answers (qa store) and the AI ladder. Build a data object that merges the
  // structured profile with any harvested fields that map to known profile keys
  // so the autofill engine has the most to work with even with no saved profile.
  const profileData = { ...(profile?.data || {}) };
  const learnedCount = Array.isArray(harvested) ? harvested.length : 0;
  logLine('ok', `start mode=${mode} · profile=${profile ? 'loaded' : 'none'} · learned=${learnedCount} · resume=${resume?.name || 'none'}`);
  reportSeen(document, 'job page');

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

  // ---- account-walled ATS gate (Workday / iCIMS / Taleo) ----
  // These platforms gate the application behind a candidate account / login, so there
  // is no honest way to auto-submit. Park (awaiting_input) with a human-readable reason
  // BEFORE driving — this REPLACES the old generic 40× "Apply" loop AND the prior
  // over-eager fail-fast. Workday allows driving ONLY when a signed-in session form is
  // already up (pack.shouldPark() === false); iCIMS/Taleo always park.
  if (walledPack) {
    const mustPark = typeof walledPack.shouldPark === 'function'
      ? (() => { try { return walledPack.shouldPark(); } catch { return true; } })()
      : true;
    if (mustPark) {
      const why = walledPack.parkReason || `${walledPack.id} account required — needs you`;
      logLine('warn', `${why} — parking (not driving)`);
      setStatus(`Needs you — ${why}`);
      report({
        state: 'awaiting_input',
        lastError: why,
        parkReason: `${walledPack.id}_account_required`,
        applyRoute: 'external',
        pendingQuestions: [{ question: why, fieldType: 'site_gate', reason: 'account_required' }],
        transcriptAppend: { kind: 'recovery', note: `account-walled ATS (${walledPack.id}) — parked instead of looping` },
      });
      S.running = false;
      hideOverlay(60000);
      return { ok: true, state: 'awaiting_input', steps: 0, lastError: why, parkReason: `${walledPack.id}_account_required`, routeState: 'external' };
    }
    logLine('ok', `${walledPack.id}: signed-in session detected — driving the in-session application`);
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
  let formGrounded = false;    // SUCCESS-TRUTH: a REAL apply form was opened+interacted-with
  let submitAttempted = false; // did we click a final submit (auto mode) at least once?
  let noChange = 0;            // consecutive advance clicks that didn't change the page (stall)
  let lastPageAction = '';     // blocks repeated clicks on the same page-level opener
  let interstitialAdvances = 0; // LinkedIn resume/continue interstitials advanced this run (bounded)
  // BUG-3: external/company-ATS repeat breaker. The page-level opener breaker resets on
  // any DOM change, so an external site that re-renders on every "Apply" click (BMO: 40×
  // "clicking Apply" → max steps) is never caught. Track the last external advance label +
  // URL and the consecutive no-real-progress repeat count; STOP+park cleanly at the cap.
  let extLastLabel = '';
  let extLastUrl = '';
  let extRepeat = 0;

  // ============================================================
  // Front-until-hydrated [occlusion fix] — ADDITIVE, fully guarded.
  // ============================================================
  // WINDOWS OCCLUSION LIMIT: to be un-throttled, a window must be visible/on-top, which
  // for chrome.windows means FOCUSED. A non-focused apply window sitting behind the user's
  // MAXIMIZED window is fully occluded → Chrome throttles its timers → a heavy SPA
  // (LinkedIn Easy-Apply) never hydrates and the executor times out. The old single 700ms
  // nudge gives too little visible time and re-occludes immediately. So: when we detect the
  // apply tab is hidden AND the form hasn't hydrated, ask the SW to keep our apply window
  // FRONT until the form loads (jat11.front-until-hydrated); the moment the form/advance
  // button appears we hand focus straight back (jat11.apply-hydrated). The SW also has a
  // hard cap so it never holds focus indefinitely. Reactive: when the apply tab is NOT
  // occluded (user doesn't run maximized) document.visibilityState is 'visible', so we
  // never send the front request → no focus-steal. Gated by the frontToHydrate setting
  // (default ON); when off we keep today's single-nudge behavior byte-unchanged.
  const frontToHydrate = (context?.frontToHydrate !== false);
  let frontRequested = false;   // did we ask the SW to front-until-hydrated this run?
  function requestFrontUntilHydrated() {
    if (!frontToHydrate || frontRequested) return;
    frontRequested = true;
    try { chrome.runtime?.sendMessage?.({ type: 'jat11.front-until-hydrated' }); } catch {}
  }
  function signalHydrated() {
    if (!frontRequested) return;   // never released a front we didn't request
    frontRequested = false;
    try { chrome.runtime?.sendMessage?.({ type: 'jat11.apply-hydrated' }); } catch {}
  }

  // ============================================================
  // Live Teach & Correct [T4] — supervised run (ADDITIVE, fully guarded).
  // ============================================================
  // Engaged ONLY when task.mode === 'supervised' (or context.supervised). It overlays
  // the EXISTING step loop with a Step/Run toggle, a per-action approval gate, and a
  // "Wrong / Fix this" picker. On a correction it POSTs an AUTHORITATIVE replacement
  // bundle to /recipe/correction (rewrites the step at high confidence) and uses the
  // corrected value for the rest of THIS run. The normal auto path is untouched: when
  // `sup` is null every gate below is a no-op. Every call is try/catch-guarded so a
  // supervised-UX bug can never break the apply itself.
  const supervised = mode === 'supervised' || !!context?.supervised;
  let sup = null;
  const correctionsThisRun = new Map();   // normalized label → corrected value, for live reuse
  if (supervised) {
    try {
      const recipe = context?.recipe;
      const { pickRunMode } = await import(chrome.runtime.getURL('content/replay.js'));
      const { createSupervisor } = await import(chrome.runtime.getURL('content/supervise.js'));
      const initialMode = (() => { try { return pickRunMode(recipe, { trust: context?.trust ?? 0.7 }); } catch { return 'step'; } })();
      sup = createSupervisor({
        mode: initialMode,
        confidence: aiConfidenceMin,
        labelFn: (el) => { try { return fieldLabel(el); } catch { return ''; } },
        // The detected-list of fillable fields + advance buttons on the current step.
        fieldsFn: (root) => {
          const out = [];
          try {
            for (const inp of qsa('input, textarea, select, [role="combobox"], [contenteditable="true"]', root || document)) {
              if (!isProbablyVisible(inp)) continue;
              out.push({ input: inp, label: fieldLabel(inp) || inp.name || inp.id || inp.tagName });
            }
            for (const b of qsa('button, [role="button"], input[type="submit"]', root || document)) {
              if (!isProbablyVisible(b)) continue;
              const t = compactText(b.getAttribute('aria-label') || b.textContent || b.value || '');
              if (t) out.push({ input: b, label: '▸ ' + t.slice(0, 40) });
            }
          } catch {}
          return out;
        },
        onStop: () => { try { cancel('teach-stop'); } catch {} },
        onPause: (paused) => { S.paused = !!paused; report({ transcriptAppend: { kind: 'control', note: paused ? 'supervised run paused' : 'supervised run resumed' } }); },
        onSettings: (settings) => { S.sessionSettings = { ...S.sessionSettings, ...settings }; report({ transcriptAppend: { kind: 'control', note: `session tuning pace=${settings.pace} confidence=${settings.confidence} stallLimit=${settings.stallLimit}` } }); },
        onNextJob: () => { S.nextRequested = true; report({ transcriptAppend: { kind: 'control', note: 'user requested skip current and supervise next job' } }); },
      });
      sup.show();
      S.supervisor = sup;
      sup.setTelemetry({ stage: 'starting', step: 0, fields: 0, recovery: 'healthy', seen: `${job?.title || 'Current job'} at ${job?.company || location.hostname}` });
      try { S.overlay?.remove(); S.overlay = null; } catch {}
      try {
        const recorder = await import(chrome.runtime.getURL('content/recorder.js'));
        await recorder.start({ preapproved: true });
      } catch {}
      logLine('ok', `supervised run — default mode "${initialMode}" (Step/Run toggle in the panel)`);
    } catch (e) {
      sup = null;   // overlay failed to load → run exactly as the normal auto path
      logLine('warn', `supervised overlay unavailable (${e?.message || e}) — running unsupervised`);
    }
  }

  // POST an authoritative correction (the user picked the right element + value) and apply
  // it live. recipeId-first; else resolve by ats/company server-side. Never throws.
  async function applyCorrection(stepLabel, replacement) {
    try {
      const recipe = context?.recipe;
      const recipeId = recipe?.companyRecipeId || recipe?.atsRecipeId || null;
      const labelPattern = replacement.label || stepLabel || '';
      const body = {
        recipeId,
        ats: context?.ats || job?.ats || null,
        companyKey: context?.companyKey || null,
        profileId,
        labelPattern,
        selector: replacement.selector, xpath: replacement.xpath, attrs: replacement.attrs,
        html: replacement.html, value: replacement.value, fieldType: replacement.fieldType, action: replacement.action,
      };
      await send({ type: 'api-call', method: 'POST', path: '/recipe/correction', body });
      // Use the corrected value immediately for the rest of THIS run.
      if (replacement.value != null && labelPattern) {
        correctionsThisRun.set(String(labelPattern).toLowerCase().trim(), String(replacement.value));
        // Also fill it into the picked element right now if it's a fillable field.
        try {
          const root = findReplayRoot();
          const sel = replacement.selector;
          const target = sel && (root || document).querySelector(sel);
          if (target && replacement.value != null) await replayFill(target, replacement.value);
        } catch {}
      }
      logLine('ok', `correction saved for "${String(labelPattern).slice(0, 40)}" — recipe rewritten (authoritative)`);
      report({ transcriptAppend: { note: `live correction: "${String(labelPattern).slice(0, 50)}" → recipe step rewritten` } });
      try { sup?.confirmFixed(); } catch {}
    } catch (e) {
      logLine('warn', `correction POST failed (${e?.message || e})`);
    }
  }

  // The supervised gate the loop calls before acting. Returns 'go' | 'stopped'. In Step
  // mode it waits for Approve; "Wrong / Fix this" opens the picker, saves a correction,
  // then re-gates. Always a no-op (returns 'go') when not supervised.
  async function superviseGate(info) {
    if (!sup) return 'go';
    for (let guard = 0; guard < 8; guard++) {
      if (S.cancelled || sup.stopped()) return 'stopped';
      const verdict = await sup.beforeAction(info);
      if (verdict === 'stopped') return 'stopped';
      if (verdict === 'approved') return 'go';
      if (verdict === 'wrong') {
        const replacement = await sup.requestCorrection({ label: info?.text || '' });
        if (replacement) await applyCorrection(info?.label || '', replacement);
        // re-gate (the user may approve, fix again, or stop)
        continue;
      }
      return 'go';
    }
    return 'go';
  }

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

  // ============================================================
  // Apprenticeship Engine [P5] — gated, additive recipe replay.
  // ============================================================
  // attemptReplay() runs ONLY when a resolved recipe rides along on the context.
  // It is the FAST PATH: when the recipe covers every required field on the live
  // page with high confidence, it fills from the answer ladder + the recipe and
  // advances with the user's own learned human pacing — skipping blind
  // re-discovery. On ANY uncertainty (planReplay says fallback) or ANY divergence
  // (unexpected required field / inline validation error / stall), it DOWNGRADES:
  // it stops replay, POSTs a correction (which decays the recipe), notes it in the
  // transcript, and returns { fellBack: true } so the caller runs today's
  // discover-every-step flow. It NEVER blind-submits on divergence and NEVER
  // fabricates. The WHOLE attempt is wrapped in try/catch by the caller → a thrown
  // runtime bug also degrades to today's behavior.
  //
  // Returns: { fellBack:true } (run the normal flow) | { done:true } (replay
  // mechanically completed; finalState already set).

  // Locate the live apply form root (mirrors the main loop's strict dialog scope).
  function findReplayRoot() {
    const dialog = findApplyDialog() || null;
    return dialog || detectApplyForm()?.form || null;
  }

  // Harvest inline validation errors in the current step (reuses the stall-detection
  // ground truth). Returns the first human-readable error string, or ''.
  function replayInlineError(root) {
    try {
      const scope = root || document;
      const errEls = Array.from(scope.querySelectorAll('.artdeco-inline-feedback--error, [class*="inline-feedback--error"], [class*="error-text"], [class*="form-element__error"], [data-test-form-element-error-messages], [role="alert"]'))
        .filter((e) => isProbablyVisible(e) && (e.textContent || '').trim() && /required|invalid|select|enter|provide|valid|must|please|choose|answer/i.test(e.textContent || ''));
      if (errEls.length) return compactText(errEls[0].textContent || '').slice(0, 120);
    } catch {}
    return '';
  }

  // Fill ONE resolved value into a field using the existing autofill strategies
  // (select → matchOption, combobox/typeahead → fillCombobox, radio group →
  // pickRadioInGroup, else → setNativeValue). Returns true on a successful fill.
  async function replayFill(input, value) {
    try {
      const v = String(value == null ? '' : value);
      if (!v.trim()) return false;
      const isCombo = input.getAttribute && (input.getAttribute('role') === 'combobox'
        || (input.closest && input.closest('[class*="select__control"],[class*="react-select"],[class*="-control"],[class*="basic-typeahead"]')));
      if (input.tagName === 'SELECT') {
        const opt = matchOption(input, v);
        if (!opt) return false;
        setNativeValue(input, opt.value);
        return true;
      }
      if (isCombo) return await fillCombobox(input, v);
      if (input.type === 'radio') {
        const picked = pickRadioInGroup(input, v) || (/^(yes|true|y|oui|sí|si|ja|1)$/i.test(v) ? input : null);
        if (!picked) return false;
        picked.checked = true;
        picked.dispatchEvent(new Event('input', { bubbles: true }));
        picked.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      if (input.type === 'checkbox') {
        if (!/^(yes|true|y|oui|sí|si|ja|1)$/i.test(v)) return false;
        input.checked = true;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      setNativeValue(input, v);
      return true;
    } catch { return false; }
  }

  // The answer-ladder ctx for resolveStepAnswer. Each rung returns a value or
  // undefined; replay.js enforces the URL-for-quantity guard. profile/qa are sync
  // (pre-fetched per step below); AI/deterministic share the confidence-gated
  // /ai/answer-question route the discover path uses.
  async function resolveReplayValue(step, root) {
    const label = step.labelPattern || '';
    // 1+2. profile + qa, in one server round-trip (qa/lookup already merges them
    // server-side via profileFieldLookup precedence isn't exposed, so we ask both):
    let profileVal = null, qaVal = null;
    try {
      const r = await send({ type: 'api-call', method: 'POST', path: '/qa/lookup', body: { question: label, profileId } });
      if (r?.ok && r.match && typeof r.match.answer === 'string') qaVal = r.match.answer;
    } catch {}
    try {
      const pm = await engine.scanFillable(root);
      const hit = pm.find((s) => s.label && (s.label === label || s.label.includes(label) || label.includes(s.label)));
      if (hit && hit.source === 'profile' && hit.value != null) profileVal = String(hit.value);
    } catch {}
    let aiVal = null;
    // 4. AI — only consulted when profile/qa/recipe-default miss (resolveStepAnswer
    // walks the ladder in order, so we lazily fetch AI to avoid a round-trip when a
    // higher rung already answers). We pre-decide whether AI is needed.
    const ladderCtx = {
      profileGet: () => profileVal,
      qaGet: () => qaVal,
      aiGet: () => aiVal,
      deterministicGet: () => null,   // deterministic floor is folded into /ai/answer-question server-side
    };
    // First pass without AI: if profile/qa/recipe-default already answer, use it.
    let val = resolveStepAnswer(step, ladderCtx);
    if (val != null) return val;
    // Otherwise consult the AI route (confidence-gated, refusal-aware) once.
    if (!LEGAL_RX.test(label) && !NEVER_AUTOFILL_RX.test(label)) {
      try {
        const r = await send({
          type: 'api-call', method: 'POST', path: '/ai/answer-question', timeoutMs: 150000,
          body: { question: label, fieldType: step.fieldType, options: step.options, jobId: job?.id, profileId },
        });
        const a = (r?.ok && r.result && typeof r.result.answer === 'string' && typeof r.result.confidence === 'number') ? r.result : null;
        if (a && !a.refuse && a.confidence >= S.sessionSettings.confidence && a.answer.trim()) aiVal = a.answer;
      } catch {}
    }
    return resolveStepAnswer(step, ladderCtx);   // re-walk with aiVal now populated
  }

  async function attemptReplay() {
    const recipe = context?.recipe;
    if (!recipe || !Array.isArray(recipe.steps) || !recipe.steps.length) return { fellBack: true };
    const recipeId = recipe.companyRecipeId || recipe.atsRecipeId || null;
    const correct = (labelPattern, why) => {
      // Decay the recipe (and the divergent step) so it self-corrects toward fall-back.
      if (recipeId) {
        try { send({ type: 'api-call', method: 'POST', path: '/recipe/correction', body: { recipeId, labelPattern } }); } catch {}
      }
      logLine('warn', `replay diverged (${why}) — falling back to discover-every-step`);
      report({ transcriptAppend: { note: `replay divergence: ${why}${labelPattern ? ' @ ' + String(labelPattern).slice(0, 60) : ''} → fell back to discovery` } });
    };

    // Need a live form to replay against. If it hasn't opened yet, fall back so the
    // existing flow can OPEN it (Easy-Apply button etc.) — replay isn't an opener.
    const root = findReplayRoot();
    if (!root) return { fellBack: true };
    everHadForm = true; S.everHadForm = true;

    // Required labels on the live page: the union of required unknowns + required
    // fillables (mirrors the executor's own required-field notion).
    let requiredLabels = [];
    try {
      const unknown = await engine.scanUnknown(root);
      requiredLabels = unknown.filter((u) => u.required).map((u) => u.label);
    } catch { return { fellBack: true }; }

    const plan = planReplay(recipe, requiredLabels, { theta: context?.replayTheta ?? 0.6 });
    if (plan.mode !== 'auto') {
      logLine('ok', `replay gate: fallback (${plan.reason}${plan.missing?.length ? '; missing: ' + plan.missing.slice(0, 3).join(', ') : ''})`);
      return { fellBack: true };   // ADDITIVE: run the existing flow unchanged.
    }
    logLine('ok', `replay AUTO — recipe covers ${requiredLabels.length} required field(s) (conf ${(Number(recipe.confidence) || 0).toFixed(2)})`);

    let replayNoChange = 0;
    let replayStep = 0;
    const REPLAY_MAX = MAX_STEPS;
    while (replayStep < REPLAY_MAX && !S.cancelled) {
      replayStep++;
      await untilUnpaused();
      if (S.cancelled) return { fellBack: true };

      const curRoot = findReplayRoot();
      if (!curRoot) { correct(null, 'apply form disappeared'); return { fellBack: true }; }

      // Divergence: an unexpected REQUIRED field with no covering step → don't fabricate.
      let liveRequired = [];
      try { liveRequired = (await engine.scanUnknown(curRoot)).filter((u) => u.required).map((u) => u.label); } catch {}
      const recheck = planReplay(recipe, liveRequired, { theta: context?.replayTheta ?? 0.6 });
      if (recheck.mode !== 'auto') {
        const div = classifyDivergence({ unexpectedRequiredField: true });
        correct(recheck.missing?.[0] || null, div || 'unexpected_field');
        return { fellBack: true };
      }

      // Fill every step that maps to a field currently on this step of the form.
      for (const step of recipe.steps) {
        if (S.cancelled) return { fellBack: true };
        if (NEVER_AUTOFILL_RX.test(step.labelPattern || '') || LEGAL_RX.test(step.labelPattern || '')) continue;
        // Find the target on the live form. SELECTOR-FIRST [T3]: try the step's resolved
        // locator (CSS selector → XPath) against the dialog root; if it finds a visible
        // element, use it. ADDITIVE + try/catch-guarded — a bad/stale selector must fall
        // back to today's label-pattern token-match, never throw.
        let target = null;
        try {
          const loc = resolveLocator(step);
          const scope = curRoot || document;
          if (loc.by === 'selector' && loc.value) {
            const el = scope.querySelector(loc.value);
            if (el && isProbablyVisible(el)) target = el;
          } else if (loc.by === 'xpath' && loc.value) {
            const r = document.evaluate(loc.value, scope, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            const el = r && r.singleNodeValue;
            if (el && el.nodeType === 1 && isProbablyVisible(el)) target = el;
          }
        } catch { target = null; }   // bad selector/xpath → fall through to label match
        // Fall back to the label-pattern token-match when no locator hit.
        if (!target) {
          try {
            const fillables = await engine.scanUnknown(curRoot);
            const hit = fillables.find((u) => u.label && step.labelPattern
              && (u.label === step.labelPattern || u.label.includes(step.labelPattern) || step.labelPattern.includes(u.label)));
            target = hit ? hit.input : null;
          } catch {}
        }
        if (!target) continue;   // already filled or not on this step — skip.
        const value = await resolveReplayValue(step, curRoot);
        if (value == null) continue;   // no grounded answer → leave it; divergence recheck catches a required gap.
        // Human pacing: a brief pre-action pause (mousedown→pause→mouseup feel).
        await sleep(paceDelay(step.medianDelayMs) * S.sessionSettings.pace);
        const ok = await replayFill(target, value);
        if (ok) {
          logLine('ok', `replayed "${String(step.labelPattern).slice(0, 40)}"`);
          try { await engine.recordAnswer({ question: step.labelPattern, answer: value, fieldType: step.fieldType, source: job?.source, jobId: job?.id }); } catch {}
        }
      }

      // Inline validation error after filling → divergence (don't push past it).
      const errTxt = replayInlineError(curRoot);
      if (errTxt) { correct(null, 'validation_error: ' + errTxt); return { fellBack: true }; }

      await untilUnpaused();
      if (S.cancelled) return { fellBack: true };

      // Advance with paced timing.
      const btn = findAdvanceButton(curRoot) || findAdvanceButton();
      if (!btn) {
        // No advance button after filling — let the existing flow take over (it
        // knows how to wait for late hydration / decide external vs transient).
        logLine('ok', 'replay: no advance button — handing to discover flow');
        return { fellBack: true };
      }
      const isFinal = isFinalSubmit(btn);
      if (isFinal) {
        // Replay reached the final submit cleanly. NEVER auto-submit from the replay
        // path — hand to the existing flow, which enforces review-mode + the
        // parked-questions safety net before any real submit. Mark the recipe's
        // mechanical completion (success) via the app, then hand off. "Never
        // blind-submit" stays absolute: the real submit/review decision is the
        // existing loop's, not the replay's.
        if (recipeId) { try { await send({ type: 'api-call', method: 'POST', path: '/recipe/outcome', body: { recipeId, success: true } }); } catch {} }
        logLine('ok', 'replay reached final submit — handing to the submit/review gate');
        return { fellBack: true };
      }

      const prevHash = domHash();
      await sleep(paceDelay(0, undefined, { defaultBaseMs: 300 }) * S.sessionSettings.pace);   // brief pre-click settle (paced)
      syntheticClick(btn);
      const changed = await waitForChange(prevHash);
      if (!changed) {
        if (++replayNoChange >= 3) {
          const div = classifyDivergence({ noChangeCount: replayNoChange });
          // Re-harvest the inline error for a precise correction label, if any.
          const why = replayInlineError(curRoot) || 'page stopped advancing';
          correct(null, (div || 'stalled') + ': ' + why);
          return { fellBack: true };
        }
      } else { replayNoChange = 0; }
    }
    return { fellBack: true };   // ran out of replay steps → let the normal flow finish.
  }

  // ---- gated replay attempt (P5) — ADDITIVE: only engages when context.recipe
  // exists and the gate passes; on any throw / fallback / divergence it degrades to
  // exactly today's discover-every-step flow below. A replay bug never breaks apply.
  if (context?.recipe && !supervised) {
    try {
      const rr = await attemptReplay();
      // attemptReplay only ever hands BACK to the normal flow (fellBack) or sets a
      // mechanical-completion that the normal flow then submits/reviews — it never
      // sets a terminal state itself, so we simply continue into the loop below.
      void rr;
    } catch (e) {
      logLine('warn', `replay attempt threw (${e?.message || e}) — falling back to discovery`);
      report({ transcriptAppend: { note: 'replay attempt threw → fell back to discover-every-step' } });
    }
  }

  // ---- recognised-ATS in-form advance/submit finder ----
  // For account-less packs the adapter knows its FINAL submit (isSubmitHint) and its
  // multi-step Next/Continue control (advanceSelector / stepAdvanceSelector). Prefer
  // those over the generic scan; fall back to findAdvanceButton when the adapter has
  // no opinion. Scoped to the pack's form root (never document.body). Submit wins over
  // a step-advance so we recognise completion correctly.
  function findPackAdvance(root) {
    if (!driveablePack) return null;
    const scope = root || document;
    try {
      // 1) explicit final-submit recognition via the adapter.
      if (typeof driveablePack.isSubmitHint === 'function') {
        for (const el of qsa('button, input[type="submit"], a[role="button"], [role="button"]', scope)) {
          if (!isProbablyVisible(el) || el.disabled) continue;
          let hit = false;
          try { hit = !!driveablePack.isSubmitHint(btnText(el), el); } catch {}
          if (hit) return el;
        }
      }
      // 2) adapter's in-form Next/Continue (multi-step ATS).
      const advSel = driveablePack.advanceSelector || driveablePack.stepAdvanceSelector;
      if (advSel) {
        for (const el of qsa(advSel, scope)) {
          if (isProbablyVisible(el) && !el.disabled) return el;
        }
      }
    } catch {}
    return null;
  }

  while (S.step < MAX_STEPS && !S.cancelled && !finished) {
    S.step++;
    await untilUnpaused();
    if (S.cancelled) break;

    // ---- hard stops ----
    // (0) BOT-CHALLENGE / CLOUDFLARE WALL — checked FIRST so an anti-automation interstitial
    // is never mislabeled as OCCLUSION (the old failure: a hidden/throttled tab on a CF wall
    // looked like a non-hydrating form, so we kept fronting the window and burning attempts
    // and the diagnostic blamed "occlusion"). On a STRONG challenge signal we STOP: no
    // front-until-hydrate loop, no opener retry, no synthetic submit (cooperates with R1 —
    // never mints success). We PARK it (skipped) with an honest, distinct lastError and flag
    // the host so background.js trips a per-run circuit breaker (one wall must not nuke every
    // same-host job). This is a SITE gate, not a failure of our flow — classified distinctly.
    const challenge = detectBotChallengeOnPage();
    if (challenge.blocked) {
      const why = botChallengeLastError(challenge.kind);
      logLine('warn', `${why} (${challenge.reason}) — stopping; not our flow's failure`);
      setStatus('Site bot-challenge — needs you to verify');
      signalHydrated();   // release any held front-until-hydrated; we are NOT waiting on hydration
      report({
        state: 'skipped',
        lastError: why,
        parkReason: 'bot_challenge',
        botChallenge: { kind: challenge.kind, host: location.hostname.replace(/^www\./, ''), reason: challenge.reason },
        transcriptAppend: { kind: 'recovery', note: `${why} [${challenge.reason}] — site anti-automation gate, parked (host breaker armed)` },
      });
      finalState = 'skipped';
      break;
    }

    const blocker = captchaOrLoginPresent();
    // A recognised CAPTCHA-gated pack (BambooHR) owns its own outcome: fill the
    // whole form, then PARK awaiting_review ('ready — solve the CAPTCHA and submit')
    // via the submitGate handler below. Its reCAPTCHA anchor renders WITH the form,
    // so the generic hard-stop would otherwise fire first on any 2nd loop iteration
    // and park the WRONG state (awaiting_input, 'Complete the site CAPTCHA, then
    // retry') with a misleading retry message. Skip the generic stop for that case
    // only; keep it for login blockers and for every non-driveable host. The
    // never-auto-solve invariant still holds — neither path ever solves/submits.
    const captchaOwnedByPack = blocker === 'captcha'
      && driveablePack && driveablePack.submitGate === 'captcha';
    if (blocker && !captchaOwnedByPack) {
      logLine('warn', `${blocker} detected — handing back to you`);
      setStatus(blocker === 'captcha' ? 'CAPTCHA — your move' : 'Login required — your move');
      const question = blocker === 'captcha' ? 'Complete the site CAPTCHA, then retry this application.' : 'Sign into this site in Chrome, then retry this application.';
      report({ state: 'awaiting_input', lastError: question, parkReason: blocker, pendingQuestions: [{ question, fieldType: 'site_gate', reason: blocker }], transcriptAppend: { kind: 'recovery', note: `${blocker} requires user intervention before retry` } });
      finalState = 'awaiting_input';
      break;
    }

    // ---- LinkedIn Easy Apply daily cap (~50/24h) ----
    // When LinkedIn shows the "reached today's Easy Apply limit" modal, don't try to
    // submit — bail cleanly with a distinguishable marker (lastError prefix
    // `easyapply-limit` + applyRoute:'easy-apply') so the server sets a cooldown and the
    // pump pivots to external/company-site jobs.
    if (easyApplyLimitHit()) {
      logLine('warn', 'LinkedIn Easy Apply daily limit reached — pausing Easy Apply, will pivot to external jobs');
      setStatus('Easy Apply daily limit reached — cooling down');
      report({ state: 'failed', lastError: 'easyapply-limit — daily Easy Apply cap reached', applyRoute: 'easy-apply' });
      finalState = 'failed';
      break;
    }

    // ---- recognised account-less ATS: reveal the form (idempotent, submit-safe) ----
    // BambooHR's "Apply for This Job" opener, Ashby/Lever job→/apply nav, Greenhouse
    // "Apply" scroll-pill. openApply() must be a no-op once the form is present and must
    // NEVER submit. We call it only before the form is grounded so we don't re-open after.
    if (driveablePack && !everHadForm && typeof driveablePack.openApply === 'function') {
      try {
        const acted = driveablePack.openApply();
        if (acted) {
          logLine('ok', `${driveablePack.id}: revealed the application form`);
          await waitForChange(domHash(), 4000);
        }
      } catch (e) { logLine('warn', `${driveablePack.id}: openApply failed (${e?.message || e})`); }
    }

    let formProbe = detectApplyForm();
    // Scope the field scan STRICTLY to the apply modal/form. Prefer the tight
    // Easy-Apply dialog over detectApplyForm()'s container — the latter can fall
    // back to document.body (Workday-style SPAs), and on LinkedIn that let the scan
    // reach the page's global "Search" box, parking every job at submit with a
    // phantom "search search" question. Keep the modal even on LinkedIn steps with
    // no text fields (resume picker/review-only pages); otherwise we lose scope
    // after Next and click the underlying Easy Apply opener forever. NEVER fall
    // back to `document`: with no real apply container we don't scan at all — we
    // just go find the Easy-Apply button below to OPEN the form (findAdvanceButton
    // defaults to document when root is null).
    let dialog = findApplyDialog() || null;
    // Once Easy Apply has opened, its form owns this run. Never fall back to the
    // underlying job-page opener during a brief React transition after Next.
    if (!dialog && everHadForm && /(^|\.)linkedin\.com$/i.test(location.hostname)) {
      setStatus(`Step ${S.step}: waiting for the next Easy Apply page…`);
      dialog = await waitForStickyLinkedInDialog();
      formProbe = detectApplyForm();
    }
    const probedRoot = formProbe?.form || null;
    const onLinkedIn = /(^|\.)linkedin\.com$/i.test(location.hostname);
    const broadLinkedInRoot = onLinkedIn
      && (probedRoot === document || probedRoot === document.body || probedRoot === document.documentElement);
    // detectApplyForm may use document.body for SPA-style ATS pages. That is useful on
    // Workday, but unsafe on LinkedIn: it exposes the underlying Easy Apply opener and
    // global Search field while the modal is transitioning.
    //
    // BUG-1 layer 3: once the Easy Apply form has appeared on linkedin.com, the ONLY safe
    // root is the tight dialog. A probedRoot container can be slightly broader than the
    // modal yet not literally document/body/html (so it slips past broadLinkedInRoot),
    // and it then contains the top-card opener — which the in-form advance scan would
    // re-click (the 1/5-page stall). So when everHadForm && LinkedIn, NEVER fall to
    // probedRoot: use the dialog or nothing (null → the "form disappeared → fail" path
    // below, which retries instead of clicking the opener).
    // Recognised account-less ATS: scope STRICTLY to the adapter's tight application
    // container (formSelector), NEVER document.body. Tight-to-loose fallbacks resolve
    // in the selector itself; if it matches the page root we reject it (the adapter
    // contract forbids document.body). Takes priority over detectApplyForm's probedRoot.
    let packRoot = null;
    if (driveablePack && driveablePack.formSelector) {
      try {
        const el = document.querySelector(driveablePack.formSelector);
        // Reject the page root, and reject any always-present generic container
        // (e.g. `main`, a stray search/newsletter <form>) that holds NO fillable
        // field: latching haveForm/everHadForm on such a container at step 1 would
        // suppress the open-path (openApply / allowOpen nav) that reveals the real
        // application form. Require >=1 input/textarea/select before treating it as
        // the apply root — the unscored fallback must not beat the open-path.
        if (el && el !== document.body && el !== document.documentElement
            && el.querySelector('input, textarea, select')) {
          packRoot = el;
        }
      } catch {}
    }
    const root = onLinkedIn && everHadForm
      ? dialog
      : (dialog || packRoot || (broadLinkedInRoot ? null : probedRoot));
    const haveForm = !!root;
    if (haveForm) {
      everHadForm = true; S.everHadForm = true;
      if (dialog && onLinkedIn) S.routeState = 'linkedin_easy_apply_modal';
      else if (!S.externalRoute && S.routeState === 'unknown') S.routeState = 'same_tab_application';
      signalHydrated(); reportSeen(root, 'apply form');
    }
    if (!haveForm && everHadForm && onLinkedIn) {
      const fingerprint = recoveryFingerprint({ hostname: location.hostname, pathname: location.pathname, label: 'easy apply form', stage: 'lost-after-advance' });
      logLine('warn', 'Easy Apply form disappeared after advancing — stopping instead of re-clicking the opener');
      report({ state: 'failed', lastError: 'Easy Apply form disappeared after advancing — will retry', applyRoute: 'easy-apply', transcriptAppend: { kind: 'recovery', note: 'sticky Easy Apply scope was lost after advance', fingerprint } });
      finalState = 'failed';
      break;
    }

    // ---- fill from profile + learned answers ----
    setStatus(`Step ${S.step}: ${haveForm ? 'filling fields…' : 'opening the application…'}`);
    const suggestions = haveForm ? (await engine.scanFillable(root)).filter((s) => {
      if (NEVER_AUTOFILL_RX.test(s.label)) {
        logLine('warn', `left sensitive field for you: "${s.label.slice(0, 40)}"`);
        return false;
      }
      // Recognised-ATS honeypot trap (BambooHR nickname_*, "leave this field blank"):
      // filling it flags the application as a bot. SKIP it entirely.
      if (driveablePack && typeof driveablePack.isHoneypot === 'function') {
        try {
          if (driveablePack.isHoneypot(s.input)) {
            logLine('warn', `skipped honeypot field "${(s.label || '').slice(0, 40)}" (${driveablePack.id} anti-bot trap)`);
            return false;
          }
        } catch {}
      }
      return true;
    }) : [];
    const filled = await engine.fill(suggestions);
    if (filled) logLine('ok', `filled ${filled} field(s) from profile/history`);

    // ---- resume upload ----
    const att = haveForm ? await tryAttachResume(root, resume) : { attempted: false, attached: 0 };
    // SUCCESS-TRUTH grounding: we opened a real, field-bearing application surface
    // (a verified dialog, or a probed form we filled/attached into) for THIS job.
    // A generic page-level Submit on a careers/search/newsletter/problem-report
    // page never reaches here with a form root, so it can never be grounded.
    if (haveForm && (dialog || filled > 0 || att?.attached > 0)) formGrounded = true;
    if (resume?.id && att.attempted && att.attached === 0) {
      logLine('err', 'resume could not be attached — stopping for you to upload it');
      report({ state: 'failed', lastError: 'resume attachment failed (will retry)' });
      finalState = 'failed';
      break;
    }

    // ---- unknown questions → AI ladder ----
    const unknownAll = haveForm ? await engine.scanUnknown(root) : [];
    const unknown = unknownAll.filter((u) => {
      if (driveablePack && typeof driveablePack.isHoneypot === 'function') {
        try {
          if (driveablePack.isHoneypot(u.input)) {
            logLine('warn', `skipped honeypot field "${(u.label || '').slice(0, 40)}" (${driveablePack.id} anti-bot trap)`);
            return false;
          }
        } catch {}
      }
      return true;
    }).slice(0, 5);
    for (const u of unknown) {
      if (S.cancelled) break;
      if (LEGAL_RX.test(u.label)) {
        logLine('warn', `legal/eligibility question not in profile: "${u.label.slice(0, 60)}" — leaving for you`);
        if (u.required || onJobBoard) park(u.label, u.fieldType, u.options, 'legal/eligibility — needs your answer');
        continue;
      }
      // Optional photo/headshot fields: leave blank + move on — don't park the job on a
      // field that's almost always optional and can't be truthfully auto-answered.
      if (OPTIONAL_SKIP_RX.test(u.label)) {
        logLine('warn', `left optional field blank: "${u.label.slice(0, 40)}" (photo/headshot — not auto-answerable)`);
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
      if (!a || a.refuse || a.confidence < S.sessionSettings.confidence || !a.answer.trim()) {
        logLine('warn', `no grounded answer for "${u.label.slice(0, 50)}" (${a ? 'conf ' + a.confidence : 'ai failed/malformed'})`);
        // Not highly confident → park it (don't guess). Required fields and any
        // job-board screening question must be answered before we submit.
        if (u.required || onJobBoard) park(u.label, u.fieldType, u.options, a && a.reason ? a.reason : 'no confident answer');
        continue;
      }
      const ok = await engine.fill([{ input: u.input, value: a.answer }]);
      if (ok) {
        logLine('ok', `AI answered "${u.label.slice(0, 40)}" (conf ${a.confidence.toFixed(2)})`);
        await engine.recordAnswer({ question: u.label, answer: a.answer, fieldType: u.fieldType, source: 'ai', jobId: job?.id });
      }
    }

    // learn everything currently on the form
    if (haveForm) await engine.captureCurrentAnswers(root, { source: job?.source, jobId: job?.id });

    // ---- supervised: honor a "Wrong" interrupt on the FILLED step (before advancing) ----
    // In Run mode the user may have flagged a bad fill while we paced; open the picker now
    // so the correction lands + applies before this step advances. No-op when unsupervised.
    if (sup && haveForm) {
      try {
        while (sup.consumeWrong() && !S.cancelled && !sup.stopped()) {
          const replacement = await sup.requestCorrection({ label: '' });
          if (replacement) await applyCorrection('', replacement);
        }
      } catch {}
    }

    await untilUnpaused();
    if (S.cancelled) break;

    // ---- advance ----
    setStatus(`Step ${S.step}: looking for next/submit…`);
    // In-form: prefer buttons inside the modal. Not open yet: also try LinkedIn's
    // Easy-Apply button to OPEN the form (covers postings the generic scan misses).
    let btn = haveForm
      ? (findPackAdvance(root) || findAdvanceButton(root, { allowOpen: false }))
      : (findEasyApplyButton() || (allowExternal ? findExternalApplyButton() : null) || findAdvanceButton(root, { allowOpen: true }));
    if (!btn) {
      const opening = !everHadForm;   // the apply form has never appeared yet
      // Background/occluded apply tabs get their JS timers throttled by Chrome, so
      // LinkedIn's Easy-Apply button can hydrate LATE — or render an offsite-looking
      // "Apply" first and swap in the real button seconds later. We therefore do NOT
      // bail early on a "looks external" signal: wait for hydration (nudging the lazy
      // renderer with a scroll), and only decide once the button truly never appears.
      // Was this tab occluded/hidden? Chrome throttles timers in a tab whose window is
      // minimized OR fully covered by another window (Windows native-occlusion), and a
      // throttled tab's SPA (LinkedIn) often never hydrates the Easy-Apply button. Detect
      // it so we (a) wait MUCH longer in real wall-clock and (b) report the true cause.
      const wasHidden = (typeof document !== 'undefined' && document.visibilityState === 'hidden');
      if (wasHidden && opening) {
        if (frontToHydrate) {
          // FRONT-UNTIL-HYDRATED: keep our own apply window front until the form loads (the
          // SW hands focus back the moment we signal apply-hydrated, or after its own ~12s
          // hard cap). A single 700ms nudge re-occludes before a heavy SPA can hydrate, so we
          // need SUSTAINED visible time. Reactive: only fires because we are actually hidden.
          requestFrontUntilHydrated();
        } else {
          // Setting off → keep today's one-shot nudge (briefly raise, restore focus ~700ms).
          try { chrome.runtime?.sendMessage?.({ type: 'jat11.nudge-apply-window' }); } catch {}
        }
      }
      logLine('warn', opening
        ? (wasHidden
            ? (frontToHydrate ? 'apply tab is hidden/occluded — Chrome throttled it; fronting its window until it hydrates' : 'apply tab is hidden/occluded — Chrome throttled it; nudging its window to hydrate')
            : 'application not open yet — waiting for it to hydrate')
        : 'no advance button — waiting for the page (or you)');
      let found = null;
      // A hidden/throttled tab gets ~1 timer tick/sec, so it needs far more real time —
      // give it up to ~3 min (the pool's hard timeout still caps a truly dead tab). BUT once
      // we've FRONTED the window (front-until-hydrated), the tab is no longer throttled, so a
      // page that STILL won't hydrate within the SW's front cap (~12s) is genuinely stuck —
      // don't burn the full 3 min; fail fast/retriably (retryStaleQueue re-attempts later).
      const frontedCap = 28;   // ~14s of 500ms ticks — comfortably past the SW front hard-cap
      const tries = opening ? ((wasHidden && frontToHydrate) ? frontedCap : (wasHidden ? 180 : 40)) : 60;
      for (let i = 0; i < tries && !S.cancelled; i++) {
        if (opening && i % 4 === 0) { try { window.scrollTo(0, 600); window.scrollTo(0, 0); } catch {} }
        await sleep(500);
        found = haveForm
          ? (findPackAdvance(root) || findAdvanceButton(root, { allowOpen: false }))
          : (findEasyApplyButton() || (allowExternal ? findExternalApplyButton() : null) || findAdvanceButton(document, { allowOpen: true }));
        if (found) { signalHydrated(); break; }
      }
      if (!found) {
        // If we're stuck because of unanswered questions, park (self-heal) so the
        // next run can ask + retry.
        if (parked.length) { reportParked('no-advance'); break; }
        if (submitAttempted) {
          // Final submit clicked but confirmation not seen — flag for a look, don't
          // falsely stamp submitted.
          logLine('ok', 'final submit clicked — confirmation not detected; flagged for your review');
          report({ state: 'awaiting_review', lastError: 'submitted but not auto-confirmed — please verify', transcriptAppend: { note: 'submit clicked; no confirmation seen' } });
          finalState = 'awaiting_review';
          break;
        }
        // The Easy-Apply form never opened this pass. Distinguish two cases:
        if (opening && loginApplyPresent()) {
          report({
            state: 'skipped',
            lastError: 'site sign-in required before applying — skipped',
            applyRoute: 'external',
            transcriptAppend: { note: 'job board requires sign-in before apply; not retriable as hydration' },
          });
          finalState = 'skipped'; break;
        }
        const ext = opening && externalApplyPresent();
        if (ext) {
          // "Looks external + the form never opened." This is reliable ONLY once the tab
          // has been visible/settled and we've already given it a real retry — LinkedIn
          // frequently renders an offsite-looking "Apply" first and swaps in the real
          // Easy-Apply button seconds later, and a hidden/throttled tab amplifies that.
          // Committing to a TERMINAL external verdict on the first pass terminal-skipped
          // jobs that would have been drivable (the over-aggressive 07bb35e gate). So:
          // on the first attempt of a tab that was hidden/throttled, fail RETRIABLY
          // (transient phrasing → classifier routes to transient_page/retry); only commit
          // to the honest terminal external state once it persists across attempts.
          const attemptN = Number(task?.attempts) || 0;
          const confidentExternal = attemptN >= 1 || !wasHidden;
          if (!confidentExternal) {
            // NOTE: keep this lastError free of "external"/"company site" so the server's
            // failure classifier routes it to transient_page (retry), not external_site
            // (inspect/terminal). It IS a transient hydration miss on a throttled tab.
            logLine('warn', 'apply form never hydrated on this hidden/throttled tab — will retry before judging the posting non-drivable');
            report({
              state: 'failed',
              lastError: 'apply form did not hydrate on a throttled/occluded tab — will retry',
              transcriptAppend: { note: 'deferred non-drivable verdict: first attempt, tab was hidden/throttled' },
            });
            finalState = 'failed'; break;
          }
          // A genuinely EXTERNAL posting (apply on the company site) — JAT can't drive it.
          // SKIP it (terminal): retrying wastes the pool + drags the success rate, and the
          // tab is now an active/visible (or already-retried) window so this is reliable.
          const st = allowExternal ? 'failed' : 'skipped';
          report({ state: st, lastError: allowExternal ? 'external apply button was present but could not be opened — inspect' : 'external — apply on the company site (not auto-applicable)', applyRoute: 'external' });
          finalState = st; break;
        }
        // Otherwise it's a transient non-open (late/throttled hydration, verification
        // gate) — fail RETRIABLY so retryStaleQueue re-attempts it later (capped).
        report({
          state: 'failed',
          lastError: opening
            ? (wasHidden
                ? 'apply window was occluded → Chrome throttled the tab so LinkedIn never hydrated — keep its window uncovered (or enable bring-to-front) — will retry'
                : 'Easy-Apply form did not hydrate — will retry')
            : 'no advance button found — will retry',
        });
        finalState = 'failed';
        break;
      }
      continue;
    }

    // FINAL-submit recognition: the adapter's isSubmitHint wins for recognised ATS
    // (it knows the platform's exact submit button), else the generic recognizer.
    let packSubmit = false;
    if (driveablePack && typeof driveablePack.isSubmitHint === 'function') {
      try { packSubmit = !!driveablePack.isSubmitHint(btnText(btn), btn); } catch {}
    }
    const isFinal = packSubmit || isFinalSubmit(btn);
    if (isFinal) {
      // SAFETY NET: never submit a job that still has unanswered questions.
      if (parked.length) { reportParked('final-submit'); break; }
      // ---- CAPTCHA-gated ATS (BambooHR): fill everything, DO NOT submit ----
      // A reCAPTCHA sits above the submit button. We've filled the whole form; now we
      // PARK for a human to solve the CAPTCHA and click submit. Never auto-solve.
      if (driveablePack && driveablePack.submitGate === 'captcha') {
        const why = 'ready — solve the CAPTCHA and submit';
        logLine('ok', `${driveablePack.id}: form filled — ${why}`);
        setStatus('Ready — solve the CAPTCHA and submit');
        report({
          state: 'awaiting_review',
          lastError: why,
          applyRoute: 'external',
          transcriptAppend: { kind: 'recovery', note: `${driveablePack.id} CAPTCHA gate — filled, parked for human submit` },
        });
        finalState = 'awaiting_review';
        break;
      }
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
    // an unrelated modal (cookie/consent) closing. For a recognised account-less
    // pack the snapshot scope is the adapter form root (no LinkedIn dialog).
    const submitDialog = isFinal ? (dialog || (driveablePack ? root : null)) : null;

    // Re-verify the button is still clickable right before acting — the DOM may
    // have changed since findAdvanceButton() above (validation re-render, etc.).
    let clickBtn = btn;
    if (clickBtn.disabled || !isProbablyVisible(clickBtn) || !document.contains(clickBtn)) {
      clickBtn = haveForm
        ? (findPackAdvance(root) || findAdvanceButton(root, { allowOpen: false }))
        : (findEasyApplyButton() || (allowExternal ? findExternalApplyButton() : null) || findAdvanceButton(document, { allowOpen: true }));
      if (!clickBtn) { logLine('warn', 'advance button became invalid before click — re-scanning'); continue; }
    }
    const label = btnText(clickBtn).slice(0, 30);
    const controlRoute = !haveForm ? classifyApplyControl(clickBtn) : { state: S.routeState || 'unknown' };
    const externalClick = !haveForm && allowExternal && controlRoute.state.startsWith('external_');
    if (!haveForm && controlRoute.state === 'linkedin_easy_apply_modal') S.routeState = 'linkedin_easy_apply_modal';
    const pageAction = !haveForm
      ? recoveryFingerprint({ hostname: location.hostname, pathname: location.pathname, label, stage: externalClick ? 'external-opener' : 'apply-opener' })
      : '';
    if (pageAction && pageAction === lastPageAction) {
      // Before declaring the opener dead: on LinkedIn this repeat usually means an
      // INTERMEDIATE resume/continue/review modal is up (no answerable fields, so
      // haveForm was false), and we're about to re-click the underlying opener. Advance
      // THROUGH the interstitial instead — without re-clicking the opener (sticky modal
      // scope preserved). If it advances, restart the loop to reach the real form.
      if (interstitialAdvances < 4 && await handleLinkedInInterstitial()) {
        interstitialAdvances++;
        logLine('ok', 'advanced past a LinkedIn interstitial — re-scanning for the apply form');
        report({ transcriptAppend: { kind: 'recovery', note: 'advanced LinkedIn resume/continue interstitial', fingerprint: pageAction } });
        lastPageAction = null;   // the interstitial advance is real progress; allow the next opener/advance
        continue;
      }
      logLine('warn', `same page-level action repeated — stopping before another "${label}" click`);
      report({ state: 'failed', lastError: `repeated page-level action did not transfer: ${label}`, transcriptAppend: { kind: 'recovery', note: 'duplicate opener blocked', fingerprint: pageAction } });
      finalState = 'failed';
      break;
    }
    if (pageAction) lastPageAction = pageAction;
    // ---- BUG-3: external/company-ATS no-progress cap ----
    // When driving an EXTERNAL/company site (allowExternal + an external or same-tab
    // application route, NOT a LinkedIn Easy Apply modal), an ATS that re-renders the page
    // on every click defeats the opener breaker (which resets on any DOM change). Count
    // consecutive clicks of the SAME label at the SAME URL; at the stall limit, STOP and
    // park cleanly instead of looping to MAX_STEPS (the BMO "Apply" ×40 failure). BUG-1
    // owns the LinkedIn Easy Apply advance path, so we explicitly exclude it here.
    // RECOGNISED account-less ATS (driveablePack) is EXCLUDED: it has a known multi-step
    // flow we now drive to completion, so the no-progress cap must not kill it mid-form.
    // The cap stays the fallback ONLY for UNRECOGNISED external hosts.
    const onExternalSite = allowExternal
      && !driveablePack
      && S.routeState !== 'linkedin_easy_apply_modal'
      && !/(^|\.)linkedin\.com$/i.test(location.hostname)   // BUG-1 owns the LinkedIn path
      && (S.externalRoute || externalClick
          || S.routeState === 'same_tab_application'
          || (typeof S.routeState === 'string' && S.routeState.startsWith('external_')));
    if (onExternalSite) {
      if (label && label === extLastLabel && location.href === extLastUrl) extRepeat++;
      else extRepeat = 0;
      extLastLabel = label; extLastUrl = location.href;
      if (extRepeat >= S.sessionSettings.stallLimit) {
        const fingerprint = recoveryFingerprint({ hostname: location.hostname, pathname: location.pathname, label, stage: 'external-no-progress' });
        logLine('warn', `external site stuck — "${label}" clicked ${extRepeat + 1}× with no progress; parking for you`);
        report({
          state: allowExternal ? 'skipped' : 'failed',
          lastError: `couldn't drive the company application site — needs you (stuck on "${label}")`,
          applyRoute: applyRouteForState(S.routeState),
          transcriptAppend: { kind: 'recovery', note: 'external/company-ATS no-progress cap — repeated advance click did not transfer', fingerprint, count: extRepeat + 1 },
        });
        finalState = allowExternal ? 'skipped' : 'failed';
        break;
      }
    }
    // ---- supervised gate [T4] ----  (no-op when not a supervised run)
    // Pause before advancing for the user's OK (Step mode) / honor a "Wrong" interrupt
    // (Run mode). A correction here rewrites the recipe + applies live before we advance.
    if (sup) {
      const verdict = isFinal
        ? await sup.beforeSubmit({ root, label, text: `Final submit ready: "${label}"` })
        : await superviseGate({ root, label, text: `About to click "${label}"` });
      if (verdict === 'stopped') { break; }
      if (isFinal && verdict !== 'apply') { cancel('submit-not-approved'); break; }
      if (isFinal) report({ transcriptAppend: { kind: 'control', note: 'user explicitly approved final submit' } });
    }
    logLine('ok', `clicking "${label}"`);
    let handoffToken = null;
    let handoffPromise = null;
    if (externalClick) {
      S.externalRoute = true;
      S.routeState = controlRoute.state;
      logLine('ok', 'opening external/company apply route');
      const armed = await send({ type: 'jat11.external-handoff-arm', taskId: task?.id, routeState: controlRoute.state });
      handoffToken = armed?.ok ? armed.token : null;
      if (handoffToken) {
        // Begin listening BEFORE the click. A same-tab external navigation destroys
        // this content world immediately; the service worker must already own the
        // transition when that happens.
        handoffPromise = send({ type: 'jat11.external-handoff-run', token: handoffToken, task, context: { ...context, routeState: controlRoute.state } });
      }
    }
    setStatus(`Step ${S.step}: "${label}"…`);
    const beforeClickUrl = location.href;
    const prevHash = domHash();
    // SUCCESS-TRUTH: snapshot the application surface IMMEDIATELY before a final
    // submit, so the post-click evaluator diffs against this exact baseline and
    // can never mint a "done" from pre-existing static success-like page text.
    const submitBaseline = (isFinal && mode !== 'review')
      ? submitSnapshot(submitDialog || findApplyDialog())
      : null;
    const submitClickAt = Date.now();
    syntheticClick(clickBtn);
    if (externalClick && handoffToken) {
      setStatus('Transferring control to the company application…');
      const handoff = await handoffPromise;
      if (handoff?.captured) {
        const childResult = handoff.result || null;
        const childState = ['done', 'awaiting_review', 'awaiting_input', 'parked', 'failed', 'skipped'].includes(childResult?.state)
          ? childResult.state : 'failed';
        const childError = childResult?.error || childResult?.lastError || handoff?.error || null;
        report({
          state: childState,
          lastError: childState === 'failed' ? (childError || 'external executor failed without a diagnostic') : childError,
          parkReason: childResult?.parkReason,
          pendingQuestions: childResult?.pendingQuestions,
          applyRoute: 'external', routeState: controlRoute.state,
          submissionEvidence: childResult?.submissionEvidence,
          handoffToken,
          transcriptAppend: { kind: 'handoff', note: `external child result adopted: ${childState}` },
        });
        logLine(childState === 'done' ? 'ok' : 'warn', `external executor finished: ${childState}`);
        finalState = childState;
        finished = true;
        break;
      }
    }
    const changed = await waitForChange(prevHash);
    if (changed && S.routeState === 'unknown') {
      const observed = observeRoute({ beforeUrl: beforeClickUrl, afterUrl: location.href, dialogOpen: !!findApplyDialog() });
      S.routeState = observed.state;
    }
    // We only reach here for an external click whose handoff did NOT adopt an owned child
    // executor (a captured child already broke out above). Don't hard-fail: an external
    // opener we can't drive via the SW handoff is recoverable, not terminal.
    if (externalClick) {
      if (changed) {
        // The click DID transition this tab — typically a same-tab off-origin navigation
        // to the company ATS. Fall back to the PRIOR in-tab behavior: keep driving the
        // page in-tab (the loop re-detects the apply form / advance button next pass).
        // Clear externalRoute so the loop treats it as a normal same-tab application.
        logLine('ok', 'external target navigated in-tab — continuing to drive it here');
        S.externalRoute = false;
        if (S.routeState === 'external_same_tab' || S.routeState === 'external_new_tab') {
          S.routeState = 'same_tab_application';
        }
        continue;
      }
      // No transition and no captured child → a transient miss (child tab not yet owned,
      // late opener, redirect chain still settling). Report RETRIABLY — phrased so the
      // server's failure classifier reads it as transient_page (retry), not external_site
      // (inspect/terminal). The in-run duplicate-opener breaker already prevents a second
      // click this pass, and the queue's attempts cap bounds cross-run retries, so this
      // can't loop forever.
      const fingerprint = recoveryFingerprint({ hostname: location.hostname, pathname: location.pathname, label, stage: 'external-handoff-missing' });
      logLine('warn', 'apply handoff did not attach this pass — will retry');
      report({ state: 'failed', lastError: 'apply handoff did not attach — page did not change; will retry', applyRoute: applyRouteForState(S.routeState), transcriptAppend: { kind: 'recovery', note: 'external handoff target was not captured this pass', fingerprint } });
      finalState = 'failed';
      break;
    }
    // Stall guard: 3 advance clicks in a row with no page change → we're stuck on a
    // step (validation we can't satisfy, a dead button). Stop cleanly instead of
    // spinning to MAX_STEPS. NEVER count the final-submit click — its confirmation
    // (below) renders a beat later and must run, or a real submit gets mis-reported.
    const isFinalAuto = isFinal && mode !== 'review';
    if (!changed && !isFinalAuto) {
      logLine('warn', 'page did not change after click');
      if (++noChange >= S.sessionSettings.stallLimit) {
        if (sup) {
          const fingerprint = recoveryFingerprint({ hostname: location.hostname, pathname: location.pathname, label, stage: 'unchanged-screen' });
          report({ transcriptAppend: { kind: 'recovery', note: 'repeated unchanged screen', fingerprint, count: noChange } });
          const decision = await sup.recoveryDecision({ reason: `stalled x${noChange}`, text: `The page did not advance after "${label}". Retry, fix the correct element, or skip.` });
          report({ transcriptAppend: { kind: 'recovery', note: `user chose ${decision}`, fingerprint } });
          if (decision === 'retry') { noChange = 0; continue; }
          if (decision === 'fix') {
            const replacement = await sup.requestCorrection({ label });
            if (replacement) await applyCorrection(label, replacement);
            noChange = 0; continue;
          }
          cancel('recovery-skip');
          break;
        }
        if (parked.length) { reportParked('stalled'); break; }
        // Find WHY the page won't advance. LinkedIn flags the offending field with an
        // INLINE ERROR (role=alert / artdeco-inline-feedback--error) — that's the ground
        // truth for what's blocking, even when the field isn't "empty" in a way the field
        // scan catches (bad format, a resume that didn't attach, an un-pickable dropdown).
        let resumeBlocked = false;
        let blockerText = '';            // the exact on-screen reason the page won't advance
        let blockerLabels = [];
        await sleep(700);   // LinkedIn renders the inline errors a beat AFTER the rejected click
        try {
          const scope = root || document;
          const errEls = Array.from(scope.querySelectorAll('.artdeco-inline-feedback--error, [class*="inline-feedback--error"], [class*="error-text"], [class*="form-element__error"], [data-test-form-element-error-messages], [role="alert"]'))
            .filter((e) => isProbablyVisible(e) && (e.textContent || '').trim() && /required|invalid|select|enter|provide|valid|must|please|choose|answer/i.test(e.textContent || ''));
          for (const er of errEls.slice(0, 6)) {
            const errTxt = compactText(er.textContent || '').slice(0, 90);
            const cont = er.closest('[data-test-form-element], .fb-dash-form-element, .jobs-easy-apply-form-element, fieldset, [class*="form-element"]') || er.parentElement;
            const lbl = compactText(cont?.querySelector('label, legend, .t-bold, [class*="label"]')?.textContent || '');
            if (!blockerText) blockerText = lbl ? `${lbl} — ${errTxt}` : errTxt;
            if (/resume|cv\b|upload/i.test(errTxt)) { resumeBlocked = true; continue; }   // not a question — a failed attach
            if (lbl) { blockerLabels.push(lbl); park(lbl.slice(0, 120), 'text', null, 'blocked the application: ' + errTxt); }
          }
        } catch {}
        // Also park any required field still empty (a dropdown we couldn't auto-pick).
        try {
          const unfilled = (await engine.scanUnknown(root)).filter((u) => u && u.required);
          for (const u of unfilled.slice(0, 5)) { if (!blockerText) blockerText = `${u.label} — required, not filled`; park(u.label, u.fieldType, u.options, 'blocked the application — needs your answer'); }
        } catch {}
        if (parked.length) { logLine('warn', 'blocked by: ' + (blockerLabels.join('; ') || blockerText)); reportParked('stalled'); break; }
        if (resumeBlocked) {
          logLine('err', 'résumé did not attach — flagged for retry');
          report({ state: 'failed', lastError: 'résumé did not attach (LinkedIn says it is required) — will retry' });
          finalState = 'failed'; break;
        }
        // Report the SPECIFIC blocker (what was on screen), not a generic "stuck", so we
        // know exactly which field to resolve next.
        const why = blockerText ? `blocked: ${blockerText} — will retry` : 'stuck on a step (page stopped advancing) — will retry';
        logLine('warn', 'stuck — ' + (blockerText || 'page stopped advancing'));
        const fingerprint = recoveryFingerprint({ hostname: location.hostname, pathname: location.pathname, label, stage: 'unchanged-screen' });
        report({ state: 'failed', lastError: why, transcriptAppend: { kind: 'recovery', note: 'automatic recovery exhausted on unchanged screen', fingerprint, count: noChange } });
        finalState = 'failed';
        break;
      }
    } else if (changed) { noChange = 0; }

    // ---- confirm a real submit (auto mode) — SUCCESS-TRUTH ----
    // A "done" must be TRUSTWORTHY, never a false positive. After the final-submit
    // click we WAIT for the confirmation to settle (the banner / modal-close renders
    // a beat later) and then prove the submit with a POST-CLICK CHANGE diffed against
    // the pre-click baseline: a NEW confirmation container, the surface text BECOMING
    // success (not already-static), a navigation to a real confirmation URL, OR a
    // correlated network POST. Pre-existing static "thank you"/recruitment text — the
    // Activision / Canada Job Bank false positives — can never count. A submit that
    // can't be proven is reported submitted-but-unverified (awaiting_review), never done.
    if (isFinal && mode !== 'review') {
      submitAttempted = true;
      setStatus('Submitting — waiting for confirmation…');
      const how = await confirmSubmitted(submitDialog);   // settle wait (also early-true on modal close)
      const after = submitSnapshot(submitDialog || findApplyDialog());
      const verdict = evaluateSubmitEvidence({
        before: submitBaseline || { url: beforeClickUrl, successText: false, text: '' },
        after,
        formGrounded,
        msElapsed: Date.now() - submitClickAt,
        urlBefore: beforeClickUrl,
        urlAfter: location.href,
        newNodes: newConfirmationNodes(submitBaseline),
      });
      // confirmSubmitted's "apply form closed" is corroborating, but only counts when
      // the form was grounded — a closed unrelated modal is not proof.
      const formClosed = how === 'apply form closed' && formGrounded;
      // ADDITIONAL (recognised-ATS) confirmation: the adapter's confirmSignals — but ONLY
      // when they are NEW (present AFTER the submit click, absent in the pre-click baseline).
      // This NEVER weakens R1: it requires a grounded form (R1's gate) AND a genuinely new
      // signal, so pre-existing static "thank you" copy can't mint a false done.
      let packSignalReason = null;
      if (driveablePack && formGrounded && Array.isArray(driveablePack.confirmSignals)) {
        const src = confirmSignalsMatched(driveablePack.confirmSignals, (submitBaseline?.text || ''), (after?.text || ''));
        if (src) packSignalReason = `confirm-signal:${src}`;
      }
      if (verdict.verified || formClosed || packSignalReason) {
        const reason = verdict.verified ? verdict.reason : (packSignalReason || 'apply-form-closed');
        logLine('ok', `✓ application submitted (${reason})`);
        setStatus('✓ Application submitted');
        // Mark the JOB submitted too, so it's counted even if the passive capture
        // detector misses the banner (queuePatch only updates the task).
        if (job?.id) await send({ type: 'api-call', method: 'PATCH', path: '/jobs/' + encodeURIComponent(job.id), body: { status: 'submitted' } });
        report({ state: 'done', submissionEvidence: { type: 'verified', reason, detail: how || reason, url: location.href, at: new Date().toISOString() }, transcriptAppend: { note: `submitted — verified (${reason})` } });
        finalState = 'done';
        finished = true;
        continue;
      }
      // Submit was clicked but NOT proven. Do not fabricate a done. Report
      // submitted-but-unverified so the user confirms it, rather than trusting it.
      logLine('warn', `submit not verified (${verdict.reason}) — flagged for your review`);
      setStatus('Submitted — awaiting your confirmation');
      report({ state: 'awaiting_review', lastError: `submit was clicked but could not be verified (${verdict.reason}) — please confirm`, transcriptAppend: { note: `submit unverified — ${verdict.reason}` } });
      finalState = 'awaiting_review';
      finished = true;
      continue;
    }
    if (changed) lastPageAction = '';
    await sleep(600);
  }

  if (!finalState && !S.cancelled && S.step >= MAX_STEPS) {
    if (parked.length) { reportParked('max-steps'); }
    else {
      logLine('warn', 'max steps reached — stopping for safety');
      report({ state: 'failed', lastError: 'max steps reached — will retry' });
      finalState = 'failed';
    }
  }

  S.running = false;
  // Always release any held front-until-hydrated so focus is handed back even if the run
  // ended before the form hydrated (external/failed/cancelled). No-op when none requested.
  try { signalHydrated(); } catch {}
  try { sup?.destroy(); } catch {}
  S.supervisor = null;
  hideOverlay(finalState === 'awaiting_review' || finalState === 'awaiting_input' || finalState === 'parked' ? 60000 : 4000);
  return {
    ok: true,
    state: finalState || (S.cancelled ? 'skipped' : 'unknown'),
    steps: S.step,
    nextRequested: S.nextRequested,
    lastError: S.lastReport?.lastError || null,
    parkReason: S.lastReport?.parkReason || null,
    pendingQuestions: S.lastReport?.pendingQuestions || [],
    submissionEvidence: S.lastReport?.submissionEvidence || null,
    routeState: S.routeState || 'unknown',
  };
}
