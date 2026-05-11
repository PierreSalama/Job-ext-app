// v8: Saved views — pin filter combinations as one-click tabs over the jobs page.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
let _adding = false;

export function render(state) {
  const views = state.savedViews || [];
  return `
    <div class="page-h">
      <div><h1>⭐ Saved Views</h1>
      <div class="sub">${views.length} pinned filter${views.length === 1 ? '' : 's'} for the Applications page</div></div>
      <div><button class="btn primary" id="sv-new">+ New view</button></div>
    </div>

    ${_adding ? `
      <div class="card" style="margin-bottom:14px">
        <h3 style="margin-top:0;font-size:14px">New saved view</h3>
        <div class="grid-2">
          <div><label>Name</label><input id="sv-name" placeholder="Senior remote roles" /></div>
          <div><label>Status filter (comma-separated, optional)</label><input id="sv-status" placeholder="submitted, interview" /></div>
        </div>
        <label>Search query (optional)</label>
        <input id="sv-q" placeholder="remote senior" />
        <label>Tag filter (comma-separated, optional)</label>
        <input id="sv-tags" placeholder="remote, no-leetcode" />
        <div style="margin-top:10px;display:flex;gap:6px">
          <button class="btn primary" id="sv-save">Save</button>
          <button class="btn" id="sv-cancel">Cancel</button>
        </div>
      </div>
    ` : ''}

    ${views.length === 0 ? `<div class="card empty"><strong>No saved views yet.</strong> Save your most-used filter combos.</div>` : `
      <div class="card"><div class="list">
        ${views.map((v) => `
          <div class="list-row">
            <div>
              <div class="t">${esc(v.name)}</div>
              <div class="s" style="font-size:12px;color:var(--muted)">
                ${v.status ? `status: ${esc(v.status)}` : ''}
                ${v.q ? ` · q: <code>${esc(v.q)}</code>` : ''}
                ${v.tags ? ` · tags: ${esc(v.tags)}` : ''}
              </div>
            </div>
            <a class="btn small" href="#/jobs?view=${encodeURIComponent(v.id)}" style="margin-left:auto">Open →</a>
            <button class="btn small danger" data-sv-del="${esc(v.id)}">Delete</button>
          </div>
        `).join('')}
      </div></div>
    `}
  `;
}

export function attach($main, ctx) {
  const { send, toast, render: rerender } = ctx;
  $main.querySelector('#sv-new')?.addEventListener('click', () => { _adding = !_adding; rerender(); });
  $main.querySelector('#sv-cancel')?.addEventListener('click', () => { _adding = false; rerender(); });
  $main.querySelector('#sv-save')?.addEventListener('click', async () => {
    const payload = {
      name: $main.querySelector('#sv-name').value.trim(),
      status: $main.querySelector('#sv-status').value.trim(),
      q: $main.querySelector('#sv-q').value.trim(),
      tags: $main.querySelector('#sv-tags').value.trim()
    };
    if (!payload.name) { toast('Name is required.', 'danger'); return; }
    const r = await send('add-saved-view', payload);
    if (r?.ok) { _adding = false; toast('View saved.', 'success'); }
  });
  $main.querySelectorAll('[data-sv-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this view?')) return;
    await send('delete-saved-view', { id: b.dataset.svDel });
  }));
}
