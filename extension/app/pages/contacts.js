// Contacts table — recruiters, hiring managers, referrers.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

let _editing = null; // contact id or 'new'
let _expanded = null;

function uuid() { return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'c-' + Date.now(); }

function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString(); } catch { return ''; }
}

export function render(state) {
  const all = (state.contacts || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const editingC = _editing === 'new' ? { id: 'new', name: '', role: '', company: '', source: '', notes: '' } : all.find((c) => c.id === _editing);
  return `
    <div class="page-h">
      <div><h1>Contacts</h1><div class="sub">${all.length} contact${all.length === 1 ? '' : 's'}</div></div>
      <div style="display:flex;gap:8px">
        <button class="btn small" id="cap-hint">+ Capture from LinkedIn</button>
        <button class="btn primary" id="ct-new">+ New contact</button>
      </div>
    </div>
    ${editingC ? editorHtml(editingC) : ''}
    <div class="card">
      ${all.length === 0 ? `<div class="empty"><strong>No contacts yet.</strong>Add one manually or capture them automatically when you message someone on LinkedIn.</div>` : `
        <table class="ct-table">
          <thead><tr><th>Name</th><th>Role</th><th>Company</th><th>Source</th><th>Last interaction</th><th></th></tr></thead>
          <tbody>
            ${all.map((c) => rowHtml(c, state)).join('')}
          </tbody>
        </table>
      `}
    </div>
    <style>
      .ct-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .ct-table th { text-align: left; padding: 8px 10px; color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid var(--border); }
      .ct-table td { padding: 10px; border-bottom: 1px solid var(--border); }
      .ct-table tr.ct-row { cursor: pointer; }
      .ct-table tr.ct-row:hover { background: rgba(99,102,241,0.06); }
      .ct-table tr.ct-detail td { background: rgba(255,255,255,0.02); padding: 14px 10px; }
    </style>
  `;
}

function rowHtml(c, state) {
  const isOpen = _expanded === c.id;
  const linked = (state.jobs || []).filter((j) => (c.company && j.company && j.company.toLowerCase() === c.company.toLowerCase()));
  return `
    <tr class="ct-row" data-ct-toggle="${esc(c.id)}">
      <td><strong>${esc(c.name || '—')}</strong></td>
      <td>${esc(c.role || '—')}</td>
      <td>${esc(c.company || '—')}</td>
      <td><span class="pill source">${esc(c.source || 'Manual')}</span></td>
      <td>${esc(fmtDate(c.lastInteraction || c.updatedAt))}</td>
      <td style="text-align:right">
        <button class="btn small" data-ct-edit="${esc(c.id)}">Edit</button>
        <button class="btn small danger" data-ct-del="${esc(c.id)}">×</button>
      </td>
    </tr>
    ${isOpen ? `
      <tr class="ct-detail">
        <td colspan="6">
          <label>Notes</label>
          <textarea data-ct-notes="${esc(c.id)}" rows="3">${esc(c.notes || '')}</textarea>
          <div style="margin-top:6px"><button class="btn small primary" data-ct-save-notes="${esc(c.id)}">Save notes</button></div>
          <div style="margin-top:14px;font-size:12px;color:var(--muted)">Linked applications (${linked.length})</div>
          ${linked.length === 0 ? `<div class="empty" style="padding:14px">No linked applications.</div>` : `
            <div class="list" style="margin-top:6px">
              ${linked.map((j) => `<a href="#/job/${esc(j.id)}" style="text-decoration:none"><div class="list-row"><div><div class="t">${esc(j.title)}</div><div class="s">${esc(j.location || '')}</div></div><span class="pill source">${esc(j.source || '')}</span><span class="pill ${esc(j.status)}">${esc(j.status)}</span></div></a>`).join('')}
            </div>
          `}
        </td>
      </tr>
    ` : ''}
  `;
}

function editorHtml(c) {
  return `
    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-top:0;font-size:14px">${c.id === 'new' ? 'New contact' : 'Edit contact'}</h3>
      <div class="grid-2">
        <div><label>Name</label><input type="text" id="ct-name" value="${esc(c.name)}" /></div>
        <div><label>Role</label><input type="text" id="ct-role" value="${esc(c.role)}" /></div>
        <div><label>Company</label><input type="text" id="ct-company" value="${esc(c.company)}" /></div>
        <div><label>Source</label>
          <select id="ct-source">
            ${['Manual','LinkedIn','Email','Referral','Other'].map((s) => `<option${(c.source || 'Manual') === s ? ' selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
      </div>
      <label>Notes</label><textarea id="ct-notes-edit" rows="3">${esc(c.notes || '')}</textarea>
      <div style="display:flex;gap:6px;margin-top:12px">
        <button class="btn primary" id="ct-save">Save</button>
        <button class="btn" id="ct-cancel">Cancel</button>
      </div>
    </div>
  `;
}

export function attach($main, ctx) {
  const { send, toast, render: rerender } = ctx;
  $main.querySelector('#ct-new')?.addEventListener('click', () => { _editing = 'new'; rerender(); });
  $main.querySelector('#ct-cancel')?.addEventListener('click', () => { _editing = null; rerender(); });
  $main.querySelector('#cap-hint')?.addEventListener('click', () => {
    toast('Visit LinkedIn → message someone. v8 captures contact + thread automatically (foreground content script).', 'info');
  });

  $main.querySelector('#ct-save')?.addEventListener('click', async () => {
    const payload = {
      name: $main.querySelector('#ct-name').value.trim(),
      role: $main.querySelector('#ct-role').value.trim(),
      company: $main.querySelector('#ct-company').value.trim(),
      source: $main.querySelector('#ct-source').value,
      notes: $main.querySelector('#ct-notes-edit').value,
      updatedAt: new Date().toISOString()
    };
    if (!payload.name) { toast('Name is required.', 'danger'); return; }
    if (_editing === 'new') {
      payload.id = uuid();
      payload.createdAt = payload.updatedAt;
      const r = await send('add-contact', payload);
      if (r?.ok) { _editing = null; toast('Contact added.', 'success'); }
    } else {
      const r = await send('patch-contact', { id: _editing, patch: payload });
      if (r?.ok) { _editing = null; toast('Saved.', 'success'); }
    }
  });

  $main.querySelectorAll('[data-ct-toggle]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    _expanded = _expanded === tr.dataset.ctToggle ? null : tr.dataset.ctToggle;
    rerender();
  }));
  $main.querySelectorAll('[data-ct-edit]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    _editing = b.dataset.ctEdit; rerender();
  }));
  $main.querySelectorAll('[data-ct-del]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete contact?')) return;
    await send('delete-contact', { id: b.dataset.ctDel });
    toast('Deleted.', 'success');
  }));
  $main.querySelectorAll('[data-ct-save-notes]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.ctSaveNotes;
    const notes = $main.querySelector(`[data-ct-notes="${id}"]`).value;
    await send('patch-contact', { id, patch: { notes, updatedAt: new Date().toISOString() } });
    toast('Notes saved.', 'success');
  }));
}
