// v9.0.3: Resume-tailor prompt — REWRITTEN AGAIN for bulletproof reliability.
//
// FIXED from v9.0.2:
//   - DOUBLE-DASHBOARD bug: setting lastShownJobKey=null + URL polling fired
//     maybeShow() twice → open-app called twice → two dashboard tabs opened.
//     Now: a global _openAppCooldown (30s) makes that physically impossible.
//   - WELCOME TUTORIAL bug: open-app always landed on a fresh dashboard which
//     showed the v9 welcome card. Now the background auto-flips onboardingDone
//     when called with a deep-link route.
//   - URL POLLING REMOVED: it was firing once every 1.5s and creating cascading
//     re-detect attempts. Now only pushState/popstate/hashchange/visibility
//     trigger re-detection, debounced 1.5s with a strict in-flight lock.
//   - DETECTION HARDENED: confidence check before any UI — must have title +
//     company AND at least one apply-context signal (Apply button, "Easy
//     Apply" text, job-description heading, etc.).

(function () {
  if (window.__jat_tailor_loaded) return;
  window.__jat_tailor_loaded = true;

  // ============ STATE — single source of truth ============
  const STATE = {
    // Set of job-keys the user has dismissed/handled this page-session
    finalized: new Set(),
    // Job key for which we're currently waiting on a resume upload
    pendingResumeUploadJob: null,
    // True while ANY async detect/prompt flow is in flight
    busy: false,
    // Timestamp of the last open-app call; rate-limited to 1 per 30s
    lastOpenApp: 0,
    // The job we last actually showed a prompt for (used to detect "same job, don't re-prompt")
    lastPromptedJobKey: null,
    // URL we last saw — used to gate re-detect
    lastUrl: location.href,
    // Pending debounce timer for URL-change re-detection
    debounceTimer: null
  };

  const STYLE_ID = 'jat-tailor-prompt-style';
  const OPEN_APP_COOLDOWN_MS = 30000;

  function jobKey(ctx) { return `${(ctx?.title || '').slice(0, 80)}|${(ctx?.company || '').slice(0, 60)}`; }

  // ============ Confidence: is this REALLY a job page? ============
  function hasApplySignals() {
    // Cheap DOM scan for apply-context markers. Returns true if any present.
    const text = document.body?.innerText?.slice(0, 8000)?.toLowerCase() || '';
    if (!text) return false;
    if (/easy\s*apply|apply\s*now|submit\s*application|apply\s*to\s*this\s*job|application\s*form/.test(text)) return true;
    if (document.querySelector('button, [role="button"], a')) {
      const btns = Array.from(document.querySelectorAll('button, [role="button"], a')).slice(0, 200);
      for (const b of btns) {
        const t = (b.innerText || b.textContent || b.value || '').trim().toLowerCase();
        if (!t || t.length > 30) continue;
        if (/^(easy apply|apply now|apply|submit application)$/.test(t)) return true;
      }
    }
    return false;
  }
  function confident(ctx) {
    if (!ctx?.title || !ctx?.company) return false;
    if (ctx.title.length < 3 || ctx.company.length < 2) return false;
    // Reject obvious noise (page-title fallbacks like "Jobs" / "LinkedIn")
    if (/^(jobs?|home|feed|profile|login|sign in)$/i.test(ctx.title.trim())) return false;
    if (/^(linkedin|indeed|glassdoor|greenhouse|lever|workday)$/i.test(ctx.company.trim())) return false;
    return hasApplySignals() || /\/jobs\/view|\/job\/|\/viewjob|\/listing\//.test(location.href);
  }

  // ============ Styles ============
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
      let resolved = false;
      const done = (val) => { if (resolved) return; resolved = true; removeCard(); resolve(val); };
      card.querySelector('.jat-close').addEventListener('click', () => done('close'));
      card.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => done(b.dataset.act)));
      setTimeout(() => done('timeout'), 90000);
    });
  }

  // ============ Open-app — RATE-LIMITED to once per 30s ============
  async function safeOpenApp(route) {
    const now = Date.now();
    if (now - STATE.lastOpenApp < OPEN_APP_COOLDOWN_MS) {
      console.info('[jat-tailor] open-app suppressed (cooldown)');
      return false;
    }
    STATE.lastOpenApp = now;
    try {
      await chrome.runtime.sendMessage({ type: 'open-app', data: { route: route || '#/documents', suppressWelcome: true } });
      return true;
    } catch (e) {
      console.warn('[jat-tailor] open-app failed', e);
      return false;
    }
  }

  // ============ Core: ask, then act ============
  async function maybeShow(ctx) {
    if (STATE.busy) { console.info('[jat-tailor] busy, skip'); return; }
    if (!confident(ctx)) { console.info('[jat-tailor] not confident, skip', ctx); return; }
    const key = jobKey(ctx);
    if (STATE.finalized.has(key)) { console.info('[jat-tailor] finalized, skip'); return; }
    if (STATE.lastPromptedJobKey === key && document.getElementById('jat-tailor-card')) { return; }

    STATE.busy = true;
    try {
      const settingsR = await chrome.runtime.sendMessage({ type: 'get-settings' }).catch(() => null);
      if (!settingsR?.ok) return;
      if (settingsR.settings.autoTailorEnabled === 'never') { STATE.finalized.add(key); return; }

      const r = await chrome.runtime.sendMessage({ type: 'get-default-resume' }).catch(() => null);
      const hasResume = r?.ok && r.document;

      STATE.lastPromptedJobKey = key;
      // If they're already pending an upload for this job AND we now confirmed
      // they still have no resume, just show the waiting card. No new prompt.
      if (STATE.pendingResumeUploadJob === key && !hasResume) {
        showWaitingForResumeCard(ctx);
        return;
      }
      // If pending an upload AND they now have a resume, jump straight to tailoring.
      if (STATE.pendingResumeUploadJob === key && hasResume) {
        STATE.pendingResumeUploadJob = null;
        await runTailor(ctx);
        STATE.finalized.add(key);
        return;
      }

      const question = hasResume
        ? `Want JAT to tweak your resume (<strong>${escapeHtml((r.document.name || '').slice(0, 40))}</strong>) so it lines up with <strong>${escapeHtml(ctx.title.slice(0, 36))}</strong> at <strong>${escapeHtml(ctx.company.slice(0, 30))}</strong>?`
        : `Upload a default resume and JAT will auto-tailor it to every job you apply to. Set one up for <strong>${escapeHtml(ctx.title.slice(0, 36))}</strong> at <strong>${escapeHtml(ctx.company.slice(0, 30))}</strong>?`;

      const choice = await ask(question);

      if (choice === 'never') {
        await chrome.runtime.sendMessage({ type: 'patch-settings', data: { autoTailorEnabled: 'never' } });
        STATE.finalized.add(key);
        return;
      }
      if (choice === 'later' || choice === 'close' || choice === 'timeout') {
        STATE.finalized.add(key);
        return;
      }
      // choice === 'yes'
      if (!hasResume) {
        // v9.0.4: DO NOT auto-open the dashboard. The previous behavior was
        // racy and caused duplicate tabs. Just show a card with a button the
        // user explicitly clicks. STATE.pendingResumeUploadJob is set so
        // when they DO upload, visibilitychange picks up and re-prompts.
        STATE.pendingResumeUploadJob = key;
        showUploadPromptCard(ctx);
        return;
      }
      await runTailor(ctx);
      STATE.finalized.add(key);
    } finally {
      STATE.busy = false;
    }
  }

  // v9.0.4: Explicit upload-prompt card. User clicks button to open Documents tab.
  // Replaces the auto-open behavior which caused duplicate dashboard tabs.
  function showUploadPromptCard(ctx) {
    injectStyles(); removeCard();
    const card = document.createElement('div');
    card.id = 'jat-tailor-card';
    card.innerHTML = `
      <button class="jat-close" aria-label="Close">×</button>
      <h3 class="jat-h"><span class="jat-logo">JAT</span><span>Upload a resume to use AI tailoring</span></h3>
      <p>To use AI resume tailoring for <strong>${escapeHtml(ctx.title.slice(0, 30))}</strong> at <strong>${escapeHtml(ctx.company.slice(0, 24))}</strong>, you'll first need to upload a default resume in JAT.</p>
      <div class="jat-row">
        <button class="jat-btn primary" data-act="open-docs">📁 Open Documents page</button>
        <button class="jat-btn ghost" data-act="dismiss">Not now</button>
      </div>
      <div class="jat-status">Upload a resume → it's auto-set as default → come back and JAT will offer to tailor it.</div>
    `;
    document.body.appendChild(card);
    card.querySelector('.jat-close').addEventListener('click', () => {
      STATE.pendingResumeUploadJob = null;
      STATE.finalized.add(jobKey(ctx));
      removeCard();
    });
    card.querySelector('[data-act=dismiss]').addEventListener('click', () => {
      STATE.pendingResumeUploadJob = null;
      STATE.finalized.add(jobKey(ctx));
      removeCard();
    });
    // Single user-gesture click → opens dashboard exactly once.
    card.querySelector('[data-act=open-docs]').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      e.currentTarget.textContent = '📁 Opening…';
      await safeOpenApp('#/documents');
      // Card stays visible — user will return after uploading and the
      // visibilitychange / documents.updated broadcast will retrigger the
      // tailor flow automatically.
      e.currentTarget.textContent = '✓ Dashboard opened';
      setTimeout(() => {
        if (document.getElementById('jat-tailor-card')) {
          // Replace with waiting card
          showWaitingForResumeCard(ctx);
        }
      }, 1500);
    });
  }

  function showWaitingForResumeCard(ctx) {
    injectStyles(); removeCard();
    const card = document.createElement('div');
    card.id = 'jat-tailor-card';
    card.innerHTML = `
      <button class="jat-close" aria-label="Close">×</button>
      <h3 class="jat-h"><span class="jat-logo">JAT</span><span>Waiting for your default resume</span></h3>
      <p>Upload a resume in the JAT Documents tab → it'll be auto-set as default → switch back here and JAT will offer to tailor it for <strong>${escapeHtml(ctx.title.slice(0, 30))}</strong>.</p>
      <div class="jat-row">
        <button class="jat-btn primary" data-act="check">I uploaded it — check now</button>
        <button class="jat-btn ghost" data-act="dismiss">Dismiss</button>
      </div>
    `;
    document.body.appendChild(card);
    card.querySelector('.jat-close').addEventListener('click', removeCard);
    card.querySelector('[data-act=dismiss]').addEventListener('click', () => {
      STATE.finalized.add(jobKey(ctx));
      STATE.pendingResumeUploadJob = null;
      removeCard();
    });
    card.querySelector('[data-act=check]').addEventListener('click', async () => {
      // Clear pending + finalized for this key, then re-trigger
      removeCard();
      STATE.pendingResumeUploadJob = null;
      STATE.lastPromptedJobKey = null;
      setTimeout(() => maybeShow(ctx), 200);
    });
  }

  async function runTailor(ctx) {
    injectStyles(); removeCard();
    const card = document.createElement('div');
    card.id = 'jat-tailor-card';
    card.innerHTML = `
      <button class="jat-close" aria-label="Close">×</button>
      <h3 class="jat-h"><span class="jat-logo">JAT</span><span>Tailoring your resume…</span></h3>
      <p>AI is rewriting the summary + skill emphasis to match <strong>${escapeHtml(ctx.title.slice(0, 40))}</strong> at <strong>${escapeHtml(ctx.company.slice(0, 30))}</strong>.</p>
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
        stat.innerHTML = `
          <div style="margin-top:6px;color:#10b981;font-weight:600">✓ Tailored resume ready</div>
          <div class="jat-row" style="margin-top:8px">
            <button class="jat-btn primary" id="jat-download-tailor">⬇ Download .txt</button>
            <button class="jat-btn" id="jat-open-app-tailor">Open in app</button>
          </div>
          <div style="font-size:11px;color:#94a3b8;margin-top:8px">Upload this version to the application instead of your default.</div>
        `;
        document.getElementById('jat-download-tailor')?.addEventListener('click', () =>
          chrome.runtime.sendMessage({ type: 'download-tailored-resume', data: { id: res.id } }));
        document.getElementById('jat-open-app-tailor')?.addEventListener('click', () => safeOpenApp(''));
      }
    } catch (e) {
      const stat = document.getElementById('jat-tailor-status');
      if (stat) stat.innerHTML = `<span style="color:#ef4444">Failed: ${escapeHtml(String(e?.message || e))}</span>`;
    }
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

  // ============ Public entry from universal.js ============
  window.__jat_tailor_show = (ctx) => { maybeShow(ctx); };

  // ============ Re-detect on SPA navigations ============
  // Debounced; only fires after a real URL change settles (1.5s after the
  // LAST pushState/popstate/hashchange).
  function scheduleRedetect(reason) {
    clearTimeout(STATE.debounceTimer);
    STATE.debounceTimer = setTimeout(() => {
      if (location.href === STATE.lastUrl) return;
      STATE.lastUrl = location.href;
      console.info('[jat-tailor] redetect:', reason, location.href);
      tryFromAdapter();
    }, 1500);
  }
  function watchUrlChanges() {
    const fire = (reason) => scheduleRedetect(reason);
    window.addEventListener('popstate', () => fire('popstate'));
    window.addEventListener('hashchange', () => fire('hashchange'));
    const origPush = history.pushState;
    history.pushState = function () { const r = origPush.apply(this, arguments); try { fire('pushstate'); } catch {} return r; };
    const origReplace = history.replaceState;
    history.replaceState = function () { const r = origReplace.apply(this, arguments); try { fire('replacestate'); } catch {} return r; };
  }

  // Tab refocus — re-check ONLY if we're waiting for a resume upload
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!STATE.pendingResumeUploadJob) return;
    // Ask background if there's a default resume now; if yes, re-trigger
    setTimeout(async () => {
      const r = await chrome.runtime.sendMessage({ type: 'get-default-resume' }).catch(() => null);
      if (r?.ok && r.document) {
        const ctx = await getContextSafe();
        if (ctx && jobKey(ctx) === STATE.pendingResumeUploadJob) {
          STATE.pendingResumeUploadJob = null;
          STATE.lastPromptedJobKey = null;
          maybeShow(ctx);
        }
      }
    }, 500);
  });

  // Background broadcast: resume just got uploaded
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'jat-event') return;
    if (msg.name !== 'documents.updated' && msg.name !== 'settings.updated') return;
    if (!STATE.pendingResumeUploadJob) return;
    setTimeout(async () => {
      const r = await chrome.runtime.sendMessage({ type: 'get-default-resume' }).catch(() => null);
      if (r?.ok && r.document) {
        const ctx = await getContextSafe();
        if (ctx && jobKey(ctx) === STATE.pendingResumeUploadJob) {
          STATE.pendingResumeUploadJob = null;
          STATE.lastPromptedJobKey = null;
          maybeShow(ctx);
        }
      }
    }, 400);
  });

  async function getContextSafe() {
    try {
      if (typeof window.__jat_get_context === 'function') {
        const ctx = await window.__jat_get_context();
        if (ctx?.title && ctx?.company) return ctx;
      }
    } catch {}
    return null;
  }
  async function tryFromAdapter() {
    const ctx = await getContextSafe();
    if (ctx) maybeShow(ctx);
  }

  watchUrlChanges();
})();
