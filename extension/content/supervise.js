// JAT v11 — Live Teach & Correct: supervised-run overlay + on-page correction picker.
// [Teach & Correct T4]
//
// BROWSER-ONLY, fully defensive. Nothing here is unit-tested — the pure decision logic
// (pickRunMode) lives in replay.js and IS tested; this module is the DOM/UX shell the
// executor's supervised path drives. Hard invariants:
//   • NEVER throws into the page (every handler is try/wrapped; failures degrade silently).
//   • The picker captures in the CAPTURE phase and stopPropagation/preventDefault so it
//     NEVER triggers the site's own click handlers, and NEVER submits anything.
//   • Esc and Stop ALWAYS work (cancel the pick, then stop the run).
//
// The controller exposes an await-able gate the executor calls before each action:
//   • mode()                → 'step' | 'run' (live, reflects the toggle)
//   • beforeAction(info)    → resolves when the user Approves (Step) / immediately (Run);
//                             rejects/returns 'wrong' when the user hit "Wrong / Fix this".
//   • setStep(info)         → update the "current step" readout.
//   • requestCorrection(step) → opens the pick UI; resolves with the chosen replacement
//                             bundle (or null if dismissed). The executor POSTs it.
//   • stopped()             → true once the user hit Stop / Esc.
//
// The executor remains the single owner of the apply walk; this only paces + corrects it.

import { buildLocator } from './recorder.js';

const Z = '2147483647';

// ---- defensive helpers (never throw) ----
function el(tag, props = {}, styles = {}) {
  const e = document.createElement(tag);
  try { Object.assign(e, props); } catch {}
  try { Object.assign(e.style, styles); } catch {}
  return e;
}
function safeText(s, n = 80) { return String(s == null ? '' : s).slice(0, n); }

// ============================================================
// SuperviseController
// ============================================================
export function createSupervisor(opts = {}) {
  const state = {
    mode: opts.mode === 'run' ? 'run' : 'step',   // default from pickRunMode upstream
    stopped: false,
    // pending Step-mode approval gate
    approveResolve: null,
    wrong: false,
    picking: false,
    root: null,        // current apply-form root (set by the executor each step)
    fieldsFn: opts.fieldsFn || null,   // () => [{ input, label }] of fillable fields + buttons
    paused: false,
    submitResolve: null,
    recoveryResolve: null,
    telemetry: {},
    settings: {
      pace: 1,
      confidence: Number(opts.confidence || 0.7),
      stallLimit: Number(opts.stallLimit || 3),
    },
  };

  let panel = null, stepLine = null, modeBtn = null, nextBtn = null, fixBtn = null;
  let pauseBtn = null, applyBtn = null, retryBtn = null, telemetryEl = null, seenEl = null, logEl = null;

  // ---------- panel ----------
  function buildPanel() {
    try {
      if (panel) return;
      panel = el('div', { id: 'jat11-teach' }, {
        position: 'fixed', top: '16px', right: '16px',
        zIndex: Z, width: '520px', maxWidth: 'calc(100vw - 32px)', padding: '14px 16px',
        background: 'rgba(10,10,10,0.97)', color: '#f4efe6',
        border: '1px solid #3a342d', borderTop: '2px solid #b08a5a',
        boxShadow: '0 18px 50px rgba(0,0,0,0.55)',
        font: '500 13px "Inter", -apple-system, "Segoe UI", system-ui, sans-serif',
      });
      const head = el('div', {}, { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', fontSize: '11px', letterSpacing: '0.22em', textTransform: 'uppercase', color: '#b08a5a' });
      head.textContent = 'JAT Control Studio - watching, teaching and healing';
      stepLine = el('div', {}, { fontSize: '12px', color: '#d9d2c6', marginBottom: '10px', minHeight: '16px' });
      stepLine.textContent = 'Waiting for the apply form…';

      telemetryEl = el('div', {}, { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '1px', background: '#302a24', border: '1px solid #302a24', marginBottom: '8px' });
      for (const key of ['Stage', 'Step', 'Fields', 'Recovery']) {
        const cell = el('div', {}, { background: '#15120f', padding: '7px', minWidth: '0' });
        cell.setAttribute('data-metric', key.toLowerCase());
        cell.innerHTML = `<div style="font-size:8px;color:#8b8378;text-transform:uppercase;letter-spacing:.12em">${key}</div><div data-value style="font-size:11px;color:#f4efe6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">-</div>`;
        telemetryEl.append(cell);
      }
      seenEl = el('div', {}, { font: '10px/1.4 ui-monospace, Consolas, monospace', color: '#a99f92', background: '#0e0c0a', border: '1px solid #241f1a', padding: '7px', minHeight: '34px', maxHeight: '58px', overflow: 'auto', marginBottom: '8px' });
      seenEl.textContent = 'Robot sees: waiting for page scan';
      logEl = el('div', {}, { font: '10px/1.4 ui-monospace, Consolas, monospace', color: '#8b8378', background: '#0e0c0a', border: '1px solid #241f1a', padding: '7px', maxHeight: '76px', overflowY: 'auto', marginBottom: '8px' });

      const row = el('div', {}, { display: 'flex', gap: '6px' });
      const mkBtn = (label, danger) => {
        const b = el('button', { type: 'button' }, {
          flex: '1', padding: '8px 6px', font: 'inherit', fontSize: '10px', fontWeight: '600',
          letterSpacing: '0.12em', textTransform: 'uppercase', cursor: 'pointer',
          border: '1px solid #3a342d', background: 'transparent', color: '#8b8378',
        });
        b.textContent = label;
        b.addEventListener('mouseenter', () => { b.style.color = danger ? '#c25b5b' : '#b08a5a'; b.style.borderColor = danger ? '#c25b5b' : '#b08a5a'; }, true);
        b.addEventListener('mouseleave', () => { b.style.color = '#8b8378'; b.style.borderColor = '#3a342d'; }, true);
        return b;
      };
      modeBtn = mkBtn(state.mode === 'run' ? '▶ Run' : '⏸ Step');
      nextBtn = mkBtn('Next / Approve');
      fixBtn = mkBtn('Wrong / Fix this');
      pauseBtn = mkBtn('Pause');

      modeBtn.addEventListener('click', (e) => { stopEv(e); toggleMode(); }, true);
      nextBtn.addEventListener('click', (e) => { stopEv(e); approve(); }, true);
      fixBtn.addEventListener('click', (e) => { stopEv(e); markWrong(); }, true);
      pauseBtn.addEventListener('click', (e) => { stopEv(e); setPaused(!state.paused); }, true);

      row.append(modeBtn, pauseBtn, nextBtn, fixBtn);

      const commandRow = el('div', {}, { display: 'flex', gap: '6px', marginTop: '6px' });
      applyBtn = mkBtn('Apply this job');
      retryBtn = mkBtn('Retry step');
      const skipBtn = mkBtn('Skip job', true);
      const nextJobBtn = mkBtn('Skip + next', true);
      const stopBtn = mkBtn('Stop session', true);
      applyBtn.addEventListener('click', (e) => { stopEv(e); approveSubmit(); }, true);
      retryBtn.addEventListener('click', (e) => { stopEv(e); resolveRecovery('retry'); }, true);
      skipBtn.addEventListener('click', (e) => { stopEv(e); stop('skip-job'); }, true);
      nextJobBtn.addEventListener('click', (e) => { stopEv(e); try { opts.onNextJob?.(); } catch {} stop('skip-next'); }, true);
      stopBtn.addEventListener('click', (e) => { stopEv(e); stop('user'); }, true);
      commandRow.append(applyBtn, retryBtn, skipBtn, nextJobBtn, stopBtn);

      const tuning = el('details', {}, { marginTop: '8px', color: '#8b8378' });
      const summary = el('summary', {}, { cursor: 'pointer', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '.12em', color: '#b08a5a' });
      summary.textContent = 'Session tuning';
      const tuneGrid = el('div', {}, { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', paddingTop: '8px' });
      const numberControl = (label, key, min, max, step) => {
        const wrap = el('label', {}, { fontSize: '9px', textTransform: 'uppercase', letterSpacing: '.08em' });
        const input = el('input', { type: 'number', min, max, step, value: state.settings[key] }, { width: '100%', marginTop: '4px', padding: '5px', boxSizing: 'border-box', background: '#15120e', border: '1px solid #3a342d', color: '#f4efe6' });
        wrap.append(document.createTextNode(label), input);
        input.addEventListener('change', () => { state.settings[key] = Math.max(min, Math.min(max, Number(input.value) || state.settings[key])); try { opts.onSettings?.({ ...state.settings }); } catch {} }, true);
        return wrap;
      };
      tuneGrid.append(numberControl('Pace x', 'pace', .25, 3, .25), numberControl('AI confidence', 'confidence', .5, 1, .05), numberControl('Stall retries', 'stallLimit', 1, 6, 1));
      tuning.append(summary, tuneGrid);
      panel.append(head, stepLine, telemetryEl, seenEl, logEl, row, commandRow, tuning);
      (document.body || document.documentElement).appendChild(panel);
      paintMode();
    } catch {}
  }
  function stopEv(e) { try { e.preventDefault(); e.stopPropagation(); } catch {} }

  function paintMode() {
    try {
      if (modeBtn) modeBtn.textContent = state.mode === 'run' ? '▶ Run' : '⏸ Step';
      if (nextBtn) nextBtn.style.opacity = state.mode === 'step' ? '1' : '0.45';
    } catch {}
  }
  function toggleMode() {
    state.mode = state.mode === 'run' ? 'step' : 'run';
    paintMode();
    // Leaving Step mode releases a pending approval gate so the run flows in Run mode.
    if (state.mode === 'run' && state.approveResolve) { const r = state.approveResolve; state.approveResolve = null; r('approved'); }
  }
  function approve() {
    if (state.recoveryResolve) return resolveRecovery('retry');
    if (state.approveResolve) { const r = state.approveResolve; state.approveResolve = null; r('approved'); }
  }
  function setPaused(paused) {
    state.paused = !!paused;
    if (pauseBtn) pauseBtn.textContent = state.paused ? 'Resume' : 'Pause';
    try { opts.onPause?.(state.paused); } catch {}
  }
  function approveSubmit() {
    if (!state.submitResolve) {
      try { if (stepLine) stepLine.textContent = 'Apply command armed - it will be used at the final submit step.'; } catch {}
      state.telemetry.submitArmed = true;
      return;
    }
    const r = state.submitResolve; state.submitResolve = null; r('apply');
  }
  function resolveRecovery(action) {
    if (!state.recoveryResolve) return;
    const r = state.recoveryResolve; state.recoveryResolve = null; r(action);
  }
  function markWrong() {
    if (state.recoveryResolve) return resolveRecovery('fix');
    state.wrong = true;
    // Release any pending Step gate with 'wrong' so the executor enters the correction flow.
    if (state.approveResolve) { const r = state.approveResolve; state.approveResolve = null; r('wrong'); }
  }
  function stop(reason) {
    state.stopped = true;
    cancelPick();
    if (state.approveResolve) { const r = state.approveResolve; state.approveResolve = null; r('stopped'); }
    if (state.submitResolve) { const r = state.submitResolve; state.submitResolve = null; r('stopped'); }
    if (state.recoveryResolve) { const r = state.recoveryResolve; state.recoveryResolve = null; r('skip'); }
    try { if (stepLine) stepLine.textContent = `Stopped (${safeText(reason, 20)})`; } catch {}
    try { if (typeof opts.onStop === 'function') opts.onStop(reason); } catch {}
  }

  // ---------- DevTools-style element picker (capture-phase, never triggers page) ----------
  let hi = null, pickResolve = null, listPanel = null;
  function ensureHighlight() {
    if (hi) return hi;
    hi = el('div', { id: 'jat11-pick-hi' }, {
      position: 'fixed', zIndex: Z, pointerEvents: 'none', boxSizing: 'border-box',
      border: '2px solid #b08a5a', background: 'rgba(176,138,90,0.15)', display: 'none',
      transition: 'all .03s linear',
    });
    (document.body || document.documentElement).appendChild(hi);
    return hi;
  }
  function moveHighlight(target) {
    try {
      const h = ensureHighlight();
      if (!target || !target.getBoundingClientRect) { h.style.display = 'none'; return; }
      const r = target.getBoundingClientRect();
      Object.assign(h.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    } catch {}
  }
  function isOwnUi(t) {
    try { return !!(t && t.closest && (t.closest('#jat11-teach') || t.closest('#jat11-pick-list') || t.closest('#jat11-pick-hi'))); }
    catch { return false; }
  }

  function onPickMove(e) {
    if (!state.picking) return;
    const t = e.target;
    if (isOwnUi(t)) { moveHighlight(null); return; }
    moveHighlight(t);
  }
  function onPickClick(e) {
    if (!state.picking) return;
    const t = e.target;
    if (isOwnUi(t)) return;   // let our own buttons work
    // NEVER let the page's own handler fire, NEVER submit.
    try { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); } catch {}
    finishPick(t);
  }
  function onPickKey(e) {
    if (!state.picking) return;
    if (e.key === 'Escape') { try { e.preventDefault(); e.stopPropagation(); } catch {} cancelPick(); }
  }

  function startPick() {
    if (state.picking) return;
    state.picking = true;
    ensureHighlight();
    try {
      document.addEventListener('mousemove', onPickMove, true);
      document.addEventListener('click', onPickClick, true);
      document.addEventListener('mousedown', onPickClick, true);   // some sites act on mousedown
      window.addEventListener('keydown', onPickKey, true);
    } catch {}
    try { if (stepLine) stepLine.textContent = 'Pick mode — click the CORRECT element (Esc to cancel)'; } catch {}
  }
  function teardownPick() {
    state.picking = false;
    try {
      document.removeEventListener('mousemove', onPickMove, true);
      document.removeEventListener('click', onPickClick, true);
      document.removeEventListener('mousedown', onPickClick, true);
      window.removeEventListener('keydown', onPickKey, true);
    } catch {}
    try { if (hi) hi.style.display = 'none'; } catch {}
  }
  function cancelPick() {
    if (!state.picking && !listPanel) { if (pickResolve) { const r = pickResolve; pickResolve = null; r(null); } return; }
    teardownPick();
    removeList();
    // a cancel resolves the correction promise with null (no change)
    if (pickResolve) { const r = pickResolve; pickResolve = null; r(null); }
  }
  function finishPick(target) {
    teardownPick();
    removeList();
    try {
      const bundle = buildLocator(target, opts.labelFn);
      openValuePrompt(target, bundle);
    } catch { if (pickResolve) { const r = pickResolve; pickResolve = null; r(null); } }
  }

  // ---------- detected-list picker ----------
  function buildList() {
    let items = [];
    try { items = (state.fieldsFn ? state.fieldsFn(state.root) : []) || []; } catch { items = []; }
    removeList();
    listPanel = el('div', { id: 'jat11-pick-list' }, {
      position: 'fixed', top: '92px', left: '50%', transform: 'translateX(-50%)', zIndex: Z,
      width: '440px', maxWidth: '92vw', maxHeight: '40vh', overflowY: 'auto',
      background: 'rgba(10,10,10,0.98)', color: '#f4efe6', border: '1px solid #3a342d',
      boxShadow: '0 18px 50px rgba(0,0,0,0.55)', font: '500 12px system-ui, sans-serif', padding: '8px',
    });
    const hint = el('div', {}, { color: '#b08a5a', fontSize: '10px', letterSpacing: '0.12em', textTransform: 'uppercase', margin: '4px 6px 8px' });
    hint.textContent = 'Or pick the correct field from the form';
    listPanel.append(hint);
    if (!items.length) {
      const empty = el('div', {}, { color: '#8b8378', padding: '6px' });
      empty.textContent = 'No fillable fields detected on this step.';
      listPanel.append(empty);
    }
    items.slice(0, 40).forEach((it) => {
      if (!it || !it.input) return;
      const b = el('button', { type: 'button' }, {
        display: 'block', width: '100%', textAlign: 'left', padding: '7px 8px', margin: '2px 0',
        border: '1px solid #241f1a', background: 'transparent', color: '#d9d2c6', cursor: 'pointer', font: 'inherit',
      });
      b.textContent = safeText(it.label || it.input.name || it.input.id || it.input.tagName, 70);
      b.addEventListener('mouseenter', () => { b.style.borderColor = '#b08a5a'; try { moveHighlight(it.input); } catch {} }, true);
      b.addEventListener('mouseleave', () => { b.style.borderColor = '#241f1a'; }, true);
      b.addEventListener('click', (e) => { stopEv(e); teardownPick(); removeList(); try { openValuePrompt(it.input, buildLocator(it.input, opts.labelFn)); } catch {} }, true);
      listPanel.append(b);
    });
    (document.body || document.documentElement).appendChild(listPanel);
  }
  function removeList() { try { if (listPanel) { listPanel.remove(); listPanel = null; } } catch {} }

  // ---------- value prompt + commit ----------
  let valuePanel = null;
  function openValuePrompt(target, bundle) {
    removeValuePrompt();
    valuePanel = el('div', { id: 'jat11-pick-val' }, {
      position: 'fixed', top: '92px', left: '50%', transform: 'translateX(-50%)', zIndex: Z,
      width: '440px', maxWidth: '92vw', background: 'rgba(10,10,10,0.98)', color: '#f4efe6',
      border: '1px solid #3a342d', borderTop: '2px solid #b08a5a', boxShadow: '0 18px 50px rgba(0,0,0,0.55)',
      font: '500 12px system-ui, sans-serif', padding: '12px',
    });
    try { moveHighlight(target); } catch {}
    const lab = el('div', {}, { color: '#d9d2c6', marginBottom: '8px' });
    lab.textContent = `Selected: ${safeText(bundle.label || bundle.selector || 'element', 60)}`;
    const input = el('input', { type: 'text', placeholder: 'Correct value (leave blank to fix only the locator)' }, {
      width: '100%', boxSizing: 'border-box', padding: '8px', marginBottom: '8px',
      background: '#15120e', border: '1px solid #3a342d', color: '#f4efe6', font: 'inherit',
    });
    try { input.value = readValue(target) || ''; } catch {}
    const row = el('div', {}, { display: 'flex', gap: '6px' });
    const save = el('button', { type: 'button' }, { flex: '2', padding: '8px', border: '1px solid #b08a5a', background: 'transparent', color: '#b08a5a', cursor: 'pointer', font: 'inherit', textTransform: 'uppercase', letterSpacing: '0.1em', fontSize: '10px' });
    save.textContent = 'Apply fix ✓';
    const cancelB = el('button', { type: 'button' }, { flex: '1', padding: '8px', border: '1px solid #3a342d', background: 'transparent', color: '#8b8378', cursor: 'pointer', font: 'inherit', textTransform: 'uppercase', letterSpacing: '0.1em', fontSize: '10px' });
    cancelB.textContent = 'Cancel';
    save.addEventListener('click', (e) => { stopEv(e); commitCorrection(target, bundle, input.value); }, true);
    cancelB.addEventListener('click', (e) => { stopEv(e); cancelPick(); }, true);
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { stopEv(e); cancelPick(); } if (e.key === 'Enter') { stopEv(e); commitCorrection(target, bundle, input.value); } }, true);
    row.append(save, cancelB);
    valuePanel.append(lab, input, row);
    (document.body || document.documentElement).appendChild(valuePanel);
    try { input.focus(); } catch {}
  }
  function removeValuePrompt() { try { if (valuePanel) { valuePanel.remove(); valuePanel = null; } } catch {} }

  function readValue(target) {
    try {
      const t = (target.type || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio') return target.checked ? (target.value || 'on') : '';
      return target.value != null ? String(target.value) : '';
    } catch { return ''; }
  }
  function inferAction(target) {
    try {
      const tag = String(target.tagName || '').toLowerCase();
      const t = (target.type || '').toLowerCase();
      if (tag === 'select') return 'select';
      if (t === 'checkbox' || t === 'radio' || tag === 'button') return 'click';
      return 'fill';
    } catch { return 'fill'; }
  }

  function commitCorrection(target, bundle, value) {
    teardownPick();
    removeList();
    removeValuePrompt();
    try { if (hi) hi.style.display = 'none'; } catch {}
    const replacement = {
      selector: bundle.selector || null,
      xpath: bundle.xpath || null,
      attrs: bundle.attrs || null,
      html: bundle.html || null,
      label: bundle.label || null,
      value: value != null && String(value).trim() ? String(value) : null,
      fieldType: (target && (target.type || (target.tagName || '').toLowerCase())) || null,
      action: inferAction(target),
    };
    if (pickResolve) { const r = pickResolve; pickResolve = null; r(replacement); }
  }

  // ---------- brief "fixed ✓" confirmation ----------
  function flashFixed() {
    try {
      const t = el('div', {}, {
        position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)', zIndex: Z,
        background: '#059669', color: '#fff', padding: '8px 14px', borderRadius: '8px',
        font: '600 12px system-ui, sans-serif', boxShadow: '0 4px 16px rgba(0,0,0,.35)',
      });
      t.textContent = 'fixed ✓ — used for the rest of this run';
      (document.body || document.documentElement).appendChild(t);
      setTimeout(() => { try { t.remove(); } catch {} }, 1600);
    } catch {}
  }

  // ============================================================
  // Public API (the executor drives these)
  // ============================================================
  return {
    show() { buildPanel(); },
    mode() { return state.mode; },
    stopped() { return state.stopped; },
    setStep(info) {
      try {
        state.root = (info && info.root) || state.root;
        if (stepLine) stepLine.textContent = safeText(info && info.text, 120) || 'Working…';
      } catch {}
    },
    setTelemetry(info = {}) {
      state.telemetry = { ...state.telemetry, ...info };
      try {
        const values = {
          stage: state.telemetry.stage || 'scanning', step: state.telemetry.step ?? '-',
          fields: state.telemetry.fields ?? '-', recovery: state.telemetry.recovery || 'healthy',
        };
        for (const [key, value] of Object.entries(values)) {
          const target = telemetryEl?.querySelector(`[data-metric="${key}"] [data-value]`);
          if (target) target.textContent = safeText(value, 36);
        }
        if (seenEl && info.seen) seenEl.textContent = 'Robot sees: ' + safeText(info.seen, 420);
      } catch {}
    },
    log(level, message) {
      try {
        if (!logEl) return;
        const line = el('div', {}, { color: level === 'err' ? '#c25b5b' : level === 'ok' ? '#7fae7f' : level === 'warn' ? '#c9a373' : '#8b8378' });
        line.textContent = safeText(message, 240); logEl.append(line); logEl.scrollTop = logEl.scrollHeight;
      } catch {}
    },
    settings() { return { ...state.settings }; },
    async beforeSubmit(info) {
      this.setStep(info);
      if (state.telemetry.submitArmed) { state.telemetry.submitArmed = false; return 'apply'; }
      try { if (stepLine) stepLine.textContent = 'Final submit is ready. Inspect the page, then choose Apply this job.'; } catch {}
      return await new Promise((resolve) => { state.submitResolve = resolve; });
    },
    async recoveryDecision(info = {}) {
      this.setTelemetry({ recovery: info.reason || 'attention needed' });
      try { if (stepLine) stepLine.textContent = safeText(info.text || 'The page did not advance. Retry, fix the page, or skip.', 180); } catch {}
      return await new Promise((resolve) => { state.recoveryResolve = resolve; });
    },
    // Gate before each action. In Step mode, resolves on Approve; in Run mode, resolves
    // immediately (but a prior "Wrong" surfaces). Returns 'approved' | 'wrong' | 'stopped'.
    async beforeAction(info) {
      if (state.stopped) return 'stopped';
      this.setStep(info);
      if (state.wrong) { state.wrong = false; return 'wrong'; }
      if (state.mode === 'run') return 'approved';
      // Step mode → wait for Approve / Wrong / Stop.
      return await new Promise((resolve) => { state.approveResolve = resolve; });
    },
    // Did the user hit "Wrong" during a Run-mode pace? (polled by the executor between actions)
    consumeWrong() { if (state.wrong) { state.wrong = false; return true; } return false; },
    // Open the correction UI for the given step. Resolves with the replacement bundle
    // (locator + value + action + label) or null if the user dismissed it.
    requestCorrection(stepInfo) {
      buildPanel();
      return new Promise((resolve) => {
        pickResolve = resolve;
        try { if (stepLine) stepLine.textContent = `Fixing: ${safeText(stepInfo && stepInfo.label, 70)}`; } catch {}
        startPick();
        buildList();
      });
    },
    confirmFixed() { flashFixed(); },
    destroy() {
      try { teardownPick(); } catch {}
      removeList(); removeValuePrompt();
      try { if (hi) hi.remove(); } catch {}
      try { if (panel) panel.remove(); } catch {}
      hi = null; panel = null;
    },
  };
}
