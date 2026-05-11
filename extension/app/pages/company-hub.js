// Searchable list of every company. Open a card → AI research panel + related jobs/contacts.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const local = {
  search: '',
  selected: '',
  research: {}, // company -> result
  loading: {} // company -> bool
};

function companyList(state) {
  const set = new Set();
  for (const j of state.jobs || []) if (j.company) set.add(j.company);
  for (const c of state.companies || []) if (c.name) set.add(c.name);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function relatedJobs(state, name) {
  return (state.jobs || []).filter((j) => j.company === name);
}
function relatedContacts(state, name) {
  return (state.contacts || []).filter((c) => c.company === name);
}

export function render(state) {
  const all = companyList(state);
  const q = local.search.toLowerCase();
  const filtered = q ? all.filter((c) => c.toLowerCase().includes(q)) : all;
  const sel = local.selected;
  const job0 = sel ? relatedJobs(state, sel) : [];
  const ct = sel ? relatedContacts(state, sel) : [];
  const res = local.research[sel];

  return `
    <div class="page-h"><div><h1>Company Hub</h1><div class="sub">${all.length} compan${all.length === 1 ? 'y' : 'ies'} you've interacted with.</div></div></div>
    <div style="display:grid;grid-template-columns:280px 1fr;gap:14px">
      <div class="card" style="padding:12px">
        <input id="ch-search" placeholder="Filter companies…" value="${esc(local.search)}" style="width:100%;padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;margin-bottom:8px"/>
        <div style="max-height:540px;overflow:auto;display:flex;flex-direction:column;gap:4px">
          ${filtered.length === 0 ? `<div style="color:var(--muted);font-size:12px">No companies.</div>` :
            filtered.map((c) => `
              <div data-ch-pick="${esc(c)}" style="padding:8px;border:1px solid var(--border);border-radius:6px;cursor:pointer;font-size:13px;${local.selected === c ? 'border-color:var(--primary);background:rgba(99,102,241,0.10)' : ''}">
                <div style="font-weight:600">${esc(c)}</div>
                <div style="font-size:11px;color:var(--muted)">${relatedJobs(state, c).length} job(s)</div>
              </div>`).join('')}
        </div>
      </div>
      <div class="card" style="padding:14px;min-height:540px">
        ${!sel ? `<div style="color:var(--muted);text-align:center;padding:40px">Select a company on the left.</div>` : `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
            <h2 style="margin:0">${esc(sel)}</h2>
            <button class="btn primary" id="ch-research" ${local.loading[sel] ? 'disabled' : ''}>${local.loading[sel] ? 'Researching…' : '✨ Research'}</button>
          </div>
          ${res ? `
            <div style="margin-bottom:14px">
              <div style="font-size:13px;margin-bottom:6px"><strong>TL;DR:</strong> ${esc(res.tldr || '')}</div>
              <div style="font-size:12px"><strong>Hiring pace:</strong> ${esc(res.hiring_pace_estimate || '')}</div>
              <div style="font-size:12px"><strong>Culture (rumored):</strong> ${esc(res.rumored_culture || '')}</div>
              <div style="font-size:12px"><strong>Glassdoor (knowledge-only):</strong> ${esc(res.glassdoor_summary || '')}</div>
              ${res.recent_news_topics?.length ? `<div style="font-size:12px;margin-top:6px"><strong>News topics:</strong> ${res.recent_news_topics.map(esc).join(', ')}</div>` : ''}
            </div>` : `<div style="color:var(--muted);font-size:13px;margin-bottom:12px">No research yet — click ✨ Research.</div>`}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div>
              <div style="font-weight:600;margin-bottom:4px">Related jobs (${job0.length})</div>
              ${job0.length === 0 ? `<div style="font-size:12px;color:var(--muted)">None.</div>` :
                `<div style="display:flex;flex-direction:column;gap:4px">${job0.map((j) => `<a href="#/job/${esc(j.id)}" style="padding:6px;border:1px solid var(--border);border-radius:6px;font-size:12px;text-decoration:none;color:var(--text)"><div style="font-weight:600">${esc(j.title)}</div><div style="color:var(--muted)">${esc(j.status)}</div></a>`).join('')}</div>`}
            </div>
            <div>
              <div style="font-weight:600;margin-bottom:4px">Contacts (${ct.length})</div>
              ${ct.length === 0 ? `<div style="font-size:12px;color:var(--muted)">None.</div>` :
                `<div style="display:flex;flex-direction:column;gap:4px">${ct.map((c) => `<div style="padding:6px;border:1px solid var(--border);border-radius:6px;font-size:12px"><div style="font-weight:600">${esc(c.name || '')}</div><div style="color:var(--muted)">${esc(c.title || c.role || '')}</div></div>`).join('')}</div>`}
            </div>
          </div>
          <div style="margin-top:14px;padding-top:10px;border-top:1px dashed var(--border);font-size:12px;color:var(--muted)">News placeholder — wire to a real news API later.</div>
        `}
      </div>
    </div>
  `;
}

export function attach($main, ctx) {
  $main.querySelector('#ch-search')?.addEventListener('input', (e) => { local.search = e.target.value; ctx.render(); });
  $main.querySelectorAll('[data-ch-pick]').forEach((el) => el.addEventListener('click', () => {
    local.selected = el.dataset.chPick; ctx.render();
  }));
  $main.querySelector('#ch-research')?.addEventListener('click', async () => {
    const c = local.selected;
    if (!c) return;
    local.loading[c] = true; ctx.render();
    const r = await ctx.aiCall({ feature: 'companyResearchDeep', company: c });
    local.loading[c] = false;
    if (!r?.ok) { ctx.toast('Failed: ' + (r?.error || ''), 'danger'); ctx.render(); return; }
    local.research[c] = r.result;
    ctx.render();
  });
}
