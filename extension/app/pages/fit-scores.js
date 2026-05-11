// v8: Job-fit scores page. Computes a 0-100 match score per job from profile
// skills + JD keywords. Pure tokenization + intersection — no AI required.
import { computeFit } from '../../lib/fit.js';
export { computeFit };
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

let _filter = 'all';
let _busy = false;

export function render(state) {
  const jobs = (state.jobs || []).filter((j) => !['archived', 'withdrawn'].includes(j.status));
  const profile = state.profile || {};
  const cached = new Map((state.fitScores || []).map((f) => [f.jobId, f]));

  const rows = jobs.map((j) => {
    const cache = cached.get(j.id);
    const fit = cache && (Date.now() - new Date(cache.computedAt || 0).getTime() < 86400000)
      ? cache : { ...computeFit(j, profile), jobId: j.id, computedAt: new Date().toISOString() };
    return { job: j, fit };
  });

  const filtered = _filter === 'high' ? rows.filter((r) => r.fit.score >= 70)
                 : _filter === 'low'  ? rows.filter((r) => r.fit.score < 40)
                 : rows;

  filtered.sort((a, b) => (b.fit.score || 0) - (a.fit.score || 0));

  return `
    <div class="page-h">
      <div><h1>🎯 Job-Fit Scores</h1>
        <div class="sub">${rows.length} active job${rows.length === 1 ? '' : 's'} scored against your profile</div>
      </div>
      <div style="display:flex;gap:8px">
        <select id="fit-filter">
          <option value="all"${_filter === 'all' ? ' selected' : ''}>All</option>
          <option value="high"${_filter === 'high' ? ' selected' : ''}>≥ 70 (strong)</option>
          <option value="low"${_filter === 'low' ? ' selected' : ''}>&lt; 40 (weak)</option>
        </select>
        <button class="btn" id="fit-recompute" ${_busy ? 'disabled' : ''}>${_busy ? 'Computing…' : 'Recompute all'}</button>
      </div>
    </div>
    ${rows.length === 0 ? `<div class="card empty"><strong>No active jobs.</strong> Add some applications first.</div>` :
    `<div class="card"><div class="list">
      ${filtered.map(({ job, fit }) => rowHtml(job, fit)).join('')}
    </div></div>`}
  `;
}

function rowHtml(j, f) {
  const color = f.score >= 70 ? 'var(--success, #2ea043)' : f.score >= 40 ? 'var(--warning, #d29922)' : 'var(--danger, #cf222e)';
  return `
    <div class="list-row" data-fit-job="${esc(j.id)}">
      <div style="flex:1;min-width:0">
        <div class="t">${esc(j.title || '(untitled)')} · <span style="color:var(--muted)">${esc(j.company || '')}</span></div>
        <div class="s" style="font-size:12px;color:var(--muted)">
          ${(f.matched || []).slice(0, 8).map((m) => `<span class="pill" style="margin-right:4px">${esc(m)}</span>`).join('')}
          ${(f.missing || []).slice(0, 4).map((m) => `<span class="pill" style="margin-right:4px;opacity:0.55">−${esc(m)}</span>`).join('')}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;min-width:130px;justify-content:flex-end">
        <div style="font-size:24px;font-weight:600;color:${color}">${f.score}</div>
        <a class="btn small" href="#/job/${esc(j.id)}">Open →</a>
      </div>
    </div>
  `;
}

export function attach($main, ctx) {
  const { send, toast, render: rerender } = ctx;
  $main.querySelector('#fit-filter')?.addEventListener('change', (e) => { _filter = e.target.value; rerender(); });
  $main.querySelector('#fit-recompute')?.addEventListener('click', async () => {
    _busy = true; rerender();
    try {
      const r = await send('recompute-fit-scores', {});
      if (r?.ok) toast(`Scored ${r.count} jobs.`, 'success');
    } finally { _busy = false; rerender(); }
  });
}
