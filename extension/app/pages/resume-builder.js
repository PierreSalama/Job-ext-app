// Resume Builder — AI-driven tailored resume drafting.
// Pick an application + a base resume document, generate a tailored draft via
// aiCall({ feature: 'tailoredResume' }), edit as markdown, save versions.
import { renderMarkdown } from '../../lib/markdown.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const local = { jobId: '', baseDocId: '', draft: '', loading: false, error: '', editingId: null, baseText: '' };

function decodeBuf(d) {
  if (!d) return '';
  try {
    if (typeof d === 'string') return d;
    if (d instanceof ArrayBuffer) return new TextDecoder().decode(d);
    if (ArrayBuffer.isView(d)) return new TextDecoder().decode(d);
    if (typeof d === 'object') {
      const keys = Object.keys(d);
      if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
        const arr = new Uint8Array(keys.length);
        for (const k of keys) arr[+k] = d[k];
        return new TextDecoder().decode(arr.buffer);
      }
    }
  } catch {}
  return '';
}

export function render(state) {
  const jobs = state.jobs || [];
  const resumes = (state.documents || []).filter((d) => d.type === 'resume');
  const versions = (state.resumeVersions || []).slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  return `
    <div class="page-h">
      <div><h1>Resume Builder</h1><div class="sub">AI-tailored drafts saved per application.</div></div>
    </div>
    <div class="card">
      <div class="grid-3" style="gap:10px">
        <div>
          <label style="font-size:12px;color:var(--muted)">Application</label>
          <select id="rb-job" style="width:100%;padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px">
            <option value="">— Select —</option>
            ${jobs.map((j) => `<option value="${esc(j.id)}"${local.jobId === j.id ? ' selected' : ''}>${esc(j.title)} · ${esc(j.company)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="font-size:12px;color:var(--muted)">Base resume</label>
          <select id="rb-base" style="width:100%;padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px">
            <option value="">— Select resume document —</option>
            ${resumes.map((d) => `<option value="${esc(d.id)}"${local.baseDocId === d.id ? ' selected' : ''}>${esc(d.name || d.originalFilename)}</option>`).join('')}
          </select>
        </div>
        <div style="display:flex;align-items:flex-end">
          <button class="btn primary" id="rb-gen" ${local.loading ? 'disabled' : ''}>${local.loading ? 'Generating…' : '✨ Generate tailored draft'}</button>
        </div>
      </div>
      ${local.error ? `<div class="empty" style="color:var(--danger);margin-top:10px">${esc(local.error)}</div>` : ''}
    </div>

    ${local.draft ? `
      <div class="card" style="margin-top:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <h3 style="margin:0;font-size:14px">${local.editingId ? 'Editing version' : 'Draft preview'}</h3>
          <div style="display:flex;gap:6px">
            <button class="btn small" id="rb-save">${local.editingId ? 'Save changes' : 'Save as version'}</button>
            <button class="btn small" id="rb-clear">Discard</button>
          </div>
        </div>
        <div class="grid-2" style="gap:10px">
          <textarea id="rb-md" style="min-height:55vh;padding:10px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;font-family:'SFMono-Regular', Consolas, monospace;font-size:12px;resize:vertical">${esc(local.draft)}</textarea>
          <div class="card" style="min-height:55vh;background:var(--bg);overflow:auto" id="rb-prev">${renderMarkdown(local.draft)}</div>
        </div>
      </div>
    ` : ''}

    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0;font-size:14px">Past versions (${versions.length})</h3>
      ${versions.length === 0 ? `<div class="empty">No saved drafts yet.</div>` : versions.map((v) => `
        <div class="list-row" style="cursor:default">
          <div>
            <div class="t">${esc(v.title || 'Untitled')}</div>
            <div class="s">${new Date(v.createdAt).toLocaleString()} · ${(v.body || '').length} chars</div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn small" data-rb-open="${esc(v.id)}">Open</button>
            <button class="btn small" data-rb-dup="${esc(v.id)}">Duplicate</button>
            <button class="btn small danger" data-rb-del="${esc(v.id)}">Delete</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

export function attach($main, ctx) {
  const { send, aiCall } = ctx;
  $main.querySelector('#rb-job')?.addEventListener('change', (e) => { local.jobId = e.target.value; });
  $main.querySelector('#rb-base')?.addEventListener('change', (e) => { local.baseDocId = e.target.value; });
  $main.querySelector('#rb-md')?.addEventListener('input', (e) => {
    local.draft = e.target.value;
    const p = $main.querySelector('#rb-prev'); if (p) p.innerHTML = renderMarkdown(local.draft);
  });
  $main.querySelector('#rb-clear')?.addEventListener('click', () => {
    local.draft = ''; local.editingId = null; ctx.render();
  });

  $main.querySelector('#rb-gen')?.addEventListener('click', async () => {
    const job = (ctx.state.jobs || []).find((j) => j.id === local.jobId);
    if (!job) { local.error = 'Pick an application first.'; ctx.render(); return; }
    const doc = (ctx.state.documents || []).find((d) => d.id === local.baseDocId);
    const baseText = doc ? decodeBuf(doc.data) : (ctx.state.profile?.summary || '');
    if (!baseText) { local.error = 'Base resume has no readable text. Upload a .txt or .md file as your base resume.'; ctx.render(); return; }
    local.loading = true; local.error = ''; local.editingId = null; ctx.render();
    const r = await aiCall({ feature: 'tailoredResume', job, baseResume: baseText, profile: ctx.state.profile || {} });
    local.loading = false;
    if (!r?.ok) { local.error = r?.error || 'AI failed'; ctx.render(); return; }
    local.draft = r.result || '';
    ctx.render();
  });

  $main.querySelector('#rb-save')?.addEventListener('click', async () => {
    if (!local.draft.trim()) return;
    const job = (ctx.state.jobs || []).find((j) => j.id === local.jobId);
    const title = job ? `${job.title} · ${job.company}` : 'Untitled draft';
    if (local.editingId) {
      await send('patch-resumeVersions', { id: local.editingId, patch: { title, body: local.draft, jobId: local.jobId } });
    } else {
      await send('add-resumeVersions', { title, body: local.draft, jobId: local.jobId });
    }
    await ctx.reload('resumeVersions');
    ctx.toast('Saved.', 'success');
  });

  $main.querySelectorAll('[data-rb-open]').forEach((b) => b.addEventListener('click', () => {
    const v = (ctx.state.resumeVersions || []).find((x) => x.id === b.dataset.rbOpen);
    if (!v) return;
    local.draft = v.body || ''; local.editingId = v.id; local.jobId = v.jobId || local.jobId;
    ctx.render();
  }));
  $main.querySelectorAll('[data-rb-dup]').forEach((b) => b.addEventListener('click', async () => {
    const v = (ctx.state.resumeVersions || []).find((x) => x.id === b.dataset.rbDup);
    if (!v) return;
    await send('add-resumeVersions', { title: (v.title || '') + ' (copy)', body: v.body || '', jobId: v.jobId || '' });
    await ctx.reload('resumeVersions');
  }));
  $main.querySelectorAll('[data-rb-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this resume version?')) return;
    await send('delete-resumeVersions', { id: b.dataset.rbDel });
    await ctx.reload('resumeVersions');
  }));
}
