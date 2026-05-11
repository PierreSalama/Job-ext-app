// Audit log page — tamper-evident chain. Each row is a signed entry written by
// the background worker on every state change. Verify recomputes hashes.
import { db } from '../../lib/db.js';

const send = (type, data) => new Promise((res) => chrome.runtime.sendMessage({ type, data }, res));

function escape(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

const local = {
  rows: [],
  loaded: false,
  filter: { actor: 'all', kind: 'all', from: '', to: '' },
  verifyResult: null
};

async function loadRows() {
  try {
    local.rows = await db.getAll('audit');
  } catch {
    local.rows = [];
  }
  local.loaded = true;
}

function applyFilter(rows) {
  return rows
    .filter((r) => local.filter.actor === 'all' || r.actor === local.filter.actor)
    .filter((r) => local.filter.kind === 'all' || r.kind === local.filter.kind)
    .filter((r) => !local.filter.from || (r.timestamp || '') >= local.filter.from)
    .filter((r) => !local.filter.to || (r.timestamp || '') <= local.filter.to + 'T23:59:59.999Z')
    .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
}

export function render(state) {
  // Lazy-load on first render
  if (!local.loaded) loadRows().then(() => state.__rerender && state.__rerender());

  const actors = ['all', ...new Set(local.rows.map((r) => r.actor || 'unknown'))];
  const kinds = ['all', ...new Set(local.rows.map((r) => r.kind || 'unknown'))];
  const filtered = applyFilter(local.rows);
  const verify = local.verifyResult;

  return `
    <div class="page-h">
      <div><h1>🔍 Audit log</h1><div class="sub">Tamper-evident chain. Every state change is hashed against the previous entry and signed.</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="audit-export">Export JSON</button>
        <button class="btn primary" id="audit-verify">Verify chain</button>
      </div>
    </div>
    ${verify ? `
      <div class="card" style="margin-bottom:14px;border-color:${verify.ok ? 'var(--success)' : 'var(--danger)'}">
        <strong style="color:${verify.ok ? 'var(--success)' : 'var(--danger)'}">${verify.ok ? '✓ Chain verified' : '✗ Chain broken'}</strong>
        <div style="font-size:12px;color:var(--muted);margin-top:6px">
          ${verify.ok
            ? `Checked ${verify.checked || 0} entries. All hashes match.`
            : `Tampering detected starting at entry id: <code>${escape(verify.brokenAt || 'unknown')}</code>${verify.reason ? ' — ' + escape(verify.reason) : ''}`}
        </div>
      </div>` : ''}
    <div class="card" style="margin-bottom:14px">
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
        <label style="font-size:11px;color:var(--muted)">Actor
          <select id="audit-actor" style="width:100%;margin-top:4px">${actors.map((a) => `<option value="${escape(a)}"${local.filter.actor === a ? ' selected' : ''}>${escape(a)}</option>`).join('')}</select>
        </label>
        <label style="font-size:11px;color:var(--muted)">Kind
          <select id="audit-kind" style="width:100%;margin-top:4px">${kinds.map((k) => `<option value="${escape(k)}"${local.filter.kind === k ? ' selected' : ''}>${escape(k)}</option>`).join('')}</select>
        </label>
        <label style="font-size:11px;color:var(--muted)">From
          <input type="date" id="audit-from" value="${escape(local.filter.from)}" style="width:100%;margin-top:4px" />
        </label>
        <label style="font-size:11px;color:var(--muted)">To
          <input type="date" id="audit-to" value="${escape(local.filter.to)}" style="width:100%;margin-top:4px" />
        </label>
      </div>
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      ${filtered.length === 0
        ? `<div style="padding:32px;text-align:center;color:var(--muted)">${local.loaded ? 'No audit entries yet.' : 'Loading…'}</div>`
        : `<table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="background:rgba(99,102,241,0.06)">
            <th style="text-align:left;padding:10px 12px">When</th>
            <th style="text-align:left;padding:10px 12px">Actor</th>
            <th style="text-align:left;padding:10px 12px">Kind</th>
            <th style="text-align:left;padding:10px 12px">Summary</th>
            <th style="text-align:left;padding:10px 12px">Hash</th>
            <th style="text-align:left;padding:10px 12px">Sig</th>
          </tr></thead>
          <tbody>
            ${filtered.map((r) => `<tr style="border-top:1px solid var(--border)">
              <td style="padding:8px 12px;color:var(--muted);white-space:nowrap">${escape(formatTime(r.timestamp))}</td>
              <td style="padding:8px 12px"><span class="btn small">${escape(r.actor || '?')}</span></td>
              <td style="padding:8px 12px;font-family:monospace;font-size:11px">${escape(r.kind || '?')}</td>
              <td style="padding:8px 12px">${escape(r.summary || '')}</td>
              <td style="padding:8px 12px;font-family:monospace;font-size:10px;color:var(--muted)">${escape((r.hash || '').slice(0, 12))}…</td>
              <td style="padding:8px 12px;color:${r.signature ? 'var(--success)' : 'var(--muted)'}">${r.signature ? '✓' : '–'}</td>
            </tr>`).join('')}
          </tbody>
        </table>`}
    </div>
  `;
}

function formatTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

export function attach($main, state) {
  const rerender = () => state.__rerender ? state.__rerender() : null;

  document.getElementById('audit-actor')?.addEventListener('change', (e) => { local.filter.actor = e.target.value; rerender(); });
  document.getElementById('audit-kind')?.addEventListener('change', (e) => { local.filter.kind = e.target.value; rerender(); });
  document.getElementById('audit-from')?.addEventListener('change', (e) => { local.filter.from = e.target.value; rerender(); });
  document.getElementById('audit-to')?.addEventListener('change', (e) => { local.filter.to = e.target.value; rerender(); });

  document.getElementById('audit-export')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(local.rows, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jat8-audit-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  document.getElementById('audit-verify')?.addEventListener('click', async () => {
    local.verifyResult = { ok: true, checked: 0, pending: true };
    rerender();
    try {
      const r = await send('verify-audit-chain');
      if (r?.ok) {
        local.verifyResult = r.result || { ok: false, reason: 'No result' };
      } else {
        local.verifyResult = { ok: false, reason: r?.error || 'verify failed' };
      }
    } catch (e) {
      local.verifyResult = { ok: false, reason: String(e.message || e) };
    }
    // Refresh rows in case an entry was just appended
    await loadRows();
    rerender();
  });
}

// React to broadcast
chrome.runtime?.onMessage?.addListener((msg) => {
  if (msg?.type === 'jat-event' && msg.name === 'audit.updated') {
    loadRows();
  }
});
