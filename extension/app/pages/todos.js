// Free-form todos with optional job link.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

let _filter = 'all'; // 'all' | 'open' | 'done'

export function render(state) {
  const all = state.todos || [];
  const jobs = state.jobs || [];
  const open = all.filter((t) => !t.done);
  const done = all.filter((t) => t.done);
  const list = (_filter === 'open' ? open : _filter === 'done' ? done : all)
    .slice().sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });

  return `
    <div class="page-h">
      <div><h1>To-dos</h1><div class="sub">${open.length} open · ${done.length} done</div></div>
    </div>
    <div class="card" style="margin-bottom:14px">
      <div style="display:grid;grid-template-columns:2fr 1fr auto;gap:8px;align-items:end">
        <div><label>New todo</label><input type="text" id="todo-text" placeholder="What needs doing?" /></div>
        <div><label>Link job (optional)</label>
          <select id="todo-job"><option value="">— None —</option>
            ${jobs.slice(0, 200).map((j) => `<option value="${esc(j.id)}">${esc(j.title)} · ${esc(j.company)}</option>`).join('')}
          </select>
        </div>
        <button class="btn primary" id="todo-add">Add</button>
      </div>
    </div>
    <div class="toolbar" style="gap:4px">
      ${['all','open','done'].map((t) => `<button class="btn small${_filter === t ? ' primary' : ''}" data-filter="${t}">${t.charAt(0).toUpperCase() + t.slice(1)}</button>`).join('')}
    </div>
    <div class="card">
      ${list.length === 0 ? `<div class="empty"><strong>No todos.</strong>Add one above.</div>` : `
        <div class="list">
          ${list.map((t) => rowHtml(t, jobs)).join('')}
        </div>
      `}
    </div>
  `;
}

function rowHtml(t, jobs) {
  const job = t.jobId ? jobs.find((j) => j.id === t.jobId) : null;
  return `
    <div class="list-row" style="cursor:default">
      <div style="display:flex;gap:10px;align-items:center">
        <input type="checkbox" data-check="${esc(t.id)}" ${t.done ? 'checked' : ''} style="width:18px;height:18px" />
        <div>
          <div class="t" style="${t.done ? 'text-decoration:line-through;color:var(--muted)' : ''}">${esc(t.text)}</div>
          ${job ? `<div class="s"><a href="#/job/${esc(job.id)}" style="color:var(--muted)">${esc(job.title)} · ${esc(job.company)}</a></div>` : ''}
        </div>
      </div>
      <span class="pill source">${esc((t.createdAt || '').slice(0, 10))}</span>
      <button class="btn small danger" data-del="${esc(t.id)}">×</button>
    </div>
  `;
}

export function attach($main, ctx) {
  const { send, toast, render: rerender } = ctx;
  $main.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { _filter = b.dataset.filter; rerender(); }));

  const addFn = async () => {
    const text = $main.querySelector('#todo-text').value.trim();
    const jobId = $main.querySelector('#todo-job').value;
    if (!text) return;
    const r = await send('add-todo', { text, jobId, done: false, createdAt: new Date().toISOString() });
    if (r?.ok) { $main.querySelector('#todo-text').value = ''; toast('Added.', 'success'); }
  };
  $main.querySelector('#todo-add')?.addEventListener('click', addFn);
  $main.querySelector('#todo-text')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addFn(); });

  $main.querySelectorAll('[data-check]').forEach((cb) => cb.addEventListener('change', async () => {
    await send('patch-todo', { id: cb.dataset.check, patch: { done: cb.checked, doneAt: cb.checked ? new Date().toISOString() : '' } });
  }));
  $main.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this todo?')) return;
    await send('delete-todo', { id: b.dataset.del });
    toast('Deleted.', 'success');
  }));
}
