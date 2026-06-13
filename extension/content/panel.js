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

function ensureRoot() {
  injectStyles();
  let root = document.getElementById(PANEL_ID);
  if (root) return root;
  root = document.createElement('div');
  root.id = PANEL_ID;
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add('visible'));
  return root;
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
  const root = ensureRoot();
  const currentIdx = STAGE_LABELS.findIndex((s) => s.id === state.stage);
  const isSubmitted = state.stage === 'submitted';
  root.classList.toggle('captured', isSubmitted);

  const ctx = state.ctx || {};
  const titleLine = ctx.title ? esc(ctx.title) : 'Detecting…';
  const coLine = ctx.company ? `<div class="jat-co">${esc(ctx.company)}</div>` : '';
  const locLine = ctx.location ? `<div class="jat-loc">${esc(ctx.location)}</div>` : '';

  const stagesHtml = STAGE_LABELS.map((s, i) =>
    `<div class="jat-stage ${stageClass(i, currentIdx)}"><span class="dot"></span>${s.label}</div>`,
  ).join('');

  const resumeLine = state.resumeName
    ? `<div class="jat-line">${esc(state.resumeName)}</div>`
    : '<div class="jat-line muted">No resume picked yet</div>';

  const answersLine = state.answersCount
    ? `<div class="jat-line">${state.answersCount} fields captured</div>`
    : '<div class="jat-line muted">No answers captured yet</div>';

  const saveLine = state.saveState === 'saved'
    ? '<div class="jat-save ok">Saved to tracker ✓</div>'
    : state.saveState === 'queued'
      ? '<div class="jat-save queued">App offline — queued ⏳</div>'
      : state.saveState === 'failed'
        ? '<div class="jat-save failed">Save failed — open the popup ⚠</div>'
        : '';

  const eyebrowText = isSubmitted ? 'JAT · CAPTURED' : 'JAT · CAPTURING';
  const pct = STAGE_PCT[state.stage] || 8;
  const stageLabel = (STAGE_LABELS.find((s) => s.id === state.stage) || {}).label || 'Detecting';

  root.classList.toggle('mini', collapsed);
  root.innerHTML = `
    <div class="jat-progress"><i style="width:${pct}%"></i></div>
    <div class="jat-pill" data-act="expand" title="Expand"><span class="dot"></span><span class="lbl">JAT · ${esc(stageLabel)}</span></div>
    <div class="jat-h">
      <div class="jat-topbar">
        <div class="jat-eyebrow">${eyebrowText}</div>
        <button class="jat-collapse" data-act="collapse" title="Collapse">‒</button>
      </div>
      <div class="jat-title">${titleLine}</div>
      ${coLine}
      ${locLine}
    </div>
    <div class="jat-section">
      <div class="jat-section-label">Stage</div>
      <div class="jat-stages">${stagesHtml}</div>
    </div>
    <div class="jat-section">
      <div class="jat-section-label">Resume</div>
      ${resumeLine}
    </div>
    <div class="jat-section">
      <div class="jat-section-label">Answers</div>
      ${answersLine}
      ${saveLine ? `<div style="margin-top:8px">${saveLine}</div>` : ''}
    </div>
    <div class="jat-actions">
      <button class="jat-btn" data-act="dismiss">${isSubmitted ? 'Done' : 'Dismiss'}</button>
    </div>
  `;
  root.querySelector('[data-act="dismiss"]').addEventListener('click', () => {
    if (onDismiss) onDismiss();
    dismissPanel();
  });
  root.querySelector('[data-act="collapse"]').addEventListener('click', () => {
    collapsed = true;
    try { sessionStorage.setItem('jat11.panelCollapsed', '1'); } catch {}
    root.classList.add('mini');
  });
  root.querySelector('[data-act="expand"]').addEventListener('click', () => {
    collapsed = false;
    try { sessionStorage.setItem('jat11.panelCollapsed', '0'); } catch {}
    root.classList.remove('mini');
  });

  if (isSubmitted) setTimeout(() => dismissPanel(), 7000);
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
  const root = document.getElementById(PANEL_ID);
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
