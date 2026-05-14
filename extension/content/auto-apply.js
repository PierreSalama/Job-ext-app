// v9.0.1: Auto-Apply RPA engine — walks a job application form for the user.
//
// What it does on each step:
//   1. Detect all visible form fields on the page
//   2. Fill them using the user's saved profile (via autofill.js)
//   3. Find the "Next" / "Continue" / "Submit" / "Review" button and click it
//   4. Wait for the next page/step to load
//   5. Repeat until the form is submitted, an error appears, or the user stops
//
// Shows a translucent overlay with current status + STOP button. The user can
// cancel at any moment with Esc or the stop button. Step-by-step actions are
// logged so the user can see what happened.
//
// Constraints: this runs inside the page's isolated world. We cannot move the
// real OS mouse — instead we dispatch synthetic click/input events directly on
// elements. For 99% of job-board forms this works identically to a real user.

(function () {
  if (window.__jat_autoapply_loaded) return;
  window.__jat_autoapply_loaded = true;

  const STATE = {
    running: false,
    cancelled: false,
    step: 0,
    log: [],
    overlayEl: null,
    stopReason: null
  };
  const MAX_STEPS = 20;
  const STEP_TIMEOUT = 8000;

  // ---------- Overlay UI ----------
  const STYLE_ID = 'jat-autoapply-style';
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      #jat-autoapply-overlay {
        position: fixed; bottom: 24px; left: 24px; z-index: 2147483647;
        width: 380px; padding: 16px;
        background: rgba(15,17,21,0.96); backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid rgba(99,102,241,0.55); border-radius: 14px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        color: #f8fafc; font: 500 13px -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
        animation: jatAaIn 0.45s cubic-bezier(0.34,1.56,0.64,1) both;
      }
      @keyframes jatAaIn { from { transform: translateY(20px) scale(0.95); opacity: 0; } to { transform: translateY(0) scale(1); opacity: 1; } }
      #jat-autoapply-overlay.exit { animation: jatAaOut 0.3s cubic-bezier(0.65,0,0.35,1) both; }
      @keyframes jatAaOut { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(20px); } }
      #jat-autoapply-overlay .h { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-weight: 700; font-size: 14px; }
      #jat-autoapply-overlay .h .pulse { width: 10px; height: 10px; border-radius: 50%; background: #10b981; box-shadow: 0 0 0 0 rgba(16,185,129,0.7); animation: jatPulse 1.4s ease-out infinite; }
      @keyframes jatPulse { 0% { box-shadow: 0 0 0 0 rgba(16,185,129,0.7); } 100% { box-shadow: 0 0 0 14px rgba(16,185,129,0); } }
      #jat-autoapply-overlay .status { font-size: 12px; color: #cbd5e1; margin-bottom: 8px; min-height: 16px; }
      #jat-autoapply-overlay .log {
        font-family: ui-monospace,Consolas,monospace; font-size: 11px; color: #94a3b8;
        max-height: 100px; overflow-y: auto; background: rgba(0,0,0,0.30); border-radius: 6px; padding: 6px 8px; margin-bottom: 10px;
      }
      #jat-autoapply-overlay .log div { margin: 2px 0; }
      #jat-autoapply-overlay .log .ok { color: #10b981; }
      #jat-autoapply-overlay .log .warn { color: #f59e0b; }
      #jat-autoapply-overlay .log .err { color: #ef4444; }
      #jat-autoapply-overlay .btn-row { display: flex; gap: 6px; }
      #jat-autoapply-overlay button {
        flex: 1; padding: 7px 12px; font: inherit; font-weight: 600; font-size: 12.5px;
        border-radius: 7px; cursor: pointer; transition: transform 0.10s, background 0.15s;
        border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05); color: #f8fafc;
      }
      #jat-autoapply-overlay button:hover { background: rgba(255,255,255,0.10); }
      #jat-autoapply-overlay button:active { transform: scale(0.97); }
      #jat-autoapply-overlay button.danger { background: rgba(239,68,68,0.18); border-color: rgba(239,68,68,0.45); color: #fca5a5; }
      #jat-autoapply-overlay button.danger:hover { background: rgba(239,68,68,0.28); }
    `;
    document.head.appendChild(s);
  }

  function showOverlay() {
    injectStyles();
    if (STATE.overlayEl) return;
    const el = document.createElement('div');
    el.id = 'jat-autoapply-overlay';
    el.innerHTML = `
      <div class="h"><span class="pulse"></span><span>🤖 AI auto-applying…</span></div>
      <div class="status" id="jat-aa-status">Starting…</div>
      <div class="log" id="jat-aa-log"></div>
      <div class="btn-row">
        <button id="jat-aa-pause">⏸ Pause</button>
        <button class="danger" id="jat-aa-stop">⏹ Stop</button>
      </div>
    `;
    document.body.appendChild(el);
    STATE.overlayEl = el;
    el.querySelector('#jat-aa-stop').addEventListener('click', () => cancel('user'));
    el.querySelector('#jat-aa-pause').addEventListener('click', (e) => {
      STATE.paused = !STATE.paused;
      e.currentTarget.textContent = STATE.paused ? '▶ Resume' : '⏸ Pause';
    });
    // Esc to cancel
    if (!window.__jat_aa_esc) {
      window.__jat_aa_esc = (e) => { if (e.key === 'Escape' && STATE.running) cancel('escape'); };
      window.addEventListener('keydown', window.__jat_aa_esc);
    }
  }
  function hideOverlay() {
    if (!STATE.overlayEl) return;
    STATE.overlayEl.classList.add('exit');
    setTimeout(() => { STATE.overlayEl?.remove(); STATE.overlayEl = null; }, 320);
  }
  function setStatus(s) {
    const el = STATE.overlayEl?.querySelector('#jat-aa-status');
    if (el) el.textContent = s;
  }
  function appendLog(level, text) {
    const log = STATE.overlayEl?.querySelector('#jat-aa-log');
    if (log) {
      const d = document.createElement('div');
      d.className = level;
      d.textContent = `[step ${STATE.step}] ${text}`;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    }
    STATE.log.push({ step: STATE.step, level, text });
  }
  function cancel(reason) {
    if (!STATE.running) return;
    STATE.cancelled = true; STATE.stopReason = reason;
    appendLog('warn', `Stopped (${reason})`);
    setStatus('Stopped');
    setTimeout(hideOverlay, 800);
  }

  // ---------- Wait helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function untilPaused() { while (STATE.paused && !STATE.cancelled) await sleep(200); }
  async function waitForChange(initialHash, timeoutMs = STEP_TIMEOUT) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (STATE.cancelled) return false;
      if (domHash() !== initialHash) return true;
      await sleep(180);
    }
    return false;
  }
  function domHash() {
    // Lightweight signature so we can detect when a new step has rendered
    return `${document.body.innerText.length}|${location.href}|${document.querySelectorAll('input,select,textarea,button').length}`;
  }

  // ---------- Submit button detection ----------
  const SUBMIT_KEYWORDS = [
    /^submit application$/i, /^submit$/i, /^submit & continue$/i,
    /^review your application$/i, /^review$/i,
    /^next$/i, /^continue$/i, /^continue to/i, /^proceed/i,
    /^save and continue$/i, /^save & continue$/i,
    /^finish$/i, /^apply now$/i, /^apply$/i,
    /^send application$/i
  ];
  function looksLikeAdvance(el) {
    if (!el || !(el.offsetWidth || el.offsetHeight)) return false;
    const text = (el.textContent || el.value || '').trim();
    if (!text || text.length > 40) return false;
    return SUBMIT_KEYWORDS.some((re) => re.test(text));
  }
  function findAdvanceButton() {
    const candidates = Array.from(document.querySelectorAll('button, input[type="submit"], a[role="button"], [role="button"]'));
    // Strong preference: buttons whose text matches a SUBMIT keyword AND are not disabled
    for (const el of candidates) {
      if (el.disabled) continue;
      if (looksLikeAdvance(el)) return el;
    }
    return null;
  }

  // ---------- One step ----------
  async function step(profile, autofill) {
    STATE.step++;
    await untilPaused();
    if (STATE.cancelled) return false;

    setStatus(`Step ${STATE.step}: filling fields…`);
    let fillCount = 0;
    try {
      // Use the existing autofill module if loaded by universal.js
      if (autofill && typeof autofill.autofillAll === 'function') {
        const r = await autofill.autofillAll(profile, { source: 'auto-apply' });
        fillCount = (r && (r.filled || r.count)) || 0;
      } else {
        // Minimal fallback: fill all empty inputs with profile values where the
        // label / placeholder / name matches a known key.
        fillCount = await minimalFill(profile);
      }
    } catch (e) { appendLog('warn', `autofill threw: ${e.message || e}`); }
    appendLog(fillCount > 0 ? 'ok' : 'warn', `Filled ${fillCount} field${fillCount === 1 ? '' : 's'}`);

    await untilPaused();
    if (STATE.cancelled) return false;

    // Look for advance button
    setStatus(`Step ${STATE.step}: looking for next/submit…`);
    const btn = findAdvanceButton();
    if (!btn) {
      appendLog('warn', 'No advance button found — page may need manual interaction');
      setStatus('No next button. Click manually, or stop.');
      // Wait for user — poll for change every 500ms up to 30s
      for (let i = 0; i < 60 && !STATE.cancelled; i++) {
        await sleep(500);
        if (findAdvanceButton()) break;
      }
      return STATE.cancelled ? false : true;
    }

    const label = (btn.textContent || btn.value || '').trim().slice(0, 30);
    appendLog('ok', `Clicking "${label}"`);
    setStatus(`Step ${STATE.step}: clicking "${label}"…`);

    const prevHash = domHash();
    // Synthetic click — mouseover, mousedown, mouseup, click for max compatibility
    try {
      ['pointerover','mouseover','mousemove','pointerdown','mousedown','pointerup','mouseup','click'].forEach((ev) => {
        btn.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window }));
      });
    } catch (e) {
      try { btn.click(); } catch { appendLog('err', `Click failed: ${e.message || e}`); return false; }
    }

    const changed = await waitForChange(prevHash, STEP_TIMEOUT);
    if (!changed && !STATE.cancelled) {
      appendLog('warn', 'Page did not change after click — may be a final state');
    }

    // Detect submission success keywords
    const text = document.body.innerText.slice(0, 5000).toLowerCase();
    if (/application (was )?(received|submitted|sent)|thank you for applying|we[' ]ve received your application/i.test(text)) {
      appendLog('ok', '✓ Application submitted!');
      setStatus('✓ Application submitted!');
      return false; // done
    }
    return true; // continue loop
  }

  async function minimalFill(profile) {
    let n = 0;
    const fields = document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select');
    for (const el of fields) {
      if (!(el.offsetWidth || el.offsetHeight)) continue;
      if (el.value && String(el.value).trim().length > 0) continue;
      const key = guessKey(el);
      const val = profile[key];
      if (!val) continue;
      try {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
        if (setter) setter.call(el, val); else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        n++;
      } catch {}
    }
    return n;
  }
  function guessKey(el) {
    const meta = `${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
    if (/email/.test(meta)) return 'email';
    if (/phone|mobile/.test(meta)) return 'phone';
    if (/first.*name|given.*name|fname/.test(meta)) return 'firstName';
    if (/last.*name|family.*name|surname|lname/.test(meta)) return 'lastName';
    if (/full.*name|^name$/.test(meta)) return 'fullName';
    if (/city/.test(meta)) return 'city';
    if (/state|province/.test(meta)) return 'state';
    if (/zip|postal/.test(meta)) return 'postalCode';
    if (/country/.test(meta)) return 'country';
    if (/linkedin/.test(meta)) return 'linkedinUrl';
    if (/github/.test(meta)) return 'githubUrl';
    if (/portfolio|website/.test(meta)) return 'portfolioUrl';
    return null;
  }

  // ---------- Main loop ----------
  async function run() {
    if (STATE.running) return { ok: false, error: 'already running' };
    STATE.running = true; STATE.cancelled = false; STATE.paused = false;
    STATE.step = 0; STATE.log = []; STATE.stopReason = null;
    showOverlay();
    setStatus('Loading profile…');

    let profile = {};
    let autofill = null;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'get-profile' });
      if (r?.ok) profile = r.profile || {};
      else appendLog('warn', `profile unavailable: ${r?.error || ''}`);
      // Try to grab the autofill module loaded by universal.js for richer field detection
      try { autofill = await import(chrome.runtime.getURL('content/autofill.js')); } catch {}
    } catch (e) {
      appendLog('err', `init failed: ${e.message || e}`);
    }

    appendLog('ok', `Starting (profile: ${profile.email ? 'loaded' : 'minimal'})`);

    let go = true;
    while (go && STATE.step < MAX_STEPS && !STATE.cancelled) {
      try { go = await step(profile, autofill); }
      catch (e) { appendLog('err', `step ${STATE.step} crashed: ${e.message || e}`); break; }
      await sleep(500); // breathe
    }

    STATE.running = false;
    if (STATE.cancelled) setStatus(`Stopped (${STATE.stopReason || 'cancelled'})`);
    else if (STATE.step >= MAX_STEPS) { setStatus('Max steps reached'); appendLog('warn', 'Hit max steps; stopping for safety'); }
    setTimeout(hideOverlay, 4000);
    return { ok: true, steps: STATE.step, cancelled: STATE.cancelled, log: STATE.log };
  }

  // Public entry — extension toolbar / popup triggers this via sendMessage:
  //   chrome.tabs.sendMessage(tabId, { type: 'start-auto-apply' })
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'start-auto-apply') {
      run().then(sendResponse);
      return true; // async response
    }
    if (msg?.type === 'stop-auto-apply') {
      cancel('user'); sendResponse({ ok: true }); return false;
    }
  });
})();
