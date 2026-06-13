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
import { qsa, isProbablyVisible, compactText } from './lib/dom.js';

const MAX_STEPS = 25;
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
  /^finish$/i, /^apply now$/i, /^apply$/i, /^easy apply$/i,
  /^send application$/i, /^suivant$/i, /^continuer$/i, /^soumettre$/i, /^postuler$/i,
];
const FINAL_SUBMIT_RX = /^(submit( application)?|send( application)?|soumettre|envoyer( ma candidature)?|confirm and submit)$/i;

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

function looksLikeAdvance(el) {
  if (!el || el.disabled || !isProbablyVisible(el)) return false;
  const text = compactText(el.textContent || el.value || '');
  if (!text || text.length > 40) return false;
  return ADVANCE_KEYWORDS.some((re) => re.test(text));
}

function findAdvanceButton(root) {
  for (const el of qsa('button, input[type="submit"], a[role="button"], [role="button"]', root || document)) {
    if (looksLikeAdvance(el)) return el;
  }
  return null;
}

function isFinalSubmit(el) {
  const text = compactText(el?.textContent || el?.value || '');
  return FINAL_SUBMIT_RX.test(text) || isSubmitClick(el);
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

  const { job, profile, resume, aiConfidenceMin = 0.7 } = context || {};
  const mode = task.mode || 'review';
  showOverlay(`${mode === 'review' ? 'Filling for your review' : 'Applying'} — ${job?.title || ''}`);
  logLine('ok', `start mode=${mode} profile=${profile ? 'loaded' : 'MISSING'} resume=${resume?.name || 'none'}`);

  if (!profile) {
    logLine('err', 'no profile configured — set one up in the dashboard first');
    report({ state: 'failed', lastError: 'no profile configured', attemptsDelta: 1 });
    S.running = false; hideOverlay();
    return { ok: false, error: 'no profile' };
  }

  const engine = new AutofillEngine({
    getProfile: async () => profile.data || profile,
    lookupAnswer: async (label) => {
      const r = await send({ type: 'api-call', method: 'POST', path: '/qa/lookup', body: { question: label } });
      return (r?.ok && r.match && typeof r.match.answer === 'string') ? { answer: r.match.answer } : null;
    },
    recordAnswer: async (item) => send({ type: 'qa-record', data: { ...item, source: job?.source } }),
  });

  let finished = false;
  let finalState = null;

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
    const root = formProbe?.form || document;

    // ---- fill from profile + learned answers ----
    setStatus(`Step ${S.step}: filling fields…`);
    const suggestions = (await engine.scanFillable(root)).filter((s) => {
      if (NEVER_AUTOFILL_RX.test(s.label)) {
        logLine('warn', `left sensitive field for you: "${s.label.slice(0, 40)}"`);
        return false;
      }
      return true;
    });
    const filled = engine.fill(suggestions);
    if (filled) logLine('ok', `filled ${filled} field(s) from profile/history`);

    // ---- resume upload ----
    const att = await tryAttachResume(root, resume);
    if (resume?.id && att.attempted && att.attached === 0) {
      logLine('err', 'resume could not be attached — stopping for you to upload it');
      report({ state: 'awaiting_input', lastError: 'resume attachment failed' });
      finalState = 'awaiting_input';
      break;
    }

    // ---- unknown questions → AI ladder ----
    const unknown = (await engine.scanUnknown(root)).slice(0, 5);
    for (const u of unknown) {
      if (S.cancelled) break;
      if (LEGAL_RX.test(u.label)) {
        logLine('warn', `legal/eligibility question not in profile: "${u.label.slice(0, 60)}" — leaving for you`);
        continue;
      }
      setStatus(`Step ${S.step}: thinking about "${u.label.slice(0, 40)}…"`);
      const r = await send({
        type: 'api-call', method: 'POST', path: '/ai/answer-question',
        timeoutMs: 150000,
        body: { question: u.label, fieldType: u.fieldType, options: u.options, jobId: job?.id },
      });
      // Validate the response shape — a malformed result (missing confidence,
      // non-string answer) must NEVER be treated as a confident answer.
      const a = (r?.ok && r.result && typeof r.result.answer === 'string'
                 && typeof r.result.confidence === 'number') ? r.result : null;
      if (!a || a.refuse || a.confidence < aiConfidenceMin || !a.answer.trim()) {
        logLine('warn', `no grounded answer for "${u.label.slice(0, 50)}" (${a ? 'conf ' + a.confidence : 'ai failed/malformed'})`);
        continue;
      }
      const ok = engine.fill([{ input: u.input, value: a.answer }]);
      if (ok) {
        logLine('ok', `AI answered "${u.label.slice(0, 40)}" (conf ${a.confidence.toFixed(2)})`);
        await engine.recordAnswer({ question: u.label, answer: a.answer, fieldType: u.fieldType, source: 'ai', jobId: job?.id });
      }
    }

    // learn everything currently on the form
    await engine.captureCurrentAnswers(root, { source: job?.source, jobId: job?.id });

    await untilUnpaused();
    if (S.cancelled) break;

    // ---- advance ----
    setStatus(`Step ${S.step}: looking for next/submit…`);
    const btn = findAdvanceButton(root);
    if (!btn) {
      // Maybe required fields are empty → validation visible, or page needs a human.
      logLine('warn', 'no advance button — waiting 30s for the page (or you)');
      let found = null;
      for (let i = 0; i < 60 && !S.cancelled; i++) {
        await sleep(500);
        found = findAdvanceButton();
        if (found) break;
      }
      if (!found) {
        report({ state: 'awaiting_input', lastError: 'no advance button found' });
        finalState = 'awaiting_input';
        break;
      }
      continue;
    }

    if (isFinalSubmit(btn)) {
      if (mode === 'review') {
        logLine('ok', 'reached the final submit — stopping for your review');
        setStatus('Ready for your review — press submit yourself when happy.');
        report({ state: 'awaiting_review', transcriptAppend: { note: 'stopped at final submit (review mode)' } });
        finalState = 'awaiting_review';
        break;
      }
      logLine('ok', 'final submit (auto mode)');
    }

    // Re-verify the button is still clickable right before acting — the DOM may
    // have changed since findAdvanceButton() above (validation re-render, etc.).
    let clickBtn = btn;
    if (clickBtn.disabled || !isProbablyVisible(clickBtn) || !document.contains(clickBtn)) {
      clickBtn = findAdvanceButton(root) || findAdvanceButton();
      if (!clickBtn) { logLine('warn', 'advance button became invalid before click — re-scanning'); continue; }
    }
    const label = compactText(clickBtn.textContent || clickBtn.value || '').slice(0, 30);
    logLine('ok', `clicking "${label}"`);
    setStatus(`Step ${S.step}: "${label}"…`);
    const prevHash = domHash();
    syntheticClick(clickBtn);
    const changed = await waitForChange(prevHash);
    if (!changed) logLine('warn', 'page did not change after click');

    // ---- success? ----
    const text = (document.body?.innerText || '').slice(0, 6000);
    if (/application (was )?(received|submitted|sent)|thank you for applying|we['']?ve received your application|candidature (envoy|soumis|reçu)/i.test(text)) {
      logLine('ok', '✓ application submitted');
      setStatus('✓ Application submitted');
      report({ state: 'done', transcriptAppend: { note: 'success text detected' } });
      finalState = 'done';
      finished = true;
    }
    await sleep(600);
  }

  if (!finalState && !S.cancelled && S.step >= MAX_STEPS) {
    logLine('warn', 'max steps reached — stopping for safety');
    report({ state: 'awaiting_input', lastError: 'max steps reached' });
    finalState = 'awaiting_input';
  }

  S.running = false;
  hideOverlay(finalState === 'awaiting_review' || finalState === 'awaiting_input' ? 60000 : 4000);
  return { ok: true, state: finalState || (S.cancelled ? 'skipped' : 'unknown'), steps: S.step };
}
