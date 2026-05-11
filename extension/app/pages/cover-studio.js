// Cover Letter Studio — generate, tone-tweak, and store cover letters per job.
import { renderMarkdown } from '../../lib/markdown.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TONES = [
  { id: 'formal', label: 'Formal', hint: 'Professional, restrained, classic.' },
  { id: 'friendly', label: 'Friendly', hint: 'Warm and personable.' },
  { id: 'enthusiastic', label: 'Enthusiastic', hint: 'High energy, excited.' },
  { id: 'concise', label: 'Concise', hint: 'Tight, ~150 words.' }
];
const local = { jobId: '', tone: 'friendly', draft: '', loading: false, error: '', editingId: null };

function fillVars(text, job, profile) {
  return String(text || '')
    .replace(/\{title\}/g, job?.title || '')
    .replace(/\{company\}/g, job?.company || '')
    .replace(/\{firstName\}/g, profile?.firstName || profile?.fullName || '');
}

export function render(state) {
  const jobs = state.jobs || [];
  const versions = (state.coverLetters || []).slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  return `
    <div class="page-h">
      <div><h1>Cover Letter Studio</h1><div class="sub">Tone presets, template variables, versioning.</div></div>
    </div>
    <div class="card">
      <div class="grid-2" style="gap:10px">
        <div>
          <label style="font-size:12px;color:var(--muted)">Application</label>
          <select id="cs-job" style="width:100%;padding:6px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px">
            <option value="">— Select —</option>
            ${jobs.map((j) => `<option value="${esc(j.id)}"${local.jobId === j.id ? ' selected' : ''}>${esc(j.title)} · ${esc(j.company)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="font-size:12px;color:var(--muted)">Tone</label>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${TONES.map((t) => `<button class="btn small${local.tone === t.id ? ' primary' : ''}" data-cs-tone="${t.id}" title="${esc(t.hint)}">${t.label}</button>`).join('')}
          </div>
        </div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px">
        <button class="btn primary" id="cs-gen" ${local.loading ? 'disabled' : ''}>${local.loading ? 'Generating…' : '✨ Generate cover letter'}</button>
        <span style="font-size:11px;color:var(--muted);align-self:center">Variables available: {title}, {company}, {firstName}</span>
      </div>
      ${local.error ? `<div class="empty" style="color:var(--danger);margin-top:10px">${esc(local.error)}</div>` : ''}
    </div>

    ${local.draft ? `
      <div class="card" style="margin-top:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <h3 style="margin:0;font-size:14px">Draft</h3>
          <div style="display:flex;gap:6px">
            <button class="btn small" id="cs-copy">Copy</button>
            <button class="btn small" id="cs-save">${local.editingId ? 'Save changes' : 'Save version'}</button>
            <button class="btn small" id="cs-clear">Discard</button>
          </div>
        </div>
        <div class="grid-2" style="gap:10px">
          <textarea id="cs-md" style="min-height:50vh;padding:10px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;font-size:13px;resize:vertical">${esc(local.draft)}</textarea>
          <div class="card" style="min-height:50vh;background:var(--bg);overflow:auto" id="cs-prev">${renderMarkdown(local.draft)}</div>
        </div>
      </div>
    ` : ''}

    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0;font-size:14px">Saved letters (${versions.length})</h3>
      ${versions.length === 0 ? `<div class="empty">No cover letters saved yet.</div>` : versions.map((v) => {
        const job = (state.jobs || []).find((j) => j.id === v.jobId);
        return `<div class="list-row" style="cursor:default">
          <div>
            <div class="t">${esc(v.title || (job ? `${job.title} · ${job.company}` : 'Untitled'))}</div>
            <div class="s">${new Date(v.createdAt).toLocaleString()}${v.tone ? ' · ' + esc(v.tone) : ''}</div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn small" data-cs-open="${esc(v.id)}">Open</button>
            <button class="btn small danger" data-cs-del="${esc(v.id)}">Delete</button>
          </div>
        </div>`;
      }).join('')}
    </div>
  `;
}

export function attach($main, ctx) {
  const { send, aiCall } = ctx;
  $main.querySelector('#cs-job')?.addEventListener('change', (e) => { local.jobId = e.target.value; });
  $main.querySelectorAll('[data-cs-tone]').forEach((b) => b.addEventListener('click', () => { local.tone = b.dataset.csTone; ctx.render(); }));
  $main.querySelector('#cs-md')?.addEventListener('input', (e) => {
    local.draft = e.target.value;
    const p = $main.querySelector('#cs-prev'); if (p) p.innerHTML = renderMarkdown(local.draft);
  });
  $main.querySelector('#cs-clear')?.addEventListener('click', () => { local.draft = ''; local.editingId = null; ctx.render(); });

  $main.querySelector('#cs-gen')?.addEventListener('click', async () => {
    const job = (ctx.state.jobs || []).find((j) => j.id === local.jobId);
    if (!job) { local.error = 'Pick an application first.'; ctx.render(); return; }
    const tone = TONES.find((t) => t.id === local.tone) || TONES[0];
    const profile = ctx.state.profile || {};
    // Inject tone instruction by prepending to the description excerpt the model uses
    const tonedJob = { ...job, description: `[Write in a ${tone.label.toLowerCase()} tone — ${tone.hint}]\n\n${job.description || ''}` };
    local.loading = true; local.error = ''; local.editingId = null; ctx.render();
    const r = await aiCall({ feature: 'coverLetter', job: tonedJob, profile });
    local.loading = false;
    if (!r?.ok) { local.error = r?.error || 'AI failed'; ctx.render(); return; }
    local.draft = fillVars(r.result || '', job, profile);
    ctx.render();
  });

  $main.querySelector('#cs-copy')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(local.draft); ctx.toast('Copied.', 'success'); }
    catch { ctx.toast('Copy failed.', 'danger'); }
  });

  $main.querySelector('#cs-save')?.addEventListener('click', async () => {
    if (!local.draft.trim()) return;
    const job = (ctx.state.jobs || []).find((j) => j.id === local.jobId);
    const title = job ? `${job.title} · ${job.company}` : 'Untitled letter';
    if (local.editingId) {
      await send('patch-coverLetters', { id: local.editingId, patch: { title, body: local.draft, tone: local.tone, jobId: local.jobId } });
    } else {
      await send('add-coverLetters', { title, body: local.draft, tone: local.tone, jobId: local.jobId });
    }
    await ctx.reload('coverLetters');
    ctx.toast('Saved.', 'success');
  });

  $main.querySelectorAll('[data-cs-open]').forEach((b) => b.addEventListener('click', () => {
    const v = (ctx.state.coverLetters || []).find((x) => x.id === b.dataset.csOpen);
    if (!v) return;
    local.draft = v.body || ''; local.editingId = v.id; local.jobId = v.jobId || ''; local.tone = v.tone || local.tone;
    ctx.render();
  }));
  $main.querySelectorAll('[data-cs-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this cover letter?')) return;
    await send('delete-coverLetters', { id: b.dataset.csDel });
    await ctx.reload('coverLetters');
  }));
}
