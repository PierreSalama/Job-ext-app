// Reminders — time-based nudges with snooze / done / overdue tabs.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

let _tab = 'upcoming'; // 'upcoming' | 'overdue' | 'done'

function fmt(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function defaultDateValue() {
  const d = new Date(Date.now() + 86400000);
  d.setSeconds(0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function render(state) {
  const all = state.reminders || [];
  const now = Date.now();
  const upcoming = all.filter((r) => !r.done && new Date(r.fireAt).getTime() > now);
  const overdue = all.filter((r) => !r.done && new Date(r.fireAt).getTime() <= now);
  const done = all.filter((r) => r.done);

  const list = _tab === 'upcoming' ? upcoming : _tab === 'overdue' ? overdue : done;
  list.sort((a, b) => (a.fireAt || '').localeCompare(b.fireAt || ''));
  if (_tab === 'done') list.reverse();

  const jobs = state.jobs || [];

  return `
    <div class="page-h">
      <div><h1>Reminders</h1><div class="sub">${upcoming.length} upcoming · ${overdue.length} overdue · ${done.length} done</div></div>
    </div>
    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-top:0;font-size:14px">Add reminder</h3>
      <div style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:8px;align-items:end">
        <div><label>Title</label><input type="text" id="rem-title" placeholder="Follow up with recruiter…" /></div>
        <div><label>When</label><input type="datetime-local" id="rem-when" value="${esc(defaultDateValue())}" /></div>
        <div><label>Job (optional)</label>
          <select id="rem-job"><option value="">— None —</option>
            ${jobs.slice(0, 200).map((j) => `<option value="${esc(j.id)}">${esc(j.title)} · ${esc(j.company)}</option>`).join('')}
          </select>
        </div>
        <button class="btn primary" id="rem-add">Add</button>
      </div>
    </div>
    <div class="toolbar" style="gap:4px">
      ${['upcoming','overdue','done'].map((t) => `
        <button class="btn small${_tab === t ? ' primary' : ''}" data-tab="${t}">
          ${t.charAt(0).toUpperCase() + t.slice(1)}
          (${t === 'upcoming' ? upcoming.length : t === 'overdue' ? overdue.length : done.length})
        </button>
      `).join('')}
    </div>
    <div class="card">
      ${list.length === 0 ? `<div class="empty"><strong>No reminders here.</strong>${_tab === 'upcoming' ? 'Add one above.' : ''}</div>` : `
        <div class="list">
          ${list.map((r) => rowHtml(r, jobs)).join('')}
        </div>
      `}
    </div>
  `;
}

function rowHtml(r, jobs) {
  const job = r.jobId ? jobs.find((j) => j.id === r.jobId) : null;
  const isOver = !r.done && new Date(r.fireAt).getTime() <= Date.now();
  return `
    <div class="list-row" style="cursor:default;${isOver ? 'border-color:rgba(245,158,11,0.4)' : ''}">
      <div>
        <div class="t">${r.done ? '<s>' : ''}${esc(r.title)}${r.done ? '</s>' : ''}</div>
        <div class="s">${esc(fmt(r.fireAt))}${job ? ' · ' + esc(job.title) + ' @ ' + esc(job.company) : ''}</div>
      </div>
      <div style="display:flex;gap:6px">
        ${!r.done ? `
          <button class="btn small" data-snooze-d="${esc(r.id)}" title="Snooze 1 day">+1d</button>
          <button class="btn small" data-snooze-w="${esc(r.id)}" title="Snooze 1 week">+1w</button>
        ` : ''}
        <button class="btn small${r.done ? '' : ' primary'}" data-toggle="${esc(r.id)}">${r.done ? 'Reopen' : 'Done'}</button>
        <button class="btn small danger" data-del="${esc(r.id)}">×</button>
      </div>
    </div>
  `;
}

export function attach($main, ctx) {
  const { send, toast, render: rerender } = ctx;
  $main.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { _tab = b.dataset.tab; rerender(); }));

  $main.querySelector('#rem-add')?.addEventListener('click', async () => {
    const title = $main.querySelector('#rem-title').value.trim();
    const when = $main.querySelector('#rem-when').value;
    const jobId = $main.querySelector('#rem-job').value;
    if (!title || !when) { toast('Title + date required.', 'danger'); return; }
    const r = await send('add-reminder', { title, fireAt: new Date(when).toISOString(), jobId, done: false });
    if (r?.ok) toast('Reminder added.', 'success');
  });

  $main.querySelectorAll('[data-snooze-d]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.snoozeD;
    const r = (ctx.state.reminders || []).find((x) => x.id === id);
    if (!r) return;
    const next = new Date(new Date(r.fireAt).getTime() + 86400000).toISOString();
    await send('patch-reminder', { id, patch: { fireAt: next } });
    toast('Snoozed +1d.', 'success');
  }));
  $main.querySelectorAll('[data-snooze-w]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.snoozeW;
    const r = (ctx.state.reminders || []).find((x) => x.id === id);
    if (!r) return;
    const next = new Date(new Date(r.fireAt).getTime() + 7 * 86400000).toISOString();
    await send('patch-reminder', { id, patch: { fireAt: next } });
    toast('Snoozed +1w.', 'success');
  }));
  $main.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.toggle;
    const r = (ctx.state.reminders || []).find((x) => x.id === id);
    if (!r) return;
    await send('patch-reminder', { id, patch: { done: !r.done, doneAt: !r.done ? new Date().toISOString() : '' } });
  }));
  $main.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this reminder?')) return;
    await send('delete-reminder', { id: b.dataset.del });
    toast('Deleted.', 'success');
  }));
}
