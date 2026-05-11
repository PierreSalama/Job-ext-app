// Goals — weekly + monthly application targets, progress bars, streaks.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const local = { showAdd: false, draft: { period: 'weekly', target: 5, kind: 'applied' } };

const KINDS = [
  ['applied', 'Applications submitted'],
  ['submitted', 'Applications captured'],
  ['interviews', 'Interviews']
];

function periodStart(period) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (period === 'weekly') {
    const dow = d.getDay() || 7;
    d.setDate(d.getDate() - (dow - 1));
  } else {
    d.setDate(1);
  }
  return d.getTime();
}

function actualForGoal(g, jobs) {
  const start = periodStart(g.period);
  if (g.kind === 'interviews') {
    return jobs.filter((j) => {
      if (j.status !== 'interview') return false;
      const t = new Date(j.updatedAt || j.submittedAt || 0).getTime();
      return t >= start;
    }).length;
  }
  if (g.kind === 'applied') {
    return jobs.filter((j) => j.applied && j.submittedAt && new Date(j.submittedAt).getTime() >= start).length;
  }
  // submitted = captured (any job created in this period)
  return jobs.filter((j) => new Date(j.createdAt || 0).getTime() >= start).length;
}

function streak(jobs) {
  // Count consecutive days back from today with at least 1 application
  const days = new Set(jobs
    .filter((j) => j.applied && j.submittedAt)
    .map((j) => new Date(j.submittedAt).toDateString())
  );
  let count = 0;
  let d = new Date(); d.setHours(0, 0, 0, 0);
  while (days.has(d.toDateString())) {
    count++;
    d.setDate(d.getDate() - 1);
  }
  return count;
}

export function render(state) {
  const goals = (state.goals || []).slice().sort((a, b) => (a.period || '').localeCompare(b.period || ''));
  const s = streak(state.jobs || []);

  return `
    <div class="page-h">
      <div><h1>Goals</h1><div class="sub">Set targets, track progress, maintain a streak.</div></div>
      <div style="display:flex;gap:8px;align-items:center">
        <div class="card" style="padding:6px 12px;margin:0;display:flex;align-items:center;gap:6px"><span style="color:var(--warn);font-size:18px">🔥</span><strong>${s}-day streak</strong></div>
        <button class="btn primary" id="g-add">${local.showAdd ? 'Cancel' : '+ Add goal'}</button>
      </div>
    </div>

    ${local.showAdd ? `
      <div class="card">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
          <label style="font-size:12px;color:var(--muted)">Period<br>
            <select data-g-field="period" style="padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px">
              <option value="weekly"${local.draft.period === 'weekly' ? ' selected' : ''}>Weekly</option>
              <option value="monthly"${local.draft.period === 'monthly' ? ' selected' : ''}>Monthly</option>
            </select>
          </label>
          <label style="font-size:12px;color:var(--muted)">Kind<br>
            <select data-g-field="kind" style="padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px">
              ${KINDS.map(([k, l]) => `<option value="${k}"${local.draft.kind === k ? ' selected' : ''}>${l}</option>`).join('')}
            </select>
          </label>
          <label style="font-size:12px;color:var(--muted)">Target<br>
            <input type="number" min="1" data-g-field="target" value="${local.draft.target}" style="width:80px;padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px" />
          </label>
          <button class="btn primary" id="g-save">Save</button>
        </div>
      </div>
    ` : ''}

    <div style="margin-top:14px;display:flex;flex-direction:column;gap:10px">
      ${goals.length === 0 ? `<div class="card empty">No goals yet. Set one above.</div>` :
        goals.map((g) => {
          const actual = actualForGoal(g, state.jobs || []);
          const pct = Math.min(100, Math.round((actual / Math.max(1, g.target)) * 100));
          const done = actual >= g.target;
          return `<div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <strong>${esc((KINDS.find((k) => k[0] === g.kind) || [])[1] || g.kind)} · ${g.period === 'weekly' ? 'this week' : 'this month'}</strong>
              <div style="display:flex;gap:6px;align-items:center">
                <span style="color:${done ? 'var(--success)' : 'var(--muted)'};font-size:13px">${actual} / ${g.target}${done ? ' ✓' : ''}</span>
                <button class="btn small danger" data-g-del="${esc(g.id)}">Delete</button>
              </div>
            </div>
            <div style="height:8px;background:var(--bg);border-radius:4px;overflow:hidden">
              <div style="height:100%;width:${pct}%;background:${done ? 'var(--success)' : 'var(--primary)'};transition:width 0.3s"></div>
            </div>
          </div>`;
        }).join('')}
    </div>
  `;
}

export function attach($main, ctx) {
  const { send } = ctx;
  $main.querySelector('#g-add')?.addEventListener('click', () => { local.showAdd = !local.showAdd; ctx.render(); });
  $main.querySelectorAll('[data-g-field]').forEach((el) => el.addEventListener('change', (e) => {
    local.draft[el.dataset.gField] = el.dataset.gField === 'target' ? Number(e.target.value) : e.target.value;
  }));
  $main.querySelector('#g-save')?.addEventListener('click', async () => {
    if (!local.draft.target || local.draft.target < 1) { ctx.toast('Target must be ≥ 1.', 'danger'); return; }
    await send('add-goals', { ...local.draft });
    local.showAdd = false;
    await ctx.reload('goals');
    ctx.toast('Goal added.', 'success');
  });
  $main.querySelectorAll('[data-g-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this goal?')) return;
    await send('delete-goals', { id: b.dataset.gDel });
    await ctx.reload('goals');
  }));

  // Award-on-completion: check each goal once and unlock an achievement
  (async () => {
    const goals = ctx.state.goals || [];
    const existing = new Set((ctx.state.achievements || []).map((a) => a.id));
    for (const g of goals) {
      const actual = actualForGoal(g, ctx.state.jobs || []);
      if (actual >= g.target) {
        const aid = `goal-complete-${g.id}-${periodStart(g.period)}`;
        if (!existing.has(aid)) {
          await send('add-achievements', {
            id: aid, // override generated id
            title: `Hit your ${g.period} target`,
            description: `${actual} / ${g.target} ${g.kind}`,
            icon: '🎯',
            unlockedAt: new Date().toISOString()
          });
        }
      }
    }
  })();
}
