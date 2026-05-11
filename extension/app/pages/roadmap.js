// Career milestones timeline. Auto-populated from user's job changes,
// interviews, offers + AI-projected future milestones.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const local = {
  loading: false,
  projection: null
};

function pastMilestones(state) {
  const out = [];
  for (const j of state.jobs || []) {
    if (j.submittedAt) out.push({ when: j.submittedAt, label: `Applied to ${j.title} @ ${j.company}`, kind: 'applied' });
    if (j.status === 'interview' && j.nextInterviewAt) out.push({ when: j.nextInterviewAt, label: `Interview: ${j.title} @ ${j.company}`, kind: 'interview' });
    if (j.status === 'offer') out.push({ when: j.updatedAt, label: `Offer received: ${j.title} @ ${j.company}`, kind: 'offer' });
    if (j.status === 'rejected') out.push({ when: j.updatedAt, label: `Rejected: ${j.title} @ ${j.company}`, kind: 'rejected' });
  }
  return out.sort((a, b) => (a.when || '').localeCompare(b.when || ''));
}

function colorOf(kind) {
  return ({
    applied: 'var(--primary)',
    interview: 'var(--warn)',
    offer: 'var(--success)',
    rejected: 'var(--danger)',
    future: 'var(--primary2)'
  })[kind] || 'var(--muted)';
}

export function render(state) {
  const past = pastMilestones(state);
  const proj = Array.isArray(local.projection) ? local.projection : [];

  return `
    <div class="page-h">
      <div><h1>Career Roadmap</h1><div class="sub">Your past milestones plus AI-projected next steps.</div></div>
      <button class="btn primary" id="rm-project" ${local.loading ? 'disabled' : ''}>${local.loading ? 'Projecting…' : '✨ Project 1/3/5y'}</button>
    </div>

    <div class="card" style="padding:14px">
      <h3 style="margin:0 0 10px">Past — ${past.length} milestones</h3>
      <div style="display:flex;flex-direction:column;gap:6px;max-height:320px;overflow:auto">
        ${past.length === 0 ? `<div style="color:var(--muted);font-size:13px">No milestones yet — apply to a job to seed this.</div>` :
          past.map((m) => `
            <div style="display:flex;align-items:center;gap:10px;padding:6px;border-left:3px solid ${colorOf(m.kind)};background:var(--bg);border-radius:4px">
              <div style="width:90px;font-size:11px;color:var(--muted)">${esc(m.when ? new Date(m.when).toLocaleDateString() : '')}</div>
              <div style="flex:1;font-size:13px">${esc(m.label)}</div>
              <div style="font-size:10px;text-transform:uppercase;color:${colorOf(m.kind)};font-weight:700">${esc(m.kind)}</div>
            </div>`).join('')}
      </div>
    </div>

    <div class="card" style="padding:14px;margin-top:12px">
      <h3 style="margin:0 0 10px">AI projection ${proj.length ? '(' + proj.length + ' milestones)' : ''}</h3>
      ${proj.length === 0 ? `<div style="color:var(--muted);font-size:13px">Click ✨ Project 1/3/5y to generate.</div>` :
        ['1y','3y','5y'].map((h) => {
          const sub = proj.filter((p) => p.horizon === h);
          if (sub.length === 0) return '';
          return `
            <div style="margin-bottom:10px">
              <div style="font-weight:700;color:var(--primary);margin-bottom:4px">${h}</div>
              <div style="display:flex;flex-direction:column;gap:4px">
                ${sub.map((p) => `
                  <div style="padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg)">
                    <div style="font-weight:600;font-size:13px">${esc(p.milestone || '')}</div>
                    <div style="font-size:12px;color:var(--muted);margin-top:2px">${esc(p.rationale || '')}</div>
                  </div>`).join('')}
              </div>
            </div>`;
        }).join('')}
    </div>
  `;
}

export function attach($main, ctx) {
  $main.querySelector('#rm-project')?.addEventListener('click', async () => {
    local.loading = true; ctx.render();
    const r = await ctx.aiCall({ feature: 'careerPath', jobs: ctx.state.jobs, profile: ctx.state.profile });
    local.loading = false;
    if (!r?.ok) { ctx.toast('Failed: ' + (r?.error || ''), 'danger'); ctx.render(); return; }
    local.projection = Array.isArray(r.result) ? r.result : [];
    ctx.render();
  });
}
