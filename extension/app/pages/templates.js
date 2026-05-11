// Email + cover letter templates with markdown body and {variable} hints.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

let _editing = null; // template id or 'new'
let _picker = null; // template id for "Use" picker

const VARS = ['{title}', '{company}', '{firstName}', '{recruiterName}'];

function uuid() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 't-' + Date.now();
}

function fillVars(text, ctxJob, profile) {
  return String(text || '')
    .replaceAll('{title}', ctxJob?.title || '')
    .replaceAll('{company}', ctxJob?.company || '')
    .replaceAll('{firstName}', profile?.firstName || '')
    .replaceAll('{recruiterName}', ctxJob?.recruiterName || '');
}

export function render(state) {
  const all = (state.emailTemplates || []).slice().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const editingTpl = _editing === 'new' ? { id: 'new', name: '', kind: 'email', subject: '', body: '' } : all.find((t) => t.id === _editing);

  return `
    <div class="page-h">
      <div><h1>Email templates</h1><div class="sub">${all.length} template${all.length === 1 ? '' : 's'} · email + cover letter snippets</div></div>
      <div><button class="btn primary" id="tpl-new">+ New template</button></div>
    </div>
    ${editingTpl ? editorHtml(editingTpl) : ''}
    ${_picker ? pickerHtml(_picker, state, all) : ''}
    <div class="card">
      ${all.length === 0 ? `<div class="empty"><strong>No templates yet.</strong>Create reusable email + cover-letter snippets with {title}, {company}, {firstName}, {recruiterName} placeholders.</div>` : `
        <div class="list">
          ${all.map((t) => rowHtml(t)).join('')}
        </div>
      `}
    </div>
  `;
}

function rowHtml(t) {
  return `
    <div class="list-row" style="cursor:default">
      <div>
        <div class="t">${esc(t.name || 'Untitled')}</div>
        <div class="s">${t.kind === 'email' ? (esc(t.subject || '(no subject)')) : 'Cover letter'} · ${esc((t.body || '').slice(0, 60))}…</div>
      </div>
      <span class="pill source">${t.kind === 'email' ? '📧 Email' : '✍ Cover'}</span>
      <div style="display:flex;gap:6px">
        <button class="btn small primary" data-use="${esc(t.id)}">Use</button>
        <button class="btn small" data-edit="${esc(t.id)}">Edit</button>
        <button class="btn small danger" data-del="${esc(t.id)}">×</button>
      </div>
    </div>
  `;
}

function editorHtml(t) {
  return `
    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-top:0;font-size:14px">${t.id === 'new' ? 'New template' : 'Edit template'}</h3>
      <div class="grid-2">
        <div><label>Name</label><input type="text" id="tpl-name" value="${esc(t.name)}" /></div>
        <div><label>Kind</label>
          <select id="tpl-kind">
            <option value="email"${t.kind === 'email' ? ' selected' : ''}>Email</option>
            <option value="cover_letter"${t.kind === 'cover_letter' ? ' selected' : ''}>Cover letter</option>
          </select>
        </div>
      </div>
      <div id="tpl-subj-wrap" style="${t.kind === 'cover_letter' ? 'display:none' : ''}">
        <label>Subject</label><input type="text" id="tpl-subj" value="${esc(t.subject)}" />
      </div>
      <label>Body (markdown)</label>
      <textarea id="tpl-body" rows="10">${esc(t.body)}</textarea>
      <div style="font-size:11px;color:var(--muted);margin-top:4px">Insert variables: ${VARS.map((v) => `<code style="background:rgba(255,255,255,0.05);padding:1px 4px;border-radius:3px;margin-right:4px">${esc(v)}</code>`).join('')}</div>
      <div style="display:flex;gap:6px;margin-top:12px">
        <button class="btn primary" id="tpl-save">Save</button>
        <button class="btn" id="tpl-cancel">Cancel</button>
      </div>
    </div>
  `;
}

function pickerHtml(id, state, all) {
  const tpl = all.find((t) => t.id === id);
  if (!tpl) return '';
  const jobs = state.jobs || [];
  return `
    <div class="cal-popover" id="tpl-picker">
      <div class="card" onclick="event.stopPropagation()">
        <h3 style="margin-top:0;font-size:14px">Use template: ${esc(tpl.name)}</h3>
        <label>Apply variables for job (optional)</label>
        <select id="tpl-job">
          <option value="">— No job (raw template) —</option>
          ${jobs.slice(0, 200).map((j) => `<option value="${esc(j.id)}">${esc(j.title)} · ${esc(j.company)}</option>`).join('')}
        </select>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:12px">
          <button class="btn primary" id="tpl-do-copy">📋 Copy</button>
          ${tpl.kind === 'email' ? `<button class="btn" id="tpl-do-mailto">📧 Email</button>` : `<span></span>`}
          ${tpl.kind === 'cover_letter' ? `<a class="btn" href="#/cover-studio">✍ Cover studio</a>` : `<span></span>`}
        </div>
        <div style="margin-top:10px"><button class="btn small" id="tpl-pick-cancel">Cancel</button></div>
      </div>
      <style>
        .cal-popover { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 100; display: flex; align-items: center; justify-content: center; }
        .cal-popover .card { width: 420px; max-width: 90vw; }
      </style>
    </div>
  `;
}

export function attach($main, ctx) {
  const { send, toast, render: rerender, state } = ctx;

  $main.querySelector('#tpl-new')?.addEventListener('click', () => { _editing = 'new'; rerender(); });
  $main.querySelector('#tpl-cancel')?.addEventListener('click', () => { _editing = null; rerender(); });
  $main.querySelector('#tpl-kind')?.addEventListener('change', (e) => {
    const w = $main.querySelector('#tpl-subj-wrap');
    if (w) w.style.display = e.target.value === 'cover_letter' ? 'none' : '';
  });
  $main.querySelector('#tpl-save')?.addEventListener('click', async () => {
    const payload = {
      name: $main.querySelector('#tpl-name').value.trim() || 'Untitled',
      kind: $main.querySelector('#tpl-kind').value,
      subject: $main.querySelector('#tpl-subj')?.value || '',
      body: $main.querySelector('#tpl-body').value,
      updatedAt: new Date().toISOString()
    };
    if (_editing === 'new') {
      payload.id = uuid();
      payload.createdAt = payload.updatedAt;
      const r = await send('add-emailTemplate', payload);
      if (r?.ok) { _editing = null; toast('Template created.', 'success'); }
    } else {
      const r = await send('patch-emailTemplate', { id: _editing, patch: payload });
      if (r?.ok) { _editing = null; toast('Saved.', 'success'); }
    }
  });

  $main.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => { _editing = b.dataset.edit; rerender(); }));
  $main.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this template?')) return;
    await send('delete-emailTemplate', { id: b.dataset.del });
    toast('Deleted.', 'success');
  }));
  $main.querySelectorAll('[data-use]').forEach((b) => b.addEventListener('click', () => { _picker = b.dataset.use; rerender(); }));

  const popover = $main.querySelector('#tpl-picker');
  if (popover) {
    popover.addEventListener('click', () => { _picker = null; rerender(); });
    $main.querySelector('#tpl-pick-cancel')?.addEventListener('click', () => { _picker = null; rerender(); });
    const tpl = (state.emailTemplates || []).find((t) => t.id === _picker);
    $main.querySelector('#tpl-do-copy')?.addEventListener('click', async () => {
      const jobId = $main.querySelector('#tpl-job').value;
      const job = jobId ? (state.jobs || []).find((j) => j.id === jobId) : null;
      const text = (tpl?.kind === 'email' ? `Subject: ${fillVars(tpl?.subject, job, state.profile)}\n\n` : '') + fillVars(tpl?.body, job, state.profile);
      try { await navigator.clipboard.writeText(text); toast('Copied to clipboard.', 'success'); _picker = null; rerender(); }
      catch { toast('Copy failed.', 'danger'); }
    });
    $main.querySelector('#tpl-do-mailto')?.addEventListener('click', () => {
      const jobId = $main.querySelector('#tpl-job').value;
      const job = jobId ? (state.jobs || []).find((j) => j.id === jobId) : null;
      const subj = encodeURIComponent(fillVars(tpl?.subject, job, state.profile));
      const body = encodeURIComponent(fillVars(tpl?.body, job, state.profile));
      window.open(`mailto:?subject=${subj}&body=${body}`, '_blank');
      _picker = null; rerender();
    });
  }
}
