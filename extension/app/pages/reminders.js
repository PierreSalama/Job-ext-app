// Reminders — v9.0.0 rich UX: quick-pick chips, custom date+time picker,
// optional recurrence (daily/weekly/monthly), priority, notes field. Tab-based
// upcoming/overdue/done view with snooze + bulk actions.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

let _tab = 'upcoming'; // 'upcoming' | 'overdue' | 'done'
let _whenMode = 'preset'; // 'preset' | 'custom'
let _selectedPreset = 'tomorrow';

function fmt(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    const absH = Math.abs(diffMs / 3600000);
    if (absH < 24) {
      const sign = diffMs >= 0 ? 'in ' : '';
      const suffix = diffMs >= 0 ? '' : ' ago';
      const h = Math.round(absH);
      if (h === 0) return 'now';
      return `${sign}${h}h${suffix} · ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    return d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function defaultCustomDate() {
  const d = new Date(Date.now() + 86400000);
  d.setHours(9, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Compute the actual ISO timestamp for a preset chip
function presetToIso(key) {
  const d = new Date();
  d.setSeconds(0, 0);
  switch (key) {
    case '1h':       d.setTime(d.getTime() + 3600000); return d.toISOString();
    case '3h':       d.setTime(d.getTime() + 3 * 3600000); return d.toISOString();
    case 'tonight':  d.setHours(20, 0, 0, 0); if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1); return d.toISOString();
    case 'tomorrow': d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.toISOString();
    case 'tomorrow_evening': d.setDate(d.getDate() + 1); d.setHours(18, 0, 0, 0); return d.toISOString();
    case 'next_week': {
      // Next Monday 9am
      const day = d.getDay();
      const daysUntilMonday = ((1 - day + 7) % 7) || 7;
      d.setDate(d.getDate() + daysUntilMonday); d.setHours(9, 0, 0, 0); return d.toISOString();
    }
    case '2_weeks': d.setDate(d.getDate() + 14); d.setHours(9, 0, 0, 0); return d.toISOString();
    case '1_month': d.setMonth(d.getMonth() + 1); d.setHours(9, 0, 0, 0); return d.toISOString();
    default: return d.toISOString();
  }
}

const PRESETS = [
  { key: '1h',               label: 'In 1 hour' },
  { key: '3h',               label: 'In 3 hours' },
  { key: 'tonight',          label: 'Tonight 8pm' },
  { key: 'tomorrow',         label: 'Tomorrow 9am' },
  { key: 'tomorrow_evening', label: 'Tomorrow 6pm' },
  { key: 'next_week',        label: 'Mon 9am' },
  { key: '2_weeks',          label: 'In 2 weeks' },
  { key: '1_month',          label: 'In 1 month' }
];

const PRIORITIES = [
  { key: 'low',    label: 'Low',    color: '#64748b' },
  { key: 'medium', label: 'Medium', color: '#3b82f6' },
  { key: 'high',   label: 'High',   color: '#ef4444' }
];

export function render(state) {
  const all = state.reminders || [];
  const now = Date.now();
  const upcoming = all.filter((r) => !r.done && new Date(r.fireAt).getTime() > now);
  const overdue  = all.filter((r) => !r.done && new Date(r.fireAt).getTime() <= now);
  const done     = all.filter((r) => r.done);

  const list = _tab === 'upcoming' ? upcoming : _tab === 'overdue' ? overdue : done;
  list.sort((a, b) => (a.fireAt || '').localeCompare(b.fireAt || ''));
  if (_tab === 'done') list.reverse();

  const jobs = state.jobs || [];
  const presetPreview = _whenMode === 'preset' ? fmt(presetToIso(_selectedPreset)) : '';

  return `
    <div class="page-h">
      <div><h1>⏰ Reminders</h1>
        <div class="sub">${upcoming.length} upcoming · ${overdue.length} overdue · ${done.length} done</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-top:0;font-size:14px;display:flex;align-items:center;gap:8px">
        <span>Add a reminder</span>
        ${presetPreview ? `<span class="pill" style="font-size:11px;background:rgba(99,102,241,0.18);color:#6366f1">→ ${esc(presetPreview)}</span>` : ''}
      </h3>

      <label style="font-size:12px;color:var(--muted);display:block;margin-top:6px">Title</label>
      <input type="text" id="rem-title" placeholder="Follow up with recruiter…" style="width:100%" />

      <label style="font-size:12px;color:var(--muted);display:block;margin-top:10px">When</label>
      <div style="display:flex;gap:4px;margin-bottom:6px">
        <button class="btn small${_whenMode === 'preset' ? ' primary' : ''}" data-when-mode="preset">Quick pick</button>
        <button class="btn small${_whenMode === 'custom' ? ' primary' : ''}" data-when-mode="custom">Custom date+time</button>
      </div>
      ${_whenMode === 'preset' ? `
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${PRESETS.map((p) => `
            <button class="btn small${_selectedPreset === p.key ? ' primary' : ''}" data-preset="${esc(p.key)}">${esc(p.label)}</button>
          `).join('')}
        </div>
      ` : `
        <input type="datetime-local" id="rem-when-custom" value="${esc(defaultCustomDate())}" style="width:280px" />
      `}

      <div class="grid-2" style="margin-top:10px">
        <div>
          <label style="font-size:12px;color:var(--muted)">Job (optional)</label>
          <select id="rem-job" style="width:100%">
            <option value="">— None —</option>
            ${jobs.slice(0, 200).map((j) => `<option value="${esc(j.id)}">${esc(j.title)} · ${esc(j.company)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="font-size:12px;color:var(--muted)">Priority</label>
          <select id="rem-priority" style="width:100%">
            ${PRIORITIES.map((p) => `<option value="${p.key}"${p.key === 'medium' ? ' selected' : ''}>${p.label}</option>`).join('')}
          </select>
        </div>
      </div>

      <label style="font-size:12px;color:var(--muted);display:block;margin-top:10px">Repeat (optional)</label>
      <select id="rem-recurrence" style="width:280px">
        <option value="none">No repeat</option>
        <option value="daily">Every day</option>
        <option value="weekly">Every week</option>
        <option value="biweekly">Every 2 weeks</option>
        <option value="monthly">Every month</option>
      </select>

      <label style="font-size:12px;color:var(--muted);display:block;margin-top:10px">Notes (optional)</label>
      <textarea id="rem-notes" rows="2" placeholder="Anything you want to remember…" style="width:100%"></textarea>

      <div style="margin-top:12px;display:flex;gap:6px;align-items:center">
        <button class="btn primary" id="rem-add">⏰ Add reminder</button>
        <span class="s" style="font-size:11px;color:var(--muted)">Tip: hit <kbd>Ctrl+Enter</kbd> to add quickly</span>
      </div>
    </div>

    <div class="toolbar" style="gap:4px">
      ${['upcoming','overdue','done'].map((t) => `
        <button class="btn small${_tab === t ? ' primary' : ''}" data-tab="${t}">
          ${t.charAt(0).toUpperCase() + t.slice(1)}
          (${t === 'upcoming' ? upcoming.length : t === 'overdue' ? overdue.length : done.length})
        </button>
      `).join('')}
      ${overdue.length > 0 && _tab !== 'overdue' ? `<button class="btn small" data-quick-overdue style="margin-left:auto;color:var(--warn,#f59e0b)">⚠ ${overdue.length} overdue</button>` : ''}
    </div>

    <div class="card">
      ${list.length === 0 ? `<div class="empty"><strong>${_tab === 'upcoming' ? 'Nothing scheduled. ✨' : _tab === 'overdue' ? 'Nothing overdue.' : 'No completed reminders yet.'}</strong>${_tab === 'upcoming' ? '<div style="margin-top:6px;font-size:12px;color:var(--muted)">Add one above to stay on top of follow-ups.</div>' : ''}</div>` : `
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
  const pri = PRIORITIES.find((p) => p.key === (r.priority || 'medium')) || PRIORITIES[1];
  return `
    <div class="list-row" style="cursor:default;${isOver ? 'border-color:rgba(245,158,11,0.4);background:rgba(245,158,11,0.04)' : ''}">
      <div style="width:4px;align-self:stretch;background:${pri.color};border-radius:2px;flex:0 0 4px"></div>
      <div style="flex:1;min-width:0">
        <div class="t">${r.done ? '<s>' : ''}${esc(r.title)}${r.done ? '</s>' : ''}
          ${r.recurrence && r.recurrence !== 'none' ? `<span class="pill" style="margin-left:6px;font-size:10px;background:rgba(99,102,241,0.18);color:#6366f1">🔁 ${esc(r.recurrence)}</span>` : ''}
        </div>
        <div class="s" style="font-size:12px;color:${isOver ? 'var(--warn,#f59e0b)' : 'var(--muted)'}">
          ${isOver ? '⚠ ' : ''}${esc(fmt(r.fireAt))}${job ? ' · ' + esc(job.title) + ' @ ' + esc(job.company) : ''}
        </div>
        ${r.notes ? `<div class="s" style="font-size:11px;color:var(--muted);margin-top:2px;white-space:pre-wrap">${esc(r.notes)}</div>` : ''}
      </div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">
        ${!r.done ? `
          <button class="btn small" data-snooze-h="${esc(r.id)}" title="Snooze 1 hour">+1h</button>
          <button class="btn small" data-snooze-d="${esc(r.id)}" title="Snooze 1 day">+1d</button>
          <button class="btn small" data-snooze-w="${esc(r.id)}" title="Snooze 1 week">+1w</button>
        ` : ''}
        <button class="btn small${r.done ? '' : ' primary'}" data-toggle="${esc(r.id)}">${r.done ? 'Reopen' : '✓ Done'}</button>
        <button class="btn small danger" data-del="${esc(r.id)}" title="Delete">×</button>
      </div>
    </div>
  `;
}

export function attach($main, ctx) {
  const { send, toast, render: rerender, state } = ctx;

  $main.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { _tab = b.dataset.tab; rerender(); }));
  $main.querySelector('[data-quick-overdue]')?.addEventListener('click', () => { _tab = 'overdue'; rerender(); });

  $main.querySelectorAll('[data-when-mode]').forEach((b) => b.addEventListener('click', () => {
    _whenMode = b.dataset.whenMode; rerender();
  }));
  $main.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
    _selectedPreset = b.dataset.preset; rerender();
  }));

  const addReminder = async () => {
    const title = $main.querySelector('#rem-title').value.trim();
    if (!title) { toast('Reminder needs a title.', 'danger'); return; }
    let fireAt;
    if (_whenMode === 'preset') fireAt = presetToIso(_selectedPreset);
    else {
      const v = $main.querySelector('#rem-when-custom').value;
      if (!v) { toast('Pick a date+time.', 'danger'); return; }
      fireAt = new Date(v).toISOString();
    }
    const payload = {
      title,
      fireAt,
      jobId: $main.querySelector('#rem-job').value || '',
      priority: $main.querySelector('#rem-priority').value || 'medium',
      recurrence: $main.querySelector('#rem-recurrence').value || 'none',
      notes: $main.querySelector('#rem-notes').value.trim(),
      done: false
    };
    const r = await send('add-reminders', payload);
    if (r?.ok) {
      toast(`Reminder added — ${fmt(fireAt)}.`, 'success');
      // Clear form
      $main.querySelector('#rem-title').value = '';
      $main.querySelector('#rem-notes').value = '';
    } else { toast(`Failed: ${r?.error || 'unknown'}`, 'danger'); }
  };

  $main.querySelector('#rem-add')?.addEventListener('click', addReminder);
  $main.querySelector('#rem-title')?.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); addReminder(); }
  });

  const snoozeBy = async (id, deltaMs) => {
    const r = (state.reminders || []).find((x) => x.id === id);
    if (!r) return;
    const next = new Date(new Date(r.fireAt).getTime() + deltaMs).toISOString();
    await send('patch-reminders', { id, patch: { fireAt: next } });
  };
  $main.querySelectorAll('[data-snooze-h]').forEach((b) => b.addEventListener('click', () => snoozeBy(b.dataset.snoozeH, 3600000).then(() => toast('Snoozed +1h.', 'success'))));
  $main.querySelectorAll('[data-snooze-d]').forEach((b) => b.addEventListener('click', () => snoozeBy(b.dataset.snoozeD, 86400000).then(() => toast('Snoozed +1d.', 'success'))));
  $main.querySelectorAll('[data-snooze-w]').forEach((b) => b.addEventListener('click', () => snoozeBy(b.dataset.snoozeW, 7 * 86400000).then(() => toast('Snoozed +1w.', 'success'))));

  $main.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.toggle;
    const r = (state.reminders || []).find((x) => x.id === id);
    if (!r) return;
    const wasDone = r.done;
    // If marking done AND has recurrence: spawn the next occurrence
    if (!wasDone && r.recurrence && r.recurrence !== 'none') {
      const next = new Date(r.fireAt);
      switch (r.recurrence) {
        case 'daily':    next.setDate(next.getDate() + 1); break;
        case 'weekly':   next.setDate(next.getDate() + 7); break;
        case 'biweekly': next.setDate(next.getDate() + 14); break;
        case 'monthly':  next.setMonth(next.getMonth() + 1); break;
      }
      await send('add-reminders', { ...r, id: undefined, fireAt: next.toISOString(), done: false, createdAt: undefined, updatedAt: undefined });
    }
    await send('patch-reminders', { id, patch: { done: !wasDone, doneAt: !wasDone ? new Date().toISOString() : '' } });
  }));

  $main.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this reminder?')) return;
    await send('delete-reminders', { id: b.dataset.del });
    toast('Deleted.', 'success');
  }));
}
