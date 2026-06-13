// JAT v11 — capture panel (atelier styling, silent-mode aware).
// v10 base plus: a save-state line (saved ✓ / queued ⏳ / failed ⚠), and the
// unsure prompt is actually wired (with a "Not a job" option that suppresses
// the host permanently — the fix for un-dismissable prompts on random sites).

const PANEL_ID = 'jat11-panel';
const STYLE_ID = 'jat11-panel-style';

const STAGE_LABELS = [
  { id: 'detected',    label: 'Detected' },
  { id: 'started',     label: 'Apply opened' },
  { id: 'progressing', label: 'In progress' },
  { id: 'submitted',   label: 'Submitted' },
];
const STAGE_PCT = { detected: 18, started: 42, progressing: 72, submitted: 100 };

// Collapsed-to-pill preference persists across re-renders within the tab.
let collapsed = false;
try { collapsed = sessionStorage.getItem('jat11.panelCollapsed') === '1'; } catch {}

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${PANEL_ID} {
      position: fixed;
      right: 16px;
      top: 50%;
      transform: translateY(-50%) translateX(8px);
      width: 280px;
      z-index: 2147483646;
      background: #0a0a0a;
      color: #d9d2c6;
      font-family: "Inter", -apple-system, "Segoe UI", system-ui, sans-serif;
      font-size: 13px;
      border: 1px solid #3a342d;
      border-left: 2px solid #b08a5a;
      box-shadow: 0 30px 60px rgba(0,0,0,0.5), inset 0 1px 0 rgba(244,239,230,0.04);
      opacity: 0;
      transition: opacity 220ms cubic-bezier(0.16,1,0.3,1), transform 220ms cubic-bezier(0.16,1,0.3,1);
      pointer-events: auto;
    }
    #${PANEL_ID}.visible { opacity: 1; transform: translateY(-50%) translateX(0); }
    #${PANEL_ID}.captured {
      border-left-color: #c9a373;
      box-shadow: 0 30px 60px rgba(0,0,0,0.5), inset 0 1px 0 rgba(244,239,230,0.04), 0 0 24px rgba(176,138,90,0.25);
    }
    #${PANEL_ID} .jat-h { padding: 14px 16px 12px; border-bottom: 1px solid #3a342d; }
    #${PANEL_ID} .jat-eyebrow {
      font-size: 10px; letter-spacing: 0.3em; text-transform: uppercase;
      color: #b08a5a; font-weight: 500;
    }
    #${PANEL_ID}.captured .jat-eyebrow { color: #c9a373; }
    #${PANEL_ID} .jat-title {
      margin: 6px 0 0; font-size: 14px; font-weight: 500; color: #f4efe6;
      line-height: 1.3; letter-spacing: -0.005em;
    }
    #${PANEL_ID} .jat-co { font-size: 12px; color: #d9d2c6; margin-top: 2px; }
    #${PANEL_ID} .jat-loc { font-size: 11px; color: #8b8378; margin-top: 2px; }
    #${PANEL_ID} .jat-section { padding: 12px 16px; border-bottom: 1px solid #3a342d; }
    #${PANEL_ID} .jat-section:last-of-type { border-bottom: 0; }
    #${PANEL_ID} .jat-section-label {
      font-size: 9px; letter-spacing: 0.32em; text-transform: uppercase;
      color: #8b8378; font-weight: 500; margin-bottom: 8px;
    }
    #${PANEL_ID} .jat-stages { display: grid; gap: 6px; }
    #${PANEL_ID} .jat-stage {
      display: flex; align-items: center; gap: 8px;
      font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: #8b8378;
    }
    #${PANEL_ID} .jat-stage .dot { width: 6px; height: 6px; border: 1px solid #3a342d; }
    #${PANEL_ID} .jat-stage.active { color: #f4efe6; }
    #${PANEL_ID} .jat-stage.active .dot { background: #b08a5a; border-color: #b08a5a; }
    #${PANEL_ID} .jat-stage.done .dot { background: #b08a5a; border-color: #b08a5a; opacity: 0.55; }
    #${PANEL_ID}.captured .jat-stage.active .dot { background: #c9a373; border-color: #c9a373; box-shadow: 0 0 8px #c9a373; }
    #${PANEL_ID} .jat-line {
      font-size: 12px; color: #d9d2c6; font-variant-numeric: tabular-nums; word-break: break-all;
    }
    #${PANEL_ID} .jat-line.muted { color: #8b8378; font-size: 11px; }
    #${PANEL_ID} .jat-save { font-size: 11px; letter-spacing: 0.08em; }
    #${PANEL_ID} .jat-save.ok { color: #7fae7f; }
    #${PANEL_ID} .jat-save.queued { color: #b08a5a; }
    #${PANEL_ID} .jat-save.failed { color: #c25b5b; }
    #${PANEL_ID} .jat-actions { padding: 10px 16px 14px; display: flex; gap: 8px; }
    #${PANEL_ID} .jat-btn {
      flex: 1; font: inherit; font-size: 10px; font-weight: 500;
      letter-spacing: 0.2em; text-transform: uppercase;
      padding: 9px 10px; border: 1px solid #3a342d; background: transparent;
      color: #8b8378; cursor: pointer;
      transition: color 200ms cubic-bezier(0.16,1,0.3,1), border-color 200ms cubic-bezier(0.16,1,0.3,1);
    }
    #${PANEL_ID} .jat-btn:hover { color: #b08a5a; border-color: #b08a5a; }

    #${PANEL_ID} .jat-progress { height: 2px; background: #241f1a; position: relative; overflow: hidden; }
    #${PANEL_ID} .jat-progress > i {
      position: absolute; left: 0; top: 0; bottom: 0; width: 8%;
      background: linear-gradient(90deg, #b08a5a, #c9a373);
      transition: width 420ms cubic-bezier(0.16,1,0.3,1);
    }
    #${PANEL_ID}.captured .jat-progress > i { background: linear-gradient(90deg, #c9a373, #e3cda0); box-shadow: 0 0 10px #c9a373; }
    #${PANEL_ID} .jat-topbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    #${PANEL_ID} .jat-collapse {
      background: none; border: 0; color: #8b8378; cursor: pointer;
      font-size: 15px; line-height: 1; padding: 0 2px 4px; transition: color 160ms cubic-bezier(0.16,1,0.3,1);
    }
    #${PANEL_ID} .jat-collapse:hover { color: #b08a5a; }
    /* collapsed pill */
    #${PANEL_ID}.mini { width: auto; max-width: 220px; }
    #${PANEL_ID}.mini .jat-h, #${PANEL_ID}.mini .jat-section, #${PANEL_ID}.mini .jat-actions { display: none; }
    #${PANEL_ID} .jat-pill { display: none; align-items: center; gap: 9px; padding: 11px 15px; cursor: pointer; white-space: nowrap; }
    #${PANEL_ID}.mini .jat-pill { display: flex; }
    #${PANEL_ID} .jat-pill .dot { width: 7px; height: 7px; background: #b08a5a; flex-shrink: 0; }
    #${PANEL_ID}.captured .jat-pill .dot { background: #c9a373; box-shadow: 0 0 8px #c9a373; }
    #${PANEL_ID} .jat-pill .lbl { font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: #d9d2c6; }
  `;
  document.head.appendChild(style);
}

let panelEl = null;
let fadeTimer = null;
let onDismissCb = null;

function attachTarget() { return document.body || document.documentElement; }

function buildSkeleton(root) {
  root.innerHTML = `
    <div class="jat-progress"><i></i></div>
    <div class="jat-pill" data-act="expand" title="Expand"><span class="dot"></span><span class="lbl"></span></div>
    <div class="jat-h">
      <div class="jat-topbar">
        <div class="jat-eyebrow"></div>
        <button class="jat-collapse" data-act="collapse" title="Collapse">‒</button>
      </div>
      <div class="jat-title"></div>
      <div class="jat-co"></div>
      <div class="jat-loc"></div>
    </div>
    <div class="jat-section"><div class="jat-section-label">Stage</div><div class="jat-stages"></div></div>
    <div class="jat-section"><div class="jat-section-label">Resume</div><div class="jat-resume jat-line muted"></div></div>
    <div class="jat-section"><div class="jat-section-label">Answers</div><div class="jat-answers jat-line muted"></div><div class="jat-save-wrap"></div></div>
    <div class="jat-actions"><button class="jat-btn" data-act="dismiss">Dismiss</button></div>
  `;
  root.querySelector('[data-act="dismiss"]').addEventListener('click', () => {
    if (onDismissCb) { try { onDismissCb(); } catch {} }
    dismissPanel();
  });
  root.querySelector('[data-act="collapse"]').addEventListener('click', () => {
    collapsed = true; try { sessionStorage.setItem('jat11.panelCollapsed', '1'); } catch {}
    root.classList.add('mini');
  });
  root.querySelector('[data-act="expand"]').addEventListener('click', () => {
    collapsed = false; try { sessionStorage.setItem('jat11.panelCollapsed', '0'); } catch {}
    root.classList.remove('mini');
  });
}

function ensureRoot() {
  injectStyles();
  let root = document.getElementById(PANEL_ID);
  if (root) { panelEl = root; if (!root.querySelector('.jat-stages')) buildSkeleton(root); return root; }
  root = document.createElement('div');
  root.id = PANEL_ID;
  buildSkeleton(root);
  attachTarget().appendChild(root);
  panelEl = root;
  requestAnimationFrame(() => root.classList.add('visible'));
  return root;
}

function setText(root, sel, text) {
  const el = root.querySelector(sel);
  if (el && el.textContent !== text) el.textContent = text;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function stageClass(targetIdx, currentIdx) {
  if (targetIdx < currentIdx) return 'done';
  if (targetIdx === currentIdx) return 'active';
  return '';
}

export function renderPanel(state, { onDismiss } = {}) {
  if (onDismiss) onDismissCb = onDismiss;
  // Re-attach in place if a SPA tore the panel out of the DOM — re-appending the
  // SAME node (content + listeners intact) avoids the disappear/reappear flicker.
  if (panelEl && !panelEl.isConnected) attachTarget().appendChild(panelEl);
  const root = (panelEl && panelEl.isConnected) ? panelEl : ensureRoot();

  const currentIdx = STAGE_LABELS.findIndex((s) => s.id === state.stage);
  const isSubmitted = state.stage === 'submitted';
  root.classList.toggle('captured', isSubmitted);
  root.classList.toggle('mini', collapsed);
  if (!root.classList.contains('visible')) requestAnimationFrame(() => root.classList.add('visible'));

  const ctx = state.ctx || {};
  // ---- in-place field updates (no innerHTML churn → no flicker) ----
  setText(root, '.jat-eyebrow', isSubmitted ? 'JAT · CAPTURED' : 'JAT · CAPTURING');
  setText(root, '.jat-title', ctx.title || 'Detecting…');
  const co = root.querySelector('.jat-co'); co.textContent = ctx.company || ''; co.style.display = ctx.company ? '' : 'none';
  const loc = root.querySelector('.jat-loc'); loc.textContent = ctx.location || ''; loc.style.display = ctx.location ? '' : 'none';
  setText(root, '.jat-pill .lbl', 'JAT · ' + ((STAGE_LABELS.find((s) => s.id === state.stage) || {}).label || 'Detecting'));
  root.querySelector('.jat-progress > i').style.width = (STAGE_PCT[state.stage] || 8) + '%';

  const stagesEl = root.querySelector('.jat-stages');
  const stagesHtml = STAGE_LABELS.map((s, i) => `<div class="jat-stage ${stageClass(i, currentIdx)}"><span class="dot"></span>${s.label}</div>`).join('');
  if (stagesEl.__sig !== stagesHtml) { stagesEl.innerHTML = stagesHtml; stagesEl.__sig = stagesHtml; }

  const resumeEl = root.querySelector('.jat-resume');
  resumeEl.className = 'jat-resume jat-line' + (state.resumeName ? '' : ' muted');
  resumeEl.textContent = state.resumeName || 'No resume picked yet';

  const ansEl = root.querySelector('.jat-answers');
  ansEl.className = 'jat-answers jat-line' + (state.answersCount ? '' : ' muted');
  ansEl.textContent = state.answersCount ? `${state.answersCount} fields captured` : 'No answers captured yet';

  const saveWrap = root.querySelector('.jat-save-wrap');
  const saveKey = state.saveState || '';
  if (saveWrap.__sig !== saveKey) {
    saveWrap.__sig = saveKey;
    if (state.saveState) {
      const cls = state.saveState === 'saved' ? 'ok' : state.saveState;
      const txt = state.saveState === 'saved' ? 'Saved to tracker ✓'
        : state.saveState === 'queued' ? 'App offline — queued ⏳' : 'Save failed — open the popup ⚠';
      saveWrap.innerHTML = `<div class="jat-save ${cls}" style="margin-top:8px">${esc(txt)}</div>`;
    } else saveWrap.innerHTML = '';
  }

  setText(root, '.jat-actions [data-act="dismiss"]', isSubmitted ? 'Done' : 'Dismiss');

  if (isSubmitted && !fadeTimer) fadeTimer = setTimeout(() => dismissPanel(), 7000);
}

export function paintSaveState(saveState) {
  const root = document.getElementById(PANEL_ID);
  if (!root) return;
  const el = root.querySelector('.jat-save');
  if (el) {
    el.className = 'jat-save ' + (saveState === 'saved' ? 'ok' : saveState);
  }
}

export function dismissPanel() {
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  const root = document.getElementById(PANEL_ID) || panelEl;
  panelEl = null;
  if (!root) return;
  root.classList.remove('visible');
  setTimeout(() => { try { root.remove(); } catch {} }, 240);
}

// Mid-confidence prompt. "Not a job" tells the detector to permanently
// suppress this host — easy, one-click, and it sticks.
export function promptUnsure(ctx, { onYes, onNo }) {
  injectStyles();
  let root = document.getElementById(PANEL_ID);
  if (!root) { root = document.createElement('div'); root.id = PANEL_ID; document.body.appendChild(root); }
  requestAnimationFrame(() => root.classList.add('visible'));
  root.innerHTML = `
    <div class="jat-h">
      <div class="jat-eyebrow">JAT · UNSURE</div>
      <div class="jat-title">Track this application?</div>
      <div class="jat-co">${esc(ctx.title || 'Untitled')}${ctx.company ? ' · ' + esc(ctx.company) : ''}</div>
    </div>
    <div class="jat-actions">
      <button class="jat-btn" data-act="no" title="Never ask again on ${esc(location.hostname)}">Not a job</button>
      <button class="jat-btn" data-act="yes" style="color:#b08a5a;border-color:#b08a5a">Yes, track</button>
    </div>
  `;
  root.querySelector('[data-act="yes"]').addEventListener('click', () => { onYes?.(); });
  root.querySelector('[data-act="no"]').addEventListener('click', () => { onNo?.(); dismissPanel(); });
  // Auto-fade if ignored — never linger in the user's way.
  setTimeout(() => {
    const cur = document.getElementById(PANEL_ID);
    if (cur && cur.querySelector('[data-act="no"]')) dismissPanel();
  }, 12000);
}
