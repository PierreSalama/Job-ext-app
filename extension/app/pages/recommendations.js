// Recommendations — full standalone page. Generate more, group by source, pin to dashboard.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const local = { generating: false };

export function render(state) {
  const recs = state.recommendations || [];
  const bySource = recs.reduce((acc, r) => {
    const k = r.source || 'Other';
    (acc[k] = acc[k] || []).push(r);
    return acc;
  }, {});
  const groups = Object.entries(bySource).sort((a, b) => b[1].length - a[1].length);
  const pinned = new Set((state.settings?.pinnedRecommendations || []));

  return `
    <div class="page-h">
      <div><h1>Recommended jobs</h1><div class="sub">${recs.length} suggestion${recs.length === 1 ? '' : 's'} across ${groups.length} source${groups.length === 1 ? '' : 's'}.</div></div>
      <button class="btn primary" id="rec-gen" ${local.generating ? 'disabled' : ''}>${local.generating ? 'Asking AI…' : '✨ Generate more'}</button>
    </div>

    ${recs.length === 0 ? `<div class="card empty"><strong>No recommendations yet.</strong>Click Generate to ask the AI for personalized job-search queries.</div>` :
      groups.map(([source, items]) => `
        <div class="card" style="margin-bottom:14px">
          <h3 style="margin-top:0;font-size:14px;display:flex;justify-content:space-between"><span><span class="pill source">${esc(source)}</span> &nbsp;${items.length} suggestion${items.length === 1 ? '' : 's'}</span></h3>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
            ${items.map((r) => {
              const isPinned = pinned.has(r.id);
              return `<div class="rec-card">
                <div>
                  <div class="keys">${esc(r.keywords || '')} ${r.location ? `<span style="font-weight:400;color:var(--muted);font-size:12px">in ${esc(r.location)}</span>` : ''}</div>
                  <div class="why">${esc(r.rationale || '')}</div>
                </div>
                <div class="links" style="display:flex;gap:6px">
                  <a href="${esc(r.url)}" target="_blank" rel="noreferrer">Apply now →</a>
                  <button class="btn small${isPinned ? ' primary' : ''}" data-rec-pin="${esc(r.id)}">${isPinned ? '★ Pinned' : '☆ Pin'}</button>
                </div>
              </div>`;
            }).join('')}
          </div>
        </div>
      `).join('')
    }
  `;
}

export function attach($main, ctx) {
  const { send, aiCall } = ctx;
  $main.querySelector('#rec-gen')?.addEventListener('click', async () => {
    local.generating = true; ctx.render();
    const r = await aiCall({ feature: 'recommend', jobs: ctx.state.jobs, profile: ctx.state.profile });
    if (!r?.ok) { local.generating = false; ctx.toast('AI failed: ' + (r?.error || ''), 'danger'); ctx.render(); return; }
    const queries = Array.isArray(r.result) ? r.result : [];
    await send('persist-recommendations', { queries });
    local.generating = false;
    await ctx.reload('recommendations');
    ctx.toast(`Generated ${queries.length * 3} suggestions.`, 'success');
  });

  $main.querySelectorAll('[data-rec-pin]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.recPin;
    const cur = new Set(ctx.state.settings?.pinnedRecommendations || []);
    if (cur.has(id)) cur.delete(id); else cur.add(id);
    const r = await send('patch-settings', { pinnedRecommendations: Array.from(cur) });
    if (r?.ok) { ctx.state.settings = r.settings; ctx.render(); }
  }));
}
