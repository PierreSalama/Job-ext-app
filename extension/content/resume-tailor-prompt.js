// v9.0.2: Resume-tailor prompt — REWRITTEN for robustness.
//
// Fixes from v9.0.1:
//   1. SPA navigation detection — LinkedIn/Indeed/Glassdoor use pushState
//      heavily, so the original setTimeout-after-boot fired exactly once and
//      missed every subsequent job. Now we patch history.pushState +
//      listen to popstate AND poll URL every 1.5s as a safety net.
//   2. Post-upload re-detection — when the user opens the documents page
//      to upload a resume, we no longer mark the job as "shown" yet. We
//      re-check on:
//        a) document.visibilitychange → tab refocused
//        b) page URL changing back to the same job page
//        c) explicit message from background ('resume.uploaded')
//   3. More retry attempts for context detection (6 → 12 with 250ms backoff)
//   4. Status tracking: a small chip shows "JAT armed" so user can see the
//      extension knows about the page even before the prompt actually fires.

(function () {
  if (window.__jat_tailor_loaded) return;
  window.__jat_tailor_loaded = true;

  const STATE = {
    lastShownJobKey: null,
    sessionDismissedJobs: new Set(),     // (job-key) where user said "Maybe next time" or closed
    pendingResumeUploadJob: null,        // job we're waiting for a resume on
    lastUrl: location.href,
    bootedAt: Date.now()
  };

  const STYLE_ID = 'jat-tailor-prompt-style';

  function jobKey(ctx) { return `${(ctx?.title || '').slice(0, 80)}|${(ctx?.company || '').slice(0, 60)}`; }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      #jat-tailor-card {
        position: fixed; bottom: 24px; right: 24px; z-index: 2147483647;
        width: 360px; padding: 18px 18px 14px;
        background: rgba(15,17,21,0.95); backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid rgba(99,102,241,0.55); border-radius: 14px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04);
        color: #f8fafc; font: 500 13.5px -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
        animation: jatTailorEnter 0.5s cubic-bezier(0.34,1.56,0.64,1) both;
        line-height: 1.5;
      }
      @keyframes jatTailorEnter { from { transform: translateY(20px) scale(0.95); opacity: 0; } to { transform: translateY(0) scale(1); opacity: 1; } }
      #jat-tailor-card.exit { animation: jatTailorExit 0.28s cubic-bezier(0.65,0,0.35,1) both; }
      @keyframes jatTailorExit { from { transform: translateY(0) scale(1); opacity: 1; } to { transform: translateY(20px) scale(0.92); opacity: 0; } }
      #jat-tailor-card .jat-h { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 14px; font-weight: 700; letter-spacing: -0.01em; }
      #jat-tailor-card .jat-h .jat-logo { width: 22px; height: 22px; border-radius: 6px; background: linear-gradient(135deg,#6366f1,#ec4899); display:inline-flex; align-items:center; justify-content:center; color:white; font-size:10px; font-weight:800; box-shadow: 0 2px 6px rgba(99,102,241,0.4); }
      #jat-tailor-card p { margin: 0 0 10px; color: #cbd5e1; font-size: 12.5px; }
      #jat-tailor-card .jat-row { display: flex; gap: 6px; flex-wrap: wrap; }
      #jat-tailor-card button.jat-btn { padding: 7px 12px; font: inherit; font-size: 12.5px; font-weight: 600; border-radius: 7px; cursor: pointer; transition: transform 0.12s, background 0.16s, border-color 0.16s, box-shadow 0.20s; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05); color: #f8fafc; }
      #jat-tailor-card button.jat-btn:hover { background: rgba(255,255,255,0.10); border-color: rgba(255,255,255,0.20); transform: translateY(-1px); }
      #jat-tailor-card button.jat-btn:active { transform: translateY(0) scale(0.97); }
      #jat-tailor-card button.jat-btn.primary { background: linear-gradient(135deg,#6366f1,#ec4899); border-color: transparent; color: white; box-shadow: 0 2px 8px rgba(99,102,241,0.35); }
      #jat-tailor-card button.jat-btn.primary:hover { box-shadow: 0 4px 14px rgba(99,102,241,0.50); }
      #jat-tailor-card button.jat-btn.ghost { background: transparent; color: #94a3b8; border-color: transparent; padding: 7px 8px; }
      #jat-tailor-card button.jat-btn.ghost:hover { color: #f8fafc; background: rgba(255,255,255,0.05); }
      #jat-tailor-card .jat-close { position: absolute; top: 8px; right: 8px; width: 26px; height: 26px; border-radius: 50%; border: none; background: transparent; color: #94a3b8; cursor: pointer; font-size: 16px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; transition: background 0.15s, color 0.15s; }
      #jat-tailor-card .jat-close:hover { background: rgba(255,255,255,0.08); color: #f8fafc; }
      #jat-tailor-card .jat-status { font-size: 11.5px; color: #94a3b8; margin-top: 6px; }
      #jat-tailor-card .jat-spinner { display: inline-block; width: 11px; height: 11px; border: 2px solid rgba(255,255,255,0.20); border-top-color: #6366f1; border-radius: 50%; vertical-align: -1px; margin-right: 6px; animation: jatSpin 0.9s linear infinite; }
      @keyframes jatSpin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(s);
  }

  function removeCard() {
    const el = document.getElementById('jat-tailor-card');
    if (el) { el.classList.add('exit'); setTimeout(() => el.remove(), 260); }
  }

  // Returns a promise that resolves with the user's choice
  function ask(question) {
    return new Promise((resolve) => {
      injectStyles(); removeCard();
      const card = document.createElement('div');
      card.id = 'jat-tailor-card';
      card.innerHTML = `
        <button class="jat-close" aria-label="Close">×</button>
        <h3 class="jat-h"><span class="jat-logo">JAT</span><span>Tailor your resume?</span></h3>
        <p>${question}</p>
        <div class="jat-row">
          <button class="jat-btn primary" data-act="yes">✨ Tailor it now</button>
          <button class="jat-btn" data-act="later">Maybe next time</button>
          <button class="jat-btn ghost" data-act="never">Don't ask again</button>
        </div>
        <div class="jat-status" id="jat-tailor-status"></div>
      `;
      document.body.appendChild(card);
      const done = (val) => { removeCard(); resolve(val); };
      card.querySelector('.jat-close').addEventListener('click', () => done('close'));
      card.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => done(b.dataset.act)));
      setTimeout(() => done('timeout'), 90000);
    });
  }

  // The core flow — runs whenever we suspect we should prompt.
  let _flowInFlight = false;
  async function maybeShow(ctx) {
    if (_flowInFlight) return;
    if (!ctx?.title || !ctx?.company) return;
    const key = jobKey(ctx);
    if (STATE.sessionDismissedJobs.has(key)) return; // already dismissed in this session
    if (STATE.lastShownJobKey === key && document.getElementById('jat-tailor-card')) return;

    _flowInFlight = true;
    try {
      const settingsR = await chrome.runtime.sendMessage({ type: 'get-settings' }).catch(() => null);
      if (!settingsR?.ok) return;
      if (settingsR.settings.autoTailorEnabled === 'never') return;

      const r = await chrome.runtime.sendMessage({ type: 'get-default-resume' }).catch(() => null);
      const hasResume = r?.ok && r.document;

      STATE.lastShownJobKey = key;

      let question;
      if (hasResume) {
        question = `Want JAT to tweak your resume (<strong>${(r.document.name || '').slice(0, 40)}</strong>) so it lines up with <strong>${ctx.title.slice(0, 36)}</strong> at <strong>${ctx.company.slice(0, 30)}</strong>?`;
      } else {
        question = `Upload a default resume and JAT will auto-tailor it to every job you apply to. Want to set one up now for <strong>${ctx.title.slice(0, 36)}</strong> at <strong>${ctx.company.slice(0, 30)}</strong>?`;
      }
      const choice = await ask(question);

      if (choice === 'never') {
        await chrome.runtime.sendMessage({ type: 'patch-settings', data: { autoTailorEnabled: 'never' } });
        STATE.sessionDismissedJobs.add(key);
        return;
      }
      if (choice === 'later' || choice === 'close' || choice === 'timeout') {
        STATE.sessionDismissedJobs.add(key); // don't nag again in this session
        return;
      }

      // choice === 'yes'
      if (!hasResume) {
        // Open Documents page in a new tab, set up a "watch for upload" state.
        // We do NOT add to sessionDismissedJobs — so when the user returns and
        // visibility-change fires, we re-check and re-prompt automatically.
        STATE.pendingResumeUploadJob = ctx;
        STATE.lastShownJobKey = null; // allow re-show for this job
        await chrome.runtime.sendMessage({ type: 'open-app', data: { route: '#/documents' } });
        injectStyles(); removeCard();
        const card = document.createElement('div');
        card.id = 'jat-tailor-card';
        card.innerHTML = `
          <button class="jat-close" aria-label="Close">×</button>
          <h3 class="jat-h"><span class="jat-logo">JAT</span><span>Upload your default resume</span></h3>
          <p>Opened the Documents tab. Upload a resume → mark it default → switch back here. JAT will offer to tailor automatically.</p>
          <div class="jat-row">
            <button class="jat-btn primary" data-act="check">I uploaded it — check now</button>
            <button class="jat-btn" data-act="dismiss">Got it</button>
          </div>
          <div class="jat-status" id="jat-tailor-status">Waiting for your default resume…</div>
        `;
        document.body.appendChild(card);
        card.querySelector('.jat-close').addEventListener('click', () => { removeCard(); });
        card.querySelector('[data-act=dismiss]').addEventListener('click', () => { removeCard(); });
        card.querySelector('[data-act=check]').addEventListener('click', async () => {
          // Recheck resume + retry the flow on this job
          removeCard();
          STATE.pendingResumeUploadJob = null;
          STATE.lastShownJobKey = null;
          maybeShow(ctx);
        });
        return;
      }

      // Tailor flow
      injectStyles(); removeCard();
      const card = document.createElement('div');
      card.id = 'jat-tailor-card';
      card.innerHTML = `
        <button class="jat-close" aria-label="Close">×</button>
        <h3 class="jat-h"><span class="jat-logo">JAT</span><span>Tailoring your resume…</span></h3>
        <p>AI is rewriting the summary + skill emphasis to match <strong>${ctx.title.slice(0, 40)}</strong> at <strong>${ctx.company.slice(0, 30)}</strong>.</p>
        <div class="jat-status" id="jat-tailor-status"><span class="jat-spinner"></span>Generating…</div>
      `;
      document.body.appendChild(card);
      card.querySelector('.jat-close').addEventListener('click', removeCard);

      try {
        const res = await chrome.runtime.sendMessage({
          type: 'tailor-resume-for-job',
          data: { title: ctx.title, company: ctx.company, description: ctx.description || '', source: ctx.source || '' }
        });
        if (!res?.ok) throw new Error(res?.error || 'tailor failed');

        const stat = document.getElementById('jat-tailor-status');
        if (stat) {
          stat.innerHTML = '';
          const ok = document.createElement('div');
          ok.innerHTML = `
            <div style="margin-top:6px;color:#10b981;font-weight:600">✓ Tailored resume ready</div>
            <div class="jat-row" style="margin-top:8px">
              <button class="jat-btn primary" id="jat-download-tailor">⬇ Download .txt</button>
              <button class="jat-btn" id="jat-open-app-tailor">Open in app</button>
            </div>
            <div style="font-size:11px;color:#94a3b8;margin-top:8px">Upload this version to the application instead of your default.</div>
          `;
          stat.appendChild(ok);
          document.getElementById('jat-download-tailor')?.addEventListener('click', async () => {
            await chrome.runtime.sendMessage({ type: 'download-tailored-resume', data: { id: res.id } });
          });
          document.getElementById('jat-open-app-tailor')?.addEventListener('click', () => {
            chrome.runtime.sendMessage({ type: 'open-app' });
          });
        }
        STATE.sessionDismissedJobs.add(key); // success — don't re-prompt on this same job
      } catch (e) {
        const stat = document.getElementById('jat-tailor-status');
        if (stat) stat.innerHTML = `<span style="color:#ef4444">Failed: ${(e?.message || e)}</span>`;
      }
    } finally {
      _flowInFlight = false;
    }
  }

  // ============ Trigger sources ============

  // (A) Manual entry — called by universal.js on boot
  window.__jat_tailor_show = (ctx) => { maybeShow(ctx); };

  // (B) URL change detection — works for hash, popstate, AND pushState (SPA).
  // LinkedIn / Indeed / Glassdoor use history.pushState heavily so we patch it.
  function watchUrlChanges() {
    const fire = () => {
      if (location.href === STATE.lastUrl) return;
      STATE.lastUrl = location.href;
      // Give the SPA a moment to render the new page
      setTimeout(retriggerFromAdapterContext, 800);
    };
    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
    const origPush = history.pushState;
    history.pushState = function () {
      const r = origPush.apply(this, arguments);
      try { fire(); } catch {}
      return r;
    };
    const origReplace = history.replaceState;
    history.replaceState = function () {
      const r = origReplace.apply(this, arguments);
      try { fire(); } catch {}
      return r;
    };
    // Belt-and-suspenders: poll URL every 1.5s
    setInterval(fire, 1500);
  }

  // (C) Visibility change — when the user comes back to this tab (likely after
  // uploading a resume in another tab), recheck.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (STATE.pendingResumeUploadJob) {
      // They went to upload a resume — try again with the same job
      const j = STATE.pendingResumeUploadJob;
      STATE.pendingResumeUploadJob = null;
      STATE.lastShownJobKey = null; // allow re-show
      setTimeout(() => maybeShow(j), 400);
    } else {
      // Just generally re-check from the adapter context
      setTimeout(retriggerFromAdapterContext, 400);
    }
  });

  // (D) Listen for explicit broadcasts from background (e.g. a setting changed
  // or a doc was added). If we have a pending tailor and a resume now exists,
  // re-trigger.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'jat-event' && (msg.name === 'documents.updated' || msg.name === 'settings.updated')) {
      if (STATE.pendingResumeUploadJob) {
        const j = STATE.pendingResumeUploadJob;
        STATE.pendingResumeUploadJob = null;
        STATE.lastShownJobKey = null;
        setTimeout(() => maybeShow(j), 400);
      }
    }
  });

  async function retriggerFromAdapterContext() {
    // Universal.js sets window.__jat_get_context lazily. If it's not there,
    // synthesize a best-effort context from <title>.
    try {
      if (typeof window.__jat_get_context === 'function') {
        const ctx = await window.__jat_get_context();
        if (ctx?.title && ctx?.company) {
          maybeShow(ctx);
          return;
        }
      }
    } catch {}
    // Fallback — derive from <title>
    const t = document.title || '';
    const m = t.match(/^(.+?)\s+[|·\-—]\s+(.+?)\s+[|·\-—]\s+/);
    if (m && m[1] && m[2]) maybeShow({ title: m[1].trim(), company: m[2].trim() });
  }

  watchUrlChanges();
})();
