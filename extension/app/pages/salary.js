// Salary research — track comp ranges across roles + companies. Auto-import
// from captured jobs that have parsed compensation. Aggregated stats card.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const local = { showAdd: false, draft: { company: '', title: '', base: '', bonus: '', equity: '', location: '', source: 'manual', notes: '' } };

function parseFirstNumber(s) {
  if (!s) return 0;
  const m = String(s).match(/[\d][\d,]*(?:\.\d+)?/);
  if (!m) return 0;
  let n = Number(m[0].replace(/,/g, ''));
  if (/k\b/i.test(s)) n *= 1000;
  if (/m\b/i.test(s)) n *= 1_000_000;
  return n;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function combinedEntries(state) {
  const manual = (state.salaryEntries || []).map((e) => ({ ...e, _from: 'manual' }));
  const fromJobs = (state.jobs || [])
    .filter((j) => j.compensation)
    .map((j) => ({
      id: 'job-' + j.id,
      company: j.company,
      title: j.title,
      base: j.compensation,
      bonus: '', equity: '',
      location: j.location || '',
      source: 'captured:' + (j.source || 'job'),
      _from: 'job'
    }));
  return [...manual, ...fromJobs];
}

function fmt(n) {
  if (!n) return '—';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000) return '$' + Math.round(n / 1000) + 'K';
  return '$' + n;
}

export function render(state) {
  const entries = combinedEntries(state);
  const baseNums = entries.map((e) => parseFirstNumber(e.base)).filter((n) => n > 0);
  const byTitle = {};
  for (const e of entries) {
    const t = (e.title || 'Unknown').trim();
    (byTitle[t] = byTitle[t] || []).push(parseFirstNumber(e.base));
  }
  const byCompany = {};
  for (const e of entries) {
    const c = (e.company || 'Unknown').trim();
    (byCompany[c] = byCompany[c] || []).push(parseFirstNumber(e.base));
  }
  const bySource = {};
  for (const e of entries) {
    const s = (e.source || '—').trim();
    (bySource[s] = bySource[s] || []).push(parseFirstNumber(e.base));
  }
  const topTitles = Object.entries(byTitle).map(([k, v]) => [k, median(v.filter((n) => n > 0))]).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topCompanies = Object.entries(byCompany).map(([k, v]) => [k, median(v.filter((n) => n > 0))]).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topSources = Object.entries(bySource).map(([k, v]) => [k, median(v.filter((n) => n > 0))]).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return `
    <div class="page-h">
      <div><h1>Salary Research</h1><div class="sub">${entries.length} data point${entries.length === 1 ? '' : 's'} · overall median ${fmt(median(baseNums.filter((n) => n > 0)))}</div></div>
      <button class="btn primary" id="sal-add-toggle">${local.showAdd ? 'Cancel' : '+ Add entry'}</button>
    </div>

    <div class="grid-3">
      <div class="card">
        <h3 style="margin-top:0;font-size:13px">Median by title</h3>
        ${topTitles.length === 0 ? `<div class="empty">No data.</div>` : topTitles.map(([k, v]) => `
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)"><span>${esc(k)}</span><strong>${fmt(v)}</strong></div>
        `).join('')}
      </div>
      <div class="card">
        <h3 style="margin-top:0;font-size:13px">Median by company</h3>
        ${topCompanies.length === 0 ? `<div class="empty">No data.</div>` : topCompanies.map(([k, v]) => `
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)"><span>${esc(k)}</span><strong>${fmt(v)}</strong></div>
        `).join('')}
      </div>
      <div class="card">
        <h3 style="margin-top:0;font-size:13px">Median by source</h3>
        ${topSources.length === 0 ? `<div class="empty">No data.</div>` : topSources.map(([k, v]) => `
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)"><span>${esc(k)}</span><strong>${fmt(v)}</strong></div>
        `).join('')}
      </div>
    </div>

    ${local.showAdd ? `
      <div class="card" style="margin-top:14px">
        <h3 style="margin-top:0;font-size:13px">New entry</h3>
        <div class="grid-3" style="gap:8px">
          ${['company','title','base','bonus','equity','location','source'].map((f) => `
            <label style="font-size:11px;color:var(--muted)">${f}<input type="text" data-sal-field="${f}" value="${esc(local.draft[f] || '')}" style="width:100%;padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px" /></label>
          `).join('')}
        </div>
        <textarea data-sal-field="notes" placeholder="Notes…" style="width:100%;margin-top:8px;padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px">${esc(local.draft.notes || '')}</textarea>
        <div style="margin-top:8px"><button class="btn primary" id="sal-save">Save entry</button></div>
      </div>
    ` : ''}

    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0;font-size:13px">All entries</h3>
      ${entries.length === 0 ? `<div class="empty">Nothing yet.</div>` : `
        <div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="text-align:left;color:var(--muted);font-weight:500">
            <th style="padding:6px;border-bottom:1px solid var(--border)">Company</th>
            <th style="padding:6px;border-bottom:1px solid var(--border)">Title</th>
            <th style="padding:6px;border-bottom:1px solid var(--border)">Base</th>
            <th style="padding:6px;border-bottom:1px solid var(--border)">Location</th>
            <th style="padding:6px;border-bottom:1px solid var(--border)">Source</th>
            <th style="padding:6px;border-bottom:1px solid var(--border)"></th>
          </tr></thead>
          <tbody>
            ${entries.map((e) => `<tr>
              <td style="padding:6px;border-bottom:1px solid var(--border)">${esc(e.company || '')}</td>
              <td style="padding:6px;border-bottom:1px solid var(--border)">${esc(e.title || '')}</td>
              <td style="padding:6px;border-bottom:1px solid var(--border)">${esc(e.base || '')}</td>
              <td style="padding:6px;border-bottom:1px solid var(--border)">${esc(e.location || '')}</td>
              <td style="padding:6px;border-bottom:1px solid var(--border)"><span class="pill source">${esc(e.source || '—')}</span></td>
              <td style="padding:6px;border-bottom:1px solid var(--border);text-align:right">
                <button class="btn small" data-sal-research="${esc(e.title || '')}">Research</button>
                ${e._from === 'manual' ? `<button class="btn small danger" data-sal-del="${esc(e.id)}">Delete</button>` : ''}
              </td>
            </tr>`).join('')}
          </tbody>
        </table></div>`}
    </div>
  `;
}

export function attach($main, ctx) {
  const { send } = ctx;
  $main.querySelector('#sal-add-toggle')?.addEventListener('click', () => { local.showAdd = !local.showAdd; ctx.render(); });
  $main.querySelectorAll('[data-sal-field]').forEach((el) => el.addEventListener('input', (e) => {
    local.draft[el.dataset.salField] = e.target.value;
  }));
  $main.querySelector('#sal-save')?.addEventListener('click', async () => {
    if (!local.draft.title || !local.draft.base) { ctx.toast('Title + base are required.', 'danger'); return; }
    await send('add-salaryEntries', { ...local.draft });
    local.showAdd = false;
    local.draft = { company: '', title: '', base: '', bonus: '', equity: '', location: '', source: 'manual', notes: '' };
    await ctx.reload('salaryEntries');
    ctx.toast('Saved.', 'success');
  });
  $main.querySelectorAll('[data-sal-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this entry?')) return;
    await send('delete-salaryEntries', { id: b.dataset.salDel });
    await ctx.reload('salaryEntries');
  }));
  $main.querySelectorAll('[data-sal-research]').forEach((b) => b.addEventListener('click', () => {
    const t = encodeURIComponent(b.dataset.salResearch);
    window.open(`https://www.linkedin.com/salary/search?keywords=${t}`, '_blank', 'noreferrer');
  }));
}
