// Activity logs page. Tail-follows the `logs` IDB store, refreshing every 2s.
// Tabs filter by category; search box does substring match across message+ctx.
import { db } from '../../lib/db.js';

const send = (type, data) => new Promise((res) => chrome.runtime.sendMessage({ type, data }, res));

function escape(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

const local = {
  rows: [],
  loaded: false,
  tab: 'all',     // 'all' | 'errors' | 'warnings' | 'ai' | 'capture'
  search: '',
  timer: null
};

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'errors', label: 'Errors' },
  { id: 'warnings', label: 'Warnings' },
  { id: 'ai', label: 'AI' },
  { id: 'capture', label: 'Capture' }
];

async function loadRows() {
  try { local.rows = await db.getAll('logs'); }
  catch { local.rows = []; }
  local.loaded = true;
}

function filterRows() {
  const q = local.search.trim().toLowerCase();
  return local.rows
    .filter((r) => {
      if (local.tab === 'errors') return r.level === 'error';
      if (local.tab === 'warnings') return r.level === 'warn';
      if (local.tab === 'ai') return (r.ctx || '').startsWith('ai');
      if (local.tab === 'capture') return (r.ctx || '').includes('capture') || (r.ctx || '').includes('sanitize');
      return true;
    })
    .filter((r) => {
      if (!q) return true;
      return (r.message || '').toLowerCase().includes(q) || (r.ctx || '').toLowerCase().includes(q);
    })
    .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
    .slice(0, 500);
}

function levelColor(lvl) {
  if (lvl === 'error') return 'var(--danger)';
  if (lvl === 'warn') return 'var(--warn)';
  if (lvl === 'info') return 'var(--primary)';
  return 'var(--muted)';
}

export function render(state) {
  if (!local.loaded) loadRows().then(() => state.__rerender && state.__rerender());
  const rows = filterRows();
  return `
    <div class="page-h">
      <div><h1>📜 Activity logs</h1><div class="sub">Tail-follow stream from background and content scripts. Auto-refreshing every 2s.</div></div>
      <div style="display:flex;gap:8px"><button class="btn danger" id="logs-clear">Clear logs</button></div>
    </div>
    <div class="card" style="margin-bottom:14px">
      <div class="logs-tabs" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
        ${TABS.map((t) => `<button class="btn small ${local.tab === t.id ? 'primary' : ''}" data-tab="${t.id}">${t.label}</button>`).join('')}
      </div>
      <input type="text" id="logs-search" placeholder="Search message or context…" value="${escape(local.search)}" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text)" />
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      ${rows.length === 0
        ? `<div style="padding:32px;text-align:center;color:var(--muted)">${local.loaded ? 'No matching log entries.' : 'Loading…'}</div>`
        : `<div style="max-height:60vh;overflow:auto">
          ${rows.map((r) => `
            <div style="padding:8px 14px;border-top:1px solid var(--border);display:grid;grid-template-columns:160px 70px 110px 1fr;gap:10px;font-size:12px;font-family:ui-monospace,monospace;align-items:start">
              <span style="color:var(--muted)">${escape(formatTime(r.timestamp))}</span>
              <span style="color:${levelColor(r.level)};font-weight:600;text-transform:uppercase">${escape(r.level || '–')}</span>
              <span style="color:var(--primary)">${escape(r.ctx || '')}</span>
              <span style="white-space:pre-wrap;word-break:break-word">${escape(r.message || '')}</span>
            </div>
          `).join('')}
        </div>`}
    </div>
  `;
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString() + '.' + String(d.getMilliseconds()).padStart(3, '0');
  } catch { return iso; }
}

export function attach($main, state) {
  const rerender = () => state.__rerender && state.__rerender();
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    local.tab = b.dataset.tab; rerender();
  }));
  document.getElementById('logs-search')?.addEventListener('input', (e) => {
    local.search = e.target.value;
    rerender();
  });
  document.getElementById('logs-clear')?.addEventListener('click', async () => {
    if (!confirm('Clear all activity logs? This cannot be undone.')) return;
    try { await db.clear('logs'); } catch {}
    local.rows = []; rerender();
  });
  // Schedule poll
  if (local.timer) clearInterval(local.timer);
  local.timer = setInterval(async () => {
    if (location.hash !== '#/logs') {
      clearInterval(local.timer); local.timer = null; return;
    }
    await loadRows();
    rerender();
  }, 2000);
}
