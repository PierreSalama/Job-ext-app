// Auto-generated daily summary: insights + nudges + today's events. Plus a download button.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const local = {
  loading: false,
  insights: '',
  nudges: [],
  generatedAt: null
};

function todaysEvents(state) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(); end.setHours(23, 59, 59, 999);
  return (state.events || []).filter((e) => {
    if (!e.startsAt) return false;
    const t = new Date(e.startsAt).getTime();
    return t >= start.getTime() && t <= end.getTime();
  }).sort((a, b) => (a.startsAt || '').localeCompare(b.startsAt || ''));
}

function recentJobs(state) {
  const cutoff = Date.now() - 24 * 3600000;
  return (state.jobs || []).filter((j) => {
    const t = new Date(j.updatedAt || j.createdAt).getTime();
    return t >= cutoff;
  });
}

export function render(state) {
  const events = todaysEvents(state);
  const recent = recentJobs(state);

  return `
    <div class="page-h">
      <div><h1>Daily Digest</h1><div class="sub">Auto-generated summary for ${new Date().toLocaleDateString()}.</div></div>
      <div style="display:flex;gap:6px">
        <button class="btn primary" id="dd-gen" ${local.loading ? 'disabled' : ''}>${local.loading ? 'Generating…' : '✨ Generate'}</button>
        <button class="btn" id="dd-email" ${!local.insights ? 'disabled' : ''}>📧 Download .txt</button>
      </div>
    </div>

    <div class="card" style="padding:14px;margin-bottom:12px">
      <h3 style="margin:0 0 8px">Today (${events.length} event${events.length === 1 ? '' : 's'})</h3>
      ${events.length === 0 ? `<div style="color:var(--muted);font-size:13px">No calendar events today.</div>` :
        `<div style="display:flex;flex-direction:column;gap:4px">${events.map((e) => `
          <div style="padding:6px;border:1px solid var(--border);border-radius:6px;font-size:13px">
            <strong>${esc(new Date(e.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</strong> — ${esc(e.title || e.kind || '')}
            ${e.notes ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">${esc(e.notes)}</div>` : ''}
          </div>`).join('')}</div>`}
    </div>

    <div class="card" style="padding:14px;margin-bottom:12px">
      <h3 style="margin:0 0 8px">Activity (last 24h) — ${recent.length} job${recent.length === 1 ? '' : 's'}</h3>
      ${recent.length === 0 ? `<div style="color:var(--muted);font-size:13px">No movement in the last 24 hours.</div>` :
        `<div style="display:flex;flex-direction:column;gap:4px">${recent.slice(0, 10).map((j) => `
          <div style="padding:6px;border:1px solid var(--border);border-radius:6px;font-size:13px">
            <strong>${esc(j.title)}</strong> @ ${esc(j.company || '')} — <span style="color:var(--muted)">${esc(j.status)}</span>
          </div>`).join('')}</div>`}
    </div>

    ${local.insights ? `
      <div class="card" style="padding:14px;margin-bottom:12px">
        <h3 style="margin:0 0 8px">AI insights</h3>
        <div style="white-space:pre-wrap;font-size:13px">${esc(local.insights)}</div>
      </div>` : ''}

    ${local.nudges.length ? `
      <div class="card" style="padding:14px">
        <h3 style="margin:0 0 8px">AI nudges (${local.nudges.length})</h3>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${local.nudges.map((n) => `
            <div style="padding:8px;border:1px solid var(--border);border-radius:6px;font-size:13px">
              <div><strong>${esc(n.action || '')}</strong> · <span style="color:var(--${n.priority === 'high' ? 'danger' : (n.priority === 'medium' ? 'warn' : 'muted')})">${esc(n.priority || '')}</span></div>
              <div style="color:var(--muted);font-size:12px">${esc(n.reason || '')}</div>
            </div>`).join('')}
        </div>
      </div>` : ''}
  `;
}

function buildDigestText(state) {
  const events = todaysEvents(state);
  const recent = recentJobs(state);
  const lines = [];
  lines.push(`Daily Digest — ${new Date().toLocaleDateString()}`);
  lines.push('='.repeat(40));
  lines.push('');
  lines.push(`Today's events (${events.length}):`);
  for (const e of events) lines.push(`- ${new Date(e.startsAt).toLocaleTimeString()} — ${e.title || e.kind || ''}`);
  lines.push('');
  lines.push(`Activity (last 24h): ${recent.length} job(s)`);
  for (const j of recent.slice(0, 10)) lines.push(`- ${j.title} @ ${j.company} — ${j.status}`);
  lines.push('');
  if (local.insights) {
    lines.push('AI Insights:');
    lines.push(local.insights);
    lines.push('');
  }
  if (local.nudges.length) {
    lines.push('AI Nudges:');
    for (const n of local.nudges) lines.push(`- [${n.priority}] ${n.action}: ${n.reason}`);
  }
  return lines.join('\n');
}

export function attach($main, ctx) {
  $main.querySelector('#dd-gen')?.addEventListener('click', async () => {
    local.loading = true; ctx.render();
    const [a, b] = await Promise.all([
      ctx.aiCall({ feature: 'insights', jobs: ctx.state.jobs }),
      ctx.aiCall({ feature: 'nudges', jobs: ctx.state.jobs })
    ]);
    local.loading = false;
    if (a?.ok) local.insights = String(a.result || '').trim();
    if (b?.ok) local.nudges = Array.isArray(b.result) ? b.result : [];
    local.generatedAt = new Date().toISOString();
    ctx.render();
  });

  $main.querySelector('#dd-email')?.addEventListener('click', () => {
    const text = buildDigestText(ctx.state);
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `daily-digest-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    ctx.toast('Digest downloaded.', 'success');
  });
}
