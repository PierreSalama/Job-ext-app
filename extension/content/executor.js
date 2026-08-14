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

import { AutofillEngine, setNativeValue, fieldLabel, fillCombobox, pickRadioInGroup, matchOption, isResumeFileInput, isFillable, radioGroupLabel, selectGroupLabel, isSiteChromeInput, bestFuzzyIndex, isJunkQuestionKey, nearestQuestionText, UI_INSTRUCTION_RX } from './autofill.js';
import { detectApplyForm } from './signals/forms.js';
import { isSubmitClick } from './signals/intent.js';
// SUCCESS_TEXT_RX is imported for the [TRACE 9b] reject-detail diagnostic only — it reports which
// baseline phrase set before.successText (and so disabled the textBecameSuccess path). It must be
// imported explicitly: that trace sits inside a try/catch, so a missing binding would be swallowed
// and the diagnostic would silently never emit.
import { pageTextLooksLikeSuccess, urlLooksLikeSuccess, evaluateSubmitEvidence, SUCCESS_TEXT_RX } from './signals/success.js';
import { qsa, isProbablyVisible, compactText } from './lib/dom.js';
import { redactValue, redactLabel } from './lib/redact.js';
import { planReplay, resolveStepAnswer, paceDelay, classifyDivergence, resolveLocator, recoveryFingerprint, shouldResetPageActionBreaker } from './replay.js';
import { classifyApplyControl, observeRoute, applyRouteForState } from './route.js';
import { classifyInterstitial } from './lib/interstitial.js';
import { shouldFrontOnOpenerStall, classifyNoChangeRoute } from './lib/opener-stall.js';
import { detectBotChallenge, botChallengeLastError } from './lib/challenge.js';
import { ADVANCE_KEYWORDS, isAdvanceLabel, stripLoadingPrefix } from './lib/advance.js';
import { isLinkedInEasyApplyApplyUrl, isLinkedInApplyAdvanceLabel, deriveApplyRootFromAdvanceButton, shouldUseGenericOpenFallback, detectLinkedInExternalPosting, decideResumePage, isUploadResumeAffordanceLabel, pageRequiresResume, groundedEligibilityAnswer, isEligibilityScreeningQuestion, isReferralQuestion, referralDefaultAnswer, decideAnswerOrPark } from './lib/linkedin-apply.js';
import { sitePack } from './sites/index.js';
import { confirmSignalsMatched, findPackSubmitBroadened } from './lib/ats-drive.js';

const MAX_STEPS = 40;
const STEP_TIMEOUT = 9000;
// Both word orders: "work authorization" AND "authorized to work" (the latter is the common
// LinkedIn phrasing — without `authoriz.*work` it slipped past this gate to the AI ladder, so a
// flaky/offline local AI could leave the most basic screening Q unanswered; now it's deterministically
// grounded from the profile's stated work authorization).
const LEGAL_RX = /(work.*authoriz|authoriz.*work|sponsor|visa|citizen|clearance|ethnic|race|gender|disabilit|veteran|criminal|background.*check)/i;
// Demographic / sensitive fields we NEVER auto-fill from any source (not even
// the profile) — the user must consciously answer these in the form. Work
// authorization / sponsorship / citizenship stay fillable (that's the profile's
// purpose); this list is the EEO + criminal-history subset only.
// THIS IS THE THIRD COPY of the same guard (autofill.js NEVER_AUTOFILL_RX, db.js SENSITIVE_RX).
// They must agree — see tests/pronoun-parity.test.mjs. Two corrections applied 2026-08-08:
//   • `pronoun` REMOVED, matching the other two. Pierre asked for pronoun questions to be answered;
//     autofill.js and db.js were updated but this copy was missed, so 12 postings kept parking on
//     "Pronouns *" — the guard nearest the form still won.
//   • `conviction` → `convict` plus `\bcrimes?\b`: the commonest real phrasing, "Have you been
//     CONVICTED of a CRIME for which you have not received a pardon?", matched neither `conviction`
//     nor `criminal` and so was never blocked.
const NEVER_AUTOFILL_RX = /(ethnic|race\b|gender|\bsex\b|disabilit|veteran|criminal|convict|\bcrimes?\b|background.*check|felony)/i;
// Optional, non-text-answerable fields (a profile photo/headshot URL, etc.) — leave
// them BLANK and move on instead of parking the whole job. They're almost always
// optional, and the AI correctly refuses to invent a photo URL.
const OPTIONAL_SKIP_RX = /(head\s?shot|profile (photo|picture|image)|upload (a )?(photo|picture|image)|\bphoto\b|\bavatar\b|picture of you|middle name|middle initial)/i;
// Challenge COPY only — NOT the bare word "captcha", which matches the benign "protected by
// reCAPTCHA" privacy badge that Indeed and most sites embed for background form protection (the
// live false-positive that aborted every Indeed apply). A real wall says "complete the captcha",
// "captcha to continue", "verify you're human", "press and hold", etc.
const CAPTCHA_RX = /(?:complete|solve|enter|pass|type)\s+(?:the\s+)?(?:security\s+)?captcha|captcha\s+(?:to continue|required|verification|challenge)|verify (that )?you(['’ʼ]| a)re (a )?human|unusual activity|are you a robot|press (?:and|&) hold/i;
// LinkedIn caps Easy Apply at ~50 submissions / rolling 24h. When hit it shows a modal
// "You reached today's Easy Apply limit." Detect it so the server can cool down the
// route and PIVOT to external/company-site jobs instead of wasting the cooldown trying.
// APOSTROPHE CLASS, not a bare ': LinkedIn renders the TYPOGRAPHIC apostrophe U+2019 --
// "You reached today’s Easy Apply limit" -- so /today'?s/ never matched the real modal and the
// cap went undetected on every run. Verified against the live DOM 2026-07-20: clicking the
// opener opens the modal (dialog present, body contains the copy) while both regexes below
// returned false; they return true only against an ASCII-apostrophe version of the same string
// that LinkedIn never actually ships. Consequence: setEasyApplyCooldown() had never once armed,
// so after hitting the ~50/24h cap the pool kept feeding LinkedIn jobs that could not succeed,
// each failing as "repeated page-level action did not transfer: Easy Apply to this job".
const APOS = "['’ʼ‘`´]";
const EASYAPPLY_LIMIT_RX = new RegExp(`reached (today${APOS}?s )?easy apply limit`, 'i');
const DAILY_LIMIT_NEAR_EASYAPPLY_RX = new RegExp(`(daily|today${APOS}?s)[^.]{0,40}\\blimit\\b`, 'i');
const LOGIN_APPLY_RX = /(?:sign\s*in|log\s*in|connectez[- ]vous|se connecter|connexion)[^.!?\n]{0,80}(?:apply|postuler)|(?:apply|postuler)[^.!?\n]{0,80}(?:sign\s*in|log\s*in|connectez[- ]vous|se connecter|connexion)/i;
const EXTERNAL_APPLY_RX = /apply on (?:the )?(?:company|employer)|apply externally|on company (?:site|website)|apply on .* website|postuler sur le site (?:de l['’]employeur|employeur|de l['’]entreprise|entreprise)|site (?:de l['’]employeur|employeur|de l['’]entreprise|entreprise)/i;
// LinkedIn's OWN marker that a posting routes applicants to the employer's ATS rather than
// Easy Apply: the job card / top card shows "Responses managed off LinkedIn" (FR: "Réponses
// gérées en dehors de LinkedIn"). This is a POSITIVE external signal — when it's present
// there is no Easy Apply to click, so the executor can FAST-skip instead of waiting out the
// hydration cap. (Confirmed firsthand on eBay job 4412182454.)
const MANAGED_OFF_LINKEDIN_RX = /responses managed off linkedin|r[ée]ponses g[ée]r[ée]es (?:en dehors|hors) de linkedin/i;
// ADVANCE_KEYWORDS / OPEN_KEYWORDS / isAdvanceLabel are the pure advance-vs-opener
// decision (BUG-1), in ./lib/advance.js so they're node-testable without a DOM.
const FINAL_SUBMIT_RX = /^(submit( application)?|send( application)?|soumettre|envoyer( ma candidature)?|confirm and submit)$/i;
// NOTE on the native <dialog> entries: LinkedIn rebuilt Easy Apply on the native HTML
// <dialog> element with fully OBFUSCATED class names (._495513b8._7402b93d…) and NO
// explicit role attribute. A native <dialog> only carries an IMPLICIT aria role, so
// '[role="dialog"]' — an attribute selector — can never match it. The modal was opening
// and working perfectly while findApplyDialog() stayed blind to it, which surfaced as
// "apply opener clicked but the modal did not mount" → "repeated page-level action did
// not transfer" on EVERY LinkedIn Easy Apply. Verified against the live DOM: both
// dialog[data-testid="dialog"] and [data-testid="dialog-content"] resolve the real modal
// ("Apply to <Company> · 1/4 pages · Contact info") and clear findApplyDialog's
// field/advance/text gates. Class names are hashed per build, so they are NOT usable.
const APPLY_DIALOG_SEL = '.jobs-easy-apply-modal, .jobs-easy-apply-content, .jobs-easy-apply-content__wrapper, .jobs-easy-apply-modal-content, [data-test-modal][role="dialog"], [role="dialog"][aria-modal="true"], dialog[open], [data-testid="dialog"], [data-testid="dialog-content"], .ia-Modal, [data-testid="smartapply-container"]';

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
// Default ceiling for a round-trip to the background service worker.
export const SEND_TIMEOUT_MS = 30000;

// EVERY executor↔SW call goes through here, and it used to have NO timeout: a bare
// chrome.runtime.sendMessage wrapped in a Promise that settles ONLY when the callback fires. Under
// MV3 the service worker can be evicted or stalled mid-call, the callback never runs, and the
// promise never settles — so the executor waits forever holding a worker slot.
//
// Live 2026-08-09 on the laptop, one Machine Learning Engineer application: a 2602-second (43 MIN)
// gap immediately after the resume step, which awaits send({type:'get-document'}). The task ran 50
// minutes against a nominal 5.5-minute apply budget. Timeouts were 51% of all outcomes, and this is
// why the per-apply timeout could not contain them — the hang is BELOW it, in an await that has no
// ceiling of its own.
//
// Resolving null on timeout is safe by construction: every caller already handles a null/!ok reply
// (`if (!r?.ok)`), because the SW could always legitimately fail. A message may ask for a longer
// budget (the AI rescue passes timeoutMs: 150000); honour it, plus headroom, so the background's own
// timeout wins and a legitimately slow call is never cut short.
const send = (msg) => new Promise((res) => {
  let settled = false;
  const finish = (v) => { if (!settled) { settled = true; res(v); } };
  const budget = Math.max(Number(msg && msg.timeoutMs) || 0, SEND_TIMEOUT_MS) + 5000;
  const timer = setTimeout(() => finish(null), budget);
  try {
    chrome.runtime.sendMessage(msg, (r) => { clearTimeout(timer); void chrome.runtime.lastError; finish(r); });
  } catch { clearTimeout(timer); finish(null); }
});

// In-tab alert for a human Cloudflare check — the reliable fallback when the OS suppresses the
// notification / blocks window-focus. A big fixed banner the user can't miss once on the tab, plus
// a short beep to draw attention (best-effort: autoplay may block it).
function showCfBanner() {
  try {
    if (document.getElementById('jat11-cf-banner')) return;
    const b = document.createElement('div');
    b.id = 'jat11-cf-banner';
    b.setAttribute('style', 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#d4351c;color:#fff;font:700 16px/1.45 system-ui,Segoe UI,sans-serif;padding:14px 18px;text-align:center;box-shadow:0 2px 14px rgba(0,0,0,.45)');
    b.textContent = '⚠ Auto-apply is waiting — please complete the “I’m human” check on this page. It will continue automatically once you do.';
    (document.body || document.documentElement).appendChild(b);
  } catch {}
}
function hideCfBanner() { try { document.getElementById('jat11-cf-banner')?.remove(); } catch {} }
function cfBeep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    // Chrome's autoplay policy leaves the context 'suspended' until a real user gesture;
    // calling start() then logs "AudioContext was not allowed to start" ASYNCHRONOUSLY
    // (not a thrown error, so try/catch can't swallow it). On an unattended run this fired
    // hundreds of times. Bail cleanly when there's been no gesture — no sound is possible anyway.
    if (ctx.state === 'suspended') { try { ctx.close(); } catch {} return; }
    for (let k = 0; k < 2; k++) {
      const t = ctx.currentTime + k * 0.42;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.start(t); o.stop(t + 0.3);
    }
  } catch {}
}

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
    // Escape aborts the run — but ONLY a real user keypress. autofill's fillCombobox
    // dispatches a SYNTHETIC Escape to dismiss a typeahead dropdown when none of its options
    // match what we typed (LinkedIn's "Location (city)" box does this constantly). That event
    // bubbles to window, so the engine was cancelling its OWN task mid-apply: 6 "stopped by
    // escape" skips in a single hour of the live run. isTrusted is false for anything
    // dispatched from script, so this keeps the user's real Escape working and ignores ours.
    window.__jat11_aa_esc = (e) => { if (e.isTrusted && e.key === 'Escape' && S.running) cancel('escape'); };
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

// ============================================================
// FORENSIC TRACE (VERBOSE) — additive, behavior-neutral.
// ============================================================
// VERBOSE turns the transcript into a COMPLETE, firsthand trace of every
// executor decision (page state, field scans + fill outcomes, button choice +
// why others were rejected, advance results, AI ladder, resume page, hydration,
// screening/park, submit/success-truth, terminal). Default ON for forensic
// debugging; flip to false to silence the verbose stream (the existing concise
// logLine/report breadcrumbs stay on regardless — this only ADDS detail).
//
// vlog() is a thin wrapper over logLine: it no-ops when VERBOSE is off, never
// throws (a logging bug must never break an apply), and tags every line with a
// `trace:` prefix + a category so the lines are filterable in the transcript.
// Each emitted string is hard-capped (logLine already slices to 300; we also cap
// per-field at ~200 here) and NEVER carries raw DOM/innerText — only short,
// redacted, structured descriptions.
const VERBOSE = true;
const TRACE_MAX = 200;   // hard cap per verbose log string (transcript-bloat guard)
function vlog(category, text) {
  if (!VERBOSE) return;
  try { logLine('info', `trace:${category} ${String(text).slice(0, TRACE_MAX)}`); } catch {}
}

// Sensitive-value redaction for the trace (redactValue / redactLabel) is imported
// from ./lib/redact.js — pure, DOM-free, and unit-tested directly. Passwords / SIN
// / full SSN / card numbers are dropped ("[redacted]"); emails/phones are masked to
// the last 4; everything is truncated short so the transcript never bloats or leaks.
// pagePathOf() — the URL path (no query/hash) for compact page-state lines; the
// full href is already carried by reportSeen, so the trace keeps it short.
function pagePathOf() {
  try { return (location.pathname || '/') + (location.search ? '?…' : ''); } catch { return '?'; }
}
// Has the job page actually RENDERED its body yet? Gates the terminal "this posting has no
// Easy Apply" decision, which is non-retriable and so must never be taken on a page that
// simply had not finished loading. Measured live 2026-07-20: LinkedIn's rebuilt job view can
// still be blank at 7s on a VISIBLE, focused tab (chrome + the Premium upsell render early;
// the job body arrives much later), and its Easy Apply modal then opens normally.
// Non-LinkedIn hosts are unaffected (returns true) so no other route changes behaviour.
const JOB_BODY_RX = /\b(about the job|job description|À propos du poste|description du poste|responsibilities|qualifications)\b/i;
function jobPageHydrated() {
  try {
    if (!/(^|\.)linkedin\.com$/i.test(location.hostname)) return true;
    const t = document.body?.innerText || '';
    // Heading-only on purpose. A text-LENGTH fallback was tried and is unusable: the executor
    // injects its own status overlay, so a job page with an EMPTY body still measured 2,862
    // chars in the harness and read as "hydrated". If some locale's heading is missing from the
    // regex we fall to "not hydrated" → a bounded retry, which is the safe direction: retrying
    // costs seconds, a wrong terminal skip discards a real job forever.
    return JOB_BODY_RX.test(t);
  } catch { return true; }   // never let a probe error cause an infinite retry
}

function reportSeen(root, phase) {
  try {
    const scope = root || document;
    // LAG FIX (#2.3): reportSeen ran two full querySelectorAll sweeps + an innerText read on
    // EVERY step. The transcript "seen" breadcrumb only needs to refresh when the surface
    // actually changes. Gate the expensive sweeps behind a CHEAP pre-signal (phase + URL +
    // interactive-element count + dialog presence); if it hasn't moved since the last
    // reportSeen, bail before doing any sweep. This keeps the breadcrumbs on phase/form changes
    // while eliminating per-step full-document scans.
    const cheapSig = `${phase}|${location.href}|${scope.querySelectorAll ? scope.querySelectorAll('input,select,textarea,button,[role="button"]').length : 0}|${!!document.querySelector(APPLY_DIALOG_SEL)}`;
    if (S.lastSeenCheapSig === cheapSig) return;
    S.lastSeenCheapSig = cheapSig;
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
// Interrupting a run is NOT a decision about the job. Stopping the overlay, pressing Escape to
// take the tab back, or ending a teach session all mean "not now" — the posting is untouched and
// should go back in the queue. Only an explicit user choice NOT to apply ('recovery-skip', the
// skip button on the recovery prompt) or a declined final submit ('submit-not-approved') is a
// real verdict on the job, and only those stay terminal.
//
// Live 2026-07-20: 123 jobs sat permanently skipped as "stopped by …" — 88 from a pause and 35
// from Escape (the newest that same day) — none of them ever attempted. Same pattern as the
// bot-challenge breaker and the anchor-opener skip: a TRANSIENT interruption written as a
// PERMANENT state.
const TRANSIENT_CANCEL = new Set(['user', 'escape', 'teach-stop', 'pause']);
function cancel(reason) {
  if (!S.running) return;
  S.cancelled = true;
  setStatus(`Stopped (${reason})`);
  if (TRANSIENT_CANCEL.has(reason)) {
    // Back to 'queued', not 'skipped' — the run stops, the job survives.
    report({
      state: 'queued',
      lastError: null,
      transcriptAppend: { kind: 'recovery', note: `run interrupted (${reason}) — returned to the queue, not skipped` },
    });
    return;
  }
  report({ state: 'skipped', lastError: `stopped by ${reason}`, transcriptAppend: { note: `stopped by ${reason}` } });
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
// 'skipped' is included so a skip that omits an explicit applyRoute still gets a route stamped
// (→ 'unknown' rather than NULL) and never lands as the server's synthesized "skipped without a
// diagnostic". An explicit applyRoute on the patch (e.g. the relevance gate's 'relevance', or the
// external fast-skip's 'external') always wins via the `patch.applyRoute === undefined` guard.
const ROUTE_STATES = new Set(['done', 'awaiting_review', 'awaiting_input', 'parked', 'failed', 'skipped']);

// ============================================================
// Helpers
// ============================================================
function domHash() {
  // LAG FIX (#2.2): the old hash read document.body.innerText.length, which forces a full
  // layout + text serialization of the WHOLE DOM every poll (~every 250ms). On heavy SPAs
  // (LinkedIn) that was a measurable per-tick cost. A cheap, equally-discriminating signal:
  // URL + interactive-element count + whether the apply dialog is present. waitForChange only
  // needs to detect that the page MOVED (navigation, new fields, modal open/close) — all three
  // of those flip this signal — without walking/serializing text nodes.
  return `${location.href}|${document.querySelectorAll('input,select,textarea,button').length}|${!!document.querySelector(APPLY_DIALOG_SEL)}`;
}

async function untilUnpaused() {
  while (S.paused && !S.cancelled) await sleep(200);
}

async function waitForChange(initialHash, timeoutMs = STEP_TIMEOUT) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (S.cancelled) return false;
    if (domHash() !== initialHash) return true;
    await sleep(250);   // LAG FIX (#2.2): 180→250ms; the hash is now cheap, poll a touch less often
  }
  return false;
}

// A REAL, rendered, interactive captcha challenge widget — NOT the invisible-recaptcha privacy
// BADGE ("protected by reCAPTCHA") or a 0×0 invisible/score-based widget that sites (Indeed,
// countless ATSs) embed for BACKGROUND form protection. Shared by both captcha detectors so
// neither false-positives on the badge and aborts a normal application.
function hasRealCaptchaWidget() {
  try {
    return Array.from(document.querySelectorAll(
      'iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], '
      + 'iframe[title*="recaptcha" i], iframe[title*="hcaptcha" i], '
      + '.g-recaptcha, #g-recaptcha, .h-captcha, [data-hcaptcha-widget-id], '
      + 'iframe[src*="challenges.cloudflare.com/turnstile" i], '
      + 'iframe[src*="arkoselabs" i], iframe[src*="funcaptcha" i]'
    )).some((el) => {
      if (el.closest && el.closest('.grecaptcha-badge')) return false;          // the privacy badge
      if (el.matches && el.matches('[data-size="invisible" i]')) return false;  // invisible/score-based
      try { const r = el.getBoundingClientRect(); return r.width >= 60 && r.height >= 30; } catch { return false; }
    });
  } catch { return false; }
}

function captchaOrLoginPresent() {
  const text = (document.body?.innerText || '').slice(0, 6000);
  if (CAPTCHA_RX.test(text)) return 'captcha';
  if (hasRealCaptchaWidget()) return 'captcha';
  const pw = qsa('input[type="password"]').filter(isProbablyVisible);
  if (pw.length && /log\s*in|sign\s*in|se connecter/i.test(text.slice(0, 2500))) return 'login';
  return null;
}

// HUMAN-ASSIST for a CAPTCHA. We NEVER auto-solve or bypass a CAPTCHA (hard line) — instead the
// caller brings the apply window to the front so the USER can solve it, and this polls for the
// challenge to clear. Returns true if it's gone (the user solved it) within the window, else false
// (the caller then parks awaiting_input as before). Bounded so an unattended run doesn't hang.
async function waitForCaptchaCleared(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(2000);
    if (S.cancelled) return false;
    try { if (captchaOrLoginPresent() !== 'captcha' && !detectBotChallengeOnPage().blocked) return true; } catch { return true; }
  }
  return false;
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
    // PRESENCE-ONLY probe (never clicked) for a REAL interactive challenge widget — a rendered
    // reCAPTCHA/hCaptcha/Turnstile/Arkose iframe or checkbox. Its ABSENCE on a Cloudflare gate is
    // what marks the interstitial self-clearing (safe to wait out). A bare .cf-turnstile CONTAINER
    // without its iframe is the managed/JS challenge → NOT counted as interactive here.
    // A REAL rendered challenge widget (shared probe; excludes the privacy badge + invisible/0×0).
    const hasInteractiveWidget = hasRealCaptchaWidget();
    return detectBotChallenge({
      url: location.href,
      title: document.title,
      bodyText,
      hasRayId,
      hasInteractiveWidget,
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
  // Strip Indeed smartapply's hydration prefix ("Loading...Continue") at THIS single choke point
  // so every downstream label matcher — isAdvanceLabel, ADVANCE_KEYWORDS (findApplyDialog),
  // FINAL_SUBMIT_RX (isFinalSubmit), isLinkedInApplyAdvanceLabel — sees the REAL label. Only a
  // LEADING loading token is removed; no LinkedIn label carries one, so LinkedIn passes through unchanged.
  return stripLoadingPrefix(compactText(el?.getAttribute?.('aria-label') || el?.textContent || el?.value || ''));
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
  // OPEN-BRANCH ONLY: a plain <a href> "Apply for this job" CTA (Lever a.postings-btn and many
  // ATS job-description pages) is NOT in the set above, so it was unreachable and the external
  // child stalled at "no generic advance found". Reach it ONLY in the open branch (allowOpen) —
  // the caller's shouldUseGenericOpenFallback already excludes LinkedIn job-view — and only for a
  // visible apply-INTENT anchor with a real navigable href. The generic counterpart to the
  // per-ATS openApply() adapters; a wrong click is bounded by the no-progress cap + breaker.
  if (allowOpen) {
    for (const a of qsa('a[href]', root || document)) {
      if (!a || !isProbablyVisible(a)) continue;
      const href = a.getAttribute('href') || '';
      if (!href || href === '#' || /^javascript:/i.test(href)) continue;
      if (looksLikeAdvance(a, { allowOpen: true })) return a;
    }
  }
  return null;
}

// A PRESENT advance/submit control that is currently DISABLED — Indeed smartapply's Continue while
// its React module hydrates ("Loading...Continue", disabled until ready). Same label test as
// looksLikeAdvance but WITHOUT the disabled gate, and it must be genuinely on-screen. DETECTION
// ONLY — the caller NEVER clicks the returned element; it waits for it to ENABLE, at which point the
// normal findBtn() picks it up. Excludes the page-level Easy-Apply opener so a disabled opener can
// never be mistaken for an in-form advance.
function findLoadingAdvanceButton(root) {
  for (const el of qsa('button, input[type="submit"], [role="button"]', root || document)) {
    if (!el || !isProbablyVisible(el)) continue;
    if (isEasyApplyOpener(el)) continue;
    const disabled = el.disabled || el.getAttribute?.('aria-disabled') === 'true';
    if (!disabled) continue;
    const label = btnText(el);
    if (isAdvanceLabel(label) || isLinkedInApplyAdvanceLabel(label)) return el;
  }
  return null;
}

// A company career page that EMBEDS its ATS application in a cross-origin iframe
// (pinterestcareers.com and app.careerpuck.com both embed job-boards.greenhouse.io).
// The top frame can never see or drive that form, so the apply looked like a dead
// opener. Returns { src, host } for the first visible frame on a known ATS host.
// Deliberately narrow: only real ATS hosts, only reasonably-sized visible frames, so a
// tracking pixel or a marketing widget can never redirect the tab.
const EMBEDDED_ATS_HOST_RX = /(^|\.)(job-boards\.greenhouse\.io|boards\.greenhouse\.io|greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com|ashbyhq\.com|apply\.workable\.com|smartrecruiters\.com|myworkdayjobs\.com|icims\.com|bamboohr\.com)$/i;
function findEmbeddedAtsFrame() {
  try {
    for (const f of qsa('iframe')) {
      const src = String(f.getAttribute('src') || f.src || '');
      if (!/^https?:\/\//i.test(src)) continue;
      let u; try { u = new URL(src); } catch { continue; }
      if (!EMBEDDED_ATS_HOST_RX.test(u.hostname)) continue;
      if (u.hostname === location.hostname) continue;          // already top-level here
      const r = f.getBoundingClientRect?.() || { width: 0, height: 0 };
      if (r.width < 200 || r.height < 120) continue;           // not a real application surface
      return { src, host: u.hostname };
    }
  } catch {}
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

// ---- NEW FULL-PAGE Easy Apply recognition (KEYSTONE) ----
// LinkedIn migrated Easy Apply from a pop-up modal to a FULL-PAGE flow on the
// /jobs/view/<id>/apply/ route: NO `<form>`, NO `[role=dialog]`, obfuscated class names, a
// "N/M pages" indicator and a Next/Review/Submit button. findApplyDialog() (old-modal
// selectors only) misses it entirely, so we recognise it structurally here. LIVE-VALIDATED:
// from the visible advance button (Next/Review/Submit/Continue), walk UP to the first ancestor
// that bears >=1 visible field and does NOT swallow the global nav/search — that ancestor is
// the apply form root. Returns the root element or null. The /apply/ URL is a fast guard so
// this never fires on the plain job page (where the old-modal path / opener still win), but we
// do NOT require it absolutely: a field-bearing advance root is itself sufficient evidence.
const APPLY_FIELD_SEL = 'input:not([type="hidden"]), select, textarea, [role="combobox"], [contenteditable="true"]';
const APPLY_NAV_SEL = 'header, nav, [role="banner"], [role="navigation"], [class*="global-nav"], [id*="global-nav"], .search-global-typeahead, [data-test-global-nav]';
function findLinkedInApplyAdvanceButton() {
  for (const el of qsa('button, input[type="submit"], [role="button"]')) {
    if (!el || el.disabled || !isProbablyVisible(el)) continue;
    if (isEasyApplyOpener(el)) continue;   // never the page-level opener
    if (isLinkedInApplyAdvanceLabel(btnText(el))) return el;
  }
  return null;
}
// RADIO-AWARE field count: visible fields PLUS each hidden-radio/checkbox GROUP counted by its
// VISIBLE affordance (the styled label/option), not the 0×0 native input. This is what lets a
// radios-ONLY apply step (LinkedIn "Additional Questions"; Indeed smartapply screening like "Are you
// legally eligible to work…" / "ok with 3 days/week in office") be recognized as a form instead of
// grounding root=none and getting "Continue" clicked past the unanswered required radios.
function countApplyFieldsRadioAware(el) {
  try {
    const n = qsa(APPLY_FIELD_SEL, el).filter(isProbablyVisible).length;
    const groups = new Set();
    for (const r of qsa('input[type="radio"], input[type="checkbox"]', el)) {
      const aff = r.closest('fieldset, [role="radiogroup"], [role="group"], [data-test-form-builder-radio-button-form-component], [class*="selectable-option"], label') || r;
      if (isProbablyVisible(aff)) groups.add(r.name || aff);
    }
    return n + groups.size;
  } catch { return 0; }
}
// Structurally ground a full-page apply step: walk UP from the visible advance button to the first
// field-bearing, nav-free ancestor. Host-neutral (LinkedIn full-page + Indeed smartapply share the
// pattern: no modal, obfuscated classes, hidden radios, a Next/Continue/Review/Submit button).
function deriveRadioAwareApplyRoot(btn) {
  if (!btn) return null;
  return deriveApplyRootFromAdvanceButton(btn, {
    parentOf: (el) => el.parentElement,
    countFields: countApplyFieldsRadioAware,
    hasNav: (el) => { try { return !!el.querySelector?.(APPLY_NAV_SEL); } catch { return false; } },
  });
}
function findLinkedInApplyPageRoot() {
  if (!/(^|\.)linkedin\.com$/i.test(location.hostname)) return null;
  // Only the /apply/ route is the full-page flow; the plain job page is the opener's domain.
  if (!isLinkedInEasyApplyApplyUrl(location.pathname)) return null;
  return deriveRadioAwareApplyRoot(findLinkedInApplyAdvanceButton());
}
// Indeed smartapply analog: its questions steps render Yes/No screening radios the same hidden way,
// and there's no LinkedIn /apply/ guard — so a radios-only smartapply step grounded root=none and the
// executor clicked "Continue" past the unanswered radios (live: "Choose an option to continue"). This
// grounds it radio-aware so the radios are scanned + answered before advancing.
function findSmartApplyPageRoot() {
  if (!/(^|\.)smartapply\.indeed\.com$/i.test(location.hostname)) return null;
  return deriveRadioAwareApplyRoot(findLinkedInApplyAdvanceButton());
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
  // Plain <a> is in the scan on purpose. Measured live 2026-07-20 on the rebuilt LinkedIn job view
  // (e.g. jobs/view/4420497662, Paymentus): the Easy Apply control renders as an ANCHOR with
  // obfuscated classes, NO role="button", NO aria-label and an href back to the job view itself —
  // so none of the specific selectors matched and `a[role="button"]` did not either. The old scan
  // found 0 candidates on that page; adding `a` finds exactly 1, and clicking it opens the real
  // Easy Apply modal. Every such posting was being terminal-skipped as "external, apply on the
  // company site" (68 of 87 LinkedIn attempts in a 100-minute sample), which ALSO hid LinkedIn's
  // daily-cap modal from the executor, so the easyapply-limit backoff never armed either.
  // Safe to widen because selection is LABEL-driven, not tag-driven: classifyApplyControl matches
  // EASY_RX on the label before any href/off-origin test, and already excludes search-filter pills
  // (FILTER_LABEL_RX / FILTER_BAR_SEL), so an external "Apply on company website" anchor still
  // classifies external and a "Easy Apply filter" pill still classifies unknown.
  const candidates = [...qsa(sel), ...qsa('button, a, a[role="button"], [role="button"]')];
  const matches = [];
  for (const el of [...new Set(candidates)]) {
    if (!el || el.disabled || !isProbablyVisible(el)) continue;
    if (classifyApplyControl(el).state === 'linkedin_easy_apply_modal') matches.push(el);
  }
  if (!matches.length) return null;
  // FIX (2026-07-27, laptop node): labelOf() reads textContent, so TWO false positives classify as
  // Easy-Apply openers even though clicking them NEVER opens the modal (it navigates to the card's
  // job / does nothing → haveForm stays false → the task times out — THE dominant LinkedIn failure):
  //   (a) a job-LIST CARD: an <a> showing an "Easy Apply" BADGE inside a long
  //       title+company+location+salary blob (measured live: labelLen ~155, 5 such cards on the page); and
  //   (b) a top-card CONTAINER wrapping the real (obfuscated <a>) button.
  // A genuine opener is the button ITSELF: an "Easy Apply" aria-label, one of LinkedIn's apply-button
  // selectors, or a control whose OWN visible text is short (just "Easy Apply", not a card blob).
  const EA_ARIA = /\beasy apply\b|candidature simplifi/i;
  const ariaEA = (el) => { try { return EA_ARIA.test(el.getAttribute('aria-label') || ''); } catch { return false; } };
  const isSel = (el) => { try { return !!(el.matches && el.matches(sel)); } catch { return false; } };
  const shortLabel = (el) => { try { return ((el.textContent || '').replace(/\s+/g, ' ').trim().length <= 40); } catch { return true; } };
  let real = matches.filter((el) => ariaEA(el) || isSel(el) || shortLabel(el));
  // If a surviving opener still WRAPS another, keep the innermost actual control.
  if (real.length > 1) real = real.filter((el) => !real.some((o) => o !== el && el.contains && el.contains(o)));
  // No real opener yet — a search-LIST view (only card badges), or the detail-pane button hasn't
  // rendered. Return null so the caller WAITS / retries (transient) instead of clicking a card blob
  // and stalling forever.
  if (!real.length) {
    // All matches were false positives (job-list card badges / a wrapping container), or the real
    // detail-pane button hasn't rendered yet. Return null so the caller waits/retries the transient
    // page instead of clicking a card blob and stalling.
    try { vlog('button', `easy-apply opener: ${matches.length} candidate(s) matched but none is a real button — waiting for the apply button`); } catch {}
    return null;
  }
  return real.find(ariaEA) || real.find(isSel) || real[0];
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

// ---- Fast-skip probes (CONFIRMED ROOT CAUSE): positive evidence a LinkedIn JOB-VIEW
// posting is EXTERNAL (no Easy Apply will ever open). Each is a tight, guarded boolean the
// pure `detectLinkedInExternalPosting` then weighs. Used to bail in ~0s instead of burning
// the ~20s hydration cap on a form that will never appear. ----

// A VISIBLE "Apply"-intent control that is an <a> whose href points OFF LinkedIn (the
// "Apply ↗" external link). This is the strongest single signal of an off-LinkedIn posting.
function linkedInOffsiteApplyAnchorPresent() {
  try {
    const here = location.hostname.replace(/^www\./, '').toLowerCase();
    for (const a of qsa('a[href]')) {
      if (!isProbablyVisible(a)) continue;
      const t = btnText(a).toLowerCase();
      if (!t || !/\bapply\b|postuler|candidature/.test(t)) continue;
      // The page-level Easy-Apply opener is sometimes an <a>; never count it as external.
      if (isEasyApplyOpener(a)) continue;
      const href = a.getAttribute('href') || '';
      if (!/^https?:\/\//i.test(href)) continue;   // in-page / relative apply → not offsite
      let host = '';
      try { host = new URL(href, location.href).hostname.replace(/^www\./, '').toLowerCase(); } catch {}
      if (host && host !== here && !/(^|\.)linkedin\.com$/i.test(host)) return true;
    }
  } catch {}
  return false;
}

// A VISIBLE Apply control whose LABEL is explicitly external ("Apply on company website",
// "Apply externally", FR equivalents) — independent of the href.
function externalApplyLabelPresent() {
  try {
    for (const el of qsa('a, button, [role="button"]')) {
      if (!isProbablyVisible(el)) continue;
      if (isEasyApplyOpener(el)) continue;
      if (EXTERNAL_APPLY_RX.test(btnText(el).toLowerCase())) return true;
    }
  } catch {}
  return false;
}

// LinkedIn's own "Responses managed off LinkedIn" marker on the posting.
function responsesManagedOffLinkedInPresent() {
  try { return MANAGED_OFF_LINKEDIN_RX.test((document.body?.innerText || '').slice(0, 12000)); }
  catch { return false; }
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

// ---- forensic trace helpers (read-only; never mutate the page) ----
// The LinkedIn full-page flow + many ATS show a "Step N of M" / "N/M" progress
// indicator. Best-effort scrape of the most explicit one for the page-state line.
// PURE-ish (DOM read only) + guarded → '' when absent. Capped short.
function pageProgressIndicator() {
  try {
    // 1) Accessible progress widgets carry the value in aria-* — prefer those.
    const pb = document.querySelector('[role="progressbar"][aria-valuenow], progress[value]');
    if (pb) {
      const now = pb.getAttribute?.('aria-valuenow') ?? pb.getAttribute?.('value');
      const max = pb.getAttribute?.('aria-valuemax') ?? pb.getAttribute?.('max');
      if (now != null) return max != null ? `${now}/${max}` : String(now);
    }
    // 2) Visible "Step N of M" / "N of M pages" / "N / M" copy.
    const txt = compactText(document.body?.innerText || '').slice(0, 4000);
    const m = txt.match(/\b(?:step\s*)?(\d{1,2})\s*(?:of|\/)\s*(\d{1,2})\b(?:\s*(?:pages?|steps?))?/i);
    if (m) return `${m[1]}/${m[2]}`;
  } catch {}
  return '';
}
// Short structural descriptor of which root matched (for the page-state line):
// modal dialog vs the new /apply/ full-page root vs a recognised-ATS packRoot vs
// a generic probed form vs none. PURE; no side effects.
function describeRoot({ dialog, applyPageRoot, packRoot, probedRoot, root }) {
  if (!root) return 'none';
  if (root === dialog) return 'modal-dialog';
  if (root === applyPageRoot) return 'apply-page-root(/apply/)';
  if (root === packRoot) return 'ats-pack-root';
  if (root === probedRoot) return 'probed-form';
  return 'form';
}
// fieldType label for the trace (text/select/radio/checkbox/file/combobox/textarea).
function traceFieldType(input) {
  try {
    if (!input) return 'field';
    const tag = (input.tagName || '').toLowerCase();
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textarea';
    const role = input.getAttribute?.('role');
    if (role === 'combobox') return 'combobox';
    if (input.closest?.('[class*="select__control"],[class*="react-select"],[class*="-control"],[class*="basic-typeahead"]')) return 'combobox';
    return input.type || tag || 'field';
  } catch { return 'field'; }
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
// DEFERRED-MOUNT UPLOAD WIDGETS. Modern job-boards.greenhouse.io renders "Attach / Dropbox /
// Google Drive" affordances and only mounts the real <input type="file"> once Attach is clicked.
// Until then there is NO file input in the DOM, so findResumeFileInputs finds nothing and the run
// parks with "requires a résumé but none could be attached" — 9 live applications on 2026-08-13.
//
// Clicking the affordance is safe in a way that guessing at an existing input is not: we only click
// something whose own text says attach/upload/résumé, we never touch a Dropbox/Drive/OneDrive
// picker (those open third-party OAuth flows), and if nothing mounts we return [] exactly as before.
// Word-bounded on purpose. Without \b this also matches "reattach", "download" and "added",
// and `.*` would span a whole sentence — and this regex decides which button we CLICK on a live
// page. Clicking the wrong one is worse than not clicking at all.
//
// NOTE FOR ANY SCRIPTED EDIT OF THIS LINE: writing "\\b" from a non-raw Python string
// produces a literal BACKSPACE byte (0x08), not a word boundary. That happened here on
// 2026-08-13 and silently killed the first two alternatives — the fixture still passed, via the
// bare ^attach$ branch, so it looked fine. Verify with `od -c` after any such edit.
const ATTACH_AFFORDANCE_RX = /\b(attach|upload|add)\b[^.]{0,24}(resume|résumé|cv|file|document)|(resume|résumé|cv)[^.]{0,24}\b(attach|upload)\b|^\s*(attach|upload|joindre|téléverser)\s*$/i;
const CLOUD_PICKER_RX = /dropbox|google drive|gdrive|onedrive|\bbox\b|sharepoint/i;

async function mountDeferredFileInput(root) {
  const scope = root && root !== document ? root : document;
  let candidates = [];
  try {
    candidates = qsa('button, [role="button"], a[role="button"], label', scope)
      .filter((el) => {
        const t = compactText(el.textContent || el.getAttribute?.('aria-label') || '');
        if (!t || t.length > 40) return false;
        if (CLOUD_PICKER_RX.test(t)) return false;      // never open a third-party picker
        return ATTACH_AFFORDANCE_RX.test(t);
      });
  } catch { return []; }
  if (!candidates.length) return [];

  for (const el of candidates.slice(0, 2)) {
    try {
      logLine('info', `no résumé input yet — clicking "${compactText(el.textContent).slice(0, 30)}" to mount one`);
      el.click();
      // React mounts on the next tick or two; poll briefly rather than guessing a single delay.
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 60));
        const found = findResumeFileInputs(root);
        if (found.length) return found;
      }
    } catch { /* try the next affordance */ }
  }
  return [];
}

async function tryAttachResume(root, resume) {
  if (!resume?.id) return { attempted: false, attached: 0 };
  let inputs = findResumeFileInputs(root);
  // Nothing to fill yet — the widget may simply not have mounted its input. Try to make it appear
  // before concluding this posting cannot take a résumé.
  if (!inputs.length) inputs = await mountDeferredFileInput(root);
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

// ---- RESUME PAGE (new full-page Easy Apply) ----
// Saved-resume SELECTION controls: LinkedIn renders previously-uploaded resumes as radio
// cards. Returns the visible, selectable elements (the clickable radio/card), plus whether
// any is already selected. Best-effort + guarded — an empty list means "no saved resumes".
function findSavedResumeControls(root) {
  const scope = root || document;
  let els = [];
  try {
    els = qsa('input[type="radio"], [role="radio"], [data-test-resume-card], .jobs-resume-picker__resume, [class*="resume-card" i]', scope)
      .filter((el) => el && isProbablyVisible(el));
  } catch { els = []; }
  const anySelected = els.some((el) => {
    try {
      if (el.checked) return true;
      const aria = el.getAttribute?.('aria-checked');
      if (aria === 'true') return true;
      const sel = el.getAttribute?.('aria-selected');
      if (sel === 'true') return true;
      if (el.closest?.('[aria-checked="true"], [aria-selected="true"], [class*="selected" i], [class*="--is-selected" i]')) return true;
    } catch {}
    return false;
  });
  return { els, anySelected };
}

// Is there an "Upload resume" / "Attach resume" affordance (a button/element) present? The new
// full-page flow has NO `<input type=file>` until this is clicked — clicking it CREATES the
// input. Returns the affordance element (to click) or null. Guarded.
function findUploadResumeAffordance(root) {
  const scope = root || document;
  try {
    for (const el of qsa('button, [role="button"], label, a[role="button"]', scope)) {
      if (!el || el.disabled || !isProbablyVisible(el)) continue;
      const t = compactText(el.getAttribute?.('aria-label') || el.textContent || el.value || '');
      if (t && isUploadResumeAffordanceLabel(t)) return el;
    }
  } catch {}
  return null;
}

// Does this step show a résumé REQUIREMENT ("A resume is required", "Resume*")? Scans the
// scope text (and any inline error). Guarded.
function resumeRequiredOnPage(root) {
  try {
    const scope = root || document;
    const txt = compactText(scope.innerText || scope.textContent || '').slice(0, 4000);
    return pageRequiresResume(txt);
  } catch { return false; }
}

// Poll up to ~2s for a resume file input to appear after clicking the "Upload resume"
// affordance (the input is created lazily by LinkedIn). Returns true once one is present.
async function waitForResumeFileInput(root, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs && !S.cancelled) {
    if (findResumeFileInputs(root).length) return true;
    await sleep(150);
  }
  return findResumeFileInputs(root).length > 0;
}

// Drive the RESUME step on the new full-page (or any) apply form. Builds DOM-free signals,
// asks the PURE decideResumePage() what to do, then ACTS:
//   • select  → click the first/most-recent saved-resume card (no upload needed)
//   • attach  → a file input is already present → run the existing attach path
//   • upload-then-attach → CLICK "Upload resume" to create the input, wait for it, then attach
//   • park    → a résumé is genuinely required but unattachable → honest park (caller stops)
//   • none    → nothing to do; proceed
// Returns { acted, attached, satisfied, park }:
//   acted     — true if we took any resume-page action (the caller should NOT also run the
//               legacy tryAttachResume()).
//   attached  — how many file inputs we filled (the SUCCESS-TRUTH grounding signal).
//   satisfied — true when the resume requirement is met WITHOUT an attach (a saved card was
//               selected, or one was already selected) — so the caller must NOT treat
//               attached===0 as an attach failure.
//   park      — a reason string when the run should PARK (resume required but unattachable).
async function handleResumePage(root, resume) {
  const { els: savedEls, anySelected } = findSavedResumeControls(root);
  const fileInputPresent = findResumeFileInputs(root).length > 0;
  const uploadAffordance = findUploadResumeAffordance(root);
  const resumeRequired = resumeRequiredOnPage(root);
  const haveResumeBytes = !!resume?.id;

  // Nothing resume-shaped on this page at all → let the normal attach path (run by the caller
  // for the old layout) own it; we have no opinion. This keeps handleResumePage cheap and
  // side-effect-free on non-resume steps.
  if (!savedEls.length && !uploadAffordance && !resumeRequired && !fileInputPresent) {
    return { acted: false, attached: 0, satisfied: false, park: null };
  }

  const decision = decideResumePage({
    savedResumeCount: savedEls.length,
    anySavedSelected: anySelected,
    fileInputPresent,
    uploadAffordancePresent: !!uploadAffordance,
    resumeRequired,
    haveResumeBytes,
  });
  // [TRACE 6] RESUME PAGE — the live signals + the pure decision the executor will act on.
  vlog('resume', `saved=${savedEls.length} selected=${anySelected} fileInput=${fileInputPresent} uploadBtn=${!!uploadAffordance} required=${resumeRequired} haveBytes=${haveResumeBytes} → action=${decision.action}${decision.reason ? ' (' + decision.reason + ')' : ''}`);

  if (decision.action === 'select') {
    const choice = savedEls[decision.index] || savedEls[0];
    if (choice) {
      logLine('ok', 'resume page: selecting your saved resume');
      syntheticClick(choice);
      try { if (choice.tagName === 'INPUT' && !choice.checked) { choice.checked = true; choice.dispatchEvent(new Event('input', { bubbles: true })); choice.dispatchEvent(new Event('change', { bubbles: true })); } } catch {}
      await sleep(250);
      return { acted: true, attached: 0, satisfied: true, park: null };
    }
    return { acted: false, attached: 0, satisfied: false, park: null };
  }

  if (decision.action === 'attach') {
    const att = await tryAttachResume(root, resume);
    vlog('resume', `attach-existing → attached=${att.attached} ${att.attached > 0 ? 'OK' : 'FAIL'}`);
    return { acted: true, attached: att.attached, satisfied: att.attached > 0, park: null };
  }

  if (decision.action === 'upload-then-attach') {
    if (uploadAffordance) {
      logLine('ok', 'resume page: clicking "Upload resume" to create the file input');
      syntheticClick(uploadAffordance);
      const appeared = await waitForResumeFileInput(root);
      vlog('resume', `clicked Upload-resume → file input ${appeared ? 'appeared' : 'did NOT appear'}`);
    }
    const att = await tryAttachResume(root, resume);
    vlog('resume', `upload-then-attach → attached=${att.attached} ${att.attached > 0 ? 'OK' : 'FAIL'}`);
    if (att.attached > 0) return { acted: true, attached: att.attached, satisfied: true, park: null };
    // Re-scan: if a resume requirement is still showing and we couldn't attach, park honestly.
    if (resumeRequiredOnPage(root) || resumeRequired) {
      return { acted: true, attached: 0, satisfied: false, park: 'resume required — add a résumé to your profile / LinkedIn (JAT could not upload one here)' };
    }
    return { acted: true, attached: 0, satisfied: false, park: null };
  }

  if (decision.action === 'park') {
    return { acted: true, attached: 0, satisfied: false, park: decision.reason };
  }

  // 'none' → already selected / no requirement → satisfied, nothing to do.
  return { acted: false, attached: 0, satisfied: decision.reason === 'saved-resume-already-selected', park: null };
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
  // Re-derivable per host: when an external "Apply (opens in new tab)" navigates IN-TAB to a
  // RECOGNISED company ATS, the live hostname changes from the one this run started on. The
  // packs are computed for the CURRENT host and re-derived in the loop if the host changes,
  // so the normal ATS-driving path can take over on the company site (Fix 3). `let` (not
  // `const`) for exactly that re-derivation; the initial value is unchanged.
  let atsPackHost = location.hostname;
  const derivePacks = (host) => {
    const onLI = /(^|\.)linkedin\.com$/i.test(host);
    const pack = (() => { try { return onLI ? null : sitePack(host); } catch { return null; } })();
    // Only drive a pack that declares the full account-less contract (formSelector +
    // account:'none'); a bare legacy hint pack (no `account`) falls through to today's
    // generic flow unchanged.
    return {
      atsPack: pack,
      driveablePack: pack && pack.account === 'none' && pack.formSelector ? pack : null,
      walledPack: pack && pack.account === 'required' ? pack : null,
    };
  };
  let { atsPack, driveablePack, walledPack } = derivePacks(location.hostname);
  showOverlay(`${mode === 'review' ? 'Filling for your review' : 'Applying'} — ${job?.title || ''}`);

  // A structured profile is OPTIONAL — we also fill from harvested/learned
  // answers (qa store) and the AI ladder. Build a data object that merges the
  // structured profile with any harvested fields that map to known profile keys
  // so the autofill engine has the most to work with even with no saved profile.
  const profileData = { ...(profile?.data || {}) };
  // FIX 1: derive whether the user is authorized to work, for GROUNDED eligibility-screening
  // defaults (authorized → "authorized to work?" = Yes, "require sponsorship?" = No) applied
  // ONLY when the profile/qa store didn't already answer the question. Truthful, never invented:
  // we only treat the user as authorized when the profile explicitly says so (a yes/authorized/
  // citizen/permanent-resident value), or there's an explicit work-auth region list. Unknown →
  // null (the grounded default then declines to guess and the question falls to AI/park).
  const authorizedToWork = (() => {
    try {
      const wa = String(profileData.workAuthorization || '').toLowerCase();
      const cit = String(profileData.citizenship || '').toLowerCase();
      const regions = profileData.workAuthRegions;
      const hasRegions = Array.isArray(regions) ? regions.length > 0 : !!String(regions || '').trim();
      const positive = /\b(yes|authori[sz]ed|eligible|citizen|permanent resident|pr\b|work permit|right to work|no sponsorship)\b/;
      const negative = /\b(no\b|not authori[sz]ed|require sponsorship|need sponsorship|require a visa)\b/;
      if (positive.test(wa) || positive.test(cit) || hasRegions) return true;
      if (negative.test(wa)) return false;
      return null;   // unknown → never guess an eligibility answer
    } catch { return null; }
  })();
  const learnedCount = Array.isArray(harvested) ? harvested.length : 0;
  logLine('ok', `start mode=${mode} · profile=${profile ? 'loaded' : 'none'} · learned=${learnedCount} · resume=${resume?.name || 'none'}`);
  reportSeen(document, 'job page');

  // ---- relevance gate: don't apply to roles above your level / excluded / that
  // demand far more experience than you set (re-checked against the live page). ----
  const fitReason = checkFit(job?.title || '', document.body?.innerText || '', context?.fit);
  if (fitReason) {
    logLine('warn', `skipping — ${fitReason}`);
    setStatus(`Skipped — ${fitReason}`);
    // Carry an honest route ('relevance') + the concrete reason on BOTH the report AND the return.
    // The report PATCH is fire-and-forget and can be dropped when the tab is torn down right after;
    // background.js then rebuilds the PATCH from this return object, so the return MUST echo
    // lastError+applyRoute or the server synthesizes "skipped without a diagnostic" + apply_route NULL.
    report({ state: 'skipped', lastError: fitReason, applyRoute: 'relevance', routeState: 'relevance_skip', transcriptAppend: { note: 'relevance skip: ' + fitReason } });
    S.running = false;
    hideOverlay(3500);
    return { ok: true, state: 'skipped', steps: 0, lastError: fitReason, applyRoute: 'relevance', routeState: 'relevance_skip' };
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
    // Never LEARN an answer under a junk key. When a control has no resolvable label,
    // fieldLabel() falls back to input.name / the element id, and that string was being saved
    // as the QUESTION: 143 of 2,576 live entries (6%) are keyed "rn" / "r1s" / "name" /
    // "city" / "easy apply". Because the server's qaLookup is FUZZY, those keys can later
    // match a real screening question and answer it with the wrong value on a real
    // application — so the store is worse than empty. Drop them at the source.
    recordAnswer: async (item) => {
      const q = String(item?.question || '');
      if (isJunkQuestionKey(q)) {
        vlog('qa', `not learning an answer under a junk key: "${redactLabel(q).slice(0, 40)}"`);
        return null;
      }
      return send({ type: 'qa-record', data: { ...item, source: job?.source, profileId } });
    },
  });

  let finished = false;
  let finalState = null;
  let everHadForm = false;     // has the apply form/modal ever appeared this run?
  let formGrounded = false;    // SUCCESS-TRUTH: a REAL apply form was opened+interacted-with
  let submitAttempted = false; // did we click a final submit (auto mode) at least once?
  let noChange = 0;            // consecutive advance clicks that didn't change the page (stall)
  let lastPageAction = '';     // blocks repeated clicks on the same page-level opener
  let lastPageActionUrl = '';  // the page URL at which lastPageAction was armed — when the live
                               // URL differs a REAL navigation happened (e.g. an external opener
                               // navigated in-tab to the company ATS), so the breaker must reset
                               // before the first click on the NEW page is judged a repeat.
  let openerStallFronted = false; // F2: did we already do a fronted retry for an opener that clicked but never mounted?
  let interstitialAdvances = 0; // LinkedIn resume/continue interstitials advanced this run (bounded)
  let blockedRescueTries = 0;   // FIX 1: advance-blocked → re-scan + answer required field(s) recoveries (bounded)
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
    send({ type: 'jat11.front-until-hydrated' });
  }
  function signalHydrated() {
    if (!frontRequested) return;   // never released a front we didn't request
    frontRequested = false;
    send({ type: 'jat11.apply-hydrated' });
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
  // FIX 1 — advance-blocked → re-scan → answer the unanswered REQUIRED field(s).
  // ============================================================
  // When an advance click (Next/Review/Submit) does NOT change the page, LinkedIn is almost
  // always blocking on an UNANSWERED REQUIRED field (a Yes/No screening radio, a dropdown, a
  // text field) — the dominant remaining cap on the success rate (Webisoft: a required
  // "comfortable commuting?" radio left blank → Review refused → "stuck"). Before the stall
  // guard gives up, we re-scan the CURRENT page root for unanswered required fields and ANSWER
  // them through the EXISTING ladder (profile/qa via scanFillable+fill → AI via
  // /ai/answer-question → grounded eligibility default for the well-known work-auth/sponsorship
  // Qs), then the caller retries the advance. Returns:
  //   { filled, parkedCount, sawRequired } — `filled` answered this pass, `parkedCount` honestly
  //   parked (unanswerable required), `sawRequired` whether any required field was even seen.
  // Reuses engine.scanFillable / engine.fill / engine.scanUnknown + the same AI route the main
  // loop uses; does NOT duplicate the ladder. Fully guarded — any throw → {filled:0,...}.
  async function answerBlockingRequiredFields(scopeRoot) {
    const out = { filled: 0, parkedCount: 0, sawRequired: false };
    const root = scopeRoot || findApplyDialog() || detectApplyForm()?.form || null;
    if (!root) return out;
    // 1) profile + learned-qa first: scanFillable matches profile patterns (incl. the
    //    work-authorization / sponsorship profile fields) and the qa store. This already
    //    handles radios (pickRadioInGroup) + selects (matchOption). Required-only? No —
    //    filling any empty profile-known field that's blocking is strictly safe and cheap.
    try {
      const sugg = (await engine.scanFillable(root)).filter((s) => !NEVER_AUTOFILL_RX.test(s.label || ''));
      const n = await engine.fill(sugg);
      if (n) { out.filled += n; logLine('ok', `recovered: filled ${n} field(s) from profile/history to unblock advance`); }
    } catch {}
    // 2) Re-scan for the REQUIRED fields still unanswered (radios/selects/text) and resolve
    //    each via AI → grounded eligibility default, parking honestly what we can't answer.
    let unknown = [];
    try { unknown = (await engine.scanUnknown(root)).filter((u) => u && u.required); } catch { unknown = []; }
    if (!unknown.length) return out;
    out.sawRequired = true;
    // Build the per-field answer-or-park inputs (PURE decision delegated to decideAnswerOrPark).
    const decided = [];
    for (const u of unknown.slice(0, 6)) {
      if (S.cancelled) break;
      // EEO / criminal-history fields are NEVER auto-answered — they must be parked for the user.
      if (NEVER_AUTOFILL_RX.test(u.label)) { decided.push({ ...u, answer: null, parkable: true, reason: 'sensitive — needs your answer' }); continue; }
      let answer = null;
      // a) AI ladder (skips legal/eligibility — those are grounded from profile below, never AI'd).
      if (!LEGAL_RX.test(u.label)) {
        try {
          const r = await send({
            type: 'api-call', method: 'POST', path: '/ai/answer-question', timeoutMs: 150000,
            body: { question: u.label, fieldType: u.fieldType, options: u.options, jobId: job?.id, profileId },
          });
          const a = (r?.ok && r.result && typeof r.result.answer === 'string' && typeof r.result.confidence === 'number') ? r.result : null;
          if (a && !a.refuse && a.confidence >= S.sessionSettings.confidence && a.answer.trim()) answer = a.answer;
        } catch {}
      }
      // b) GROUNDED eligibility default for the well-known work-auth/sponsorship screening Qs —
      //    truthful, derived from the profile (authorizedToWork), applied ONLY when AI didn't
      //    (and profile/qa in step 1 didn't) already answer. Matches Yes/No option text when
      //    the field offers options (so a select/radio with "Yes, I am" still resolves).
      if (answer == null && isEligibilityScreeningQuestion(u.label)) {
        const opts = Array.isArray(u.options) ? u.options : [];
        const yesText = opts.find((o) => /^\s*(yes|oui|s[ií]|ja)\b/i.test(o)) || 'Yes';
        const noText = opts.find((o) => /^\s*(no|non|nein)\b/i.test(o)) || 'No';
        answer = groundedEligibilityAnswer(u.label, { authorizedToWork, yesText, noText, options: opts });
        // [TRACE 8] grounded-eligibility default applied from the profile (never invented).
        if (answer != null) {
          vlog('screen', `grounded-eligibility "${redactLabel(u.label)}" = ${redactValue(answer, u.label)} (from profile, authorizedToWork=${authorizedToWork})`);
          logLine('ok', `recovered: grounded eligibility answer for "${u.label.slice(0, 40)}" → ${answer}`);
        }
      }
      // Parkable: a real question (has label) we couldn't answer → hand to the user.
      decided.push({ ...u, answer, parkable: !!u.label, reason: answer == null ? `needs your answer: ${u.label.slice(0, 80)}` : null });
    }
    const plan = decideAnswerOrPark(decided);
    for (const f of plan.toAnswer) {
      if (S.cancelled) break;
      try {
        const ok = await engine.fill([{ input: f.input, value: f.answer }]);
        if (ok) {
          out.filled++;
          logLine('ok', `recovered: answered required "${f.label.slice(0, 40)}"`);
          try { await engine.recordAnswer({ question: f.label, answer: f.answer, fieldType: f.fieldType, source: isEligibilityScreeningQuestion(f.label) ? 'profile' : 'ai', jobId: job?.id }); } catch {}
        } else {
          // Fill failed (un-pickable widget) → park it rather than lose the blocker silently.
          park(f.label, f.fieldType, f.options, 'blocked the application — could not fill the answer');
          out.parkedCount++;
        }
      } catch {}
    }
    for (const f of plan.toPark) { park(f.label, f.fieldType, f.options, f.reason); out.parkedCount++; }
    return out;
  }

  // ============================================================
  // AI RESCUE — last-resort AI guidance when the deterministic logic is STUCK.
  // ============================================================
  // When the normal ladder (profile → qa → /ai/answer-question → grounded defaults) AND the
  // deterministic advance have BOTH failed (no advance control, page won't move, a required field
  // the scanner couldn't see/answer), we hand the WHOLE page to the configured AI provider
  // (Claude/OpenAI subscription via the official CLI, API key, or local) and apply the structured
  // actions it returns through the EXISTING safe fill/click primitives. Profile + learned memory are
  // injected server-side (/ai/apply-rescue). HARD SAFETY: never AI-blind-submits — a final-submit
  // is refused here and left to the R1 success-truth path; sensitive/legal fields are parked, not
  // guessed. Bounded per task so a confused page can't loop or rack up cost.
  let aiRescueCount = 0;
  const MAX_AI_RESCUE = 2;
  // When the AI parks without naming a target, its reason still identifies the field it refused
  // to answer — pull the quoted label out so the needs-you queue shows the QUESTION rather than
  // the internal stage name. Returns '' when the reason has no quoted field, so the caller keeps
  // its existing fallback. Straight/curly quotes both, because model output uses either.
  // The model delimits the field it refused with whatever quoting it feels like. Measured on the
  // 41 live post-fix "AI rescue" parks: straight/curly quotes recovered only 4 (10%) because the
  // model overwhelmingly writes BACKTICKS — "Required field `phone country code*` cannot be
  // answered truthfully". Adding ` as a delimiter takes it to 11 (27%). The other 73% name no
  // delimited field at all ("the required years fields for Java, Spring Boot and Angular are not
  // grounded"), which no regex will ever recover — those are handled structurally at the park
  // site from fieldRefs, which holds the page's REAL fields.
  // ── NATIVE-VALIDATION GATE ─────────────────────────────────────────────────────────────────
  // If the browser itself is going to refuse this submit, clicking it tells us nothing and
  // produces a phantom "submit was clicked but could not be verified — please confirm".
  //
  // Greenhouse, observed live on job-boards.greenhouse.io 2026-07-26: required screening
  // questions render as react-select comboboxes whose native-validation participation comes from
  // a sentinel input:
  //     <input required tabindex="-1" aria-hidden="true" class="…-requiredInput" value="">
  // scanFillable correctly skips it (aria-hidden, tabindex -1) and never registers the visible
  // combobox, so the run concludes `unknown=0 toResolve=0`, clicks a type=submit button, and the
  // browser silently blocks the submit — no DOM mutation, no error node, no URL change. That is
  // exactly the observed `changed=false newNodes=0 elapsed=24s`, identical across Dialpad,
  // Robinhood and 8 others: all 10 Greenhouse "no-post-click-change" tasks.
  //
  // Precision matters here: native validation runs ONLY for a submit button inside a form that
  // has not opted out. Requiring btn.type==='submit' and !form.noValidate means this can only
  // fire where the browser would have refused anyway, so it cannot suppress a site that submits
  // through its own JS handler.
  function nativeValidationBlockers(btn) {
    try {
      if (!btn || btn.type !== 'submit') return [];
      const form = btn.form || btn.closest?.('form');
      if (!form || form.noValidate || typeof form.checkValidity !== 'function') return [];
      if (form.checkValidity()) return [];
      const out = [];
      for (const el of Array.from(form.elements || [])) {
        if (out.length >= 6) break;
        try {
          if (!el.willValidate || el.checkValidity()) continue;
          // The sentinel is aria-hidden and unlabelled, so fieldLabel has no real source to work
          // from and returns the surrounding widget chrome instead. For that shape go straight to
          // the ancestor question block; only fall back to fieldLabel for normally-labelled fields.
          const unlabelled = el.getAttribute('aria-hidden') === 'true' || (!el.id && !el.name);
          const label = (unlabelled ? nearestQuestionText(el) : '')
            || (fieldLabel(el) || '').trim() || nearestQuestionText(el) || el.name || el.id || 'a required field';
          out.push({ label: String(label).slice(0, 200), message: String(el.validationMessage || '').slice(0, 120) });
        } catch { /* skip this element */ }
      }
      return out;
    } catch { return []; }
  }

  function fieldFromParkReason(reason) {
    const m = String(reason || '').match(/[`'"‘’“”]([^`'"‘’“”]{3,160})[`'"‘’“”]/);
    return m ? m[1].trim() : '';
  }
  // EXT-4 token moderation: the rescue already fires ONLY from the hard-stall path
  // (noChange >= stallLimit), so the deterministic ladder always runs first and most
  // applies spend ZERO rescue tokens. The remaining leak is calling the model AGAIN on a
  // page that hasn't changed since the last call (a genuinely stuck screen stalls twice).
  // Dedup on the page signature within a 60s window so the 2nd identical call is skipped.
  // 250 covers a full country/phone-code select (~250) whole; radio groups are small but 12 could
  // clip a work-status list, so give them headroom too.
  const OPTION_CAP_SELECT = 250;
  const OPTION_CAP_RADIO = 24;
  let lastRescueSig = '';
  let lastRescueAt = 0;
  async function tryAiRescue(reason) {
    if (aiRescueCount >= MAX_AI_RESCUE || S.cancelled) return false;
    const root = findApplyDialog() || (typeof findLinkedInApplyPageRoot === 'function' ? findLinkedInApplyPageRoot() : null) || detectApplyForm()?.form || document.body;
    if (!root) return false;
    // Gather the RAW field list (incl. fields the deterministic scanner may have skipped), deduped.
    const seen = new Set();
    const fieldRefs = [];
    for (const el of qsa('input, select, textarea', root)) {
      try {
        if (!isFillable(el) || isSiteChromeInput(el)) continue;
        const isRadio = el.type === 'radio';
        const key = isRadio ? `radio:${el.name || el.id || ''}` : (el.id || el.name || `f${fieldRefs.length}`);
        if (seen.has(key)) continue;
        seen.add(key);
        // Radios use ONLY the recovered group prompt (never the "yes yes q_<id>" fieldLabel
        // fallback); selects use the prompt-recovering resolver; everything else fieldLabel.
        const label = isRadio
          ? radioGroupLabel(el)
          : (el.tagName === 'SELECT' ? selectGroupLabel(el) : fieldLabel(el)) || el.getAttribute('aria-label') || el.name || '';
        if (!label) continue;
        // Truncating the option list makes the AI refuse fields it could answer. The 20-option cap
        // silently cut every long select: a phone country-code list is ~250 entries and "Canada"
        // sits ~38th alphabetically, so the model was shown 20 options, correctly observed that
        // Canada was not among them, and parked — "`Canada (+1)` is not among the options". That
        // false premise blocked 7 otherwise-complete applications in the last week. Cap high enough
        // that real-world lists fit whole, and when a list STILL overflows say so rather than
        // letting a partial list read as complete.
        let options = null;
        let optionsTotal = 0;
        if (el.tagName === 'SELECT') {
          const all = Array.from(el.options).map((o) => (o.textContent || '').trim()).filter(Boolean);
          optionsTotal = all.length; options = all.slice(0, OPTION_CAP_SELECT);
        } else if (isRadio && el.name) {
          const all = qsa('input[type="radio"]', root).filter((r) => r.name === el.name).map((r) => fieldLabel(r)).filter(Boolean);
          optionsTotal = all.length; options = all.slice(0, OPTION_CAP_RADIO);
        }
        // A checkbox/radio's .value is its option value ("on"), NOT whether it's answered — report
        // CHECKED state so the AI sees an unchecked-required control as still needing action.
        const reportedValue = (el.type === 'checkbox' || el.type === 'radio')
          ? (el.checked ? 'checked' : (isRadio ? (qsa('input[type="radio"]', root).some((r) => r.name === el.name && r.checked) ? 'checked' : '') : ''))
          : String(el.value || '').slice(0, 40);
        // Required also inferred from the prompt container/text (smartapply's loose radios carry no
        // input.required) so the rescue treats them as blocking, same as scanUnknown.
        const required = !!(el.required || el.getAttribute('aria-required') === 'true'
          || el.closest?.('[aria-required="true"], [class*="required" i], [data-required]')
          || /[*]|\brequired\b|\brequis\b|\bobligatoire\b/i.test(label));
        fieldRefs.push({ el, label: String(label).slice(0, 160), type: el.type || el.tagName.toLowerCase(), required, value: reportedValue, options, optionsTotal });
      } catch {}
    }
    const btnRefs = qsa('button, [role="button"], input[type="submit"], a[role="button"]', root)
      .map((el) => ({ el, label: btnText(el) })).filter((b) => b.label).slice(0, 25);
    // pageText kept small (≈900 chars) — the structured field/button list carries the
    // actionable state; pageText is only orienting context, so it doesn't need the full DOM.
    const pageText = String(root.innerText || '').replace(/\s+/g, ' ').slice(0, 900);

    // EXT-4 dedup: a stable signature of the actionable surface (url + unanswered required
    // fields + button labels). If it matches the last rescue within 60s, the page genuinely
    // hasn't moved since we already asked — skip the duplicate call (the per-task cap would
    // otherwise let a stuck screen burn the 2nd attempt on an identical prompt).
    const rescueSig = [
      location.href,
      fieldRefs.filter((f) => f.required && !f.value).map((f) => f.label).join('|'),
      btnRefs.map((b) => b.label).join('|'),
    ].join('§');
    if (rescueSig === lastRescueSig && (Date.now() - lastRescueAt) < 60000) {
      vlog('rescue', `skipped — same page signature within 60s (no change since last rescue)`);
      return false;
    }
    lastRescueSig = rescueSig; lastRescueAt = Date.now();

    aiRescueCount++;
    vlog('rescue', `asking AI [${reason}] — ${fieldRefs.length} field(s), ${btnRefs.length} button(s)`);
    let resp = null;
    try {
      resp = await send({
        type: 'api-call', method: 'POST', path: '/ai/apply-rescue', timeoutMs: 150000,
        body: {
          pageState: {
            url: location.href, routeState: S.routeState, failureReason: reason,
            // optionsTruncated tells the model a partial list is partial, so "X is not among the
            // options" is never inferred from a list we cut ourselves.
            fields: fieldRefs.map((f) => ({
              label: f.label, type: f.type, required: f.required, value: f.value, options: f.options,
              ...(f.optionsTotal > (f.options?.length || 0) ? { optionsTruncated: true, optionsTotal: f.optionsTotal } : {}),
            })),
            buttons: btnRefs.map((b) => b.label), pageText,
          },
          jobId: job?.id, profileId,
        },
      });
    } catch (e) { vlog('rescue', `call failed: ${String(e?.message || e).slice(0, 80)}`); return false; }

    const result = (resp && resp.ok) ? resp.result : null;
    if (!result || !Array.isArray(result.actions) || !result.actions.length) {
      vlog('rescue', `no actions (${resp?.aiUnavailable ? 'AI unavailable' : 'empty/none'})`);
      return false;
    }
    vlog('rescue', `AI plan: ${redactLabel(String(result.assessment || ''))} — ${result.actions.length} action(s) confident=${result.confident}`);
    let progressed = false;
    for (const act of result.actions) {
      if (S.cancelled) break;
      const target = String(act.target || '');
      const t = target.toLowerCase();
      if (act.type === 'park') {
        // Label the park with the FIELD, never the internal stage name — a park is only actionable
        // if its title says what is being asked. Three sources, in descending reliability:
        //   1. the AI's own target;
        //   2. the field it named inside its reason, e.g.
        //      "Required field `work authorization in canada*` cannot be answered truthfully …";
        //   3. the page's real unanswered required fields, when the reason is prose.
        // The internal stage name is the last resort only. Parking straight to it filled the
        // needs-you queue with 107 identical unanswerable rows across 57 tasks (measured 07-25).
        const why = act.reason || 'AI could not safely proceed — needs you';
        const named = target || fieldFromParkReason(act.reason);
        if (named) { park(named, 'text', null, why); return 'parked'; }
        // No delimited field name — the model wrote prose. 30 of the 41 live post-fix parks look
        // like this, and scraping prose for a field name is a losing game. But we do not need to:
        // fieldRefs already holds this page's REAL fields. Park the unanswered REQUIRED ones with
        // their true labels, types and OPTIONS, so the needs-you queue shows an answerable question
        // (a radio renders as its actual choices) and the answer becomes learnable + reusable.
        // Same `required && !value` predicate the rescue signature uses above.
        // The two autofill scan paths already drop combobox screen-reader help via
        // UI_INSTRUCTION_RX; this path parked raw labels and so re-introduced exactly what that
        // guard exists to prevent. Live 2026-08-08: 6 rows reading "1 result available.Use Up and
        // Down to choose options, press Enter to select…" and 9 reading a bare "Type" sat in the
        // needs-you queue as if they were questions. A label that is not a question can never be
        // answered, so the job parks forever.
        const answerable = (f) => f.label && f.label.trim().length > 2 && !UI_INSTRUCTION_RX.test(f.label);
        const blocking = fieldRefs.filter((f) => f.required && !f.value && answerable(f));
        if (blocking.length) {
          for (const f of blocking.slice(0, 6)) park(f.label, f.type, f.options, why);
          return 'parked';
        }
        // Last resort, deliberately kept: a row the user cannot answer is still a signal that this
        // job needs attention, and dropping it entirely would let the task retry-loop silently.
        // See tests/ai-rescue-park-fields.test.mjs for why this stays behind the structural path.
        park('AI rescue', 'text', null, why);
        return 'parked';
      }
      if (act.type === 'click') {
        const btn = btnRefs.find((b) => b.label.toLowerCase() === t) || btnRefs.find((b) => t && (b.label.toLowerCase().includes(t) || t.includes(b.label.toLowerCase())));
        if (!btn) { vlog('rescue', `click target not found: "${redactLabel(target)}"`); continue; }
        if (isFinalSubmit(btn.el)) { vlog('rescue', `REFUSED AI final-submit "${redactLabel(btn.label)}" — submit stays on the verified path`); continue; }
        logLine('ok', `AI rescue: clicking "${btn.label.slice(0, 40)}"`);
        syntheticClick(btn.el); progressed = true; await sleep(500);
        continue;
      }
      if (act.type === 'fill' || act.type === 'select' || act.type === 'check') {
        if (NEVER_AUTOFILL_RX.test(target) || LEGAL_RX.test(target)) { park(target, 'text', null, 'sensitive/legal — needs your answer'); continue; }
        let idx = bestFuzzyIndex(fieldRefs.map((f) => f.label), target, 0.5);
        let f = idx >= 0 ? fieldRefs[idx] : fieldRefs.find((x) => t && (x.label.toLowerCase().includes(t) || t.includes(x.label.toLowerCase())));
        if (!f) { vlog('rescue', `fill target not matched: "${redactLabel(target)}"`); continue; }
        const val = act.type === 'check' ? (/(^|\b)(yes|true|1|on|agree|accept)\b/i.test(String(act.value || '')) ? 'Yes' : 'No') : String(act.value || '');
        if (!val) continue;
        try {
          const ok = await engine.fill([{ input: f.el, value: val, label: f.label }]);
          if (ok) {
            progressed = true;
            logLine('ok', `AI rescue: answered "${f.label.slice(0, 40)}"`);
            try { await engine.recordAnswer({ question: f.label, answer: val, fieldType: f.type, source: 'ai', jobId: job?.id }); } catch {}
          }
        } catch {}
      }
    }
    return progressed ? 'progressed' : false;
  }

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

  // ---- SIGNED-OUT DETECTION -------------------------------------------------------------------
  // The worst failure this project has had: the applier sat SIGNED OUT of LinkedIn for 31 hours
  // (2026-08-06 → 08-07) while looking perfectly healthy. Every dispatch loaded a job page, got the
  // sign-in wall, waited 30s for a control that could never appear, and reported the generic
  // "no advance button found — will retry". Nothing anywhere detected the real cause, so it kept
  // going: hundreds of automated requests from a signed-out session, which is exactly the pattern
  // that earns an account an automated-access warning. It produced ZERO applications the whole time.
  //
  // LinkedIn has (at least) TWO logged-out presentations and the first version of this only caught
  // one. The original outage page rendered the full login form (#csm-v2_session_key /
  // #csm-v2_session_pas), so requiring an input[type=password] worked. But a logged-out JOB page
  // shows only a sign-in overlay — "Join now", "Sign in", "Sign in with Email", "Continue with
  // google" — and NO password field at all. Live 2026-08-10 the laptop sat logged out on exactly
  // that variant with signedOut=false, i.e. the latch that exists to prevent the 31-hour outage
  // silently missed it.
  //
  // The discriminator is now the right way round. A signed-IN LinkedIn page ALWAYS carries the
  // global nav (My Network / Messaging / Notifications); its presence is the strongest possible
  // "we are fine" signal and is what keeps this from false-positiving on, say, a feed post that
  // happens to contain the words "join now". Only when that nav is absent do we look for a sign-in
  // affordance — and those affordances never appear while signed in.
  function linkedInSignedOut() {
    try {
      if (!/(^|\.)linkedin\.com$/i.test(location.hostname)) return false;
      const t = (document.body?.innerText || '').slice(0, 6000);
      // Signed-in global nav present → definitively NOT signed out. Checked first, and it wins.
      if (/\bMy Network\b|\bMessaging\b|\bNotifications\b/i.test(t)) return false;
      // No nav — now any one of these is conclusive.
      if (document.querySelector('input[type="password"]')) return true;   // full login form
      if (/sign in with email/i.test(t)) return true;                      // sign-in overlay
      if (/new to linkedin/i.test(t)) return true;
      return /\bjoin now\b/i.test(t) && /\bsign in\b/i.test(t);
    } catch { return false; }
  }

  // ---- ACCOUNT RESTRICTION -----------------------------------------------------------------------
  // Strictly worse than being signed out, and it needs its own detector.
  //
  // Live 2026-08-10 02:28: LinkedIn served Pierre a full-page checkpoint — "Your account has been
  // temporarily restricted … we detected that over time, it has accessed an unusually high volume of
  // LinkedIn profile data" — and JAT did not notice. It kept dispatching. He found it by looking at
  // the screen. Nothing in the system could tell the difference between "this page failed" and "the
  // platform has sanctioned the account".
  //
  // Why this cannot reuse the signed-out latch: that latch holds only LinkedIn work and CLEARS
  // ITSELF on the next successful apply. Both behaviours are wrong here. A restriction means every
  // further request is evidence against the account, and auto-resuming after a sanction is how a
  // temporary restriction becomes a permanent ban. So this stops the whole engine and stays stopped
  // until a human decides otherwise.
  //
  // The phrases below are specific to the restriction interstitial; ordinary job pages, feed posts
  // and Easy-Apply forms do not contain them.
  function linkedInRestricted() {
    try {
      if (!/(^|\.)linkedin\.com$/i.test(location.hostname)) return false;
      const t = (document.body?.innerText || '').slice(0, 6000);
      if (/your account has been (temporarily )?restricted/i.test(t)) return true;
      if (/we (have )?restricted your account/i.test(t)) return true;
      if (/unusually high volume of linkedin/i.test(t)) return true;
      // A checkpoint URL alone is not enough (they are also used for benign 2FA/verification), so it
      // only counts alongside restriction wording.
      return /\/checkpoint\//i.test(location.pathname) && /restrict/i.test(t);
    } catch { return false; }
  }

  // Halt everything for an account restriction. Returns true if it fired.
  function reportIfRestricted(where) {
    if (!linkedInRestricted()) return false;
    logLine('err', 'LinkedIn has RESTRICTED this account — stopping auto-apply entirely');
    report({
      state: 'failed',
      parkReason: 'account_restricted',
      lastError: 'linkedin-account-restricted — LinkedIn has restricted this account; auto-apply has been STOPPED and will not resume on its own',
      transcriptAppend: { kind: 'recovery', note: `LinkedIn account-restriction page detected (${where}) — engine stopped, no auto-resume` },
    });
    return true;
  }

  // Report the signed-out halt from ANY terminal LinkedIn failure. Returns true if it fired, so the
  // caller stops instead of emitting a misleading reason.
  //
  // v1 called linkedInSignedOut() from exactly ONE branch — the "waiting for the page" path before
  // the hydrate wait. But a logged-out job page usually exits through a DIFFERENT terminal report
  // ("no advance button found — will retry"), which never reached the check. Live 2026-08-10: the
  // laptop was signed out on 9 of 10 sampled pages and produced 64 "no advance button found" plus 26
  // "timed out" in two hours, while the latch still read signedOut=false. Detection is worthless if
  // it is only wired into the path the failure does not take.
  function reportIfSignedOut(where) {
    if (!linkedInSignedOut()) return false;
    logLine('err', 'LinkedIn is SIGNED OUT in this browser — halting instead of retrying');
    report({
      state: 'failed',
      parkReason: 'signed_out',
      lastError: 'linkedin-signed-out — this browser is signed out of LinkedIn; auto-apply is halted until you sign in',
      transcriptAppend: { kind: 'recovery', note: `signed-out sign-in wall detected (${where}) — halted rather than retrying` },
    });
    return true;
  }

  // ---- BROADENED final-submit finder for a recognised pack (BUG: BambooHR submit in footer) ----
  // A recognised account-less ATS can render its FINAL "Submit Application" button OUTSIDE the
  // field container — BambooHR puts it in a page-level footer, so the root-scoped findPackAdvance
  // above misses it entirely and the loop would falsely "no advance button — will retry". When the
  // in-root scan finds nothing, look for the pack's final submit in a BROADER scope (document),
  // but CONSERVATIVELY: only a button the adapter's OWN isSubmitHint recognises (specific, e.g.
  // bamboohr → "submit application") qualifies — never an arbitrary button. We always prefer the
  // in-root control (findPackAdvance) when present; this is strictly the fallback. The pure pick
  // lives in lib/ats-drive.js (findPackSubmitBroadened) so it's node-testable. Returns the element
  // or null. Safe for LinkedIn/modal flows: those have no driveablePack (onLinkedIn → pack=null),
  // and in-root submits are found first, so this never fires for them.
  function findPackSubmitBroad(root) {
    if (!driveablePack || typeof driveablePack.isSubmitHint !== 'function') return null;
    try {
      const rootEl = root || null;
      const cands = qsa('button, input[type="submit"], a[role="button"], [role="button"]', document)
        // Exclude controls already inside the form root — findPackAdvance owns those, and we
        // only broaden for a submit that lives OUTSIDE the scanned root.
        .filter((el) => !(rootEl && rootEl.contains?.(el)))
        .map((el) => ({ el, text: btnText(el), visible: isProbablyVisible(el), disabled: !!el.disabled }));
      const idx = findPackSubmitBroadened(cands, driveablePack.isSubmitHint);
      if (idx >= 0) {
        vlog('button', `pack-submit found OUTSIDE root via broadened scan: "${redactLabel(cands[idx].text)}" (${driveablePack.id})`);
        return cands[idx].el;
      }
    } catch {}
    return null;
  }

  // ---- Fix 1: open-branch button finder (no form open yet, NOT on the /apply/ route) ----
  // Order: a real LinkedIn Easy-Apply opener → a real external opener (when allowed) → the
  // GENERIC advance/open fallback. The generic fallback is the one that, on a LinkedIn
  // job-view page WITHOUT an Easy-Apply opener, used to grab a stray "Next" (carousel / more-
  // jobs pager) and click it forever ("repeated page-level action did not transfer: Next" on
  // external/"Apply on company website" postings, e.g. Bosch). shouldUseGenericOpenFallback
  // blocks that fallback in exactly that case; genuine non-LinkedIn ATS pages still use it.
  function findOpenBranchButton(fallbackScope) {
    const easyOpener = findEasyApplyButton();
    if (easyOpener) { vlog('button', 'open-branch → easy-apply-opener'); return easyOpener; }
    const externalOpener = allowExternal ? findExternalApplyButton() : null;
    if (externalOpener) { vlog('button', 'open-branch → external-opener'); return externalOpener; }
    const onLI = /(^|\.)linkedin\.com$/i.test(location.hostname);
    const onApply = onLI && isLinkedInEasyApplyApplyUrl(location.pathname);
    if (!shouldUseGenericOpenFallback({ onLinkedIn: onLI, onApplyRoute: onApply, hasEasyApplyOpener: false, haveForm: false })) {
      vlog('button', 'open-branch → generic fallback EXCLUDED (LinkedIn job-view, no Easy Apply — would click a stray advance)');
      return null;   // LinkedIn job-view page, no Easy Apply → never click a stray advance button
    }
    const gen = findAdvanceButton(fallbackScope, { allowOpen: true });
    vlog('button', gen ? `open-branch → generic fallback "${redactLabel(btnText(gen))}"` : 'open-branch → no generic advance found');
    return gen;
  }

  while (S.step < MAX_STEPS && !S.cancelled && !finished) {
    S.step++;
    await untilUnpaused();
    if (S.cancelled) break;

    // ---- Fix 3: re-derive the ATS pack when the host changed (external in-tab handoff) ----
    // An external opener can navigate IN-TAB to the company ATS (handled below: externalRoute
    // cleared, "continuing to drive it here"). The packs were computed for the LinkedIn/origin
    // host, so on the company site they'd be stale. Re-derive once per host change so a now-
    // RECOGNISED account-less ATS gets driven by the normal adapter path (and a now-walled ATS
    // is recognised too). UNRECOGNISED hosts derive null packs → today's generic flow / honest
    // no-progress cap, exactly as before. Guarded: only re-runs when the hostname actually moved.
    if (location.hostname !== atsPackHost) {
      atsPackHost = location.hostname;
      ({ atsPack, driveablePack, walledPack } = derivePacks(location.hostname));
      if (driveablePack) logLine('ok', `now on a recognised ATS (${driveablePack.id}) after in-tab navigation — driving it`);
    }

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
    // "HAVE A GO" on a SELF-CLEARING Cloudflare interstitial — the managed/JS "checking your
    // browser…" wall that resolves ITSELF on a short wait, with NO user action and NO widget
    // interaction. Bounded (~15s), no-touch: we never front the window, never click/solve anything,
    // never arm the host breaker during the wait. Re-runs the FULL probe each tick so the instant
    // it clears we resume the apply; the instant a REAL interactive widget appears (late iframe
    // injection → selfClearing flips false) or the budget elapses, we fall through to the honest
    // terminal park below. This is the legitimate "try it" — waiting out the page's own JS — and
    // it NEVER crosses the never-auto-solve line. Interactive captcha/verify gates skip this entirely.
    if (challenge.blocked && challenge.kind === 'cloudflare') {
      // (a) BRIEF no-touch self-clear wait first: a no-widget "checking your browser" JS challenge
      //     often passes on its own in a few seconds — don't bother the user for those.
      if (challenge.selfClearing) {
        logLine('info', 'Cloudflare check — waiting a moment to see if it clears itself…');
        setStatus('Cloudflare check — waiting…');
        const t0 = Date.now();
        let selfCleared = false;
        while (Date.now() - t0 < 12000 && !S.cancelled) {
          await sleep(2000);
          const c2 = detectBotChallengeOnPage();
          if (!c2.blocked) { selfCleared = true; break; }
          if (!c2.selfClearing) break;   // a real interactive widget rendered → hand to the human below
        }
        if (selfCleared) {
          logLine('ok', 'Cloudflare check cleared on its own — continuing the application');
          report({ transcriptAppend: { kind: 'recovery', note: 'self-clearing Cloudflare check cleared on a no-touch wait — resuming' } });
          noChange = 0;
          continue;
        }
      }
      // (b) HUMAN HANDOFF (Option 2): we NEVER auto-solve/bypass. Fire an OS notification + surface the
      //     apply tab, then WAIT (no interaction from us) while the USER completes the check. Cloudflare
      //     then sets cf_clearance in the shared Chrome profile, so one solve covers many later jobs until
      //     it expires — minimizing how often the user is asked. Bounded (~4 min); cancel-aware.
      logLine('warn', 'Cloudflare needs a human check — notifying you; auto-apply will continue once you verify');
      setStatus('Verify you’re human in the apply tab — auto-apply will resume');
      // Use send() (callback form) — NOT raw sendMessage. Raw sendMessage with no callback returns a
      // PROMISE that REJECTS when the background's message channel closes (the MV3 service worker
      // sleeps during the multi-minute wait), surfacing as an unhandled rejection that KILLED the task
      // before the user could solve anything (the live "message channel closed" crash — 0 applies/7h).
      // send() swallows lastError and never rejects. Re-ping every ~25s so the user is reminded and
      // the apply window is re-surfaced if they navigated away (the background no-ops a duplicate).
      // Alert on EVERY channel (the OS frequently suppresses notifications + blocks window-focus):
      // background fires the OS notification + flashes the taskbar + sets a toolbar badge; here we add
      // an in-page banner + a beep. The background also flips this tab to "awaiting human" so the run's
      // hard cap is suspended (12 min) — otherwise the 90s hidden-stall cap closes the captcha tab.
      send({ type: 'jat11.human-challenge', host: location.hostname });
      showCfBanner();
      cfBeep();
      report({ transcriptAppend: { kind: 'recovery', note: 'cloudflare human-check — alerted you (notification + flashing tab + badge + in-page banner + beep); waiting for you to verify' } });
      const cf0 = Date.now();
      const HUMAN_WAIT_MS = 360000;   // full wait when the user is actually present
      const PROBE_MS = 30000;         // UNATTENDED FAST-SKIP: with no interaction in 30s, park instead
                                      // of burning 6 min per hit — the overnight-run killer (27 hits × 6 min).
      let cfCleared = false, lastPing = Date.now(), userSeen = false;
      // The user is "present" only if they actually touch this machine while the check is up.
      const onAct = () => { userSeen = true; };
      const ACT_EVENTS = ['mousemove', 'keydown', 'pointerdown', 'wheel', 'touchstart'];
      const onVis = () => { if (document.visibilityState === 'visible') userSeen = true; };
      ACT_EVENTS.forEach((e) => window.addEventListener(e, onAct, { passive: true, capture: true }));
      document.addEventListener('visibilitychange', onVis);
      try {
        while (Date.now() - cf0 < HUMAN_WAIT_MS && !S.cancelled) {
          await sleep(2500);
          if (!detectBotChallengeOnPage().blocked) { cfCleared = true; break; }
          // Unattended: nobody interacted within the probe window → don't waste the wait.
          if (!userSeen && Date.now() - cf0 > PROBE_MS) {
            vlog('challenge', 'cloudflare human-check: no interaction within probe — run is unattended, parking fast (host breaker will skip further same-host jobs)');
            break;
          }
          if (Date.now() - lastPing > 25000) { lastPing = Date.now(); send({ type: 'jat11.human-challenge', host: location.hostname, repeat: true }); if (userSeen) cfBeep(); }
        }
      } finally {
        ACT_EVENTS.forEach((e) => window.removeEventListener(e, onAct, { capture: true }));
        document.removeEventListener('visibilitychange', onVis);
      }
      hideCfBanner();
      send({ type: 'jat11.human-challenge-resolved', cleared: cfCleared, host: location.hostname });
      vlog('challenge', `cloudflare human-handoff: ${cfCleared ? 'cleared by user' : 'not solved in time'} after ${Math.round((Date.now() - cf0) / 1000)}s`);
      if (cfCleared) {
        logLine('ok', 'Cloudflare check passed (you verified) — continuing the application');
        report({ transcriptAppend: { kind: 'recovery', note: 'cloudflare cleared after human verification — resuming; cf_clearance now covers later jobs' } });
        noChange = 0;
        continue;
      }
      logLine('warn', 'Cloudflare check not completed in time — parking for you');
    }
    if (challenge.blocked) {
      const why = botChallengeLastError(challenge.kind);
      logLine('warn', `${why} (${challenge.reason}) — stopping; not our flow's failure`);
      setStatus('Site bot-challenge — needs you to verify');
      signalHydrated();   // release any held front-until-hydrated; we are NOT waiting on hydration
      // DEFER, don't skip. A verification wall is TRANSIENT: it clears, and this posting was never
      // attempted. This is the twin of the host-breaker bug fixed in 11.88.14 -- the breaker stopped
      // destroying jobs it declined to dispatch, but the executor was still terminally skipping the
      // job that first hit the wall (8 such jobs live on 2026-07-20, every one attempts=0).
      // Stay 'queued' with scheduled_at past the breaker window so the pump passes over it
      // (server.js hostDeferred) and it becomes dispatchable again by itself once the wall lifts.
      // The botChallenge hint below still arms the host breaker exactly as before.
      // Mirrors HOST_BREAKER_COOLDOWN_MS in ../lib/host-breaker.js. Inlined deliberately: that
      // module is not in web_accessible_resources, and importing it made the whole executor module
      // fail to load ("Failed to fetch dynamically imported module"), which breaks every apply.
      const HOST_BREAKER_COOLDOWN_MS = 20 * 60 * 1000;
      const deferUntil = new Date(Date.now() + HOST_BREAKER_COOLDOWN_MS).toISOString();
      report({
        state: 'queued',
        scheduledAt: deferUntil,
        lastError: null,
        parkReason: null,
        botChallenge: { kind: challenge.kind, host: location.hostname.replace(/^www\./, ''), reason: challenge.reason },
        transcriptAppend: { kind: 'recovery', note: `${why} [${challenge.reason}] — site anti-automation gate; deferred until ${deferUntil}, not skipped (host breaker armed)` },
      });
      finalState = 'queued';
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
      // CAPTCHA human-assist: we never auto-solve/bypass (hard line), but the rest of the form is
      // already filled — so bring the window to the FRONT and give the user a bounded window to
      // solve it, then CONTINUE the application if they do. Only park if it isn't solved in time.
      // (Login walls still hand straight back — they need credentials we won't enter.)
      if (blocker === 'captcha') {
        logLine('warn', 'CAPTCHA — bringing the window to the front so you can solve it');
        setStatus('CAPTCHA — solve it in the window (waiting ~45s)…');
        try { await send({ type: 'jat11.nudge-apply-window' }); } catch {}
        if (await waitForCaptchaCleared(45000)) {
          logLine('ok', 'CAPTCHA cleared by you — continuing the application');
          report({ transcriptAppend: { kind: 'recovery', note: 'CAPTCHA solved by user (human-assist) — resuming apply' } });
          noChange = 0;
          continue;
        }
      } else {
        logLine('warn', `${blocker} detected — handing back to you`);
      }
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
    const onSmartApply = /(^|\.)smartapply\.indeed\.com$/i.test(location.hostname);
    // KEYSTONE: the new FULL-PAGE Easy Apply flow has no modal dialog. When findApplyDialog()
    // misses, recognise the /jobs/view/<id>/apply/ full-page form structurally (the visible
    // Next/Review/Submit button's field-bearing, nav-free ancestor). This is the root the
    // existing fill + F1 advance logic then drives. The old-modal `dialog` still WINS when a
    // real modal is present (search/collections split-view) so BOTH layouts work.
    // Structural grounding when there's no modal: LinkedIn full-page /apply/ OR Indeed smartapply
    // (its radios-only screening steps grounded root=none without this → "Continue" clicked blindly).
    const applyPageRoot = (!dialog && onLinkedIn) ? findLinkedInApplyPageRoot()
      : (!dialog && onSmartApply) ? findSmartApplyPageRoot()
        : null;
    // OPENER → NAVIGATION recognition: the full-page opener NAVIGATES to .../apply/ instead
    // of opening an in-place modal. The moment the live URL is the /apply/ route, the form is
    // "opened" — latch everHadForm so the opener is NEVER re-clicked (this excludes the opener
    // path below) even during the brief window before the advance button/fields hydrate. The
    // duplicate-opener breaker therefore can't fire once we're on /apply/.
    if (onLinkedIn && !everHadForm && isLinkedInEasyApplyApplyUrl(location.pathname)) {
      everHadForm = true; S.everHadForm = true;
      if (S.routeState === 'unknown') S.routeState = 'linkedin_easy_apply_modal';
      logLine('ok', 'Easy Apply navigated to the full-page application (/apply/) — driving it here');
    }
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
    // On LinkedIn, once a form has opened the ONLY safe roots are the tight dialog OR the
    // full-page apply root (both exclude the page-level opener + global nav). The full-page
    // flow has no modal, so after Next/Review the next root is again the full-page apply root.
    const root = onLinkedIn && everHadForm
      ? (dialog || applyPageRoot)
      : (dialog || applyPageRoot || packRoot || (broadLinkedInRoot ? null : probedRoot));
    const haveForm = !!root;
    // [TRACE 1] PAGE STATE — one structured line per loop iteration capturing
    // exactly what the executor sees before it acts: step#, URL path, tab
    // visibility/focus (the throttling signals), the N/M page indicator, the
    // current route state, haveForm, and WHICH root matched (modal vs /apply/
    // root vs ats-pack vs probed form) + a short why for the no-form case.
    try {
      const progress = pageProgressIndicator();
      const rootDesc = describeRoot({ dialog, applyPageRoot, packRoot, probedRoot, root });
      let vis = '?'; let focus = '?';
      try { vis = document.visibilityState; } catch {}
      try { focus = document.hasFocus() ? 'focused' : 'blurred'; } catch {}
      vlog('page', `step=${S.step} path=${pagePathOf()} vis=${vis} ${focus}`
        + (progress ? ` pages=${progress}` : '')
        + ` route=${S.routeState || 'unknown'} haveForm=${haveForm} root=${rootDesc}`
        + (haveForm ? '' : ` (everHadForm=${everHadForm}${onLinkedIn ? ' onLinkedIn' : ''}${atsPack ? ' ats=' + atsPack.id : ''})`));
    } catch {}
    if (haveForm) {
      everHadForm = true; S.everHadForm = true;
      // The full-page flow IS the Easy Apply application — treat it as the easy-apply route.
      if ((dialog || applyPageRoot) && onLinkedIn) S.routeState = 'linkedin_easy_apply_modal';
      else if (!S.externalRoute && S.routeState === 'unknown') S.routeState = 'same_tab_application';
      signalHydrated(); reportSeen(root, 'apply form');
    }
    // "Form disappeared after advancing" only fails when we're NOT on the full-page /apply/
    // route. On /apply/ the form IS present (just mid-hydration / between pages after Next) —
    // failing here would abort a live full-page application; the no-button hydration wait below
    // handles that case correctly without ever re-clicking the opener.
    if (!haveForm && everHadForm && onLinkedIn && !isLinkedInEasyApplyApplyUrl(location.pathname)) {
      // The modal also vanishes for the BEST reason: the advance COMPLETED the application and
      // LinkedIn replaced it with its confirmation. Failing blindly here recorded genuinely
      // SUBMITTED applications as failures — and "will retry" then re-applied to a job the user
      // had already applied to. So look for POSITIVE success evidence before calling it a loss.
      //
      // Deliberately NOT using confirmSubmitted()'s "apply form closed" branch: the form is
      // closed by definition in this branch, so that heuristic would mark EVERY disappearance as
      // a submit — a false positive, which is worse than the bug. Only success TEXT or a success
      // URL counts. Poll briefly because the banner renders a beat after the click.
      let lateSuccess = null;
      for (let i = 0; i < 8 && !S.cancelled; i++) {
        if (urlLooksLikeSuccess()) { lateSuccess = 'success-url'; break; }
        if (pageTextLooksLikeSuccess(8000)) { lateSuccess = 'success-text'; break; }
        await sleep(400);
      }
      if (lateSuccess) {
        vlog('submit', `→ DONE evidence=verified:${lateSuccess} (modal closed because the application completed)`);
        logLine('ok', `✓ application submitted (${lateSuccess})`);
        setStatus('✓ Application submitted');
        if (job?.id) await send({ type: 'api-call', method: 'PATCH', path: '/jobs/' + encodeURIComponent(job.id), body: { status: 'submitted' } });
        report({
          state: 'done', lastError: null, parkReason: null, pendingQuestions: [], applyRoute: 'easy-apply',
          submissionEvidence: { type: 'verified', reason: lateSuccess, detail: 'modal closed after advance with success on the page', url: location.href, at: new Date().toISOString() },
          transcriptAppend: { note: `submitted — verified (${lateSuccess}) after the Easy Apply modal closed` },
        });
        finalState = 'done';
        break;
      }
      const fingerprint = recoveryFingerprint({ hostname: location.hostname, pathname: location.pathname, label: 'easy apply form', stage: 'lost-after-advance' });
      logLine('warn', 'Easy Apply form disappeared after advancing — stopping instead of re-clicking the opener');
      report({ state: 'failed', lastError: 'Easy Apply form disappeared after advancing — will retry', applyRoute: 'easy-apply', transcriptAppend: { kind: 'recovery', note: 'sticky Easy Apply scope was lost after advance', fingerprint } });
      finalState = 'failed';
      break;
    }

    // ---- fill from profile + learned answers ----
    setStatus(`Step ${S.step}: ${haveForm ? 'filling fields…' : 'opening the application…'}`);
    // Collect WHY each field was passed over, so a `fillable=0` step can explain itself.
    const scanSkips = [];
    const noteSkip = (reason, input, label) => {
      if (scanSkips.length >= 14) return;
      let d = '';
      try {
        d = (input.tagName || '').toLowerCase() + (input.type ? ':' + input.type : '')
          + (input.id ? ' #' + String(input.id).slice(0, 18) : '')
          + (input.placeholder ? ' ph="' + String(input.placeholder).slice(0, 26) + '"' : '')
          + (label ? ' lbl="' + redactLabel(String(label)).slice(0, 34) + '"' : '');
      } catch {}
      scanSkips.push(reason + ' ← ' + d);
    };
    const suggestions = haveForm ? (await engine.scanFillable(root, noteSkip)).filter((s) => {
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
    // [TRACE 2a] FIELD SCAN — what scanFillable resolved as fillable (label/type/
    // source), value redacted. The per-field FILL OUTCOME is traced via the
    // onOutcome side-channel passed to engine.fill() below (behavior-neutral).
    if (haveForm) {
      vlog('scan', `fillable=${suggestions.length}`);
      for (const s of suggestions.slice(0, 12)) {
        vlog('field', `"${redactLabel(s.label)}" type=${traceFieldType(s.input)} src=${s.source || '?'} → ${redactValue(s.value, s.label)}`);
      }
      // Say WHY each field was passed over, so the failure is diagnosable from the transcript
      // instead of guessed at.
      //
      // This used to fire ONLY when nothing at all was fillable, which blinded the exact case now
      // blocking every Greenhouse run: live 2026-08-13 on Affirm the scan reported `fillable=1`
      // (pronouns) out of 9 required fields, filled that one, then died on "BLOCKED by native
      // validation — 6 required field(s) still invalid". Because suggestions.length was 1 and not 0,
      // the reasons the other eight were skipped were never written down, and the transcript could
      // not distinguish a label-match miss from a visibility/duplicate-node skip. A PARTIAL scan
      // that leaves required fields behind is exactly as fatal as an empty one — log both.
      if (scanSkips.length) {
        vlog('scan', `skipped ${scanSkips.length} field(s):`);
        for (const s of scanSkips.slice(0, 10)) vlog('scan', '  ' + s);
      }
    }
    const filled = await engine.fill(suggestions, ({ suggestion, outcome, detail }) => {
      // [TRACE 2b] FILL OUTCOME per field.
      const lbl = redactLabel(suggestion.label);
      const src = suggestion.source === 'qa' ? 'filled-from-qa' : 'filled-from-profile';
      if (outcome === 'filled') vlog('fill', `"${lbl}" → ${src}`);
      else if (outcome === 'fuzzy-snapped') vlog('fill', `"${lbl}" → fuzzy-snapped-to "${redactLabel(detail)}"`);
      // A REQUIRED control we could not satisfy will block EVERY advance attempt, so leaving it
      // silently empty is the expensive failure: the flow clicks the advance button against a form
      // that can never move. Live 2026-08-09 on the PC — profile held a work-authorization answer,
      // the select had no option matching that exact text, the field was left empty, and the task
      // burned 75 of its 100 page iterations clicking "Review" before dying as a generic
      // "stuck on a step". ~26 minutes per task, converting nothing.
      //
      // Parking it instead does two things: the existing `if (parked.length) reportParked(); break;`
      // checks short-circuit the loop immediately, and the question surfaces WITH ITS REAL OPTIONS,
      // so it is answerable once and then learned — the next posting fills it automatically.
      else if (outcome === 'skipped-no-option' || outcome === 'skipped-combobox-miss') {
        const how = outcome === 'skipped-no-option' ? 'no matching option' : 'typeahead no match';
        vlog('fill', `"${lbl}" → left-empty (${how})`);
        if (suggestion.required) {
          park(suggestion.label, suggestion.fieldType || 'select', suggestion.options || null,
            `we hold an answer for this, but none of this field's options match it — pick the right one once and it will be reused`);
          vlog('fill', `"${lbl}" is REQUIRED and unfillable — parking instead of clicking a form that cannot advance`);
        }
      }
      else if (outcome === 'skipped-not-yes') vlog('fill', `"${lbl}" → skipped-optional (checkbox, answer not affirmative)`);
      else if (outcome === 'skipped-site-chrome') vlog('fill', `"${lbl}" → skipped (site chrome)`);
      else if (outcome === 'error') vlog('fill', `"${lbl}" → error (${String(detail || '').slice(0, 40)})`);
    });
    if (filled) logLine('ok', `filled ${filled} field(s) from profile/history`);

    // ---- resume upload / selection (handles BOTH layouts) ----
    // NEW full-page Easy Apply: the resume step may have (a) saved-resume RADIO CARDS to
    // SELECT, or (b) a plain "Upload resume" <button> with NO `<input type=file>` in the DOM
    // until it is CLICKED (clicking CREATES the input). handleResumePage() recognises these,
    // selects the most-recent saved resume, or clicks-then-attaches, and PARKS honestly when a
    // resume is genuinely required but unattachable — instead of looping "stuck". The OLD modal
    // layout (file input already present) flows through the same handler's 'attach' branch, so
    // the existing path is preserved. When the page has no resume-shaped UI at all, the handler
    // is a no-op and we fall through to the legacy tryAttachResume() (unchanged behavior).
    let att = { attempted: false, attached: 0 };
    let resumeSatisfiedBySelect = false;   // saved card selected (no attach) → not an attach failure
    if (haveForm) {
      const resumePage = await handleResumePage(root, resume);
      if (resumePage.park) {
        logLine('warn', `resume — ${resumePage.park}`);
        setStatus(`Needs you — ${resumePage.park}`);
        report({
          state: 'parked',
          parkReason: 'resume_required',
          lastError: resumePage.park,
          pendingQuestions: [{ question: resumePage.park, fieldType: 'resume', reason: 'resume_required' }],
          transcriptAppend: { kind: 'recovery', note: `resume required but unattachable — parked honestly (${resumePage.park})` },
        });
        finalState = 'parked';
        break;
      }
      if (resumePage.acted) {
        att = { attempted: true, attached: resumePage.attached };
        // A saved-resume card selected satisfies the requirement WITHOUT an attach — so the
        // attached===0 attach-failure guard below must not fire on it.
        resumeSatisfiedBySelect = resumePage.satisfied && resumePage.attached === 0;
      } else if (resumePage.satisfied) {
        // ALREADY SATISFIED without acting: ensureResume returns { acted:false, satisfied:true }
        // for 'saved-resume-already-selected'. Branching on `acted` alone sent that case into the
        // legacy attach below, which re-uploads the file into every file input on the page even
        // though the decision just said nothing was needed. Live 2026-07-20 that showed up as
        //   trace:resume … → action=none (saved-resume-already-selected)
        //   attached PierreSalama_2026.2.pdf          ← re-upload, unwanted
        //   trace:button no control found (tier=in-form-advance)
        //   trace:hydrate initial wait EXHAUSTED (31876ms) — no control yet
        // on Indeed's resume-selection module: the re-upload puts the module back into
        // processing, the Continue button goes away, and the run dies as "module stuck
        // (Continue never enabled)" after burning the full 30s hydrate cap.
        att = { attempted: false, attached: 0 };
        resumeSatisfiedBySelect = true;
        vlog('resume', 'already satisfied by a selected saved resume — skipping the legacy attach');
      } else {
        // No resume-shaped UI handled → legacy attach path (file input already present, etc.).
        att = await tryAttachResume(root, resume);
      }
    }
    // SUCCESS-TRUTH grounding: we opened a real, field-bearing application surface
    // (a verified dialog, or a probed form we filled/attached into) for THIS job.
    // A generic page-level Submit on a careers/search/newsletter/problem-report
    // page never reaches here with a form root, so it can never be grounded.
    // SUCCESS-TRUTH grounding signals: a verified modal `dialog`, a structurally-grounded full-page
    // `applyPageRoot` (findLinkedInApplyPageRoot only returns a field-bearing, nav-free /apply/ root —
    // never a stray newsletter form), a profile fill, or a résumé attach/select. Without applyPageRoot
    // here, a full-page radios-ONLY flow (no branded dialog, eligibility answered via grounded-
    // eligibility which doesn't bump `filled`) submitted but could never be VERIFIED → landed in
    // awaiting_review instead of a clean done (the obfuscated Ultrassure case).
    if (haveForm && (dialog || applyPageRoot || filled > 0 || att?.attached > 0 || resumeSatisfiedBySelect)) formGrounded = true;
    // smartapply.indeed.com IS Indeed's hosted apply flow — every page there (resume / questions /
    // review / post-apply) is a real application surface, never a random page. So being on that host
    // is itself success-truth grounding. Without this, a smartapply job that lands DIRECTLY on the
    // REVIEW step (no fillable field — Indeed pre-filled everything from the profile) had
    // formGrounded=false, so its real submit (URL → /post-apply) downgraded to awaiting_review instead
    // of a verified done. Live: this was the dominant Indeed-Apply loss (submitted but "unverified").
    if (/(^|\.)smartapply\.indeed\.com$/i.test(location.hostname)) formGrounded = true;
    if (resume?.id && att.attempted && att.attached === 0 && !resumeSatisfiedBySelect) {
      // An attach was attempted but produced nothing. Split by whether a résumé is GENUINELY
      // required on THIS page (review finding): only then is it a terminal blocker.
      let resumeRequiredHere = false;
      try { resumeRequiredHere = pageRequiresResume(compactText(root?.innerText || root?.textContent || '')); } catch {}
      if (resumeRequiredHere) {
        // Required + unattachable → retrying can NEVER satisfy it. PARK as user-actionable
        // resume_required (terminal 'user' in db.js) instead of failing RETRIABLY, which used to
        // re-dispatch the same unsatisfiable page to the 4× cap (the dominant Indeed-resume loss).
        logLine('warn', 'résumé required but no upload/select control found — parking for you to add a résumé');
        report({
          state: 'parked',
          parkReason: 'resume_required',
          lastError: 'résumé required — add or select a résumé on this posting',
          pendingQuestions: [{ question: 'This posting requires a résumé but none could be attached — select your résumé or add one', fieldType: 'resume', reason: 'resume_required' }],
          transcriptAppend: { kind: 'recovery', note: 'resume required, no attachable control → parked (resume_required), not retried' },
        });
        finalState = 'parked';
        break;
      }
      // Résumé was OPTIONAL here and the programmatic attach flaked — do NOT block the application.
      // Continue and let the form submit without it (previously this terminal-failed/retried or
      // over-parked an optional page).
      logLine('warn', 'could not attach an optional résumé — continuing without it');
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
    // [TRACE 2c] UNANSWERED fields the ladder must resolve (with required flag).
    if (haveForm) {
      vlog('scan', `unknown=${unknownAll.length} toResolve=${unknown.length}`);
      for (const u of unknown) vlog('field', `unanswered "${redactLabel(u.label)}" type=${u.fieldType}${u.required ? ' REQUIRED' : ' optional'}${u.options ? ' opts=' + u.options.length : ''}`);
    }
    for (const u of unknown) {
      if (S.cancelled) break;
      // GROUNDED ELIGIBILITY FIRST (any language), BEFORE the LEGAL_RX gate. LEGAL_RX's
      // "work.*authoriz" misses the common "authorized to work" word order (and all French/Spanish
      // phrasings), so those eligibility Qs used to fall through to the AI. isEligibilityScreeningQuestion
      // is PRECISE (full-phrase EN/FR/ES), so grounding here answers them TRUTHFULLY from the profile
      // without risking a non-eligibility false-park. Non-eligibility legal/sensitive Qs still fall to
      // the LEGAL_RX park below.
      if (isEligibilityScreeningQuestion(u.label) && authorizedToWork != null) {
        const eopts = Array.isArray(u.options) ? u.options : [];
        const yesText = eopts.find((o) => /^\s*(yes|oui|s[ií]|ja)\b/i.test(o)) || 'Yes';
        const noText = eopts.find((o) => /^\s*(no|non|nein)\b/i.test(o)) || 'No';
        const eg = groundedEligibilityAnswer(u.label, { authorizedToWork, yesText, noText, options: eopts });
        if (eg != null && await engine.fill([{ input: u.input, value: eg }])) {
          vlog('screen', `grounded-eligibility "${redactLabel(u.label)}" = ${redactValue(eg, u.label)} (authorizedToWork=${authorizedToWork})`);
          logLine('ok', `answered eligibility "${u.label.slice(0, 40)}" → ${eg} (from your work authorization)`);
          try { await engine.recordAnswer({ question: u.label, answer: eg, fieldType: u.fieldType, source: 'profile', jobId: job?.id }); } catch {}
          continue;
        }
      }
      if (LEGAL_RX.test(u.label)) {
        // Legal/eligibility questions NEVER go to AI. But the well-known work-auth / sponsorship
        // screening Qs are TRUTHFULLY grounded from the profile (authorizedToWork) — answer those
        // HERE, in the MAIN pass, so they fill on this step. Previously this branch parked ALL
        // eligibility eagerly and only the answer-rescan grounded them; that left a STALE pending
        // entry, so the form filled + advanced to Review but the job still terminal-PARKED on an
        // already-answered question (the Ultrassure radios-only "never submits" failure). Only
        // genuinely unanswerable eligibility (EEO/criminal/clearance, or auth unknown) parks.
        let grounded = null;
        if (isEligibilityScreeningQuestion(u.label)) {
          const opts = Array.isArray(u.options) ? u.options : [];
          // Language-aware: a French (Oui/Non) or Spanish (Sí/No) smartapply radio resolves to its
          // OWN option string so the grounded answer matches (else "Yes" wouldn't match "Oui").
          const yesText = opts.find((o) => /^\s*(yes|oui|s[ií]|ja)\b/i.test(o)) || 'Yes';
          const noText = opts.find((o) => /^\s*(no|non|nein)\b/i.test(o)) || 'No';
          grounded = groundedEligibilityAnswer(u.label, { authorizedToWork, yesText, noText, options: opts });
        }
        if (grounded != null && await engine.fill([{ input: u.input, value: grounded }])) {
          // [TRACE 8] grounded-eligibility default applied from the profile (never invented).
          vlog('screen', `grounded-eligibility "${redactLabel(u.label)}" = ${redactValue(grounded, u.label)} (from profile, authorizedToWork=${authorizedToWork})`);
          logLine('ok', `answered eligibility "${u.label.slice(0, 40)}" → ${grounded} (from your work authorization)`);
          try { await engine.recordAnswer({ question: u.label, answer: grounded, fieldType: u.fieldType, source: 'profile', jobId: job?.id }); } catch {}
          continue;
        }
        // [TRACE 8] SCREENING — legal/eligibility we can't ground → never AI'd; parked for the user.
        vlog('screen', `legal/eligibility "${redactLabel(u.label)}" → not AI'd${(u.required || onJobBoard) ? ' → PARK' : ' → left (optional)'}`);
        logLine('warn', `legal/eligibility question not in profile: "${u.label.slice(0, 60)}" — leaving for you`);
        if (u.required || onJobBoard) park(u.label, u.fieldType, u.options, 'legal/eligibility — needs your answer');
        continue;
      }
      // Optional photo/headshot fields: leave blank + move on — don't park the job on a
      // field that's almost always optional and can't be truthfully auto-answered.
      if (OPTIONAL_SKIP_RX.test(u.label)) {
        vlog('field', `"${redactLabel(u.label)}" → left-empty (optional photo/headshot — not auto-answerable)`);
        logLine('warn', `left optional field blank: "${u.label.slice(0, 40)}" (photo/headshot — not auto-answerable)`);
        continue;
      }
      // Referral fields ("referred by (name)" / "if you were referred…" / "Were you referred?"): when
      // not referred (the common case) the AI refuses (no info) → parks → stalls the form. Answer the
      // truthful neutral default (text → "N/A"; Yes/No → No) so it advances.
      if (isReferralQuestion(u.label)) {
        const rv = referralDefaultAnswer(u.label, { fieldType: u.fieldType, options: u.options });
        if (rv != null) {
          const ok = await engine.fill([{ input: u.input, value: rv }]);
          vlog('screen', `referral "${redactLabel(u.label)}" → ${rv} (not referred) ${ok ? 'filled' : 'fill-failed'}`);
          if (ok) {
            logLine('ok', `answered referral "${u.label.slice(0, 40)}" → ${rv} (not referred)`);
            try { await engine.recordAnswer({ question: u.label, answer: rv, fieldType: u.fieldType, source: 'profile', jobId: job?.id }); } catch {}
            continue;
          }
        }
      }
      setStatus(`Step ${S.step}: thinking about "${u.label.slice(0, 40)}…"`);
      // [TRACE 5] AI LADDER — the question going to /ai/answer-question.
      vlog('ai', `ask "${redactLabel(u.label)}" type=${u.fieldType}`);
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
        // [TRACE 5] AI result rejected — refusal / low-confidence / malformed.
        const why = !a ? 'malformed/failed' : a.refuse ? 'refused' : !a.answer.trim() ? 'empty' : `conf ${a.confidence.toFixed(2)}<min ${S.sessionSettings.confidence}`;
        vlog('ai', `reply "${redactLabel(u.label)}" → ${a ? 'ans="' + redactValue(a.answer, u.label) + '" ' : ''}${why} → ${(u.required || onJobBoard) ? 'PARK' : 'left'}`);
        logLine('warn', `no grounded answer for "${u.label.slice(0, 50)}" (${a ? 'conf ' + a.confidence : 'ai failed/malformed'})`);
        // Not highly confident → park it (don't guess). Required fields and any
        // job-board screening question must be answered before we submit.
        if (u.required || onJobBoard) park(u.label, u.fieldType, u.options, a && a.reason ? a.reason : 'no confident answer');
        continue;
      }
      // [TRACE 5] AI accepted (above confidence floor).
      vlog('ai', `reply "${redactLabel(u.label)}" → ans="${redactValue(a.answer, u.label)}" conf=${a.confidence.toFixed(2)} → accepted`);
      const ok = await engine.fill([{ input: u.input, value: a.answer }]);
      if (ok) {
        logLine('ok', `AI answered "${u.label.slice(0, 40)}" (conf ${a.confidence.toFixed(2)})`);
        await engine.recordAnswer({ question: u.label, answer: a.answer, fieldType: u.fieldType, source: 'ai', jobId: job?.id });
      } else {
        vlog('ai', `"${redactLabel(u.label)}" → AI answer could NOT be filled (un-pickable widget)`);
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
    // On the NEW full-page /apply/ route the opener is already gone (we navigated here), so we
    // must NEVER use the open-path button finders (they could re-click a stray opener). Use the
    // ADVANCE-ONLY scan (Next/Review/Submit) scoped to the form root or the document. This also
    // covers the brief window where haveForm is false because the advance button hasn't hydrated.
    const onApplyPage = onLinkedIn && isLinkedInEasyApplyApplyUrl(location.pathname);
    // In-form: prefer buttons inside the modal. Not open yet (and NOT on /apply/): also try
    // LinkedIn's Easy-Apply button to OPEN the form (covers postings the generic scan misses).
    let btn = haveForm
      ? (findPackAdvance(root) || findAdvanceButton(root, { allowOpen: false }) || findPackSubmitBroad(root))
      : (onApplyPage
          ? (findAdvanceButton(root || document, { allowOpen: false }))
          : findOpenBranchButton(root));
    // [TRACE 3] BUTTON CHOICE — which control was selected and which TIER (in-form
    // advance vs /apply/ advance vs easy-apply/external/generic opener) + the branch.
    try {
      const tier = haveForm ? 'in-form-advance'
        : onApplyPage ? '/apply/-advance'
        : 'open-branch(opener)';
      if (btn) vlog('button', `chose "${redactLabel(btnText(btn))}" tier=${tier}${isEasyApplyOpener(btn) ? ' [easy-apply-opener]' : ''}`);
      else vlog('button', `no control found (tier=${tier}) — opener excluded? haveForm=${haveForm} onApplyPage=${onApplyPage}`);
    } catch {}
    if (!btn) {
      const opening = !everHadForm;   // the apply form has never appeared yet
      // Fix 3: the NEW Easy Apply NAVIGATES to a full /apply/ page that must LOAD. On a
      // backgrounded/throttled tab that page loads slowly → the advance button / form root
      // hasn't hydrated yet even though everHadForm was latched the moment the URL became
      // /apply/ (so `opening` is false here). That case must ALSO trigger the front-until-
      // hydrate nudge — not only the opener-stall path — so the page actually loads. The
      // form works once loaded; only the initial navigation/load throttles.
      const applyPageLoading = onApplyPage && !haveForm;
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
      // ---- FAST-SKIP: positively-EXTERNAL LinkedIn JOB-VIEW posting (CONFIRMED ROOT CAUSE) ----
      // With easyApplyOnly ON, JobSpy floods the queue with NON-Easy-Apply LinkedIn jobs
      // (it can't read the EA flag). The executor used to OPEN each one, find no Easy-Apply
      // opener, then BURN the full ~20s hydration cap before skipping "without a diagnostic"
      // (route=null) — dozens of 20s-wasting skips per run, almost no real applies.
      //
      // When the form has never opened (`opening`), we're on a LinkedIn JOB-VIEW page (NOT the
      // /apply/ route), AND a POSITIVE external signal is present (an off-LinkedIn "Apply ↗"
      // anchor / an explicitly-external Apply label / "Responses managed off LinkedIn"), the
      // posting is external — there is no Easy Apply to wait for. SKIP NOW (~0s) with an HONEST
      // diagnostic + applyRoute 'external' so (a) the user learns WHY and (b) the terminal
      // 'skipped' state is non-retriable (retryStaleQueue only re-pulls 'failed'), so it is
      // never re-dispatched. CONSERVATIVE: it fires ONLY on a positive external signal — the
      // mere ABSENCE of an Easy-Apply opener keeps the full hydration wait below, so a genuinely
      // slow-hydrating REAL Easy Apply is NEVER mis-skipped.
      const onLI_fs = /(^|\.)linkedin\.com$/i.test(location.hostname);
      // Indeed smartapply keeps Continue DISABLED while its React module hydrates, so findBtn()
      // (which rejects disabled) returns null and we would blind-wait the full cap. Detect that a
      // loading advance IS present so we (a) wait SHORT and re-check for enable (the loop already
      // re-calls findBtn each tick), (b) cap fast on a genuinely stuck module, and (c) trace honestly.
      const onSmartApply_fs = /(^|\.)smartapply\.indeed\.com$/i.test(location.hostname);
      const loadingAdvance = findLoadingAdvanceButton(root || document);
      // The fast-skip is an EASY-APPLY-ONLY optimization: when the user only wants Easy Apply,
      // a positively-external LinkedIn posting has nothing to drive, so skip it in ~0s. But in
      // BOTH mode (allowExternal — easyApplyOnly OFF) we WANT to apply to externals: don't
      // fast-skip; let findOpenBranchButton's external-opener path drive the offsite handoff
      // (and if no clickable external control is found, fall through to the retriable path).
      const extVerdict = (opening && onLI_fs && !allowExternal)
        ? detectLinkedInExternalPosting({
            onLinkedIn: true,
            onApplyRoute: onApplyPage,
            hasEasyApplyOpener: !!findEasyApplyButton(),
            haveForm,
            offsiteApplyAnchor: linkedInOffsiteApplyAnchorPresent(),
            externalApplyLabel: externalApplyLabelPresent(),
            managedOffLinkedIn: responsesManagedOffLinkedInPresent(),
          })
        : { external: false, signal: null };
      if (extVerdict.external) {
        vlog('button', `fast-skip: external LinkedIn posting (${extVerdict.signal}) — no Easy Apply to open; skipping in ~0s instead of waiting the hydration cap`);
        logLine('warn', `external posting (${extVerdict.signal}) — no Easy Apply on this job; skipping fast`);
        S.routeState = 'external_same_tab';   // honest route on the terminal result/trace (not 'unknown')
        signalHydrated();   // release any held front-until-hydrated; we are NOT waiting
        setStatus('External posting — no Easy Apply; skipped');
        report({
          state: 'skipped',
          lastError: 'external posting — no Easy Apply on this job (skipped, easy-apply-only)',
          applyRoute: 'external',
          routeState: 'external_same_tab',
          transcriptAppend: { kind: 'recovery', note: `fast-skip external LinkedIn posting [${extVerdict.signal}] — no Easy Apply, not re-dispatched` },
        });
        finalState = 'skipped';
        break;
      }
      // NON-FOCUS-STEALING: do NOT front the window preemptively. DIRECT live observation
      // proved the Easy Apply form mounts + works on a HIDDEN, UNFOCUSED tab, so on the normal
      // path we simply WAIT for it to hydrate (a hidden on-display tab is un-throttled enough).
      // Fronting is now a RARE last-resort safety net: only after an initial wait fails do we
      // escalate to front-until-hydrated (below). This avoids stealing the foreground on every
      // apply (the v11.26.0 disruption) while still rescuing a genuinely occluded+stuck tab.
      // Restriction is checked FIRST: the restriction interstitial also renders "Sign in" and
      // "Join now" in its header, so the signed-out detector fires on it too and would report the
      // wrong — and far less serious — cause.
      if (reportIfRestricted('before the hydrate wait')) { finalState = 'failed'; break; }
      // Before burning 30s waiting for a control that can never appear: are we simply signed out?
      if (reportIfSignedOut('before the hydrate wait')) { finalState = 'failed'; break; }
      logLine('warn', opening
        ? (wasHidden ? 'apply tab is hidden — waiting for the application to hydrate' : 'application not open yet — waiting for it to hydrate')
        : 'no advance button — waiting for the page (or you)');
      let found = null;
      const findBtn = () => haveForm
        ? (findPackAdvance(root) || findAdvanceButton(root, { allowOpen: false }) || findPackSubmitBroad(root))
        : (onApplyPage
            ? findAdvanceButton(root || document, { allowOpen: false })
            : findOpenBranchButton(document));
      // 1) Initial hydration wait WITHOUT fronting. Hidden tabs get fewer timer ticks, so give
      //    them more real wall-clock; a visible tab settles fast.
      // LIVE-DATA TUNING (2026-06-20): on the OPEN branch (job-view, looking for the Easy-Apply
      // OPENER) a VISIBLE+FOCUSED tab hydrates the opener in <2s when it exists — direct
      // observation showed working jobs find "Easy Apply to this job" on the very first tick.
      // So a 20s wait there is pure waste on the JobSpy EXTERNAL flood (most LinkedIn jobs have
      // NO Easy Apply): hundreds of postings each burned ~20s before being re-dispatched. Cut the
      // visible-tab OPENER wait to ~8s (16×500ms) — long enough to absorb a slow paint, short
      // enough to blaze through externals. KEEP the long wait for: hidden/throttled tabs (timers
      // throttled → opener hydrates late) and for the /apply/ page-LOAD + in-form-advance cases
      // (a full page must navigate + render, which genuinely takes longer).
      // Smartapply fast-fail: once the module was already seen (everHadForm) and a loading Continue
      // is present but never re-enables, the step is genuinely stuck — cap at ~11s (22×500) instead
      // of 30s so the forced-serial worker isn't burned. ~11s comfortably exceeds a normal 1-3s
      // smartapply inter-step hydration, and the loop below re-calls findBtn() every tick, so the
      // REAL Continue is clicked the instant it enables — the cap only bites a truly stuck module.
      // Triple-gated on onSmartApply_fs, so every LinkedIn initialTries path is byte-unchanged.
      const initialTries = opening ? (wasHidden ? 40 : 16)
        : (onSmartApply_fs && everHadForm && loadingAdvance ? 22 : 60);   // ~11s stuck-smartapply / ~30s /apply/-load
      // [TRACE 7] HYDRATION — entering the wait, with the occlusion/visibility cause + cap.
      const hydrateStart = Date.now();
      if (loadingAdvance) vlog('hydrate', `advance button present but loading ("${redactLabel(btnText(loadingAdvance))}") — waiting for it to enable`);
      vlog('hydrate', `wait begin opening=${opening} applyPageLoading=${applyPageLoading} hidden=${wasHidden}${onSmartApply_fs ? ' smartapply' : ''} cap=${initialTries * 500}ms`);
      for (let i = 0; i < initialTries && !S.cancelled; i++) {
        if ((opening || applyPageLoading) && i % 4 === 0) { try { window.scrollTo(0, 600); window.scrollTo(0, 0); } catch {} }
        await sleep(500);
        found = findBtn();
        if (found) { signalHydrated(); break; }
      }
      if (found) vlog('hydrate', `hydrated after ${Date.now() - hydrateStart}ms (initial wait)`);
      else vlog('hydrate', `initial wait EXHAUSTED (${Date.now() - hydrateStart}ms) — no control yet${(opening || applyPageLoading) && wasHidden ? ' → escalating to front-until-hydrate' : ''}`);
      // 2) LAST-RESORT safety net: still nothing AND the tab is genuinely hidden+stuck either on
      //    the OPEN path (form never opened) OR on the /apply/ page-LOAD path (Fix 3: navigated to
      //    the full-page /apply/ form but it hasn't hydrated on this throttled tab). Now (and only
      //    now) front the window so a truly occluded tab gets visible time, then wait the fronted
      //    cap. Rare by construction — never fires on the normal, successfully-hydrating path.
      //    Bounded: requestFrontUntilHydrated is a no-op once already requested, so /apply/-load
      //    and opener-stall can't strobe the window. Gated by frontToHydrate (default ON).
      if (!found && (opening || applyPageLoading) && wasHidden) {
        if (frontToHydrate) {
          logLine('warn', applyPageLoading
            ? 'apply /apply/ page not hydrated on this throttled tab — fronting its window to let it load'
            : 'apply tab still not hydrated after waiting — fronting its window as a last resort');
          requestFrontUntilHydrated();
        } else {
          send({ type: 'jat11.nudge-apply-window' });
        }
        const frontedCap = 28;   // ~14s of 500ms ticks — comfortably past the SW front hard-cap
        const frontStart = Date.now();
        vlog('hydrate', `front-until-hydrate requested (frontToHydrate=${frontToHydrate}) cap=${frontedCap * 500}ms`);
        for (let i = 0; i < frontedCap && !S.cancelled; i++) {
          if (i % 4 === 0) { try { window.scrollTo(0, 600); window.scrollTo(0, 0); } catch {} }
          await sleep(500);
          found = findBtn();
          if (found) { signalHydrated(); break; }
        }
        vlog('hydrate', found ? `hydrated after fronting (${Date.now() - frontStart}ms)` : `FAST-FAIL CAP HIT — still not hydrated after fronting (${Date.now() - frontStart}ms)`);
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
        // HONEST TERMINAL for the no-Easy-Apply flood (LIVE-DATA, 2026-06-20): the dominant
        // current-build waste was LinkedIn JOB-VIEW postings where the form never opened on a
        // VISIBLE+FOCUSED (un-throttled) tab and NO opener appeared after the settle wait, yet
        // externalApplyPresent()/loginApplyPresent() did NOT fire (LinkedIn's external "Apply"
        // button isn't always matched by those positive signals). Those fell here and were
        // marked failed-RETRIABLE ("did not hydrate") → re-dispatched every run, each burning
        // the full wait, NEVER succeeding, and surfacing as the mystery "skipped without a
        // diagnostic". On a tab that was NEVER hidden/occluded, Chrome did NOT throttle it, so a
        // working Easy Apply opener WOULD have hydrated within the wait (observed: <2s when it
        // exists). Therefore "no opener + no form after the visible wait" is RELIABLE evidence of
        // NO Easy Apply on this posting (external/company-site). TERMINAL-SKIP it with a concrete
        // diagnostic + an honest external route so (a) the pool stops re-burning it, (b) the
        // server classifier reads it as terminal (not transient_page), and (c) the user learns
        // WHY. CONSERVATIVE: fires ONLY when opening && !wasHidden && the form NEVER opened — a
        // hidden/throttled tab (where late hydration is real) still fails RETRIABLY below.
        // 2026-07-20 CORRECTION to the premise above. That reasoning assumed a visible tab is
        // always hydrated within the settle wait ("observed: <2s when it exists"). Measured live
        // on the rebuilt LinkedIn job page, that is NO LONGER TRUE: on a visible, focused,
        // un-throttled tab the job body was still not rendered at SEVEN seconds, and a trusted
        // click then opened a perfectly normal Easy Apply modal. Because this branch is TERMINAL
        // and non-retriable, every such posting was permanently discarded as "external" — 24 of
        // them after the native-<dialog> fix alone, each a REAL Easy Apply job thrown away.
        // So only conclude "no Easy Apply" once the page has actually rendered its job body;
        // otherwise fall through to the RETRIABLE path below (which is attempt-capped, so the
        // worst case is a few bounded retries instead of silently losing the job).
        if (opening && !wasHidden && !everHadForm && !jobPageHydrated()) {
          vlog('button', 'no opener yet, but the job page has NOT rendered its body — not concluding "no Easy Apply"; retrying later');
          logLine('warn', 'page had not finished loading — will retry rather than write this off as external');
        } else if (opening && !wasHidden && !everHadForm) {
          vlog('button', 'no Easy-Apply opener after the visible settle wait (un-throttled tab) → terminal-skip: this posting has no Easy Apply');
          logLine('warn', 'no Easy Apply on this posting — no apply control appeared on a visible tab; skipping (not retried)');
          S.routeState = 'external_same_tab';
          signalHydrated();
          setStatus('No Easy Apply on this posting — skipped');
          const st = allowExternal ? 'failed' : 'skipped';
          report({
            state: st,
            lastError: allowExternal
              ? 'no Easy Apply opener and no drivable form appeared (visible tab) — inspect'
              : 'no Easy Apply on this posting — apply is on the company site (not auto-applicable)',
            applyRoute: 'external',
            routeState: 'external_same_tab',
            transcriptAppend: { kind: 'recovery', note: 'no opener + no form after visible settle wait → terminal external/no-EA skip (not re-dispatched)' },
          });
          finalState = st;
          break;
        }
        // Otherwise it's a transient non-open (late/throttled hydration, verification
        // gate) — fail RETRIABLY so retryStaleQueue re-attempts it later (capped). This now
        // covers: hidden/occluded tabs (opener may hydrate late once visible) and the
        // /apply/-advance case (!opening: a form WAS open and we lost the advance button).
        // THE path a logged-out LinkedIn job page actually exits through. Checking here is what
        // makes the latch fire at all — "no advance button found" is the symptom, being signed out
        // is the cause, and reporting the symptom sends the task round the retry loop forever.
        if (reportIfRestricted('terminal no-advance')) { finalState = 'failed'; break; }
        if (reportIfSignedOut('terminal no-advance')) { finalState = 'failed'; break; }
        report({
          state: 'failed',
          lastError: opening
            ? (wasHidden
                ? 'apply window was occluded → Chrome throttled the tab so LinkedIn never hydrated — keep its window uncovered (or enable bring-to-front) — will retry'
                : 'Easy-Apply form did not hydrate — will retry')
            : (onSmartApply_fs && everHadForm
                ? 'smartapply step did not advance — module stuck (Continue never enabled); will retry'
                : 'no advance button found — will retry'),
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
    // NOTE: do NOT gate this on everHadForm. It tracks whether the form DETECTOR latched, not
    // whether a form exists. Indeed's smartapply submits from a page reporting
    // `haveForm=false root=none everHadForm=false` and is nonetheless a real, verifiable submit
    // ("Submit your application", formGrounded=true, new-confirmation-node). Gating on it
    // suppressed that genuine submit and broke the indeed-cloudflare fixture. The opener/submit
    // distinction has to come from what the button SAYS, which is where it is now handled.
    const isFinal = packSubmit || isFinalSubmit(btn);
    // [TRACE 3] isFinalSubmit decision — is this the terminal submit, and via which recognizer.
    vlog('button', `isFinalSubmit("${redactLabel(btnText(btn))}")=${isFinal}${isFinal ? (packSubmit ? ' [ats-pack hint]' : ' [generic recognizer]') : ''} mode=${mode}`);
    if (isFinal) {
      // SAFETY NET: never submit a job that still has unanswered questions.
      if (parked.length) { reportParked('final-submit'); break; }
      // SAFETY NET: never CLAIM a submit the browser is about to refuse. Park the fields it
      // is refusing on — with their real question text — so they become answerable and learned,
      // instead of clicking into a no-op and asking Pierre to confirm a phantom submission.
      const blockers = nativeValidationBlockers(btn);
      if (blockers.length) {
        vlog('submit', `BLOCKED by native validation — ${blockers.length} required field(s) still invalid; not clicking`);
        for (const b of blockers) park(b.label, 'text', null, b.message || 'required — the form will not submit until this is answered');
        reportParked('native-validation');
        break;
      }
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
    // Snapshot the VERIFIED apply surface (the field-bearing `dialog`, never a loose
    // fallback) before clicking submit, so detecting it close can't be tricked by
    // an unrelated modal (cookie/consent) closing. For a recognised account-less
    // pack the snapshot scope is the adapter form root (no LinkedIn dialog). For the
    // NEW full-page Easy Apply flow there is no modal — the verified apply-page root is
    // the tight scope (its disappearance / the page text becoming "application sent"
    // after the click is the confirmation), so use it as the submit scope too.
    const submitDialog = isFinal ? (dialog || applyPageRoot || (driveablePack ? root : null)) : null;

    // Re-verify the button is still clickable right before acting — the DOM may
    // have changed since findAdvanceButton() above (validation re-render, etc.).
    let clickBtn = btn;
    if (clickBtn.disabled || !isProbablyVisible(clickBtn) || !document.contains(clickBtn)) {
      clickBtn = haveForm
        ? (findPackAdvance(root) || findAdvanceButton(root, { allowOpen: false }) || findPackSubmitBroad(root))
        : (onApplyPage
            ? findAdvanceButton(root || document, { allowOpen: false })
            : findOpenBranchButton(document));
      if (!clickBtn) { logLine('warn', 'advance button became invalid before click — re-scanning'); continue; }
    }
    const label = btnText(clickBtn).slice(0, 30);
    const controlRoute = !haveForm ? classifyApplyControl(clickBtn) : { state: S.routeState || 'unknown' };
    // Indeed-native (smartapply) is Indeed's easy-apply equivalent: it navigates in-tab to the
    // Indeed-hosted smartapply flow on a DIFFERENT host, so it rides the SAME cross-host handoff
    // machinery as an external click — but it is ALLOWED even in easy-apply-only mode (it is NOT a
    // company-site bounce) and is stamped 'easy-apply', not 'external'.
    const indeedNative = !haveForm && controlRoute.state === 'indeed_native';
    const externalClick = !haveForm && ((allowExternal && controlRoute.state.startsWith('external_')) || indeedNative);
    if (!haveForm && controlRoute.state === 'linkedin_easy_apply_modal') S.routeState = 'linkedin_easy_apply_modal';
    // FAST-SKIP an EXTERNAL Indeed posting in easy-apply-only mode (mirror of the LinkedIn fast-skip).
    // On an Indeed job whose only apply control is an off-Indeed "Apply on company site" link (NOT the
    // Indeed-Apply widget → indeed_native), there is nothing in-board to drive. Without this the
    // executor clicked the external opener, its target=_blank tab was blocked, and it looped to a
    // RETRIABLE failure (re-dispatched forever) — pure waste. Skip honestly in ~0s. In BOTH mode
    // (allowExternal) externalClick drives the company handoff instead, so this never fires there.
    if (!haveForm && !allowExternal && !indeedNative && controlRoute.state.startsWith('external_')
        && /(^|\.)indeed\.[a-z]+(\.[a-z]+)?$/i.test(location.hostname)) {
      vlog('button', 'fast-skip: external Indeed posting (off-Indeed apply, no Indeed-Apply widget) — skipping in ~0s');
      logLine('warn', 'external posting — no Indeed-Apply on this job; skipping fast (easy-apply-only)');
      S.routeState = 'external_same_tab';
      signalHydrated();
      setStatus('External posting — no Indeed-Apply; skipped');
      report({
        state: 'skipped',
        lastError: 'external posting — no Indeed-Apply on this job (skipped, easy-apply-only)',
        applyRoute: 'external',
        routeState: 'external_same_tab',
        transcriptAppend: { kind: 'recovery', note: 'fast-skip external Indeed posting — no Indeed-Apply, not re-dispatched' },
      });
      finalState = 'skipped';
      break;
    }
    const pageAction = !haveForm
      ? recoveryFingerprint({ hostname: location.hostname, pathname: location.pathname, label, stage: externalClick ? 'external-opener' : 'apply-opener' })
      : '';
    // ---- BREAKER RESET ON REAL NAVIGATION (external in-tab handoff fix) ----
    // The duplicate-page-action breaker (lastPageAction) protects against re-clicking the
    // SAME opener on the SAME page (the "opener doesn't transfer" loop). But when an external
    // "Apply (opens in new tab)" navigates IN-TAB to the company ATS, the company landing page
    // commonly has its OWN "Apply"/"Apply on company site" button — and that first, legitimate,
    // DIFFERENT-page click must not be mistaken for a repeat. If the live page URL differs from
    // the one at which lastPageAction was armed, a real navigation happened → clear the breaker.
    // Same page (same host+path) → no reset, so the genuine in-page opener loop is still caught.
    if (shouldResetPageActionBreaker({ lastActionUrl: lastPageActionUrl, currentUrl: location.href, hasPending: !!lastPageAction })) {
      logLine('ok', 'page navigated since the last page-level action — resetting the duplicate-action breaker for the new page');
      lastPageAction = ''; lastPageActionUrl = '';
    }
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
        lastPageAction = null; lastPageActionUrl = '';   // the interstitial advance is real progress; allow the next opener/advance
        continue;
      }
      // EMBEDDED ATS: a company career site (pinterestcareers.com, app.careerpuck.com, …)
      // often hosts the real application in a CROSS-ORIGIN iframe (job-boards.greenhouse.io,
      // lever, ashby…), while its own "Apply Now" is just an anchor that scrolls to it. The
      // top frame therefore never sees a form and the opener never "transfers" — which is
      // why this reported the misleading "did not transfer" instead of applying. The form is
      // right there, just one origin away: navigate to the iframe's own URL so the ATS page
      // becomes top-level and the existing site pack drives it normally.
      const atsFrame = findEmbeddedAtsFrame();
      if (atsFrame) {
        // Report the TRUTH instead of "did not transfer": nothing was ever going to transfer,
        // the form is one origin away and the top frame cannot drive it.
        // NOTE: navigating the tab to atsFrame.src was tried and is NOT safe — a cross-origin
        // navigation tears down the content script, so the executor kills its own run mid-task
        // (harness: "message channel closed before a response was received"). Driving these
        // needs the task to survive navigation, which is a separate change.
        logLine('warn', `application is embedded from ${atsFrame.host} — not auto-applicable from this page`);
        report({
          state: 'skipped',
          lastError: `application form is embedded from ${atsFrame.host} — open that page directly to apply`,
          applyRoute: 'external',
          transcriptAppend: { kind: 'recovery', note: `embedded ATS iframe detected → ${atsFrame.host}`, fingerprint: pageAction },
        });
        finalState = 'skipped';
        break;
      }
      logLine('warn', `same page-level action repeated — stopping before another "${label}" click`);
      report({ state: 'failed', lastError: `repeated page-level action did not transfer: ${label}`, transcriptAppend: { kind: 'recovery', note: 'duplicate opener blocked', fingerprint: pageAction } });
      finalState = 'failed';
      break;
    }
    if (pageAction) { lastPageAction = pageAction; lastPageActionUrl = location.href; }
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
      logLine('ok', indeedNative ? 'opening Indeed-native apply (smartapply) — driving in-tab' : 'opening external/company apply route');
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
    // [TRACE 9] SUBMIT — the pre-click success-truth baseline (text already looks like
    // success? + confirmation-node signature count) so the post-click diff is auditable.
    if (submitBaseline) vlog('submit', `baseline url=${pagePathOf()} successTextAlready=${submitBaseline.successText} nodeSig=${submitBaseline.nodeSig?.size ?? 0} formGrounded=${formGrounded}`);
    const submitClickAt = Date.now();
    // POPUP-BLOCKED-HANDOFF FIX: clear any stale captured URL before clicking. The SW's
    // MAIN-world hook (installed at arm) records the opener's window.open()/target=_blank URL
    // onto data-jat-exturl when our synthetic click fires the page's handler.
    if (externalClick && handoffToken) { try { document.documentElement.removeAttribute('data-jat-exturl'); } catch {} }
    syntheticClick(clickBtn);
    if (externalClick && handoffToken) {
      setStatus('Transferring control to the company application…');
      // The opener usually opens the company site via window.open(), which Chrome BLOCKS under
      // our untrusted synthetic click — so no tab opens by itself ("apply handoff did not
      // attach"). Recover the intended URL (from the MAIN-world hook, or the control's own
      // off-site href) and have the SW open it directly; the existing handoff then drives it.
      // Rely ONLY on the hook's capture (window.open URL, or a target=_blank anchor href). We do
      // NOT fall back to the control's own href: a same-tab opener (plain anchor / location.assign)
      // has an href too, and opening it directly would race a competing tab against the in-tab
      // navigation the SW already handles (EXT-2). Poll briefly in case the open() is async.
      let exturl = '';
      for (let i = 0; i < 12 && !exturl; i++) {
        try { exturl = document.documentElement.getAttribute('data-jat-exturl') || ''; } catch {}
        if (!exturl) await sleep(150);
      }
      if (exturl) {
        logLine('ok', 'recovered company-site URL from the opener — opening it directly');
        try { await send({ type: 'jat11.external-handoff-open', token: handoffToken, url: exturl }); } catch {}
        try { document.documentElement.removeAttribute('data-jat-exturl'); } catch {}
      }
      const handoff = await handoffPromise;
      if (handoff?.captured) {
        const childResult = handoff.result || null;
        const childState = ['done', 'awaiting_review', 'awaiting_input', 'parked', 'failed', 'skipped'].includes(childResult?.state)
          ? childResult.state : 'failed';
        const childError = childResult?.error || childResult?.lastError || handoff?.error || null;
        // No terminal external state without an honest diagnostic. The db terminal-integrity
        // guard synthesizes "…without a diagnostic" when lastError is missing on failed/skipped;
        // set a concrete reason at the SOURCE for every external-child terminal so the user
        // always learns WHY the company-site handoff didn't complete.
        const childTerminalError = childError || (
          childState === 'skipped'
            ? 'company site application could not be completed (handoff returned skipped) — needs you'
            : childState === 'failed'
              ? 'company site Apply did not open a drivable form (external handoff failed) — needs you'
              : null);
        report({
          state: childState,
          lastError: childTerminalError,
          parkReason: childResult?.parkReason,
          pendingQuestions: childResult?.pendingQuestions,
          applyRoute: indeedNative ? 'easy-apply' : 'external', routeState: controlRoute.state,
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
    // [TRACE 4] ADVANCE RESULT — did the page change after the click? (domHash diff +
    // url move + the next page indicator). The no-change branch below traces the rescan.
    try {
      const afterPath = pagePathOf();
      const prog = pageProgressIndicator();
      vlog('advance', `clicked "${redactLabel(label)}" → changed=${changed}`
        + (beforeClickUrl !== location.href ? ` url:${'navigated'}` : ' url:same')
        + (afterPath ? ` path=${afterPath}` : '')
        + (prog ? ` pages=${prog}` : ''));
    } catch {}
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
        // EXT-1: a real transition to the company site happened. The opener fingerprint we
        // just armed (lastPageAction) belongs to the PRIOR LinkedIn page; the company
        // landing page very often has its OWN legitimate "Apply"/"Apply on company site"
        // button. If we leave the breaker armed, that first genuine click is mistaken for a
        // repeat and the run dies with "repeated page-level action did not transfer". The
        // page transitioned, so the prior opener is stale — clear the breaker and reset the
        // external no-progress + stall counters so the company site starts with a clean slate.
        lastPageAction = ''; lastPageActionUrl = '';
        extRepeat = 0; extLastLabel = ''; extLastUrl = '';
        noChange = 0;
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
      // ---- OPENING vs MID-FLOW routing (live-bug fix) ----
      // Decide ONCE which no-change handler owns this click:
      //   • OPENING  (no form has opened this run) → the opener-stall front+retry path.
      //   • MID-FLOW (a form has opened this run — Next/Review/Submit) → the advance-blocked
      //     answer-rescan. The opener-stall front/duplicate-opener logic must NOT run here
      //     (it was pre-empting the rescan and burning the retry on a "duplicate opener
      //     blocked" failure — the Open Systems mid-flow Review bug). everHadForm keys the
      //     mid-flow case so a brief React drop of the dialog after Review can't mis-route it.
      //   • EXTERNAL click → neither (its own handoff + no-progress cap handled above).
      const noChangeRoute = classifyNoChangeRoute({ haveForm, everHadForm, isExternalClick: externalClick });
      // [TRACE 4] no-change route decision: opening (opener stall) vs mid-flow (advance-blocked rescan).
      vlog('advance', `blocked — re-scanning; route=${noChangeRoute.route} (haveForm=${haveForm} everHadForm=${everHadForm} ext=${externalClick})`);
      // ---- F2 KEYSTONE (OPENING ONLY): opener clicked but the modal never mounted → FRONT + RETRY ----
      // We clicked the Easy-Apply OPENER (no form open yet) and nothing changed AND no apply
      // modal mounted. The dominant cause on the regressed build: the apply window is occluded
      // → Chrome throttled its JS → the modal can't mount. Before this counts toward the
      // duplicate-opener breaker / stall (which would FAIL the task without ever fronting the
      // window), ask the SW to front+un-throttle the apply window and WAIT for the modal to
      // hydrate. Only ONE fronted retry; if it STILL doesn't mount, fall through to the normal
      // stall/breaker path so a genuinely dead opener still fails. Gated to the OPENING route so
      // a mid-flow advance click goes straight to the answer-rescan below.
      if (noChangeRoute.route === 'opener-stall') {
        const modalMounted = !!findApplyDialog();
        const stallDecision = shouldFrontOnOpenerStall({
          haveForm,
          isExternalClick: externalClick,
          changed,
          modalMounted,
          alreadyFronted: openerStallFronted,
        });
        if (stallDecision.front) {
          openerStallFronted = true;
          logLine('warn', 'apply opener clicked but the modal did not mount — fronting the apply window and waiting for it to hydrate');
          report({ transcriptAppend: { kind: 'recovery', note: 'opener clicked, no mount — front-until-hydrated retry', fingerprint: pageAction } });
          requestFrontUntilHydrated();
          // Give the now-foreground (un-throttled) tab real wall-clock time to mount the modal.
          // ~14s of 500ms ticks — comfortably past the SW's front hard-cap. Nudge the lazy
          // renderer with a scroll like the opener-hydration path does.
          let mounted = false;
          for (let i = 0; i < 28 && !S.cancelled; i++) {
            if (i % 4 === 0) { try { window.scrollTo(0, 600); window.scrollTo(0, 0); } catch {} }
            await sleep(500);
            if (findApplyDialog() || findPackAdvance(root) || (findEasyApplyButton() && everHadForm)) { mounted = true; break; }
          }
          if (mounted) {
            signalHydrated();
            logLine('ok', 'apply modal mounted after fronting the window — continuing');
            // Real progress: clear the stall/breaker counters so the next pass drives the form.
            noChange = 0; lastPageAction = null; lastPageActionUrl = '';
            continue;
          }
          // Fronted retry still produced no modal — release the front and fall through to the
          // honest stall/breaker handling below (it will fail RETRIABLY, classified as transient).
          signalHydrated();
          logLine('warn', 'apply modal still did not mount after fronting — treating as a genuine stall');
        }
      }
      // ---- FIX 1 KEYSTONE: advance BLOCKED on a form → re-scan, ANSWER, RETRY (before give-up) ----
      // The dominant remaining cap: a REQUIRED screening field (Yes/No radio, dropdown, text) was
      // left unanswered on this page (the "Additional Questions" page in the new full-page flow),
      // so LinkedIn refuses to advance and the page doesn't change. The OLD behavior just re-clicked
      // the same advance button and gave up "stuck". Instead, when we HAVE a form root and haven't
      // exhausted the bounded recovery budget, re-scan THIS page for unanswered required fields and
      // ANSWER them (profile/qa → AI → grounded eligibility default), then RETRY the advance with
      // the normal change-detection wait. Unanswerable required fields are PARKED honestly. Only if
      // nothing could be answered AND nothing is parkable do we fall through to the genuine stall.
      // Excludes the no-form / external / final-auto-submit cases (handled elsewhere); bounded so a
      // genuinely dead button still fails.
      if (haveForm && !externalClick && blockedRescueTries < 3) {
        blockedRescueTries++;
        logLine('warn', `advance blocked — re-scanning this page for an unanswered required field (try ${blockedRescueTries})`);
        await sleep(600);   // let LinkedIn render its inline "required" markers / validation state
        const rescue = await answerBlockingRequiredFields(root);
        // [TRACE 4] what the advance-blocked rescan found/answered.
        vlog('advance', `rescan: sawRequired=${rescue.sawRequired} filled=${rescue.filled} parked=${rescue.parkedCount}`);
        if (rescue.parkedCount && parked.length) {
          // A required field we genuinely can't answer is blocking → park honestly (replaces the
          // old "stuck — page stopped advancing" loop for the unanswerable case). NEVER submit
          // past an unanswered required question (R1 preserved).
          logLine('warn', `blocked by an unanswerable required question — parking for your input`);
          reportParked('advance-blocked');
          break;
        }
        if (rescue.filled) {
          // We answered the blocking field(s). Retry the advance and re-judge with a fresh wait.
          report({ transcriptAppend: { kind: 'recovery', note: `answered ${rescue.filled} blocking required field(s); retrying advance`, fingerprint: pageAction } });
          const retryBtn = (clickBtn && document.contains(clickBtn) && !clickBtn.disabled && isProbablyVisible(clickBtn))
            ? clickBtn
            : (findPackAdvance(root) || findAdvanceButton(root, { allowOpen: false }));
          if (retryBtn) {
            const retryHash = domHash();
            logLine('ok', `retrying "${btnText(retryBtn).slice(0, 30)}" after answering the required field(s)`);
            syntheticClick(retryBtn);
            const retried = await waitForChange(retryHash);
            if (retried) {
              // Real progress — clear stall/breaker counters and drive the next page.
              noChange = 0; lastPageAction = ''; lastPageActionUrl = '';
              continue;
            }
          }
          // Filled but STILL didn't advance: don't count this rescue toward give-up yet — loop
          // around so the next pass re-scans (a multi-required page answers one field at a time).
          continue;
        }
        // Nothing answerable here this pass → fall through to the normal stall handling below.
      }
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
        // AI RESCUE (full-page, profile+memory) — runs FIRST, before we give up or park, so the AI
        // gets a shot at the exact required controls the per-field ladder couldn't resolve, INCLUDING
        // ones it parked this pass. The whole page (fields the scanner skipped, buttons, text) goes to
        // the configured provider; it returns the next safe actions (never a final-submit). On progress
        // we clear the pending parks (the AI just answered them) and retry the advance; if still
        // blocked, the next pass honestly re-detects + re-parks. Bounded per task.
        if (!S.cancelled) {
          const rescued = await tryAiRescue('page stopped advancing — a required control the deterministic ladder could not satisfy');
          if (rescued === 'progressed') { logLine('ok', 'AI rescue made progress — retrying advance'); parked.length = 0; noChange = 0; continue; }
          if (rescued === 'parked') { reportParked('stalled'); break; }
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
        // [DIAGNOSTIC] Stuck with NO detected blocker/field (parked + resumeBlocked already handled
        // above) — the page won't advance but our scan found nothing to answer. On Indeed smartapply
        // this is the dominant convertible loss: a required control the scanner can't see. Dump a
        // compact inventory of EVERY control on the form so the next run reveals exactly what was
        // missed (type, required, value-state, visibility, size) + iframe count (fields may be nested).
        try {
          const scope = root || document;
          const ctrls = qsa('input:not([type="hidden"]), select, textarea, [role="combobox"], [role="radiogroup"], [role="radio"], [role="checkbox"], [contenteditable="true"]', scope);
          const inv = ctrls.slice(0, 30).map((el) => {
            const tag = (el.tagName || '').toLowerCase();
            const type = el.getAttribute?.('type') || el.getAttribute?.('role') || '';
            let lbl = '';
            try { lbl = compactText(el.getAttribute?.('aria-label') || el.closest?.('label, fieldset, [class*="form"], [data-testid]')?.querySelector?.('label, legend')?.textContent || el.name || '').slice(0, 36); } catch {}
            const req = (el.required || el.getAttribute?.('aria-required') === 'true') ? '!' : '';
            const state = el.value ? 'val' : (el.checked ? 'chk' : (el.getAttribute?.('aria-checked') === 'true' ? 'chk' : '-'));
            const vis = isProbablyVisible(el) ? 'v' : 'h';
            let sz = ''; try { const b = el.getBoundingClientRect(); sz = `${Math.round(b.width)}x${Math.round(b.height)}`; } catch {}
            return `${tag}/${type}${req} "${redactLabel(lbl)}" ${state} ${vis} ${sz}`;
          });
          let iframes = 0; try { iframes = qsa('iframe', scope).length; } catch {}
          vlog('stuck-dump', `path=${pagePathOf()} controls=${ctrls.length} iframes=${iframes} :: ${inv.join(' | ')}`);
        } catch {}
        // DIAG (smartapply/React prompt recovery): if we're stuck and there are radio/select groups
        // whose QUESTION prompt we could NOT resolve, dump a VALUE-FREE structural skeleton of each
        // (tag/class/role/aria-labelledby + own text only — never input values) so the next live run
        // reveals the real markup to tune the walk-up. Never-debug-blindly safety net: the fixtures
        // are inferred from the symptom; this confirms against reality.
        try {
          const dscope = root || document;
          const seenG = new Set();
          const skel = [];
          for (const el of qsa('input[type="radio"], select', dscope)) {
            if (!isFillable(el) || isSiteChromeInput(el)) continue;
            const gk = el.type === 'radio' ? `r:${el.name || ''}` : `s:${el.id || el.name || ''}`;
            if (seenG.has(gk)) continue;
            seenG.add(gk);
            const lbl = el.type === 'radio' ? radioGroupLabel(el) : selectGroupLabel(el);
            if (lbl && lbl.length >= 4) continue;   // prompt resolved fine — not a problem case
            const chain = [];
            let n = el, d = 0;
            while (n && d++ < 5) {
              const ownText = Array.from(n.childNodes || []).filter((c) => c.nodeType === 3).map((c) => c.textContent).join(' ').replace(/\s+/g, ' ').trim().slice(0, 50);
              chain.push({ tag: (n.tagName || '').toLowerCase(), cls: (n.getAttribute?.('class') || '').slice(0, 50), role: n.getAttribute?.('role') || undefined, lblby: n.getAttribute?.('aria-labelledby') || undefined, txt: ownText || undefined });
              n = n.parentElement;
            }
            skel.push({ g: gk, type: el.type || 'select', chain });
            if (skel.length >= 4) break;
          }
          if (skel.length) vlog('prompt-unresolved', `${skel.length} group(s) with no recoverable question prompt: ` + JSON.stringify(skel).slice(0, 1400));
        } catch {}
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
      // [TRACE 9] SUBMIT result — the settle outcome + evidence the evaluator weighed +
      // the after-snapshot diff (url move? new confirmation nodes? text became success?).
      try {
        const newNodeList = newConfirmationNodes(submitBaseline);
        const newNodeCount = newNodeList.length;
        vlog('submit', `settle=${how || 'none'} verified=${verdict.verified} reason=${verdict.reason}`
          + ` urlMoved=${beforeClickUrl !== location.href} successTextNow=${after?.successText} newNodes=${newNodeCount}`
          + ` formClosed=${formClosed}${packSignalReason ? ' ' + packSignalReason : ''} elapsed=${Date.now() - submitClickAt}ms`);
        // [TRACE 9b] WHY the evaluator/pack rejected. Every ATS awaiting_review on the laptop ends
        // as `static-success-text-unchanged` with newNodes>=1, and the counts alone cannot separate
        // "submitted, confirmation rendered outside the snapshot scope" from "never submitted".
        // These three facts do separate them, so capture them rather than guess:
        //   • what the appeared nodes actually SAY (and whether they were flagged confirmation)
        //   • whether the dialog-scoped `after` snapshot went stale/detached while the PAGE moved on
        //   • which baseline phrase made before.successText true (the thing disabling textBecameSuccess)
        // Diagnostic only — it changes no verdict.
        if (!verdict.verified && !formClosed && !packSignalReason) {
          const preview = newNodeList.slice(0, 3).map((n) => {
            const t = String(n?.text || '').replace(/\s+/g, ' ').trim();
            return `{conf=${n?.confirmation === true} len=${t.length} "${t.slice(0, 120)}"}`;
          }).join(' ');
          const dialogDetached = !!(submitDialog && !document.contains(submitDialog));
          const bodyNow = (document.body?.textContent || '').replace(/\s+/g, ' ').trim();
          const baseHit = SUCCESS_TEXT_RX.exec(String(submitBaseline?.text || ''));
          vlog('submit', `reject-detail nodes=${preview || '(none)'}`
            + ` dialogDetached=${dialogDetached} afterLen=${String(after?.text || '').length} bodyLen=${bodyNow.length}`
            + ` bodySuccessNow=${SUCCESS_TEXT_RX.test(bodyNow.slice(0, 5000))}`
            + ` baselinePhrase="${baseHit ? String(baseHit[0]).slice(0, 60) : '(none)'}"`);
        }
      } catch {}
      if (verdict.verified || formClosed || packSignalReason) {
        const reason = verdict.verified ? verdict.reason : (packSignalReason || 'apply-form-closed');
        // [TRACE 9] DONE — the evidence TYPE chosen for the verified submission.
        const evType = verdict.verified ? `verified:${verdict.reason}` : packSignalReason ? packSignalReason : 'apply-form-closed';
        vlog('submit', `→ DONE evidence=${evType}`);
        logLine('ok', `✓ application submitted (${reason})`);
        setStatus('✓ Application submitted');
        // Mark the JOB submitted too, so it's counted even if the passive capture
        // detector misses the banner (queuePatch only updates the task).
        if (job?.id) await send({ type: 'api-call', method: 'PATCH', path: '/jobs/' + encodeURIComponent(job.id), body: { status: 'submitted' } });
        // FIX 2: a VERIFIED done must carry NO contradictory failure text. Earlier retry
        // attempts on this row may have left a stale last_error ("submit was reported without
        // confirmation — please confirm") / park_reason / pendingQuestions — clear them at the
        // SOURCE so a real, verified submission never LOOKS unconfirmed. (db.js queuePatch also
        // nulls these defensively when a done carries trustworthy evidence.)
        report({ state: 'done', lastError: null, parkReason: null, pendingQuestions: [], submissionEvidence: { type: 'verified', reason, detail: how || reason, url: location.href, at: new Date().toISOString() }, transcriptAppend: { note: `submitted — verified (${reason})` } });
        finalState = 'done';
        finished = true;
        continue;
      }
      // Submit was clicked but NOT proven. Do not fabricate a done. Report
      // submitted-but-unverified so the user confirms it, rather than trusting it.
      // [TRACE 9] submit clicked but unproven → awaiting_review (never minted done).
      vlog('submit', `→ AWAITING_REVIEW (unverified: ${verdict.reason})`);
      logLine('warn', `submit not verified (${verdict.reason}) — flagged for your review`);
      setStatus('Submitted — awaiting your confirmation');
      report({ state: 'awaiting_review', lastError: `submit was clicked but could not be verified (${verdict.reason}) — please confirm`, transcriptAppend: { note: `submit unverified — ${verdict.reason}` } });
      finalState = 'awaiting_review';
      finished = true;
      continue;
    }
    if (changed) { lastPageAction = ''; lastPageActionUrl = ''; }
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

  // [TRACE 10] TERMINAL — the final state, lastError, route, steps + a one-line WHY.
  try {
    const term = finalState || (S.cancelled ? 'skipped' : 'unknown');
    const why = S.lastReport?.lastError
      || (parked.length ? `parked: ${parked.length} unanswered (${parked.map((p) => redactLabel(p.question)).slice(0, 3).join('; ')})` : null)
      || (S.cancelled ? 'cancelled by user/escape' : 'no terminal diagnostic');
    vlog('terminal', `state=${term} route=${S.routeState || 'unknown'} steps=${S.step} everHadForm=${everHadForm} formGrounded=${formGrounded} why=${String(why).slice(0, 120)}`);
  } catch {}

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
    // Echo the route so background.js's reconcile preserves it on a loop-exit skip whose
    // fire-and-forget report() was dropped (otherwise → "skipped without a diagnostic").
    applyRoute: S.lastReport?.applyRoute || null,
  };
}
