// v8: Health check — verifies extension permissions, AI provider, sync, DB.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

let _checks = null;
let _running = false;

export function render(state) {
  return `
    <div class="page-h">
      <div><h1>🩻 Health Check</h1>
      <div class="sub">Verifies your install across permissions, AI, sync, and database.</div></div>
      <div><button class="btn primary" id="hc-run" ${_running ? 'disabled' : ''}>${_running ? 'Running…' : 'Run all checks'}</button></div>
    </div>

    ${!_checks ? `<div class="card empty"><strong>Click "Run all checks" to start.</strong> Takes ~3 seconds.</div>` : `
      <div class="card"><div class="list">
        ${_checks.map((c) => `
          <div class="list-row">
            <div>
              <div class="t">${statusIcon(c.status)} ${esc(c.name)}</div>
              <div class="s" style="font-size:12px;color:var(--muted)">${esc(c.detail || '')}</div>
            </div>
            ${c.fix ? `<button class="btn small" data-hc-fix="${esc(c.fix)}" style="margin-left:auto">${esc(c.fixLabel || 'Fix')}</button>` : ''}
          </div>
        `).join('')}
      </div></div>
    `}
  `;
}

function statusIcon(s) {
  return s === 'ok' ? '✅' : s === 'warn' ? '⚠️' : s === 'fail' ? '❌' : 'ℹ️';
}

export function attach($main, ctx) {
  const { send, toast, render: rerender } = ctx;
  $main.querySelector('#hc-run')?.addEventListener('click', async () => {
    _running = true; rerender();
    try {
      _checks = await runChecks(send);
    } finally { _running = false; rerender(); }
  });
  $main.querySelectorAll('[data-hc-fix]').forEach((b) => b.addEventListener('click', async () => {
    const action = b.dataset.hcFix;
    if (action === 'open-permissions') {
      location.hash = '#/permissions';
    } else if (action === 'open-ai') {
      location.hash = '#/ai';
    } else if (action === 'open-install') {
      location.hash = '#/install-app';
    }
  }));
}

async function runChecks(send) {
  const out = [];

  // Permissions
  try {
    const perms = await chrome.permissions.getAll();
    out.push({ name: 'Chrome permissions', status: 'ok', detail: `${(perms.permissions || []).length} permissions, ${(perms.origins || []).length} hosts.` });
  } catch (e) {
    out.push({ name: 'Chrome permissions', status: 'fail', detail: 'Could not read permissions.', fix: 'open-permissions', fixLabel: 'Audit' });
  }

  // Service worker
  try {
    const r = await Promise.race([
      send('ping', {}),
      new Promise((res) => setTimeout(() => res(null), 1500))
    ]);
    out.push({ name: 'Service worker (background.js)', status: r ? 'ok' : 'warn', detail: r ? 'Reachable.' : 'No response in 1.5s — may be sleeping.' });
  } catch {
    out.push({ name: 'Service worker', status: 'fail', detail: 'Send-message failed.' });
  }

  // IndexedDB
  try {
    const c = await send('db-stats', {});
    if (c?.ok) {
      out.push({ name: 'IndexedDB integrity', status: 'ok', detail: `${c.totalRows} rows across ${c.storeCount} stores.` });
    } else throw new Error();
  } catch {
    out.push({ name: 'IndexedDB integrity', status: 'fail', detail: 'Could not read DB stats.' });
  }

  // AI
  try {
    const r = await send('ai-ping', {});
    if (r?.ok) out.push({ name: `AI provider (${r.provider})`, status: 'ok', detail: r.detail || 'Ready.' });
    else out.push({ name: 'AI provider', status: 'warn', detail: r?.error || 'Not configured.', fix: 'open-ai', fixLabel: 'Configure' });
  } catch {
    out.push({ name: 'AI provider', status: 'warn', detail: 'No AI provider responded.', fix: 'open-ai', fixLabel: 'Configure' });
  }

  // Desktop sync
  try {
    const r = await send('sync-status', {});
    if (r?.ok && r.connected) out.push({ name: 'Desktop sync', status: 'ok', detail: `Connected to ${r.url}.` });
    else out.push({ name: 'Desktop sync', status: 'warn', detail: 'Desktop app not running (optional).', fix: 'open-install', fixLabel: 'Install' });
  } catch {
    out.push({ name: 'Desktop sync', status: 'warn', detail: 'Status unavailable.' });
  }

  // Storage quota
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      const usedMb = Math.round((est.usage || 0) / 1048576);
      const quotaMb = Math.round((est.quota || 0) / 1048576);
      const pct = quotaMb ? Math.round((usedMb / quotaMb) * 100) : 0;
      out.push({ name: 'Storage quota', status: pct > 80 ? 'warn' : 'ok', detail: `${usedMb} MB / ${quotaMb} MB (${pct}%).` });
    }
  } catch {}

  // Online status
  out.push({ name: 'Network', status: navigator.onLine ? 'ok' : 'warn', detail: navigator.onLine ? 'Online.' : 'Offline — most features still work locally.' });

  return out;
}
