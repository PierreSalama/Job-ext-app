// Unified inbox of messages (LinkedIn DMs, Gmail, Indeed). Each message has source + threadId + body.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

let _filterSrc = 'all';
let _search = '';
let _expanded = null;
let _adding = false;

function fmt(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 86400000) return d.toTimeString().slice(0, 5);
    if (diff < 7 * 86400000) return d.toLocaleDateString(undefined, { weekday: 'short' });
    return d.toLocaleDateString();
  } catch { return ''; }
}

export function render(state) {
  const all = (state.messages || []).slice().sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || ''));
  const sources = ['all', ...new Set(all.map((m) => m.source || 'Unknown'))];
  const q = _search.toLowerCase();
  const list = all.filter((m) => {
    if (_filterSrc !== 'all' && (m.source || 'Unknown') !== _filterSrc) return false;
    if (q && !(`${m.from || ''} ${m.subject || ''} ${m.body || ''}`.toLowerCase().includes(q))) return false;
    return true;
  });

  return `
    <div class="page-h">
      <div><h1>Inbox</h1><div class="sub">${list.length} message${list.length === 1 ? '' : 's'}${_filterSrc !== 'all' ? ' from ' + esc(_filterSrc) : ''}</div></div>
      <div style="display:flex;gap:8px"><button class="btn primary" id="msg-add-toggle">${_adding ? 'Cancel' : '+ Add message'}</button></div>
    </div>

    ${_adding ? addFormHtml(state) : ''}

    <div class="toolbar">
      <input type="text" id="msg-search" placeholder="Search sender, subject, body…" value="${esc(_search)}" />
      <select id="msg-src">
        ${sources.map((s) => `<option value="${esc(s)}"${_filterSrc === s ? ' selected' : ''}>${s === 'all' ? 'All sources' : esc(s)}</option>`).join('')}
      </select>
    </div>

    <div class="card">
      ${list.length === 0 ? emptyHtml() : `
        <div class="list">
          ${list.map((m) => rowHtml(m, state)).join('')}
        </div>
      `}
    </div>
  `;
}

function emptyHtml() {
  return `
    <div class="empty">
      <strong>No messages yet.</strong>
      Messages are captured automatically when you DM on LinkedIn (foreground content script) and from Gmail once you connect OAuth.
      For now you can paste any message in via "+ Add message" above.
    </div>
  `;
}

function addFormHtml(state) {
  const jobs = state.jobs || [];
  return `
    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-top:0;font-size:14px">Add message</h3>
      <div class="grid-2">
        <div><label>From (sender)</label><input type="text" id="m-from" /></div>
        <div><label>Source</label>
          <select id="m-src">
            <option>LinkedIn</option><option>Gmail</option><option>Indeed</option><option>Other</option>
          </select>
        </div>
      </div>
      <label>Subject</label><input type="text" id="m-subj" />
      <label>Body</label><textarea id="m-body" rows="4"></textarea>
      <label>Link to application (optional)</label>
      <select id="m-job">
        <option value="">— None —</option>
        ${jobs.slice(0, 200).map((j) => `<option value="${esc(j.id)}">${esc(j.title)} · ${esc(j.company)}</option>`).join('')}
      </select>
      <div style="margin-top:10px"><button class="btn primary" id="m-save">Save message</button></div>
    </div>
  `;
}

function rowHtml(m, state) {
  const isOpen = _expanded === m.id;
  const job = m.jobId ? (state.jobs || []).find((j) => j.id === m.jobId) : null;
  const snippet = (m.subject || m.body || '').slice(0, 100);
  return `
    <div class="msg-row${isOpen ? ' open' : ''}" data-msg="${esc(m.id)}">
      <div class="list-row" data-msg-toggle="${esc(m.id)}">
        <div>
          <div class="t">${esc(m.from || 'Unknown sender')}</div>
          <div class="s">${esc(snippet)}${snippet.length === 100 ? '…' : ''}</div>
        </div>
        <span class="pill source">${esc(m.source || 'Manual')}</span>
        <span class="s" style="font-size:11px;color:var(--muted)">${esc(fmt(m.receivedAt))}</span>
      </div>
      ${isOpen ? `
        <div class="card" style="margin:6px 0 12px">
          <div style="white-space:pre-wrap;font-size:13px;line-height:1.5;margin-bottom:10px">${esc(m.body || '(empty body)')}</div>
          <label>Link to application</label>
          <select data-msg-link="${esc(m.id)}">
            <option value="">— None —</option>
            ${(state.jobs || []).slice(0, 200).map((j) => `<option value="${esc(j.id)}"${m.jobId === j.id ? ' selected' : ''}>${esc(j.title)} · ${esc(j.company)}</option>`).join('')}
          </select>
          ${job ? `<div style="margin-top:6px;font-size:12px"><a href="#/job/${esc(job.id)}">→ Open ${esc(job.title)}</a></div>` : ''}
          <div style="margin-top:10px;display:flex;gap:6px">
            <button class="btn small danger" data-msg-del="${esc(m.id)}">Delete</button>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

export function attach($main, ctx) {
  const { send, toast, render: rerender } = ctx;
  $main.querySelector('#msg-search')?.addEventListener('input', (e) => { _search = e.target.value; rerender(); });
  $main.querySelector('#msg-src')?.addEventListener('change', (e) => { _filterSrc = e.target.value; rerender(); });
  $main.querySelector('#msg-add-toggle')?.addEventListener('click', () => { _adding = !_adding; rerender(); });

  $main.querySelector('#m-save')?.addEventListener('click', async () => {
    const payload = {
      from: $main.querySelector('#m-from').value.trim(),
      source: $main.querySelector('#m-src').value,
      subject: $main.querySelector('#m-subj').value.trim(),
      body: $main.querySelector('#m-body').value,
      jobId: $main.querySelector('#m-job').value,
      receivedAt: new Date().toISOString()
    };
    if (!payload.from && !payload.body) { toast('Add at least sender or body.', 'danger'); return; }
    const r = await send('add-message', payload);
    if (r?.ok) { _adding = false; toast('Message saved.', 'success'); }
  });

  $main.querySelectorAll('[data-msg-toggle]').forEach((el) => el.addEventListener('click', () => {
    _expanded = _expanded === el.dataset.msgToggle ? null : el.dataset.msgToggle;
    rerender();
  }));
  $main.querySelectorAll('[data-msg-link]').forEach((sel) => sel.addEventListener('change', async () => {
    await send('patch-message', { id: sel.dataset.msgLink, patch: { jobId: sel.value } });
    toast('Linked.', 'success');
  }));
  $main.querySelectorAll('[data-msg-del]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete message?')) return;
    await send('delete-message', { id: b.dataset.msgDel });
    _expanded = null;
    toast('Deleted.', 'success');
  }));
}
