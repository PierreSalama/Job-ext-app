// v8: Tag manager + smart-tag rules. Smart rules auto-apply tags when a JD or
// title contains specific keywords.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
let _addingRule = false;
let _addingTag = false;

export function render(state) {
  const tags = state.tags || [];
  const rules = state.smartTagRules || [];
  const jobs = state.jobs || [];
  const counts = {};
  for (const j of jobs) for (const t of (j.tags || [])) counts[t] = (counts[t] || 0) + 1;

  return `
    <div class="page-h">
      <div><h1>🏷️ Tags</h1>
      <div class="sub">${tags.length} tags · ${rules.length} smart rule${rules.length === 1 ? '' : 's'}</div></div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="tag-new">+ New tag</button>
        <button class="btn primary" id="rule-new">+ Smart rule</button>
      </div>
    </div>

    ${_addingTag ? `
      <div class="card" style="margin-bottom:14px">
        <h3 style="margin-top:0;font-size:14px">New tag</h3>
        <div class="grid-2">
          <div><label>Name</label><input id="t-name" /></div>
          <div><label>Color</label><input id="t-color" type="color" value="#3b82f6" /></div>
        </div>
        <div style="margin-top:10px;display:flex;gap:6px">
          <button class="btn primary" id="t-save">Save</button>
          <button class="btn" id="t-cancel">Cancel</button>
        </div>
      </div>
    ` : ''}

    ${_addingRule ? `
      <div class="card" style="margin-bottom:14px">
        <h3 style="margin-top:0;font-size:14px">New smart rule</h3>
        <label>Tag to apply</label>
        <select id="r-tag">
          ${tags.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('')}
        </select>
        <label>If JD or title contains (case-insensitive, regex allowed)</label>
        <input id="r-pattern" placeholder="e.g. remote|distributed" />
        <label>Field</label>
        <select id="r-field">
          <option value="any">Any (description + title)</option>
          <option value="description">Description only</option>
          <option value="title">Title only</option>
          <option value="company">Company only</option>
        </select>
        <div style="margin-top:10px;display:flex;gap:6px">
          <button class="btn primary" id="r-save">Save rule</button>
          <button class="btn" id="r-cancel">Cancel</button>
        </div>
      </div>
    ` : ''}

    <div class="card">
      <h3 style="margin-top:0;font-size:14px">Tags (${tags.length})</h3>
      ${tags.length === 0 ? `<div class="empty">No tags yet. Click "+ New tag" or apply tags directly on a job.</div>` : `
        <div class="list">
          ${tags.map((t) => `
            <div class="list-row">
              <span class="pill" style="background:${esc(t.color || '#3b82f6')};color:#fff">${esc(t.name)}</span>
              <span class="s" style="color:var(--muted);margin-left:auto;font-size:12px">${counts[t.name] || 0} job${(counts[t.name] || 0) === 1 ? '' : 's'}</span>
              <button class="btn small danger" data-tag-del="${esc(t.id)}">Delete</button>
            </div>
          `).join('')}
        </div>
      `}
    </div>

    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0;font-size:14px">Smart rules (${rules.length})</h3>
      ${rules.length === 0 ? `<div class="empty">Smart rules auto-apply tags whenever you add a job. Try one.</div>` : `
        <div class="list">
          ${rules.map((r) => `
            <div class="list-row">
              <div>
                <div class="t"><span class="pill" style="background:#3b82f6;color:#fff">${esc(r.tag)}</span> ← <code style="font-size:12px">${esc(r.pattern)}</code></div>
                <div class="s" style="font-size:11px;color:var(--muted)">field: ${esc(r.field)}</div>
              </div>
              <button class="btn small danger" data-rule-del="${esc(r.id)}" style="margin-left:auto">Delete</button>
            </div>
          `).join('')}
        </div>
      `}
    </div>
  `;
}

export function attach($main, ctx) {
  const { send, toast, render: rerender } = ctx;
  $main.querySelector('#tag-new')?.addEventListener('click', () => { _addingTag = !_addingTag; rerender(); });
  $main.querySelector('#rule-new')?.addEventListener('click', () => { _addingRule = !_addingRule; rerender(); });
  $main.querySelector('#t-cancel')?.addEventListener('click', () => { _addingTag = false; rerender(); });
  $main.querySelector('#r-cancel')?.addEventListener('click', () => { _addingRule = false; rerender(); });

  $main.querySelector('#t-save')?.addEventListener('click', async () => {
    const name = $main.querySelector('#t-name').value.trim();
    const color = $main.querySelector('#t-color').value;
    if (!name) { toast('Enter a tag name.', 'danger'); return; }
    const r = await send('add-tag', { name, color });
    if (r?.ok) { _addingTag = false; toast('Tag saved.', 'success'); }
  });

  $main.querySelector('#r-save')?.addEventListener('click', async () => {
    const tag = $main.querySelector('#r-tag').value;
    const pattern = $main.querySelector('#r-pattern').value.trim();
    const field = $main.querySelector('#r-field').value;
    if (!tag || !pattern) { toast('Tag + pattern required.', 'danger'); return; }
    try { new RegExp(pattern, 'i'); } catch { toast('Invalid regex.', 'danger'); return; }
    const r = await send('add-smart-tag-rule', { tag, pattern, field });
    if (r?.ok) { _addingRule = false; toast('Rule saved.', 'success'); }
  });

  $main.querySelectorAll('[data-tag-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this tag (does not remove from existing jobs)?')) return;
    await send('delete-tag', { id: b.dataset.tagDel });
  }));
  $main.querySelectorAll('[data-rule-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this rule?')) return;
    await send('delete-smart-tag-rule', { id: b.dataset.ruleDel });
  }));
}
