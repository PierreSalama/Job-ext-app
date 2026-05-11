// Monthly calendar view. Pulls events store + auto-surfaces job followUpDueAt + nextInterviewAt.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const KIND_COLORS = {
  interview: 'rgba(249,115,22,0.30)',
  follow_up: 'rgba(245,158,11,0.30)',
  deadline:  'rgba(239,68,68,0.30)',
  custom:    'rgba(99,102,241,0.30)'
};
const KIND_LABELS = {
  interview: 'Interview',
  follow_up: 'Follow-up',
  deadline:  'Deadline',
  custom:    'Event'
};

let _viewYear = null;
let _viewMonth = null; // 0-11
let _addingFor = null; // YYYY-MM-DD
let _editingEvent = null; // event id

function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function ensureView() {
  if (_viewYear == null) {
    const now = new Date();
    _viewYear = now.getFullYear();
    _viewMonth = now.getMonth();
  }
}

function collectEvents(state) {
  const out = []; // { dateKey, time, title, kind, jobId, id, source }
  for (const e of (state.events || [])) {
    if (!e.startsAt) continue;
    const d = new Date(e.startsAt);
    if (Number.isNaN(d.getTime())) continue;
    out.push({
      id: e.id, dateKey: dateKey(d), time: d.toTimeString().slice(0, 5),
      title: e.title || KIND_LABELS[e.kind] || 'Event', kind: e.kind || 'custom',
      jobId: e.jobId || '', source: 'event', raw: e
    });
  }
  for (const j of (state.jobs || [])) {
    if (j.followUpDueAt) {
      const d = new Date(j.followUpDueAt);
      if (!Number.isNaN(d.getTime())) {
        out.push({ id: 'fu-' + j.id, dateKey: dateKey(d), time: '', title: `Follow up: ${j.title}`, kind: 'follow_up', jobId: j.id, source: 'job' });
      }
    }
    if (j.nextInterviewAt) {
      const d = new Date(j.nextInterviewAt);
      if (!Number.isNaN(d.getTime())) {
        out.push({ id: 'iv-' + j.id, dateKey: dateKey(d), time: d.toTimeString().slice(0, 5), title: `Interview: ${j.title}`, kind: 'interview', jobId: j.id, source: 'job' });
      }
    }
  }
  return out;
}

export function render(state) {
  ensureView();
  const events = collectEvents(state);
  const byDay = {};
  for (const e of events) {
    (byDay[e.dateKey] ||= []).push(e);
  }
  const first = new Date(_viewYear, _viewMonth, 1);
  const startWd = first.getDay();
  const daysInMonth = new Date(_viewYear, _viewMonth + 1, 0).getDate();
  const todayKey = dateKey(new Date());

  const cells = [];
  for (let i = 0; i < startWd; i++) cells.push(`<div class="cal-cell cal-empty"></div>`);
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(_viewYear, _viewMonth, d);
    const k = dateKey(dt);
    const dayEvents = (byDay[k] || []).sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    const visible = dayEvents.slice(0, 3);
    const more = dayEvents.length - visible.length;
    const isToday = k === todayKey;
    cells.push(`
      <div class="cal-cell${isToday ? ' cal-today' : ''}" data-day="${k}">
        <div class="cal-cell-h"><span class="cal-d">${d}</span><button class="cal-add" data-add-day="${k}" title="Add event">+</button></div>
        <div class="cal-events">
          ${visible.map((e) => `
            <div class="cal-evt" data-evt="${esc(e.id)}" data-source="${esc(e.source)}" style="background:${KIND_COLORS[e.kind] || KIND_COLORS.custom}">
              ${e.time ? `<span class="t">${esc(e.time)}</span>` : ''}<span>${esc(e.title)}</span>
            </div>`).join('')}
          ${more > 0 ? `<div class="cal-more">+${more} more</div>` : ''}
        </div>
        ${_addingFor === k ? addFormHtml(k, state) : ''}
      </div>
    `);
  }

  let editPopover = '';
  if (_editingEvent) {
    const evt = (state.events || []).find((e) => e.id === _editingEvent);
    if (evt) editPopover = editFormHtml(evt, state);
  }

  return `
    <div class="page-h">
      <div><h1>Calendar</h1><div class="sub">Interviews, follow-ups, deadlines.</div></div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn small" id="cal-prev">← Prev</button>
        <strong style="min-width:160px;text-align:center">${MONTH_NAMES[_viewMonth]} ${_viewYear}</strong>
        <button class="btn small" id="cal-next">Next →</button>
        <button class="btn small" id="cal-today">Today</button>
      </div>
    </div>
    <div class="cal-legend">
      ${Object.entries(KIND_LABELS).map(([k, l]) => `<span class="cal-legend-i"><span style="background:${KIND_COLORS[k]}"></span>${l}</span>`).join('')}
    </div>
    <div class="cal-grid-h">
      ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((w) => `<div class="cal-wd">${w}</div>`).join('')}
    </div>
    <div class="cal-grid">${cells.join('')}</div>
    ${editPopover}
    <style>
      .cal-legend { display: flex; gap: 14px; margin-bottom: 10px; flex-wrap: wrap; }
      .cal-legend-i { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
      .cal-legend-i span { width: 14px; height: 14px; border-radius: 3px; display: inline-block; }
      .cal-grid-h { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; margin-bottom: 4px; }
      .cal-wd { font-size: 11px; color: var(--muted); text-align: center; padding: 4px; text-transform: uppercase; letter-spacing: 0.05em; }
      .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
      .cal-cell { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; min-height: 100px; padding: 6px; position: relative; }
      .cal-empty { background: transparent; border: 1px dashed var(--border); }
      .cal-today { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary) inset; }
      .cal-cell-h { display: flex; justify-content: space-between; align-items: center; }
      .cal-d { font-size: 12px; font-weight: 600; color: var(--muted); }
      .cal-add { background: transparent; border: 0; color: var(--muted); cursor: pointer; font-size: 14px; padding: 0 4px; opacity: 0; transition: opacity 0.12s; }
      .cal-cell:hover .cal-add { opacity: 1; }
      .cal-add:hover { color: var(--primary); }
      .cal-events { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
      .cal-evt { font-size: 10px; padding: 2px 5px; border-radius: 4px; cursor: pointer; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .cal-evt .t { font-weight: 600; margin-right: 4px; }
      .cal-evt:hover { filter: brightness(1.3); }
      .cal-more { font-size: 10px; color: var(--muted); padding: 0 5px; }
      .cal-popover { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 100; display: flex; align-items: center; justify-content: center; }
      .cal-popover .card { width: 360px; max-width: 90vw; }
      .cal-form { display: flex; flex-direction: column; gap: 6px; padding: 6px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; margin-top: 4px; }
      .cal-form input, .cal-form select { font-size: 11px; padding: 4px 6px; }
      .cal-form .row { display: flex; gap: 4px; }
    </style>
  `;
}

function addFormHtml(dateK, state) {
  const jobs = state.jobs || [];
  return `
    <div class="cal-form" data-form-day="${dateK}" onclick="event.stopPropagation()">
      <input type="time" id="cal-add-time" value="09:00" />
      <select id="cal-add-kind">
        ${Object.entries(KIND_LABELS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}
      </select>
      <input type="text" id="cal-add-title" placeholder="Title" />
      <select id="cal-add-job">
        <option value="">— No job —</option>
        ${jobs.slice(0, 200).map((j) => `<option value="${esc(j.id)}">${esc(j.title)} · ${esc(j.company)}</option>`).join('')}
      </select>
      <div class="row">
        <button class="btn primary small" id="cal-add-save">Save</button>
        <button class="btn small" id="cal-add-cancel">Cancel</button>
      </div>
    </div>
  `;
}

function editFormHtml(evt, state) {
  const jobs = state.jobs || [];
  const d = new Date(evt.startsAt);
  const dateV = dateKey(d);
  const timeV = d.toTimeString().slice(0, 5);
  return `
    <div class="cal-popover" id="cal-popover">
      <div class="card" onclick="event.stopPropagation()">
        <h3 style="margin-top:0;font-size:14px">Edit event</h3>
        <label>Date</label><input type="date" id="cal-e-date" value="${esc(dateV)}" />
        <label>Time</label><input type="time" id="cal-e-time" value="${esc(timeV)}" />
        <label>Kind</label>
        <select id="cal-e-kind">
          ${Object.entries(KIND_LABELS).map(([k, l]) => `<option value="${k}"${evt.kind === k ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
        <label>Title</label><input type="text" id="cal-e-title" value="${esc(evt.title || '')}" />
        <label>Linked job</label>
        <select id="cal-e-job">
          <option value="">— No job —</option>
          ${jobs.slice(0, 200).map((j) => `<option value="${esc(j.id)}"${evt.jobId === j.id ? ' selected' : ''}>${esc(j.title)} · ${esc(j.company)}</option>`).join('')}
        </select>
        <div style="display:flex;gap:6px;margin-top:12px">
          <button class="btn primary small" id="cal-e-save">Save</button>
          <button class="btn danger small" id="cal-e-delete">Delete</button>
          <button class="btn small" id="cal-e-cancel">Cancel</button>
        </div>
      </div>
    </div>
  `;
}

export function attach($main, ctx) {
  const { send, toast, render: rerender } = ctx;
  $main.querySelector('#cal-prev')?.addEventListener('click', () => {
    if (_viewMonth === 0) { _viewMonth = 11; _viewYear--; } else _viewMonth--;
    rerender();
  });
  $main.querySelector('#cal-next')?.addEventListener('click', () => {
    if (_viewMonth === 11) { _viewMonth = 0; _viewYear++; } else _viewMonth++;
    rerender();
  });
  $main.querySelector('#cal-today')?.addEventListener('click', () => {
    const n = new Date(); _viewYear = n.getFullYear(); _viewMonth = n.getMonth(); rerender();
  });

  // Drag-to-set followup date: drag a job pill onto a calendar cell.
  $main.querySelectorAll('.cal-evt[data-source="job"]').forEach((el) => {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      const id = el.dataset.evt || '';
      // Job-derived event ids look like "fu-<jobId>" or "iv-<jobId>".
      const jobId = (id.startsWith('fu-') || id.startsWith('iv-')) ? id.slice(3) : id;
      try { e.dataTransfer.setData('text/jat-jobid', jobId); e.dataTransfer.effectAllowed = 'move'; } catch {}
    });
  });
  $main.querySelectorAll('[data-day]').forEach((cell) => {
    cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('drop-target'); });
    cell.addEventListener('dragleave', () => cell.classList.remove('drop-target'));
    cell.addEventListener('drop', async (e) => {
      e.preventDefault();
      cell.classList.remove('drop-target');
      const jobId = e.dataTransfer?.getData('text/jat-jobid');
      if (!jobId) return;
      const day = cell.dataset.day;
      const followUpDueAt = new Date(day + 'T09:00').toISOString();
      const r = await send('patch-job', { id: jobId, patch: { followUpDueAt } });
      if (r?.ok) toast('Follow-up date updated.', 'success');
    });
  });

  $main.querySelectorAll('[data-add-day]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    _addingFor = b.dataset.addDay;
    rerender();
  }));
  $main.querySelector('#cal-add-cancel')?.addEventListener('click', () => { _addingFor = null; rerender(); });
  $main.querySelector('#cal-add-save')?.addEventListener('click', async () => {
    const day = _addingFor;
    const time = $main.querySelector('#cal-add-time').value || '09:00';
    const kind = $main.querySelector('#cal-add-kind').value;
    const title = $main.querySelector('#cal-add-title').value.trim();
    const jobId = $main.querySelector('#cal-add-job').value;
    if (!title) { toast('Title required.', 'danger'); return; }
    const startsAt = new Date(day + 'T' + time).toISOString();
    const r = await send('add-event', { kind, title, startsAt, jobId });
    if (r?.ok) { _addingFor = null; toast('Event added.', 'success'); }
  });

  $main.querySelectorAll('.cal-evt').forEach((el) => el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (el.dataset.source === 'job') {
      const evt = (ctx.state.events || []).find((x) => x.id === el.dataset.evt);
      if (!evt) {
        const id = el.dataset.evt;
        if (id.startsWith('fu-') || id.startsWith('iv-')) {
          location.hash = '#/job/' + id.slice(3);
          return;
        }
      }
    }
    _editingEvent = el.dataset.evt;
    rerender();
  }));

  const popover = $main.querySelector('#cal-popover');
  if (popover) {
    popover.addEventListener('click', () => { _editingEvent = null; rerender(); });
    $main.querySelector('#cal-e-cancel')?.addEventListener('click', () => { _editingEvent = null; rerender(); });
    $main.querySelector('#cal-e-save')?.addEventListener('click', async () => {
      const id = _editingEvent;
      const date = $main.querySelector('#cal-e-date').value;
      const time = $main.querySelector('#cal-e-time').value || '09:00';
      const patch = {
        kind: $main.querySelector('#cal-e-kind').value,
        title: $main.querySelector('#cal-e-title').value,
        jobId: $main.querySelector('#cal-e-job').value,
        startsAt: new Date(date + 'T' + time).toISOString()
      };
      const r = await send('patch-event', { id, patch });
      if (r?.ok) { _editingEvent = null; toast('Saved.', 'success'); }
    });
    $main.querySelector('#cal-e-delete')?.addEventListener('click', async () => {
      if (!confirm('Delete this event?')) return;
      await send('delete-event', { id: _editingEvent });
      _editingEvent = null;
      toast('Deleted.', 'success');
    });
  }
}
