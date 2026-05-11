// Notes page — markdown notes with two-pane editor + live preview.
// Uses lib/markdown.js renderMarkdown(). Pin/unpin, link to job, search,
// auto-save on blur.
import { renderMarkdown } from '../../lib/markdown.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const local = { selectedId: null, search: '' };

function shortDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
  catch { return ''; }
}

function filtered(notes, q) {
  if (!q) return notes;
  const ql = q.toLowerCase();
  return notes.filter((n) => (n.title || '').toLowerCase().includes(ql) || (n.body || '').toLowerCase().includes(ql));
}

export function render(state) {
  const notes = (state.notes || []).slice().sort((a, b) => {
    if ((b.pinned ? 1 : 0) !== (a.pinned ? 1 : 0)) return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });
  const list = filtered(notes, local.search);
  const sel = list.find((n) => n.id === local.selectedId) || list[0] || null;
  if (sel) local.selectedId = sel.id;

  const jobOpts = ['<option value="">— No job link —</option>']
    .concat((state.jobs || []).map((j) => `<option value="${esc(j.id)}"${sel && sel.jobId === j.id ? ' selected' : ''}>${esc(j.title)} · ${esc(j.company)}</option>`))
    .join('');

  return `
    <div class="page-h">
      <div><h1>Notes</h1><div class="sub">${notes.length} note${notes.length === 1 ? '' : 's'}</div></div>
      <div style="display:flex;gap:8px"><button class="btn primary" id="note-new">+ New note</button></div>
    </div>
    <div class="grid-2" style="grid-template-columns: 280px 1fr; gap:14px; align-items:start">
      <div class="card" style="padding:0">
        <div style="padding:10px;border-bottom:1px solid var(--border)">
          <input type="text" id="note-search" placeholder="Search…" value="${esc(local.search)}" style="width:100%;padding:6px 8px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px" />
        </div>
        <div style="max-height:70vh;overflow:auto">
          ${list.length === 0 ? `<div class="empty"><strong>No notes yet.</strong>Start writing.</div>` :
            list.map((n) => `
              <div class="list-row" data-note="${esc(n.id)}" style="cursor:pointer;${sel && sel.id === n.id ? 'background:rgba(99,102,241,0.10)' : ''}">
                <div>
                  <div class="t">${n.pinned ? '★ ' : ''}${esc(n.title || 'Untitled')}</div>
                  <div class="s">${shortDate(n.updatedAt)}${n.jobId ? ' · linked' : ''}</div>
                </div>
              </div>
            `).join('')}
        </div>
      </div>
      <div>
        ${sel ? `
          <div class="card">
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
              <input type="text" id="note-title" value="${esc(sel.title || '')}" placeholder="Title…" style="flex:1;padding:8px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:15px;font-weight:600" />
              <button class="btn small" id="note-pin">${sel.pinned ? '★ Pinned' : '☆ Pin'}</button>
              <button class="btn small danger" id="note-del">Delete</button>
            </div>
            <select id="note-job" style="width:100%;padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;margin-bottom:10px">
              ${jobOpts}
            </select>
            <div class="grid-2" style="gap:10px">
              <textarea id="note-body" placeholder="Write markdown…" style="width:100%;min-height:50vh;padding:10px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;font-family:'SFMono-Regular', Consolas, monospace;font-size:13px;resize:vertical">${esc(sel.body || '')}</textarea>
              <div class="card" style="min-height:50vh;background:var(--bg);overflow:auto" id="note-preview">${renderMarkdown(sel.body || '')}</div>
            </div>
            <div style="margin-top:8px;font-size:11px;color:var(--muted)">Auto-saves on blur. Last edited ${shortDate(sel.updatedAt)}.</div>
          </div>
        ` : `<div class="card empty">Select or create a note.</div>`}
      </div>
    </div>
  `;
}

export function attach($main, ctx) {
  const { send } = ctx;
  $main.querySelectorAll('[data-note]').forEach((el) => el.addEventListener('click', () => {
    local.selectedId = el.dataset.note;
    ctx.render();
  }));
  const search = $main.querySelector('#note-search');
  if (search) search.addEventListener('input', (e) => { local.search = e.target.value; ctx.render(); });
  $main.querySelector('#note-new')?.addEventListener('click', async () => {
    const r = await send('add-notes', { title: 'New note', body: '', pinned: false, jobId: '' });
    if (r?.ok) { local.selectedId = r.item.id; await ctx.reload('notes'); }
  });
  const note = (ctx.state.notes || []).find((n) => n.id === local.selectedId);
  const save = async (patch) => {
    if (!note) return;
    await send('patch-notes', { id: note.id, patch });
    await ctx.reload('notes');
  };
  $main.querySelector('#note-title')?.addEventListener('blur', (e) => save({ title: e.target.value }));
  $main.querySelector('#note-body')?.addEventListener('blur', (e) => save({ body: e.target.value }));
  $main.querySelector('#note-body')?.addEventListener('input', (e) => {
    const prev = $main.querySelector('#note-preview');
    if (prev) prev.innerHTML = renderMarkdown(e.target.value);
  });
  $main.querySelector('#note-job')?.addEventListener('change', (e) => save({ jobId: e.target.value }));
  $main.querySelector('#note-pin')?.addEventListener('click', () => save({ pinned: !note?.pinned }));
  $main.querySelector('#note-del')?.addEventListener('click', async () => {
    if (!note || !confirm('Delete this note?')) return;
    await send('delete-notes', { id: note.id });
    local.selectedId = null;
    await ctx.reload('notes');
  });
}
