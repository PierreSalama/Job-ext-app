// Companies — auto-aggregated from jobs + manual entries.
import { STATUS_LABELS } from '../../lib/schema.js';
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

let _expanded = null;
let _adding = false;

function uuid() { return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'co-' + Date.now(); }

function buildAggregated(state) {
  const map = new Map();
  // Manual entries first
  for (const c of (state.companies || [])) {
    if (!c.name) continue;
    const k = c.name.toLowerCase();
    map.set(k, { name: c.name, manual: c, jobs: [], contacts: [] });
  }
  // Augment from jobs
  for (const j of (state.jobs || [])) {
    if (!j.company) continue;
    const k = j.company.toLowerCase();
    if (!map.has(k)) map.set(k, { name: j.company, manual: null, jobs: [], contacts: [] });
    map.get(k).jobs.push(j);
  }
  // Contacts
  for (const c of (state.contacts || [])) {
    if (!c.company) continue;
    const k = c.company.toLowerCase();
    if (!map.has(k)) map.set(k, { name: c.company, manual: null, jobs: [], contacts: [] });
    map.get(k).contacts.push(c);
  }
  // Compute lastInteraction + status counts
  for (const co of map.values()) {
    let last = co.manual?.updatedAt || '';
    const counts = {};
    for (const j of co.jobs) {
      counts[j.status] = (counts[j.status] || 0) + 1;
      if ((j.updatedAt || '') > last) last = j.updatedAt;
    }
    for (const c of co.contacts) {
      if ((c.updatedAt || c.lastInteraction || '') > last) last = c.updatedAt || c.lastInteraction;
    }
    co.lastInteraction = last;
    co.statusCounts = counts;
  }
  return Array.from(map.values()).sort((a, b) => (b.lastInteraction || '').localeCompare(a.lastInteraction || ''));
}

export function render(state) {
  const companies = buildAggregated(state);

  return `
    <div class="page-h">
      <div><h1>Companies</h1><div class="sub">${companies.length} compan${companies.length === 1 ? 'y' : 'ies'} tracked</div></div>
      <div><button class="btn primary" id="co-add-toggle">${_adding ? 'Cancel' : '+ Add company'}</button></div>
    </div>
    ${_adding ? addFormHtml() : ''}
    ${companies.length === 0 ? `<div class="card"><div class="empty"><strong>No companies yet.</strong>Companies appear automatically as you apply to jobs.</div></div>` : `
      <div class="co-grid">
        ${companies.map((c) => cardHtml(c, state)).join('')}
      </div>
    `}
    <style>
      .co-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
      .co-card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px; cursor: pointer; transition: all 0.12s; }
      .co-card:hover { border-color: var(--primary); transform: translateY(-1px); }
      .co-card.open { grid-column: 1 / -1; cursor: default; }
      .co-card h3 { margin: 0 0 6px; font-size: 15px; }
      .co-card .sub { font-size: 11px; color: var(--muted); margin-bottom: 10px; }
      .co-stats { display: flex; gap: 6px; flex-wrap: wrap; }
      .co-stat { background: rgba(255,255,255,0.04); padding: 4px 8px; border-radius: 6px; font-size: 11px; }
      .co-stat strong { color: var(--text); margin-right: 4px; }
    </style>
  `;
}

function addFormHtml() {
  return `
    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-top:0;font-size:14px">Add company</h3>
      <div class="grid-2">
        <div><label>Name</label><input type="text" id="co-name" /></div>
        <div><label>Website</label><input type="text" id="co-web" placeholder="https://…" /></div>
      </div>
      <label>Notes</label><textarea id="co-notes" rows="3"></textarea>
      <div style="margin-top:10px"><button class="btn primary" id="co-save">Save</button></div>
    </div>
  `;
}

function cardHtml(c, state) {
  const isOpen = _expanded === c.name.toLowerCase();
  const counts = c.statusCounts || {};
  const statusKeys = Object.keys(counts);
  return `
    <div class="co-card${isOpen ? ' open' : ''}" data-co="${esc(c.name.toLowerCase())}">
      <h3>${esc(c.name)}</h3>
      <div class="sub">${c.jobs.length} application${c.jobs.length === 1 ? '' : 's'} · ${c.contacts.length} contact${c.contacts.length === 1 ? '' : 's'} · last activity ${c.lastInteraction ? esc(new Date(c.lastInteraction).toLocaleDateString()) : '—'}</div>
      <div class="co-stats">
        ${statusKeys.length === 0 ? `<span class="co-stat" style="color:var(--muted)">No applications yet</span>` :
          statusKeys.map((s) => `<span class="co-stat"><strong>${counts[s]}</strong>${esc(STATUS_LABELS[s] || s)}</span>`).join('')}
      </div>
      ${isOpen ? `
        <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
          <label>Notes</label>
          <textarea data-co-notes="${esc(c.name.toLowerCase())}" rows="3">${esc(c.manual?.notes || '')}</textarea>
          <div style="margin-top:6px"><button class="btn small primary" data-co-save-notes="${esc(c.name)}">Save notes</button></div>

          <div style="margin-top:14px;font-size:12px;color:var(--muted)">Linked applications</div>
          ${c.jobs.length === 0 ? `<div class="empty" style="padding:14px">None</div>` : `
            <div class="list" style="margin-top:6px">
              ${c.jobs.map((j) => `<a href="#/job/${esc(j.id)}" style="text-decoration:none"><div class="list-row"><div><div class="t">${esc(j.title)}</div><div class="s">${esc(j.location || '')}</div></div><span class="pill source">${esc(j.source || '')}</span><span class="pill ${esc(j.status)}">${esc(STATUS_LABELS[j.status] || j.status)}</span></div></a>`).join('')}
            </div>
          `}

          ${c.contacts.length > 0 ? `
            <div style="margin-top:14px;font-size:12px;color:var(--muted)">Contacts</div>
            <div class="list" style="margin-top:6px">
              ${c.contacts.map((ct) => `<div class="list-row" style="cursor:default"><div><div class="t">${esc(ct.name)}</div><div class="s">${esc(ct.role || '')}</div></div><span class="pill source">${esc(ct.source || 'Manual')}</span><a class="btn small" href="#/contacts">→</a></div>`).join('')}
            </div>
          ` : ''}
        </div>
      ` : ''}
    </div>
  `;
}

export function attach($main, ctx) {
  const { send, toast, render: rerender, state } = ctx;
  $main.querySelector('#co-add-toggle')?.addEventListener('click', () => { _adding = !_adding; rerender(); });
  $main.querySelector('#co-save')?.addEventListener('click', async () => {
    const name = $main.querySelector('#co-name').value.trim();
    if (!name) { toast('Name required.', 'danger'); return; }
    const payload = {
      id: uuid(), name,
      website: $main.querySelector('#co-web').value.trim(),
      notes: $main.querySelector('#co-notes').value,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    const r = await send('add-company', payload);
    if (r?.ok) { _adding = false; toast('Company added.', 'success'); }
  });

  $main.querySelectorAll('[data-co]').forEach((card) => card.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('a') || e.target.closest('textarea')) return;
    _expanded = _expanded === card.dataset.co ? null : card.dataset.co;
    rerender();
  }));

  $main.querySelectorAll('[data-co-save-notes]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const name = b.dataset.coSaveNotes;
    const k = name.toLowerCase();
    const notes = $main.querySelector(`[data-co-notes="${k}"]`).value;
    const existing = (state.companies || []).find((c) => c.name && c.name.toLowerCase() === k);
    if (existing) {
      await send('patch-company', { id: existing.id, patch: { notes, updatedAt: new Date().toISOString() } });
    } else {
      await send('add-company', { id: uuid(), name, notes, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
    toast('Notes saved.', 'success');
  }));
}
