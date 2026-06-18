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
import { pageTextLooksLikeSuccess, urlLooksLikeSuccess } from './signals/success.js';
import { qsa, isProbablyVisible, compactText } from './lib/dom.js';
import { planReplay, resolveStepAnswer, paceDelay, classifyDivergence, resolveLocator } from './replay.js';

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
const ADVANCE_KEYWORDS = [
  /^submit application$/i, /^submit$/i, /^submit & continue$/i,
  /^review your application$/i, /^review$/i,
  /^next$/i, /^continue$/i, /^continue to/i, /^proceed/i,
  /^save and continue$/i, /^save & continue$/i,
  /^finish$/i, /^apply now$/i, /^apply$/i, /^easy apply/i,
  /^send application$/i, /^suivant$/i, /^continuer$/i, /^soumettre$/i, /^postuler$/i,
];
const FINAL_SUBMIT_RX = /^(submit( application)?|send( application)?|soumettre|envoyer( ma candidature)?|confirm and submit)$/i;
const APPLY_DIALOG_SEL = '.jobs-easy-apply-modal, [data-test-modal][role="dialog"], [role="dialog"][aria-modal="true"], .ia-Modal, [data-testid="smartapply-container"]';

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
  // Stamp the apply ROUTE on real outcome transitions so the dashboard chart can
  // split the "easy / in-page apply" route from "external": an apply form that
  // never opened in-page means the posting bounced us to an external ATS or a
  // verification wall we can't auto-drive. Skips (relevance) get no route.
  if (patch && ROUTE_STATES.has(patch.state) && patch.applyRoute === undefined) {
    patch.applyRoute = S.externalRoute ? 'external' : (S.everHadForm ? 'easy-apply' : 'external');
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

function findApplyDialog({ requireFields = false } = {}) {
  for (const d of qsa(APPLY_DIALOG_SEL)) {
    if (!isProbablyVisible(d)) continue;
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
  try {
    if (!el || !isProbablyVisible(el)) return false;
    const txt = compactText(el.getAttribute?.('aria-label') || el.textContent || el.value || '').toLowerCase();
    const href = el.href || el.getAttribute?.('href') || '';
    let externalHref = false;
    try { externalHref = !!href && new URL(href, location.href).hostname.replace(/^www\./, '') !== location.hostname.replace(/^www\./, ''); } catch {}
    if (/easy apply/.test(txt)) return false;
    return (EXTERNAL_APPLY_RX.test(txt) || /apply now|^apply$/.test(txt))
      && (externalHref || /company|external|employer|website|employeur|entreprise/.test(txt));
  } catch { return false; }
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
  S.task = task; S.context = context; S.everHadForm = false; S.externalRoute = false;
  S.lastSeenSig = '';

  const { job, profile, profileId, resume, harvested, aiConfidenceMin = 0.7 } = context || {};
  const mode = task.mode || 'review';
  const allowExternal = context?.easyApplyOnly === false;
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
      });
      sup.show();
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
        if (a && !a.refuse && a.confidence >= aiConfidenceMin && a.answer.trim()) aiVal = a.answer;
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
        await sleep(paceDelay(step.medianDelayMs));
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
      await sleep(paceDelay(0, undefined, { defaultBaseMs: 300 }));   // brief pre-click settle (paced)
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

  while (S.step < MAX_STEPS && !S.cancelled && !finished) {
    S.step++;
    await untilUnpaused();
    if (S.cancelled) break;

    // ---- hard stops ----
    const blocker = captchaOrLoginPresent();
    if (blocker) {
      logLine('warn', `${blocker} detected — handing back to you`);
      setStatus(blocker === 'captcha' ? 'CAPTCHA — your move' : 'Login required — your move');
      report({ state: 'failed', lastError: blocker === 'captcha' ? 'captcha — pass it in this browser, will retry' : 'login required — sign into the site in this browser, will retry' });
      finalState = 'failed';
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

    const formProbe = detectApplyForm();
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
    const dialog = findApplyDialog() || null;
    const root = dialog || formProbe?.form || null;
    const haveForm = !!root;
    if (haveForm) { everHadForm = true; S.everHadForm = true; signalHydrated(); reportSeen(root, 'apply form'); }

    // ---- fill from profile + learned answers ----
    setStatus(`Step ${S.step}: ${haveForm ? 'filling fields…' : 'opening the application…'}`);
    const suggestions = haveForm ? (await engine.scanFillable(root)).filter((s) => {
      if (NEVER_AUTOFILL_RX.test(s.label)) {
        logLine('warn', `left sensitive field for you: "${s.label.slice(0, 40)}"`);
        return false;
      }
      return true;
    }) : [];
    const filled = await engine.fill(suggestions);
    if (filled) logLine('ok', `filled ${filled} field(s) from profile/history`);

    // ---- resume upload ----
    const att = haveForm ? await tryAttachResume(root, resume) : { attempted: false, attached: 0 };
    if (resume?.id && att.attempted && att.attached === 0) {
      logLine('err', 'resume could not be attached — stopping for you to upload it');
      report({ state: 'failed', lastError: 'resume attachment failed (will retry)' });
      finalState = 'failed';
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
      if (!a || a.refuse || a.confidence < aiConfidenceMin || !a.answer.trim()) {
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
      ? findAdvanceButton(root)
      : (findEasyApplyButton() || (allowExternal ? findExternalApplyButton() : null) || findAdvanceButton(root));
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
          ? findAdvanceButton(root)
          : (findEasyApplyButton() || (allowExternal ? findExternalApplyButton() : null) || findAdvanceButton());
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
          // A genuinely EXTERNAL posting (apply on the company site) — JAT can't drive it.
          // SKIP it (terminal): retrying wastes the pool + drags the success rate, and the
          // tab is now an active/visible window so this detection is reliable.
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
      clickBtn = haveForm
        ? (findAdvanceButton(root) || findAdvanceButton())
        : (findEasyApplyButton() || (allowExternal ? findExternalApplyButton() : null) || findAdvanceButton());
      if (!clickBtn) { logLine('warn', 'advance button became invalid before click — re-scanning'); continue; }
    }
    const label = btnText(clickBtn).slice(0, 30);
    // ---- supervised gate [T4] ----  (no-op when not a supervised run)
    // Pause before advancing for the user's OK (Step mode) / honor a "Wrong" interrupt
    // (Run mode). A correction here rewrites the recipe + applies live before we advance.
    if (sup) {
      const verdict = await superviseGate({ root, label, text: `About to click "${label}"` });
      if (verdict === 'stopped') { break; }
    }
    logLine('ok', `clicking "${label}"`);
    if (!haveForm && allowExternal && looksExternalApplyButton(clickBtn)) {
      S.externalRoute = true;
      logLine('ok', 'opening external/company apply route');
    }
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
        report({ state: 'failed', lastError: why });
        finalState = 'failed';
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
      report({ state: 'failed', lastError: 'max steps reached — will retry' });
      finalState = 'failed';
    }
  }

  S.running = false;
  // Always release any held front-until-hydrated so focus is handed back even if the run
  // ended before the form hydrated (external/failed/cancelled). No-op when none requested.
  try { signalHydrated(); } catch {}
  try { sup?.destroy(); } catch {}
  hideOverlay(finalState === 'awaiting_review' || finalState === 'awaiting_input' || finalState === 'parked' ? 60000 : 4000);
  return { ok: true, state: finalState || (S.cancelled ? 'skipped' : 'unknown'), steps: S.step };
}
