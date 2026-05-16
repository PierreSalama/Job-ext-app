// JAT v10 dashboard SPA.
// Talks directly to the desktop app's REST API on localhost:7744 (the
// extension manifest has host permission; the Electron renderer has no CORS
// restriction). Same code runs in both hosts.
//
// Two views: Dashboard (#/) and Applications (#/applications, with
// #/applications/<id> for detail). Live polling every 4s, plus a manual
// refresh button. When the extension receives a `jobs.updated` broadcast
// from the SW, dashboard pages also refresh immediately.

const API = 'http://localhost:7744';

// ---------- Runtime detection ----------
const RUNTIME = (() => {
  const isExt = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  const isElectron = !isExt && /electron/i.test(navigator.userAgent || '');
  return { isExt, isElectron, label: isExt ? 'Extension' : isElectron ? 'Desktop' : 'Web' };
})();

// ---------- Status FSM (mirror of extension/lib/status.js) ----------
const STATUSES = [
  { id: 'started',         label: 'Started',         order: 10, category: 'pre' },
  { id: 'submitted',       label: 'Submitted',       order: 20, category: 'active' },
  { id: 'contacted',       label: 'Contacted',       order: 30, category: 'active' },
  { id: 'interview_1',     label: 'First interview', order: 40, category: 'active' },
  { id: 'interview_2',     label: 'Second interview',order: 50, category: 'active' },
  { id: 'interview_final', label: 'Final interview', order: 60, category: 'active' },
  { id: 'offer',           label: 'Offer',           order: 70, category: 'win' },
  { id: 'hired',           label: 'Hired',           order: 80, category: 'win' },
  { id: 'rejected',        label: 'Rejected',        order: 90, category: 'loss' },
  { id: 'withdrawn',       label: 'Withdrawn',       order: 91, category: 'loss' },
  { id: 'ghosted',         label: 'Ghosted',         order: 92, category: 'loss' },
];
const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.id, s.label]));

// ---------- API ----------
async function apiGet(path) {
  try {
    const r = await fetch(API + path, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
async function apiSend(path, method, body) {
  try {
    const r = await fetch(API + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

// ---------- Tiny utilities ----------
const $ = (sel, root = document) => root.querySelector(sel);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleDateString(); } catch { return '—'; } };
const fmtRel = (iso) => {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
};

// ---------- Router ----------
const routes = [];
function route(pattern, render) { routes.push({ pattern, render }); }
function resolve(path) {
  for (const r of routes) {
    if (typeof r.pattern === 'string' && r.pattern === path) return { render: r.render, params: {} };
    if (r.pattern instanceof RegExp) { const m = path.match(r.pattern); if (m) return { render: r.render, params: m.groups || {} }; }
  }
  return null;
}
async function navigate() {
  const path = (location.hash.replace(/^#/, '') || '/').replace(/\/+$/, '') || '/';
  const match = resolve(path) || resolve('/');
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.route === path);
  });
  const main = $('#main');
  main.innerHTML = '<div class="empty"><div class="empty-mark"></div><div class="empty-eyebrow">Loading</div></div>';
  const node = await match.render(match.params);
  main.innerHTML = '';
  main.appendChild(node);
}
window.addEventListener('hashchange', navigate);

// ---------- View: Dashboard ----------
route('/', async () => {
  const [statsR, jobsR] = await Promise.all([apiGet('/stats'), apiGet('/jobs?limit=5')]);
  const stats = statsR.ok ? statsR : { total: 0, thisWeek: 0, byStatus: {} };
  const jobs = jobsR.ok ? (jobsR.items || []) : [];
  const inProgress = ['contacted', 'interview_1', 'interview_2', 'interview_final', 'offer']
    .reduce((s, id) => s + (stats.byStatus[id] || 0), 0);
  const offers = (stats.byStatus.offer || 0) + (stats.byStatus.hired || 0);

  const pipelinePills = STATUSES.filter((s) => ['started','submitted','contacted','interview_1','offer','rejected'].includes(s.id))
    .map((s) => `<div class="pill" data-status="${s.id}"><span class="dot"></span>${esc(s.label)}<span class="count">${stats.byStatus[s.id] || 0}</span></div>`)
    .join('');

  const recent = jobs.length
    ? jobs.map((j) => `
        <tr data-id="${esc(j.id)}" class="row-link">
          <td class="title-cell">${esc(j.title || 'Untitled')}</td>
          <td>${esc(j.company || '')}</td>
          <td><span class="status-chip" data-status="${esc(j.status)}"><span class="dot"></span>${esc(STATUS_LABEL[j.status] || j.status)}</span></td>
          <td>${esc(j.source || '—')}</td>
          <td>${fmtRel(j.updatedAt)}</td>
        </tr>`).join('')
    : `<tr><td colspan="5"><div class="empty">
         <div class="empty-mark"></div>
         <div class="empty-eyebrow">Quiet ledger</div>
         <div class="empty-title">No applications yet</div>
         <div class="empty-sub">Apply to a job on LinkedIn and JAT will capture it here automatically.</div>
       </div></td></tr>`;

  const wrap = h(`
    <div>
      <header class="page-header">
        <div>
          <div class="page-eyebrow">Overview</div>
          <h1 class="page-title">Dashboard</h1>
          <div class="page-sub">A considered record of your job search — every application, every conversation, every offer.</div>
        </div>
        <div style="display:flex; gap:10px">
          <button class="btn" id="btn-refresh">Refresh</button>
          <a href="#/applications/new" class="btn primary">+ New application</a>
        </div>
      </header>

      <section class="stats">
        <div class="stat"><div class="stat-label">Applications</div><div class="stat-value">${stats.total || 0}</div><div class="stat-delta">All time</div></div>
        <div class="stat"><div class="stat-label">This week</div><div class="stat-value">${stats.thisWeek || 0}</div><div class="stat-delta">Last 7 days</div></div>
        <div class="stat"><div class="stat-label">In progress</div><div class="stat-value">${inProgress}</div><div class="stat-delta">Contacted → final round</div></div>
        <div class="stat"><div class="stat-label">Offers</div><div class="stat-value gold">${offers}</div><div class="stat-delta">All time (incl. hired)</div></div>
      </section>

      <section class="section">
        <header class="section-header">
          <div><div class="section-eyebrow">Status</div><h2 class="section-title">Pipeline</h2></div>
          <a href="#/applications" class="section-link">View all</a>
        </header>
        <div class="pipeline">${pipelinePills}</div>
      </section>

      <section class="section">
        <header class="section-header">
          <div><div class="section-eyebrow">Recent</div><h2 class="section-title">Latest applications</h2></div>
          <a href="#/applications" class="section-link">All applications</a>
        </header>
        <table class="table">
          <thead><tr><th>Title</th><th>Company</th><th>Status</th><th>Source</th><th>Updated</th></tr></thead>
          <tbody>${recent}</tbody>
        </table>
      </section>
    </div>
  `);
  wrap.querySelector('#btn-refresh').addEventListener('click', navigate);
  wrap.querySelectorAll('.row-link').forEach((tr) => {
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => { location.hash = '#/applications/' + tr.dataset.id; });
  });
  return wrap;
});

// ---------- View: Applications list ----------
route('/applications', async () => {
  const r = await apiGet('/jobs');
  const jobs = r.ok ? (r.items || []) : [];

  const rows = jobs.length
    ? jobs.map((j) => `
        <tr data-id="${esc(j.id)}" class="row-link">
          <td class="title-cell">${esc(j.title || 'Untitled')}</td>
          <td>${esc(j.company || '')}</td>
          <td><span class="status-chip" data-status="${esc(j.status)}"><span class="dot"></span>${esc(STATUS_LABEL[j.status] || j.status)}</span></td>
          <td>${esc(j.source || '—')}</td>
          <td>${fmtDate(j.createdAt)}</td>
          <td>${fmtRel(j.updatedAt)}</td>
        </tr>`).join('')
    : `<tr><td colspan="6"><div class="empty">
         <div class="empty-mark"></div>
         <div class="empty-eyebrow">No entries</div>
         <div class="empty-title">The ledger is empty</div>
         <div class="empty-sub">Hit Apply on a job and JAT will record it here. Or click <strong>+ New application</strong> to add one by hand.</div>
       </div></td></tr>`;

  const wrap = h(`
    <div>
      <header class="page-header">
        <div>
          <div class="page-eyebrow">Ledger</div>
          <h1 class="page-title">Applications</h1>
          <div class="page-sub">Every job you've applied to, in one place.</div>
        </div>
        <div style="display:flex; gap:10px">
          <button class="btn" id="btn-refresh">Refresh</button>
          <button class="btn primary" id="btn-new">+ New application</button>
        </div>
      </header>

      <section class="section">
        <table class="table">
          <thead><tr><th>Title</th><th>Company</th><th>Status</th><th>Source</th><th>Applied</th><th>Updated</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>
    </div>
  `);
  wrap.querySelector('#btn-new').addEventListener('click', () => { location.hash = '#/applications/new'; });
  wrap.querySelector('#btn-refresh').addEventListener('click', navigate);
  wrap.querySelectorAll('.row-link').forEach((tr) => {
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => { location.hash = '#/applications/' + tr.dataset.id; });
  });
  return wrap;
});

// ---------- View: Application detail ----------
route(/^\/applications\/(?<id>.+)$/, async ({ id }) => {
  const isNew = id === 'new';
  const job = isNew ? null : (await apiGet('/jobs/' + encodeURIComponent(id))).job;
  if (!isNew && !job) {
    const wrap = h(`<div>
      <header class="page-header"><div><a href="#/applications" class="back-link">← All applications</a><h1 class="page-title" style="margin-top:10px">Not found</h1></div></header>
    </div>`);
    return wrap;
  }
  const events = isNew ? [] : ((await apiGet('/events?jobId=' + encodeURIComponent(id))).items || []);

  const j = job || {};
  const statusOpts = STATUSES.map((s) => `<option value="${s.id}" ${j.status === s.id ? 'selected' : ''}>${esc(s.label)}</option>`).join('');

  const timelineHtml = events.length
    ? events.map((e) => `
        <div class="timeline-item">
          <div class="timeline-dot"></div>
          <div class="timeline-body">
            <div class="timeline-title">${esc(e.summary || e.type)}</div>
            <div class="timeline-sub">${fmtRel(e.timestamp)} · ${esc(e.source || 'extension')}</div>
          </div>
        </div>`).join('')
    : `<div class="empty" style="padding: 36px 24px"><div class="empty-sub">${isNew ? 'Save the application to start a timeline.' : 'No events yet.'}</div></div>`;

  const wrap = h(`
    <div>
      <header class="page-header">
        <div>
          <a href="#/applications" class="back-link">← All applications</a>
          <h1 class="page-title" style="margin-top:10px">${isNew ? 'New application' : esc(j.title || 'Untitled')}</h1>
          <div class="page-sub">${isNew ? 'Capture the essentials. The timeline grows as you advance.' : esc(j.company || '') + (j.location ? ' · ' + esc(j.location) : '')}</div>
        </div>
        <div style="display:flex; gap:10px">
          ${isNew ? '' : '<button class="btn" id="btn-delete">Delete</button>'}
          <button class="btn" id="btn-cancel">Cancel</button>
          <button class="btn primary" id="btn-save">${isNew ? 'Save application' : 'Save changes'}</button>
        </div>
      </header>

      <div id="save-status" class="status" style="margin-bottom:14px; text-align:left"></div>

      <div class="app-detail">
        <div>
          <section class="section">
            <header class="section-header"><div><div class="section-eyebrow">Job</div><h2 class="section-title">Posting</h2></div></header>
            <dl class="kv">
              <dt>Title</dt>      <dd><input class="input" id="f-title" value="${esc(j.title || '')}" placeholder="Senior Frontend Engineer" /></dd>
              <dt>Company</dt>    <dd><input class="input" id="f-company" value="${esc(j.company || '')}" placeholder="Acme Corp" /></dd>
              <dt>Location</dt>   <dd><input class="input" id="f-location" value="${esc(j.location || '')}" placeholder="Remote · Toronto, ON" /></dd>
              <dt>Comp</dt>       <dd><input class="input" id="f-comp" value="${esc(j.compensation || '')}" placeholder="$120k–$160k CAD" /></dd>
              <dt>Source</dt>     <dd><input class="input" id="f-source" value="${esc(j.source || '')}" placeholder="linkedin" /></dd>
              <dt>Job URL</dt>    <dd><input class="input" id="f-url" value="${esc(j.jobUrl || '')}" placeholder="https://…" /></dd>
            </dl>
          </section>
          <section class="section">
            <header class="section-header"><div><div class="section-eyebrow">Marginalia</div><h2 class="section-title">Notes</h2></div></header>
            <div style="padding: 20px 24px">
              <textarea class="input" id="f-notes" rows="6" style="width:100%; resize:vertical" placeholder="Anything worth remembering…">${esc(j.notes || '')}</textarea>
            </div>
          </section>
          ${(j.attachments && j.attachments.length) ? `
          <section class="section">
            <header class="section-header"><div><div class="section-eyebrow">Files</div><h2 class="section-title">Attachments</h2></div></header>
            <div style="padding: 16px 24px">
              ${j.attachments.map((a) => `<div class="jat-line" style="font-size:12px; color:#d9d2c6; margin-bottom:6px">${esc(a.role)}: <strong style="color:#f4efe6">${esc(a.name)}</strong> <span style="color:#8b8378">(${Math.round((a.sizeBytes||0)/1024)} KB)</span></div>`).join('')}
            </div>
          </section>` : ''}
        </div>

        <div>
          <section class="section">
            <header class="section-header"><div><div class="section-eyebrow">Standing</div><h2 class="section-title">Status</h2></div></header>
            <dl class="kv">
              <dt>Status</dt>      <dd><select class="select" id="f-status">${statusOpts}</select></dd>
              <dt>Next action</dt> <dd><input class="input" id="f-next" value="${esc(j.nextAction || '')}" placeholder="Follow up via email" /></dd>
              <dt>Due</dt>         <dd><input class="input" id="f-due" type="date" value="${esc((j.dueAt || '').slice(0,10))}" /></dd>
              ${j.submittedAt ? `<dt>Submitted</dt><dd>${fmtDate(j.submittedAt)}</dd>` : ''}
            </dl>
          </section>

          <section class="section">
            <header class="section-header"><div><div class="section-eyebrow">Record</div><h2 class="section-title">Timeline</h2></div></header>
            <div class="timeline">${timelineHtml}</div>
          </section>
        </div>
      </div>
    </div>
  `);

  const setStatus = (msg, cls = '') => { const el = wrap.querySelector('#save-status'); el.className = 'status ' + cls; el.textContent = msg; };

  wrap.querySelector('#btn-cancel').addEventListener('click', () => { location.hash = '#/applications'; });

  if (!isNew) {
    wrap.querySelector('#btn-delete').addEventListener('click', async () => {
      if (!confirm('Delete this application? This cannot be undone.')) return;
      const r = await apiSend('/jobs/' + encodeURIComponent(id), 'DELETE');
      if (r.ok) location.hash = '#/applications';
      else setStatus(r.error || 'Delete failed', 'bad');
    });
  }

  wrap.querySelector('#btn-save').addEventListener('click', async () => {
    const payload = {
      title:     wrap.querySelector('#f-title').value.trim(),
      company:   wrap.querySelector('#f-company').value.trim(),
      location:  wrap.querySelector('#f-location').value.trim(),
      compensation: wrap.querySelector('#f-comp').value.trim(),
      source:    wrap.querySelector('#f-source').value.trim(),
      jobUrl:    wrap.querySelector('#f-url').value.trim(),
      notes:     wrap.querySelector('#f-notes').value,
      nextAction:wrap.querySelector('#f-next').value.trim(),
      dueAt:     wrap.querySelector('#f-due').value || null,
      status:    wrap.querySelector('#f-status').value,
      _source:   'manual',
    };
    if (!payload.title || !payload.company) { setStatus('Title and company are required.', 'bad'); return; }
    setStatus('Saving…');
    if (isNew) {
      const r = await apiSend('/jobs', 'POST', payload);
      if (r.ok && r.job?.id) location.hash = '#/applications/' + r.job.id;
      else setStatus(r.error || 'Save failed', 'bad');
    } else {
      const r = await apiSend('/jobs/' + encodeURIComponent(id), 'PATCH', payload);
      if (r.ok) { setStatus('Saved', 'ok'); setTimeout(() => navigate(), 600); }
      else setStatus(r.error || 'Save failed', 'bad');
    }
  });

  return wrap;
});

// ---------- Footer status ----------
async function paintRuntime() {
  const dot = $('#runtime-dot');
  const txt = $('#runtime-text');
  const vEl = $('#brand-version');
  let version = '';
  try { if (RUNTIME.isExt) version = chrome.runtime.getManifest().version; } catch {}
  vEl.textContent = version ? `v${version}` : 'v10';
  // Probe the app to show connection
  const probe = await fetch(API + '/health', { signal: AbortSignal.timeout(1200) }).catch(() => null);
  if (probe?.ok) { dot.className = 'status-dot ok'; txt.textContent = RUNTIME.label + ' · app online'; }
  else           { dot.className = 'status-dot bad'; txt.textContent = RUNTIME.label + ' · app offline'; }
}

// ---------- Live refresh ----------
let pollTimer = null;
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    // Only refresh list/dashboard routes, not detail edit forms
    const p = location.hash.replace(/^#/, '') || '/';
    if (p === '/' || p === '/applications') navigate();
    paintRuntime();
  }, 4000);
}
// Background broadcast → immediate refresh
if (RUNTIME.isExt) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'jobs.updated') {
      const p = location.hash.replace(/^#/, '') || '/';
      if (p === '/' || p === '/applications') navigate();
    }
  });
}

// ---------- Boot ----------
paintRuntime();
if (!location.hash) location.hash = '#/';
navigate();
startPolling();
