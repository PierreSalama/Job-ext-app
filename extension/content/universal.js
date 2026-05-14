// Universal content script. Runs on EVERY job-board host listed in manifest.
// Picks the adapter by hostname, then runs the standard capture loop:
//   - watch DOM for "apply dialog open" → save as 'started'
//   - watch DOM for "submission confirmed" → save as 'submitted'
//   - on submit-button click → fire optimistic capture
// Fixes the v4 bug where success was detected but jobContext returned empty:
// we now RETRY context extraction with exponential backoff before giving up.

import * as linkedin from './adapters/linkedin.js';
import * as indeed from './adapters/indeed.js';
import * as glassdoor from './adapters/glassdoor.js';
import * as greenhouse from './adapters/greenhouse.js';
import * as lever from './adapters/lever.js';
import * as workday from './adapters/workday.js';
import * as generic from './adapters/generic.js';
import { isStepAdvanceClick } from './adapters/base.js';
import { AutofillEngine } from './autofill.js';
import { pickProfileScraper } from './profile-scraper.js';

const ADAPTERS = [linkedin, indeed, glassdoor, greenhouse, lever, workday];

const sendBg = (type, data) => new Promise((res) => chrome.runtime.sendMessage({ type, data }, res));

(function bootUniversal() {
  function clog(level, ctx, message, data) {
    try { chrome.runtime.sendMessage({ type: 'log', data: { level, ctx, message, data } }); } catch {}
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[JAT5:${ctx}]`, message, data || '');
  }

  // Pick adapter by URL match
  let adapter = ADAPTERS.find((a) => a.matches.some((rx) => rx.test(location.href)));
  if (!adapter) {
    if (generic.canActivate?.()) adapter = generic;
    else { clog('debug', 'universal', `No adapter matched for ${location.host}`); return; }
  }
  clog('info', 'universal', `Adapter: ${adapter.name} (${location.host})`);

  let lastStartedKey = '';
  let lastAppliedKey = '';
  let mutationCount = 0;
  let autofillSuggestedFor = '';
  let lastDetectedAttachments = [];

  const autofill = new AutofillEngine({
    // Pull the named profile assigned to this source, falling back to the default
    getProfile: async () => {
      const r = await sendBg('get-profile-for-source', { source: adapter.id ? adapter.name : '' });
      if (r?.profile && Object.keys(r.profile).length) return r.profile;
      return (await sendBg('get-profile'))?.profile || {};
    },
    lookupAnswer: async (q) => (await sendBg('lookup-answer', { question: q }))?.answer,
    recordAnswer: (entry) => sendBg('record-answer', entry),
    log: clog
  });

  function sigKey(ctx) { return `${ctx.externalId || ''}|${ctx.title}|${ctx.company}`; }

  async function getContextWithRetry(maxAttempts = 6, delayMs = 250) {
    // Fix for v4 bug: when success modal appears before DOM finalizes, we'd
    // get empty title/company. Retry with backoff up to ~3.5s total.
    for (let i = 0; i < maxAttempts; i++) {
      const ctx = adapter.getContext();
      if (ctx.title && ctx.company) return ctx;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
    return adapter.getContext(); // last attempt, even if empty
  }

  async function fire(eventType, ctx, extra = {}) {
    const data = {
      ...ctx, ...extra,
      _source: 'extension',
      adapterId: adapter.id
    };
    panelStatus(`→ ${eventType}: ${ctx.title}`);
    clog('info', 'capture', `Firing ${eventType}: ${ctx.title} at ${ctx.company}`, { eventType, externalId: ctx.externalId, status: extra.status });
    try {
      const r = await chrome.runtime.sendMessage({ type: 'capture', data });
      if (r?.ok) {
        panelStatus(`✓ ${r.action} · ${ctx.title} (${r.job.status})`);
        clog('info', 'capture', `Saved: ${r.action}`, { jobId: r.job.id, action: r.action });
      } else {
        panelStatus(`✗ ${r?.error || 'failed'}`);
        clog('warn', 'capture', `Capture failed: ${r?.error}`, { eventType });
      }
    } catch (e) {
      panelStatus(`✗ ${e.message || e}`);
      clog('error', 'capture', `Exception`, { error: String(e.message || e) });
    }
  }

  async function tick() {
    const ctx = adapter.getContext();
    panelMeta(ctx);
    if (!ctx.title || !ctx.company) return;
    const key = sigKey(ctx);

    if (adapter.isSubmissionConfirmed()) {
      if (key !== lastAppliedKey) {
        lastAppliedKey = key;
        await fire('submission_confirmed', ctx, { applied: true, status: 'submitted', submittedAt: new Date().toISOString() });
      }
      return;
    }
    if (adapter.isApplyDialogOpen()) {
      if (key !== lastStartedKey) {
        lastStartedKey = key;
        await fire('apply_dialog_open', ctx, { applied: false, status: 'started' });
        // First time we see this dialog: harvest any values the site pre-filled
        // (LinkedIn / Indeed / Workday auto-populate name/email/phone/etc.) so
        // they enrich the user's profile + qa store next time.
        try {
          const harvested = await autofill.harvestPrefilledValues(undefined, { source: adapter.id, jobId: ctx.externalId });
          if (harvested > 0) {
            clog('info', 'autofill', `Harvested ${harvested} pre-filled value(s) from dialog`);
            panelStatus(`✨ Saved ${harvested} pre-filled values to your profile.`);
          }
        } catch (e) { clog('warn', 'autofill', `Harvest failed: ${e.message || e}`); }
      }
      // Offer autofill suggestions (once per job)
      if (autofillSuggestedFor !== key) {
        autofillSuggestedFor = key;
        try {
          const suggestions = await autofill.scanFillable();
          if (suggestions.length >= 2) {
            showAutofillPrompt(suggestions);
          }
        } catch (e) { clog('warn', 'autofill', `Scan failed: ${e.message || e}`); }
      }
      // Detect attachments (resume / cover letter) on every tick — they may
      // be added/changed between steps of a multi-step wizard.
      try {
        const att = autofill.detectAttachments();
        if (att.length) lastDetectedAttachments = att;
      } catch {}
    }
  }

  // Instant success hook with context retry — fixes v4 "no job context yet" bug
  let lastInstantFire = 0;
  async function onSuccessSignal(reason) {
    if (Date.now() - lastInstantFire < 1500) return;
    lastInstantFire = Date.now();
    const ctx = await getContextWithRetry();
    if (!ctx.title || !ctx.company) {
      clog('warn', 'instant', `Success detected but context empty after retry`, { reason, url: location.href });
      // Last resort: use URL + page title as company name
      const pageTitle = document.title || '';
      ctx.title = ctx.title || pageTitle.split(/[|·-]/)[0]?.trim();
      ctx.company = ctx.company || pageTitle.split(/[|·-]/)[1]?.trim() || location.hostname.replace(/^www\./, '');
      if (!ctx.title || !ctx.company) return;
    }
    const key = sigKey(ctx);
    if (key === lastAppliedKey) return;
    lastAppliedKey = key;
    clog('info', 'instant', `INSTANT capture (${reason})`, { externalId: ctx.externalId, title: ctx.title });
    panelStatus(`⚡ ${reason} — ${ctx.title}`);
    await fire('instant_success', ctx, { applied: true, status: 'submitted', submittedAt: new Date().toISOString() });
  }

  // Click hook
  document.addEventListener('click', async (ev) => {
    const target = ev.target?.closest?.('button, a, [role="button"], input[type="submit"]');
    if (!target) return;
    if (adapter.isSubmitClick(target)) {
      const ctx = await getContextWithRetry();
      if (ctx.title && ctx.company) {
        // Capture answers AND attachments before they vanish from the DOM
        let answersCaptured = 0;
        try { answersCaptured = await autofill.captureCurrentAnswers(undefined, { source: adapter.id, jobId: ctx.externalId }); } catch {}
        const att = autofill.detectAttachments();
        if (att.length) lastDetectedAttachments = att;
        const resume = (lastDetectedAttachments.find((a) => a.role === 'resume') || lastDetectedAttachments[0]);
        const coverLetter = lastDetectedAttachments.find((a) => a.role === 'coverLetter');
        clog('info', 'capture', `Submit clicked: ${answersCaptured} answers, ${lastDetectedAttachments.length} attachment(s)`);
        const key = sigKey(ctx);
        if (key !== lastAppliedKey) {
          lastAppliedKey = key;
          panelStatus(`⚡ Submit clicked — ${ctx.title}`);
          fire('submit_click', ctx, {
            applied: true, status: 'submitted', submittedAt: new Date().toISOString(),
            resumeName: resume?.name || '',
            coverLetterName: coverLetter?.name || '',
            attachments: lastDetectedAttachments,
            answersCaptured
          }).catch(() => {});
        }
      }
    } else if (adapter.isApplyClick(target)) {
      const ctx = await getContextWithRetry();
      if (ctx.title && ctx.company) {
        const key = sigKey(ctx);
        if (key !== lastStartedKey) {
          lastStartedKey = key;
          panelStatus(`⚡ Apply clicked — ${ctx.title}`);
          fire('apply_click', ctx, { applied: false, status: 'started' }).catch(() => {});
        }
      }
    } else if (adapter.isApplyDialogOpen() && isStepAdvanceClick(target)) {
      // User clicked Next/Continue/Review inside an open apply wizard.
      // Capture answers visible on this step + any newly attached files,
      // and patch the in-progress job so the user sees them in the app even
      // if they abandon the application halfway through.
      const ctx = await getContextWithRetry();
      if (ctx.title && ctx.company) {
        let answersCaptured = 0;
        try { answersCaptured = await autofill.captureCurrentAnswers(undefined, { source: adapter.id, jobId: ctx.externalId }); } catch {}
        const att = autofill.detectAttachments();
        if (att.length) lastDetectedAttachments = att;
        const resume = lastDetectedAttachments.find((a) => a.role === 'resume');
        const coverLetter = lastDetectedAttachments.find((a) => a.role === 'coverLetter');
        clog('info', 'capture', `Step advance: ${answersCaptured} answers, ${lastDetectedAttachments.length} attachment(s)`);
        panelStatus(`⚡ Captured step (${answersCaptured} answers).`);
        // Re-fire as 'started' so the job record absorbs the new attachments / answer count.
        fire('step_advance', ctx, {
          applied: false, status: 'started',
          resumeName: resume?.name || '',
          coverLetterName: coverLetter?.name || '',
          attachments: lastDetectedAttachments,
          answersCaptured
        }).catch(() => {});
      }
    }
  }, true);

  // Mutation watcher with debounce
  let debounce = null;
  const obs = new MutationObserver((records) => {
    mutationCount += records.length;
    clearTimeout(debounce);
    debounce = setTimeout(() => { tick().catch(() => {}); }, 200);
    // Fast path: success node added → fire immediately
    for (const r of records) {
      for (const node of r.addedNodes || []) {
        if (looksLikeSuccessAddedNode(node)) {
          onSuccessSignal('mutation:added-node');
          return;
        }
      }
    }
  });

  function looksLikeSuccessAddedNode(node) {
    if (!(node instanceof Element)) return false;
    if (node.id === 'post-apply-modal') return true;
    if (node.matches?.('[id^="post-apply"], [class*="post-apply-card"], [class*="jobs-post-apply"], #application_thank_you, [class*="thank-you"]')) return true;
    if (node.querySelector?.('#post-apply-modal, [id^="post-apply"], [class*="post-apply-card"], [class*="jobs-post-apply"], #application_thank_you')) return true;
    const t = (node.textContent || '').slice(0, 600);
    if (t.length < 600 && /(your application was sent|application sent|application submitted|thank you for applying)/i.test(t)) return true;
    return false;
  }

  // Periodic safety net
  setInterval(() => tick().catch(() => {}), 1500);
  setInterval(() => {
    if (adapter.isSubmissionConfirmed()) onSuccessSignal('poll:submission-confirmed');
  }, 800);

  // SPA URL change watcher
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastStartedKey = ''; lastAppliedKey = '';
      panelStatus('URL changed — rescanning.');
      setTimeout(() => tick().catch(() => {}), 600);
    }
  }, 800);

  // ============ Floating panel ============
  const PID = 'jat5-panel';
  // Theme vars applied to the floating panel + autofill prompt. Read from
  // chrome.storage.local under 'jat6.settings' / 'jat5.settings' (whatever
  // db.js mirrors there). Defaults match the Midnight theme.
  function applyContentTheme(themeId) {
    const T = {
      midnight:   { bg: '#0f172a', text: '#f8fafc', muted: '#94a3b8', primary: '#6366f1', primary2: '#8b5cf6', border: 'rgba(255,255,255,0.08)' },
      arctic:     { bg: '#f8fafc', text: '#0f172a', muted: '#64748b', primary: '#0ea5e9', primary2: '#6366f1', border: 'rgba(15,23,42,0.08)' },
      dracula:    { bg: '#282a36', text: '#f8f8f2', muted: '#6272a4', primary: '#bd93f9', primary2: '#ff79c6', border: 'rgba(189,147,249,0.2)' },
      nord:       { bg: '#2e3440', text: '#eceff4', muted: '#81a1c1', primary: '#88c0d0', primary2: '#5e81ac', border: 'rgba(136,192,208,0.2)' },
      gruvbox:    { bg: '#282828', text: '#ebdbb2', muted: '#a89984', primary: '#fe8019', primary2: '#d3869b', border: 'rgba(254,128,25,0.2)' },
    };
    const v = T[themeId] || T.midnight;
    const root = document.documentElement;
    root.style.setProperty('--jat-bg', v.bg);
    root.style.setProperty('--jat-text', v.text);
    root.style.setProperty('--jat-muted', v.muted);
    root.style.setProperty('--jat-primary', v.primary);
    root.style.setProperty('--jat-primary2', v.primary2);
    root.style.setProperty('--jat-border', v.border);
  }
  // Initial theme + live updates
  try {
    chrome.storage.local.get(['jat6.settings', 'jat5.settings']).then((s) => {
      const id = s['jat6.settings']?.theme || s['jat5.settings']?.theme || 'midnight';
      applyContentTheme(id);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      for (const k of ['jat6.settings', 'jat5.settings']) {
        if (changes[k]?.newValue?.theme) applyContentTheme(changes[k].newValue.theme);
      }
    });
  } catch {}
  function ensurePanel() {
    if (document.getElementById(PID)) return;
    const style = document.createElement('style');
    style.textContent = `
      #${PID} { position: fixed; right: 18px; bottom: 22px; width: 320px; z-index: 2147483646;
        border-radius: 14px; background: var(--jat-bg, rgba(15,23,42,0.97)); color: var(--jat-text, #f8fafc); backdrop-filter: blur(16px);
        font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
        box-shadow: 0 20px 50px rgba(0,0,0,0.5); overflow: hidden;
        border: 1px solid var(--jat-border, rgba(255,255,255,0.08)); }
      #${PID} .h { padding: 11px 14px; background: linear-gradient(135deg, var(--jat-primary, #6366f1), var(--jat-primary2, #8b5cf6));
        display: flex; justify-content: space-between; align-items: center; color: #fff; }
      #${PID} .h .e { font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255,255,255,0.85); font-weight: 700; }
      #${PID} .h strong { display: block; margin-top: 2px; font-size: 13px; color: #fff; }
      #${PID} .h .src { font-size: 10px; opacity: 0.85; }
      #${PID} .b { padding: 12px 14px; display: grid; gap: 10px; }
      #${PID} .meta { font-size: 11px; color: var(--jat-text, #cbd5e1); opacity: 0.85; line-height: 1.5; }
      #${PID} .status { font-size: 11px; color: var(--jat-muted, #94a3b8); }
      #${PID} .acts { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      #${PID} .acts button { border: 0; border-radius: 8px; padding: 8px; font-weight: 600; font-size: 11px; cursor: pointer;
        background: color-mix(in srgb, var(--jat-primary, #6366f1) 22%, transparent); color: var(--jat-text, #c7d2fe); transition: background 0.15s; }
      #${PID} .acts button:hover { background: color-mix(in srgb, var(--jat-primary, #6366f1) 32%, transparent); }
      #${PID} .acts button.primary { background: var(--jat-primary, #6366f1); color: #fff; }
      #${PID} .acts button.primary:hover { filter: brightness(1.1); }
      #${PID} .min { position: absolute; top: 8px; right: 10px; background: transparent; border: 0; color: rgba(255,255,255,0.7); cursor: pointer; font-size: 14px; }
      #${PID}.collapsed .b { display: none; }
      #${PID}.collapsed { width: 200px; }
    `;
    document.head.appendChild(style);
    const p = document.createElement('div');
    p.id = PID;
    p.innerHTML = `
      <div class="h">
        <div><div class="e">JAT v5 · <span class="src">${adapter.name}</span></div><strong>Capture this application</strong></div>
        <button class="min" title="Minimize">–</button>
      </div>
      <div class="b">
        <div class="meta">Scanning…</div>
        <div class="acts">
          <button data-act="save" class="primary">Save job</button>
          <button data-act="applied" class="primary">I applied</button>
          <button data-act="open">Open app</button>
          <button data-act="copy">Copy details</button>
        </div>
        <div class="status">Ready.</div>
      </div>
    `;
    p.querySelector('.min').addEventListener('click', (e) => { e.stopPropagation(); p.classList.toggle('collapsed'); });
    p.addEventListener('click', async (ev) => {
      const a = ev.target?.dataset?.act;
      if (!a) return;
      const ctx = await getContextWithRetry();
      if (a === 'save') fire('manual_save', ctx, { applied: false, status: 'started' });
      else if (a === 'applied') {
        lastAppliedKey = sigKey(ctx);
        fire('manual_applied', ctx, { applied: true, status: 'submitted', submittedAt: new Date().toISOString() });
      }
      else if (a === 'open') chrome.runtime.sendMessage({ type: 'open-app' });
      else if (a === 'copy') {
        try {
          await navigator.clipboard.writeText(`${ctx.title} at ${ctx.company} — ${ctx.jobUrl}`);
          panelStatus('Copied to clipboard.');
        } catch { panelStatus('Copy failed.'); }
      }
    });
    document.body.appendChild(p);
  }
  function panelStatus(t) { const el = document.querySelector(`#${PID} .status`); if (el) el.textContent = t; }
  // Autofill prompt UI
  const APID = 'jat5-autofill';
  function showAutofillPrompt(suggestions) {
    if (document.getElementById(APID)) return;
    const style = document.createElement('style');
    style.textContent = `
      #${APID} { position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647; max-width: 480px; padding: 14px 16px; border-radius: 14px;
        background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff;
        box-shadow: 0 24px 60px rgba(0,0,0,0.5);
        font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
        animation: jatSlideIn 0.25s; }
      @keyframes jatSlideIn { from { transform: translate(-50%, -10px); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }
      #${APID} .h { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 14px; font-weight: 700; }
      #${APID} p { margin: 0 0 10px; font-size: 13px; opacity: 0.95; }
      #${APID} .row { display: flex; gap: 6px; flex-wrap: wrap; }
      #${APID} button { border: 0; border-radius: 8px; padding: 7px 12px; cursor: pointer; font-size: 12px; font-weight: 600; background: rgba(255,255,255,0.18); color: #fff; }
      #${APID} button:hover { background: rgba(255,255,255,0.28); }
      #${APID} button.primary { background: #fff; color: #6366f1; }
      #${APID} button.primary:hover { background: #f4f4f5; }
    `;
    document.head.appendChild(style);
    const el = document.createElement('div');
    el.id = APID;
    const profCount = suggestions.filter((s) => s.source === 'profile').length;
    const qaCount = suggestions.filter((s) => s.source === 'qa').length;
    el.innerHTML = `
      <div class="h">✨ Autofill ${suggestions.length} field${suggestions.length === 1 ? '' : 's'}?</div>
      <p>${profCount} from your profile, ${qaCount} from previous answers. You can override anything before submitting — the app will learn from your changes.</p>
      <div class="row">
        <button class="primary" data-act="fill">Fill all</button>
        <button data-act="skip">Skip</button>
        <button data-act="never">Never autofill on ${adapter.name}</button>
      </div>
    `;
    document.body.appendChild(el);
    const dismiss = () => el.remove();
    el.querySelector('[data-act="fill"]').addEventListener('click', () => {
      const n = autofill.fill(suggestions);
      panelStatus(`Autofilled ${n} field(s).`);
      dismiss();
    });
    el.querySelector('[data-act="skip"]').addEventListener('click', dismiss);
    el.querySelector('[data-act="never"]').addEventListener('click', () => {
      sendBg('patch-settings', { ['noAutofill_' + adapter.id]: true });
      dismiss();
    });
    setTimeout(dismiss, 30000);
  }

  function panelMeta(ctx) {
    const el = document.querySelector(`#${PID} .meta`);
    if (!el) return;
    if (!ctx.title || !ctx.company) { el.textContent = `Open a job posting on ${adapter.name} to capture it.`; return; }
    el.textContent = [ctx.title, ctx.company, ctx.location, ctx.compensation].filter(Boolean).join(' · ');
  }

  // ============ Source-profile scraper UI ============
  function maybeOfferProfileSync() {
    const scraper = pickProfileScraper();
    if (!scraper) return;
    if (typeof scraper.isOwnProfile === 'function' && !scraper.isOwnProfile()) return;
    const PROF_ID = 'jat5-profile-sync';
    if (document.getElementById(PROF_ID)) return;
    const style = document.createElement('style');
    style.textContent = `
      #${PROF_ID} { position: fixed; top: 16px; right: 16px; z-index: 2147483647;
        background: linear-gradient(135deg,#10b981,#06b6d4); color:#fff;
        padding:12px 14px; border-radius:12px; box-shadow:0 16px 36px rgba(0,0,0,0.4);
        font-family:-apple-system, "Segoe UI", system-ui, sans-serif; max-width:300px; }
      #${PROF_ID} h4{margin:0 0 4px;font-size:13px;font-weight:700}
      #${PROF_ID} p{margin:0 0 10px;font-size:12px;opacity:0.95;line-height:1.4}
      #${PROF_ID} .row{display:flex;gap:6px}
      #${PROF_ID} button{border:0;border-radius:8px;padding:6px 12px;cursor:pointer;font-size:12px;font-weight:600;background:rgba(255,255,255,0.2);color:#fff}
      #${PROF_ID} button.primary{background:#fff;color:#0f766e}
    `;
    document.head.appendChild(style);
    const el = document.createElement('div');
    el.id = PROF_ID;
    el.innerHTML = `
      <h4>✨ Sync this profile to JAT</h4>
      <p>Capture your name, headline, location, summary, and skills into a JAT profile assigned to ${scraper.id[0].toUpperCase() + scraper.id.slice(1)}.</p>
      <div class="row">
        <button class="primary" data-act="sync">Sync now</button>
        <button data-act="skip">Skip</button>
      </div>
    `;
    document.body.appendChild(el);
    el.querySelector('[data-act="skip"]').addEventListener('click', () => el.remove());
    el.querySelector('[data-act="sync"]').addEventListener('click', async () => {
      try {
        const data = scraper.scrape();
        if (!data?.fullName && !data?.firstName) { panelStatus('No profile data found on page.'); el.remove(); return; }
        const name = `${(scraper.id[0].toUpperCase() + scraper.id.slice(1))} import — ${new Date().toLocaleDateString()}`;
        const r = await sendBg('import-source-profile', { source: data._source || scraper.id, name, data });
        if (r?.ok) {
          panelStatus(`✓ Profile synced (${r.profile?.name})`);
          el.querySelector('h4').textContent = '✓ Synced!';
          el.querySelector('p').textContent = `Saved as "${r.profile?.name}". Open JAT → Profile to review.`;
          el.querySelector('.row').innerHTML = `<button class="primary" data-act="open">Open JAT</button>`;
          el.querySelector('[data-act="open"]').addEventListener('click', () => sendBg('open-app'));
        } else {
          panelStatus(`Sync failed: ${r?.error || 'unknown'}`);
        }
      } catch (e) {
        panelStatus(`Sync error: ${e.message || e}`);
      }
    });
    setTimeout(() => { if (document.getElementById(PROF_ID)) el.remove(); }, 90000);
  }

  function boot() {
    ensurePanel();
    panelMeta(adapter.getContext());
    panelStatus(`Watching ${adapter.name}.`);
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => tick().catch(() => {}), 600);
    setTimeout(() => { try { maybeOfferProfileSync(); } catch {} }, 1200);
    // v9.0.1: fire the resume-tailor prompt once we have a confident job context
    setTimeout(async () => {
      try {
        const ctx = await getContextWithRetry();
        if (ctx?.title && ctx?.company && typeof window.__jat_tailor_show === 'function') {
          window.__jat_tailor_show({ ...ctx, source: adapter.id });
        }
      } catch {}
    }, 2200);
    clog('info', 'universal', `Boot complete on ${adapter.name}`);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
