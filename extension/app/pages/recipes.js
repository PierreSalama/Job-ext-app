// v8: Recipes — saved automation flows. "When status -> X, do Y".
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
let _adding = false;

const TRIGGERS = [
  { id: 'status_changed', label: 'Job status changed' },
  { id: 'job_added', label: 'New job added' },
  { id: 'rejected', label: 'Job rejected' },
  { id: 'interview', label: 'Job moved to Interview' },
  { id: 'offer', label: 'Job moved to Offer' }
];
const ACTIONS = [
  { id: 'add_todo', label: 'Add a todo', needs: ['text'] },
  { id: 'add_reminder', label: 'Add a reminder (in N days)', needs: ['days', 'text'] },
  { id: 'add_tag', label: 'Apply tag', needs: ['tag'] },
  { id: 'create_event', label: 'Schedule calendar event', needs: ['days', 'text'] },
  { id: 'webhook', label: 'POST to webhook', needs: ['url'] },
  { id: 'autopsy', label: 'Run application autopsy', needs: [] }
];

export function render(state) {
  const recipes = state.recipes || [];
  return `
    <div class="page-h">
      <div><h1>🧪 Recipes</h1>
      <div class="sub">${recipes.length} saved automation${recipes.length === 1 ? '' : 's'}</div></div>
      <div><button class="btn primary" id="rx-new">+ New recipe</button></div>
    </div>

    ${_adding ? formHtml() : ''}

    ${recipes.length === 0 ? `<div class="card empty"><strong>No recipes yet.</strong> Try: "When job moves to Interview → add a reminder in 1 day to prep."</div>` : `
      <div class="card"><div class="list">
        ${recipes.map((r) => `
          <div class="list-row">
            <div>
              <div class="t"><span class="pill">${esc((TRIGGERS.find((x) => x.id === r.trigger) || {}).label || r.trigger)}</span> → <span class="pill" style="background:var(--accent, #3b82f6);color:#fff">${esc((ACTIONS.find((x) => x.id === r.action) || {}).label || r.action)}</span></div>
              <div class="s" style="font-size:12px;color:var(--muted)">${esc(JSON.stringify(r.params || {}))}</div>
            </div>
            <button class="btn small danger" data-rx-del="${esc(r.id)}" style="margin-left:auto">Delete</button>
          </div>
        `).join('')}
      </div></div>
    `}
  `;
}

function formHtml() {
  return `
    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-top:0;font-size:14px">New recipe</h3>
      <div class="grid-2">
        <div><label>Trigger</label>
          <select id="rx-trigger">${TRIGGERS.map((t) => `<option value="${t.id}">${t.label}</option>`).join('')}</select>
        </div>
        <div><label>Action</label>
          <select id="rx-action">${ACTIONS.map((t) => `<option value="${t.id}">${t.label}</option>`).join('')}</select>
        </div>
      </div>
      <label>Parameters (text / tag / url / days, comma-separated)</label>
      <input id="rx-params" placeholder="e.g. 1, prep call" />
      <div style="margin-top:10px;display:flex;gap:6px">
        <button class="btn primary" id="rx-save">Save</button>
        <button class="btn" id="rx-cancel">Cancel</button>
      </div>
    </div>
  `;
}

export function attach($main, ctx) {
  const { send, toast, render: rerender } = ctx;
  $main.querySelector('#rx-new')?.addEventListener('click', () => { _adding = !_adding; rerender(); });
  $main.querySelector('#rx-cancel')?.addEventListener('click', () => { _adding = false; rerender(); });
  $main.querySelector('#rx-save')?.addEventListener('click', async () => {
    const trigger = $main.querySelector('#rx-trigger').value;
    const action = $main.querySelector('#rx-action').value;
    const raw = $main.querySelector('#rx-params').value.trim();
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const params = {};
    if (parts[0] && /^\d+$/.test(parts[0])) params.days = parseInt(parts[0], 10);
    if (parts[1]) params.text = parts.slice(1).join(', ');
    else if (parts[0] && !params.days) params.text = parts[0];
    if (action === 'webhook' && parts[0]) params.url = parts[0];
    if (action === 'add_tag' && parts[0]) params.tag = parts[0];
    const r = await send('add-recipe', { trigger, action, params });
    if (r?.ok) { _adding = false; toast('Recipe saved.', 'success'); }
  });
  $main.querySelectorAll('[data-rx-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete recipe?')) return;
    await send('delete-recipe', { id: b.dataset.rxDel });
  }));
}
