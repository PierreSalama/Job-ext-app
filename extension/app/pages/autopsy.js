// v8: Application Autopsy. For each rejected job, generate (or load cached)
// a breakdown of likely gaps and suggested next steps using AI when available.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

let _busy = {};

export function render(state) {
  const rejected = (state.jobs || []).filter((j) => j.status === 'rejected').sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const auto = new Map((state.autopsies || []).map((a) => [a.jobId, a]));
  return `
    <div class="page-h">
      <div><h1>🩺 Application Autopsy</h1>
      <div class="sub">${rejected.length} rejected application${rejected.length === 1 ? '' : 's'} · learn from every miss</div></div>
    </div>
    ${rejected.length === 0 ? `<div class="card empty"><strong>No rejections yet.</strong> Keep going — and when one happens, it'll show up here for analysis.</div>` :
    `<div class="card"><div class="list">
      ${rejected.map((j) => {
        const a = auto.get(j.id);
        const isBusy = _busy[j.id];
        return `
          <div class="list-row" style="flex-direction:column;align-items:stretch" data-autopsy-row="${esc(j.id)}">
            <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
              <div class="t">${esc(j.title)} · <span style="color:var(--muted)">${esc(j.company)}</span></div>
              <div style="display:flex;gap:6px">
                <button class="btn small" data-autopsy-run="${esc(j.id)}" ${isBusy ? 'disabled' : ''}>${isBusy ? 'Analyzing…' : (a ? 'Re-analyze' : 'Analyze')}</button>
                <a class="btn small" href="#/job/${esc(j.id)}">Open →</a>
              </div>
            </div>
            ${a ? `
              <div class="card" style="margin-top:6px">
                <div style="font-size:13px;line-height:1.5">${escMd(a.summary || '')}</div>
                ${(a.gaps || []).length ? `
                  <h4 style="margin-top:10px;font-size:13px">Likely gaps</h4>
                  <ul style="margin:4px 0 0 18px;font-size:13px">${a.gaps.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
                ` : ''}
                ${(a.actions || []).length ? `
                  <h4 style="margin-top:10px;font-size:13px">Action items</h4>
                  <ul style="margin:4px 0 0 18px;font-size:13px">${a.actions.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
                ` : ''}
                <div style="margin-top:6px;font-size:11px;color:var(--muted)">Generated ${esc(new Date(a.createdAt).toLocaleString())}${a.provider ? ' · ' + esc(a.provider) : ''}</div>
              </div>
            ` : ''}
          </div>
        `;
      }).join('')}
    </div></div>`}
  `;
}

function escMd(s) {
  // Basic line breaks + bold/italic
  let out = esc(s).replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return `<p style="margin:0">${out}</p>`;
}

export function attach($main, ctx) {
  const { send, toast, render: rerender } = ctx;
  $main.querySelectorAll('[data-autopsy-run]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.autopsyRun;
    _busy[id] = true; rerender();
    try {
      const r = await send('run-autopsy', { jobId: id });
      if (r?.ok) toast('Autopsy ready.', 'success');
      else toast(r?.error || 'Could not run autopsy.', 'danger');
    } finally { _busy[id] = false; rerender(); }
  }));
}
