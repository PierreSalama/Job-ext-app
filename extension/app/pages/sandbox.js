// v8: Onboarding sandbox — seeds fake demo data so users can try every page
// without committing real applications. One-click reset wipes only sandbox rows.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

export function render(state) {
  const seeded = state.settings?.sandboxSeeded;
  return `
    <div class="page-h">
      <div><h1>🧰 Sandbox</h1>
      <div class="sub">Try every page with realistic demo data. Wipe in one click when done.</div></div>
    </div>
    <div class="card">
      <h3 style="margin-top:0">What this does</h3>
      <ul style="font-size:13px;line-height:1.7">
        <li>Adds 12 demo job applications spanning every status (started → offer → rejected).</li>
        <li>Adds 6 demo contacts (recruiters + hiring managers) and 3 companies.</li>
        <li>Adds 4 inbox messages and 2 calendar events.</li>
        <li>Adds 3 saved views and 5 tags so the UI feels populated.</li>
      </ul>
      <p style="font-size:13px;color:var(--muted)">
        Demo rows are tagged <code>demo</code> internally. Click "Wipe sandbox" to remove only those rows — your real data is untouched.
      </p>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn primary" id="sb-seed" ${seeded ? 'disabled' : ''}>${seeded ? 'Already seeded' : 'Seed sandbox'}</button>
        <button class="btn danger" id="sb-wipe" ${seeded ? '' : 'disabled'}>Wipe sandbox</button>
      </div>
    </div>
  `;
}

export function attach($main, ctx) {
  const { send, toast } = ctx;
  $main.querySelector('#sb-seed')?.addEventListener('click', async () => {
    const r = await send('sandbox-seed', {});
    if (r?.ok) toast(`Seeded ${r.count} demo rows.`, 'success');
    else toast(r?.error || 'Seed failed.', 'danger');
  });
  $main.querySelector('#sb-wipe')?.addEventListener('click', async () => {
    if (!confirm('Wipe all demo rows? Your real data is unaffected.')) return;
    const r = await send('sandbox-wipe', {});
    if (r?.ok) toast(`Removed ${r.count} demo rows.`, 'success');
  });
}
