// Bulk Tools page — CSV import/export, JSON snapshot import/export.
// Shows dry-run preview before committing CSV imports.
import { parseCsv, parseCsvObjects, serializeCsv, downloadBlob, jobsToCsv, csvRowToJob, JOB_CSV_HEADERS } from '../csv.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Local UI state — only used inside this page module.
const local = {
  preview: null,    // { headers, items } from a CSV upload
  status: '',
};

export function render(state) {
  const jobs = state.jobs || [];
  const preview = local.preview;
  return `
    <div class="page-h">
      <div><h1>Bulk Tools</h1><div class="sub">CSV import/export · JSON backup &amp; restore</div></div>
    </div>

    <div class="grid-2">
      <div class="card">
        <h3 style="margin-top:0;font-size:14px">📥 Import CSV</h3>
        <p style="color:var(--muted);font-size:12px;margin:0 0 10px">Columns supported: <code>${JOB_CSV_HEADERS.join(', ')}</code>. Header row required.</p>
        <input type="file" id="bt-csv-file" accept=".csv,text/csv" />
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" id="bt-csv-preview">Preview</button>
          <button class="btn primary" id="bt-csv-commit" ${preview ? '' : 'disabled'}>Import ${preview ? `${preview.items.length} row${preview.items.length === 1 ? '' : 's'}` : ''}</button>
          <button class="btn" id="bt-csv-clear" ${preview ? '' : 'disabled'}>Clear preview</button>
        </div>
        ${preview ? renderPreview(preview) : ''}
      </div>

      <div class="card">
        <h3 style="margin-top:0;font-size:14px">📤 Export CSV</h3>
        <p style="color:var(--muted);font-size:12px;margin:0 0 10px">${jobs.length} application${jobs.length === 1 ? '' : 's'} will be exported.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary" id="bt-csv-export">Download all as CSV</button>
          <button class="btn" id="bt-csv-export-active">Active only</button>
        </div>
      </div>
    </div>

    <div class="grid-2" style="margin-top:14px">
      <div class="card">
        <h3 style="margin-top:0;font-size:14px">💾 Export JSON snapshot</h3>
        <p style="color:var(--muted);font-size:12px;margin:0 0 10px">Full database snapshot — jobs, documents, notes, todos, contacts, companies, settings, profile.</p>
        <button class="btn primary" id="bt-json-export">Download snapshot</button>
      </div>
      <div class="card">
        <h3 style="margin-top:0;font-size:14px">♻ Restore from JSON</h3>
        <p style="color:var(--muted);font-size:12px;margin:0 0 10px">Re-import a previously exported snapshot. Existing data is merged; duplicates are de-duped by id.</p>
        <input type="file" id="bt-json-file" accept=".json,application/json" />
        <div style="margin-top:10px"><button class="btn" id="bt-json-import">Restore</button></div>
      </div>
    </div>

    ${local.status ? `<div class="card" style="margin-top:14px"><strong>Status:</strong> ${esc(local.status)}</div>` : ''}
  `;
}

function renderPreview(preview) {
  const sample = preview.items.slice(0, 8);
  return `
    <div style="margin-top:14px;border:1px solid var(--border);border-radius:8px;padding:10px;background:rgba(99,102,241,0.04)">
      <strong style="font-size:13px">Dry-run preview (${preview.items.length} row${preview.items.length === 1 ? '' : 's'})</strong>
      <div style="overflow-x:auto;margin-top:8px">
        <table style="width:100%;font-size:12px;border-collapse:collapse">
          <thead><tr>${preview.headers.map((h) => `<th style="text-align:left;padding:4px 8px;color:var(--muted)">${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>
            ${sample.map((row) => `<tr>${preview.headers.map((h) => `<td style="padding:4px 8px;border-top:1px solid var(--border)">${esc(row[h] || '')}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${preview.items.length > sample.length ? `<div style="color:var(--muted);font-size:11px;margin-top:6px">… and ${preview.items.length - sample.length} more row(s)</div>` : ''}
    </div>
  `;
}

export function attach($main, ctx) {
  const { send, toast, render: rerender, state } = ctx;
  const $ = (sel) => $main.querySelector(sel);

  $('#bt-csv-preview')?.addEventListener('click', async () => {
    const file = $('#bt-csv-file')?.files?.[0];
    if (!file) { toast('Pick a CSV first.', 'info'); return; }
    try {
      const text = await file.text();
      const parsed = parseCsvObjects(text);
      if (!parsed.items.length) { toast('No rows found in CSV.', 'danger'); return; }
      local.preview = parsed;
      local.status = `Preview ready: ${parsed.items.length} row(s).`;
      rerender();
    } catch (e) {
      toast('Parse failed: ' + (e.message || e), 'danger');
    }
  });

  $('#bt-csv-clear')?.addEventListener('click', () => {
    local.preview = null;
    local.status = '';
    rerender();
  });

  $('#bt-csv-commit')?.addEventListener('click', async () => {
    if (!local.preview) return;
    let added = 0, failed = 0;
    for (const row of local.preview.items) {
      const job = csvRowToJob(row);
      if (!job.title || !job.company) { failed++; continue; }
      try {
        const r = await send('capture', { ...job, _source: 'csv-import' });
        if (r?.ok) added++; else failed++;
      } catch { failed++; }
    }
    local.preview = null;
    local.status = `Imported ${added} job(s)${failed ? `, ${failed} skipped` : ''}.`;
    toast(`Imported ${added} job${added === 1 ? '' : 's'}.`, added ? 'success' : 'danger');
    // Refresh
    const r = await send('list-jobs');
    if (r?.ok) state.jobs = r.items || [];
    rerender();
  });

  $('#bt-csv-export')?.addEventListener('click', () => {
    const csv = jobsToCsv(state.jobs || []);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(`jobs-${stamp}.csv`, csv);
    toast('CSV downloaded.', 'success');
  });

  $('#bt-csv-export-active')?.addEventListener('click', () => {
    const filtered = (state.jobs || []).filter((j) => !['offer', 'rejected', 'withdrawn', 'archived'].includes(j.status));
    const csv = jobsToCsv(filtered);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(`jobs-active-${stamp}.csv`, csv);
    toast(`${filtered.length} active job(s) exported.`, 'success');
  });

  $('#bt-json-export')?.addEventListener('click', async () => {
    toast('Building snapshot…', 'info');
    const stores = ['jobs', 'documents', 'notes', 'todos', 'contacts', 'companies', 'reminders', 'events', 'salaryEntries', 'goals', 'achievements', 'skills', 'savedSearches', 'templates'];
    const snapshot = { exportedAt: new Date().toISOString(), version: 2, data: {} };
    for (const s of stores) {
      try {
        const r = await send('list-' + s);
        if (r?.ok) snapshot.data[s] = r.items || [];
      } catch {}
    }
    try {
      const settings = await send('get-settings');
      const profile = await send('get-profile');
      if (settings?.ok) snapshot.settings = settings.settings;
      if (profile?.ok) snapshot.profile = profile.profile;
    } catch {}
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(`jat-snapshot-${stamp}.json`, JSON.stringify(snapshot, null, 2), 'application/json');
    toast('Snapshot downloaded.', 'success');
  });

  $('#bt-json-import')?.addEventListener('click', async () => {
    const file = $('#bt-json-file')?.files?.[0];
    if (!file) { toast('Pick a JSON snapshot first.', 'info'); return; }
    if (!confirm('Restore data from this snapshot? Existing items with the same id will be overwritten.')) return;
    try {
      const text = await file.text();
      const snap = JSON.parse(text);
      if (!snap || typeof snap !== 'object' || !snap.data) { toast('Not a valid snapshot.', 'danger'); return; }
      let restored = 0;
      for (const [store, items] of Object.entries(snap.data)) {
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          try {
            // Map known stores via the add-* endpoints; otherwise capture for jobs.
            if (store === 'jobs') {
              await send('capture', { ...item, _source: 'json-restore' });
              restored++;
            } else {
              const r = await send('add-' + store, item);
              if (r?.ok) restored++;
            }
          } catch {}
        }
      }
      if (snap.settings) await send('patch-settings', snap.settings);
      if (snap.profile) await send('patch-profile', snap.profile);
      local.status = `Restored ${restored} item(s).`;
      toast(`Restored ${restored} item${restored === 1 ? '' : 's'}.`, 'success');
      rerender();
    } catch (e) {
      toast('Restore failed: ' + (e.message || e), 'danger');
    }
  });
}
