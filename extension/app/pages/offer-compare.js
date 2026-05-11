// Side-by-side compare of all jobs with status='offer'.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const local = {
  loading: false,
  ranking: null,
  winnerExplanation: '',
  wlbCache: {}, // jobId -> {score, signals, red_flags}
  cultureCache: {}, // jobId -> {score, alignments, frictions}
  commuteCache: {} // jobId -> estimate
};

function offers(state) {
  return (state.jobs || []).filter((j) => j.status === 'offer');
}

function parseSalary(s) {
  if (!s) return 0;
  const m = String(s).match(/(\d{1,3}(?:[,\d]{0,12})?)(?:\s*[KkMm])?/);
  if (!m) return 0;
  const n = parseInt(m[1].replace(/,/g, ''), 10);
  if (/[Kk]/.test(s)) return n * 1000;
  if (/[Mm]/.test(s)) return n * 1000000;
  return n;
}

export function render(state) {
  const list = offers(state);
  if (list.length === 0) {
    return `
      <div class="page-h"><div><h1>Offer Compare</h1><div class="sub">Side-by-side compare of every active offer.</div></div></div>
      <div class="card empty">No offers yet. When a job's status is "offer" it shows up here.</div>
    `;
  }

  const winnerScore = (id) => local.ranking?.find((r) => r.offerId === id)?.score;

  return `
    <div class="page-h">
      <div><h1>Offer Compare</h1><div class="sub">${list.length} active offer${list.length === 1 ? '' : 's'}.</div></div>
      <div style="display:flex;gap:6px">
        <button class="btn primary" id="oc-run" ${local.loading ? 'disabled' : ''}>${local.loading ? 'Analyzing…' : '✨ Analyze + rank'}</button>
      </div>
    </div>
    ${local.winnerExplanation ? `
      <div class="card" style="margin-bottom:12px;border:1px solid var(--primary)">
        <div style="font-weight:600;color:var(--primary);margin-bottom:4px">🏆 Winner</div>
        <div>${esc(local.winnerExplanation)}</div>
      </div>` : ''}
    <div style="display:grid;grid-template-columns:repeat(${Math.min(list.length, 4)}, minmax(220px,1fr));gap:12px;overflow-x:auto">
      ${list.map((j) => renderColumn(j, winnerScore(j.id), local.wlbCache[j.id], local.cultureCache[j.id], local.commuteCache[j.id])).join('')}
    </div>
  `;
}

function renderColumn(job, score, wlb, culture, commute) {
  return `
    <div class="card" style="padding:12px;display:flex;flex-direction:column;gap:8px">
      <div style="font-weight:700">${esc(job.title)}</div>
      <div style="color:var(--muted);font-size:12px">${esc(job.company || '')}</div>
      ${score != null ? `<div style="background:var(--primary);color:#fff;padding:4px 8px;border-radius:6px;font-size:13px;font-weight:700;align-self:flex-start">Score ${score}</div>` : ''}
      <div style="font-size:12px"><strong>Base:</strong> ${esc(job.compensation || '—')}</div>
      <div style="font-size:12px"><strong>Bonus:</strong> ${esc(job.bonus || '—')}</div>
      <div style="font-size:12px"><strong>Equity:</strong> ${esc(job.equity || '—')}</div>
      <div style="font-size:12px"><strong>Total:</strong> ${esc(job.totalComp || '—')}</div>
      <div style="font-size:12px"><strong>Location:</strong> ${esc(job.location || '—')}</div>
      <div style="font-size:12px"><strong>Commute:</strong> ${esc(commute || '—')}</div>
      <div style="font-size:12px"><strong>WLB:</strong> ${wlb ? wlb.score + '/100' : '—'}</div>
      <div style="font-size:12px"><strong>Culture fit:</strong> ${culture ? culture.score + '/100' : '—'}</div>
      <div style="display:flex;gap:4px;margin-top:6px">
        <button class="btn small" data-oc-wlb="${esc(job.id)}">Estimate WLB</button>
        <button class="btn small" data-oc-cul="${esc(job.id)}">Culture fit</button>
      </div>
    </div>
  `;
}

export function attach($main, ctx) {
  $main.querySelector('#oc-run')?.addEventListener('click', async () => {
    const list = offers(ctx.state);
    if (list.length === 0) return;
    local.loading = true; ctx.render();
    const offerObjs = list.map((j) => ({
      offerId: j.id, base: j.compensation, bonus: j.bonus, equity: j.equity,
      benefits: j.benefits, location: j.location, role: j.title, company: j.company
    }));
    const r = await ctx.aiCall({ feature: 'compareOffers', offers: offerObjs, profile: ctx.state.profile });
    local.loading = false;
    if (!r?.ok) { ctx.toast('Failed: ' + (r?.error || ''), 'danger'); ctx.render(); return; }
    local.ranking = r.result?.ranking || [];
    local.winnerExplanation = r.result?.winner_explanation || '';
    ctx.render();
  });

  $main.querySelectorAll('[data-oc-wlb]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.ocWlb;
    const job = (ctx.state.jobs || []).find((j) => j.id === id);
    if (!job) return;
    const r = await ctx.aiCall({ feature: 'wlbEstimate', job });
    if (r?.ok) { local.wlbCache[id] = r.result; ctx.render(); }
  }));

  $main.querySelectorAll('[data-oc-cul]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.ocCul;
    const job = (ctx.state.jobs || []).find((j) => j.id === id);
    if (!job) return;
    const r = await ctx.aiCall({ feature: 'cultureFit', job, profile: ctx.state.profile });
    if (r?.ok) { local.cultureCache[id] = r.result; ctx.render(); }
  }));
}
