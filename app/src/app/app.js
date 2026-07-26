// JAT v11 dashboard SPA.
// The SAME file runs in two hosts:
//   • Chrome extension page  (chrome-extension://…/app/app.html)
//       token via chrome.runtime.sendMessage({type:'get-token'})
//   • Electron renderer      (file://…/app/app.html + preload bridge)
//       token via window.jatDesktop.boot() → { token, version, port }
// All data flows through the desktop app's REST API (X-JAT-Token header);
// live updates ride the SSE /stream. No frameworks, no build step.
//
// v10 lesson baked in: NEVER blow away the DOM while the user is typing.
// List views refresh on SSE only when no input/textarea/select is focused and
// no overlay is open; detail/editor views never auto-refresh — they show a
// "Data changed — refresh" pill instead. 30s polling only while SSE is down.

import { THEMES, applyTheme, DEFAULT_THEME } from './lib/themes.js';

// ---------- Status FSM (mirror of extension/lib/status.js — keep in lockstep) ----------
const STATUSES = [
  { id: 'started',         label: 'Started',          order: 10 },
  { id: 'submitted',       label: 'Submitted',        order: 20 },
  { id: 'contacted',       label: 'Contacted',        order: 30 },
  { id: 'assessment',      label: 'Assessment',       order: 35 },
  { id: 'interview_1',     label: 'First interview',  order: 40 },
  { id: 'interview_2',     label: 'Second interview', order: 50 },
  { id: 'interview_final', label: 'Final interview',  order: 60 },
  { id: 'offer',           label: 'Offer',            order: 70 },
  { id: 'hired',           label: 'Hired',            order: 80 },
  { id: 'rejected',        label: 'Rejected',         order: 90 },
  { id: 'withdrawn',       label: 'Withdrawn',        order: 91 },
  { id: 'ghosted',         label: 'Ghosted',          order: 92 },
];
const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.id, s.label]));
const STATUS_INDEX = Object.fromEntries(STATUSES.map((s, i) => [s.id, i]));
const PIPELINE_ACTIVE = ['submitted', 'contacted', 'assessment', 'interview_1', 'interview_2', 'interview_final', 'offer'];

const QUEUE_STATE_ORDER = ['running', 'awaiting_review', 'parked', 'awaiting_input', 'queued', 'scheduled', 'done', 'failed', 'skipped'];
const QUEUE_STATE_LABEL = {
  running: 'Running', awaiting_review: 'Awaiting review', parked: 'Set aside — needs input',
  awaiting_input: 'Awaiting input',
  queued: 'Queued', scheduled: 'Scheduled', done: 'Done', failed: 'Failed', skipped: 'Skipped',
};

const LS_THEME = 'jat11.theme';
const LS_FILTERS = 'jat11.apps.filters';
const LS_PIPELINE = 'jat11.pipeline.prefs';

const DOC_ROLES = [
  { id: 'resume', label: 'Resume' },
  { id: 'cover_letter', label: 'Cover letter' },
  { id: 'other', label: 'Other' },
];
const DOC_ROLE_LABEL = Object.fromEntries(DOC_ROLES.map((r) => [r.id, r.label]));

// ---------- Tiny utilities ----------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmtFull = (iso) => { if (!iso) return ''; try { return new Date(iso).toLocaleString(); } catch { return ''; } };
const fmtRel = (iso) => {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d`;
  try { return new Date(iso).toLocaleDateString(); } catch { return '—'; }
};
const relHtml = (iso) => iso
  ? `<span class="num" title="${esc(fmtFull(iso))}">${esc(fmtRel(iso))}</span>`
  : '<span class="muted">—</span>';
const dateHtml = (iso) => iso
  ? `<span class="num" title="${esc(fmtFull(iso))}">${esc(new Date(iso).toLocaleDateString())}</span>`
  : '<span class="muted">—</span>';
const daysIn = (iso) => {
  if (!iso) return '';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? 'today' : `${d}d in stage`;
};
const fmtBytes = (n) => {
  if (!n && n !== 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
};
function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function bufToB64(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('could not read file'));
    r.readAsDataURL(file);
  });
}
const skeletonHtml = () => `
  <div class="skeleton">
    <div class="sk-head">
      <div style="flex:1;max-width:240px"><div class="sk-line tall" style="width:55%"></div><div class="sk-line" style="width:80%;margin-top:12px"></div></div>
      <div class="sk-line" style="width:120px;height:34px"></div>
    </div>
    <div class="sk-grid" style="margin-bottom:22px">
      <div><div class="sk-line" style="width:60%"></div><div class="sk-line tall" style="width:40%;margin-top:12px"></div></div>
      <div><div class="sk-line" style="width:60%"></div><div class="sk-line tall" style="width:40%;margin-top:12px"></div></div>
      <div><div class="sk-line" style="width:60%"></div><div class="sk-line tall" style="width:40%;margin-top:12px"></div></div>
      <div><div class="sk-line" style="width:60%"></div><div class="sk-line tall" style="width:40%;margin-top:12px"></div></div>
    </div>
    <div class="sk-card">
      <div class="sk-line" style="width:30%"></div>
      <div class="sk-line" style="width:100%"></div>
      <div class="sk-line" style="width:92%"></div>
      <div class="sk-line" style="width:96%"></div>
      <div class="sk-line" style="width:70%"></div>
    </div>
  </div>`;
const emptyHtml = (eyebrow, title, sub) =>
  `<div class="empty"><div class="empty-mark"></div>
   <div class="empty-eyebrow">${esc(eyebrow)}</div>
   <div class="empty-title">${esc(title)}</div>
   <div class="empty-sub">${esc(sub)}</div></div>`;
const statusChip = (s) =>
  `<span class="status-chip" data-status="${esc(s)}"><span class="dot"></span>${esc(STATUS_LABEL[s] || s)}</span>`;
const fitBadgeHtml = (score) => (score == null || score === '') ? ''
  : `<span class="fit-badge ${score >= 70 ? 'good' : score >= 45 ? 'mid' : 'low'}" title="AI fit score">${esc(score)}</span>`;
// Provenance badge — was this application submitted BY THE AUTO-APPLY PIPELINE or BY HAND?
// `via` is set server-side (db.annotateAutoApply): 'auto' = a completed auto-apply task
// exists, 'manual' = reached submitted+ without one, null = not submitted yet.
const viaBadge = (j) => {
  if (!j) return '';
  if (j.via === 'auto') return `<span class="via-badge via-auto" title="Submitted by the auto-apply pipeline">⚡ Auto</span>`;
  if (j.via === 'auto-assisted') return `<span class="via-badge via-assisted" title="Auto-apply set it up; you finished or corrected it">⚡ Auto (assisted)</span>`;
  if (j.via === 'manual') return `<span class="via-badge via-manual" title="Applied to by hand">✋ Manual</span>`;
  if (j.autoApply) return `<span class="via-badge via-pipeline" title="In the auto-apply pipeline (not submitted yet)">⚡ Pipeline</span>`;
  return '';
};
const statusOptions = (sel) =>
  STATUSES.map((s) => `<option value="${s.id}" ${sel === s.id ? 'selected' : ''}>${esc(s.label)}</option>`).join('');

// ---------- State ----------
const state = {
  host: 'web',                       // 'extension' | 'desktop' | 'web'
  token: null,
  base: 'http://localhost:7744',
  version: '',
  settings: null,                    // cached merged settings
  online: false,
  sse: null,
  sseOk: false,
  pollTimer: null,
  lastWrite: 0,                      // ts of our last non-GET (suppresses own-change pills)
  route: { path: '/' },
  selection: new Set(),              // bulk selection on the applications list
  profileSel: null,
  apps: (() => {
    const def = { q: '', status: 'all', source: 'all', via: 'all', sort: 'updatedAt', dir: 'desc' };
    try { return { ...def, ...JSON.parse(localStorage.getItem(LS_FILTERS) || '{}'), q: '' }; }
    catch { return def; }
  })(),
  docsFilter: { role: 'all', q: '' },
  board: (() => {
    const def = { q: '', source: 'all', minFit: 0, sort: 'updatedAt', dir: 'desc', density: 'comfortable', hiddenCols: [], collapsed: [] };
    try { return { ...def, ...JSON.parse(localStorage.getItem(LS_PIPELINE) || '{}'), q: '' }; }
    catch { return def; }
  })(),
};
function persistBoard() {
  try {
    const { source, minFit, sort, dir, density, hiddenCols, collapsed } = state.board;
    localStorage.setItem(LS_PIPELINE, JSON.stringify({ source, minFit, sort, dir, density, hiddenCols, collapsed }));
  } catch {}
}
const HOST_LABEL = { extension: 'Extension', desktop: 'Desktop', web: 'Web' };
function persistFilters() {
  try {
    const { status, source, via, sort, dir } = state.apps;
    localStorage.setItem(LS_FILTERS, JSON.stringify({ status, source, via, sort, dir }));
  } catch {}
}

// ---------- API ----------
async function api(path, opts = {}) {
  const { method = 'GET', body, timeoutMs = 20000, raw = false } = opts;
  let res;
  try {
    res = await fetch(state.base + path, {
      method,
      headers: {
        'X-JAT-Token': state.token || '',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = new Error('app unreachable');
    err.status = 0;
    throw err;
  }
  if (method !== 'GET') state.lastWrite = Date.now();
  if (res.status === 401) {
    renderNotConnected();
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  }
  if (raw) {
    if (!res.ok) { const err = new Error('HTTP ' + res.status); err.status = res.status; throw err; }
    return res;
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}
async function getSettings(force = false) {
  if (!force && state.settings) return state.settings;
  const r = await api('/settings');
  state.settings = r.settings || {};
  state.secretsPresent = r.secretsPresent || {};   // which secrets are saved (keys are redacted out of the response)
  return state.settings;
}

// ---------- Theme ----------
function setTheme(id, persist = true) {
  applyTheme(id);
  try { localStorage.setItem(LS_THEME, id); } catch {}
  if (persist) {
    api('/settings', { method: 'PATCH', body: { appearance: { theme: id } } })
      .then((r) => { state.settings = r.settings || state.settings; })
      .catch((e) => toast('Could not save theme: ' + e.message, 'danger'));
  }
}

// ---------- Toasts ----------
function toast(msg, kind = 'info', opts = {}) {
  const box = $('#toasts');
  if (!box) return () => {};
  const t = document.createElement('div');
  t.className = 'toast' + (kind && kind !== 'info' ? ' ' + kind : '');
  const span = document.createElement('span');
  span.className = 'toast-msg';
  span.textContent = msg;
  t.appendChild(span);
  let closed = false;
  const close = () => { if (closed) return; closed = true; t.remove(); };
  if (opts.actionLabel) {
    const b = document.createElement('button');
    b.className = 'btn-link';
    b.textContent = opts.actionLabel;
    b.addEventListener('click', () => { close(); try { opts.onAction && opts.onAction(); } catch {} });
    t.appendChild(b);
  }
  const x = document.createElement('button');
  x.className = 'toast-x';
  x.textContent = '×';
  x.setAttribute('aria-label', 'Dismiss');
  x.addEventListener('click', close);
  t.appendChild(x);
  box.appendChild(t);
  const ttl = opts.ttl !== undefined ? opts.ttl : (kind === 'danger' ? 8000 : 5000);
  if (ttl > 0) setTimeout(close, ttl);
  return close;
}
const errToast = (e, prefix = '') => toast((prefix ? prefix + ': ' : '') + (e && e.message ? e.message : String(e)), 'danger');
const undoToast = (msg, onUndo) => toast(msg, 'info', { actionLabel: 'Undo', onAction: onUndo, ttl: 5000 });

// ---------- Overlays (modal + palette) ----------
function openOverlay(node) {
  const root = $('#overlay-root');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.appendChild(node);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.remove(); });
  root.appendChild(ov);
  return () => ov.remove();
}
function closeTopOverlay() {
  const ovs = document.querySelectorAll('#overlay-root .overlay');
  if (ovs.length) { ovs[ovs.length - 1].remove(); return true; }
  return false;
}
function closeAllOverlays() {
  document.querySelectorAll('#overlay-root .overlay').forEach((o) => o.remove());
}

// ---------- Custom confirm / prompt dialogs ----------
// We never use the browser's native confirm()/prompt() — they render as OS dialogs.
// These resolve on ANY dismissal path (button, click-outside, the global Escape
// handler, or closeAllOverlays() on navigation) via a removal observer.
function dialogOverlay(node, onDismiss) {
  const root = $('#overlay-root');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.appendChild(node);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.remove(); });
  root.appendChild(ov);
  const obs = new MutationObserver(() => {
    if (!document.contains(ov)) { obs.disconnect(); try { onDismiss(); } catch {} }
  });
  obs.observe(root, { childList: true });
  return { close: () => ov.remove(), stop: () => obs.disconnect() };
}

function confirmModal(message, opts = {}) {
  return new Promise((resolve) => {
    const danger = !!opts.danger;
    const m = el(`<div class="modal modal-ask">
      <div class="modal-head"><h3 class="modal-title"></h3></div>
      <div class="modal-body"><p class="ask-text"></p></div>
      <div class="modal-foot">
        <button class="btn small" data-cancel></button>
        <button class="btn small ${danger ? 'danger' : 'primary'}" data-ok></button>
      </div>
    </div>`);
    m.querySelector('.modal-title').textContent = opts.title || (danger ? 'Are you sure?' : 'Please confirm');
    m.querySelector('.ask-text').textContent = message;
    m.querySelector('[data-cancel]').textContent = opts.cancelLabel || 'Cancel';
    m.querySelector('[data-ok]').textContent = opts.okLabel || (danger ? 'Delete' : 'Confirm');
    let settled = false;
    const handle = dialogOverlay(m, () => { if (!settled) { settled = true; resolve(false); } });
    const done = (val) => { if (settled) return; settled = true; handle.stop(); handle.close(); resolve(val); };
    m.querySelector('[data-cancel]').addEventListener('click', () => done(false));
    m.querySelector('[data-ok]').addEventListener('click', () => done(true));
    setTimeout(() => m.querySelector('[data-ok]').focus(), 0);
  });
}

function promptModal(label, opts = {}) {
  return new Promise((resolve) => {
    const m = el(`<div class="modal modal-ask">
      <div class="modal-head"><h3 class="modal-title"></h3></div>
      <div class="modal-body"><p class="ask-text"></p><input type="text" class="input ask-input" /></div>
      <div class="modal-foot">
        <button class="btn small" data-cancel></button>
        <button class="btn small primary" data-ok></button>
      </div>
    </div>`);
    m.querySelector('.modal-title').textContent = opts.title || 'Enter a value';
    m.querySelector('.ask-text').textContent = label;
    const input = m.querySelector('.ask-input');
    input.value = opts.value || '';
    if (opts.placeholder) input.placeholder = opts.placeholder;
    m.querySelector('[data-cancel]').textContent = opts.cancelLabel || 'Cancel';
    m.querySelector('[data-ok]').textContent = opts.okLabel || 'Save';
    let settled = false;
    const handle = dialogOverlay(m, () => { if (!settled) { settled = true; resolve(null); } });
    const done = (val) => { if (settled) return; settled = true; handle.stop(); handle.close(); resolve(val); };
    m.querySelector('[data-cancel]').addEventListener('click', () => done(null));
    m.querySelector('[data-ok]').addEventListener('click', () => done(input.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(input.value); } });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

// ---------- Right-click context menu (per-page actions) ----------
// items: [{ label, danger?, run() } | { sep:true }]. Falsy items are skipped.
function contextMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
  const list = (items || []).filter(Boolean);
  if (!list.length) return;
  const menu = el('<div class="ctx-menu"></div>');
  for (const it of list) {
    if (it.sep) { menu.appendChild(el('<div class="ctx-sep"></div>')); continue; }
    const b = document.createElement('button');
    b.className = 'ctx-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.addEventListener('click', async () => { menu.remove(); try { await it.run(); } catch (err) { errToast(err); } });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  let x = e.clientX, y = e.clientY;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  if (x + mw > window.innerWidth - 8) x = window.innerWidth - mw - 8;
  if (y + mh > window.innerHeight - 8) y = Math.max(8, window.innerHeight - mh - 8);
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  const close = (ev) => {
    if (menu.contains(ev.target)) return;
    menu.remove();
    document.removeEventListener('mousedown', close, true);
    document.removeEventListener('scroll', close, true);
    window.removeEventListener('blur', close);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', close, true);
    document.addEventListener('scroll', close, true);
    window.addEventListener('blur', close);
  }, 0);
}

function textModal(title, text, opts = {}) {
  const m = el(`<div class="modal">
    <div class="modal-head"><h3 class="modal-title"></h3><button class="toast-x" data-close aria-label="Close">×</button></div>
    <div class="modal-body"><pre></pre></div>
    <div class="modal-foot">
      ${opts.downloadName ? '<button class="btn small" data-dl>Download .txt</button>' : ''}
      <button class="btn small primary" data-copy>Copy</button>
    </div>
  </div>`);
  m.querySelector('.modal-title').textContent = title;
  m.querySelector('pre').textContent = text;
  const close = openOverlay(m);
  m.querySelector('[data-close]').addEventListener('click', close);
  m.querySelector('[data-copy]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied ✓';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
    } catch { toast('Clipboard unavailable in this context', 'danger'); }
  });
  const dl = m.querySelector('[data-dl]');
  if (dl) dl.addEventListener('click', () => downloadBlob(new Blob([text], { type: 'text/plain' }), opts.downloadName));
}

// ---------- Command palette (Ctrl/Cmd+K) ----------
function openPalette() {
  if (document.querySelector('#overlay-root .palette')) return;
  const p = el(`<div class="palette">
    <input type="text" placeholder="Jump to a page or search applications…" />
    <div class="palette-list"></div>
  </div>`);
  const close = openOverlay(p);
  const input = p.querySelector('input');
  const list = p.querySelector('.palette-list');
  const PAGES = [
    { label: 'Dashboard', hint: 'page', go: '#/' },
    { label: 'Applications', hint: 'page', go: '#/applications' },
    { label: 'Pipeline', hint: 'page', go: '#/pipeline' },
    { label: 'Auto-apply queue', hint: 'page', go: '#/queue' },
    { label: 'Profile', hint: 'page', go: '#/profile' },
    { label: 'Documents', hint: 'page', go: '#/documents' },
    { label: 'Activity', hint: 'page', go: '#/activity' },
    { label: 'Settings', hint: 'page', go: '#/settings' },
    { label: 'New application', hint: 'action', go: '#/applications/new' },
  ];
  let jobs = [];
  let items = [];
  let sel = 0;
  function rebuild() {
    const q = input.value.trim().toLowerCase();
    const pages = PAGES.filter((c) => !q || c.label.toLowerCase().includes(q));
    items = [
      ...pages.map((c) => ({ label: c.label, hint: c.hint, run: () => { location.hash = c.go; } })),
      ...jobs.map((j) => ({
        label: `${j.title || 'Untitled'} — ${j.company || ''}`,
        hint: STATUS_LABEL[j.status] || 'application',
        run: () => { location.hash = '#/applications/' + j.id; },
      })),
    ];
    sel = Math.min(sel, Math.max(0, items.length - 1));
    paint();
  }
  function paint() {
    list.replaceChildren();
    if (!items.length) {
      list.innerHTML = '<div class="palette-empty">Nothing matches.</div>';
      return;
    }
    items.forEach((it, i) => {
      const d = el('<div class="palette-item"><span class="pi-label"></span><span class="pi-hint"></span></div>');
      d.querySelector('.pi-label').textContent = it.label;
      d.querySelector('.pi-hint').textContent = it.hint;
      if (i === sel) d.classList.add('sel');
      d.addEventListener('click', () => { close(); it.run(); });
      list.appendChild(d);
    });
  }
  const searchJobs = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { jobs = []; rebuild(); return; }
    try {
      const r = await api('/jobs?q=' + encodeURIComponent(q) + '&limit=10');
      jobs = r.items || [];
    } catch { jobs = []; }
    rebuild();
  }, 220);
  input.addEventListener('input', () => { sel = 0; rebuild(); searchJobs(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = items[sel]; if (it) { close(); it.run(); } }
  });
  rebuild();
  input.focus();
}

// ---------- Chips input ----------
function chipsInput(initial, placeholder) {
  const root = el('<div class="chips"><input type="text" /></div>');
  const input = root.querySelector('input');
  input.placeholder = placeholder || 'Add…';
  let values = [...(initial || [])];
  function paint() {
    root.querySelectorAll('.chip').forEach((c) => c.remove());
    for (const v of values) {
      const c = el('<span class="chip"><span class="chip-t"></span><span class="chip-x" title="Remove">×</span></span>');
      c.querySelector('.chip-t').textContent = v;
      c.querySelector('.chip-x').addEventListener('click', () => { values = values.filter((x) => x !== v); paint(); });
      root.insertBefore(c, input);
    }
  }
  function add(raw) {
    for (const piece of String(raw).split(',')) {
      const v = piece.trim();
      if (v && !values.includes(v)) values.push(v);
    }
    paint();
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (input.value.trim()) { add(input.value); input.value = ''; }
    } else if (e.key === 'Backspace' && !input.value && values.length) {
      values.pop(); paint();
    }
  });
  input.addEventListener('blur', () => { if (input.value.trim()) { add(input.value); input.value = ''; } });
  root.addEventListener('click', (e) => { if (e.target === root) input.focus(); });
  paint();
  return { node: root, get: () => [...values], set: (v) => { values = [...(v || [])]; paint(); } };
}

// ---------- Router ----------
const routes = [];
function route(pattern, render) { routes.push({ pattern, render }); }
function resolve(path) {
  for (const r of routes) {
    if (typeof r.pattern === 'string') {
      if (r.pattern === path) return { render: r.render, params: {} };
    } else {
      const m = path.match(r.pattern);
      if (m) return { render: r.render, params: m.groups || {} };
    }
  }
  return null;
}
let navSeq = 0;
let aaHistoryLoad = null;   // set by the auto-apply view; lets SSE refreshes reload the History pane
let aaLiveLoad = null;      // set by the auto-apply view; refreshes the live "Running now" panel
async function navigate(opts = {}) {
  // soft = an SSE-driven live refresh: morph the current view in place (counts and
  // rows update, focus + scroll preserved) instead of a full re-render.
  const soft = opts && opts.soft === true;
  const path = (location.hash.replace(/^#/, '') || '/').replace(/\/+$/, '') || '/';
  state.route = { path };
  if (!soft) state.selection = new Set();   // keep multi-select intact across live refreshes
  if (!soft) closeAllOverlays();
  document.querySelectorAll('.nav-item').forEach((n) => {
    const r = n.dataset.route;
    n.classList.toggle('active', r === path || (r !== '/' && path.startsWith(r + '/')));
  });
  if (!state.token) { renderNotConnected(); return; }
  const seq = ++navSeq;
  const match = resolve(path) || resolve('/');
  const main = $('#main');
  const loadT = soft ? null : setTimeout(() => {
    if (seq === navSeq) main.innerHTML = skeletonHtml();
  }, 130);
  try {
    const node = await match.render(match.params);
    if (loadT) clearTimeout(loadT);
    if (seq !== navSeq) return;
    if (soft && main.firstElementChild) {
      morphNode(main.firstElementChild, node);   // in-place patch — scroll, focus & listeners preserved
    } else {
      main.replaceChildren(node);
    }
  } catch (e) {
    clearTimeout(loadT);
    if (seq !== navSeq) return;
    if (e && e.status === 401) return; // not-connected screen already rendered
    main.replaceChildren(errorView(e));
  }
}

// ---------- Error / not-connected states ----------
function errorView(e) {
  const v = el(`<div>
    <div class="empty">
      <div class="empty-mark"></div>
      <div class="empty-eyebrow">App offline</div>
      <div class="empty-title">The desktop companion isn't answering</div>
      <div class="empty-sub"></div>
      <div class="mt"><button class="btn primary" data-retry>Retry</button></div>
    </div>
  </div>`);
  v.querySelector('.empty-sub').textContent =
    (e && e.message ? e.message + ' — ' : '') + 'Start the Job Application Tracker app, then retry.';
  v.querySelector('[data-retry]').addEventListener('click', navigate);
  return v;
}

function renderNotConnected() {
  const main = $('#main');
  if (!main) return;
  const isExt = state.host === 'extension';
  const v = el(`<div>
    <div class="empty">
      <div class="empty-mark"></div>
      <div class="empty-eyebrow">Not connected</div>
      <div class="empty-title">Pair this dashboard with the desktop app</div>
      <div class="empty-sub">${isExt
        ? 'The extension needs a one-time approval from the app. Make sure the app is running, then connect — a dialog will appear in the app window.'
        : 'The desktop app could not hand over its access token. Restart the app; if this persists, check the logs.'}</div>
      <div class="mt">
        ${isExt ? '<button class="btn primary" data-pair>Connect to app</button>' : ''}
        <button class="btn" data-retry>Retry</button>
      </div>
    </div>
  </div>`);
  const pair = v.querySelector('[data-pair]');
  if (pair) {
    pair.addEventListener('click', async () => {
      pair.disabled = true;
      pair.textContent = 'Check the app window…';
      try {
        const r = await new Promise((res) => chrome.runtime.sendMessage({ type: 'pair-app' }, (x) => {
          void chrome.runtime.lastError; res(x);
        }));
        if (r?.ok) {
          const t = await new Promise((res) => chrome.runtime.sendMessage({ type: 'get-token' }, (x) => {
            void chrome.runtime.lastError; res(x);
          }));
          state.token = t?.token || null;
          if (state.token) { toast('Connected ✓'); connectSSE(); navigate(); return; }
        }
        toast(r?.error || 'Pairing failed — is the app running?', 'danger');
      } finally {
        pair.disabled = false;
        pair.textContent = 'Connect to app';
      }
    });
  }
  v.querySelector('[data-retry]').addEventListener('click', () => boot(true));
  main.replaceChildren(v);
}

// ---------- Refresh pill + SSE ----------
const LIST_ROUTES = new Set(['/', '/applications', '/pipeline', '/queue', '/documents', '/activity', '/profile']);
function canAutoRefresh() {
  if (!LIST_ROUTES.has(state.route.path)) return false;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return false;
  if (document.querySelector('#overlay-root .overlay')) return false;
  if (document.querySelector('.ctx-menu')) return false;   // don't yank a right-click menu away
  return true;
}

// Patch the live #main subtree toward a freshly-rendered view instead of replacing
// it wholesale: counts tick in place, a new row appends (with a pulse), gone rows
// drop, and the field you're typing in is never rebuilt. Keyed by data-k/-id/-task.
function nodeKey(n) {
  if (!n || n.nodeType !== 1) return null;
  return n.dataset.k ?? n.dataset.id ?? n.dataset.task ?? null;
}
function isEditable(a) {
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
}
function isActiveField(n) { return n === document.activeElement && isEditable(n); }
function containsActiveField(n) {
  const a = document.activeElement;
  return !!(a && isEditable(a) && n.nodeType === 1 && n !== a && n.contains(a));
}
function morphAttrs(from, to) {
  for (const at of [...from.attributes]) if (!to.hasAttribute(at.name)) from.removeAttribute(at.name);
  for (const at of [...to.attributes]) if (from.getAttribute(at.name) !== at.value) from.setAttribute(at.name, at.value);
}
// NOTE: kept (unkeyed) container nodes survive a morph WITH their original event
// listeners while their children/attrs are patched — so container-level listeners
// must read live DOM, never close over render-time data snapshots (they'd go stale).
function morphNode(from, to) {
  if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) {
    if (containsActiveField(from)) return;     // a type change under the cursor — leave it till blur
    from.replaceWith(to); return;
  }
  if (from.nodeType === 3 || from.nodeType === 8) { if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue; return; }
  if (from.nodeType !== 1) return;
  if (isActiveField(from)) return;             // never touch the exact field being typed in
  morphAttrs(from, to);
  // [data-keep] marks a subtree whose CONTENT is managed imperatively (e.g. the
  // History pane that loads via fetch) — sync its own attributes but never morph
  // its children, so a soft refresh can't wipe what was loaded into it.
  if (from.dataset && from.dataset.keep != null) return;
  morphChildren(from, to);
}
function morphChildren(from, to) {
  const keyed = new Map();
  for (const c of from.childNodes) { const k = nodeKey(c); if (k != null) keyed.set(k, c); }
  let cursor = from.firstChild;
  for (const want of [...to.childNodes]) {
    const k = nodeKey(want);
    if (k != null && keyed.has(k)) {
      const have = keyed.get(k); keyed.delete(k);
      if (have !== cursor) from.insertBefore(have, cursor);            // reorder into place (preserves focus)
      if (have.outerHTML !== want.outerHTML) {
        if (containsActiveField(have)) { morphNode(have, want); }      // patch in place — keep the focused field
        else { have.replaceWith(want); cursor = want.nextSibling; continue; }  // changed → fresh node + listeners
      }
      cursor = have.nextSibling;
    } else if (k != null) {
      if (want.nodeType === 1) want.classList.add('row-new');          // brand-new entry → pulse
      from.insertBefore(want, cursor);
    } else if (cursor && cursor.nodeName === want.nodeName && nodeKey(cursor) == null) {
      const next = cursor.nextSibling;
      morphNode(cursor, want);                                         // recurse unkeyed container (counts, headers)
      cursor = next;
    } else {
      from.insertBefore(want, cursor);
    }
  }
  while (cursor) {                                                     // drop leftovers (but never the focused field)
    const next = cursor.nextSibling;
    if (!(cursor.nodeType === 1 && (isActiveField(cursor) || containsActiveField(cursor)))) cursor.remove();
    cursor = next;
  }
}

const softRefresh = debounce(() => {
  if (!LIST_ROUTES.has(state.route.path)) return;
  if (document.querySelector('.ctx-menu')) return;               // don't reshuffle under a right-click menu
  if (document.querySelector('#overlay-root .overlay')) return;  // don't refresh under an open modal
  navigate({ soft: true });
  // The History pane is [data-keep] so the morph won't touch it — reload it here so
  // it stays live as outcomes change.
  if (aaHistoryLoad && document.querySelector('[data-qpane="history"]:not([hidden])')) aaHistoryLoad();
  if (aaLiveLoad && document.getElementById('aa-live')) aaLiveLoad();
}, 350);

// Live "Running now" panel — one global ticker (reads live DOM, so no stacked
// intervals across navigations). Refreshes the in-flight workers ~every 2.5s while
// the panel is mounted, independent of SSE, so elapsed times + steps stay current.
setInterval(() => { if (aaLiveLoad && document.getElementById('aa-live') && !document.hidden) aaLiveLoad(); }, 2500);

function connectSSE() {
  if (state.sse) { try { state.sse.close(); } catch {} state.sse = null; }
  if (!state.token) return;
  let es;
  try {
    es = new EventSource(`${state.base}/stream?token=${encodeURIComponent(state.token)}`);
  } catch { startPollingFallback(); return; }
  state.sse = es;
  es.onopen = () => { state.sseOk = true; stopPollingFallback(); };
  es.onerror = () => { state.sseOk = false; startPollingFallback(); };
  for (const ev of ['jobs.updated', 'queue.updated', 'documents.updated', 'profileFields.updated', 'emails.updated']) {
    es.addEventListener(ev, () => softRefresh());
  }
  es.addEventListener('settings.updated', async () => {
    try {
      const s = await getSettings(true);
      if (s.appearance?.theme) { applyTheme(s.appearance.theme); try { localStorage.setItem(LS_THEME, s.appearance.theme); } catch {} }
    } catch {}
    softRefresh();
  });
  // Desktop pushes update state, notifications, and pairing prompts here instead of
  // ever showing a native OS popup.
  es.addEventListener('updates.state', (e) => { try { state.update = JSON.parse(e.data); } catch {} renderUpdateBanner(); });
  es.addEventListener('notify.toast', (e) => { try { const d = JSON.parse(e.data); toast(d.body || d.title || '', d.toastKind || 'info'); } catch {} });
}
function startPollingFallback() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(() => {
    if (!state.sseOk && canAutoRefresh()) navigate();
    if (!state.sseOk) connectSSE();
  }, 30000);
}
function stopPollingFallback() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

// ---------- In-app update banner + pairing prompt (replace native popups) ----------
let updateBannerDismissed = null;   // version the user clicked "Later" on
function renderUpdateBanner() {
  const host = $('#app-banner');
  if (!host) return;
  host.replaceChildren();
  const u = state.update;
  if (!u || !u.version) return;
  // Show the update DOWNLOADING (progress) so the user knows one's incoming, then the
  // actionable "ready" prompt. Downloading is informational (auto-replaced); only the
  // ready state is dismissible.
  if (u.status === 'downloading') {
    const pct = Math.max(0, Math.min(100, Number(u.percent) || 0));
    host.appendChild(el(`<div class="app-banner">
      <span class="app-banner-msg">Update v${esc(u.version)} is downloading… ${pct}%
        <span style="display:inline-block;width:90px;height:5px;border-radius:3px;background:var(--border,#2a2a2a);vertical-align:middle;margin-left:8px;overflow:hidden"><span style="display:block;height:100%;width:${pct}%;background:var(--accent,#d9a441)"></span></span>
      </span>
    </div>`));
    return;
  }
  if (u.status === 'downloaded' && u.version !== updateBannerDismissed) {
    const b = el(`<div class="app-banner">
      <span class="app-banner-msg">Update v${esc(u.version)} is ready — it auto-installs when your machine is idle.</span>
      <span class="app-banner-actions">
        <button class="btn small primary" data-upd-restart>Update &amp; restart</button>
        <button class="btn small" data-upd-later>Later</button>
      </span>
    </div>`);
    b.querySelector('[data-upd-restart]').addEventListener('click', () => { if (window.jatDesktop) window.jatDesktop.restartToUpdate(); });
    b.querySelector('[data-upd-later]').addEventListener('click', () => {
      updateBannerDismissed = u.version;
      try { window.jatDesktop?.updateLater?.(); } catch {}   // explicit human "Later" opts out of the unattended idle install
      renderUpdateBanner();
    });
    host.appendChild(b);
  }
}

let pairingShownId = null;
function showPairingModal(p) {
  if (!window.jatDesktop || !p || !p.id || pairingShownId === p.id) return;   // only the desktop host can answer
  pairingShownId = p.id;
  const m = el(`<div class="modal modal-ask">
    <div class="modal-head"><h3 class="modal-title">Connect extension?</h3></div>
    <div class="modal-body">
      <p class="ask-text">A browser extension wants to connect to your Job Application Tracker data.</p>
      <div class="kv" style="margin-top:12px"><span class="muted">Client</span> <strong data-pair-client></strong></div>
      <div class="kv"><span class="muted">Origin</span> <strong data-pair-origin></strong></div>
      <p class="ask-text muted" style="margin-top:12px">Only allow this if you just clicked “Connect” in the JAT extension.</p>
    </div>
    <div class="modal-foot">
      <button class="btn small" data-deny>Deny</button>
      <button class="btn small primary" data-allow>Allow</button>
    </div>
  </div>`);
  m.querySelector('[data-pair-client]').textContent = p.client || 'unknown';
  m.querySelector('[data-pair-origin]').textContent = p.origin || '(none)';
  let settled = false;
  const respond = (allow) => { try { window.jatDesktop.pairRespond(p.id, allow); } catch {} };
  const handle = dialogOverlay(m, () => { if (!settled) { settled = true; respond(false); } });
  const done = (allow) => { if (settled) return; settled = true; handle.stop(); handle.close(); respond(allow); };
  m.querySelector('[data-allow]').addEventListener('click', () => done(true));
  m.querySelector('[data-deny]').addEventListener('click', () => done(false));
}

// ---------- Runtime footer ----------
async function paintRuntime() {
  const dot = $('#runtime-dot');
  const txt = $('#runtime-text');
  if (!dot || !txt) return;
  try {
    const r = await fetch(state.base + '/health', { signal: AbortSignal.timeout(1500) });
    const body = r.ok ? await r.json() : null;
    state.online = !!body?.ok;
    dot.className = 'status-dot' + (state.online ? ' ok' : ' bad');
    txt.textContent = `${HOST_LABEL[state.host]} · ${state.online ? 'app v' + (body.version || '?') : 'app offline'}${state.sseOk ? ' · live' : ''}`;
  } catch {
    state.online = false;
    dot.className = 'status-dot bad';
    txt.textContent = `${HOST_LABEL[state.host]} · app offline`;
  }
}

// ============================================================
// VIEW: Dashboard (#/)
// ============================================================
route('/', async () => {
  const [statsR, jobsR, queueR, aiR, gmailR, liveR, bdR, trendR] = await Promise.all([
    api('/stats'),
    api('/jobs?limit=8'),
    api('/queue').catch(() => ({ items: [] })),
    api('/ai/status').catch(() => null),
    api('/gmail/status').catch(() => null),
    api('/auto-apply/live').catch(() => null),
    api('/auto-apply/breakdown?days=7').catch(() => null),
    api('/stats/activity?days=30').catch(() => null),
  ]);
  const stats = statsR;
  const jobs = jobsR.items || [];
  const tasks = queueR.items || [];
  const byStatus = stats.byStatus || {};
  const qCounts = {};
  for (const t of tasks) qCounts[t.state] = (qCounts[t.state] || 0) + 1;

  const aiChip = (label, st) => {
    if (!st) return '';
    const ok = !!st.available;
    return `<span class="sys-chip ${ok ? 'ok' : 'bad'}" title="${esc(st.reason || '')}">${esc(label)} ${ok ? '●' : '○'}</span>`;
  };
  const sysBits = [];
  if (aiR) { sysBits.push(aiChip('Codex', aiR.codex)); sysBits.push(aiChip('Ollama', aiR.ollama)); }
  if (gmailR?.enabled) {
    const lr = gmailR.lastResult;
    sysBits.push(`<span class="sys-chip">Gmail · ${lr?.at ? 'synced ' + fmtRel(lr.at) : (gmailR.authorized ? 'connected' : 'not connected')}</span>`);
  }
  const awaiting = (qCounts.awaiting_review || 0) + (qCounts.awaiting_input || 0);
  if (tasks.length) sysBits.push(`<span class="sys-chip ${awaiting ? 'warn' : ''}">Auto-apply · ${qCounts.queued || 0} queued${awaiting ? ` · ${awaiting} need you` : ''}</span>`);

  // ---- auto-apply health (live) ----
  const live = (liveR && liveR.ok) ? liveR : null;
  const sess = (live && live.session) || {};
  const aaStatus = live ? live.status : 'off';
  const AA_STATUS_LABEL = { off: 'Off', running: 'Running', 'queue-empty': 'Idle · queue empty', 'hourly-cap': 'Hourly cap hit', pacing: 'Paced · waiting' };
  const subAuto = stats.submittedAuto || 0, subMan = stats.submittedManual || 0;
  const subBot = stats.submittedAutoSubmitted || 0, subCap = stats.submittedAutoAssisted || 0;
  const subTot = stats.submittedTotal || (subAuto + subMan);
  const autoPct = (subAuto + subMan) ? Math.round(100 * subAuto / (subAuto + subMan)) : 0;
  const sessTried = (sess.submitted || 0) + (sess.failed || 0);
  const openRate = sessTried ? Math.round(100 * (sess.submitted || 0) / sessTried) : null;
  const topReasons = ((bdR && bdR.topReasons) || []).slice(0, 3);

  // ---- submission trend: this-week (7d) bars + 30-day completed mini ----
  const trend = (trendR && trendR.items) || [];
  const trend7 = trend.slice(-7);
  const wkAuto = trend7.reduce((s, d) => s + (d.auto || 0), 0);
  const wkMan = trend7.reduce((s, d) => s + (d.manual || 0), 0);
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayLabel = (iso) => { try { return DOW[new Date(iso + 'T12:00:00').getDay()]; } catch { return ''; } };
  // This week — taller stacked bars (auto over by-hand) with per-day counts + weekday labels.
  const wkMax = Math.max(1, ...trend7.map((d) => (d.auto || 0) + (d.manual || 0)));
  const WK_H = 76;
  const weekBars = trend7.map((d) => {
    const total = (d.auto || 0) + (d.manual || 0);
    const h = total ? Math.max(3, Math.round((total / wkMax) * WK_H)) : 1;
    const ah = total ? Math.round(((d.auto || 0) / total) * h) : 0;
    return `<div class="wk-col" title="${d.date}: ${d.auto || 0} auto · ${d.manual || 0} by hand"><div class="wk-n">${total || ''}</div><div class="wk-stack" style="height:${h}px"><div class="spk-auto" style="height:${ah}px"></div><div class="spk-man" style="height:${h - ah}px"></div></div><div class="wk-day">${dayLabel(d.date)}</div></div>`;
  }).join('');
  // Completed over time — total submissions per day, last 30 days.
  const c30Max = Math.max(1, ...trend.map((d) => (d.auto || 0) + (d.manual || 0)));
  const C30_H = 46;
  const c30Bars = trend.map((d) => {
    const total = (d.auto || 0) + (d.manual || 0);
    const h = total ? Math.max(2, Math.round((total / c30Max) * C30_H)) : 1;
    return `<div class="c30-col" title="${d.date}: ${total} submitted"><div class="c30-bar" style="height:${h}px"></div></div>`;
  }).join('');
  const trendTotal = trend.reduce((s, d) => s + (d.auto || 0) + (d.manual || 0), 0);

  // ---- pipeline funnel: DISCRETE stages from byStatus (auto-populates as the Gmail pipeline
  // advances jobs to assessment/interview/offer). Cumulative "at or beyond" so it narrows
  // monotonically; terminal states (rejected/withdrawn/ghosted) are excluded from the stages. ----
  const fn = stats.funnel || {};
  const STAGE_RANK = { started: 10, submitted: 20, contacted: 30, assessment: 35, interview_1: 40, interview_2: 50, interview_final: 60, offer: 70, hired: 80 };
  const TERMINAL_ST = { rejected: 1, withdrawn: 1, ghosted: 1 };
  const atOrBeyond = (min) => Object.entries(byStatus).reduce((s, [st, n]) => s + (((STAGE_RANK[st] || 0) >= min && !TERMINAL_ST[st]) ? n : 0), 0);
  const fnStages = [
    { label: 'Submitted', n: subTot, sub: `${subAuto} auto · ${subMan} by hand` },
    { label: 'Assessment', n: atOrBeyond(35) },
    { label: 'Interview', n: atOrBeyond(40) },
    { label: 'Offer', n: atOrBeyond(70) },
  ];
  const fnMax = Math.max(1, subTot);
  const funnelHtml = fnStages.map((st, i) => {
    const pct = Math.round((st.n / fnMax) * 100);
    const conv = i > 0 && fnStages[i - 1].n ? Math.round(100 * st.n / fnStages[i - 1].n) : null;
    return `<div class="fn-row"><div class="fn-top"><span class="fn-label">${st.label}${st.sub ? ` <span class="muted" style="font-size:10px">${st.sub}</span>` : ''}</span><span class="fn-n">${st.n}${conv != null ? ` <span class="muted">${conv}%</span>` : ''}</span></div><div class="fn-bar"><div class="fn-fill" style="width:${pct}%"></div></div></div>`;
  }).join('');

  // ---- source breakdown ----
  const srcEntries = Object.entries(stats.bySource || {}).filter(([, vv]) => vv).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const srcMax = Math.max(1, ...srcEntries.map(([, vv]) => vv));
  const sourcesHtml = srcEntries.length
    ? srcEntries.map(([k, vv]) => `<div class="fn-row"><div class="fn-top"><span class="fn-label">${esc(k)}</span><span class="fn-n">${vv}</span></div><div class="fn-bar"><div class="fn-fill alt" style="width:${Math.round(vv / srcMax * 100)}%"></div></div></div>`).join('')
    : '<div class="ny-empty">No sources yet.</div>';

  const recent = jobs.length ? jobs.map((j) => `
    <tr data-id="${esc(j.id)}" class="row-link">
      <td class="title-cell">${esc(j.title || 'Untitled')}${j.needsReview ? ' <span class="muted" title="Needs review">⚠</span>' : ''}</td>
      <td>${esc(j.company || '')}</td>
      <td>${statusChip(j.status)}</td>
      <td>${viaBadge(j) || fitBadgeHtml(j.fitScore)}</td>
      <td>${esc(j.source || '—')}</td>
      <td>${relHtml(j.updatedAt)}</td>
    </tr>`).join('')
    : `<tr><td colspan="6">${emptyHtml('Quiet ledger', 'No applications yet', 'Apply to a job — JAT captures it automatically. Or press “/” and add one by hand.')}</td></tr>`;

  const v = el(`<div>
    <header class="page-header">
      <div>
        <div class="page-eyebrow">Overview</div>
        <h1 class="page-title">Dashboard</h1>
        <div class="page-sub">A considered record of your job search.</div>
      </div>
      <div class="page-actions">
        <button class="btn" data-refresh>Refresh</button>
        <a href="#/applications/new" class="btn primary">+ New application</a>
      </div>
    </header>

    ${sysBits.length ? `<div class="sys-strip">${sysBits.join('')}</div>` : ''}

    <section class="stats stats-5">
      <div class="stat"><div class="stat-label">Submitted</div><div class="stat-value gold">${subTot}</div><div class="stat-delta">${stats.submittedToday || 0} today · ${stats.total || 0} started</div></div>
      <div class="stat"><div class="stat-label">Via auto-apply</div><div class="stat-value">${subAuto}</div><div class="stat-delta">${autoPct}% · ${subBot} submitted${subCap ? ` · ${subCap} captured` : ''}</div></div>
      <div class="stat"><div class="stat-label">By hand</div><div class="stat-value">${subMan}</div><div class="stat-delta">${100 - autoPct}% — no auto-apply task</div></div>
      <div class="stat"><div class="stat-label">Response rate</div><div class="stat-value">${fn.responseRate == null ? '—' : fn.responseRate + '%'}</div><div class="stat-delta">${fn.responded || 0} replied${fn.interviews ? ` · ${fn.interviews} interview${fn.interviews === 1 ? '' : 's'}` : ''}</div></div>
      <div class="stat clickable" data-go-review><div class="stat-label">Needs review</div><div class="stat-value ${stats.needsReview ? 'warn' : ''}">${stats.needsReview || 0}</div><div class="stat-delta">${stats.thisWeek || 0} new this week</div></div>
    </section>

    <section class="section">
      <header class="section-header">
        <div><div class="section-eyebrow">Momentum</div><h2 class="section-title">Submissions this week</h2></div>
        <span class="muted" style="font-size:12px">${wkAuto + wkMan} this week · ${wkAuto} auto · ${wkMan} by hand</span>
      </header>
      <div class="section-body">
        <div class="wk-chart">${weekBars || '<span class="muted" style="font-size:12px">No submissions in the last 7 days.</span>'}</div>
        <div class="spark-legend"><span class="lg lg-auto">Auto-apply</span><span class="lg lg-man">By hand</span></div>
        <div class="dash-sub" style="margin-top:20px">Completed · last 30 days <span class="muted">(${trendTotal})</span></div>
        <div class="c30">${c30Bars || '<span class="muted" style="font-size:12px">No submissions yet.</span>'}</div>
      </div>
    </section>

    <section class="section">
      <header class="section-header">
        <div><div class="section-eyebrow">Automate</div><h2 class="section-title">Auto-apply</h2></div>
        <a href="#/queue" class="section-link">Open auto-apply</a>
      </header>
      <div class="section-body">
        <div class="aa-dash-grid">
          <div class="mini"><div class="mini-label">Status</div><div class="mini-value ${aaStatus === 'running' ? 'live' : ''}">${aaStatus === 'running' ? '<span class="aa-pulse"></span> ' : ''}${esc(AA_STATUS_LABEL[aaStatus] || aaStatus)}</div></div>
          <div class="mini"><div class="mini-label">Submitted today</div><div class="mini-value gold">${stats.submittedToday || 0}</div></div>
          <div class="mini"><div class="mini-label">In queue</div><div class="mini-value">${(live ? live.queuedDepth : 0) || 0}</div></div>
          <div class="mini ${sess.needsYou ? 'warn' : ''}"><div class="mini-label">Needs you</div><div class="mini-value ${sess.needsYou ? 'warn' : ''}">${sess.needsYou || 0}</div></div>
          <div class="mini"><div class="mini-label">Session open-rate</div><div class="mini-value">${openRate == null ? '—' : openRate + '%'}</div></div>
        </div>
        <div class="dash-aa-cols">
          <div class="split-wrap">
            <div class="split-head"><span class="muted">Submissions — auto-apply vs by hand</span><span>${subAuto} · ${subMan}</span></div>
            <div class="split-bar" title="${autoPct}% via auto-apply"><div class="split-fill" style="width:${autoPct}%"></div></div>
          </div>
          <div>
            <div class="dash-sub">Top blockers · 7 days</div>
            ${topReasons.length ? topReasons.map((r) => `<div class="blk-row"><span class="blk-reason">${esc(r.reason)}</span><span class="blk-n">${r.count}×</span></div>`).join('') : '<div class="muted" style="font-size:12px">None — clean run.</div>'}
          </div>
        </div>
        ${(live && live.running && live.running.length) ? `<div class="aa-dash-live">${live.running.map((w) => `<span class="aa-live-chip"><span class="aa-pulse"></span> ${esc(w.title || '…')} <span class="muted">${esc((w.step || '').slice(0, 44))}</span></span>`).join('')}</div>` : ''}
      </div>
    </section>

    <div class="dash-cols">
      <section class="section">
        <header class="section-header">
          <div><div class="section-eyebrow">Pipeline</div><h2 class="section-title">Funnel</h2></div>
          <a href="#/pipeline" class="section-link">Board</a>
        </header>
        <div class="section-body">${funnelHtml}</div>
      </section>
      <section class="section">
        <header class="section-header">
          <div><div class="section-eyebrow">Where from</div><h2 class="section-title">Sources</h2></div>
        </header>
        <div class="section-body">${sourcesHtml}</div>
      </section>
    </div>

    <section class="section">
      <header class="section-header">
        <div><div class="section-eyebrow">Recent</div><h2 class="section-title">Latest applications</h2></div>
        <a href="#/applications" class="section-link">All applications</a>
      </header>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Title</th><th>Company</th><th>Status</th><th>Via</th><th>Source</th><th>Updated</th></tr></thead>
        <tbody>${recent}</tbody>
      </table></div>
    </section>
  </div>`);

  v.querySelector('[data-refresh]').addEventListener('click', navigate);
  v.querySelector('[data-go-review]').addEventListener('click', () => {
    state.apps.status = 'needs_review'; persistFilters();
    location.hash = '#/applications';
  });
  v.querySelectorAll('.pill').forEach((p) => p.addEventListener('click', () => {
    state.apps.status = p.dataset.status; persistFilters();
    location.hash = '#/applications';
  }));
  v.querySelectorAll('.row-link').forEach((tr) => {
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => { location.hash = '#/applications/' + tr.dataset.id; });
    tr.addEventListener('contextmenu', (e) => contextMenu(e, [
      { label: 'Open', run: () => { location.hash = '#/applications/' + tr.dataset.id; } },
      { sep: true },
      ...STATUSES.map((s) => ({ label: `→ ${s.label}`, run: async () => { await api('/jobs/' + encodeURIComponent(tr.dataset.id), { method: 'PATCH', body: { status: s.id, _source: 'manual' } }); navigate(); } })),
      { sep: true },
      { label: 'Queue auto-apply', run: async () => { await api('/queue', { method: 'POST', body: { jobId: tr.dataset.id } }); toast('Queued for auto-apply'); } },
      { label: 'Delete', danger: true, run: async () => { if (!(await confirmModal('Delete this application?', { danger: true, okLabel: 'Delete' }))) return; await api('/jobs/' + encodeURIComponent(tr.dataset.id), { method: 'DELETE' }); navigate(); } },
    ]));
  });
  return v;
});

// ============================================================
// VIEW: Applications list (#/applications)
// ============================================================
route('/applications', async () => {
  const f = state.apps;
  let q = '/jobs?limit=500';
  if (f.status === 'needs_review') q += '&needsReview=1';
  else if (f.status !== 'all') q += '&status=' + encodeURIComponent(f.status);
  if (f.source !== 'all') q += '&source=' + encodeURIComponent(f.source);
  if (f.q) q += '&q=' + encodeURIComponent(f.q);
  const [r, nyR] = await Promise.all([api(q), api('/auto-apply/needs-you').catch(() => ({ items: [] }))]);
  let rows = r.items || [];
  // Provenance filter (client-side — `via` is derived server-side, not a DB column).
  if (f.via === 'auto') rows = rows.filter((j) => j.via === 'auto' || j.autoApply);
  else if (f.via === 'manual') rows = rows.filter((j) => j.via === 'manual' && !j.autoApply);
  const needsYou = (nyR && nyR.items) || [];

  const dir = f.dir === 'asc' ? 1 : -1;
  rows = rows.slice().sort((a, b) => {
    const k = f.sort;
    if (k === 'status') return (STATUS_INDEX[a.status] - STATUS_INDEX[b.status]) * dir;
    if (k === 'fitScore') return ((a.fitScore ?? -1) - (b.fitScore ?? -1)) * dir;
    const av = String(a[k] ?? ''); const bv = String(b[k] ?? '');
    return av.localeCompare(bv) * dir;
  });

  const allSources = [...new Set((await api('/jobs?limit=500').catch(() => ({ items: rows }))).items?.map((j) => j.source).filter(Boolean) || [])].sort();

  const th = (key, label) => {
    const active = f.sort === key;
    return `<th data-sort="${key}" style="cursor:pointer">${esc(label)}${active ? (f.dir === 'asc' ? ' ↑' : ' ↓') : ''}</th>`;
  };

  const bodyRows = rows.length ? rows.map((j) => `
    <tr data-id="${esc(j.id)}" class="row-link">
      <td><input type="checkbox" data-sel="${esc(j.id)}" ${state.selection.has(j.id) ? 'checked' : ''} /></td>
      <td class="title-cell">${esc(j.title || 'Untitled')}${j.needsReview ? ' <span class="muted" title="Needs review">⚠</span>' : ''}</td>
      <td>${esc(j.company || '')}</td>
      <td>${statusChip(j.status)}</td>
      <td>${viaBadge(j)}</td>
      <td>${fitBadgeHtml(j.fitScore)}</td>
      <td>${esc(j.source || '—')}</td>
      <td>${dateHtml(j.createdAt)}</td>
      <td>${relHtml(j.updatedAt)}</td>
    </tr>`).join('')
    : `<tr><td colspan="9">${emptyHtml(
      f.q || f.status !== 'all' || f.source !== 'all' ? 'No matches' : 'No entries',
      f.q || f.status !== 'all' || f.source !== 'all' ? 'Nothing matches the current filter' : 'The ledger is empty',
      'Adjust the filters, or hit Apply on a job and JAT will record it.')}</td></tr>`;

  // "Needs your input" — auto-apply tasks that parked / await you, surfaced so you can
  // answer the missing question right here and the pipeline re-queues + finishes them.
  const NY_STATE_LABEL = { parked: 'Parked', awaiting_input: 'Needs you', awaiting_review: 'Review' };
  const nyCard = (t) => `
    <div class="ny-card" data-task="${esc(t.taskId)}" data-job="${esc(t.jobId)}">
      <div class="ny-head">
        <span class="ny-title">${esc(t.title || 'Application')}</span>
        <span class="ny-co">${esc(t.company || '')}</span>
        <span class="state-chip" data-state="${esc(t.state)}">${esc(NY_STATE_LABEL[t.state] || t.state)}</span>
        ${t.route === 'external' ? '<span class="aa-route-chip external">external</span>' : ''}
      </div>
      ${t.reason ? `<div class="ny-reason">${esc(t.reason)}</div>` : ''}
      ${(t.questions || []).map((qq) => `
        <div class="ny-q">
          <label class="ny-q-label">${esc(qq.question)}</label>
          ${(qq.options && qq.options.length)
            ? `<select class="select ny-input" data-q="${esc(qq.question)}">${qq.options.map((o) => `<option>${esc(o)}</option>`).join('')}</select>`
            : `<input class="input ny-input" data-q="${esc(qq.question)}" placeholder="Your answer" />`}
        </div>`).join('')}
      ${(t.questions || []).length ? '' : '<div class="ny-reason muted">No specific question captured — open the job to finish it by hand.</div>'}
      <div class="ny-actions">
        ${(t.questions || []).length ? '<button class="btn small primary" data-ny-save>Save &amp; continue</button>' : ''}
        ${t.jobUrl ? `<a class="btn small" href="${esc(t.jobUrl)}" target="_blank" rel="noopener">Open job ↗</a>` : ''}
        <button class="btn small" data-ny-detail>Details</button>
        <button class="btn small" data-ny-skip>Dismiss</button>
      </div>
    </div>`;
  const needsYouHtml = needsYou.length ? `
    <section class="section needs-you">
      <header class="section-header">
        <div><div class="section-eyebrow">Needs your input</div><h2 class="section-title">${needsYou.length} auto-apply${needsYou.length === 1 ? '' : 's'} waiting on you</h2></div>
        <a href="#/queue" class="section-link">Auto-apply page</a>
      </header>
      <div class="section-body">${needsYou.map(nyCard).join('')}</div>
    </section>` : '';

  const v = el(`<div>
    <header class="page-header">
      <div>
        <div class="page-eyebrow">Ledger</div>
        <h1 class="page-title">Applications</h1>
        <div class="page-sub">${rows.length} shown</div>
      </div>
      <div class="page-actions">
        ${state.host === 'extension' ? '<button class="btn" data-sync-open title="Import your past LinkedIn/Indeed applications">⟳ Sync past applications</button>' : ''}
        <button class="btn" data-csv>Export CSV</button>
        <a href="#/applications/new" class="btn primary">+ New application</a>
      </div>
    </header>

    ${state.host === 'extension' ? `
    <div class="sync-panel" id="sync-panel" hidden>
      <div class="sync-row">
        <label class="chk"><input type="checkbox" id="sync-li" checked /> LinkedIn</label>
        <label class="chk"><input type="checkbox" id="sync-in" /> Indeed</label>
        <select class="select" id="sync-days" style="max-width:160px">
          <option value="30">Last 30 days</option>
          <option value="90" selected>Last 90 days</option>
          <option value="180">Last 6 months</option>
          <option value="3650">All time</option>
        </select>
        <button class="btn primary" data-sync-go>Sync now</button>
        <span class="muted" id="sync-status"></span>
      </div>
      <div class="form-hint">Opens your applied-jobs page(s) in a background tab, reads your past applications, and imports them (deduped, marked submitted with their real date). Runs in your browser using your existing login.</div>
    </div>` : ''}

    ${needsYouHtml}

    <div class="toolbar">
      <div class="tb-search">
        <svg class="tb-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>
        <input class="input" id="f-q" type="search" placeholder="Search title, company, notes…   ( / )" value="${esc(f.q)}" />
      </div>
      <select class="select tb-filter ${f.status !== 'all' ? 'on' : ''}" id="f-status" title="Filter by status">
        <option value="all" ${f.status === 'all' ? 'selected' : ''}>All statuses</option>
        <option value="needs_review" ${f.status === 'needs_review' ? 'selected' : ''}>Needs review ⚠</option>
        ${STATUSES.map((s) => `<option value="${s.id}" ${f.status === s.id ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
      </select>
      <select class="select tb-filter ${f.source !== 'all' ? 'on' : ''}" id="f-source" title="Filter by source">
        <option value="all">All sources</option>
        ${allSources.map((s) => `<option value="${esc(s)}" ${f.source === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
      </select>
      <select class="select tb-filter ${f.via !== 'all' ? 'on' : ''}" id="f-via" title="Filter by how it was applied to">
        <option value="all" ${f.via === 'all' ? 'selected' : ''}>Auto &amp; manual</option>
        <option value="auto" ${f.via === 'auto' ? 'selected' : ''}>⚡ Auto-apply only</option>
        <option value="manual" ${f.via === 'manual' ? 'selected' : ''}>✋ Manual only</option>
      </select>
    </div>

    <div class="bulkbar" id="bulkbar" hidden>
      <span class="muted" id="bulk-n"></span>
      <select class="select" id="bulk-status"><option value="">Set status…</option>${statusOptions('')}</select>
      <button class="btn small" data-bulk-status>Apply</button>
      <button class="btn small" data-bulk-queue>Queue for auto-apply</button>
      <span class="right"></span>
      <button class="btn small" data-bulk-delete>Delete</button>
    </div>

    <section class="section">
      <div class="table-wrap"><table class="table">
        <thead><tr>
          <th style="width:30px"><input type="checkbox" id="sel-all" /></th>
          ${th('title', 'Title')}${th('company', 'Company')}${th('status', 'Status')}<th>Via</th>${th('fitScore', 'Fit')}${th('source', 'Source')}${th('createdAt', 'Applied')}${th('updatedAt', 'Updated')}
        </tr></thead>
        <tbody>${bodyRows}</tbody>
      </table></div>
    </section>
  </div>`);

  // filters
  const requery = () => { persistFilters(); navigate(); };
  v.querySelector('#f-q').addEventListener('input', debounce((e) => { f.q = e.target.value.trim(); requery(); }, 350));
  v.querySelector('#f-status').addEventListener('change', (e) => { f.status = e.target.value; requery(); });
  v.querySelector('#f-source').addEventListener('change', (e) => { f.source = e.target.value; requery(); });
  v.querySelector('#f-via').addEventListener('change', (e) => { f.via = e.target.value; requery(); });

  // Needs-you intake cards: answer the parked question(s) → saved to profile → the task
  // is re-queued and the pipeline finishes it on the next tick.
  v.querySelectorAll('.ny-card').forEach((card) => {
    const taskId = card.dataset.task, jobId = card.dataset.job;
    card.querySelector('[data-ny-save]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true;
      const answers = [...card.querySelectorAll('.ny-input')]
        .map((inp) => ({ question: inp.dataset.q, value: (inp.value || '').trim() }))
        .filter((a) => a.value);
      if (!answers.length) { toast('Type an answer first', 'danger'); btn.disabled = false; return; }
      try {
        const rr = await api('/auto-apply/intake', { method: 'POST', body: { answers } });
        toast(`Saved${rr && rr.requeued ? ` — ${rr.requeued} re-queued` : ''} ✓`);
        navigate();
      } catch (err) { errToast(err); btn.disabled = false; }
    });
    card.querySelector('[data-ny-detail]')?.addEventListener('click', () => { location.hash = '#/applications/' + jobId; });
    card.querySelector('[data-ny-skip]')?.addEventListener('click', async () => {
      try { await api('/queue/' + encodeURIComponent(taskId), { method: 'PATCH', body: { state: 'skipped' } }); toast('Dismissed'); navigate(); }
      catch (err) { errToast(err); }
    });
  });

  v.querySelectorAll('th[data-sort]').forEach((h) => h.addEventListener('click', () => {
    const k = h.dataset.sort;
    if (f.sort === k) f.dir = f.dir === 'asc' ? 'desc' : 'asc';
    else { f.sort = k; f.dir = k === 'updatedAt' || k === 'createdAt' ? 'desc' : 'asc'; }
    requery();
  }));

  // selection / bulk
  const paintBulk = () => {
    const bar = v.querySelector('#bulkbar');
    bar.hidden = state.selection.size === 0;
    v.querySelector('#bulk-n').textContent = `${state.selection.size} selected`;
  };
  v.querySelectorAll('[data-sel]').forEach((cb) => cb.addEventListener('click', (e) => {
    e.stopPropagation();
    if (cb.checked) state.selection.add(cb.dataset.sel); else state.selection.delete(cb.dataset.sel);
    paintBulk();
  }));
  v.querySelector('#sel-all').addEventListener('click', (e) => {
    e.stopPropagation();
    const on = e.target.checked;
    state.selection = new Set(on ? rows.map((j) => j.id) : []);
    v.querySelectorAll('[data-sel]').forEach((cb) => { cb.checked = on; });
    paintBulk();
  });
  paintBulk();

  v.querySelector('[data-bulk-status]').addEventListener('click', async () => {
    const s = v.querySelector('#bulk-status').value;
    if (!s || !state.selection.size) return;
    try {
      for (const id of state.selection) await api('/jobs/' + encodeURIComponent(id), { method: 'PATCH', body: { status: s, _source: 'manual' } });
      toast(`Status → ${STATUS_LABEL[s]} for ${state.selection.size}`);
      state.selection.clear(); navigate();
    } catch (e) { errToast(e); }
  });
  v.querySelector('[data-bulk-queue]').addEventListener('click', async () => {
    if (!state.selection.size) return;
    let n = 0;
    try {
      for (const id of state.selection) { await api('/queue', { method: 'POST', body: { jobId: id } }); n++; }
      toast(`Queued ${n} for auto-apply`);
      state.selection.clear(); navigate();
    } catch (e) { errToast(e, `Queued ${n}, then failed`); }
  });
  v.querySelector('[data-bulk-delete]').addEventListener('click', async () => {
    if (!state.selection.size) return;
    const victims = rows.filter((j) => state.selection.has(j.id));
    try {
      for (const j of victims) await api('/jobs/' + encodeURIComponent(j.id), { method: 'DELETE' });
      state.selection.clear();
      undoToast(`Deleted ${victims.length} application${victims.length === 1 ? '' : 's'}`, async () => {
        for (const j of victims) await api('/jobs', { method: 'POST', body: { ...j, _manual: true, _source: 'manual' } }).catch(() => {});
        navigate();
      });
      navigate();
    } catch (e) { errToast(e); }
  });

  // Sync past applications (extension host only — the scrape runs in the SW).
  v.querySelector('[data-sync-open]')?.addEventListener('click', () => {
    const p = v.querySelector('#sync-panel'); if (p) p.hidden = !p.hidden;
  });
  v.querySelector('[data-sync-go]')?.addEventListener('click', async (e) => {
    const sources = [];
    if (v.querySelector('#sync-li')?.checked) sources.push('linkedin');
    if (v.querySelector('#sync-in')?.checked) sources.push('indeed');
    if (!sources.length) { toast('Pick LinkedIn and/or Indeed', 'danger'); return; }
    const maxDays = Number(v.querySelector('#sync-days')?.value) || 90;
    const btn = e.currentTarget; btn.disabled = true;
    const status = v.querySelector('#sync-status'); if (status) status.textContent = 'Syncing… a background tab will open — leave it be';
    try {
      const r = await new Promise((res) => chrome.runtime.sendMessage({ type: 'sync-applied', sources, maxDays }, (x) => { void chrome.runtime.lastError; res(x); }));
      if (!r?.ok) { toast('Sync failed: ' + (r?.error || 'unknown'), 'danger', { ttl: 9000 }); }
      else {
        const tot = (r.results || []).reduce((a, x) => ({ created: a.created + (x.created || 0), merged: a.merged + (x.merged || 0), scraped: a.scraped + (x.scraped || 0) }), { created: 0, merged: 0, scraped: 0 });
        const notes = (r.results || []).filter((x) => x.note || x.error).map((x) => `${x.source}: ${x.note || x.error}`).join(' · ');
        toast(`Imported ${tot.created} new · ${tot.merged} already tracked · read ${tot.scraped}${notes ? ' — ' + notes : ''}`, (tot.created || tot.merged) ? 'info' : 'danger', { ttl: 12000 });
        navigate();
      }
    } catch (err) { errToast(err); }
    btn.disabled = false; if (status) status.textContent = '';
  });

  v.querySelector('[data-csv]').addEventListener('click', () => {
    const cols = ['title', 'company', 'status', 'source', 'location', 'compensation', 'jobUrl', 'fitScore', 'createdAt', 'submittedAt', 'updatedAt', 'notes'];
    // Guard CSV formula injection (a cell starting with = + - @ runs as a formula in
    // Excel/Sheets) by prefixing a quote, and prepend a UTF-8 BOM so accented (FR)
    // company/role names don't mojibake in Excel.
    const cell = (x) => {
      let s = String(x ?? '').replace(/\r?\n/g, ' ');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const csv = [cols.join(',')].concat(rows.map((j) => cols.map((c) => cell(j[c])).join(','))).join('\n');
    downloadBlob(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `jat-applications-${new Date().toISOString().slice(0, 10)}.csv`);
  });

  v.querySelectorAll('.row-link').forEach((tr) => {
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', (e) => {
      if (e.target.matches('input[type="checkbox"]')) return;
      location.hash = '#/applications/' + tr.dataset.id;
    });
  });
  return v;
});

// ============================================================
// VIEW: Application detail / new (#/applications/:id)
// ============================================================
route(/^\/applications\/(?<id>.+)$/, async ({ id }) => {
  const isNew = id === 'new';
  let job = null;
  if (!isNew) {
    const r = await api('/jobs/' + encodeURIComponent(id));
    job = r.job;
  }
  if (!isNew && !job) {
    return el(`<div><header class="page-header"><div>
      <a href="#/applications" class="back-link">← All applications</a>
      <h1 class="page-title" style="margin-top:10px">Not found</h1>
    </div></header></div>`);
  }
  const events = isNew ? [] : ((await api('/events?jobId=' + encodeURIComponent(id)).catch(() => ({ items: [] }))).items || []);
  const emailData = isNew ? { matched: [], suggested: [] } : (await api('/emails?jobId=' + encodeURIComponent(id)).catch(() => ({ matched: [], suggested: [] })));
  const j = job || {};

  // Deep-link a synced email back to the real message in the user's Gmail. rfc822msgid: searches by
  // the RFC-822 Message-ID header (most reliable across accounts); thread id is the fallback. Opened
  // via target=_blank → the desktop app's will-navigate handler sends it to the default browser.
  const gmailLink = (e) => {
    const mid = String(e.messageId || '').replace(/[<>]/g, '').trim();
    if (mid) return 'https://mail.google.com/mail/u/0/#search/' + encodeURIComponent('rfc822msgid:' + mid);
    if (e.threadId) return 'https://mail.google.com/mail/u/0/#all/' + encodeURIComponent(e.threadId);
    return null;
  };
  const emailRow = (e, mode) => { const gl = gmailLink(e); return `<div class="mail-row" data-email="${esc(e.id)}">
      <div class="mail-head"><span class="out-chip cat-${esc(e.category || 'other')}">${esc(String(e.category || 'other').replace(/_/g, ' '))}</span>
        ${gl ? `<a class="mail-subj" href="${esc(gl)}" target="_blank" rel="noopener" title="Open in Gmail">${esc(e.subject || '(no subject)')} ↗</a>` : `<span class="mail-subj">${esc(e.subject || '(no subject)')}</span>`}</div>
      <div class="mail-sub muted">${esc(e.fromName || e.from || '')} · ${esc(fmtRel(e.sentAt))}${e.matchConfidence ? ` · ${Math.round(e.matchConfidence * 100)}% match` : ''}</div>
      ${e.snippet ? `<div class="mail-snip muted">${esc(e.snippet)}</div>` : ''}
      <div class="mail-actions">${gl ? `<a class="btn small" href="${esc(gl)}" target="_blank" rel="noopener">Open in Gmail ↗</a> ` : ''}${mode === 'suggested'
        ? `<button class="btn small primary" data-email-confirm="${esc(e.id)}">Yes, link it</button> <button class="btn small" data-email-dismiss="${esc(e.id)}">Not this</button>`
        : `<button class="btn small" data-email-unlink="${esc(e.id)}">Unlink</button>`}</div>
    </div>`; };
  const emailPanelHtml = isNew ? '<div class="muted">Save the application first.</div>' : `
    ${(emailData.matched || []).length ? (emailData.matched).map((e) => emailRow(e, 'matched')).join('') : '<div class="muted" style="font-size:13px">No emails matched yet. Connect your inbox in Settings → it auto-links replies here.</div>'}
    ${(emailData.suggested || []).length ? `<div class="mail-suggest-head">Suggested — does this belong to this job?</div>${emailData.suggested.map((e) => emailRow(e, 'suggested')).join('')}` : ''}
    <details class="fold mail-find"><summary>+ Link an email manually</summary>
      <input class="input" id="mail-search" placeholder="search your synced emails…" style="margin:8px 0" />
      <div id="mail-search-results" class="muted" style="font-size:13px">Type to search unmatched emails.</div>
    </details>`;

  const field = (label, idd, value, ph = '', type = 'text') =>
    `<div class="form-row"><label class="form-label" for="${idd}">${esc(label)}</label>
     <div class="form-control"><input class="input" id="${idd}" type="${type}" value="${esc(value ?? '')}" placeholder="${esc(ph)}" /></div></div>`;

  const timelineHtml = events.length ? events.map((e) => `
    <div class="timeline-item">
      <div class="timeline-dot"></div>
      <div>
        <div class="timeline-title">${esc(e.summary || e.type)}</div>
        <div class="timeline-sub">${esc(fmtRel(e.timestamp))} · ${esc(e.source || '')}</div>
      </div>
    </div>`).join('')
    : `<div class="empty" style="padding:30px 24px"><div class="empty-sub">${isNew ? 'Save the application to start a timeline.' : 'No events yet.'}</div></div>`;

  const answersRows = Object.entries(j.answers || {}).map(([k, val]) =>
    `<div class="form-row"><div class="form-label">${esc(k.replace(/_/g, ' '))}</div><div class="form-control muted">${esc(val)}</div></div>`).join('');

  const v = el(`<div>
    <header class="page-header">
      <div>
        <a href="#/applications" class="back-link">← All applications</a>
        <h1 class="page-title" style="margin-top:10px">${isNew ? 'New application' : esc(j.title || 'Untitled')}</h1>
        <div class="page-sub" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">${isNew ? 'Capture the essentials.' : `<span>${esc(j.company || '') + (j.location ? ' · ' + esc(j.location) : '')}</span> ${viaBadge(j)}`}</div>
      </div>
      <div class="page-actions">
        ${isNew ? '' : '<button class="btn" data-delete>Delete</button>'}
        <button class="btn" data-cancel>Cancel</button>
        <button class="btn primary" data-save>${isNew ? 'Save application' : 'Save changes'}</button>
      </div>
    </header>

    ${j.needsReview ? `<div class="banner"><div class="banner-text">This capture was sparse — check title and company, then mark it reviewed.</div>
      <button class="btn small" data-reviewed>Looks good</button></div>` : ''}

    <div class="status-line" id="save-status"></div>

    <div class="app-detail">
      <div>
        <section class="section">
          <header class="section-header"><div><div class="section-eyebrow">Job</div><h2 class="section-title">Posting</h2></div></header>
          ${field('Title', 'f-title', j.title, 'Senior Frontend Engineer')}
          ${field('Company', 'f-company', j.company, 'Acme Corp')}
          ${field('Location', 'f-location', j.location, 'Remote · Toronto, ON')}
          ${field('Compensation', 'f-comp', j.compensation, '$120k–$160k CAD')}
          ${field('Source', 'f-source', j.source, 'linkedin')}
          <div class="form-row"><label class="form-label" for="f-url">Job URL</label>
            <div class="form-control url-row">
              <input class="input" id="f-url" value="${esc(j.jobUrl || '')}" placeholder="https://…" />
              ${j.jobUrl ? `<a href="${esc(j.jobUrl)}" target="_blank" rel="noopener" title="Open posting" data-open-url>↗</a>` : ''}
            </div></div>
          ${field('Work mode', 'f-mode', j.workMode, 'Remote / Hybrid / On-site')}
          ${field('Type', 'f-type', j.employmentType, 'Full-time')}
        </section>

        <section class="section">
          <header class="section-header"><div><div class="section-eyebrow">Marginalia</div><h2 class="section-title">Notes</h2></div></header>
          <div class="section-body">
            <textarea class="input" id="f-notes" rows="6" style="width:100%;resize:vertical" placeholder="Anything worth remembering…">${esc(j.notes || '')}</textarea>
          </div>
        </section>

        ${(j.attachments && j.attachments.length) ? `<section class="section">
          <header class="section-header"><div><div class="section-eyebrow">Files</div><h2 class="section-title">Attachments</h2></div></header>
          <div class="section-body">
            ${j.attachments.map((a) => `<div class="kv"><span class="role-badge" data-role="${esc(a.role)}">${esc(a.role)}</span> <strong>${esc(a.name)}</strong> <span class="muted">${a.sizeBytes ? '(' + fmtBytes(a.sizeBytes) + ')' : ''}</span></div>`).join('')}
          </div>
        </section>` : ''}

        ${answersRows ? `<section class="section">
          <header class="section-header"><div><div class="section-eyebrow">Captured</div><h2 class="section-title">Form answers</h2></div></header>
          ${answersRows}
        </section>` : ''}

        ${isNew ? '' : `<section class="section" id="email-section">
          <header class="section-header"><div><div class="section-eyebrow">Mailbox</div><h2 class="section-title">Emails</h2>
            <div class="form-hint">Replies &amp; confirmations JAT matched to this application.</div></div></header>
          <div class="section-body" id="email-panel">${emailPanelHtml}</div>
        </section>`}
      </div>

      <div>
        <section class="section">
          <header class="section-header"><div><div class="section-eyebrow">Standing</div><h2 class="section-title">Status</h2></div></header>
          <div class="form-row"><label class="form-label" for="f-status">Status</label>
            <div class="form-control"><select class="select" id="f-status">${statusOptions(j.status || 'started')}</select></div></div>
          ${field('Next action', 'f-next', j.nextAction, 'Follow up via email')}
          ${field('Due', 'f-due', (j.dueAt || '').slice(0, 10), '', 'date')}
          <div class="form-row"><div class="form-label">Tags</div><div class="form-control" id="f-tags-slot"></div></div>
          ${j.submittedAt ? `<div class="form-row"><div class="form-label">Submitted</div><div class="form-control muted">${esc(fmtFull(j.submittedAt))}</div></div>` : ''}
        </section>

        ${isNew ? '' : `<section class="section">
          <header class="section-header"><div><div class="section-eyebrow">Assistant</div><h2 class="section-title">AI</h2></div></header>
          <div class="section-body" style="display:flex;flex-wrap:wrap;gap:8px">
            <button class="btn small" data-ai="fit">Fit score</button>
            <button class="btn small" data-ai="summarize">Summarize</button>
            <button class="btn small" data-ai="cover">Cover letter</button>
            <button class="btn small" data-ai="tailor">Tailor resume</button>
            <button class="btn small" data-ai="followup">Follow-up draft</button>
            <button class="btn small" data-ai="queue">Queue auto-apply</button>
          </div>
          <div id="fit-slot">${j.fitData ? '' : ''}</div>
        </section>`}

        <section class="section">
          <header class="section-header"><div><div class="section-eyebrow">Record</div><h2 class="section-title">Timeline</h2></div></header>
          <div class="timeline">${timelineHtml}</div>
        </section>
      </div>
    </div>
  </div>`);

  const tags = chipsInput(j.tags || [], 'Add tag…');
  v.querySelector('#f-tags-slot').appendChild(tags.node);

  const setStatus = (msg, cls = '') => {
    const s = v.querySelector('#save-status');
    s.className = 'status-line ' + cls;
    s.textContent = msg;
  };

  const renderFit = (fit, deterministic) => {
    const slot = v.querySelector('#fit-slot');
    if (!slot || !fit) return;
    slot.innerHTML = `<div class="fit-panel">
      <div class="fit-score-row"><span class="fit-score-big">${esc(fit.score)}</span>
        <span class="fit-summary">${esc(fit.summary || '')}</span></div>
      ${fit.strengths?.length ? `<div class="fit-eyebrow">Strengths</div><ul class="fit-list">${fit.strengths.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
      ${fit.gaps?.length ? `<div class="fit-eyebrow">Gaps</div><ul class="fit-list">${fit.gaps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
      ${deterministic ? `<div class="muted" style="font-size:11px;margin-top:8px">Keyword overlap: ${esc(deterministic.score)}/100</div>` : ''}
    </div>`;
  };
  if (j.fitData?.score != null) renderFit(j.fitData, j.fitData.deterministic);

  if (!isNew) {
    const reviewed = v.querySelector('[data-reviewed]');
    if (reviewed) reviewed.addEventListener('click', async () => {
      try { await api('/jobs/' + encodeURIComponent(id), { method: 'PATCH', body: { needsReview: false } }); navigate(); }
      catch (e) { errToast(e); }
    });

    v.querySelector('[data-delete]').addEventListener('click', async () => {
      try {
        const snapshot = { ...j };
        await api('/jobs/' + encodeURIComponent(id), { method: 'DELETE' });
        location.hash = '#/applications';
        undoToast('Application deleted', async () => {
          await api('/jobs', { method: 'POST', body: { ...snapshot, _manual: true, _source: 'manual' } }).catch(() => {});
          navigate();
        });
      } catch (e) { errToast(e); }
    });

    const aiBusy = async (btn, fn) => {
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = orig + ' …';
      try { await fn(); } catch (e) { errToast(e); }
      btn.disabled = false; btn.textContent = orig;
    };
    v.querySelectorAll('[data-ai]').forEach((btn) => btn.addEventListener('click', () => aiBusy(btn, async () => {
      const kind = btn.dataset.ai;
      if (kind === 'fit') {
        const r = await api('/ai/fit-score', { method: 'POST', body: { jobId: id }, timeoutMs: 180000 });
        renderFit(r.result, r.deterministic);
        toast(`Fit score ${r.result.score} (${r.provider})`);
      } else if (kind === 'summarize') {
        const r = await api('/ai/summarize', { method: 'POST', body: { jobId: id }, timeoutMs: 180000 });
        textModal('Job summary', r.text);
      } else if (kind === 'cover') {
        const r = await api('/ai/cover-letter', { method: 'POST', body: { jobId: id }, timeoutMs: 240000 });
        textModal('Cover letter', r.text, { downloadName: `cover-letter-${(j.company || 'job').replace(/\W+/g, '-')}.txt` });
      } else if (kind === 'tailor') {
        const r = await api('/ai/tailor-resume', { method: 'POST', body: { jobId: id }, timeoutMs: 300000 });
        textModal('Tailored resume', r.text, { downloadName: `resume-${(j.company || 'job').replace(/\W+/g, '-')}.txt` });
      } else if (kind === 'followup') {
        const r = await api('/ai/follow-up', { method: 'POST', body: { jobId: id }, timeoutMs: 180000 });
        textModal('Follow-up email', r.text);
      } else if (kind === 'queue') {
        await api('/queue', { method: 'POST', body: { jobId: id } });
        toast('Queued for auto-apply');
      }
    })));
  }

  v.querySelector('[data-cancel]').addEventListener('click', () => { location.hash = '#/applications'; });
  v.querySelector('[data-save]').addEventListener('click', async () => {
    const val = (sel) => v.querySelector(sel).value.trim();
    const payload = {
      title: val('#f-title') || null,
      company: val('#f-company') || null,
      location: val('#f-location') || null,
      compensation: val('#f-comp') || null,
      source: val('#f-source') || null,
      jobUrl: val('#f-url') || null,
      workMode: val('#f-mode') || null,
      employmentType: val('#f-type') || null,
      notes: v.querySelector('#f-notes').value || null,
      nextAction: val('#f-next') || null,
      dueAt: v.querySelector('#f-due').value || null,
      status: v.querySelector('#f-status').value,
      tags: tags.get(),
      _source: 'manual',
    };
    if (!payload.title || !payload.company) { setStatus('Title and company are required.', 'bad'); return; }
    setStatus('Saving…');
    try {
      if (isNew) {
        const r = await api('/jobs', { method: 'POST', body: { ...payload, _manual: true } });
        location.hash = '#/applications/' + r.job.id;
      } else {
        await api('/jobs/' + encodeURIComponent(id), { method: 'PATCH', body: payload });
        setStatus('Saved ✓', 'ok');
        setTimeout(navigate, 500);
      }
    } catch (e) { setStatus(e.message, 'bad'); }
  });

  // ---- email panel: confirm / dismiss / unlink + manual link ----
  const matchEmail = async (emailId, body) => { try { await api('/emails/match', { method: 'POST', body: { emailId, ...body } }); navigate(); } catch (e) { errToast(e); } };
  v.querySelectorAll('[data-email-confirm]').forEach((b) => b.addEventListener('click', () => matchEmail(b.dataset.emailConfirm, { jobId: id, source: 'manual', confidence: 1 })));
  v.querySelectorAll('[data-email-dismiss]').forEach((b) => b.addEventListener('click', () => matchEmail(b.dataset.emailDismiss, { jobId: null, source: 'dismissed' })));
  v.querySelectorAll('[data-email-unlink]').forEach((b) => b.addEventListener('click', () => matchEmail(b.dataset.emailUnlink, { jobId: null, source: 'dismissed' })));
  const mailSearch = v.querySelector('#mail-search');
  if (mailSearch) mailSearch.addEventListener('input', debounce(async (e) => {
    const q = e.target.value.trim();
    const out = v.querySelector('#mail-search-results');
    if (q.length < 2) { out.textContent = 'Type to search unmatched emails.'; return; }
    try {
      const r = await api('/emails?unmatched=1&q=' + encodeURIComponent(q));
      const items = r.emails || [];
      out.innerHTML = items.length ? items.slice(0, 12).map((m) => `<div class="mail-find-row"><div><div>${esc(m.subject || '(no subject)')}</div><div class="muted" style="font-size:11px">${esc(m.fromName || m.from || '')} · ${esc(fmtRel(m.sentAt))}</div></div><button class="btn small" data-email-link="${esc(m.id)}">Link</button></div>`).join('')
        : 'No matching unmatched emails.';
      out.querySelectorAll('[data-email-link]').forEach((b) => b.addEventListener('click', () => matchEmail(b.dataset.emailLink, { jobId: id, source: 'manual', confidence: 1 })));
    } catch (err) { out.textContent = err.message || String(err); }
  }, 350));

  return v;
});

// ============================================================
// VIEW: Pipeline kanban (#/pipeline)
// ============================================================
route('/pipeline', async () => {
  const r = await api('/jobs?limit=500');
  const jobs = r.items || [];
  const b = state.board;
  const emailAcctR = await api('/email/accounts').catch(() => null);
  const gmailR = await api('/gmail/status').catch(() => null);
  // "Connected" = an IMAP account OR an authorized Gmail (OAuth). Without the Gmail check the
  // banner nags forever for users who connected via Gmail rather than an app-password.
  const hasEmail = !!(emailAcctR && (emailAcctR.accounts || []).length) || !!(gmailR && gmailR.authorized);
  const emailBannerOff = (() => { try { return localStorage.getItem('jat11.emailBannerDismissed') === '1'; } catch { return false; } })();

  const sources = [...new Set(jobs.map((j) => j.source).filter(Boolean))].sort();
  const q = b.q.toLowerCase();
  const filtered = jobs.filter((j) => {
    if (b.source !== 'all' && j.source !== b.source) return false;
    if (b.minFit && !(j.fitScore != null && j.fitScore >= b.minFit)) return false;
    if (q) {
      const hay = `${j.title || ''} ${j.company || ''} ${j.location || ''} ${(j.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const cmp = (x, y) => {
    let c = 0;
    if (b.sort === 'fit') c = (y.fitScore ?? -1) - (x.fitScore ?? -1);
    else if (b.sort === 'title') c = String(x.title || '').localeCompare(String(y.title || ''));
    else if (b.sort === 'createdAt') c = new Date(y.createdAt || 0) - new Date(x.createdAt || 0);
    else c = new Date(y.updatedAt || 0) - new Date(x.updatedAt || 0);
    return b.dir === 'asc' ? -c : c;
  };

  const byStatus = {};
  for (const s of STATUSES) byStatus[s.id] = [];
  for (const j of filtered) (byStatus[j.status] || (byStatus[j.status] = [])).push(j);
  for (const s of STATUSES) byStatus[s.id].sort(cmp);

  const GROUPS = { started: 'Pre', submitted: 'Active', contacted: 'Active', assessment: 'Active', interview_1: 'Interviews', interview_2: 'Interviews', interview_final: 'Interviews', offer: 'Closing', hired: 'Closing', rejected: 'Closed', withdrawn: 'Closed', ghosted: 'Closed' };
  const TERMINAL_S = ['hired', 'rejected', 'withdrawn', 'ghosted'];
  const STALE_DAYS = 14;

  const initials = (s) => (String(s || '?').trim().match(/\b\w/g) || ['?']).slice(0, 2).join('').toUpperCase();
  const avatarHue = (s) => { let h = 0; for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
  const cardHtml = (j) => {
    const stale = j.updatedAt && (Date.now() - new Date(j.updatedAt).getTime()) > STALE_DAYS * 86400000 && !TERMINAL_S.includes(j.status);
    const fitCls = j.fitScore == null ? '' : (j.fitScore >= 70 ? 'fit-good' : j.fitScore >= 45 ? 'fit-mid' : 'fit-low');
    const tags = (j.tags || []).slice(0, 3).map((t) => `<span class="kb-tag">${esc(t)}</span>`).join('');
    const sub = [];
    if (j.source) sub.push(`<span class="kb-source">${esc(j.source)}</span>`);
    if (j.location) sub.push(`<span class="kb-loc">${esc(j.location)}</span>`);
    if (j.via === 'auto') sub.push('<span class="via-badge via-auto">⚡ Auto</span>');
    else if (j.via === 'auto-assisted') sub.push('<span class="via-badge via-assisted">⚡ Auto (assisted)</span>');
    else if (j.via === 'manual') sub.push('<span class="via-badge via-manual">✋ Manual</span>');
    return `<div class="kb-card ${fitCls} ${stale ? 'stale' : ''}" draggable="true" data-id="${esc(j.id)}">
      <div class="kb-card-top">
        <span class="kb-avatar" style="--hue:${avatarHue(j.company || j.title)}">${esc(initials(j.company || j.title))}</span>
        <div class="kb-card-id">
          <div class="t">${j.needsReview ? '<span class="kb-warn" title="Needs review">⚠</span> ' : ''}${esc(j.title || 'Untitled')}</div>
          <div class="c">${esc(j.company || '')}</div>
        </div>
        ${fitBadgeHtml(j.fitScore)}
      </div>
      ${sub.length ? `<div class="kb-sub">${sub.join('')}</div>` : ''}
      ${tags ? `<div class="kb-tags">${tags}</div>` : ''}
      <div class="kb-meta"><span class="${stale ? 'stale-txt' : ''}">${esc(daysIn(j.updatedAt))}</span></div>
    </div>`;
  };

  const cols = STATUSES.filter((s) => !b.hiddenCols.includes(s.id)).map((s) => {
    const collapsed = b.collapsed.includes(s.id);
    return `<div class="kb-col ${collapsed ? 'collapsed' : ''}" data-status="${s.id}">
      <div class="kb-group">${esc(GROUPS[s.id] || '')}</div>
      <div class="kb-head" data-status="${s.id}">
        <span style="display:flex;align-items:center;gap:8px;min-width:0">
          <button class="kb-collapse" data-collapse="${s.id}" title="Collapse / expand">${collapsed ? '▸' : '▾'}</button>
          <span class="dot"></span><span class="kb-label">${esc(s.label)}</span>
        </span>
        <span class="n">${byStatus[s.id].length}</span>
      </div>
      <div class="kb-body">${byStatus[s.id].map(cardHtml).join('')}</div>
    </div>`;
  }).join('');

  const v = el(`<div>
    <header class="page-header">
      <div>
        <div class="page-eyebrow">Board</div>
        <h1 class="page-title">Pipeline</h1>
        <div class="page-sub">Drag a card to change its status${filtered.length !== jobs.length ? ` · ${filtered.length}/${jobs.length} shown` : ''}.</div>
      </div>
      <div class="page-actions">
        <button class="btn" data-columns>Columns</button>
        <button class="btn" data-refresh>Refresh</button>
      </div>
    </header>

    ${(!hasEmail && !emailBannerOff) ? `<div class="banner email-banner">
      <div class="banner-text">📬 <strong>Connect your email</strong> to auto-track replies, interview invites &amp; offers on each application — JAT matches them to the right job for you.</div>
      <a class="btn small primary" href="#/settings">Connect email →</a>
      <button class="btn small" data-email-banner-dismiss>Dismiss</button>
    </div>` : ''}

    <div class="board-toolbar">
      <input class="input" id="pb-q" placeholder="Search title, company, tag…" value="${esc(b.q)}" style="min-width:180px" />
      <select class="select" id="pb-source"><option value="all">All sources</option>${sources.map((sc) => `<option value="${esc(sc)}" ${b.source === sc ? 'selected' : ''}>${esc(sc)}</option>`).join('')}</select>
      <select class="select" id="pb-fit"><option value="0">Any fit</option><option value="45" ${b.minFit === 45 ? 'selected' : ''}>Fit 45+</option><option value="70" ${b.minFit === 70 ? 'selected' : ''}>Fit 70+</option></select>
      <select class="select" id="pb-sort">
        <option value="updatedAt" ${b.sort === 'updatedAt' ? 'selected' : ''}>Recently updated</option>
        <option value="createdAt" ${b.sort === 'createdAt' ? 'selected' : ''}>Newest</option>
        <option value="fit" ${b.sort === 'fit' ? 'selected' : ''}>Best fit</option>
        <option value="title" ${b.sort === 'title' ? 'selected' : ''}>Title</option>
      </select>
      <button class="btn small" id="pb-dir" title="Toggle sort direction">${b.dir === 'asc' ? '↑' : '↓'}</button>
      <button class="btn small" id="pb-density" title="Toggle card density">${b.density === 'compact' ? 'Compact' : 'Comfortable'}</button>
    </div>

    <div class="kanban" data-density="${esc(b.density)}">${cols}</div>
  </div>`);

  const apply = () => { persistBoard(); navigate(); };
  v.querySelector('#pb-q').addEventListener('input', debounce((e) => { state.board.q = e.target.value.trim(); navigate(); }, 250));
  v.querySelector('#pb-source').addEventListener('change', (e) => { state.board.source = e.target.value; apply(); });
  v.querySelector('#pb-fit').addEventListener('change', (e) => { state.board.minFit = Number(e.target.value) || 0; apply(); });
  v.querySelector('#pb-sort').addEventListener('change', (e) => { state.board.sort = e.target.value; apply(); });
  v.querySelector('#pb-dir').addEventListener('click', () => { state.board.dir = state.board.dir === 'asc' ? 'desc' : 'asc'; apply(); });
  v.querySelector('#pb-density').addEventListener('click', () => { state.board.density = state.board.density === 'compact' ? 'comfortable' : 'compact'; apply(); });

  v.querySelectorAll('[data-collapse]').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const set = new Set(state.board.collapsed);
    set.has(btn.dataset.collapse) ? set.delete(btn.dataset.collapse) : set.add(btn.dataset.collapse);
    state.board.collapsed = [...set];
    apply();
  }));

  v.querySelector('[data-columns]').addEventListener('click', () => {
    const m = el(`<div class="modal">
      <div class="modal-head"><h3 class="modal-title">Columns</h3><button class="toast-x" data-close aria-label="Close">×</button></div>
      <div class="modal-body"><div class="col-toggle-list">${STATUSES.map((s) => `<label class="col-toggle"><input type="checkbox" data-col="${s.id}" ${b.hiddenCols.includes(s.id) ? '' : 'checked'} /> ${esc(s.label)}</label>`).join('')}</div></div>
      <div class="modal-foot"><button class="btn small" data-hide-closed>Hide closed</button><button class="btn small primary" data-close>Done</button></div>
    </div>`);
    const close = openOverlay(m);
    m.querySelectorAll('[data-close]').forEach((b2) => b2.addEventListener('click', () => { close(); navigate(); }));
    m.querySelectorAll('[data-col]').forEach((cb) => cb.addEventListener('change', () => {
      const hidden = new Set(state.board.hiddenCols);
      cb.checked ? hidden.delete(cb.dataset.col) : hidden.add(cb.dataset.col);
      state.board.hiddenCols = [...hidden];
      persistBoard();
    }));
    m.querySelector('[data-hide-closed]').addEventListener('click', () => {
      state.board.hiddenCols = [...new Set([...state.board.hiddenCols, ...TERMINAL_S])];
      persistBoard(); close(); navigate();
    });
  });

  v.querySelector('[data-refresh]').addEventListener('click', navigate);
  v.querySelector('[data-email-banner-dismiss]')?.addEventListener('click', (e) => {
    try { localStorage.setItem('jat11.emailBannerDismissed', '1'); } catch {}
    e.currentTarget.closest('.email-banner')?.remove();
  });

  v.querySelectorAll('.kb-card').forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('click', () => { location.hash = '#/applications/' + card.dataset.id; });
    card.addEventListener('contextmenu', (e) => contextMenu(e, [
      { label: 'Open', run: () => { location.hash = '#/applications/' + card.dataset.id; } },
      { sep: true },
      ...STATUSES.map((s) => ({ label: `→ ${s.label}`, run: async () => { await api('/jobs/' + encodeURIComponent(card.dataset.id), { method: 'PATCH', body: { status: s.id, _source: 'manual' } }); navigate(); } })),
      { sep: true },
      { label: 'Queue auto-apply', run: async () => { await api('/queue', { method: 'POST', body: { jobId: card.dataset.id } }); toast('Queued for auto-apply'); } },
      { label: 'Delete', danger: true, run: async () => { if (!(await confirmModal('Delete this application?', { danger: true, okLabel: 'Delete' }))) return; await api('/jobs/' + encodeURIComponent(card.dataset.id), { method: 'DELETE' }); navigate(); } },
    ]));
  });

  v.querySelectorAll('.kb-col').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('dragover'); });
    col.addEventListener('dragleave', () => col.classList.remove('dragover'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('dragover');
      const jobId = e.dataTransfer.getData('text/plain');
      const status = col.dataset.status;
      if (!jobId || !status) return;
      // Optimistic move: relocate the card + adjust counts now, PATCH in the
      // background. Avoids the full re-render flicker and scroll jump.
      const card = v.querySelector(`.kb-card[data-id="${CSS.escape(jobId)}"]`);
      const fromCol = card?.closest('.kb-col');
      const body = col.querySelector('.kb-body');
      if (card && body && fromCol !== col) {
        body.appendChild(card);
        const bump = (c, d) => { const n = c?.querySelector('.kb-head .n'); if (n) n.textContent = String((Number(n.textContent) || 0) + d); };
        bump(fromCol, -1); bump(col, +1);
      }
      try {
        await api('/jobs/' + encodeURIComponent(jobId), { method: 'PATCH', body: { status, _source: 'manual' } });
      } catch (err) { errToast(err); navigate(); }
    });
  });

  return v;
});

// ============================================================
// VIEW: Auto-apply queue (#/queue)
// ============================================================
route('/queue', async () => {
  const [settings, queueR, profilesR, docsR, parkedR, discR] = await Promise.all([
    getSettings(true), api('/queue'),
    api('/profiles').catch(() => ({ items: [] })),
    api('/documents').catch(() => ({ items: [] })),
    api('/queue/parked').catch(() => ({ items: [] })),
    api('/auto-apply/discovery-status').catch(() => ({ status: null })),
  ]);
  const disc = discR.status || null;
  const discHealth = discR.health || { providers: [], pendingFallbacks: 0 };
  const latestDiscovery = (discR.batches || [])[0] || null;
  const aa = settings.autoApply;
  const tasks = queueR.items || [];
  const profiles = profilesR.items || [];
  const resumes = (docsR.items || []).filter((d) => d.role === 'resume');
  const parked = parkedR.items || [];
  const boards = aa.boards || ['linkedin', 'indeed'];
  const working = tasks.some((t) => t.state === 'running' || t.state === 'scheduled');
  const groups = new Map(QUEUE_STATE_ORDER.map((s) => [s, []]));
  for (const t of tasks) (groups.get(t.state) || groups.set(t.state, []).get(t.state)).push(t);

  const qc = (label, html) => `<div class="qc-field"><span class="qc-label form-label">${esc(label)}</span>${html}</div>`;

  const lastLogOf = (t) => {
    // The lean /queue list carries the last line as t.lastLog (no transcript blob); fall back to
    // the full transcript when present (full-mode / already-fetched task).
    if (typeof t.lastLog === 'string') return t.lastLog;
    const e = (t.transcript || []).filter((x) => x && (x.text || x.note)).slice(-1)[0];
    return e ? (e.text || e.note || '') : '';
  };
  const taskCard = (t) => `
    <div class="task-card" data-task="${esc(t.id)}">
      <div class="task-head">
        <span class="task-title">${esc(t.job?.title || '?')} <span class="muted">· ${esc(t.job?.company || '')}</span></span>
        <span class="state-chip" data-state="${esc(t.state)}">${esc(QUEUE_STATE_LABEL[t.state] || t.state)}</span>
      </div>
      <div class="task-sub">${esc(t.mode)} mode · ${esc(t.attempts)} attempt${t.attempts === 1 ? '' : 's'} · updated ${esc(fmtRel(t.updatedAt))}</div>
      ${t.parkReason ? `<div class="task-park">⚑ ${esc(t.parkReason)}${(t.pendingQuestions || []).length ? ' — answer below to retry' : ''}</div>` : ''}
      ${t.lastError ? `<div class="task-err">${esc(t.lastError)}</div>` : ''}
      ${(['failed', 'awaiting_input'].includes(t.state) && lastLogOf(t)) ? `<div class="task-last">last step: ${esc(lastLogOf(t).slice(0, 140))}</div>` : ''}
      <div class="task-actions">
        ${['failed', 'skipped', 'awaiting_input'].includes(t.state) ? '<button class="btn small" data-act="retry">Retry</button>' : ''}
        ${['queued', 'scheduled', 'running'].includes(t.state) ? '<button class="btn small" data-act="cancel">Cancel</button>' : ''}
        ${(t.hasTranscript || t.transcript?.length) ? '<button class="btn small" data-act="transcript">Transcript</button>' : ''}
        ${t.job?.jobUrl ? `<a class="btn small" href="${esc(t.job.jobUrl)}" target="_blank" rel="noopener">Open job</a>` : ''}
        <button class="btn small" data-act="delete">Remove</button>
      </div>
      <div class="transcript" hidden><div class="transcript-entries"></div></div>
    </div>`;

  // OOM FIX: render a task's transcript lines LAZILY (only when its panel is first opened). Rendering
  // every task's full transcript into hidden DOM up front built ~233k nodes on the queue page (live
  // [heap] log: 82 → 233,551 nodes in 60s on #/queue) → the renderer OOM-crashed. Cap at the last 200
  // lines so one huge transcript can't bloat the DOM either.
  const fillTranscript = async (card, t) => {
    const box = card.querySelector('.transcript-entries');
    if (!box || box.dataset.filled === '1') return;
    // The queue list is now LEAN (no transcript blob) to keep /queue small — so fetch the full
    // task's transcript on demand the first time the panel opens. Full-mode items still carry it.
    let tr = Array.isArray(t?.transcript) ? t.transcript : null;
    if (!tr) {
      box.dataset.filled = '1';   // guard against a double-click firing two fetches
      try { const r = await api('/queue/' + encodeURIComponent(t.id)); tr = (r && r.task && r.task.transcript) || []; }
      catch { tr = []; }
    }
    const lines = tr.filter((e2) => e2 && (e2.text || e2.note)).slice(-200);
    box.innerHTML = lines.map((e2) => `<div class="tr-line"><span class="tr-ts">${esc((e2.ts || '').slice(11, 19))}</span><span class="tr-body ${esc(e2.level || '')}">${esc(e2.text || e2.note || JSON.stringify(e2))}</span></div>`).join('');
    box.dataset.filled = '1';
  };

  // OOM FIX 2: cap the number of task CARDS rendered per state group. Rendering every task
  // built ~23,400 nodes on a real queue (1,716 tasks) and the renderer's heap climbed to
  // 441-561MB over hours until Chromium OOM-killed it (10 crashes in the live [heap] log,
  // every one on route #/queue, peaking at 2,995MB of a 3,586MB limit). Terminal states are
  // the bulk and are pure history — show the newest few and reveal more on demand.
  const renderCap = (s) => (['running', 'awaiting_review', 'awaiting_input', 'queued', 'scheduled'].includes(s) ? 60 : 15);
  const groupsHtml = [...groups.entries()]
    .filter(([, list]) => list.length)
    .map(([s, list]) => {
      const cap = renderCap(s);
      const shown = list.slice(0, cap);
      const hidden = list.length - shown.length;
      const more = hidden > 0
        ? `<div class="queue-more"><button class="btn small" data-more-state="${esc(s)}">Show ${Math.min(hidden, cap)} more</button><span class="muted" style="margin-left:10px">${hidden} older hidden</span></div>`
        : '';
      return `<div class="queue-group-head"><span>${esc(QUEUE_STATE_LABEL[s] || s)}</span><span class="n">${list.length}</span></div>${shown.map(taskCard).join('')}${more}`;
    })
    .join('') || emptyHtml('Idle', 'Nothing queued', 'Add keywords above and press Start — it searches Easy-Apply jobs and applies, paced.');
  // Which queue pane is showing (driven by a stored pref so a soft morph refresh
  // doesn't reset the user's Queue↔History choice).
  const qview = (() => { try { return localStorage.getItem('jat11.queue.view') === 'history' ? 'history' : 'tasks'; } catch { return 'tasks'; } })();

  const intakeHtml = parked.length ? `
    <section class="section aa-intake" data-keep>
      <header class="section-header"><div><div class="section-eyebrow">Self-healing</div><h2 class="section-title">Needs your input</h2>
        <div class="form-hint">${parked.length} question(s) auto-apply couldn't answer confidently. Answer them — they're saved to your profile and the set-aside jobs retry automatically.</div></div></header>
      ${parked.map((q) => `<div class="form-row"><div class="form-label">${esc(q.question)}${q.reason ? `<div class="form-hint">${esc(q.reason)}</div>` : ''}</div>
        <div class="form-control">${(q.options && q.options.length)
          ? `<select class="select aa-intake-a" data-q="${esc(q.question)}" data-ft="${esc(q.fieldType || '')}"><option value="">—</option>${q.options.map((o) => `<option>${esc(o)}</option>`).join('')}</select>`
          : `<input class="input aa-intake-a" data-q="${esc(q.question)}" data-ft="${esc(q.fieldType || '')}" />`}</div></div>`).join('')}
      <div class="section-footer"><button class="btn small primary" data-intake-save>Save answers & retry jobs</button></div>
    </section>` : '';

  const v = el(`<div>
    <header class="page-header">
      <div>
        <div class="page-eyebrow">Automate</div>
        <h1 class="page-title">Auto-apply</h1>
        <div class="page-sub">Searches Easy-Apply jobs and applies — paced, review-first, always stoppable.</div>
      </div>
      <div class="page-actions aa-master">
        <span class="aa-timer" id="aa-timer" data-start="${aa.enabled && aa.startedAt ? esc(aa.startedAt) : ''}" title="Running for">${aa.enabled && aa.startedAt ? fmtElapsed(Date.now() - Date.parse(aa.startedAt)) : ''}</span>
        <button class="btn aa-power ${aa.enabled ? 'danger' : 'primary'}" data-power>${aa.enabled ? '⏹ Stop' : '▶ Start'}</button>
        <button class="btn" data-save>Save settings</button>
      </div>
    </header>

    ${working ? '<div class="aa-running"><span class="aa-pulse"></span> Auto-apply is working in a background tab — <strong>don\'t touch that window</strong>. It\'s paced and you can Stop any time.</div>' : ''}
    ${(aa.enabled && aa.idleOnly === true && disc && disc.paused) ? `<div class="aa-running" style="background:rgba(120,124,160,.14);border-color:rgba(120,124,160,.35)">🌙 <strong>Idle-pause</strong> — ${esc(disc.pauseReason || 'you\'re using the computer')}. Auto-apply resumes automatically the moment you\'re idle and nothing is playing.</div>` : ''}

    <div id="aa-live" data-keep></div>

    <div class="aa-disco">
      <div class="aa-disco-main">
        <span class="aa-disco-eyebrow">Last search</span>
        ${latestDiscovery ? `<span class="aa-disco-txt"><strong>${esc(latestDiscovery.provider)}</strong> / ${esc(latestDiscovery.source)} · "${esc(latestDiscovery.keyword || '')}" — ${esc(latestDiscovery.status)}, found <strong>${esc(latestDiscovery.found || 0)}</strong>, queued <strong>${esc(latestDiscovery.accepted || 0)}</strong>${latestDiscovery.error ? ` · <span class="aa-disco-note">${esc(latestDiscovery.error)}</span>` : ''} <span class="muted">(${esc(fmtRel(latestDiscovery.completedAt || latestDiscovery.startedAt))})</span>${discHealth.pendingFallbacks ? ` · ${esc(discHealth.pendingFallbacks)} browser fallback pending` : ''}</span>`
          : '<span class="muted">No search yet. The desktop app runs JobSpy first and asks Chrome only when a board provider fails.</span>'}
      </div>
      <div class="aa-disco-actions">
        <button class="btn small primary" data-supervise-next title="Open the next application in Control Studio with live robot vision, pause, step, correction, recovery, skip and explicit submit controls.">Open Control Studio for next application</button>
        <button class="btn small" data-run-disco>Search now</button>
        ${state.host === 'extension' ? '<button class="btn small" data-test-apply title="Apply the next queued job right now, skipping pacing.">Apply next now</button>' : ''}
      </div>
    </div>

    ${intakeHtml}

    <section class="section">
      <header class="section-header"><div><div class="section-eyebrow">Target</div><h2 class="section-title">What to apply to</h2></div></header>
      <div class="queue-controls section-body" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px">
        ${qc('Keywords', '<div id="aa-keywords-slot"></div>')}
        ${qc('Locations', '<div id="aa-locations-slot"></div><div class="form-hint">Geography only — e.g. Toronto, ON · Canada. For remote/hybrid use Work mode, not a location.</div>')}
        ${qc('Work mode', `<label class="aa-chk"><input type="checkbox" id="aa-wm-remote" ${(aa.workModes || []).includes('remote') ? 'checked' : ''}/> Remote</label> <label class="aa-chk"><input type="checkbox" id="aa-wm-hybrid" ${(aa.workModes || []).includes('hybrid') ? 'checked' : ''}/> Hybrid</label> <label class="aa-chk"><input type="checkbox" id="aa-wm-onsite" ${(aa.workModes || []).includes('onsite') ? 'checked' : ''}/> On-site</label><div class="form-hint">Filter by how you work. None checked = any. Separate from Locations so "remote" never means worldwide.</div>`)}
        ${qc('Country', `<input class="input" id="aa-country" value="${esc(aa.country || 'Canada')}" placeholder="Canada" /><div class="form-hint">Hard limit — every search stays inside this country.</div>`)}
        ${qc('Mode', `<select class="select" id="aa-mode">
          <option value="auto" ${aa.mode === 'auto' ? 'selected' : ''}>Auto — submit for me</option>
          <option value="review" ${aa.mode === 'review' ? 'selected' : ''}>Review — stop before submit</option>
        </select>`)}
        ${qc('Job boards', `<label class="aa-chk"><input type="checkbox" id="aa-li" ${boards.includes('linkedin') ? 'checked' : ''}/> LinkedIn</label> <label class="aa-chk"><input type="checkbox" id="aa-in" ${boards.includes('indeed') ? 'checked' : ''}/> Indeed</label> <label class="aa-chk"><input type="checkbox" id="aa-gd" ${boards.includes('glassdoor') ? 'checked' : ''}/> Glassdoor</label> <label class="aa-chk"><input type="checkbox" id="aa-google" ${boards.includes('google') ? 'checked' : ''}/> Google Jobs</label> <label class="aa-chk"><input type="checkbox" id="aa-zip" ${boards.includes('zip_recruiter') ? 'checked' : ''}/> ZipRecruiter</label>`)}
        ${qc('Easy Apply only', `<label class="toggle"><input type="checkbox" id="aa-easy" ${aa.easyApplyOnly !== false ? 'checked' : ''} /><span class="knob"></span></label><div class="form-hint">On = only 1-click / in-page applies. Off = also includes normal postings and tries the company/ATS handoff, then fills the external form when it can.</div>`)}
        ${qc('Apply with profile', `<select class="select" id="aa-profile"><option value="">Default</option>${profiles.map((p) => `<option value="${esc(p.id)}" ${aa.profileId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`)}
        ${qc('Attach résumé', `<select class="select" id="aa-resume"><option value="">Active résumé</option>${resumes.map((d) => `<option value="${esc(d.id)}" ${aa.resumeDocId === d.id ? 'selected' : ''}>${esc(d.label || d.name)}</option>`).join('')}</select>`)}
        ${qc('Your experience (years)', `<input class="input" id="aa-exp" type="number" min="0" max="40" value="${Number(aa.experienceYears) || 0}" /><div class="form-hint">skip roles that demand many more years than this (0 = off)</div>`)}
        ${qc('Max seniority', `<select class="select" id="aa-seniority">
          <option value="any" ${(aa.seniorityMax || 'any') === 'any' ? 'selected' : ''}>Any level</option>
          <option value="entry" ${aa.seniorityMax === 'entry' ? 'selected' : ''}>Entry / Junior only</option>
          <option value="mid" ${aa.seniorityMax === 'mid' ? 'selected' : ''}>Up to Mid</option>
          <option value="senior" ${aa.seniorityMax === 'senior' ? 'selected' : ''}>Up to Senior (skip Lead/Manager)</option>
        </select>`)}
        ${qc('Exclude titles', '<div id="aa-exclude-slot"></div><div class="form-hint">skip any title containing these</div>')}
        ${qc('Exclude companies', '<div id="aa-exclude-companies-slot"></div><div class="form-hint">skip any company containing these</div>')}
        ${qc('Exclude locations', '<div id="aa-exclude-locations-slot"></div><div class="form-hint">skip any location containing these</div>')}
      </div>
    </section>

    <details class="section aa-advanced" ${(aa.runAnytime === false || aa.idleOnly === true || aa.maxPerDay < 50 || (Number(aa.concurrency) || 1) > 1) ? 'open' : ''}>
      <summary><span class="section-eyebrow">Advanced</span> Pacing &amp; limits</summary>
      <div class="queue-controls section-body" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px">
        ${qc('Run anytime (24/7)', `<label class="toggle"><input type="checkbox" id="aa-anytime" ${aa.runAnytime !== false ? 'checked' : ''} /><span class="knob"></span></label>`)}
        ${qc('Only when I\'m idle', `<label class="toggle"><input type="checkbox" id="aa-idleonly" ${aa.idleOnly === true ? 'checked' : ''} /><span class="knob"></span></label><div class="form-hint">Pauses the moment you touch the mouse/keyboard <em>or</em> any tab plays audio/video (YouTube, music, a call), and resumes automatically only when you're completely idle with nothing playing — ideal for applying while you're away. Uses your browser's idle + audible-tab detection; audio from apps outside the browser isn't detected.</div>`)}
        ${qc('Count me idle after (sec)', `<input class="input" id="aa-idlesecs" type="number" min="15" max="1800" step="5" value="${Math.max(15, Number(aa.idleThresholdSeconds) || 60)}" /><div class="form-hint">Seconds of no mouse/keyboard before you count as idle (minimum 15).</div>`)}
        ${qc('Max / day', `<input class="input" id="aa-day" type="number" min="1" max="500" value="${aa.maxPerDay}" />`)}
        ${qc('Max / hour', `<input class="input" id="aa-hour" type="number" min="1" max="100" value="${aa.maxPerHour}" />`)}
        ${qc('Gap min (min)', `<input class="input" id="aa-gmin" type="number" min="0" max="180" step="0.25" value="${aa.minGapMinutes}" />`)}
        ${qc('Gap max (min)', `<input class="input" id="aa-gmax" type="number" min="0" max="360" step="0.25" value="${aa.maxGapMinutes}" />`)}
        ${qc('Parallel applications', `<input class="input" id="aa-conc" type="number" min="1" max="5" value="${Math.max(1, Math.min(5, Number(aa.concurrency) || 1))}" /><div class="form-hint">1 (the default) applies one at a time, keeping the single apply window in the foreground so the new full-page Easy Apply (/apply/) page reliably LOADS — most reliable, lowest automation footprint. Raising it opens that many apply windows at once (tiled side-by-side so they aren't occluded), for throughput. The hourly cap still binds total throughput.</div>`)}
        ${qc('Max on the same site', `<input class="input" id="aa-persite" type="number" min="1" max="5" value="${Math.max(1, Math.min(5, Number(aa.perSiteConcurrency) || 2))}" /><div class="form-hint">Of those parallel windows, how many may run on the SAME site at once. ALL LinkedIn jobs count as one site, so this is effectively "how many LinkedIn applications run together". 2 is the ban-safe default. 3+ is more throughput but several simultaneous Easy-Apply sessions on ONE account looks more like a bot (higher flag risk). Capped at your Parallel-applications value.</div>`)}
        ${qc('Bring window to front while applying', `<label class="toggle"><input type="checkbox" id="aa-bringfront" ${aa.bringToFrontToHydrate ? 'checked' : ''} /><span class="knob"></span></label><div class="form-hint">For max reliability when a fullscreen app (e.g. a game) covers the apply window — Chrome throttles a fully-hidden window so the Easy-Apply button never loads. ON brings the apply window to the front while each application runs (it takes focus). Leave OFF for unobtrusive background applying.</div>`)}
        ${qc('Keep PC awake while running', `<label class="toggle"><input type="checkbox" id="aa-keepawake" ${aa.keepAwake !== false ? 'checked' : ''} /><span class="knob"></span></label><div class="form-hint">Session-scoped. JAT does not change your Windows power plan.</div>`)}
        ${qc('Keep display awake too', `<label class="toggle"><input type="checkbox" id="aa-keepdisplay" ${aa.keepDisplayAwake ? 'checked' : ''} /><span class="knob"></span></label><div class="form-hint">Stronger mode for overnight runs on sites that throttle hidden displays.</div>`)}
        <div id="aa-window-row">
          ${qc('Window start', `<input class="input" id="aa-ws" type="time" value="${esc(aa.windowStart || '')}" />`)}
          ${qc('Window end', `<input class="input" id="aa-we" type="time" value="${esc(aa.windowEnd || '')}" />`)}
        </div>
      </div>
      <div class="section-footer muted">Run anytime is on by default (24/7). Turn it off to restrict applying to a daily time window. LinkedIn/Indeed flag bots — if you push the volume up, expect more risk to your account. Auto mode submits real applications.</div>
    </details>

    <section class="section">
      <header class="section-header" style="align-items:center">
        <div><div class="section-eyebrow">Queue</div><h2 class="section-title">Tasks &amp; history</h2></div>
        <div class="seg" role="tablist">
          <button class="seg-btn ${qview === 'tasks' ? 'on' : ''}" data-qview="tasks">Queue</button>
          <button class="seg-btn ${qview === 'history' ? 'on' : ''}" data-qview="history">History</button>
        </div>
      </header>
      <div data-qpane="tasks" ${qview === 'tasks' ? '' : 'hidden'}>${groupsHtml}</div>
      <div data-qpane="history" ${qview === 'history' ? '' : 'hidden'}>
        <div class="toolbar">
          <select class="select" id="aa-hist-range" style="max-width:170px">
            <option value="1">Today</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="3650">All time</option>
          </select>
          <span class="aa-hist-roll" id="aa-hist-roll" data-keep></span>
        </div>
        <div id="aa-hist-body" data-keep><div class="muted" style="padding:18px">Open History to load…</div></div>
      </div>
    </section>
  </div>`);

  const kw = chipsInput(aa.keywords || [], 'software engineer, data analyst…');
  v.querySelector('#aa-keywords-slot').appendChild(kw.node);
  const locs = chipsInput(aa.locations || [], 'Toronto, ON · Canada…');
  v.querySelector('#aa-locations-slot').appendChild(locs.node);
  const exTitles = chipsInput(aa.excludeKeywords || [], 'game, manager, sales…');
  v.querySelector('#aa-exclude-slot').appendChild(exTitles.node);
  const exCompanies = chipsInput(aa.excludeCompanies || [], 'Acme, staffing…');
  v.querySelector('#aa-exclude-companies-slot').appendChild(exCompanies.node);
  const exLocations = chipsInput(aa.excludeLocations || [], 'onsite only, New York…');
  v.querySelector('#aa-exclude-locations-slot').appendChild(exLocations.node);
  // The run-anytime toggle shows/hides #aa-window-row purely via CSS :has() — no JS
  // here, so a live morph refresh can never fight the user's toggle state.

  v.querySelector('[data-save]').addEventListener('click', async () => {
    try {
      const boardsSel = [];
      if (v.querySelector('#aa-li').checked) boardsSel.push('linkedin');
      if (v.querySelector('#aa-in').checked) boardsSel.push('indeed');
      if (v.querySelector('#aa-gd').checked) boardsSel.push('glassdoor');
      if (v.querySelector('#aa-google').checked) boardsSel.push('google');
      if (v.querySelector('#aa-zip').checked) boardsSel.push('zip_recruiter');
      const conc = Math.max(1, Math.min(8, Number(v.querySelector('#aa-conc').value) || 1));
      // Parallel = more apply tabs at once = much faster, but a bigger automation
      // footprint. Warn (once) only when the user is RAISING it past safe serial.
      if (conc > 1 && conc > (Math.max(1, Number(aa.concurrency) || 1))) {
        const ok = await confirmModal(
          `This opens ${conc} apply windows at the same time. Reliability tradeoff: only ONE window can be in the foreground at a time, and Chrome THROTTLES the other backgrounded/occluded apply windows while their full-page Easy Apply (/apply/) page is still LOADING — those windows may load slowly or NOT HYDRATE at all, so their applications can time out and retry. Serial ("1") keeps the single apply window foreground so its /apply/ page reliably loads — it is the most reliable and the default. The other trade-off is automation footprint: several apply windows in parallel looks more like a bot to LinkedIn/Indeed (higher risk of a temporary block or account flag). Continue?`,
          { title: `Run ${conc} applications in parallel?`, danger: true, okLabel: 'Yes, go parallel', cancelLabel: 'Keep it safe' });
        if (!ok) return;
      }
      await api('/settings', {
        method: 'PATCH',
        body: { autoApply: {
          // enabled is owned by the Start/Stop button, not Save — don't touch it here.
          mode: v.querySelector('#aa-mode').value,
          keywords: kw.get(),
          locations: locs.get(),
          workModes: ['remote', 'hybrid', 'onsite'].filter((m) => v.querySelector('#aa-wm-' + m)?.checked),
          country: (v.querySelector('#aa-country').value || '').trim() || 'Canada',
          boards: boardsSel,
          easyApplyOnly: v.querySelector('#aa-easy').checked,
          concurrency: conc,
          perSiteConcurrency: Math.max(1, Math.min(conc, Number(v.querySelector('#aa-persite')?.value) || 2)),
          bringToFrontToHydrate: v.querySelector('#aa-bringfront').checked,
          keepAwake: v.querySelector('#aa-keepawake').checked,
          keepDisplayAwake: v.querySelector('#aa-keepdisplay').checked,
          experienceYears: Math.max(0, Number(v.querySelector('#aa-exp').value) || 0),
          seniorityMax: v.querySelector('#aa-seniority').value,
          excludeKeywords: exTitles.get(),
          excludeCompanies: exCompanies.get(),
          excludeLocations: exLocations.get(),
          profileId: v.querySelector('#aa-profile').value,
          resumeDocId: v.querySelector('#aa-resume').value,
          maxPerDay: Number(v.querySelector('#aa-day').value) || 50,
          maxPerHour: Number(v.querySelector('#aa-hour').value) || 10,
          minGapMinutes: Math.max(0, Number(v.querySelector('#aa-gmin').value) || 0),
          maxGapMinutes: Math.max(0, Number(v.querySelector('#aa-gmax').value) || 0),
          runAnytime: v.querySelector('#aa-anytime').checked,
          windowStart: v.querySelector('#aa-ws')?.value || '',
          windowEnd: v.querySelector('#aa-we')?.value || '',
          idleOnly: v.querySelector('#aa-idleonly')?.checked || false,
          idleThresholdSeconds: Math.max(15, Math.min(1800, Number(v.querySelector('#aa-idlesecs')?.value) || 60)),
        } },
      });
      state.settings = null;
      toast(conc > 1 ? `Saved — running ${conc} in parallel` : 'Auto-apply settings saved');
    } catch (e) { errToast(e); }
  });

  // One Start↔Stop button (replaces the old ON/OFF toggle + "Stop everything").
  // Start: enable auto-apply. Stop: disable + skip queued/running + close the tabs.
  v.querySelector('[data-power]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    // Read the LIVE button state (its class) — never the render-time `aa` snapshot:
    // a soft morph can repaint Start↔Stop in place without rebinding this listener.
    const turnOn = !btn.classList.contains('danger');
    btn.disabled = true;
    try {
      if (turnOn) {
        await api('/settings', { method: 'PATCH', body: { autoApply: { enabled: true } } });
        toast('Auto-apply started — searching & applying, paced');
      } else {
        await api('/settings', { method: 'PATCH', body: { autoApply: { enabled: false } } });
        // STOPPING MUST NOT DESTROY THE QUEUE. This used to patch every queued/scheduled/running
        // task to 'skipped' — terminal and never re-dispatched — so pressing Stop threw away the
        // whole backlog. Live 2026-07-20: 67 jobs sat permanently skipped from previous stops,
        // none of them ever attempted. Turning the engine off is not a decision about any job.
        //
        // Queued and scheduled tasks are now left exactly as they are: autoApply.enabled is already
        // false above, so nothing will dispatch them, and they are waiting when you start again.
        // Only a RUNNING task needs standing down, and it goes back to 'queued' so it is retried
        // rather than lost. (A running task that has already submitted is protected by the storage
        // guard in db.js, which refuses to move a verified submission out of 'done'.)
        for (const t of tasks) {
          if (t.state === 'running') {
            await api('/queue/' + encodeURIComponent(t.id), { method: 'PATCH', body: { state: 'queued', lastError: null, transcriptAppend: { note: 'stopped from dashboard — returned to the queue, not skipped' } } });
          }
        }
        stopAutoApplyTabs();   // close the run's tabs + drop the group (state already saved)
        toast('Auto-apply stopped — tabs closed');
      }
      state.settings = null;
      navigate();
    } catch (err) { errToast(err); btn.disabled = false; }
  });

  // Queue ↔ History toggle + the submissions data view. The roll + body are
  // [data-keep] (loaded imperatively), so loadHistory targets the LIVE DOM and a
  // soft refresh re-runs it (live) rather than wiping it.
  const OUTCOME_LABEL = { submitted: 'Submitted', failed: 'Failed', needs_you: 'Needs you', skipped: 'Skipped', pending: 'Queued', running: 'Running' };
  const OUTCOME_COLOR = { submitted: '#16a34a', failed: '#dc2626', needs_you: '#d97706', skipped: '#9ca3af', pending: '#3b82f6', running: '#8b5cf6' };
  // The breakdown chart: total + a stacked outcome bar, then by-board, by-route
  // (easy/in-page vs external), and the top skip/fail reasons. Self-contained
  // inline styles so it needs no CSS-file change (keeps the app/extension mirror simple).
  function aaBreakdownHtml(bd) {
    if (!bd || !bd.total) return '';
    const oc = bd.byOutcome || {};
    const ORDER = ['submitted', 'failed', 'needs_you', 'skipped', 'pending', 'running'];
    const present = ORDER.filter((k) => oc[k]);
    const bar = present.map((k) => `<span title="${esc(OUTCOME_LABEL[k])}: ${oc[k]}" style="display:block;flex:${oc[k]};background:${OUTCOME_COLOR[k]}"></span>`).join('');
    const legend = present.map((k) => `<span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;margin-right:12px"><i style="width:9px;height:9px;border-radius:2px;background:${OUTCOME_COLOR[k]};display:inline-block"></i>${oc[k]} ${esc(OUTCOME_LABEL[k])}</span>`).join('');
    const tot = (m) => (m ? Object.values(m).reduce((a, b) => a + b, 0) : 0);
    const sub = (m) => (m && m.submitted) || 0;
    const line = (label, m) => `<div style="display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:3px 0;border-top:1px solid var(--border,#2a2a2a)"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(label)}">${esc(label)}</span><span class="muted"><b style="color:${OUTCOME_COLOR.submitted}">${sub(m)}</b> ✓ · ${tot(m)}</span></div>`;
    const rows = (obj, labels) => {
      const e2 = Object.entries(obj || {}).sort((a, b) => tot(b[1]) - tot(a[1]));
      return e2.length ? e2.map(([name, m]) => line((labels && labels[name]) || name, m)).join('') : '<div class="muted" style="font-size:12px">—</div>';
    };
    const ROUTE_LABEL = { 'easy-apply': 'Easy / in-page', external: 'External (needs you)', unknown: 'Unknown' };
    const ACTION_LABEL = { retry: 'Will retry', user: 'Needs you', inspect: 'Inspect', skip: 'Skipped by rule', wait: 'Waiting', complete: 'Complete' };
    const actionLine = (label, n) => `<div style="display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:3px 0;border-top:1px solid var(--border,#2a2a2a)"><span>${esc(label)}</span><span class="muted">${esc(n)}</span></div>`;
    const actions = Object.entries(bd.byFailureAction || {}).length
      ? Object.entries(bd.byFailureAction || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => actionLine(ACTION_LABEL[k] || k, n)).join('')
      : '<div class="muted" style="font-size:12px">—</div>';
    const reasons = (bd.topReasons || []).length
      ? bd.topReasons.map((r2) => `<div style="display:flex;justify-content:space-between;gap:10px;font-size:12px;padding:3px 0;border-top:1px solid var(--border,#2a2a2a)"><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r2.reason)}">${esc(r2.reason)}</span><span class="muted">${r2.count}</span></div>`).join('')
      : '<div class="muted" style="font-size:12px">No skips or failures 🎉</div>';
    const h = (t) => `<div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted,#888);margin-bottom:2px">${t}</div>`;
    return `<div class="card" style="padding:14px;margin-bottom:14px">
      <div style="font-size:13px;margin-bottom:8px"><b style="font-size:18px">${bd.total}</b> application${bd.total === 1 ? '' : 's'} <span class="muted">in the last ${bd.days} day${bd.days === 1 ? '' : 's'}</span></div>
      <div style="display:flex;height:14px;border-radius:7px;overflow:hidden;background:var(--border,#2a2a2a)">${bar}</div>
      <div style="margin-top:9px">${legend}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:16px;margin-top:14px">
        <div>${h('By board')}${rows(bd.byBoard)}</div>
        <div>${h('By route')}${rows(bd.byRoute, ROUTE_LABEL)}</div>
        <div>${h('Failure policy')}${actions}</div>
        <div>${h('Why skipped / failed')}${reasons}</div>
      </div>
    </div>`;
  }
  async function loadHistory() {
    const body = document.getElementById('aa-hist-body');
    if (!body) return;
    const days = Number(document.getElementById('aa-hist-range')?.value) || 7;
    try {
      const [r, bd] = await Promise.all([
        api('/auto-apply/history?days=' + days),
        api('/auto-apply/breakdown?days=' + days).catch(() => null),
      ]);
      const rl = r.rollup || {};
      const roll = document.getElementById('aa-hist-roll');
      if (roll) roll.innerHTML = ['submitted', 'failed', 'needs_you', 'skipped'].map((k) =>
        `<span class="roll-chip out-${k}">${rl[k] || 0} ${esc(OUTCOME_LABEL[k])}</span>`).join('');
      const items = r.items || [];
      const b2 = document.getElementById('aa-hist-body'); if (!b2) return;
      b2.innerHTML = aaBreakdownHtml(bd) + (items.length ? `<div class="hist-list">${items.map((it) => `
        <div class="hist-row" data-k="${esc(it.taskId)}">
          <span class="out-chip out-${esc(it.outcome)}">${esc(OUTCOME_LABEL[it.outcome] || it.outcome)}</span>
          <div class="hist-main">
            <div class="hist-title">${esc(it.job?.title || '?')} <span class="muted">· ${esc(it.job?.company || '')}</span></div>
            ${it.reason ? `<div class="hist-reason">${esc(it.reason)}</div>` : ''}
          </div>
          <div class="hist-meta">${it.job?.source ? `<span class="src-tag">${esc(it.job.source)}</span>` : ''}<span class="muted">${esc(fmtRel(it.updatedAt))}</span></div>
        </div>`).join('')}</div>`
        : emptyHtml('No data', 'No auto-apply activity in this range', 'Press Start and let it run — every outcome shows up here.'));
    } catch (e) {
      const b2 = document.getElementById('aa-hist-body'); if (b2) b2.innerHTML = `<div class="task-err" style="padding:18px">${esc(String(e?.message || e))}</div>`;
    }
  }
  // ---- LIVE "Running now" panel: in-flight workers + session tally + effective rate ----
  const AA_STATUS = {
    running: ['#16a34a', 'Applying'],
    pacing: ['#d97706', 'Pacing — waiting for the next slot'],
    'queue-empty': ['#3b82f6', 'Queue empty — searching for more jobs'],
    'hourly-cap': ['#d97706', 'Hourly limit reached — resumes next hour'],
    off: ['#9ca3af', 'Stopped'],
  };
  function liveHtml(d) {
    const [col, label] = AA_STATUS[d.status] || ['#9ca3af', d.status || ''];
    const p = d.pacing || {}, s = d.session || {};
    const slow = p.effectivePerHour && p.effectivePerHour <= 12;
    // Per-worker live card: the runner's title/company, route, attempt, elapsed timer,
    // and a streaming trail of the LAST several transcript lines — i.e. exactly what it's
    // seeing / filling / answering right now (last line = current action), plus any
    // question it's waiting on.
    const lvClass = (l) => l === 'ok' ? 'lv-ok' : l === 'warn' ? 'lv-warn' : (l === 'err' || l === 'error') ? 'lv-err' : '';
    const workerCard = (w) => {
      const elapsed = fmtElapsed((Date.now() - Date.parse(w.startedAt || '')) || 0);
      const route = w.route ? `<span class="aa-route-chip ${esc(w.route)}">${esc(w.route)}</span>` : '';
      const trail = (w.trail && w.trail.length)
        ? w.trail.map((e, i) => {
            const cur = i === w.trail.length - 1 ? 'cur' : '';
            const seen = e.kind === 'seen' ? ' lv-seen' : '';
            return `<div class="trail-line ${lvClass(e.level)}${seen} ${cur}"><span class="t-dot">${cur ? '▸' : '·'}</span><span>${esc(e.text || '')}</span></div>`;
          }).join('')
        : `<div class="trail-line"><span class="t-dot">·</span><span class="muted">opening the application…</span></div>`;
      const seen = (w.seen && w.seen.length) ? w.seen[w.seen.length - 1] : null;
      const seenHtml = seen ? `<div class="aa-seen">
        <div class="aa-seen-label">Robot sees</div>
        <div class="aa-seen-text">${esc(seen.text || '')}</div>
        ${(seen.fields || []).length ? `<div class="aa-seen-row"><span>Fields</span>${seen.fields.map((x) => `<b>${esc(x)}</b>`).join('')}</div>` : ''}
        ${(seen.buttons || []).length ? `<div class="aa-seen-row"><span>Buttons</span>${seen.buttons.map((x) => `<b>${esc(x)}</b>`).join('')}</div>` : ''}
      </div>` : '';
      const q = (w.pendingQuestions && w.pendingQuestions.length)
        ? `<div class="aa-worker-q">⏳ waiting on — ${w.pendingQuestions.map((x) => esc(x.question || '')).slice(0, 3).join(' · ')}</div>` : '';
      const policy = w.failureLabel ? `<span title="${esc(w.failureClass || '')}">${esc(w.failureLabel)}</span>` : '';
      return `<div class="aa-worker">
        <div class="aa-worker-head">
          <div><div class="aa-worker-title">${esc(w.title || 'job')}</div><div class="aa-worker-co">${esc(w.company || '')}</div></div>
          <div class="aa-worker-meta">${route}<span>${esc(w.source || '')}</span>${policy}${w.siteKey ? `<span>${esc(w.siteKey.replace(/^(host|ats|source):/, ''))}</span>` : ''}${(w.attempts || 0) > 1 ? `<span>try ${w.attempts}</span>` : ''}<span class="aa-worker-elapsed">${elapsed}</span></div>
        </div>
        <div class="aa-worker-trail">${trail}</div>
        ${seenHtml}
        ${q}
      </div>`;
    };
    const siteSpread = (d.activeSites || []).length
      ? `<div class="muted" style="font-size:12px;margin-bottom:10px">Active sites: ${(d.activeSites || []).map((x) => `<b>${esc(String(x.siteKey || '').replace(/^(host|ats|source):/, ''))}</b>`).join(' · ')}</div>`
      : '';
    const workers = (d.running || []).length
      ? `<div class="aa-workers">${d.running.map(workerCard).join('')}</div>`
      : `<div class="aa-empty-live">${d.enabled ? (d.queuedDepth ? 'Next application starting…' : 'No applications in flight — topping up the queue from discovery + retries.') : 'Auto-apply is stopped. Press Start to begin.'}</div>`;
    const hp = d.health || {};
    const dh = hp.discovery || {};
    const healthLine = `<div class="muted" style="font-size:12px;margin-bottom:10px">Watchdog: ${hp.staleTasks || hp.invalidWaits ? `<b style="color:var(--danger)">${esc((hp.staleTasks || 0) + (hp.invalidWaits || 0))} issue(s) detected</b>` : '<b>healthy</b>'} · discovery ${dh.lastSuccess ? `last healthy ${esc(fmtRel(dh.lastSuccess))}` : 'awaiting first healthy batch'}${dh.pendingFallbacks ? ` · ${esc(dh.pendingFallbacks)} fallback pending` : ''}</div>`;
    const stat = (n, lbl, cls) => `<div class="mini"><div class="mini-label">${lbl}</div><div class="mini-value ${cls || ''}">${n}</div></div>`;
    // R3 — HONEST run-scoped breakdown. The headline is the RAW verified rate (verified
    // submits ÷ everything dispatched this run); the supported rate (over jobs we could
    // actually drive — excludes site/bot gates + out-of-scope skips) sits beside it as
    // context. awaiting_review is shown as the honest "maybe" and is NEVER counted as
    // verified. Site/bot gates are broken out so they don't read as our failures.
    const honest = (() => {
      const rs = d.runSummary; if (!rs || !rs.counts) return '';
      const c = rs.counts;
      const pct = (x) => `${Math.round((x || 0) * 100)}%`;
      const row = (n, lbl, cls, title) => `<div class="aa-honest-row${cls ? ' ' + cls : ''}"${title ? ` title="${esc(title)}"` : ''}><span class="aa-honest-n">${n || 0}</span><span class="aa-honest-l">${lbl}</span></div>`;
      return `<div class="aa-honest" style="margin:4px 0 14px;padding:12px 14px;border:1px solid var(--border);border-radius:10px">
        <div style="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:10px">
          <div><div class="section-eyebrow">Honest rate (this run)</div><div style="font-size:24px;font-weight:700">${pct(rs.rawRate)} <span class="muted" style="font-size:12px;font-weight:500">raw verified</span></div></div>
          <div class="muted" style="font-size:13px">${pct(rs.supportedRate)} <span style="font-size:11px">supported (of ${rs.drivable || 0} drivable)</span></div>
          <div class="muted" style="font-size:11px;margin-left:auto">${c.dispatched || 0} dispatched · raw = verified ÷ dispatched</div>
        </div>
        <div class="aa-honest-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:7px">
          ${row(c.verified_done, 'Verified submits', 'ok', 'R1-trustworthy submits only')}
          ${row(c.awaiting_review, 'Submitted, needs confirm', 'warn', 'Submit reported but not verified — needs human confirmation')}
          ${row((c.site_gate || 0) + (c.bot_challenge || 0), 'Blocked by site (Cloudflare/CAPTCHA)', '', 'Site/bot gate — NOT our failure')}
          ${row(c.flow_failed, 'Flow failed', 'bad', 'Our flow genuinely failed (no-advance, missing form, executor error)')}
          ${row(c.skipped, 'Skipped (out of scope)', '', 'Filters, dupes, non-applicable / external-site')}
          ${c.needs_you ? row(c.needs_you, 'Needs your answer', 'warn', 'A real unanswered question is blocking it') : ''}
        </div>
        ${c.awaiting_review ? `<div class="muted" style="font-size:11px;margin-top:9px">Note: “Submitted, needs confirm” items are NOT counted as verified — they need human confirmation.</div>` : ''}
      </div>`;
    })();
    return `<section class="section" style="margin-bottom:14px">
      <header class="section-header" style="align-items:center">
        <div><div class="section-eyebrow">Live</div><h2 class="section-title">Running now</h2></div>
        <span style="display:inline-flex;align-items:center;gap:7px;font-size:12px"><span style="width:9px;height:9px;border-radius:50%;background:${col};box-shadow:0 0 0 3px ${col}22"></span>${esc(label)} · <b>${d.active || 0}/${d.concurrency || 1}</b> ${d.active === 1 ? 'worker' : 'workers'}</span>
      </header>
      <div class="section-body">
        <div class="aa-dash-grid" style="margin-bottom:14px">
          ${stat(s.submitted || 0, 'submitted', 'gold')}
          ${stat(s.readyForReview || 0, 'to review', '')}
          ${stat(s.needsYou || 0, 'needs you', s.needsYou ? 'warn' : '')}
          ${stat(s.skipped || 0, 'skipped', '')}
          ${stat(s.failed || 0, 'failed', '')}
          ${stat(d.queuedDepth || 0, 'in queue', '')}
        </div>
        <div class="muted" style="font-size:12px;margin-bottom:12px">≈ <b style="color:${slow ? 'var(--danger)' : 'inherit'}">${p.effectivePerHour || 0}</b> applications/hour at current settings${p.bindingCap ? ` (capped by ${p.bindingCap === 'hourly-cap' ? 'your hourly limit' : 'the gap between applications'})` : ''}${slow ? ` — your saved pacing predates the speed update. <button class="btn small" data-aa-maxspeed style="padding:2px 9px">⚡ Max speed</button>` : ''}</div>
        ${honest}
        ${siteSpread}
        ${healthLine}
        ${workers}
      </div>
    </section>`;
  }
  async function aaMaxSpeed() {
    try {
      await api('/settings', { method: 'PATCH', body: { autoApply: {
        maxPerHour: 60, maxPerDay: 200, minGapMinutes: 0.25, maxGapMinutes: 0.6, aiAnswerConfidenceMin: 0.7,
      } } });
      state.settings = null;
      toast('⚡ Max speed on — faster pacing + more autonomous answers');
      loadLive();
    } catch (e) { errToast(e); }
  }
  async function loadLive() {
    const host = document.getElementById('aa-live');
    if (!host) return;
    try {
      const d = await api('/auto-apply/live');
      if (!d || d.ok === false) { host.innerHTML = ''; return; }
      host.innerHTML = liveHtml(d);
      host.querySelector('[data-aa-maxspeed]')?.addEventListener('click', aaMaxSpeed);
    } catch { /* keep the last good render on a transient error */ }
  }
  aaLiveLoad = loadLive;
  loadLive();

  aaHistoryLoad = loadHistory;
  v.querySelector('#aa-hist-range')?.addEventListener('change', loadHistory);
  v.querySelectorAll('[data-qview]').forEach((b) => b.addEventListener('click', () => {
    const view = b.dataset.qview;
    try { localStorage.setItem('jat11.queue.view', view); } catch {}
    v.querySelectorAll('[data-qview]').forEach((x) => x.classList.toggle('on', x === b));
    const tp = v.querySelector('[data-qpane="tasks"]'); if (tp) tp.hidden = view !== 'tasks';
    const hp = v.querySelector('[data-qpane="history"]'); if (hp) hp.hidden = view !== 'history';
    if (view === 'history') loadHistory();
  }));
  if (qview === 'history') loadHistory();

  // Manual Search now always runs through the app-owned primary provider.
  v.querySelector('[data-run-disco]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Searching…';
    try {
      const r = await api('/auto-apply/discover-now', { method: 'POST', body: {} });
      const found = (r.results || []).reduce((n, x) => n + (x.found || 0), 0);
      const queued = (r.results || []).reduce((n, x) => n + (x.accepted || 0), 0);
      toast(r.ok === false ? `Search: ${r.reason || r.error || 'failed'}` : `Search complete: found ${found}, queued ${queued}`, queued ? 'info' : 'danger', { ttl: 9000 });
      navigate();
    } catch (err) { errToast(err); }
    btn.disabled = false; btn.textContent = '🔍 Search now';
  });

  // TEST: apply the next queued job right now (skips pacing). Removed later.
  v.querySelector('[data-test-apply]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Applying…';
    try {
      const r = await new Promise((res) => chrome.runtime.sendMessage({ type: 'run-autoapply-now' }, (x) => { void chrome.runtime.lastError; res(x); }));
      if (!r?.dispatched) toast('Nothing to apply: ' + (r?.reason || 'no queued jobs') + (r?.reason === 'disabled' ? ' (turn auto-apply ON first)' : ''), 'danger', { ttl: 8000 });
      else toast(`Applied "${r.title || 'job'}" → ${QUEUE_STATE_LABEL[r.state] || r.state}`, r.state === 'failed' ? 'danger' : 'info', { ttl: 8000 });
      navigate();
    } catch (err) { errToast(err); }
    btn.disabled = false; btn.textContent = '⚡ Apply next now';
  });

  // Arm Control Studio for the NEXT application FROM THE DASHBOARD. The Electron window can't send
  // chrome.runtime messages, so we arm a one-shot server flag (consumed by queueNext) that
  // makes the next auto-apply dispatch run supervised, on-screen (Step/Run + Fix-this).
  v.querySelector('[data-supervise-next]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    try {
      await api('/auto-apply/supervise-next', { method: 'POST' });
      btn.textContent = '✓ Armed — next application is supervised';
      toast('The next application will open in supervised mode — watch & correct it on-screen.', 'info', { ttl: 9000 });
    } catch (err) { errToast(err); btn.disabled = false; }
  });

  v.querySelector('[data-intake-save]')?.addEventListener('click', async (e) => {
    const answers = [...v.querySelectorAll('.aa-intake-a')]
      .map((el2) => ({ question: el2.dataset.q, value: (el2.value || '').trim(), fieldType: el2.dataset.ft }))
      .filter((a) => a.value);
    if (!answers.length) { toast('Answer at least one question', 'danger'); return; }
    const btn = e.currentTarget; btn.disabled = true;
    try {
      const r = await api('/auto-apply/intake', { method: 'POST', body: { answers } });
      toast(`Saved ${r.saved} answer(s) · ${r.requeued} job(s) re-queued`);
      navigate();
    } catch (err) { errToast(err); btn.disabled = false; }
  });

  const wireCard = (card) => {
    const taskId = card.dataset.task;
    const t = tasks.find((x) => x.id === taskId);
    card.addEventListener('contextmenu', (e) => contextMenu(e, [
      t && ['failed', 'skipped', 'awaiting_input'].includes(t.state) && { label: 'Retry', run: async () => { await api('/queue/' + encodeURIComponent(taskId), { method: 'PATCH', body: { state: 'queued', lastError: null } }); navigate(); } },
      t && ['queued', 'scheduled', 'running'].includes(t.state) && { label: 'Cancel', run: async () => { await api('/queue/' + encodeURIComponent(taskId), { method: 'PATCH', body: { state: 'skipped' } }); navigate(); } },
      (t?.hasTranscript || t?.transcript?.length) && { label: 'Show transcript', run: () => { const tr = card.querySelector('.transcript'); if (tr.hidden) fillTranscript(card, t); tr.hidden = !tr.hidden; } },
      t?.job?.jobUrl && { label: 'Open job posting', run: () => window.open(t.job.jobUrl, '_blank', 'noopener') },
      { sep: true },
      { label: 'Remove', danger: true, run: async () => { await api('/queue/' + encodeURIComponent(taskId), { method: 'DELETE' }); navigate(); } },
    ]));
    card.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      try {
        if (act === 'transcript') {
          const t2 = card.querySelector('.transcript');
          if (t2.hidden) fillTranscript(card, t);   // lazy: build transcript DOM only when first opened
          t2.hidden = !t2.hidden;
          return;
        }
        if (act === 'retry') await api('/queue/' + encodeURIComponent(taskId), { method: 'PATCH', body: { state: 'queued', lastError: null } });
        if (act === 'cancel') await api('/queue/' + encodeURIComponent(taskId), { method: 'PATCH', body: { state: 'skipped' } });
        if (act === 'delete') await api('/queue/' + encodeURIComponent(taskId), { method: 'DELETE' });
        navigate();
      } catch (e) { errToast(e); }
    }));
  };
  v.querySelectorAll('.task-card').forEach(wireCard);

  // "Show more": append the NEXT batch for that group and wire the new cards (they miss
  // the initial pass). Keeps every task reachable while the default render stays small.
  const shownPerState = new Map([...groups.entries()].map(([s, list]) => [s, Math.min(list.length, renderCap(s))]));
  v.querySelectorAll('[data-more-state]').forEach((btn) => btn.addEventListener('click', () => {
    const s = btn.dataset.moreState;
    const list = groups.get(s) || [];
    const cap = renderCap(s);
    const from = shownPerState.get(s) || 0;
    const next = list.slice(from, from + cap);
    if (!next.length) return;
    const wrap = btn.closest('.queue-more');
    const holder = document.createElement('div');
    holder.innerHTML = next.map(taskCard).join('');
    const added = [...holder.children];
    for (const c of added) wrap.parentNode.insertBefore(c, wrap);
    added.forEach(wireCard);
    const nowShown = from + next.length;
    shownPerState.set(s, nowShown);
    const hidden = list.length - nowShown;
    if (hidden <= 0) { wrap.remove(); return; }
    btn.textContent = `Show ${Math.min(hidden, cap)} more`;
    const lbl = wrap.querySelector('.muted');
    if (lbl) lbl.textContent = `${hidden} older hidden`;
  }));

  return v;
});

// ============================================================
// VIEW: Profile (#/profile)
// ============================================================
const PROFILE_FIELDS = [
  ['firstName', 'First name'], ['lastName', 'Last name'], ['fullName', 'Full name'],
  ['preferredName', 'Preferred name'], ['pronouns', 'Pronouns'],
  ['email', 'Email'], ['phone', 'Phone'],
  ['address1', 'Address'], ['address2', 'Address 2'], ['city', 'City'],
  ['state', 'Province / State'], ['postalCode', 'Postal code'], ['country', 'Country'],
  ['linkedinUrl', 'LinkedIn URL'], ['githubUrl', 'GitHub URL'], ['portfolioUrl', 'Portfolio URL'],
  ['workAuthorization', 'Work authorization'], ['sponsorshipRequired', 'Needs sponsorship'],
  ['citizenship', 'Citizenship'], ['securityClearance', 'Security clearance'],
  ['salaryExpectation', 'Salary expectation'], ['yearsExperience', 'Years of experience'],
  ['noticePeriod', 'Notice period / start date'],
  ['highestDegree', 'Highest degree'], ['university', 'University'],
  ['major', 'Field of study'], ['graduationYear', 'Graduation year'],
  ['headline', 'Headline'],
];
const PF_LABEL = Object.fromEntries(PROFILE_FIELDS);

// Editable multi-field rows (work history, education history).
// fields: [{ key, ph, wide?, ta? }]. Returns { node, get(), set(arr) }.
function recordRows(initial, fields, addLabel, onChange) {
  const root = el('<div class="rec-rows"></div>');
  const list = el('<div class="rec-list"></div>');
  const addBtn = el(`<button class="btn small" type="button">+ ${esc(addLabel)}</button>`);
  root.appendChild(list); root.appendChild(addBtn);
  const fire = () => { try { onChange && onChange(); } catch {} };
  function addRow(vals = {}) {
    const row = el('<div class="rec-row"></div>');
    for (const f of fields) {
      const node = el(f.ta
        ? `<textarea class="input rec-f rec-ta${f.wide ? ' rec-wide' : ''}" data-f="${esc(f.key)}" placeholder="${esc(f.ph)}" rows="2"></textarea>`
        : `<input class="input rec-f${f.wide ? ' rec-wide' : ''}" data-f="${esc(f.key)}" placeholder="${esc(f.ph)}" />`);
      node.value = vals[f.key] || '';
      row.appendChild(node);
    }
    const rm = el('<button class="btn small rec-rm" type="button" title="Remove">✕</button>');
    rm.addEventListener('click', () => { row.remove(); fire(); });
    row.appendChild(rm);
    list.appendChild(row);
    return row;
  }
  (initial || []).forEach((vv) => addRow(vv));
  addBtn.addEventListener('click', () => { const r = addRow(); r.querySelector('input,textarea')?.focus(); fire(); });
  root.addEventListener('input', fire);
  return {
    node: root,
    get() {
      return [...list.querySelectorAll('.rec-row')].map((row) => {
        const o = {};
        for (const f of row.querySelectorAll('.rec-f')) { const val = String(f.value || '').trim(); if (val) o[f.dataset.f] = val; }
        return o;
      }).filter((o) => Object.keys(o).length);
    },
    set(arr) { list.replaceChildren(); (arr || []).forEach((vv) => addRow(vv)); fire(); },
  };
}

// First 4-digit year in a string; "Present"/"current" → this year.
function expYear(s, fallback) {
  const str = String(s || '');
  if (/present|current|now|ongoing/i.test(str)) return new Date().getFullYear();
  const m = str.match(/(?:19|20)\d{2}/);
  return m ? Number(m[0]) : fallback;
}

// SVG timeline of work + education spans across years (the "experience chart").
function experienceChart(work, education) {
  const nowY = new Date().getFullYear();
  const rows = [];
  for (const w of (work || [])) {
    if (!w.title && !w.company) continue;
    const s = expYear(w.startDate, null); if (s == null) continue;
    rows.push({ kind: 'work', label: w.title || w.company, sub: w.company || '', s, e: Math.max(expYear(w.endDate, nowY), s) });
  }
  for (const ed of (education || [])) {
    if (!ed.degree && !ed.school) continue;
    const s = expYear(ed.startYear, null); if (s == null) continue;
    rows.push({ kind: 'edu', label: ed.degree || ed.school, sub: ed.school || '', s, e: Math.max(expYear(ed.endYear, nowY), s) });
  }
  if (!rows.length) return el('<div class="muted" style="font-size:12px;padding:6px 2px">Add work or education with years and your experience timeline appears here.</div>');
  const minY = Math.min(...rows.map((r) => r.s));
  const maxY = Math.max(nowY, ...rows.map((r) => r.e));
  const span = Math.max(1, maxY - minY);
  const W = 1000, labelW = 250, trackW = W - labelW - 12, rowH = 30, top = 26, H = top + rows.length * rowH + 10;
  const xFor = (y) => labelW + ((y - minY) / span) * trackW;
  const step = span <= 10 ? 1 : span <= 22 ? 2 : 5;
  let ticks = '';
  for (let y = minY; y <= maxY; y += step) {
    const x = xFor(y);
    ticks += `<line x1="${x}" y1="${top - 4}" x2="${x}" y2="${H - 6}" class="ec-grid"/><text x="${x}" y="${top - 10}" class="ec-yr" text-anchor="middle">${y}</text>`;
  }
  let bars = '';
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const x1 = xFor(r.s), x2 = Math.max(xFor(r.e), x1 + 6);
    const sub = r.sub ? ` <tspan class="ec-sub">· ${esc(String(r.sub).slice(0, 28))}</tspan>` : '';
    bars += `<text x="0" y="${y + rowH / 2 + 4}" class="ec-lab">${esc(String(r.label).slice(0, 30))}${sub}</text>`;
    bars += `<rect x="${x1}" y="${y + 6}" width="${x2 - x1}" height="${rowH - 14}" rx="4" class="ec-bar ec-${r.kind}"><title>${esc(r.label)} (${r.s}–${r.e >= nowY ? 'Present' : r.e})</title></rect>`;
  });
  return el(`<svg viewBox="0 0 ${W} ${H}" class="exp-chart" preserveAspectRatio="xMinYMin meet">${ticks}${bars}</svg>`);
}
const FIELD_GROUPS = [
  { title: 'Identity', keys: ['firstName', 'lastName', 'fullName', 'preferredName', 'pronouns'] },
  { title: 'Contact & location', keys: ['email', 'phone', 'address1', 'address2', 'city', 'state', 'postalCode', 'country'] },
  { title: 'Links', keys: ['linkedinUrl', 'githubUrl', 'portfolioUrl'] },
  { title: 'Work eligibility', keys: ['workAuthorization', 'sponsorshipRequired', 'citizenship', 'securityClearance'] },
  { title: 'Compensation & experience', keys: ['salaryExpectation', 'yearsExperience', 'noticePeriod'] },
  { title: 'Education', keys: ['highestDegree', 'university', 'major', 'graduationYear', 'headline'] },
];

// Map a learned-answer label → a structured profile key (client mirror of the
// server's LEARNED_TO_PROFILE) for the per-row "↑ Profile" promote.
const CLIENT_LEARNED_TO_PROFILE = [
  [/first.?name|given.?name|prenom|firstname/i, 'firstName'],
  [/last.?name|surname|family.?name|lastname/i, 'lastName'],
  [/full.?name|legal.?name|^name$/i, 'fullName'],
  [/preferred.?name|nickname/i, 'preferredName'],
  [/pronoun/i, 'pronouns'],
  [/email|courriel/i, 'email'],
  [/phone|mobile|telephone|cell/i, 'phone'],
  [/address.?2|apartment|unit|suite/i, 'address2'],
  [/address|street/i, 'address1'],
  [/\bcity\b|ville/i, 'city'],
  [/province|state\b|region/i, 'state'],
  [/postal|zip/i, 'postalCode'],
  [/country|pays/i, 'country'],
  [/linkedin/i, 'linkedinUrl'],
  [/github/i, 'githubUrl'],
  [/portfolio|website/i, 'portfolioUrl'],
  [/work.?authoriz|authorized.?work/i, 'workAuthorization'],
  [/sponsor|visa/i, 'sponsorshipRequired'],
  [/salary|compensation/i, 'salaryExpectation'],
  [/years?.*experience|experience.*years?/i, 'yearsExperience'],
  [/notice|start.?date|availab/i, 'noticePeriod'],
  [/degree|diploma/i, 'highestDegree'],
  [/university|college|school/i, 'university'],
  [/major|field.?of.?study/i, 'major'],
  [/graduation/i, 'graduationYear'],
  [/citizen/i, 'citizenship'],
];
function clientMapToProfileKey(label) {
  const hay = String(label || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');   // fold accents so "prénom" matches
  for (const [rx, key] of CLIENT_LEARNED_TO_PROFILE) if (rx.test(hay)) return key;
  return null;
}

// ============================================================
// VIEW: Taught Procedures (#/procedures) — Review / Audit dashboard [T5]
// ============================================================
// Every learned recipe (grouped ATS → company) with its ordered steps. Per step: the
// captured screenshot, label, selector (xpath on expand), field type, value, confidence,
// and source. Controls: edit value/label, delete, move up/down (step_index reorder), flip
// scope (ats↔company). A "Needs attention" filter surfaces low-confidence / recently-
// corrected / fail-prone steps. Every write hits PATCH/DELETE /recipe-step and refreshes.
const SOURCE_LABEL = { manual: 'manual', teach: 'teach', correction: 'correction', distilled: 'distilled' };
function confChipHtml(conf) {
  const c = Number(conf);
  if (!Number.isFinite(c)) return '<span class="proc-conf unknown" title="no confidence yet">—</span>';
  const pct = Math.round(c * 100);
  const cls = c < 0.5 ? 'low' : (c < 0.75 ? 'mid' : 'high');
  return `<span class="proc-conf ${cls}" title="replay confidence">${pct}%</span>`;
}
route('/procedures', async () => {
  const profilesR = await api('/profiles').catch(() => ({ items: [] }));
  const profiles = profilesR.items || [];
  // Reuse the same profile selection the Profile page uses, so they stay in sync.
  if (!state.profileSel || state.profileSel === 'new' || !profiles.find((p) => p.id === state.profileSel)) {
    state.profileSel = (profiles.find((p) => p.isDefault) || profiles[0])?.id || '';
  }
  const pid = state.profileSel;
  const onlyAttn = !!state.procOnlyAttention;

  const recipesR = await api('/recipes' + (pid ? '?profileId=' + encodeURIComponent(pid) : '')).catch(() => ({ recipes: [] }));
  const recipes = recipesR.recipes || [];
  const totalAttn = recipes.reduce((n, r) => n + (r.attentionCount || 0), 0);
  const totalSteps = recipes.reduce((n, r) => n + (r.steps ? r.steps.length : 0), 0);

  // Group ATS → company. The ATS recipe (company null) heads each ATS group; company
  // overlays follow. visibleRecipes respects the "Needs attention" filter.
  const visibleRecipes = onlyAttn
    ? recipes.map((r) => ({ ...r, steps: (r.steps || []).filter((s) => s.needsAttention) })).filter((r) => r.steps.length)
    : recipes;
  const byAts = new Map();
  for (const r of visibleRecipes) {
    if (!byAts.has(r.ats)) byAts.set(r.ats, []);
    byAts.get(r.ats).push(r);
  }

  const stepRowHtml = (recipe, step, i, count) => {
    const shot = step.screenshotId
      ? `<img class="proc-shot" loading="lazy" src="${esc(state.base)}/teach-shot/${encodeURIComponent(step.screenshotId)}?token=${encodeURIComponent(state.token || '')}" alt="step screenshot" />`
      : '<div class="proc-shot empty" aria-hidden="true">no shot</div>';
    const val = step.defaultValue != null && step.defaultValue !== '' ? esc(step.defaultValue) : '<span class="muted">—</span>';
    const xpathRow = step.xpath
      ? `<details class="proc-xpath"><summary>xpath</summary><code class="mono">${esc(step.xpath)}</code></details>` : '';
    return `<div class="proc-step ${step.needsAttention ? 'attn' : ''}" data-step="${esc(step.id)}" data-idx="${esc(step.stepIndex)}">
      ${shot}
      <div class="proc-body">
        <div class="proc-line1">
          <span class="proc-label">${esc(step.labelPattern || '(no label)')}</span>
          <span class="proc-type">${esc(step.fieldType || step.action || '·')}</span>
          ${confChipHtml(step.confidence)}
          <span class="proc-source" data-src="${esc(step.source || '')}">${esc(SOURCE_LABEL[step.source] || step.source || 'learned')}</span>
          ${step.needsAttention ? '<span class="proc-attn-flag" title="needs attention">⚠ attention</span>' : ''}
        </div>
        <div class="proc-line2">
          <span class="proc-val">value: ${val}</span>
        </div>
        ${step.selector ? `<code class="mono proc-sel" title="CSS selector">${esc(step.selector)}</code>` : '<span class="muted proc-sel">label-match only</span>'}
        ${xpathRow}
      </div>
      <div class="proc-controls">
        <button class="btn small" data-edit-value title="Edit value">Value</button>
        <button class="btn small" data-edit-label title="Edit label">Label</button>
        <button class="btn small" data-flip-scope title="Flip scope (ats↔company)">↔ ${esc(recipe.scope === 'company' ? 'ats' : 'company')}</button>
        <button class="btn small" data-move-up title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn small" data-move-down title="Move down" ${i === count - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn small danger" data-del title="Delete step">Delete</button>
      </div>
    </div>`;
  };

  const recipeCardHtml = (r) => {
    const scopeChip = r.scope === 'company'
      ? `<span class="sys-chip">company · ${esc(r.company || '?')}</span>`
      : '<span class="sys-chip">ATS · cross-company</span>';
    const steps = r.steps || [];
    const stepsHtml = steps.length
      ? steps.map((s, i) => stepRowHtml(r, s, i, steps.length)).join('')
      : '<div class="muted" style="padding:10px 4px;font-size:12px">No steps in this recipe.</div>';
    return `<section class="section proc-recipe" data-recipe="${esc(r.id)}" data-scope="${esc(r.scope)}">
      <header class="section-header">
        <div>
          <div class="section-eyebrow">${esc(r.ats)}</div>
          <h2 class="section-title">${esc(r.scope === 'company' ? (r.company || 'company') : 'ATS recipe')}</h2>
        </div>
        <div class="proc-recipe-meta">
          ${scopeChip}
          ${confChipHtml(r.confidence)}
          <span class="sys-chip" title="successes / failures">${esc(r.successCount || 0)}✓ ${esc(r.failCount || 0)}✕</span>
        </div>
      </header>
      <div class="proc-steps">${stepsHtml}</div>
    </section>`;
  };

  const groupsHtml = byAts.size
    ? [...byAts.entries()].map(([ats, rs]) => `
      <div class="proc-group">
        <div class="proc-group-head"><span class="proc-group-ats">${esc(ats)}</span><span class="muted">${rs.length} recipe${rs.length === 1 ? '' : 's'}</span></div>
        ${rs.map(recipeCardHtml).join('')}
      </div>`).join('')
    : emptyHtml('Nothing taught', onlyAttn ? 'No steps need attention' : 'No procedures learned yet',
        onlyAttn ? 'Everything the system has learned looks healthy.' : 'Apply to a few jobs (or use Control Studio) and the steps it learns appear here, editable.');

  const v = el(`<div>
    <header class="page-header">
      <div>
        <div class="page-eyebrow">Automate</div>
        <h1 class="page-title">Taught Procedures</h1>
        <div class="page-sub">Every step the system learned, by ATS then company — view, edit, reorder, or delete.</div>
      </div>
      <div class="page-actions">
        ${profiles.length > 1 ? `<select class="select" id="proc-profile">${profiles.map((p) => `<option value="${esc(p.id)}" ${p.id === pid ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>` : ''}
        <button class="btn ${onlyAttn ? 'primary' : ''}" data-attn>${onlyAttn ? 'Showing attention' : 'Needs attention'}${totalAttn ? ` · ${totalAttn}` : ''}</button>
        <button class="btn" data-refresh>Refresh</button>
      </div>
    </header>

    <div class="proc-summary muted">${recipes.length} recipe${recipes.length === 1 ? '' : 's'} · ${totalSteps} step${totalSteps === 1 ? '' : 's'}${totalAttn ? ` · <span class="proc-attn-flag">${totalAttn} need${totalAttn === 1 ? 's' : ''} attention</span>` : ''}</div>

    <div class="proc-list">${groupsHtml}</div>
  </div>`);

  v.querySelector('[data-refresh]').addEventListener('click', navigate);
  v.querySelector('[data-attn]').addEventListener('click', () => { state.procOnlyAttention = !onlyAttn; navigate(); });
  v.querySelector('#proc-profile')?.addEventListener('change', (e) => { state.profileSel = e.target.value; navigate(); });

  const patchStep = async (stepId, body, okMsg) => {
    try { await api('/recipe-step/' + encodeURIComponent(stepId), { method: 'PATCH', body }); if (okMsg) toast(okMsg); navigate(); }
    catch (e) { errToast(e); }
  };

  v.querySelectorAll('.proc-step').forEach((row) => {
    const stepId = row.dataset.step;
    const recipeEl = row.closest('.proc-recipe');
    const scope = recipeEl?.dataset.scope;
    row.querySelector('[data-edit-value]')?.addEventListener('click', async () => {
      const cur = row.querySelector('.proc-val')?.textContent?.replace(/^value:\s*/, '').trim() || '';
      const val = await promptModal('Value for this step:', { title: 'Edit value', value: cur === '—' ? '' : cur });
      if (val === null) return;
      patchStep(stepId, { defaultValue: val }, 'Value updated');
    });
    row.querySelector('[data-edit-label]')?.addEventListener('click', async () => {
      const cur = row.querySelector('.proc-label')?.textContent?.trim() || '';
      const val = await promptModal('Label / question for this step:', { title: 'Edit label', value: cur });
      if (val === null || !val.trim()) return;
      patchStep(stepId, { labelPattern: val.trim() }, 'Label updated');
    });
    row.querySelector('[data-flip-scope]')?.addEventListener('click', () => {
      patchStep(stepId, { scope: scope === 'company' ? 'ats' : 'company' }, 'Scope flipped');
    });
    row.querySelector('[data-move-up]')?.addEventListener('click', () => {
      const prev = row.previousElementSibling;
      if (prev && prev.classList.contains('proc-step')) reorderSwap(row, prev);
    });
    row.querySelector('[data-move-down]')?.addEventListener('click', () => {
      const next = row.nextElementSibling;
      if (next && next.classList.contains('proc-step')) reorderSwap(row, next);
    });
    row.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!(await confirmModal('Delete this learned step?', { danger: true, okLabel: 'Delete' }))) return;
      try { await api('/recipe-step/' + encodeURIComponent(stepId), { method: 'DELETE' }); toast('Step deleted'); navigate(); }
      catch (e) { errToast(e); }
    });
  });

  // Reorder = swap the two adjacent steps' step_index values, then refresh.
  async function reorderSwap(a, b) {
    const ai = Number(a.dataset.idx), bi = Number(b.dataset.idx);
    try {
      await api('/recipe-step/' + encodeURIComponent(a.dataset.step), { method: 'PATCH', body: { stepIndex: bi } });
      await api('/recipe-step/' + encodeURIComponent(b.dataset.step), { method: 'PATCH', body: { stepIndex: ai } });
      navigate();
    } catch (e) { errToast(e); }
  }

  return v;
});

route('/profile', async () => {
  const [profilesR, settings] = await Promise.all([
    api('/profiles'),
    getSettings(),
  ]);
  const profiles = profilesR.items || [];
  const af = settings.autofill || {};

  if (!state.profileSel || !profiles.find((p) => p.id === state.profileSel)) {
    state.profileSel = profiles[0]?.id || 'new';
  }
  const cur = profiles.find((p) => p.id === state.profileSel) || { name: 'Main', isDefault: !profiles.length, sourceAssignments: [], data: {} };
  const d = cur.data || {};

  // Each profile has its OWN memory — load only this profile's learned answers.
  const harvested = cur.id
    ? ((await api('/profile-fields?profileId=' + encodeURIComponent(cur.id)).catch(() => ({ items: [] }))).items || [])
    : [];

  // Dynamic structured fields: grouped seed fields + any custom keys already
  // saved in this profile's data, rendered as a DENSE multi-column grid so many
  // fields are visible at once.
  const seedKeys = new Set(PROFILE_FIELDS.map(([k]) => k));
  const humanize = (k) => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  const extraKeys = Object.keys(d).filter((k) => !seedKeys.has(k) && k !== 'skills' && k !== 'summary' && !k.startsWith('_'));
  const fieldCard = (k, label, custom) => `
    <div class="pf-field ${custom ? 'custom' : ''}" data-fieldrow="${esc(k)}">
      <label class="pf-flabel" for="pf-${esc(k)}">${esc(label)}</label>
      <div class="pf-inwrap"><input class="input pf-input" id="pf-${esc(k)}" data-key="${esc(k)}" value="${esc(d[k] ?? '')}" />${custom ? '<button class="pf-rm" data-rmfield title="Remove field">✕</button>' : ''}</div>
    </div>`;
  const groupsHtml = FIELD_GROUPS.map((g) => `
    <div class="pf-group">
      <div class="pf-group-title">${esc(g.title)}</div>
      <div class="pf-grid">${g.keys.map((k) => fieldCard(k, PF_LABEL[k] || humanize(k), false)).join('')}</div>
    </div>`).join('');
  const customHtml = `
    <div class="pf-group">
      <div class="pf-group-title">Custom fields <button class="btn small" data-addfield>+ Add</button></div>
      <div class="pf-grid" id="pf-custom">${extraKeys.map((k) => fieldCard(k, humanize(k), true)).join('')}</div>
    </div>`;

  const langBadge = (loc) => loc === 'fr' ? '<span class="lang-badge fr">FR</span>' : '<span class="lang-badge">EN</span>';
  const harvestRows = harvested.length ? harvested.map((it) => `
    <tr data-pf="${esc(it.id)}" class="${it.locked ? 'pf-locked' : ''}">
      <td class="title-cell" title="${esc(it.label)}${it.source ? ' · from ' + esc(it.source) : ''}">${langBadge(it.locale)} ${esc(it.label.length > 60 ? it.label.slice(0, 60) + '…' : it.label)}</td>
      <td><input class="input" data-pf-answer value="${esc(it.value)}" style="width:100%" /></td>
      <td class="num">${esc(it.seenCount)}</td>
      <td class="nowrap">
        <button class="btn small" data-pf-promote data-pf-label="${esc(it.label)}" title="Copy this answer up into your structured profile fields">↑ Profile</button>
        <button class="btn small ${it.locked ? 'primary' : ''}" data-pf-lock title="${it.locked ? 'Locked — new applications won’t overwrite. Click to unlock.' : 'Lock so new applications don’t overwrite this value.'}">${it.locked ? '🔒' : '🔓'}</button>
        <button class="btn small" data-pf-del title="Forget">✕</button>
      </td>
    </tr>`).join('')
    : `<tr><td colspan="4">${emptyHtml('Empty memory', 'No learned answers yet', 'Apply to jobs (or “Build from past applications”) and JAT learns how you answer — EN + FR.')}</td></tr>`;

  const v = el(`<div>
    <header class="page-header">
      <div>
        <div class="page-eyebrow">Material</div>
        <h1 class="page-title">Profile</h1>
        <div class="page-sub">What autofill and auto-apply know about you — self-populating as you apply.</div>
      </div>
      <div class="page-actions">
        <button class="btn" data-import>Import from résumé</button>
        ${cur.id ? '<button class="btn" data-fill-from-memory title="Fill empty profile fields from this profile’s learned memory">Fill from memory</button>' : ''}
        ${cur.id ? '<button class="btn" data-del-profile>Delete</button>' : ''}
        <button class="btn primary" data-save>Save profile</button>
      </div>
    </header>

    <div class="autofill-strip ${af.enabled ? 'on' : ''}">
      <label class="toggle"><input type="checkbox" id="af-enabled" ${af.enabled ? 'checked' : ''} /><span class="knob"></span></label>
      <div class="as-text"><strong>Autofill new applications</strong> — ${af.enabled
        ? 'on. Empty fields fill automatically when you open an application; it never submits.'
        : 'off. Turn on to pre-fill matching fields on new applications (empty fields only, never submits).'}</div>
      <a href="#/settings" class="section-link">Options →</a>
    </div>

    <div class="profile-layout">
      <div class="profile-list">
        ${profiles.map((p) => `<button class="profile-item ${p.id === state.profileSel ? 'active' : ''}" data-prof="${esc(p.id)}">${esc(p.name)}${p.isDefault ? ' <span class="muted">· default</span>' : ''}</button>`).join('')}
        <button class="profile-item ${state.profileSel === 'new' ? 'active' : ''}" data-prof="new">+ New profile</button>
      </div>

      <div>
        <section class="section pf-main">
          <div class="pf-idrow">
            <div class="pf-field"><label class="pf-flabel" for="pf-name">Profile name</label>
              <input class="input" id="pf-name" value="${esc(cur.name || '')}" /></div>
            <label class="pf-default"><input type="checkbox" id="pf-default" ${cur.isDefault ? 'checked' : ''} /> <span>Default profile</span></label>
            <div class="pf-field pf-grow"><label class="pf-flabel">Use on sites <span class="muted">(hostname contains)</span></label>
              <div id="pf-sources-slot"></div></div>
          </div>
          ${groupsHtml}
          ${customHtml}
          <div class="pf-group">
            <div class="pf-group-title">Summary</div>
            <textarea class="input" id="pf-summary" rows="3" style="width:100%;resize:vertical">${esc(d.summary || '')}</textarea>
          </div>
          <div class="pf-group">
            <div class="pf-group-title">Skills</div>
            <div id="pf-skills-slot"></div>
          </div>
          <div class="pf-group">
            <div class="pf-group-title">Experience timeline</div>
            <div id="pf-chart-slot"></div>
          </div>
          <div class="pf-group">
            <div class="pf-group-title">Work history</div>
            <div id="pf-work-slot"></div>
          </div>
          <div class="pf-group">
            <div class="pf-group-title">Education history</div>
            <div id="pf-edu-slot"></div>
          </div>
        </section>

        <section class="section">
          <header class="section-header"><div><div class="section-eyebrow">Memory</div><h2 class="section-title">${esc(cur.name || 'This profile')} — learned answers</h2>
            <div class="form-hint">Learned from your applications (EN + FR), private to this profile. Edit a value to override + lock it; “↑ Profile” copies an answer up into your structured fields above.</div></div>
            <div class="nowrap">${cur.id ? '<button class="btn small" data-save-to-memory title="Push your structured profile fields into this memory so auto-apply knows them">Save profile → memory</button> <button class="btn small" data-backfill title="Harvest answers from every past application into this profile">Build from past applications</button> ' : ''}<span class="section-link muted">${harvested.length} stored</span></div></header>
          ${harvested.length ? `<div class="pf-mem-tools"><input class="input" id="pf-mem-search" placeholder="Search your learned answers…" autocomplete="off" spellcheck="false" /><span class="pf-mem-count muted" id="pf-mem-count"></span></div>` : ''}
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Question</th><th>Answer</th><th>Seen</th><th></th></tr></thead>
            <tbody>${harvestRows}</tbody>
          </table></div>
        </section>
      </div>
    </div>
  </div>`);

  const sources = chipsInput(cur.sourceAssignments || [], 'linkedin, indeed…');
  v.querySelector('#pf-sources-slot').appendChild(sources.node);
  const skills = chipsInput(d.skills || [], 'Add skill…');
  v.querySelector('#pf-skills-slot').appendChild(skills.node);

  // Memory search — live client-side filter over the learned-answers rows (essential at hundreds
  // of rows). Filtering keeps the search input focused, so the SSE no-refresh-while-editing guard
  // preserves the query while you type.
  const memSearch = v.querySelector('#pf-mem-search');
  const memCount = v.querySelector('#pf-mem-count');
  if (memSearch) {
    memSearch.addEventListener('input', () => {
      const q = memSearch.value.trim().toLowerCase();
      let shown = 0;
      v.querySelectorAll('tr[data-pf]').forEach((tr) => {
        const hay = ((tr.querySelector('.title-cell')?.textContent || '') + ' ' + (tr.querySelector('[data-pf-answer]')?.value || '')).toLowerCase();
        const match = !q || hay.includes(q);
        tr.style.display = match ? '' : 'none';
        if (match) shown++;
      });
      if (memCount) memCount.textContent = q ? `${shown} match${shown === 1 ? '' : 'es'}` : '';
    });
  }

  // Work + education history (editable rows) + the experience timeline chart.
  const redrawChart = () => { const slot = v.querySelector('#pf-chart-slot'); if (slot) slot.replaceChildren(experienceChart(work.get(), education.get())); };
  const work = recordRows(d.workHistory, [
    { key: 'title', ph: 'Title', wide: true }, { key: 'company', ph: 'Company' }, { key: 'location', ph: 'Location' },
    { key: 'startDate', ph: 'Start (e.g. 2024)' }, { key: 'endDate', ph: 'End / Present' },
    { key: 'description', ph: 'What you did (one per line)', ta: true },
  ], 'Add job', () => redrawChart());
  const education = recordRows(d.educationHistory, [
    { key: 'degree', ph: 'Degree', wide: true }, { key: 'school', ph: 'School' },
    { key: 'field', ph: 'Field of study' }, { key: 'startYear', ph: 'Start' }, { key: 'endYear', ph: 'End' }, { key: 'gpa', ph: 'GPA' },
  ], 'Add education', () => redrawChart());
  v.querySelector('#pf-work-slot').appendChild(work.node);
  v.querySelector('#pf-edu-slot').appendChild(education.node);
  redrawChart();

  // Autofill master toggle (persists to settings.autofill.enabled).
  v.querySelector('#af-enabled').addEventListener('change', async (e) => {
    const on = e.target.checked;
    try {
      await api('/settings', { method: 'PATCH', body: { autofill: { enabled: on } } });
      state.settings = null;
      v.querySelector('.autofill-strip').classList.toggle('on', on);
      toast(on ? 'Autofill on — new applications will be pre-filled' : 'Autofill off');
    } catch (err) { errToast(err); e.target.checked = !on; }
  });

  v.querySelectorAll('[data-prof]').forEach((b) => b.addEventListener('click', () => {
    state.profileSel = b.dataset.prof;
    navigate();
  }));

  // Add / remove custom structured fields.
  const wireRemove = (btn) => btn.addEventListener('click', () => btn.closest('[data-fieldrow]')?.remove());
  v.querySelectorAll('[data-rmfield]').forEach(wireRemove);
  v.querySelector('[data-addfield]').addEventListener('click', async () => {
    const name = await promptModal('Field name (e.g. “Years of AutoCAD”, “Preferred shift”):', { title: 'New field', okLabel: 'Add' });
    if (!name || !name.trim()) return;
    const key = (name.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60)) || ('field_' + Date.now());
    if (v.querySelector('[data-key="' + key + '"]')) { toast('That field already exists', 'danger'); return; }
    const card = el(fieldCard(key, name.trim(), true));
    wireRemove(card.querySelector('[data-rmfield]'));
    v.querySelector('#pf-custom').appendChild(card);
    card.querySelector('input').focus();
  });

  // Build THIS profile's memory from every past application's answers.
  v.querySelector('[data-backfill]')?.addEventListener('click', async (e) => {
    if (!cur.id) { toast('Save the profile first', 'warn'); return; }
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Building…';
    try {
      const r = await api('/profile-fields/backfill', { method: 'POST', body: { profileId: cur.id }, timeoutMs: 120000 });
      toast(r.fields ? `Learned ${r.fields} answer(s) from ${r.jobs} past application(s)` : 'No new answers found in past applications');
      navigate();
    } catch (err) { errToast(err); btn.disabled = false; btn.textContent = 'Build from past applications'; }
  });

  // Import from a résumé — pick from uploaded documents or upload a new one.
  const fillFromParse = (parsed) => {
    let filled = 0;
    for (const input of v.querySelectorAll('.pf-input')) {
      const k = input.dataset.key;
      if (!input.value.trim() && parsed[k]) { input.value = parsed[k]; filled++; }
    }
    const sum = v.querySelector('#pf-summary');
    if (sum && !sum.value.trim() && parsed.summary) { sum.value = parsed.summary; filled++; }
    if (Array.isArray(parsed.skills) && parsed.skills.length && !skills.get().length) { skills.set(parsed.skills); filled++; }
    // Work + education arrays → fill the row editors, but only when empty so we
    // never clobber what you've already entered.
    if (Array.isArray(parsed.workExperience) && parsed.workExperience.length && !work.get().length) {
      work.set(parsed.workExperience.map((w) => ({
        title: w.title || '', company: w.company || '', location: w.location || '',
        startDate: w.startDate || '', endDate: w.endDate || (w.current ? 'Present' : ''),
        description: w.description || '',
      })));
      filled += parsed.workExperience.length;
    }
    if (Array.isArray(parsed.educationHistory) && parsed.educationHistory.length && !education.get().length) {
      education.set(parsed.educationHistory.map((e2) => ({
        degree: e2.degree || '', school: e2.school || '', field: e2.field || '',
        startYear: e2.startYear || '', endYear: e2.endYear || '', gpa: e2.gpa || '',
      })));
      filled += parsed.educationHistory.length;
    }
    redrawChart();
    return filled;
  };
  const importFromDoc = async (documentId, name) => {
    const done = toast(`Reading ${name || 'résumé'}…`, 'info', { ttl: 0 });
    try {
      const r = await api('/ai/resume-parse', { method: 'POST', body: { documentId }, timeoutMs: 240000 });
      const filled = fillFromParse(r.result || {});
      done();
      toast(filled ? `Filled ${filled} empty field(s) from your résumé (${r.provider}). Review, then Save profile.` : 'Nothing new to fill — those fields are already set.');
    } catch (err) { done(); errToast(err, 'Import failed'); }
  };
  v.querySelector('[data-import]').addEventListener('click', async () => {
    let docs = [];
    try { docs = ((await api('/documents')).items || []).filter((dd) => dd.hasText); } catch {}
    const m = el(`<div class="modal">
      <div class="modal-head"><h3 class="modal-title">Import from a document</h3><button class="toast-x" data-close aria-label="Close">×</button></div>
      <div class="modal-body">
        <p class="muted" style="font-size:12px;margin:0 0 12px">Pick a résumé/CV to pull your details from, or upload a new one — it's also saved to Documents.</p>
        <div class="doc-pick-list">${docs.length ? docs.map((dd) => `
          <button class="doc-pick" data-pick-doc="${esc(dd.id)}" data-pick-name="${esc(dd.name)}">
            <span class="role-badge" data-role="${esc(dd.role)}">${esc(DOC_ROLE_LABEL[dd.role] || dd.role)}</span>
            <span class="dp-name">${esc(dd.label || dd.name)}</span>
          </button>`).join('') : '<div class="muted" style="padding:8px 2px">No documents with extractable text yet — upload one below.</div>'}</div>
      </div>
      <div class="modal-foot">
        <input type="file" id="rp-file" accept=".pdf,.docx,.doc,.txt,.md,.rtf" hidden />
        <button class="btn small primary" data-upload-new>Upload new résumé…</button>
      </div>
    </div>`);
    const close = openOverlay(m);
    m.querySelector('[data-close]').addEventListener('click', close);
    m.querySelectorAll('[data-pick-doc]').forEach((b) => b.addEventListener('click', () => { close(); importFromDoc(b.dataset.pickDoc, b.dataset.pickName); }));
    m.querySelector('[data-upload-new]').addEventListener('click', () => m.querySelector('#rp-file').click());
    m.querySelector('#rp-file').addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      if (file.size > 10 * 1024 * 1024) { toast('File too large (10 MB max)', 'danger'); return; }
      close();
      const done = toast(`Uploading ${file.name}…`, 'info', { ttl: 0 });
      try {
        const dataBase64 = await fileToB64(file);
        const up = await api('/documents', { method: 'POST', timeoutMs: 60000, body: { name: file.name, role: 'resume', mime: file.type, dataBase64, isDefault: false } });
        done();
        toast('Saved to Documents ✓');
        importFromDoc(up.document.id, file.name);
      } catch (err) { done(); errToast(err, 'Upload failed'); }
    });
  });

  const collect = () => {
    const data = {};
    for (const input of v.querySelectorAll('.pf-input')) {
      const val = input.value.trim();
      if (val) data[input.dataset.key] = val;
    }
    const summary = v.querySelector('#pf-summary').value.trim();
    if (summary) data.summary = summary;
    const sk = skills.get();
    if (sk.length) data.skills = sk;
    const wh = work.get(); if (wh.length) data.workHistory = wh;
    const eh = education.get(); if (eh.length) data.educationHistory = eh;
    return {
      id: cur.id || undefined,
      name: v.querySelector('#pf-name').value.trim() || 'Profile',
      isDefault: v.querySelector('#pf-default').checked,
      sourceAssignments: sources.get(),
      data,
    };
  };

  v.querySelector('[data-save]').addEventListener('click', async () => {
    try {
      const r = await api('/profiles', { method: 'POST', body: collect() });
      state.profileSel = r.profile?.id || state.profileSel;
      toast('Profile saved');
      navigate();
    } catch (e) { errToast(e); }
  });

  // Bridge (memory → profile): fill empty structured fields from this profile's memory.
  v.querySelector('[data-fill-from-memory]')?.addEventListener('click', async () => {
    if (!cur.id) { toast('Save the profile first', 'warn'); return; }
    try {
      const r = await api('/profile/from-memory?profileId=' + encodeURIComponent(cur.id));
      const filled = fillFromParse(r.data || {});
      toast(filled ? `Filled ${filled} empty field(s) from memory — review, then Save profile.` : 'Nothing new — those fields are already set.');
    } catch (e) { errToast(e); }
  });
  // Bridge (profile → memory): push the structured fields down into this profile's memory.
  v.querySelector('[data-save-to-memory]')?.addEventListener('click', async () => {
    if (!cur.id) { toast('Save the profile first', 'warn'); return; }
    try {
      const { data } = collect();
      const r = await api('/profile/to-memory', { method: 'POST', body: { profileId: cur.id, data } });
      toast(r.pushed ? `Saved ${r.pushed} field(s) into ${cur.name}’s memory` : 'Nothing to save — fill in some fields first.');
      navigate();
    } catch (e) { errToast(e); }
  });

  const delBtn = v.querySelector('[data-del-profile]');
  if (delBtn) delBtn.addEventListener('click', async () => {
    try {
      await api('/profiles/' + encodeURIComponent(cur.id), { method: 'DELETE' });
      state.profileSel = null;
      toast('Profile deleted');
      navigate();
    } catch (e) { errToast(e); }
  });

  // Harvested answers: edit (override + lock), lock toggle, forget.
  v.querySelectorAll('tr[data-pf]').forEach((tr) => {
    const id = tr.dataset.pf;
    const answerEl = tr.querySelector('[data-pf-answer]');
    const lockBtn = tr.querySelector('[data-pf-lock]');
    answerEl.addEventListener('change', async () => {
      try {
        await api('/profile-fields/' + encodeURIComponent(id), { method: 'PATCH', body: { value: answerEl.value, locked: true } });
        tr.classList.add('pf-locked');
        lockBtn.classList.add('primary'); lockBtn.textContent = '🔒';
        toast('Saved & locked — new applications won’t overwrite this');
      } catch (err) { errToast(err); }
    });
    lockBtn.addEventListener('click', async () => {
      const willLock = !tr.classList.contains('pf-locked');
      try {
        await api('/profile-fields/' + encodeURIComponent(id), { method: 'PATCH', body: { locked: willLock } });
        tr.classList.toggle('pf-locked', willLock);
        lockBtn.classList.toggle('primary', willLock);
        lockBtn.textContent = willLock ? '🔒' : '🔓';
      } catch (err) { errToast(err); }
    });
    tr.querySelector('[data-pf-del]').addEventListener('click', async () => {
      try { await api('/profile-fields/' + encodeURIComponent(id), { method: 'DELETE' }); tr.remove(); }
      catch (err) { errToast(err); }
    });
    // Promote a learned answer UP into the structured profile (memory → profile, one field).
    tr.querySelector('[data-pf-promote]')?.addEventListener('click', () => {
      const label = tr.querySelector('[data-pf-promote]').dataset.pfLabel || '';
      const value = answerEl.value.trim();
      if (!value) { toast('No answer to copy yet', 'warn'); return; }
      const key = clientMapToProfileKey(label);
      let input = key ? v.querySelector('.pf-input[data-key="' + key + '"]') : null;
      if (!input) {
        // No standard field maps → add it as a custom profile field.
        const ck = (label.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60)) || ('field_' + Date.now());
        if (!v.querySelector('[data-key="' + ck + '"]')) {
          const card = el(fieldCard(ck, label.slice(0, 40), true));
          wireRemove(card.querySelector('[data-rmfield]'));
          v.querySelector('#pf-custom').appendChild(card);
        }
        input = v.querySelector('.pf-input[data-key="' + ck + '"]');
      }
      if (input) {
        input.value = value;
        input.classList.add('pf-flash');
        input.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setTimeout(() => input.classList.remove('pf-flash'), 1200);
        toast(`Copied into your profile (${key ? (PF_LABEL[key] || key) : 'custom field'}) — review, then Save profile.`);
      }
    });
  });

  return v;
});

// ============================================================
// VIEW: Documents (#/documents)
// ============================================================
route('/documents', async () => {
  const [docsR, foldersR] = await Promise.all([
    api('/documents'),
    api('/document-folders').catch(() => ({ items: [] })),
  ]);
  const docs = docsR.items || [];
  const folders = foldersR.items || [];
  const filt = state.docsFilter;

  const counts = docs.reduce((a, dd) => { a[dd.role] = (a[dd.role] || 0) + 1; return a; }, {});
  const tabs = [{ id: 'all', label: 'All' }, ...DOC_ROLES].map((t) => {
    const n = t.id === 'all' ? docs.length : (counts[t.id] || 0);
    return `<button class="doc-tab ${filt.role === t.id ? 'active' : ''}" data-tab="${t.id}">${esc(t.label)} <span class="tab-n">${n}</span></button>`;
  }).join('');

  const shown = () => {
    let list = filt.role === 'all' ? docs : docs.filter((dd) => dd.role === filt.role);
    if (filt.q) {
      const q = filt.q.toLowerCase();
      list = list.filter((dd) => dd.name.toLowerCase().includes(q) || (dd.keywords || []).some((k) => String(k).toLowerCase().includes(q)));
    }
    return list;
  };
  const srcTag = (dd) => dd.source === 'folder' ? '<span class="doc-src">folder</span>'
    : dd.source === 'application' ? '<span class="doc-src">from application</span>' : '';
  const labelChip = (dd) => dd.label ? `<span class="doc-label" title="Designation">${esc(dd.label)}</span>` : '';
  const kwHtml = (dd) => (dd.keywords && dd.keywords.length)
    ? `<div class="kw-row">${dd.keywords.slice(0, 8).map((k) => `<span class="kw">${esc(k)}</span>`).join('')}</div>` : '<span class="muted">—</span>';
  const sumTxt = (s) => s ? ` — ${s.resume || 0} résumé · ${s.cover_letter || 0} cover · ${s.other || 0} other` : '';

  // Active (default) document per role — what autofill / auto-apply / tailoring use.
  const actRes = docs.find((dd) => dd.role === 'resume' && dd.isDefault);
  const actCov = docs.find((dd) => dd.role === 'cover_letter' && dd.isDefault);
  const adVal = (doc) => doc ? `<span class="ad-v">${esc(doc.label || doc.name)}</span>` : '<span class="ad-v muted">none — star a row</span>';

  const rowsHtml = (list) => list.length ? list.map((doc) => `
    <tr data-doc="${esc(doc.id)}" class="${doc.isDefault ? 'doc-active' : ''}">
      <td><button class="star-btn ${doc.isDefault ? 'on' : ''}" data-star title="${doc.isDefault ? 'Active ' + esc(DOC_ROLE_LABEL[doc.role] || doc.role) + ' — used by autofill, auto-apply & tailoring' : 'Set as active ' + esc(DOC_ROLE_LABEL[doc.role] || doc.role)}">★</button></td>
      <td class="title-cell">${esc(doc.name)} ${labelChip(doc)} ${srcTag(doc)} <button class="doc-rename" data-label title="Set a designation (e.g. Master CV)">✎</button></td>
      <td><select class="select doc-role" data-role-sel>${DOC_ROLES.map((r) => `<option value="${r.id}" ${doc.role === r.id ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></td>
      <td>${kwHtml(doc)}</td>
      <td class="num">${fmtBytes(doc.sizeBytes)}</td>
      <td>${dateHtml(doc.lastModified || doc.createdAt)}</td>
      <td class="nowrap">
        ${doc.hasText ? '<button class="btn small" data-text>Text</button>' : ''}
        ${doc.source !== 'folder' ? '<button class="btn small" data-dl>Download</button>' : ''}
        <button class="btn small" data-del>✕</button>
      </td>
    </tr>`).join('')
    : `<tr><td colspan="7">${emptyHtml('Empty drawer', filt.role === 'all' ? 'No documents yet' : 'No ' + (DOC_ROLE_LABEL[filt.role] || filt.role).toLowerCase() + ' here', 'Upload one, or link a local folder to index it automatically.')}</td></tr>`;

  const folderCards = folders.length ? folders.map((f) => `
    <div class="folder-card" data-folder="${esc(f.id)}">
      <div class="fc-main">
        <div class="fc-path" title="${esc(f.path)}">${esc(f.label || f.path)}</div>
        <div class="fc-meta">${esc(f.fileCount)} file(s) · ${f.lastScanAt ? 'scanned ' + esc(fmtRel(f.lastScanAt)) : 'not scanned yet'} · <span class="fc-live">auto-updates</span></div>
      </div>
      <div class="fc-actions">
        <button class="btn small" data-rescan>Re-index</button>
        <button class="btn small" data-unlink>Unlink</button>
      </div>
    </div>`).join('') : '<div class="muted" style="padding:6px 2px">No linked folders. Link one to auto-index its résumés / letters.</div>';

  const v = el(`<div>
    <header class="page-header">
      <div>
        <div class="page-eyebrow">Material</div>
        <h1 class="page-title">Documents</h1>
        <div class="page-sub">Résumés, cover letters & more — auto-collected from applications, with extracted text and keywords.</div>
      </div>
      <div class="page-actions">
        <select class="select" id="up-role">${DOC_ROLES.map((r) => `<option value="${r.id}">${esc(r.label)}</option>`).join('')}</select>
        <button class="btn primary" data-pick>Upload…</button>
        <input type="file" id="up-file" accept=".pdf,.docx,.doc,.txt,.md,.rtf" hidden />
      </div>
    </header>

    <section class="section">
      <header class="section-header"><div><div class="section-eyebrow">Folders</div><h2 class="section-title">Linked local folders</h2>
        <div class="form-hint">Indexed read-only & smartly — folders/files named “résumé”, “cover letter” etc. are recognised, junk is skipped, and changes are picked up automatically. Your files are never moved or changed.</div></div></header>
      <div class="folder-list">${folderCards}</div>
      <div class="folder-add">
        <input class="input" id="fold-path" placeholder="C:\\Users\\you\\Documents\\Job applications" style="flex:1" />
        <select class="select" id="fold-role"><option value="auto">auto-detect role</option>${DOC_ROLES.map((r) => `<option value="${r.id}">${esc(r.label)}</option>`).join('')}</select>
        ${state.host === 'desktop' ? '<button class="btn small" data-browse>Browse…</button>' : ''}
        <button class="btn small primary" data-link>Link &amp; index</button>
      </div>
    </section>

    <div class="active-docs">
      <span class="ad-item"><span class="ad-k">Active résumé</span>${adVal(actRes)}</span>
      <span class="ad-item"><span class="ad-k">Active cover letter</span>${adVal(actCov)}</span>
      <span class="ad-hint">★ a row to set the document autofill, auto-apply &amp; tailoring use.</span>
    </div>

    <div class="doc-toolbar">
      <div class="doc-tabs">${tabs}</div>
      <input class="input doc-search" id="doc-q" placeholder="Search name or keyword…" value="${esc(filt.q)}" />
    </div>

    <div class="dropzone" id="dropzone">Drop a file here, or click Upload</div>

    <section class="section">
      <div class="table-wrap"><table class="table">
        <thead><tr><th></th><th>Name</th><th>Role</th><th>Keywords</th><th>Size</th><th>Modified</th><th></th></tr></thead>
        <tbody id="doc-rows">${rowsHtml(shown())}</tbody>
      </table></div>
    </section>
  </div>`);

  if (filt.role !== 'all') { const sel = v.querySelector('#up-role'); if (sel.querySelector('option[value="' + filt.role + '"]')) sel.value = filt.role; }

  function wireRows() {
    v.querySelectorAll('tr[data-doc]').forEach((tr) => {
      const docId = tr.dataset.doc;
      const doc = docs.find((x) => x.id === docId);
      tr.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: doc.isDefault ? `Active ${DOC_ROLE_LABEL[doc.role] || doc.role} ✓` : `Set as active ${DOC_ROLE_LABEL[doc.role] || doc.role}`, run: async () => { await api('/documents/' + encodeURIComponent(docId), { method: 'PATCH', body: { isDefault: true } }); toast('Set as active'); navigate(); } },
        { label: 'Set designation…', run: async () => { const val = await promptModal('Designation (e.g. “Master CV”):', { title: 'Set designation', value: doc.label || '' }); if (val === null) return; await api('/documents/' + encodeURIComponent(docId), { method: 'PATCH', body: { label: val.trim() } }); navigate(); } },
        { sep: true },
        ...DOC_ROLES.map((r) => ({ label: `Role → ${r.label}${doc.role === r.id ? ' ✓' : ''}`, run: async () => { await api('/documents/' + encodeURIComponent(docId), { method: 'PATCH', body: { role: r.id } }); toast('Role updated'); navigate(); } })),
        { sep: true },
        doc.hasText && { label: 'View text', run: async () => { const r2 = await api('/documents/' + encodeURIComponent(docId) + '?text=1'); textModal(doc.name, r2.document?.textContent || '(no text)', { downloadName: doc.name + '.txt' }); } },
        doc.source !== 'folder' && { label: 'Download', run: async () => { const res = await api('/documents/' + encodeURIComponent(docId) + '?raw=1', { raw: true, timeoutMs: 30000 }); downloadBlob(await res.blob(), doc.name); } },
        { sep: true },
        { label: 'Remove', danger: true, run: async () => { const permanent = doc.source !== 'folder'; if (!(await confirmModal(permanent ? `Delete “${doc.name}”? The file is permanently removed.` : 'Remove this entry? Your file is untouched.', { danger: true, okLabel: permanent ? 'Delete' : 'Remove' }))) return; await api('/documents/' + encodeURIComponent(docId), { method: 'DELETE' }); toast('Removed'); navigate(); } },
      ]));
      tr.querySelector('[data-star]')?.addEventListener('click', async () => {
        try { await api('/documents/' + encodeURIComponent(docId), { method: 'PATCH', body: { isDefault: true } }); toast(`Set as active ${DOC_ROLE_LABEL[doc.role] || doc.role}`); navigate(); }
        catch (e) { errToast(e); }
      });
      tr.querySelector('[data-role-sel]')?.addEventListener('change', async (e) => {
        try { await api('/documents/' + encodeURIComponent(docId), { method: 'PATCH', body: { role: e.target.value } }); toast('Role updated'); navigate(); }
        catch (err) { errToast(err); }
      });
      tr.querySelector('[data-label]')?.addEventListener('click', async () => {
        const val = await promptModal('Designation for this document (e.g. “Master CV”, “Short résumé”):', { title: 'Set designation', value: doc.label || '' });
        if (val === null) return;
        try { await api('/documents/' + encodeURIComponent(docId), { method: 'PATCH', body: { label: val.trim() } }); navigate(); }
        catch (err) { errToast(err); }
      });
      tr.querySelector('[data-dl]')?.addEventListener('click', async () => {
        try {
          const res = await api('/documents/' + encodeURIComponent(docId) + '?raw=1', { raw: true, timeoutMs: 30000 });
          downloadBlob(await res.blob(), doc.name);
        } catch (e) { errToast(e); }
      });
      tr.querySelector('[data-text]')?.addEventListener('click', async () => {
        try {
          const r2 = await api('/documents/' + encodeURIComponent(docId) + '?text=1');
          textModal(doc.name, r2.document?.textContent || '(no text extracted)', { downloadName: doc.name + '.txt' });
        } catch (e) { errToast(e); }
      });
      tr.querySelector('[data-del]')?.addEventListener('click', async () => {
        const permanent = doc && doc.source !== 'folder';
        const msg = permanent
          ? `Delete “${doc.name}”? The file will be permanently removed from the app.`
          : `Remove “${doc?.name || 'this entry'}” from the library? Your original file is untouched.`;
        if (!(await confirmModal(msg, { danger: true, okLabel: permanent ? 'Delete' : 'Remove' }))) return;
        try { await api('/documents/' + encodeURIComponent(docId), { method: 'DELETE' }); toast('Document removed'); navigate(); }
        catch (e) { errToast(e); }
      });
    });
  }
  const rerenderRows = () => { v.querySelector('#doc-rows').innerHTML = rowsHtml(shown()); wireRows(); };
  wireRows();

  v.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    state.docsFilter.role = b.dataset.tab;
    v.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
    rerenderRows();
  }));
  v.querySelector('#doc-q').addEventListener('input', debounce((e) => { state.docsFilter.q = e.target.value.trim(); rerenderRows(); }, 200));

  async function upload(file) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast('File too large (10 MB max)', 'danger'); return; }
    const role = v.querySelector('#up-role').value;
    toast(`Uploading ${file.name}…`, 'info', { ttl: 2500 });
    try {
      const dataBase64 = await fileToB64(file);
      const r2 = await api('/documents', {
        method: 'POST', timeoutMs: 60000,
        body: { name: file.name, role, mime: file.type, dataBase64, isDefault: docs.filter((x) => x.role === role).length === 0 },
      });
      toast(r2.extractedChars
        ? `Uploaded — extracted ${r2.extractedChars.toLocaleString()} characters of text ✓`
        : 'Uploaded — but no text could be extracted from this file', r2.extractedChars ? 'info' : 'danger');
      navigate();
    } catch (e) { errToast(e, 'Upload failed'); }
  }

  v.querySelector('[data-pick]').addEventListener('click', () => v.querySelector('#up-file').click());
  v.querySelector('#up-file').addEventListener('change', (e) => upload(e.target.files[0]));
  const dz = v.querySelector('#dropzone');
  dz.addEventListener('click', () => v.querySelector('#up-file').click());
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); upload(e.dataTransfer.files[0]); });

  // folder linking + indexing
  const browse = v.querySelector('[data-browse]');
  if (browse) browse.addEventListener('click', async () => {
    try { const p = await window.jatDesktop?.pickFolder?.(); if (p) v.querySelector('#fold-path').value = p; }
    catch (e) { errToast(e); }
  });
  v.querySelector('[data-link]').addEventListener('click', async (e) => {
    const path = v.querySelector('#fold-path').value.trim();
    if (!path) { toast('Enter a folder path', 'danger'); return; }
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Indexing…';
    try {
      const r2 = await api('/document-folders', { method: 'POST', timeoutMs: 300000, body: { path, roleHint: v.querySelector('#fold-role').value } });
      toast(`Linked & indexed ${r2.indexed} file(s)${sumTxt(r2.summary)}`);
      navigate();
    } catch (err) { errToast(err, 'Link failed'); btn.disabled = false; btn.textContent = 'Link & index'; }
  });
  v.querySelectorAll('.folder-card').forEach((card) => {
    const fid = card.dataset.folder;
    card.querySelector('[data-rescan]').addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = '…';
      try { const r2 = await api('/document-folders/' + encodeURIComponent(fid) + '/scan', { method: 'POST', timeoutMs: 300000 }); toast(`Re-indexed ${r2.indexed} file(s)${sumTxt(r2.summary)}`); navigate(); }
      catch (err) { errToast(err); btn.disabled = false; btn.textContent = 'Re-index'; }
    });
    card.querySelector('[data-unlink]').addEventListener('click', async () => {
      if (!(await confirmModal('Unlink this folder? Its indexed entries leave the library (your actual files are untouched).', { danger: true, okLabel: 'Unlink' }))) return;
      try { await api('/document-folders/' + encodeURIComponent(fid) + '?prune=1', { method: 'DELETE' }); toast('Folder unlinked'); navigate(); }
      catch (err) { errToast(err); }
    });
  });

  return v;
});

// ============================================================
// VIEW: Activity (#/activity)
// ============================================================
const EVENT_ICONS = {
  created: '＋', status_changed: '→', reopened: '↻', email: '✉',
  progressing: '…', resume_tailored: '✎', note: '·',
};
route('/activity', async () => {
  const [evR, usageR] = await Promise.all([
    api('/events/recent?limit=120').catch(() => ({ items: [] })),
    api('/ai/usage').catch(() => null),
  ]);
  const events = evR.items || [];

  const feed = events.length ? events.map((e) => `
    <div class="feed-item">
      <span class="feed-icon">${esc(EVENT_ICONS[e.type] || '·')}</span>
      <span class="feed-text">${esc(e.summary || e.type)}</span>
      <span class="feed-meta">${esc(fmtRel(e.timestamp))} · ${esc(e.source || '')}</span>
    </div>`).join('')
    : emptyHtml('Silence', 'No activity yet', 'Events appear as captures, status changes, and syncs happen.');

  const usageRows = (usageR?.usage || []).map((u) => `
    <tr><td>${esc(u.provider)}</td><td class="num">${esc(u.calls)}</td><td class="num">${esc(u.ok_calls)}</td><td class="num">${u.total_ms ? Math.round(u.total_ms / 1000) + 's' : '—'}</td></tr>`).join('')
    || '<tr><td colspan="4" class="muted" style="padding:16px 24px">No AI calls yet.</td></tr>';

  const recentAi = (usageR?.recent || []).slice(0, 20).map((l) => `
    <tr><td>${esc(l.kind)}</td><td>${esc(l.provider)}${l.model ? ' <span class="muted">' + esc(l.model) + '</span>' : ''}</td>
    <td class="num">${esc(Math.round((l.ms || 0) / 100) / 10)}s</td>
    <td>${l.ok ? '<span class="text-ind ok">ok</span>' : `<span class="text-ind no" title="${esc(l.error || '')}">failed</span>`}</td>
    <td>${relHtml(l.ts)}</td></tr>`).join('');

  const v = el(`<div>
    <header class="page-header">
      <div>
        <div class="page-eyebrow">System</div>
        <h1 class="page-title">Activity</h1>
        <div class="page-sub">Everything that happened, and what the AI cost you.</div>
      </div>
      <div class="page-actions"><button class="btn" data-refresh>Refresh</button></div>
    </header>

    <div class="app-detail">
      <section class="section">
        <header class="section-header"><div><div class="section-eyebrow">Record</div><h2 class="section-title">Event feed</h2></div></header>
        <div class="feed">${feed}</div>
      </section>

      <div>
        <section class="section">
          <header class="section-header"><div><div class="section-eyebrow">Meter</div><h2 class="section-title">AI usage</h2></div></header>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Provider</th><th>Calls</th><th>OK</th><th>Time</th></tr></thead>
            <tbody>${usageRows}</tbody>
          </table></div>
        </section>
        <section class="section">
          <header class="section-header"><div><div class="section-eyebrow">Recent</div><h2 class="section-title">AI calls</h2></div></header>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Kind</th><th>Provider</th><th>Time</th><th>Result</th><th>When</th></tr></thead>
            <tbody>${recentAi || '<tr><td colspan="5" class="muted" style="padding:16px 24px">—</td></tr>'}</tbody>
          </table></div>
        </section>
      </div>
    </div>
  </div>`);
  v.querySelector('[data-refresh]').addEventListener('click', navigate);
  return v;
});

// ============================================================
// VIEW: Settings (#/settings)
// ============================================================
route('/settings', async () => {
  const [settings, aiSt, gmailSt, hw, emailR] = await Promise.all([
    getSettings(true),
    api('/ai/status').catch(() => null),
    api('/gmail/status').catch(() => null),
    api('/hardware').catch(() => null),
    api('/email/accounts').catch(() => null),
  ]);
  const s = settings;
  const ollamaModels = aiSt?.ollama?.models?.map((m) => m.name) || [];

  // AI provider priority (defensive: bridge legacy string order, ensure all 3).
  const aiOrder = (() => {
    const base = Array.isArray(s.ai.order) ? s.ai.order.filter((k) => ['claude', 'chatgpt', 'local'].includes(k)) : [];
    for (const k of ['claude', 'chatgpt', 'local']) if (!base.includes(k)) base.push(k);
    return base;
  })();
  const PROV_LABEL = { claude: 'Claude · Sonnet 4.6', chatgpt: 'ChatGPT · GPT-5.4', local: 'Local · Ollama' };
  const provStatusOf = (k) => (k === 'claude' ? aiSt?.claude : k === 'chatgpt' ? aiSt?.chatgpt : aiSt?.local);
  const aiDot = (st) => st?.available ? '<span class="sys-chip ok">● ready</span>' : '<span class="sys-chip">○ not set up</span>';
  const claude = s.ai.claude || {};
  const chatgpt = (() => {     // bridge new ai.chatgpt over legacy ai.cloud field-by-field
    const cg = s.ai.chatgpt || {}, old = s.ai.cloud || {};
    return { useSubscription: cg.useSubscription, apiKey: cg.apiKey || old.apiKey || '', model: cg.model || old.model || 'gpt-5.4' };
  })();
  const localAi = s.ai.local || {};

  const row = (label, html, hint = '') =>
    `<div class="form-row"><div class="form-label">${esc(label)}${hint ? `<div class="form-hint">${esc(hint)}</div>` : ''}</div><div class="form-control">${html}</div></div>`;
  const toggle = (idd, on) => `<label class="toggle"><input type="checkbox" id="${idd}" ${on ? 'checked' : ''} /><span class="knob"></span></label>`;
  const modelSelect = (idd, current) => ollamaModels.length
    ? `<select class="select" id="${idd}">${[...new Set([current, ...ollamaModels])].filter(Boolean).map((m) => `<option value="${esc(m)}" ${m === current ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>`
    : `<input class="input" id="${idd}" value="${esc(current)}" />`;
  const provChip = (label, st) => st
    ? `<span class="sys-chip ${st.available ? 'ok' : 'bad'}" title="${esc(st.reason || '')}">${esc(label)} ${st.available ? '● ready' : '○ ' + esc((st.reason || 'unavailable').slice(0, 40))}</span>`
    : `<span class="sys-chip">${esc(label)} · unknown</span>`;

  // The AI section body: the ONE clean message when AI is off (master switch), else the full
  // provider UI. When off, none of the provider inputs exist — the save payload handles both shapes.
  const aiBodyHtml = () => s.ai.disabled ? `
      <div class="section-body"><div class="muted" style="line-height:1.7">
        <b>AI features are turned off on this computer.</b><br/>
        Everything else works normally — applications are captured and auto-apply still runs.
        Questions it can't answer from your profile are saved for you under <b>Needs You</b>,
        and every answer you give there is remembered for next time.
      </div></div>` : `
      <div class="ai-order" id="ai-order-list">
        ${aiOrder.map((k, i) => `<div class="ai-rank" data-prov="${k}">
          <span class="ai-rank-n">${i + 1}</span>
          <span class="ai-rank-label">${esc(PROV_LABEL[k])}</span>
          ${aiDot(provStatusOf(k))}
          <span class="ai-rank-moves"><button class="btn small" data-up title="Move up">↑</button><button class="btn small" data-down title="Move down">↓</button></span>
        </div>`).join('')}
      </div>

      <div class="ai-prov">
        <div class="ai-prov-head">Claude (Anthropic) ${aiDot(aiSt?.claude)}</div>
        ${row('API key', `<input class="input" id="ai-claude-key" type="password" placeholder="${state.secretsPresent && state.secretsPresent.claudeKey ? 'saved — leave blank to keep current' : 'sk-ant-…'}" value="${esc(claude.apiKey || '')}" />`, 'from console.anthropic.com — Claude can only run via an API key (subscriptions are blocked outside Claude Code)')}
        ${row('Model', `<input class="input" id="ai-claude-model" value="${esc(claude.model || 'claude-sonnet-4-6')}" />`)}
        <div class="section-body"><button class="btn small" data-test="claude">Test Claude</button></div>
      </div>

      <div class="ai-prov">
        <div class="ai-prov-head">ChatGPT (OpenAI) ${aiDot(aiSt?.chatgpt)}</div>
        ${row('Use my ChatGPT subscription', toggle('ai-cg-sub', chatgpt.useSubscription !== false), 'via the official Codex CLI (personal use)')}
        <div class="form-row"><div class="form-label">Subscription</div><div class="form-control">${aiDot(aiSt?.chatgpt?.subscription)}
          <button class="btn small" data-connect-codex>Connect / sign in</button> <button class="btn small" data-recheck>Re-check</button></div></div>
        ${row('OpenAI API key', `<input class="input" id="ai-oai-key" type="password" placeholder="${state.secretsPresent && state.secretsPresent.chatgptKey ? 'saved — leave blank to keep current' : 'sk-…'}" value="${esc(chatgpt.apiKey || '')}" />`, 'alternative to the subscription')}
        ${row('Model', `<input class="input" id="ai-cg-model" value="${esc(chatgpt.model || 'gpt-5.4')}" />`)}
        <div class="section-body"><button class="btn small" data-test="chatgpt">Test ChatGPT</button></div>
      </div>

      <div class="ai-prov">
        <div class="ai-prov-head">Local (Ollama) ${aiDot(aiSt?.local)}</div>
        ${row('Enable local AI', toggle('ai-local-enabled', !!localAi.enabled), 'off = JAT never runs, probes, or downloads Ollama (cloud providers still work)')}
        <div id="ai-local-body" ${localAi.enabled ? '' : 'hidden'}>
        ${row('This machine', `<span class="muted">${hw ? esc(hw.ramGb + ' GB RAM · ' + (hw.gpuName ? hw.gpuName + ' (' + hw.vramGb + ' GB)' : 'no GPU detected')) : 'detecting…'}</span>`)}
        ${row('Recommended', hw ? `<span>${esc(hw.recommend.label)} — <span class="mono">${esc(hw.recommend.structured)}</span></span>` : '—', hw ? '~' + hw.recommend.approxGb + ' GB download' : '')}
        ${row('Auto-pick for hardware', toggle('ai-local-autopick', localAi.autoPick !== false))}
        ${row('Auto-download in background', toggle('ai-local-autosetup', !!localAi.autoSetup), 'set up local AI automatically on launch (off = set up here on demand)')}
        <div class="form-row"><div class="form-label">Set up local AI<div class="form-hint">downloads Ollama + models</div></div><div class="form-control">
          <button class="btn small primary" data-setup-local>Set up / update</button>
          <div class="setup-bar" id="setup-bar" hidden><div class="setup-track"><div class="setup-fill"></div></div><span class="setup-msg"></span></div>
        </div></div>
        ${row('Server URL', `<input class="input" id="ai-local-url" value="${esc(localAi.url || 'http://localhost:11434')}" />`)}
        ${row('Structured model', `<input class="input" id="ai-local-structured" value="${esc(localAi.structuredModel || '')}" placeholder="(use recommendation)" />`, 'blank = recommended')}
        ${row('Prose model', `<input class="input" id="ai-local-prose" value="${esc(localAi.proseModel || '')}" placeholder="(use recommendation)" />`, 'blank = recommended')}
        <div class="section-body"><button class="btn small" data-test="local">Test local</button></div>
        </div>
      </div>`;

  // ---- email integration (multi-provider IMAP) ----
  const emailPresets = (emailR && emailR.presets) || {};
  const emailAccts = (emailR && emailR.accounts) || [];
  const emailStats = (emailR && emailR.stats) || {};
  const emProvOpts = Object.entries(emailPresets).map(([k, p]) => `<option value="${esc(k)}">${esc(p.label)}</option>`).join('') || '<option value="gmail">Gmail</option>';
  const emAcctRow = (a) => `<div class="acct-row" data-acct="${esc(a.id)}">
      <span class="sys-chip ${a.hasPassword ? 'ok' : ''}">${a.hasPassword ? '●' : '○'}</span>
      <span class="acct-email">${esc(a.email)}</span> <span class="muted">· ${esc((emailPresets[a.provider] || {}).label || a.provider)}</span>
      <span class="muted acct-stat">${(emailStats.byAccount && emailStats.byAccount[a.id]) ? esc(emailStats.byAccount[a.id].count + ' synced') : ''}</span>
      <button class="btn small danger" data-email-remove="${esc(a.id)}">Remove</button>
    </div>`;
  const emAccountsHtml = emailAccts.length ? emailAccts.map(emAcctRow).join('')
    : '<div class="muted" style="font-size:13px">No email connected yet — add one below and JAT will auto-track replies, confirmations & interviews.</div>';
  const emStatsHtml = emailStats.total
    ? `${emailStats.total} synced · ${emailStats.matched} matched · ${emailStats.suggested} suggested`
      + (Object.keys(emailStats.byCategory || {}).length ? ' · ' + Object.entries(emailStats.byCategory).map(([c, n]) => `${esc(String(n))} ${esc(String(c).replace(/_/g, ' '))}`).join(', ') : '')
    : 'Nothing synced yet — connect an account, then Sync now.';

  const themeGrid = THEMES.map((t) => `
    <button class="swatch ${document.body.dataset.theme === t.id ? 'active' : ''}" data-theme-id="${esc(t.id)}" type="button">
      <span class="swatch-chips">
        <span class="swatch-chip" style="background:${esc(t.vars.bg)}"></span>
        <span class="swatch-chip" style="background:${esc(t.vars.panel)}"></span>
        <span class="swatch-chip" style="background:${esc(t.vars.primary)}"></span>
        <span class="swatch-chip" style="background:${esc(t.vars.text)}"></span>
      </span>
      <span class="swatch-name">${esc(t.name)}</span>
      <span class="swatch-mode">${esc(t.mode)}</span>
    </button>`).join('');

  const v = el(`<div>
    <header class="page-header">
      <div>
        <div class="page-eyebrow">System</div>
        <h1 class="page-title">Settings</h1>
        <div class="page-sub">Hardcoded defaults, all overridable here.</div>
      </div>
    </header>

    <section class="section">
      <header class="section-header"><div><div class="section-eyebrow">General</div><h2 class="section-title">App</h2></div>
        <button class="btn small primary" data-save-section="app">Save</button></header>
      ${row('Server port', `<span class="mono muted">${esc(s.server.port)} · restart the app to change</span>`)}
      ${row('Close to tray', toggle('app-tray', s.app.closeToTray), 'capture keeps running with the window closed')}
      ${row('Start with Windows', toggle('app-autolaunch', s.app.autoLaunch))}
      ${row('Global hotkey', toggle('app-hotkey', s.app.globalHotkey), 'Ctrl+Shift+J toggles this window')}
    </section>

    <section class="section">
      <header class="section-header"><div><div class="section-eyebrow">Assistant</div><h2 class="section-title">AI providers</h2>
        <div class="form-hint">Used by every AI feature. Tried top-to-bottom; first one that's set up wins. Drag-free reorder with ↑ ↓.</div></div>
        <button class="btn small primary" data-save-section="ai">Save</button></header>

      ${row('AI features', toggle('ai-master', !s.ai.disabled), 'off = AI is fully disabled on this computer — no downloads, no background AI, no keys needed')}
      ${aiBodyHtml()}
    </section>

    <section class="section">
      <header class="section-header"><div><div class="section-eyebrow">Capture</div><h2 class="section-title">In-page behaviour</h2></div>
        <button class="btn small primary" data-save-section="capture">Save</button></header>
      ${row('Panel on detection', toggle('cap-panel', s.capture.panelOnDetect), 'off = silent until you click Apply')}
      ${row('Ask when unsure', toggle('cap-ask', s.capture.askWhenUnsure), 'mid-confidence pages ask once; “Not a job” silences the site forever')}
    </section>

    <section class="section">
      <header class="section-header"><div><div class="section-eyebrow">Autofill</div><h2 class="section-title">Profile autofill &amp; learning</h2></div>
        <button class="btn small primary" data-save-section="autofill">Save</button></header>
      ${row('Auto-fill new applications', toggle('saf-enabled', s.autofill.enabled), 'fills EMPTY fields from your profile when you open an application — never submits for you')}
      ${row('Use structured profile fields', toggle('saf-profile', s.autofill.fillProfile))}
      ${row('Use learned answers', toggle('saf-learned', s.autofill.fillLearned))}
      ${row('Skip sensitive fields', toggle('saf-sensitive', s.autofill.skipSensitive), 'never auto-fill EEO / demographic / identity questions')}
      ${row('Highlight filled fields', toggle('saf-highlight', s.autofill.highlight))}
      ${row('Match confidence', `<input class="input" id="saf-minconf" type="number" min="0.3" max="1" step="0.05" value="${esc(s.autofill.minConfidence)}" />`, 'higher = only fill very confident matches (0.3–1.0)')}
      ${row('Learn answers from applications', toggle('hv-enabled', s.harvest.enabled), 'auto-build your profile from the answers you give — appears under Profile → Learned answers')}
    </section>

    <section class="section" id="email-section">
      <header class="section-header">
        <div><div class="section-eyebrow">Mail</div><h2 class="section-title">Connect your email</h2>
          <div class="form-hint">Auto-track replies, confirmations, interviews &amp; offers across your applications. Gmail, Outlook &amp; Yahoo — connect once, it syncs in the background.</div></div>
        <button class="btn small" data-email-syncnow>Sync now</button>
      </header>
      <div class="section-body">
        <div id="email-accounts">${emAccountsHtml}</div>
        <div id="email-stats" class="muted" style="font-size:12px;margin-top:8px">${emStatsHtml}</div>
      </div>
      <details class="fold" id="email-add" ${emailAccts.length ? '' : 'open'}>
        <summary>+ Add an email account</summary>
        <div class="section-body">
          ${row('Provider', `<select class="select" id="em-provider">${emProvOpts}</select>`)}
          <ol class="email-steps" id="em-steps"></ol>
          <div id="em-imaprow" hidden>
            ${row('IMAP host', `<input class="input" id="em-host" placeholder="imap.example.com" />`)}
            ${row('Port', `<input class="input" id="em-port" type="number" value="993" />`)}
          </div>
          ${row('Email address', `<input class="input" id="em-email" type="email" placeholder="you@gmail.com" autocomplete="off" />`)}
          ${row('App Password', `<input class="input" id="em-pass" type="password" placeholder="paste the 16-character app password" autocomplete="off" />`, 'This is the App Password you generated above — NOT your normal login password.')}
          <div class="section-footer">
            <button class="btn small" data-email-test>Test connection</button>
            <button class="btn small primary" data-email-add>Connect</button>
            <span class="muted" id="em-result"></span>
          </div>
        </div>
      </details>
    </section>

    <section class="section">
      <header class="section-header"><div><div class="section-eyebrow">Mail</div><h2 class="section-title">Gmail OAuth sync (advanced)</h2>
        <div class="form-hint">Legacy LinkedIn-notification sync via Google OAuth (needs your own Google Cloud client). Most people should use “Connect your email” above instead.</div></div>
        <button class="btn small primary" data-save-section="gmail">Save</button></header>
      <div class="section-body">
        <span class="sys-chip ${gmailSt?.authorized ? 'ok' : ''}">${gmailSt?.authorized ? '● connected' : '○ not connected'}</span>
        ${gmailSt?.lastResult?.at ? `<span class="muted" style="font-size:12px;margin-left:8px">last sync ${esc(fmtRel(gmailSt.lastResult.at))} · ${esc(gmailSt.lastResult.updated ?? 0)} updated</span>` : ''}
      </div>
      ${row('Enabled', toggle('gm-enabled', s.gmail.enabled))}
      ${row('Search query', `<input class="input" id="gm-query" value="${esc(s.gmail.query)}" />`, 'Gmail search syntax')}
      ${row('Interval (minutes)', `<input class="input" id="gm-interval" type="number" min="5" value="${esc(s.gmail.intervalMinutes)}" />`)}
      ${row('OAuth Client ID', `<input class="input" id="gm-cid" value="${esc(s.gmail.clientId)}" />`, 'Google Cloud Console → OAuth desktop app')}
      ${row('OAuth Client Secret', `<input class="input" id="gm-secret" type="password" placeholder="${state.secretsPresent && state.secretsPresent.gmailSecret ? 'saved — leave blank to keep current' : ''}" value="${esc(s.gmail.clientSecret)}" />`)}
      <div class="section-footer">
        <button class="btn small" data-gmail-connect>Connect Gmail…</button>
        <button class="btn small" data-gmail-sync>Sync now</button>
        <span class="muted" id="gm-status"></span>
      </div>
    </section>

    <section class="section">
      <header class="section-header"><div><div class="section-eyebrow">Signals</div><h2 class="section-title">Notifications</h2></div>
        <button class="btn small primary" data-save-section="notifications">Save</button></header>
      ${row('Status changes', toggle('nt-status', s.notifications.statusChanges))}
      ${row('Auto-apply events', toggle('nt-aa', s.notifications.autoApply))}
      ${row('Updates', toggle('nt-upd', s.notifications.updates))}
      ${row('Follow-up reminders', toggle('nt-fu', s.notifications.followUps))}
    </section>

    <section class="section">
      <header class="section-header"><div><div class="section-eyebrow">Appearance</div><h2 class="section-title">Theme</h2></div></header>
      <div class="theme-grid section-body">${themeGrid}</div>
    </section>

    <section class="section">
      <header class="section-header"><div><div class="section-eyebrow">About</div><h2 class="section-title">Version & updates</h2></div></header>
      <div class="section-body">
        <div class="kv"><span class="muted">App version</span> <strong id="upd-version">v${esc(state.version || '?')}</strong></div>
        <div class="form-row" style="margin-top:10px"><div class="form-label">Update mode<div class="form-hint">pinned = never check or install — stays on this version until changed here</div></div>
          <div class="form-control"><select class="select" id="upd-mode">
            ${['auto', 'prompt', 'manual', 'pinned'].map((m) => `<option value="${m}" ${(s.autoUpdate?.mode || 'auto') === m ? 'selected' : ''}>${{ auto: 'Automatic (install when idle)', prompt: 'Notify me (in-app banner)', manual: 'Manual check only', pinned: 'Pinned — never update' }[m]}</option>`).join('')}
          </select></div></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
          <button class="btn small" data-check-updates>Check for updates</button>
          <button class="btn small" data-restart-update hidden>Restart to apply update</button>
          <button class="btn small" data-releases>Releases &amp; downloads</button>
        </div>
        <div class="status-line" id="upd-status" style="margin-top:8px"></div>
        <div class="section-footer muted">${(s.autoUpdate?.mode === 'pinned')
          ? 'Updates are PINNED — this computer stays on its installed version until the mode above is changed.'
          : state.host === 'desktop'
            ? 'The app checks automatically on launch and every 4 hours, downloads in the background, and prompts you to restart.'
            : 'The desktop app self-updates; you can also re-download the installer from the toolbar popup or the releases page.'}</div>
      </div>
    </section>

    <section class="section">
      <header class="section-header"><div><div class="section-eyebrow">Network</div><h2 class="section-title">Remote access (local network)</h2>
        <div class="form-hint">Watch this JAT live from another computer on the same network — the full dashboard: auto-apply running now, every application, activity, logs.</div></div></header>
      <div class="section-body">
        ${row('Allow local-network access', toggle('remote-access', !!s.server.remoteAccess), 'off = this computer only. Changing this needs an app restart (and a firewall rule the USB kit sets up).')}
        <div id="remote-urls" class="muted" style="font-size:12px;line-height:1.7;margin-top:6px">${s.server.remoteAccess ? 'Loading addresses…' : 'Turn on, restart the app, then the connect links appear here.'}</div>
      </div>
    </section>

    <section class="section">
      <header class="section-header"><div><div class="section-eyebrow">Data</div><h2 class="section-title">Backup & portability</h2></div></header>
      <div class="section-body" style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn small" data-backup>Back up database now</button>
        <button class="btn small" data-export>Export everything (JSON)</button>
        <button class="btn small" data-import-data>Import JSON…</button>
        <input type="file" id="import-file" accept=".json" hidden />
        ${state.host === 'desktop' ? '<button class="btn small" data-logs>Open logs folder</button>' : ''}
      </div>
      <div class="section-footer muted">Daily backups rotate automatically in the app's data folder. Exports never include your API keys or OAuth secret.</div>
    </section>

    <section class="section">
      <header class="section-header"><div><div class="section-eyebrow">Danger zone</div><h2 class="section-title">Delete all my data</h2></div></header>
      <div class="section-body" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn small danger" data-wipe>Delete all my data…</button>
      </div>
      <div class="section-footer muted">Permanently removes every application, email, profile, document, and learned answer, and disconnects any linked email/Gmail accounts. Cannot be undone.</div>
    </section>
  </div>`);

  // remote access (LAN)
  v.querySelector('#remote-access')?.addEventListener('change', async (e) => {
    try {
      await api('/settings', { method: 'PATCH', body: { server: { remoteAccess: e.target.checked } } });
      state.settings = null;
      toast(e.target.checked
        ? 'Remote access ON after the next app restart (quit from the tray, reopen)'
        : 'Remote access OFF after the next app restart', 'info', { ttl: 6000 });
    } catch (err) { errToast(err); }
  });
  if (s.server.remoteAccess) {
    api('/netinfo').then((n) => {
      const box = v.querySelector('#remote-urls');
      if (!box) return;
      if (!n.ips?.length) { box.textContent = 'No network address found — is this computer on the network?'; return; }
      box.innerHTML = 'Open from another computer on the same network:<br/>' + n.ips.map((i) =>
        `<span class="mono">http://${esc(i.ip)}:${esc(String(n.port))}/app/?token=${esc(state.token || '')}#/auto-apply</span> <span class="muted">(${esc(i.iface)})</span>`
      ).join('<br/>') + '<br/>The link includes this JAT’s access key — share it only with your own devices.';
    }).catch(() => {});
  }

  // updates
  const updStatus = (msg, cls = '') => { const el = v.querySelector('#upd-status'); el.className = 'status-line ' + cls; el.textContent = msg; };
  v.querySelector('#upd-mode')?.addEventListener('change', async (e) => {
    try {
      await api('/settings', { method: 'PATCH', body: { autoUpdate: { mode: e.target.value } } });
      state.settings = null;
      toast(e.target.value === 'pinned' ? 'Updates pinned — this computer stays on its current version' : `Update mode: ${e.target.value}`);
      navigate();   // footer text reflects the mode
    } catch (err) { errToast(err); }
  });
  v.querySelector('[data-releases]').addEventListener('click', () => {
    if (window.jatDesktop) window.jatDesktop.openReleases();
    else window.open('https://github.com/PierreSalama/Job-ext-app/releases', '_blank');
  });
  v.querySelector('[data-check-updates]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; updStatus('Checking…');
    try {
      if (window.jatDesktop) {
        const r = await window.jatDesktop.checkUpdates();
        if (r.status === 'current') updStatus(`You're on the latest version (v${r.current}).`, 'ok');
        else if (r.status === 'available' || r.status === 'downloaded') {
          updStatus(`Update v${r.version} found — downloading. You'll be prompted to restart.`, 'ok');
          if (r.status === 'downloaded') v.querySelector('[data-restart-update]').hidden = false;
        } else if (r.status === 'pinned') updStatus('Updates are pinned on this computer — change the update mode above to check.');
        else if (r.status === 'dev') updStatus('Dev build — updates only run in the installed app.');
        else if (r.status === 'error') updStatus(r.error || 'Update check failed.', 'bad');
        else updStatus('Still checking — try again shortly.');
      } else {
        // Extension host: it can't drive the app's updater; route to the popup/releases.
        updStatus('Open the toolbar popup to download/update the app, or use “Releases & downloads”.');
      }
    } catch (err) { updStatus(String(err.message || err), 'bad'); }
    btn.disabled = false;
  });
  v.querySelector('[data-restart-update]').addEventListener('click', () => { if (window.jatDesktop) window.jatDesktop.restartToUpdate(); });
  // Reflect a pending downloaded-update on load.
  if (window.jatDesktop) {
    window.jatDesktop.updateState().then((u) => {
      if (u?.status === 'downloaded') { v.querySelector('[data-restart-update]').hidden = false; updStatus(`Update v${u.version} downloaded — restart to apply.`, 'ok'); }
      else if (u?.status === 'downloading') updStatus(`Downloading update v${u.version || ''}… ${u.percent || 0}%`);
    }).catch(() => {});
  }

  // section saves
  const sections = {
    app: () => ({ app: {
      closeToTray: v.querySelector('#app-tray').checked,
      autoLaunch: v.querySelector('#app-autolaunch').checked,
      globalHotkey: v.querySelector('#app-hotkey').checked,
    } }),
    ai: () => {
      // Master switch first: when AI is off (or being turned off) the provider inputs may not
      // exist in the DOM — send ONLY the flag; the PATCH deep-merge keeps everything else.
      const master = v.querySelector('#ai-master');
      const disabled = master ? !master.checked : false;
      if (disabled || !v.querySelector('#ai-order-list')) return { ai: { disabled } };
      return { ai: {
        disabled: false,
        order: [...v.querySelectorAll('#ai-order-list .ai-rank')].map((el2) => el2.dataset.prov),
        claude: {
          apiKey: v.querySelector('#ai-claude-key').value.trim(),
          model: v.querySelector('#ai-claude-model').value.trim() || 'claude-sonnet-4-6',
        },
        chatgpt: {
          useSubscription: v.querySelector('#ai-cg-sub').checked,
          apiKey: v.querySelector('#ai-oai-key').value.trim(),
          model: v.querySelector('#ai-cg-model').value.trim() || 'gpt-5.4',
        },
        local: {
          enabled: v.querySelector('#ai-local-enabled').checked,
          url: v.querySelector('#ai-local-url').value.trim() || 'http://localhost:11434',
          autoPick: v.querySelector('#ai-local-autopick').checked,
          autoSetup: v.querySelector('#ai-local-autosetup').checked,
          structuredModel: v.querySelector('#ai-local-structured').value.trim(),
          proseModel: v.querySelector('#ai-local-prose').value.trim(),
        },
      } };
    },
    capture: () => ({ capture: {
      panelOnDetect: v.querySelector('#cap-panel').checked,
      askWhenUnsure: v.querySelector('#cap-ask').checked,
    } }),
    autofill: () => ({
      autofill: {
        enabled: v.querySelector('#saf-enabled').checked,
        fillProfile: v.querySelector('#saf-profile').checked,
        fillLearned: v.querySelector('#saf-learned').checked,
        skipSensitive: v.querySelector('#saf-sensitive').checked,
        highlight: v.querySelector('#saf-highlight').checked,
        minConfidence: Math.min(1, Math.max(0.3, Number(v.querySelector('#saf-minconf').value) || 0.6)),
      },
      harvest: { enabled: v.querySelector('#hv-enabled').checked },
    }),
    gmail: () => ({ gmail: {
      enabled: v.querySelector('#gm-enabled').checked,
      query: v.querySelector('#gm-query').value.trim(),
      intervalMinutes: Number(v.querySelector('#gm-interval').value) || 30,
      clientId: v.querySelector('#gm-cid').value.trim(),
      clientSecret: v.querySelector('#gm-secret').value,
    } }),
    notifications: () => ({ notifications: {
      statusChanges: v.querySelector('#nt-status').checked,
      autoApply: v.querySelector('#nt-aa').checked,
      updates: v.querySelector('#nt-upd').checked,
      followUps: v.querySelector('#nt-fu').checked,
    } }),
  };
  v.querySelectorAll('[data-save-section]').forEach((btn) => btn.addEventListener('click', async () => {
    const name = btn.dataset.saveSection;
    try {
      await api('/settings', { method: 'PATCH', body: sections[name]() });
      state.settings = null;
      toast(`${name[0].toUpperCase() + name.slice(1)} settings saved`);
      if ((name === 'app' || name === 'gmail') && window.jatDesktop) window.jatDesktop.settingsChanged();
      if (name === 'ai') navigate();   // the AI section body swaps between full UI and the off message
    } catch (e) { errToast(e); }
  }));

  // AI tests
  v.querySelectorAll('[data-test]').forEach((btn) => btn.addEventListener('click', async () => {
    const prov = btn.dataset.test;
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = 'Testing…';
    try {
      const r = await api('/ai/generate', {
        method: 'POST', timeoutMs: 180000,
        body: { prompt: 'Reply with exactly: OK', kind: 'test', provider: prov },
      });
      toast(`${prov}: "${(r.text || '').slice(0, 40)}" (${r.model || ''})`);
    } catch (e) { errToast(e, prov + ' test failed'); }
    btn.disabled = false; btn.textContent = orig;
  }));

  // AI provider priority reorder (↑ ↓)
  const renumberAi = () => v.querySelectorAll('#ai-order-list .ai-rank .ai-rank-n').forEach((n, i) => { n.textContent = i + 1; });
  v.querySelectorAll('#ai-order-list .ai-rank').forEach((rank) => {
    rank.querySelector('[data-up]')?.addEventListener('click', () => { const p = rank.previousElementSibling; if (p) { rank.parentNode.insertBefore(rank, p); renumberAi(); } });
    rank.querySelector('[data-down]')?.addEventListener('click', () => { const n = rank.nextElementSibling; if (n) { rank.parentNode.insertBefore(n, rank); renumberAi(); } });
  });

  // Connect ChatGPT subscription (Codex) + re-check
  v.querySelector('[data-connect-codex]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    try {
      const r = await api('/ai/connect/codex', { method: 'POST', body: {} });
      toast(r.ok ? (r.message || 'Sign-in started — finish it in your browser, then Re-check.') : (r.error || 'Could not start sign-in'), r.ok ? 'info' : 'danger', { ttl: 8000 });
    } catch (err) { errToast(err); }
    btn.disabled = false;
  });
  v.querySelector('[data-recheck]')?.addEventListener('click', () => { state.settings = null; navigate(); });

  // Set up local AI (download Ollama + models) with a live progress bar
  // Local-AI master: reveal/hide the card body immediately (saving still requires Save)
  v.querySelector('#ai-local-enabled')?.addEventListener('change', (e) => {
    const body = v.querySelector('#ai-local-body');
    if (body) body.hidden = !e.target.checked;
  });
  v.querySelector('[data-setup-local]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    const bar = v.querySelector('#setup-bar'); bar.hidden = false;
    const fill = bar.querySelector('.setup-fill'); const msg = bar.querySelector('.setup-msg');
    msg.textContent = 'Starting…';
    try {
      await api('/ai/local/setup', { method: 'POST', body: {} });
      const poll = setInterval(async () => {
        let st; try { st = (await api('/ai/local/state')).state; } catch { return; }
        fill.style.width = (st.progress || 0) + '%';
        msg.textContent = st.message || st.step || '';
        if (st.step === 'ready' || st.step === 'error') {
          clearInterval(poll); btn.disabled = false;
          if (st.step === 'ready') toast('Local AI is ready ✓'); else toast(st.error || 'Local setup failed', 'danger');
        }
      }, 1500);
    } catch (err) { errToast(err); btn.disabled = false; }
  });

  // ---- Email integration (multi-provider IMAP) ----
  const emProvider = v.querySelector('#em-provider');
  const renderEmSteps = () => {
    const p = emailPresets[emProvider.value] || {};
    const steps = v.querySelector('#em-steps');
    if (steps) steps.innerHTML = (p.steps || []).map((st) =>
      `<li>${esc(st.t)}${st.url ? ` <a class="link" href="${esc(st.url)}" target="_blank" rel="noopener">open ↗</a>` : ''}</li>`).join('')
      + (p.appPwUrl ? `<li><button class="btn small" type="button" data-open="${esc(p.appPwUrl)}">Open the App Password page ↗</button></li>` : '');
    const imapRow = v.querySelector('#em-imaprow'); if (imapRow) imapRow.hidden = emProvider.value !== 'imap';
    const host = v.querySelector('#em-host'); if (host && emProvider.value !== 'imap') host.value = p.host || '';
  };
  if (emProvider) { emProvider.addEventListener('change', renderEmSteps); renderEmSteps(); }
  v.querySelector('#email-add')?.addEventListener('click', (e) => {   // delegate the "open link" buttons
    const o = e.target.closest('[data-open]'); if (o) { e.preventDefault(); window.open(o.dataset.open, '_blank', 'noopener'); }
  });
  const emBody = () => ({
    provider: emProvider?.value || 'gmail',
    email: (v.querySelector('#em-email')?.value || '').trim(),
    password: (v.querySelector('#em-pass')?.value || '').trim(),
    host: (v.querySelector('#em-host')?.value || '').trim() || undefined,
    port: Number(v.querySelector('#em-port')?.value) || undefined,
  });
  v.querySelector('[data-email-test]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget; const out = v.querySelector('#em-result');
    const body = emBody();
    if (!body.email || !body.password) { out.textContent = 'Enter your email + App Password first.'; return; }
    btn.disabled = true; out.textContent = 'Connecting…';
    try {
      const r = await api('/email/accounts/test', { method: 'POST', body, timeoutMs: 30000 });
      out.textContent = r.ok ? `✓ Connected — ${r.total ?? 0} messages in your inbox` : `✗ ${r.error || 'failed'}`;
      out.style.color = r.ok ? 'var(--success)' : 'var(--danger)';
    } catch (err) { out.textContent = '✗ ' + (err.message || err); out.style.color = 'var(--danger)'; }
    btn.disabled = false;
  });
  v.querySelector('[data-email-add]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget; const out = v.querySelector('#em-result');
    const body = emBody();
    if (!body.email || !body.password) { out.textContent = 'Enter your email + App Password first.'; return; }
    btn.disabled = true; out.textContent = 'Verifying…';
    try {
      const t = await api('/email/accounts/test', { method: 'POST', body, timeoutMs: 30000 });   // verify before saving
      if (!t.ok) { out.textContent = '✗ ' + (t.error || 'connection failed — not saved'); out.style.color = 'var(--danger)'; btn.disabled = false; return; }
      await api('/email/accounts', { method: 'POST', body });
      toast('Email connected ✓ — syncing will start in the background');
      api('/email/sync', { method: 'POST', body: {}, timeoutMs: 120000 }).catch(() => {});   // kick an initial sync
      navigate();
    } catch (err) { errToast(err); btn.disabled = false; }
  });
  v.querySelectorAll('[data-email-remove]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmModal('Disconnect this email account? Synced emails stay, but it stops updating.', { danger: true, okLabel: 'Disconnect' }))) return;
    try { await api('/email/accounts/' + encodeURIComponent(b.dataset.emailRemove), { method: 'DELETE' }); toast('Email disconnected'); navigate(); } catch (e) { errToast(e); }
  }));
  v.querySelector('[data-email-syncnow]')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true; const old = btn.textContent; btn.textContent = 'Syncing…';
    try {
      const r = await api('/email/sync', { method: 'POST', body: {}, timeoutMs: 180000 });
      if (!r.ok) toast('Sync: ' + (r.error || 'failed'), 'danger');
      else { const tot = (r.results || []).reduce((a, x) => ({ f: a.f + (x.fetched || 0), m: a.m + (x.matched || 0) }), { f: 0, m: 0 }); const err = (r.results || []).find((x) => x.error); toast(err ? ('Sync issue: ' + err.error) : `Synced ${tot.f} new · ${tot.m} matched`, err ? 'danger' : 'info', { ttl: 9000 }); navigate(); }
    } catch (err) { errToast(err); }
    btn.disabled = false; btn.textContent = old;
  });

  // Gmail actions
  v.querySelector('[data-gmail-connect]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const st = v.querySelector('#gm-status');
    btn.disabled = true;
    st.textContent = 'A browser window will open — approve access, then come back…';
    try {
      const r = await api('/gmail/auth-url', { method: 'POST', timeoutMs: 320000 });
      st.textContent = r.ok ? 'Connected ✓' : (r.error || 'failed');
      if (r.ok) toast('Gmail connected ✓');
    } catch (err) { st.textContent = err.message; }
    btn.disabled = false;
  });
  v.querySelector('[data-gmail-sync]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const st = v.querySelector('#gm-status');
    btn.disabled = true;
    st.textContent = 'Syncing…';
    try {
      const r = await api('/gmail/sync', { method: 'POST', timeoutMs: 180000 });
      st.textContent = r.ok === false ? (r.error || 'failed')
        : `scanned ${r.scanned ?? 0} · matched ${r.matched ?? 0} · updated ${r.updated ?? 0}`;
    } catch (err) { st.textContent = err.message; }
    btn.disabled = false;
  });

  // theme swatches
  v.querySelectorAll('[data-theme-id]').forEach((sw) => sw.addEventListener('click', () => {
    setTheme(sw.dataset.themeId);
    v.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('active', x === sw));
  }));

  // data section
  v.querySelector('[data-backup]').addEventListener('click', async () => {
    try {
      const r = await api('/backup', { method: 'POST', timeoutMs: 30000 });
      toast(r.path ? 'Backed up → ' + r.path : 'Backup done');
    } catch (e) { errToast(e); }
  });
  v.querySelector('[data-export]').addEventListener('click', async () => {
    try {
      const r = await api('/export', { timeoutMs: 60000 });
      downloadBlob(new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' }),
        `jat-export-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (e) { errToast(e); }
  });
  v.querySelector('[data-import-data]').addEventListener('click', () => v.querySelector('#import-file').click());
  v.querySelector('[data-wipe]')?.addEventListener('click', async () => {
    const typed = await promptModal('This permanently deletes ALL your applications, emails, profile, documents, and learned answers, and disconnects any linked email/Gmail accounts. It cannot be undone. Type DELETE to confirm.',
      { title: 'Delete all my data', okLabel: 'Delete everything', placeholder: 'DELETE' });
    if (typed === null) return;
    if (String(typed).trim() !== 'DELETE') { toast('Not deleted — type DELETE exactly to confirm.', 'warn'); return; }
    try {
      const r = await api('/wipe', { method: 'POST', body: { confirm: true }, timeoutMs: 60000 });
      const total = Object.values(r.deleted || {}).reduce((a, b) => a + Number(b || 0), 0);
      state.settings = null;
      toast(`Deleted everything (${total} records) and disconnected accounts.`, 'success');
      navigate();
    } catch (e) { errToast(e, 'Wipe failed'); }
  });
  v.querySelector('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const r = await api('/import', { method: 'POST', body: { data }, timeoutMs: 120000 });
      toast(`Imported ${r.jobs} jobs, ${r.events} events, ${r.qa} answers`);
      navigate();
    } catch (err) { errToast(err, 'Import failed'); }
  });
  const logsBtn = v.querySelector('[data-logs]');
  if (logsBtn) logsBtn.addEventListener('click', () => window.jatDesktop.openLogs());

  return v;
});

// ============================================================
// Boot
// ============================================================
async function boot(reauth = false) {
  // Instant theme from cache (settings refine it later)
  try { applyTheme(localStorage.getItem(LS_THEME) || DEFAULT_THEME); } catch {}

  if (!state.host || state.host === 'web' || reauth) {
    // WEB host: a plain browser tab against the loopback server, token in the URL — the same
    // convention the /stream EventSource route already accepts. Support/debug surface (e.g.
    // helping Dad remotely): http://127.0.0.1:7744/app/?token=<token>#/settings
    const urlTok = (() => { try { return new URLSearchParams(location.search).get('token'); } catch { return null; } })();
    const inExtension = typeof chrome !== 'undefined' && chrome.runtime?.id;
    if (urlTok && !inExtension && !window.jatDesktop) {
      state.host = 'web';
      state.token = urlTok;
      state.base = location.origin;   // same-origin (localhost vs 127.0.0.1 differ — CORS otherwise)
    } else if (inExtension) {
      state.host = 'extension';
      try {
        const r = await new Promise((res) => chrome.runtime.sendMessage({ type: 'get-token' }, (x) => {
          void chrome.runtime.lastError; res(x);
        }));
        state.token = r?.token || null;
        state.version = chrome.runtime.getManifest().version;
      } catch {}
    } else if (window.jatDesktop) {
      state.host = 'desktop';
      try {
        const b = await window.jatDesktop.boot();
        state.token = b?.token || null;
        state.version = b?.version || '';
        if (b?.port) state.base = `http://localhost:${b.port}`;
      } catch {}
    }
  }
  const bv = $('#brand-version');
  if (bv && state.version) bv.textContent = 'v' + state.version;

  if (state.token) {
    connectSSE();
    getSettings(true).then((s) => {
      const t = s.appearance?.theme;
      if (t) { applyTheme(t); try { localStorage.setItem(LS_THEME, t); } catch {} }
    }).catch(() => {});
  }

  // Desktop host: reflect any pending update + a pairing request that may have
  // arrived before this window finished loading (both also arrive live over SSE).
  if (window.jatDesktop) {
    if (window.jatDesktop.updateState) window.jatDesktop.updateState().then((u) => { state.update = u; renderUpdateBanner(); }).catch(() => {});
    if (window.jatDesktop.onPairingRequest) window.jatDesktop.onPairingRequest((p) => showPairingModal(p));
    if (window.jatDesktop.pendingPair) window.jatDesktop.pendingPair().then((p) => { if (p) showPairingModal(p); }).catch(() => {});
  }

  paintRuntime();
  navigate();
}

// Live "running for" timer: one global ticker reads the start time off #aa-timer's
// data-start (kept current by the morph refresh) and updates the text every second.
// Reading the live DOM each tick keeps it morph-safe and avoids stacking intervals.
function fmtElapsed(ms) {
  if (!(ms >= 0)) return '';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
setInterval(() => {
  const el = document.getElementById('aa-timer');
  if (!el) return;
  const start = el.dataset.start;
  el.textContent = start ? fmtElapsed(Date.now() - Date.parse(start)) : '';
}, 1000);

// Ask the extension SW to close the auto-apply tab group (extension host only; the
// desktop app has no `chrome`, where the SW's alarm tidies up on the next tick).
function stopAutoApplyTabs() {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'stop-autoapply' }, () => void chrome.runtime.lastError);
    }
  } catch {}
}

// global listeners (registered once)
window.addEventListener('hashchange', navigate);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (e.key === 'Escape') { if (closeTopOverlay()) e.preventDefault(); return; }
  if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return;
    const q = $('#f-q');
    if (q) { e.preventDefault(); q.focus(); }
  }
});
setInterval(paintRuntime, 30000);
if (!location.hash) location.hash = '#/';
boot();
