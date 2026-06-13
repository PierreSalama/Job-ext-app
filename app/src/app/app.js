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
const PIPELINE_ACTIVE = ['submitted', 'contacted', 'interview_1', 'interview_2', 'interview_final', 'offer'];

const QUEUE_STATE_ORDER = ['running', 'awaiting_review', 'awaiting_input', 'queued', 'scheduled', 'done', 'failed', 'skipped'];
const QUEUE_STATE_LABEL = {
  running: 'Running', awaiting_review: 'Awaiting review', awaiting_input: 'Awaiting input',
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
    const def = { q: '', status: 'all', source: 'all', sort: 'updatedAt', dir: 'desc' };
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
    const { status, source, sort, dir } = state.apps;
    localStorage.setItem(LS_FILTERS, JSON.stringify({ status, source, sort, dir }));
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
async function navigate() {
  const path = (location.hash.replace(/^#/, '') || '/').replace(/\/+$/, '') || '/';
  state.route = { path };
  state.selection = new Set();
  hideRefreshPill();
  closeAllOverlays();
  document.querySelectorAll('.nav-item').forEach((n) => {
    const r = n.dataset.route;
    n.classList.toggle('active', r === path || (r !== '/' && path.startsWith(r + '/')));
  });
  if (!state.token) { renderNotConnected(); return; }
  const seq = ++navSeq;
  const match = resolve(path) || resolve('/');
  const main = $('#main');
  const loadT = setTimeout(() => {
    if (seq === navSeq) main.innerHTML = skeletonHtml();
  }, 130);
  try {
    const node = await match.render(match.params);
    clearTimeout(loadT);
    if (seq !== navSeq) return;
    main.replaceChildren(node);
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
function showRefreshPill() { const p = $('#refresh-pill'); if (p) p.hidden = false; }
function hideRefreshPill() { const p = $('#refresh-pill'); if (p) p.hidden = true; }

function canAutoRefresh() {
  if (!LIST_ROUTES.has(state.route.path)) return false;
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return false;
  if (document.querySelector('#overlay-root .overlay')) return false;
  return true;
}

const softRefresh = debounce(() => {
  if (canAutoRefresh()) { hideRefreshPill(); navigate(); }
  else showRefreshPill();
}, 350);

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
  for (const ev of ['jobs.updated', 'queue.updated', 'documents.updated', 'profileFields.updated']) {
    es.addEventListener(ev, () => softRefresh());
  }
  es.addEventListener('settings.updated', async () => {
    try {
      const s = await getSettings(true);
      if (s.appearance?.theme) { applyTheme(s.appearance.theme); try { localStorage.setItem(LS_THEME, s.appearance.theme); } catch {} }
    } catch {}
    softRefresh();
  });
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
  const [statsR, jobsR, queueR, aiR, gmailR] = await Promise.all([
    api('/stats'),
    api('/jobs?limit=8'),
    api('/queue').catch(() => ({ items: [] })),
    api('/ai/status').catch(() => null),
    api('/gmail/status').catch(() => null),
  ]);
  const stats = statsR;
  const jobs = jobsR.items || [];
  const tasks = queueR.items || [];
  const byStatus = stats.byStatus || {};
  const inPipeline = PIPELINE_ACTIVE.reduce((s, id) => s + (byStatus[id] || 0), 0);
  const qCounts = {};
  for (const t of tasks) qCounts[t.state] = (qCounts[t.state] || 0) + 1;

  const aiChip = (label, st) => {
    if (!st) return '';
    const ok = !!st.available;
    return `<span class="sys-chip ${ok ? 'ok' : 'bad'}" title="${esc(st.reason || '')}">${esc(label)} ${ok ? '●' : '○'}</span>`;
  };
  const sysBits = [];
  if (aiR) {
    sysBits.push(aiChip('Codex', aiR.codex));
    sysBits.push(aiChip('Ollama', aiR.ollama));
  }
  if (gmailR?.enabled) {
    const lr = gmailR.lastResult;
    sysBits.push(`<span class="sys-chip">Gmail · ${lr?.at ? 'synced ' + fmtRel(lr.at) : (gmailR.authorized ? 'connected' : 'not connected')}</span>`);
  }
  const awaiting = (qCounts.awaiting_review || 0) + (qCounts.awaiting_input || 0);
  if (tasks.length) {
    sysBits.push(`<span class="sys-chip ${awaiting ? 'warn' : ''}">Auto-apply · ${qCounts.queued || 0} queued${awaiting ? ` · ${awaiting} need you` : ''}</span>`);
  }

  const pills = STATUSES.map((s) =>
    `<button class="pill" data-status="${s.id}" type="button"><span class="dot"></span>${esc(s.label)}<span class="count">${byStatus[s.id] || 0}</span></button>`).join('');

  const recent = jobs.length ? jobs.map((j) => `
    <tr data-id="${esc(j.id)}" class="row-link">
      <td class="title-cell">${esc(j.title || 'Untitled')}${j.needsReview ? ' <span class="muted" title="Needs review">⚠</span>' : ''}</td>
      <td>${esc(j.company || '')}</td>
      <td>${statusChip(j.status)}</td>
      <td>${fitBadgeHtml(j.fitScore)}</td>
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

    <section class="stats">
      <div class="stat"><div class="stat-label">Applications</div><div class="stat-value">${stats.total || 0}</div><div class="stat-delta">All time</div></div>
      <div class="stat"><div class="stat-label">This week</div><div class="stat-value">${stats.thisWeek || 0}</div><div class="stat-delta">Captured</div></div>
      <div class="stat"><div class="stat-label">In pipeline</div><div class="stat-value">${inPipeline}</div><div class="stat-delta">Submitted → offer</div></div>
      <div class="stat" data-go-review style="cursor:pointer"><div class="stat-label">Needs review</div><div class="stat-value ${stats.needsReview ? 'warn' : ''}">${stats.needsReview || 0}</div><div class="stat-delta">Sparse captures</div></div>
    </section>

    <section class="section">
      <header class="section-header">
        <div><div class="section-eyebrow">Status</div><h2 class="section-title">Pipeline</h2></div>
        <a href="#/pipeline" class="section-link">Board view</a>
      </header>
      <div class="pipeline">${pills}</div>
    </section>

    <section class="section">
      <header class="section-header">
        <div><div class="section-eyebrow">Recent</div><h2 class="section-title">Latest applications</h2></div>
        <a href="#/applications" class="section-link">All applications</a>
      </header>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Title</th><th>Company</th><th>Status</th><th></th><th>Source</th><th>Updated</th></tr></thead>
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
  const r = await api(q);
  let rows = r.items || [];

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
      <td>${fitBadgeHtml(j.fitScore)}</td>
      <td>${esc(j.source || '—')}</td>
      <td>${dateHtml(j.createdAt)}</td>
      <td>${relHtml(j.updatedAt)}</td>
    </tr>`).join('')
    : `<tr><td colspan="8">${emptyHtml(
      f.q || f.status !== 'all' || f.source !== 'all' ? 'No matches' : 'No entries',
      f.q || f.status !== 'all' || f.source !== 'all' ? 'Nothing matches the current filter' : 'The ledger is empty',
      'Adjust the filters, or hit Apply on a job and JAT will record it.')}</td></tr>`;

  const v = el(`<div>
    <header class="page-header">
      <div>
        <div class="page-eyebrow">Ledger</div>
        <h1 class="page-title">Applications</h1>
        <div class="page-sub">${rows.length} shown</div>
      </div>
      <div class="page-actions">
        <button class="btn" data-csv>Export CSV</button>
        <a href="#/applications/new" class="btn primary">+ New application</a>
      </div>
    </header>

    <div class="toolbar">
      <input class="input" id="f-q" type="search" placeholder="Search title, company, notes… ( / )" value="${esc(f.q)}" style="max-width:280px" />
      <select class="select" id="f-status">
        <option value="all" ${f.status === 'all' ? 'selected' : ''}>All statuses</option>
        <option value="needs_review" ${f.status === 'needs_review' ? 'selected' : ''}>Needs review ⚠</option>
        ${STATUSES.map((s) => `<option value="${s.id}" ${f.status === s.id ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
      </select>
      <select class="select" id="f-source">
        <option value="all">All sources</option>
        ${allSources.map((s) => `<option value="${esc(s)}" ${f.source === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
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
          ${th('title', 'Title')}${th('company', 'Company')}${th('status', 'Status')}${th('fitScore', 'Fit')}${th('source', 'Source')}${th('createdAt', 'Applied')}${th('updatedAt', 'Updated')}
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

  v.querySelector('[data-csv]').addEventListener('click', () => {
    const cols = ['title', 'company', 'status', 'source', 'location', 'compensation', 'jobUrl', 'fitScore', 'createdAt', 'submittedAt', 'updatedAt', 'notes'];
    const csv = [cols.join(',')].concat(rows.map((j) =>
      cols.map((c) => `"${String(j[c] ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`).join(','))).join('\n');
    downloadBlob(new Blob([csv], { type: 'text/csv' }), `jat-applications-${new Date().toISOString().slice(0, 10)}.csv`);
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
  const j = job || {};

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
        <div class="page-sub">${isNew ? 'Capture the essentials.' : esc(j.company || '') + (j.location ? ' · ' + esc(j.location) : '')}</div>
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

  return v;
});

// ============================================================
// VIEW: Pipeline kanban (#/pipeline)
// ============================================================
route('/pipeline', async () => {
  const r = await api('/jobs?limit=500');
  const jobs = r.items || [];
  const b = state.board;

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

  const GROUPS = { started: 'Pre', submitted: 'Active', contacted: 'Active', interview_1: 'Interviews', interview_2: 'Interviews', interview_final: 'Interviews', offer: 'Closing', hired: 'Closing', rejected: 'Closed', withdrawn: 'Closed', ghosted: 'Closed' };
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

  v.querySelectorAll('.kb-card').forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('click', () => { location.hash = '#/applications/' + card.dataset.id; });
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
  const [settings, queueR] = await Promise.all([getSettings(true), api('/queue')]);
  const aa = settings.autoApply;
  const tasks = queueR.items || [];
  const groups = new Map(QUEUE_STATE_ORDER.map((s) => [s, []]));
  for (const t of tasks) (groups.get(t.state) || groups.set(t.state, []).get(t.state)).push(t);

  const qc = (label, html) => `<div class="qc-field"><span class="qc-label form-label">${esc(label)}</span>${html}</div>`;

  const taskCard = (t) => `
    <div class="task-card" data-task="${esc(t.id)}">
      <div class="task-head">
        <span class="task-title">${esc(t.job?.title || '?')} <span class="muted">· ${esc(t.job?.company || '')}</span></span>
        <span class="state-chip" data-state="${esc(t.state)}">${esc(QUEUE_STATE_LABEL[t.state] || t.state)}</span>
      </div>
      <div class="task-sub">${esc(t.mode)} mode · ${esc(t.attempts)} attempt${t.attempts === 1 ? '' : 's'} · updated ${esc(fmtRel(t.updatedAt))}</div>
      ${t.lastError ? `<div class="task-err">${esc(t.lastError)}</div>` : ''}
      <div class="task-actions">
        ${['failed', 'skipped', 'awaiting_input'].includes(t.state) ? '<button class="btn small" data-act="retry">Retry</button>' : ''}
        ${['queued', 'scheduled', 'running'].includes(t.state) ? '<button class="btn small" data-act="cancel">Cancel</button>' : ''}
        ${t.transcript?.length ? '<button class="btn small" data-act="transcript">Transcript</button>' : ''}
        ${t.job?.jobUrl ? `<a class="btn small" href="${esc(t.job.jobUrl)}" target="_blank" rel="noopener">Open job</a>` : ''}
        <button class="btn small" data-act="delete">Remove</button>
      </div>
      <div class="transcript" hidden><div class="transcript-entries">
        ${(t.transcript || []).map((e2) => `<div class="tr-line"><span class="tr-ts">${esc((e2.ts || '').slice(11, 19))}</span><span class="tr-body ${esc(e2.level || '')}">${esc(e2.text || e2.note || JSON.stringify(e2))}</span></div>`).join('')}
      </div></div>
    </div>`;

  const groupsHtml = [...groups.entries()]
    .filter(([, list]) => list.length)
    .map(([s, list]) => `<div class="queue-group-head"><span>${esc(QUEUE_STATE_LABEL[s] || s)}</span><span class="n">${list.length}</span></div>${list.map(taskCard).join('')}`)
    .join('') || emptyHtml('Idle', 'Nothing queued', 'Queue a job from its detail page, or select rows in Applications.');

  const v = el(`<div>
    <header class="page-header">
      <div>
        <div class="page-eyebrow">Automate</div>
        <h1 class="page-title">Auto-apply</h1>
        <div class="page-sub">Paced, review-first, always stoppable.</div>
      </div>
      <div class="page-actions">
        <button class="btn" data-stop-all>⏹ Stop everything</button>
        <button class="btn primary" data-save>Save settings</button>
      </div>
    </header>

    <section class="section">
      <header class="section-header"><div><div class="section-eyebrow">Engine</div><h2 class="section-title">Pacing</h2></div></header>
      <div class="queue-controls section-body" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:16px">
        ${qc('Master switch', `<label class="toggle"><input type="checkbox" id="aa-enabled" ${aa.enabled ? 'checked' : ''} /><span class="knob"></span></label>`)}
        ${qc('Mode', `<select class="select" id="aa-mode">
          <option value="review" ${aa.mode === 'review' ? 'selected' : ''}>Review — stop before submit</option>
          <option value="auto" ${aa.mode === 'auto' ? 'selected' : ''}>Auto — submit for me</option>
        </select>`)}
        ${qc('Max / day', `<input class="input" id="aa-day" type="number" min="1" max="50" value="${aa.maxPerDay}" />`)}
        ${qc('Max / hour', `<input class="input" id="aa-hour" type="number" min="1" max="10" value="${aa.maxPerHour}" />`)}
        ${qc('Gap min (min)', `<input class="input" id="aa-gmin" type="number" min="1" max="180" value="${aa.minGapMinutes}" />`)}
        ${qc('Gap max (min)', `<input class="input" id="aa-gmax" type="number" min="1" max="360" value="${aa.maxGapMinutes}" />`)}
        ${qc('Window start', `<input class="input" id="aa-ws" type="time" value="${esc(aa.windowStart)}" />`)}
        ${qc('Window end', `<input class="input" id="aa-we" type="time" value="${esc(aa.windowEnd)}" />`)}
      </div>
      <div class="section-footer muted">The extension checks for due tasks about once a minute while Chrome is open. Review mode fills everything and waits for you at the final submit.</div>
    </section>

    <section class="section">
      <header class="section-header"><div><div class="section-eyebrow">Queue</div><h2 class="section-title">Tasks</h2></div></header>
      ${groupsHtml}
    </section>
  </div>`);

  v.querySelector('[data-save]').addEventListener('click', async () => {
    try {
      await api('/settings', {
        method: 'PATCH',
        body: { autoApply: {
          enabled: v.querySelector('#aa-enabled').checked,
          mode: v.querySelector('#aa-mode').value,
          maxPerDay: Number(v.querySelector('#aa-day').value) || 5,
          maxPerHour: Number(v.querySelector('#aa-hour').value) || 2,
          minGapMinutes: Number(v.querySelector('#aa-gmin').value) || 8,
          maxGapMinutes: Number(v.querySelector('#aa-gmax').value) || 25,
          windowStart: v.querySelector('#aa-ws').value || '10:00',
          windowEnd: v.querySelector('#aa-we').value || '18:00',
        } },
      });
      state.settings = null;
      toast('Auto-apply settings saved');
    } catch (e) { errToast(e); }
  });

  v.querySelector('[data-stop-all]').addEventListener('click', async () => {
    try {
      await api('/settings', { method: 'PATCH', body: { autoApply: { enabled: false } } });
      for (const t of tasks) {
        if (['queued', 'scheduled', 'running'].includes(t.state)) {
          await api('/queue/' + encodeURIComponent(t.id), { method: 'PATCH', body: { state: 'skipped', transcriptAppend: { note: 'stop-all from dashboard' } } });
        }
      }
      state.settings = null;
      toast('Auto-apply stopped — master switch off');
      navigate();
    } catch (e) { errToast(e); }
  });

  v.querySelectorAll('.task-card').forEach((card) => {
    const taskId = card.dataset.task;
    card.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', async () => {
      const act = btn.dataset.act;
      try {
        if (act === 'transcript') {
          const t2 = card.querySelector('.transcript');
          t2.hidden = !t2.hidden;
          return;
        }
        if (act === 'retry') await api('/queue/' + encodeURIComponent(taskId), { method: 'PATCH', body: { state: 'queued', lastError: null } });
        if (act === 'cancel') await api('/queue/' + encodeURIComponent(taskId), { method: 'PATCH', body: { state: 'skipped' } });
        if (act === 'delete') await api('/queue/' + encodeURIComponent(taskId), { method: 'DELETE' });
        navigate();
      } catch (e) { errToast(e); }
    }));
  });

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
const FIELD_GROUPS = [
  { title: 'Identity', keys: ['firstName', 'lastName', 'fullName', 'preferredName', 'pronouns'] },
  { title: 'Contact & location', keys: ['email', 'phone', 'address1', 'address2', 'city', 'state', 'postalCode', 'country'] },
  { title: 'Links', keys: ['linkedinUrl', 'githubUrl', 'portfolioUrl'] },
  { title: 'Work eligibility', keys: ['workAuthorization', 'sponsorshipRequired', 'citizenship', 'securityClearance'] },
  { title: 'Compensation & experience', keys: ['salaryExpectation', 'yearsExperience', 'noticePeriod'] },
  { title: 'Education', keys: ['highestDegree', 'university', 'major', 'graduationYear', 'headline'] },
];

route('/profile', async () => {
  const [profilesR, fieldsR, settings] = await Promise.all([
    api('/profiles'),
    api('/profile-fields').catch(() => ({ items: [] })),
    getSettings(),
  ]);
  const profiles = profilesR.items || [];
  const harvested = fieldsR.items || [];
  const af = settings.autofill || {};

  if (!state.profileSel || !profiles.find((p) => p.id === state.profileSel)) {
    state.profileSel = profiles[0]?.id || 'new';
  }
  const cur = profiles.find((p) => p.id === state.profileSel) || { name: 'Main', isDefault: !profiles.length, sourceAssignments: [], data: {} };
  const d = cur.data || {};

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
        </section>

        <section class="section">
          <header class="section-header"><div><div class="section-eyebrow">Memory</div><h2 class="section-title">Learned answers</h2>
            <div class="form-hint">Auto-captured from your applications (EN + FR). Edit a value to override + lock it; otherwise the newest answer wins.</div></div>
            <div class="nowrap"><button class="btn small" data-backfill title="Harvest answers from every past application">Build from past applications</button> <span class="section-link muted">${harvested.length} stored</span></div></header>
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
  v.querySelector('[data-addfield]').addEventListener('click', () => {
    const name = window.prompt('Field name (e.g. “Years of AutoCAD”, “Preferred shift”):');
    if (!name || !name.trim()) return;
    const key = (name.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60)) || ('field_' + Date.now());
    if (v.querySelector('[data-key="' + key + '"]')) { toast('That field already exists', 'danger'); return; }
    const card = el(fieldCard(key, name.trim(), true));
    wireRemove(card.querySelector('[data-rmfield]'));
    v.querySelector('#pf-custom').appendChild(card);
    card.querySelector('input').focus();
  });

  // Build the profile from every past application's answers.
  v.querySelector('[data-backfill]').addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Building…';
    try {
      const r = await api('/profile-fields/backfill', { method: 'POST', timeoutMs: 120000 });
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
      tr.querySelector('[data-star]')?.addEventListener('click', async () => {
        try { await api('/documents/' + encodeURIComponent(docId), { method: 'PATCH', body: { isDefault: true } }); toast(`Set as active ${DOC_ROLE_LABEL[doc.role] || doc.role}`); navigate(); }
        catch (e) { errToast(e); }
      });
      tr.querySelector('[data-role-sel]')?.addEventListener('change', async (e) => {
        try { await api('/documents/' + encodeURIComponent(docId), { method: 'PATCH', body: { role: e.target.value } }); toast('Role updated'); navigate(); }
        catch (err) { errToast(err); }
      });
      tr.querySelector('[data-label]')?.addEventListener('click', async () => {
        const val = window.prompt('Designation for this document (e.g. “Master CV”, “Short résumé”):', doc.label || '');
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
        if (!window.confirm(msg)) return;
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
      if (!window.confirm('Unlink this folder? Its indexed entries leave the library (your actual files are untouched).')) return;
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
  const [settings, aiSt, gmailSt, hw] = await Promise.all([
    getSettings(true),
    api('/ai/status').catch(() => null),
    api('/gmail/status').catch(() => null),
    api('/hardware').catch(() => null),
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
        ${row('API key', `<input class="input" id="ai-claude-key" type="password" placeholder="sk-ant-…" value="${esc(claude.apiKey || '')}" />`, 'from console.anthropic.com — Claude can only run via an API key (subscriptions are blocked outside Claude Code)')}
        ${row('Model', `<input class="input" id="ai-claude-model" value="${esc(claude.model || 'claude-sonnet-4-6')}" />`)}
        <div class="section-body"><button class="btn small" data-test="claude">Test Claude</button></div>
      </div>

      <div class="ai-prov">
        <div class="ai-prov-head">ChatGPT (OpenAI) ${aiDot(aiSt?.chatgpt)}</div>
        ${row('Use my ChatGPT subscription', toggle('ai-cg-sub', chatgpt.useSubscription !== false), 'via the official Codex CLI (personal use)')}
        <div class="form-row"><div class="form-label">Subscription</div><div class="form-control">${aiDot(aiSt?.chatgpt?.subscription)}
          <button class="btn small" data-connect-codex>Connect / sign in</button> <button class="btn small" data-recheck>Re-check</button></div></div>
        ${row('OpenAI API key', `<input class="input" id="ai-oai-key" type="password" placeholder="sk-…" value="${esc(chatgpt.apiKey || '')}" />`, 'alternative to the subscription')}
        ${row('Model', `<input class="input" id="ai-cg-model" value="${esc(chatgpt.model || 'gpt-5.4')}" />`)}
        <div class="section-body"><button class="btn small" data-test="chatgpt">Test ChatGPT</button></div>
      </div>

      <div class="ai-prov">
        <div class="ai-prov-head">Local (Ollama) ${aiDot(aiSt?.local)}</div>
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

    <section class="section">
      <header class="section-header"><div><div class="section-eyebrow">Mail</div><h2 class="section-title">Gmail status sync</h2></div>
        <button class="btn small primary" data-save-section="gmail">Save</button></header>
      <div class="section-body">
        <span class="sys-chip ${gmailSt?.authorized ? 'ok' : ''}">${gmailSt?.authorized ? '● connected' : '○ not connected'}</span>
        ${gmailSt?.lastResult?.at ? `<span class="muted" style="font-size:12px;margin-left:8px">last sync ${esc(fmtRel(gmailSt.lastResult.at))} · ${esc(gmailSt.lastResult.updated ?? 0)} updated</span>` : ''}
      </div>
      ${row('Enabled', toggle('gm-enabled', s.gmail.enabled))}
      ${row('Search query', `<input class="input" id="gm-query" value="${esc(s.gmail.query)}" />`, 'Gmail search syntax')}
      ${row('Interval (minutes)', `<input class="input" id="gm-interval" type="number" min="5" value="${esc(s.gmail.intervalMinutes)}" />`)}
      ${row('OAuth Client ID', `<input class="input" id="gm-cid" value="${esc(s.gmail.clientId)}" />`, 'Google Cloud Console → OAuth desktop app')}
      ${row('OAuth Client Secret', `<input class="input" id="gm-secret" type="password" value="${esc(s.gmail.clientSecret)}" />`)}
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
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
          <button class="btn small" data-check-updates>Check for updates</button>
          <button class="btn small" data-restart-update hidden>Restart to apply update</button>
          <button class="btn small" data-releases>Releases &amp; downloads</button>
        </div>
        <div class="status-line" id="upd-status" style="margin-top:8px"></div>
        <div class="section-footer muted">${state.host === 'desktop'
          ? 'The app checks automatically on launch and every 4 hours, downloads in the background, and prompts you to restart.'
          : 'The desktop app self-updates; you can also re-download the installer from the toolbar popup or the releases page.'}</div>
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
      <div class="section-footer muted">Daily backups rotate automatically in the app's data folder.</div>
    </section>
  </div>`);

  // updates
  const updStatus = (msg, cls = '') => { const el = v.querySelector('#upd-status'); el.className = 'status-line ' + cls; el.textContent = msg; };
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
        } else if (r.status === 'dev') updStatus('Dev build — updates only run in the installed app.');
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
    ai: () => ({ ai: {
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
        url: v.querySelector('#ai-local-url').value.trim() || 'http://localhost:11434',
        autoPick: v.querySelector('#ai-local-autopick').checked,
        autoSetup: v.querySelector('#ai-local-autosetup').checked,
        structuredModel: v.querySelector('#ai-local-structured').value.trim(),
        proseModel: v.querySelector('#ai-local-prose').value.trim(),
      },
    } }),
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
    if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
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

  paintRuntime();
  navigate();
}

// global listeners (registered once)
window.addEventListener('hashchange', navigate);
$('#refresh-pill')?.addEventListener('click', () => { hideRefreshPill(); navigate(); });
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
