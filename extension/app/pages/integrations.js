// Integrations page. Reads/writes the `integrations` IDB store; probes the
// desktop sync app at localhost:7733 every 5s.
import { db } from '../../lib/db.js';

const send = (type, data) => new Promise((res) => chrome.runtime.sendMessage({ type, data }, res));

function escape(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

const PRESETS = [
  { id: 'desktop', kind: 'desktop', name: 'Desktop App', icon: '🖥️', desc: 'Local sync app at localhost:7733. Mirrors data into a native window with notifications.', live: true },
  { id: 'gcal',    kind: 'gcal',    name: 'Google Calendar', icon: '📅', desc: 'Push interview events to your calendar.', placeholder: true },
  { id: 'gmail',   kind: 'gmail',   name: 'Gmail',           icon: '📧', desc: 'Pull recruiter emails into your inbox automatically.', placeholder: true },
  { id: 'slack',   kind: 'slack',   name: 'Slack',           icon: '💬', desc: 'Daily summary + interview reminders to your channel.', placeholder: true }
];

const local = {
  rows: [],
  loaded: false,
  desktopReachable: null,
  desktopChecking: false,
  timer: null
};

async function loadRows() {
  try { local.rows = await db.getAll('integrations'); }
  catch { local.rows = []; }
  // Seed presets that don't yet have a row
  for (const p of PRESETS) {
    if (!local.rows.find((r) => r.id === p.id)) {
      try { await db.put('integrations', { id: p.id, kind: p.kind, name: p.name, status: 'disconnected', createdAt: new Date().toISOString() }); } catch {}
    }
  }
  try { local.rows = await db.getAll('integrations'); } catch {}
  local.loaded = true;
}

async function probeDesktop(state) {
  if (local.desktopChecking) return;
  local.desktopChecking = true;
  const url = (state.settings?.desktopAppUrl) || 'http://localhost:7733';
  try {
    const res = await fetch(url + '/health', { method: 'GET', signal: AbortSignal.timeout(1500) });
    local.desktopReachable = res.ok;
  } catch {
    local.desktopReachable = false;
  } finally {
    local.desktopChecking = false;
  }
}

export function render(state) {
  if (!local.loaded) loadRows().then(() => state.__rerender && state.__rerender());
  return `
    <div class="page-h">
      <div><h1>🔌 Integrations</h1><div class="sub">Connect external tools so Job Tracker can talk to your calendar, inbox, and the desktop app.</div></div>
    </div>
    <div class="grid-2">
      ${PRESETS.map((p) => renderCard(p, state)).join('')}
    </div>
  `;
}

function renderCard(p, state) {
  const row = local.rows.find((r) => r.id === p.id) || {};
  const isDesktop = p.id === 'desktop';
  const reachable = local.desktopReachable;
  const url = (state.settings?.desktopAppUrl) || 'http://localhost:7733';

  return `
    <div class="card integration-card">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <span style="font-size:24px">${p.icon}</span>
        <div style="flex:1">
          <strong>${escape(p.name)}</strong>
          <div style="font-size:11px;color:var(--muted)">${escape(p.desc)}</div>
        </div>
        ${p.placeholder ? `<span class="btn small" style="background:rgba(245,158,11,0.18);color:var(--warn)">v6.1</span>` : ''}
      </div>
      ${isDesktop ? `
        <div style="font-size:12px;margin:8px 0">
          Status: <strong style="color:${reachable === null ? 'var(--muted)' : reachable ? 'var(--success)' : 'var(--danger)'}">
            ${reachable === null ? 'Checking…' : reachable ? 'Reachable' : 'Not reachable'}
          </strong>
          <div style="color:var(--muted);font-size:11px;margin-top:4px">Probing <code>${escape(url)}</code> every 5s.</div>
        </div>
        <div style="display:flex;gap:8px">
          <a class="btn primary" href="${escape(url)}" target="_blank" rel="noreferrer">Open desktop app</a>
          <button class="btn" data-int-toggle="${p.id}">${row.status === 'connected' ? 'Disconnect' : 'Connect'}</button>
        </div>
      ` : `
        <div style="font-size:12px;color:var(--muted);margin:8px 0">Coming in v6.1.</div>
        <div style="display:flex;gap:8px">
          <button class="btn" disabled title="Coming in v6.1">Connect</button>
        </div>
      `}
    </div>
  `;
}

export function attach($main, state) {
  const rerender = () => state.__rerender && state.__rerender();

  document.querySelectorAll('[data-int-toggle]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.intToggle;
    const row = local.rows.find((r) => r.id === id) || { id, kind: id };
    const next = { ...row, status: row.status === 'connected' ? 'disconnected' : 'connected', updatedAt: new Date().toISOString() };
    try { await db.put('integrations', next); } catch {}
    await loadRows();
    rerender();
  }));

  // Initial probe + 5s poll while page is mounted
  if (local.timer) clearInterval(local.timer);
  probeDesktop(state).then(() => rerender());
  local.timer = setInterval(async () => {
    if (location.hash !== '#/integrations') {
      clearInterval(local.timer); local.timer = null; return;
    }
    await probeDesktop(state);
    rerender();
  }, 5000);
}
