// v9.0.1: Resume-tailor prompt — injects a small floating card when the user
// is on a job application page. Detects:
//   - JD text + title + company from the page adapter context (set by universal.js)
//   - Whether the user has a default resume configured
// Shows one of three states:
//   A) No default resume yet → "Upload one and let us tailor it"
//   B) Has default resume + autoTailorEnabled in ['ask','always']
//      → "Tailor your resume for this role? (button)"
//   C) Permanently dismissed → no UI
//
// Runs once per (job, day) so the same prompt doesn't nag.

(function () {
  if (window.__jat_tailor_loaded) return;
  window.__jat_tailor_loaded = true;

  const SHOWN_KEY = '__jat_tailor_shown_jobs'; // sessionStorage
  const STYLE_ID = 'jat-tailor-prompt-style';

  function shownKeyForJob(ctx) {
    return `${(ctx.title || '').slice(0, 80)}|${(ctx.company || '').slice(0, 60)}`;
  }
  function alreadyShown(key) {
    try {
      const raw = sessionStorage.getItem(SHOWN_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return list.includes(key);
    } catch { return false; }
  }
  function markShown(key) {
    try {
      const raw = sessionStorage.getItem(SHOWN_KEY);
      const list = raw ? JSON.parse(raw) : [];
      if (!list.includes(key)) list.push(key);
      sessionStorage.setItem(SHOWN_KEY, JSON.stringify(list.slice(-50)));
    } catch {}
  }

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
      @keyframes jatTailorEnter {
        from { transform: translateY(20px) scale(0.95); opacity: 0; }
        to { transform: translateY(0) scale(1); opacity: 1; }
      }
      #jat-tailor-card.exit {
        animation: jatTailorExit 0.28s cubic-bezier(0.65,0,0.35,1) both;
      }
      @keyframes jatTailorExit {
        from { transform: translateY(0) scale(1); opacity: 1; }
        to { transform: translateY(20px) scale(0.92); opacity: 0; }
      }
      #jat-tailor-card .jat-h { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 14px; font-weight: 700; letter-spacing: -0.01em; }
      #jat-tailor-card .jat-h .jat-logo { width: 22px; height: 22px; border-radius: 6px; background: linear-gradient(135deg,#6366f1,#ec4899); display:inline-flex; align-items:center; justify-content:center; color:white; font-size:10px; font-weight:800; letter-spacing:0.02em; box-shadow: 0 2px 6px rgba(99,102,241,0.4); }
      #jat-tailor-card p { margin: 0 0 10px; color: #cbd5e1; font-size: 12.5px; }
      #jat-tailor-card .jat-row { display: flex; gap: 6px; flex-wrap: wrap; }
      #jat-tailor-card button.jat-btn {
        padding: 7px 12px; font: inherit; font-size: 12.5px; font-weight: 600;
        border-radius: 7px; cursor: pointer; transition: transform 0.12s, background 0.16s, border-color 0.16s, box-shadow 0.20s;
        border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.05); color: #f8fafc;
      }
      #jat-tailor-card button.jat-btn:hover { background: rgba(255,255,255,0.10); border-color: rgba(255,255,255,0.20); transform: translateY(-1px); }
      #jat-tailor-card button.jat-btn:active { transform: translateY(0) scale(0.97); }
      #jat-tailor-card button.jat-btn.primary {
        background: linear-gradient(135deg,#6366f1,#ec4899); border-color: transparent; color: white;
        box-shadow: 0 2px 8px rgba(99,102,241,0.35);
      }
      #jat-tailor-card button.jat-btn.primary:hover { box-shadow: 0 4px 14px rgba(99,102,241,0.50); }
      #jat-tailor-card button.jat-btn.ghost { background: transparent; color: #94a3b8; border-color: transparent; padding: 7px 8px; }
      #jat-tailor-card button.jat-btn.ghost:hover { color: #f8fafc; background: rgba(255,255,255,0.05); }
      #jat-tailor-card .jat-close {
        position: absolute; top: 8px; right: 8px;
        width: 26px; height: 26px; border-radius: 50%; border: none; background: transparent;
        color: #94a3b8; cursor: pointer; font-size: 16px; line-height: 1;
        display: inline-flex; align-items: center; justify-content: center;
        transition: background 0.15s, color 0.15s;
      }
      #jat-tailor-card .jat-close:hover { background: rgba(255,255,255,0.08); color: #f8fafc; }
      #jat-tailor-card .jat-status { font-size: 11.5px; color: #94a3b8; margin-top: 6px; }
      #jat-tailor-card .jat-spinner {
        display: inline-block; width: 11px; height: 11px;
        border: 2px solid rgba(255,255,255,0.20); border-top-color: #6366f1;
        border-radius: 50%; vertical-align: -1px; margin-right: 6px;
        animation: jatSpin 0.9s linear infinite;
      }
      @keyframes jatSpin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(s);
  }

  function removeCard() {
    const el = document.getElementById('jat-tailor-card');
    if (el) { el.classList.add('exit'); setTimeout(() => el.remove(), 260); }
  }

  function ask(question, ctx, defaults) {
    return new Promise((resolve) => {
      injectStyles();
      removeCard();
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
      const cleanup = (val) => { removeCard(); resolve(val); };
      card.querySelector('.jat-close').addEventListener('click', () => cleanup('close'));
      card.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => cleanup(b.dataset.act)));
      // Auto-dismiss after 60s if user doesn't engage
      setTimeout(() => cleanup('timeout'), 60000);
    });
  }

  function setStatus(html) {
    const el = document.getElementById('jat-tailor-status');
    if (el) el.innerHTML = html;
  }

  async function start(ctx) {
    if (!ctx?.title || !ctx?.company) return;
    const key = shownKeyForJob(ctx);
    if (alreadyShown(key)) return;
    markShown(key);

    // Ask background what to do
    const settings = await chrome.runtime.sendMessage({ type: 'get-settings' }).catch(() => null);
    if (!settings?.ok) return;
    const s = settings.settings || {};
    if (s.autoTailorEnabled === 'never') return;

    // Get default resume status
    const r = await chrome.runtime.sendMessage({ type: 'get-default-resume' }).catch(() => null);
    const hasResume = r?.ok && r.document;

    let question;
    if (hasResume) {
      question = `Want JAT to tweak your resume (<strong>${(r.document.name || '').slice(0, 40)}</strong>) so it lines up with <strong>${ctx.title.slice(0, 36)}</strong> at <strong>${ctx.company.slice(0, 30)}</strong>?`;
    } else {
      question = `Set a default resume and JAT will auto-tailor it to every job you apply to. <strong>${ctx.title.slice(0, 36)}</strong> at <strong>${ctx.company.slice(0, 30)}</strong> would be the first.`;
    }
    const choice = await ask(question, ctx);

    if (choice === 'never') {
      await chrome.runtime.sendMessage({ type: 'patch-settings', data: { autoTailorEnabled: 'never' } });
      return;
    }
    if (choice !== 'yes') return; // close / later / timeout

    if (!hasResume) {
      // Open the extension app on the documents page
      await chrome.runtime.sendMessage({ type: 'open-app' });
      // Inject a follow-up note
      injectStyles();
      removeCard();
      const card = document.createElement('div');
      card.id = 'jat-tailor-card';
      card.innerHTML = `
        <button class="jat-close" aria-label="Close">×</button>
        <h3 class="jat-h"><span class="jat-logo">JAT</span><span>Upload your default resume</span></h3>
        <p>Opened the Documents page — upload a resume and mark it default. Then return here and click apply again.</p>
        <div class="jat-row"><button class="jat-btn" data-act="ok">Got it</button></div>
      `;
      document.body.appendChild(card);
      card.querySelector('.jat-close').addEventListener('click', removeCard);
      card.querySelector('button[data-act=ok]').addEventListener('click', removeCard);
      return;
    }

    // Tailor flow
    injectStyles();
    removeCard();
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

      // Replace card with success state
      const stat = document.getElementById('jat-tailor-status');
      if (stat) {
        stat.innerHTML = '';
        const ok = document.createElement('div');
        ok.innerHTML = `
          <div style="margin-top:6px;color:#10b981;font-weight:600">✓ Tailored resume ready</div>
          <div class="jat-row" style="margin-top:8px">
            <button class="jat-btn primary" id="jat-download-tailor">⬇ Download tailored .txt</button>
            <button class="jat-btn" id="jat-open-app-tailor">Open in app</button>
          </div>
          <div style="font-size:11px;color:#94a3b8;margin-top:8px">Upload the downloaded version to this application instead of your default resume.</div>
        `;
        stat.appendChild(ok);
        document.getElementById('jat-download-tailor')?.addEventListener('click', async () => {
          await chrome.runtime.sendMessage({ type: 'download-tailored-resume', data: { id: res.id } });
        });
        document.getElementById('jat-open-app-tailor')?.addEventListener('click', () => {
          chrome.runtime.sendMessage({ type: 'open-app' });
        });
      }
    } catch (e) {
      const stat = document.getElementById('jat-tailor-status');
      if (stat) stat.innerHTML = `<span style="color:#ef4444">Failed: ${(e?.message || e)}</span>`;
    }
  }

  // Public entry — universal.js calls this when it has a job context
  window.__jat_tailor_show = start;
})();
