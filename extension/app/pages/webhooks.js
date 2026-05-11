// v8: Webhooks — outbound POSTs on certain events for n8n / Zapier / Slack.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
let _adding = false;

const KINDS = [
  { id: 'job_created', label: 'New job added' },
  { id: 'status_changed', label: 'Job status changed' },
  { id: 'offer', label: 'Offer received' },
  { id: 'interview', label: 'Interview scheduled' },
  { id: 'rejected', label: 'Job rejected' }
];

export function render(state) {
  const hooks = state.webhooks || [];
  return `
    <div class="page-h">
      <div><h1>🪝 Webhooks</h1>
      <div class="sub">${hooks.length} outbound webhook${hooks.length === 1 ? '' : 's'}</div></div>
      <div><button class="btn primary" id="wh-new">+ New webhook</button></div>
    </div>

    ${_adding ? `
      <div class="card" style="margin-bottom:14px">
        <h3 style="margin-top:0;font-size:14px">New webhook</h3>
        <div class="grid-2">
          <div><label>Event</label>
            <select id="wh-kind">${KINDS.map((k) => `<option value="${k.id}">${k.label}</option>`).join('')}</select>
          </div>
          <div><label>Format</label>
            <select id="wh-format"><option value="json">JSON</option><option value="slack">Slack-formatted</option></select>
          </div>
        </div>
        <label>URL (https only)</label>
        <input id="wh-url" placeholder="https://hooks.slack.com/services/..." />
        <div style="margin-top:10px;display:flex;gap:6px">
          <button class="btn primary" id="wh-save">Save</button>
          <button class="btn" id="wh-cancel">Cancel</button>
        </div>
      </div>
    ` : ''}

    ${hooks.length === 0 ? `<div class="card empty"><strong>No webhooks yet.</strong> Send job events to Slack, n8n, Zapier, or any HTTPS endpoint.</div>` : `
      <div class="card"><div class="list">
        ${hooks.map((h) => `
          <div class="list-row">
            <div>
              <div class="t">${esc((KINDS.find((k) => k.id === h.kind) || {}).label || h.kind)}</div>
              <div class="s" style="font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;max-width:400px"><code>${esc(h.url)}</code></div>
            </div>
            <button class="btn small" data-wh-test="${esc(h.id)}">Test</button>
            <button class="btn small danger" data-wh-del="${esc(h.id)}">Delete</button>
          </div>
        `).join('')}
      </div></div>
    `}

    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0">Privacy note</h3>
      <p style="font-size:13px">
        Webhooks send job titles, companies, and statuses to your configured URL. They are <strong>disabled</strong> when "Local-only mode" is on (Settings).
      </p>
    </div>
  `;
}

export function attach($main, ctx) {
  const { send, toast, render: rerender } = ctx;
  $main.querySelector('#wh-new')?.addEventListener('click', () => { _adding = !_adding; rerender(); });
  $main.querySelector('#wh-cancel')?.addEventListener('click', () => { _adding = false; rerender(); });
  $main.querySelector('#wh-save')?.addEventListener('click', async () => {
    const url = $main.querySelector('#wh-url').value.trim();
    const kind = $main.querySelector('#wh-kind').value;
    const format = $main.querySelector('#wh-format').value;
    if (!/^https:\/\//i.test(url)) { toast('HTTPS URL required.', 'danger'); return; }
    const r = await send('add-webhook', { kind, url, format });
    if (r?.ok) { _adding = false; toast('Webhook saved.', 'success'); }
  });
  $main.querySelectorAll('[data-wh-test]').forEach((b) => b.addEventListener('click', async () => {
    const r = await send('test-webhook', { id: b.dataset.whTest });
    toast(r?.ok ? 'Test sent.' : (r?.error || 'Test failed.'), r?.ok ? 'success' : 'danger');
  }));
  $main.querySelectorAll('[data-wh-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete webhook?')) return;
    await send('delete-webhook', { id: b.dataset.whDel });
  }));
}
