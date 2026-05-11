// v8: Application Timeline — single chronological feed of every event across every job.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
let _filter = 'all';

const TYPE_ICON = {
  created: '➕', status_changed: '🔄', updated: '✏️', applied: '📨',
  interview: '🎤', offer: '🎉', rejected: '❌', message: '💬',
  note: '📝', event: '📅'
};

export function render(state) {
  const events = [];
  for (const j of (state.jobs || [])) {
    for (const t of (j.timeline || [])) {
      events.push({ ...t, jobId: j.id, jobTitle: j.title, company: j.company });
    }
  }
  for (const m of (state.messages || [])) {
    events.push({ id: 'm-' + m.id, timestamp: m.receivedAt, type: 'message', summary: m.subject || (m.body || '').slice(0, 80), source: m.source, jobId: m.jobId, jobTitle: '', company: '' });
  }
  for (const ev of (state.events || [])) {
    events.push({ id: 'e-' + ev.id, timestamp: ev.startsAt, type: 'event', summary: ev.title || ev.kind, source: 'calendar', jobId: ev.jobId, jobTitle: '', company: '' });
  }
  events.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  const filtered = _filter === 'all' ? events : events.filter((e) => e.type === _filter);

  return `
    <div class="page-h">
      <div><h1>📜 Timeline</h1>
      <div class="sub">${events.length} events across all applications</div></div>
      <div>
        <select id="tl-filter">
          <option value="all">All events</option>
          <option value="status_changed" ${_filter === 'status_changed' ? 'selected' : ''}>Status changes only</option>
          <option value="message" ${_filter === 'message' ? 'selected' : ''}>Messages only</option>
          <option value="event" ${_filter === 'event' ? 'selected' : ''}>Calendar events only</option>
        </select>
      </div>
    </div>
    ${filtered.length === 0 ? `<div class="card empty"><strong>Nothing here yet.</strong> As you act on applications, events will accumulate.</div>` : `
      <div class="card"><div class="list">
        ${filtered.slice(0, 500).map((e) => `
          <div class="list-row">
            <div style="font-size:18px;width:32px;text-align:center">${TYPE_ICON[e.type] || '•'}</div>
            <div style="flex:1;min-width:0">
              <div class="t">${esc(e.summary || e.type)}</div>
              <div class="s" style="font-size:12px;color:var(--muted)">
                ${e.jobTitle ? `${esc(e.jobTitle)} · ${esc(e.company || '')}` : (e.source ? esc(e.source) : '')}
              </div>
            </div>
            <div style="font-size:11px;color:var(--muted);min-width:140px;text-align:right">
              ${e.timestamp ? esc(new Date(e.timestamp).toLocaleString()) : ''}
            </div>
            ${e.jobId ? `<a class="btn small" href="#/job/${esc(e.jobId)}">Open →</a>` : ''}
          </div>
        `).join('')}
      </div></div>
    `}
  `;
}

export function attach($main, ctx) {
  $main.querySelector('#tl-filter')?.addEventListener('change', (e) => {
    _filter = e.target.value; ctx.render();
  });
}
