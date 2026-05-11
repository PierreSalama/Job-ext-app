// Kanban pipeline view. Drag-drop cards across status columns.
import { STATUS_LABELS } from '../../lib/schema.js';

const DEFAULT_COLUMNS = ['started', 'submitted', 'received', 'reviewing', 'recruiter_replied', 'interview', 'assessment', 'offer'];
function getColumns(state) {
  const order = (state && state.settings && state.settings.kanbanColumnOrder) || null;
  if (!Array.isArray(order) || !order.length) return DEFAULT_COLUMNS;
  const set = new Set(order);
  // Use user's order, but append any default not present (forward-compat).
  const out = order.filter((c) => DEFAULT_COLUMNS.includes(c));
  for (const d of DEFAULT_COLUMNS) if (!set.has(d)) out.push(d);
  return out;
}
const COLUMNS = DEFAULT_COLUMNS;

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

function daysSince(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

let _compact = false;

export function render(state) {
  const jobs = state.jobs || [];
  const cols = getColumns(state);
  const byCol = Object.fromEntries(cols.map((c) => [c, []]));
  for (const j of jobs) {
    if (byCol[j.status]) byCol[j.status].push(j);
  }
  for (const c of cols) {
    byCol[c].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }
  const total = cols.reduce((n, c) => n + byCol[c].length, 0);

  return `
    <div class="page-h">
      <div><h1>Pipeline</h1><div class="sub">${total} application${total === 1 ? '' : 's'} across ${COLUMNS.length} stages. Drag cards to update status.</div></div>
      <div style="display:flex;gap:8px">
        <button class="btn small" id="kanban-toggle">${_compact ? 'Expanded' : 'Compact'} view</button>
      </div>
    </div>
    <div class="kanban${_compact ? ' kanban-compact' : ''}">
      ${cols.map((col) => columnHtml(col, byCol[col])).join('')}
    </div>
    <style>
      .kanban { display: grid; grid-template-columns: repeat(${cols.length}, minmax(220px, 1fr)); gap: 10px; overflow-x: auto; padding-bottom: 12px; }
      .kanban-col-h { cursor: grab; }
      .kanban-col-h.col-drag { opacity: 0.4; }
      .kanban-col.col-drop { outline: 2px dashed var(--primary); outline-offset: -2px; }
      .kanban-col { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 10px; display: flex; flex-direction: column; min-height: 240px; }
      .kanban-col-h { display: flex; justify-content: space-between; align-items: center; padding: 4px 6px 10px; border-bottom: 1px solid var(--border); margin-bottom: 8px; }
      .kanban-col-h strong { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
      .kanban-col-h .n { background: rgba(255,255,255,0.06); padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
      .kanban-card { background: rgba(99,102,241,0.06); border: 1px solid var(--border); border-radius: 8px; padding: 10px; margin-bottom: 6px; cursor: grab; transition: all 0.12s; }
      .kanban-card:hover { background: rgba(99,102,241,0.14); transform: translateY(-1px); }
      .kanban-card.dragging { opacity: 0.4; }
      .kanban-card .t { font-weight: 600; font-size: 13px; margin-bottom: 2px; line-height: 1.3; }
      .kanban-card .c { color: var(--muted); font-size: 11px; }
      .kanban-card .meta { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; }
      .kanban-card .age { font-size: 10px; color: var(--muted); }
      .kanban-compact .kanban-card { padding: 6px 8px; }
      .kanban-compact .kanban-card .c, .kanban-compact .kanban-card .meta { display: none; }
      .kanban-drop-hint { padding: 18px 8px; border: 1px dashed var(--border); border-radius: 8px; text-align: center; color: var(--muted); font-size: 11px; margin-top: 6px; }
      .kanban-col.drag-over { background: rgba(99,102,241,0.10); border-color: var(--primary); }
    </style>
  `;
}

function columnHtml(col, jobs) {
  return `
    <div class="kanban-col" data-col="${esc(col)}">
      <div class="kanban-col-h" draggable="true" data-col-h="${esc(col)}">
        <strong>${esc(STATUS_LABELS[col] || col)}</strong>
        <span class="n">${jobs.length}</span>
      </div>
      <div class="kanban-col-body" data-col="${esc(col)}">
        ${jobs.map(cardHtml).join('')}
        ${jobs.length === 0 ? `<div class="kanban-drop-hint">Drop here</div>` : ''}
      </div>
    </div>
  `;
}

function cardHtml(j) {
  const d = daysSince(j.submittedAt || j.createdAt);
  return `
    <div class="kanban-card" draggable="true" data-job="${esc(j.id)}">
      <div class="t">${esc(j.title || 'Untitled')}</div>
      <div class="c">${esc(j.company || '')}</div>
      <div class="meta">
        <span class="pill source">${esc(j.source || 'Manual')}</span>
        <span class="age">${d == null ? '' : d === 0 ? 'today' : d + 'd'}</span>
      </div>
    </div>
  `;
}

export function attach($main, ctx) {
  const { send, toast, render: rerender } = ctx;
  $main.querySelector('#kanban-toggle')?.addEventListener('click', () => { _compact = !_compact; rerender(); });

  $main.querySelectorAll('.kanban-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (card.classList.contains('dragging')) return;
      location.hash = `#/job/${card.dataset.job}`;
    });
    card.addEventListener('dragstart', (e) => {
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.job);
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });

  // Column reorder by dragging the header
  let colDragId = null;
  $main.querySelectorAll('.kanban-col-h[data-col-h]').forEach((h) => {
    h.addEventListener('dragstart', (e) => {
      colDragId = h.dataset.colH;
      h.classList.add('col-drag');
      try { e.dataTransfer.setData('application/x-jat-col', colDragId); e.dataTransfer.effectAllowed = 'move'; } catch {}
    });
    h.addEventListener('dragend', () => { h.classList.remove('col-drag'); colDragId = null; $main.querySelectorAll('.col-drop').forEach((n) => n.classList.remove('col-drop')); });
  });
  $main.querySelectorAll('.kanban-col').forEach((col) => {
    col.addEventListener('dragover', (e) => {
      const types = Array.from(e.dataTransfer?.types || []);
      if (types.includes('application/x-jat-col')) { e.preventDefault(); col.classList.add('col-drop'); }
    });
    col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('col-drop'); });
    col.addEventListener('drop', async (e) => {
      const types = Array.from(e.dataTransfer?.types || []);
      if (!types.includes('application/x-jat-col')) return;
      e.preventDefault();
      col.classList.remove('col-drop');
      const fromCol = e.dataTransfer.getData('application/x-jat-col') || colDragId;
      const toCol = col.dataset.col;
      if (!fromCol || fromCol === toCol) return;
      const cur = getColumns(ctx.state);
      const arr = cur.filter((c) => c !== fromCol);
      const i = arr.indexOf(toCol);
      arr.splice(i < 0 ? arr.length : i, 0, fromCol);
      await send('patch-settings', { kanbanColumnOrder: arr });
      ctx.state.settings.kanbanColumnOrder = arr;
      rerender();
    });
  });
  $main.querySelectorAll('.kanban-col').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', (e) => {
      if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over');
    });
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const jobId = e.dataTransfer.getData('text/plain');
      const status = col.dataset.col;
      if (!jobId || !status) return;
      const r = await send('patch-job', { id: jobId, patch: { status } });
      if (r?.ok) toast(`Moved to ${STATUS_LABELS[status] || status}.`, 'success');
      else toast('Failed to update.', 'danger');
    });
  });
}
