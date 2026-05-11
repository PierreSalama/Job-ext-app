// Reference contact list. Stored in the references IDB store.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const local = {
  editing: null, // id or 'new'
  draft: { name: '', role: '', company: '', relationship: '', willingToHelp: 'Yes', lastContacted: '', notes: '' }
};

function blankDraft() {
  return { name: '', role: '', company: '', relationship: '', willingToHelp: 'Yes', lastContacted: '', notes: '' };
}

export function render(state) {
  const list = (state.references || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const editing = local.editing;
  const isNew = editing === 'new';
  const cur = isNew ? local.draft : (editing ? list.find((r) => r.id === editing) || local.draft : null);

  return `
    <div class="page-h">
      <div><h1>References</h1><div class="sub">Track who's vouching for you and when you last touched base.</div></div>
      <button class="btn primary" id="ref-new">+ Add reference</button>
    </div>
    ${editing ? renderForm(cur, isNew) : ''}
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;margin-top:14px">
      ${list.length === 0 ? `<div class="card empty" style="grid-column:1/-1">No references yet.</div>` :
        list.map((r) => `
          <div class="card" style="padding:12px">
            <div style="font-weight:700;font-size:14px">${esc(r.name)}</div>
            <div style="font-size:12px;color:var(--muted)">${esc(r.role || '')}${r.company ? ' · ' + esc(r.company) : ''}</div>
            <div style="font-size:12px;margin-top:6px"><strong>Relationship:</strong> ${esc(r.relationship || '—')}</div>
            <div style="font-size:12px"><strong>Willing:</strong> ${esc(r.willingToHelp || 'Unknown')}</div>
            <div style="font-size:12px"><strong>Last contacted:</strong> ${esc(r.lastContacted || '—')}</div>
            ${r.notes ? `<div style="font-size:12px;margin-top:6px;color:var(--muted)">${esc(r.notes)}</div>` : ''}
            <div style="display:flex;gap:4px;margin-top:8px">
              <button class="btn small" data-ref-edit="${esc(r.id)}">Edit</button>
              <button class="btn small danger" data-ref-del="${esc(r.id)}">Delete</button>
            </div>
          </div>`).join('')}
    </div>
  `;
}

function renderForm(cur, isNew) {
  return `
    <div class="card" style="padding:14px;margin-top:12px;border:1px solid var(--primary)">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <input data-ref-f="name" placeholder="Name *" value="${esc(cur?.name || '')}" style="padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px"/>
        <input data-ref-f="role" placeholder="Role / title" value="${esc(cur?.role || '')}" style="padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px"/>
        <input data-ref-f="company" placeholder="Company" value="${esc(cur?.company || '')}" style="padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px"/>
        <input data-ref-f="relationship" placeholder="Relationship (former manager, peer, …)" value="${esc(cur?.relationship || '')}" style="padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px"/>
        <select data-ref-f="willingToHelp" style="padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px">
          ${['Yes','Maybe','No','Unknown'].map((v) => `<option value="${v}"${cur?.willingToHelp === v ? ' selected' : ''}>${v}</option>`).join('')}
        </select>
        <input type="date" data-ref-f="lastContacted" value="${esc(cur?.lastContacted || '')}" style="padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px"/>
      </div>
      <textarea data-ref-f="notes" placeholder="Notes" style="width:100%;margin-top:8px;padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;min-height:60px;resize:vertical">${esc(cur?.notes || '')}</textarea>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button class="btn primary" id="ref-save">${isNew ? 'Create' : 'Save'}</button>
        <button class="btn" id="ref-cancel">Cancel</button>
      </div>
    </div>
  `;
}

export function attach($main, ctx) {
  $main.querySelector('#ref-new')?.addEventListener('click', () => {
    local.editing = 'new';
    local.draft = blankDraft();
    ctx.render();
  });

  $main.querySelectorAll('[data-ref-edit]').forEach((b) => b.addEventListener('click', () => {
    local.editing = b.dataset.refEdit;
    const cur = (ctx.state.references || []).find((r) => r.id === local.editing);
    local.draft = { ...blankDraft(), ...(cur || {}) };
    ctx.render();
  }));

  $main.querySelectorAll('[data-ref-f]').forEach((el) => el.addEventListener('input', (e) => {
    local.draft[el.dataset.refF] = e.target.value;
  }));

  $main.querySelector('#ref-cancel')?.addEventListener('click', () => { local.editing = null; ctx.render(); });

  $main.querySelector('#ref-save')?.addEventListener('click', async () => {
    const d = local.draft;
    if (!d.name?.trim()) { ctx.toast('Name required.', 'danger'); return; }
    if (local.editing === 'new') {
      await ctx.send('add-references', d);
    } else {
      await ctx.send('patch-references', { id: local.editing, patch: d });
    }
    local.editing = null;
    await ctx.reload('references');
    ctx.toast('Saved.', 'success');
  });

  $main.querySelectorAll('[data-ref-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this reference?')) return;
    await ctx.send('delete-references', { id: b.dataset.refDel });
    await ctx.reload('references');
  }));
}
