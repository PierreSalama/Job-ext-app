// Skills — track user skills + level/interest, extract from JDs, show gap analysis.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'Expert'];
const INTERESTS = ['low', 'med', 'high'];
const local = { extractingFor: null, draft: { name: '', level: 'Intermediate', interest: 'med' }, showAdd: false };

function jdSkillCounts(state) {
  const counts = {};
  for (const j of state.jobs || []) {
    const arr = Array.isArray(j.aiSkills) ? j.aiSkills : (Array.isArray(j.skills) ? j.skills : []);
    for (const s of arr) {
      const k = String(s).trim();
      if (!k) continue;
      counts[k] = (counts[k] || 0) + 1;
    }
  }
  return counts;
}

export function render(state) {
  const skills = (state.skills || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const jdCounts = jdSkillCounts(state);
  const top = Object.entries(jdCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const known = new Set(skills.map((s) => (s.name || '').toLowerCase()));
  const gap = top.filter(([k]) => !known.has(k.toLowerCase())).slice(0, 8);
  const max = Math.max(1, ...top.map((t) => t[1]));

  return `
    <div class="page-h">
      <div><h1>Skills</h1><div class="sub">${skills.length} tracked · ${Object.keys(jdCounts).length} mentioned in your jobs.</div></div>
      <div style="display:flex;gap:6px">
        <button class="btn" id="sk-extract">✨ Extract from latest job</button>
        <button class="btn primary" id="sk-add-toggle">${local.showAdd ? 'Cancel' : '+ Add skill'}</button>
      </div>
    </div>

    ${local.showAdd ? `
      <div class="card">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
          <input type="text" data-sk-field="name" placeholder="Skill (e.g., React)" value="${esc(local.draft.name)}" style="flex:1;min-width:200px;padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px" />
          <select data-sk-field="level" style="padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px">${LEVELS.map((l) => `<option${local.draft.level === l ? ' selected' : ''}>${l}</option>`).join('')}</select>
          <select data-sk-field="interest" style="padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px">${INTERESTS.map((i) => `<option value="${i}"${local.draft.interest === i ? ' selected' : ''}>${i} interest</option>`).join('')}</select>
          <button class="btn primary" id="sk-save">Save</button>
        </div>
      </div>
    ` : ''}

    <div class="grid-2" style="margin-top:14px">
      <div class="card">
        <h3 style="margin-top:0;font-size:14px">Your skills</h3>
        ${skills.length === 0 ? `<div class="empty">None yet.</div>` : `
          <div style="display:flex;flex-direction:column;gap:6px">
            ${skills.map((s) => `<div class="list-row" style="cursor:default">
              <div>
                <div class="t">${esc(s.name)}</div>
                <div class="s">${esc(s.level || '')} · ${esc(s.interest || '')} interest${s.endorsements ? ' · ' + s.endorsements + ' endorsements' : ''}${s.lastUsed ? ' · last used ' + esc(s.lastUsed) : ''}</div>
              </div>
              <div style="display:flex;gap:4px">
                <button class="btn small" data-sk-endorse="${esc(s.id)}">+1</button>
                <button class="btn small danger" data-sk-del="${esc(s.id)}">×</button>
              </div>
            </div>`).join('')}
          </div>`}
      </div>
      <div class="card">
        <h3 style="margin-top:0;font-size:14px">Top skills mentioned in jobs you applied to</h3>
        ${top.length === 0 ? `<div class="empty">Run the AI "Skills" feature on a job to populate this.</div>` : `
          <div style="display:flex;flex-direction:column;gap:4px">
            ${top.map(([k, v]) => `<div style="display:flex;align-items:center;gap:8px;font-size:12px">
              <span style="width:120px">${esc(k)}</span>
              <div style="flex:1;height:8px;background:var(--bg);border-radius:4px;overflow:hidden"><div style="height:100%;width:${(v / max) * 100}%;background:var(--primary)"></div></div>
              <span style="width:30px;text-align:right;color:var(--muted)">${v}</span>
            </div>`).join('')}
          </div>`}
      </div>
    </div>

    ${gap.length ? `
      <div class="card" style="margin-top:14px">
        <h3 style="margin-top:0;font-size:14px">💡 Suggested skills to learn</h3>
        <div style="color:var(--muted);font-size:12px;margin-bottom:8px">These come up in jobs you've applied to but aren't on your list.</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${gap.map(([k, v]) => `<button class="btn small" data-sk-quick-add="${esc(k)}" title="${v} mentions">+ ${esc(k)} (${v})</button>`).join('')}
        </div>
      </div>` : ''}
  `;
}

export function attach($main, ctx) {
  const { send, aiCall } = ctx;
  $main.querySelector('#sk-add-toggle')?.addEventListener('click', () => { local.showAdd = !local.showAdd; ctx.render(); });
  $main.querySelectorAll('[data-sk-field]').forEach((el) => el.addEventListener('input', (e) => { local.draft[el.dataset.skField] = e.target.value; }));
  $main.querySelector('#sk-save')?.addEventListener('click', async () => {
    if (!local.draft.name) { ctx.toast('Name required.', 'danger'); return; }
    await send('add-skills', { ...local.draft, endorsements: 0 });
    local.draft = { name: '', level: 'Intermediate', interest: 'med' };
    local.showAdd = false;
    await ctx.reload('skills');
  });
  $main.querySelectorAll('[data-sk-quick-add]').forEach((b) => b.addEventListener('click', async () => {
    await send('add-skills', { name: b.dataset.skQuickAdd, level: 'Beginner', interest: 'med', endorsements: 0 });
    await ctx.reload('skills');
  }));
  $main.querySelectorAll('[data-sk-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this skill?')) return;
    await send('delete-skills', { id: b.dataset.skDel });
    await ctx.reload('skills');
  }));
  $main.querySelectorAll('[data-sk-endorse]').forEach((b) => b.addEventListener('click', async () => {
    const s = (ctx.state.skills || []).find((x) => x.id === b.dataset.skEndorse);
    if (!s) return;
    await send('patch-skills', { id: s.id, patch: { endorsements: (s.endorsements || 0) + 1, lastUsed: new Date().toISOString().slice(0, 10) } });
    await ctx.reload('skills');
  }));
  $main.querySelector('#sk-extract')?.addEventListener('click', async () => {
    const job = (ctx.state.jobs || []).slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0];
    if (!job) { ctx.toast('No jobs available.', 'danger'); return; }
    ctx.toast('Extracting skills…', 'info');
    const r = await aiCall({ feature: 'skills', job });
    if (!r?.ok) { ctx.toast('Failed.', 'danger'); return; }
    await ctx.send('patch-job', { id: job.id, patch: { aiSkills: r.result || [] } });
    ctx.toast(`Extracted ${(r.result || []).length} skills from ${job.title}.`, 'success');
  });
}
