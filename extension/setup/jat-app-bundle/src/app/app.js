// Single-page app for v5. Hash routing, vanilla JS, no build step.
// DESKTOP BUILD: chrome.* APIs are replaced with window.jat5 bridge → local
// HTTP server on :7733 backed by SQLite. The shape of `send(type, data)` is
// preserved verbatim so the same logic works in both extension and desktop.
import { STATUS_LABELS, STATUSES } from '../lib/schema.js';
import { THEMES, applyTheme } from '../lib/themes.js';
import { ICON_PRESETS, presetToSvgDataUrl, presetToIconBundle, imageUrlToIconBundle } from '../lib/icon-presets.js';

const send = (type, data) => window.jat5.api({ type, data });

// Pre-rasterize an icon bundle in the page (which has full SVG → canvas
// support) and ship it to the main process as a structure-cloneable plain
// object. (Desktop build doesn't drive a browser-action icon, but we keep
// the wire format so the extension and desktop share message shapes.)
function imageDataToPlain(id) {
  return { width: id.width, height: id.height, data: Array.from(id.data) };
}
async function applyIconBundle(bundle) {
  const plain = {};
  for (const k of Object.keys(bundle)) plain[k] = imageDataToPlain(bundle[k]);
  return send('set-icon-bundle', { bundle: plain });
}
async function clearIconBundle() {
  return send('set-icon-bundle', { bundle: null });
}

// Normalize whatever survived the structured-clone roundtrip back into a Blob
// with the correct MIME type. Some Chrome versions deliver the IDB ArrayBuffer
// as an object with numeric keys after sendMessage — this guards against that.
const MIME_BY_EXT = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  rtf: 'application/rtf',
  odt: 'application/vnd.oasis.opendocument.text',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml'
};
function makeDocBlob(d) {
  const filename = d.originalFilename || d.name || '';
  const ext = (filename.split('.').pop() || '').toLowerCase();
  let mime = d.mimeType && d.mimeType !== 'application/octet-stream' ? d.mimeType : (MIME_BY_EXT[ext] || 'application/octet-stream');
  let buf = d.data;
  if (buf == null) throw new Error('No file data');
  // Already a Blob
  if (buf instanceof Blob) return buf.type ? buf : new Blob([buf], { type: mime });
  // ArrayBuffer or typed array — fastest path
  if (buf instanceof ArrayBuffer) return new Blob([buf], { type: mime });
  if (ArrayBuffer.isView(buf)) return new Blob([buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)], { type: mime });
  // Plain object with numeric keys (post-clone fallback)
  if (typeof buf === 'object') {
    const keys = Object.keys(buf);
    if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
      const arr = new Uint8Array(keys.length);
      for (const k of keys) arr[+k] = buf[k];
      return new Blob([arr.buffer], { type: mime });
    }
  }
  if (Array.isArray(buf)) return new Blob([new Uint8Array(buf).buffer], { type: mime });
  throw new Error('Unrecognized file data shape: ' + (typeof buf));
}

// Desktop AI client. The main process can talk directly to Ollama via fetch
// (no MV3 service-worker concerns), so we route AI calls through the same
// JSON-RPC channel as everything else. Long requests are fine — the HTTP
// connection stays alive until the response lands.
function aiCall(data) {
  return window.jat5.api({ type: 'ai-call', data });
}
const $ = (s, root) => (root || document).querySelector(s);
const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));

const state = {
  route: location.hash.slice(1) || '/',
  jobs: [],
  summary: null,
  profile: {},
  settings: {},
  selectedJobId: null,
  aiStatus: null,
  aiResults: {},     // jobId -> { feature -> result }
  aiLoading: {},     // jobId -> { feature -> bool }
  filter: { status: 'all', source: 'all', search: '' },
  answers: [],
  recommendations: [],
  recsLoading: false,
  aiWizardStep: 1,
  aiTestResult: null,
  documents: [],
};

const DOC_TYPES = [
  ['resume', 'Resume'],
  ['coverLetter', 'Cover letter'],
  ['transcript', 'Transcript'],
  ['portfolio', 'Portfolio'],
  ['other', 'Other'],
];
const DOC_TYPE_LABEL = Object.fromEntries(DOC_TYPES);

const SOURCES = [
  { id: 'LinkedIn', host: 'linkedin.com', icon: 'in', desc: 'Watches job pages and Easy Apply' },
  { id: 'Indeed', host: 'indeed.com', icon: 'I', desc: 'Indeed Apply modal + applied state' },
  { id: 'Glassdoor', host: 'glassdoor.com', icon: 'G', desc: 'JobListing pages + apply modal' },
  { id: 'Greenhouse', host: 'boards.greenhouse.io', icon: 'GH', desc: 'Inline application form + thank you' },
  { id: 'Lever', host: 'jobs.lever.co', icon: 'L', desc: 'Lever-hosted apply forms' },
  { id: 'Workday', host: '*.myworkdayjobs.com', icon: 'W', desc: 'Multi-step Workday wizard' },
  { id: 'Generic', host: 'JSON-LD JobPosting', icon: '★', desc: 'Any site with structured data' },
];

async function load() {
  const [s, l, p, st, ai] = await Promise.all([
    send('status-summary'),
    send('list-jobs'),
    send('get-profile'),
    send('get-settings'),
    send('ai-status'),
  ]);
  if (s?.ok) state.summary = s.summary;
  if (l?.ok) state.jobs = l.items || [];
  if (p?.ok) state.profile = p.profile || {};
  if (st?.ok) state.settings = st.settings || {};
  if (ai?.ok) state.aiStatus = ai.status;
  applyTheme(state.settings.theme || 'midnight');
  // Also load Q&A and recommendations
  const [qa, recs, docs] = await Promise.all([send('list-answers'), send('list-recommendations'), send('list-documents')]);
  if (qa?.ok) state.answers = qa.items || [];
  if (recs?.ok) state.recommendations = recs.items || [];
  if (docs?.ok) state.documents = docs.items || [];
  render();
}

function setRoute() {
  state.route = location.hash.slice(1) || '/';
  if (state.route.startsWith('/job/')) {
    state.selectedJobId = state.route.split('/')[2];
  }
  render();
}
window.addEventListener('hashchange', setRoute);

// Desktop event bridge — main-process broadcasts (e.g. when the extension
// pushes an IDB snapshot via the sync server) arrive on window.jat5.onEvent.
// The handler shape mirrors the extension's chrome.runtime.onMessage payload
// so the rest of this function is identical.
window.jat5.onEvent((msg) => {
  if (msg?.type !== 'jat-event') return;
  const { name, data } = msg;
  if (name === 'job.created' || name === 'job.updated') {
    const i = state.jobs.findIndex((j) => j.id === data.job.id);
    if (i >= 0) state.jobs[i] = data.job; else state.jobs.push(data.job);
    refreshSummary();
    render();
  } else if (name === 'job.deleted') {
    state.jobs = state.jobs.filter((j) => j.id !== data.id);
    refreshSummary();
    render();
  } else if (name === 'settings.updated') {
    state.settings = data.settings;
    if (data.settings?.theme) applyTheme(data.settings.theme);
    render();
  } else if (name === 'recommendations.updated') {
    send('list-recommendations').then((r) => { if (r?.ok) { state.recommendations = r.items; render(); } });
  } else if (name === 'documents.updated') {
    send('list-documents').then((r) => { if (r?.ok) { state.documents = r.items || []; render(); } });
  } else if (name === 'profile.updated') {
    state.profile = data.profile || state.profile;
    // Refresh learned answers too — record-answer often triggers this
    send('list-answers').then((r) => { if (r?.ok) { state.answers = r.items || []; render(); } });
  }
});

async function refreshSummary() {
  const r = await send('status-summary');
  if (r?.ok) state.summary = r.summary;
}

function render() {
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === state.route || (state.route.startsWith('/job/') && a.dataset.route === '/jobs')));
  // Sidebar brand icon — reflects chosen preset / custom icon
  const brand = $('.brand .logo');
  if (brand) {
    const presetId = state.settings.iconPreset;
    const custom = state.settings.iconCustomDataUrl;
    if (custom) {
      brand.innerHTML = `<img src="${escape(custom)}" style="width:100%;height:100%;border-radius:10px;object-fit:cover" />`;
      brand.style.background = 'transparent';
    } else if (presetId) {
      const preset = ICON_PRESETS.find((p) => p.id === presetId);
      if (preset) {
        brand.innerHTML = `<span style="font-size:20px">${preset.emoji}</span>`;
        brand.style.background = `linear-gradient(135deg, ${preset.bg[0]}, ${preset.bg[1]})`;
      }
    } else {
      brand.innerHTML = 'JAT';
      brand.style.background = '';
    }
  }
  // AI pill
  const pill = $('#ai-pill');
  if (state.aiStatus?.available) pill.className = 'ai-status ok', pill.textContent = `✨ AI: ${state.aiStatus.provider} ready`;
  else pill.className = 'ai-status bad', pill.textContent = `⚠ AI off — configure in Settings`;

  let html;
  if (state.route === '/') html = pageDashboard();
  else if (state.route === '/jobs') html = pageJobs();
  else if (state.route.startsWith('/job/')) html = pageJobDetail();
  else if (state.route === '/profile') html = pageProfile();
  else if (state.route === '/settings') html = pageSettings();
  else if (state.route === '/ai') html = pageAi();
  else if (state.route === '/documents') html = pageDocuments();
  else if (state.route === '/sources') html = pageSources();
  else html = `<div class="empty"><strong>Not found.</strong>${state.route}</div>`;
  // Global AI-unavailable banner (skip on the AI page itself to avoid duplication)
  let banner = '';
  if (state.aiStatus && state.aiStatus.available === false && state.route !== '/ai') {
    banner = `<a href="#/ai" class="ai-banner">⚠ AI unavailable${state.aiStatus.reason ? ' — ' + escape(state.aiStatus.reason) : ''} — open the AI Setup Wizard →</a>`;
  }
  $('#main').innerHTML = banner + html;
  attach();
}

function escape(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

function extensionPromoCard() {
  // Show until the extension has connected at least once. We track this in
  // settings.extensionEverConnected which the sync server flips to true on
  // the first /sync/event POST it receives from a chrome-extension origin.
  if (state.settings.extensionEverConnected) return '';
  if (state.settings.dismissedExtensionPromo) return '';
  return `
    <div class="card desktop-promo" style="margin-bottom:14px;padding:18px;background:linear-gradient(135deg,rgba(99,102,241,0.10),rgba(139,92,246,0.06));border:1px solid rgba(99,102,241,0.3)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px">
        <div style="flex:1">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--primary);font-weight:700;margin-bottom:6px">🌐 OPTIONAL CHROME EXTENSION</div>
          <h3 style="margin:0 0 6px;font-size:16px">Capture jobs as you browse</h3>
          <p style="margin:0 0 10px;color:var(--muted);font-size:13px;line-height:1.5">
            The desktop app works great alone. The Chrome extension adds: <strong>real-time capture as you apply</strong> on LinkedIn / Indeed / Glassdoor / Greenhouse / Lever / Workday, universal autofill across every supported site, and one-click profile sync from your LinkedIn /in/me page.
          </p>
          <div style="font-size:12px;color:var(--muted);margin-bottom:12px"><strong>3-step setup:</strong></div>
          <ol style="margin:0 0 12px 20px;font-size:13px;line-height:1.7;color:var(--text)">
            <li>Open <code style="background:var(--bg);padding:2px 6px;border-radius:4px;font-family:ui-monospace,Consolas,monospace">chrome://extensions/</code> in Chrome</li>
            <li>Toggle <strong>Developer mode</strong> (top-right)</li>
            <li>Click <strong>Load unpacked</strong> → select <code style="background:var(--bg);padding:2px 6px;border-radius:4px;font-family:ui-monospace,Consolas,monospace">v6/extension/</code></li>
          </ol>
          <p style="margin:0 0 10px;color:var(--muted);font-size:12px">Once loaded, the extension auto-detects this app on <code style="background:var(--bg);padding:2px 6px;border-radius:4px">localhost:7733</code> and starts syncing instantly. No restart needed.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn primary" id="open-chrome-extensions">Open chrome://extensions/</button>
            <button class="btn" id="dismiss-extension-promo">Dismiss</button>
          </div>
        </div>
        <div style="font-size:48px;opacity:0.5">🌐</div>
      </div>
    </div>
  `;
}

function pageDashboard() {
  const s = state.summary || {};
  const recent = [...state.jobs].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 6);
  const bySource = state.jobs.reduce((acc, j) => { acc[j.source || 'Unknown'] = (acc[j.source || 'Unknown'] || 0) + 1; return acc; }, {});
  const sources = Object.entries(bySource).sort((a, b) => b[1] - a[1]);
  const shortcuts = state.settings.dashboardShortcuts || [];
  const recs = (state.recommendations || []).slice(0, 6);

  return `
    <div class="page-h">
      <div><h1>Dashboard</h1><div class="sub">${state.jobs.length} application${state.jobs.length === 1 ? '' : 's'} tracked across ${sources.length} source${sources.length === 1 ? '' : 's'}.</div></div>
      <div style="display:flex;gap:8px"><button class="btn" id="refresh-recs">🔍 Refresh recommendations</button><button class="btn primary" id="ai-nudges">✨ AI nudges</button></div>
    </div>
    ${extensionPromoCard()}
    <div class="shortcuts">
      ${shortcuts.map((sh) => `<a class="shortcut-btn" href="${escape(sh.url)}" target="_blank" rel="noreferrer">${escape(sh.label)}<span class="x" data-rm-shortcut="${escape(sh.id)}" title="Remove">×</span></a>`).join('')}
      <button class="shortcut-btn shortcut-add" id="add-shortcut">+ Add shortcut</button>
    </div>
    <div class="grid-3">
      <div class="card stat"><div class="v">${s.today || 0}</div><div class="l">Today</div></div>
      <div class="card stat"><div class="v">${s.week || 0}</div><div class="l">This week</div></div>
      <div class="card stat"><div class="v">${s.total || 0}</div><div class="l">All-time</div></div>
      <div class="card stat"><div class="v">${s.active || 0}</div><div class="l">Active pipeline</div></div>
      <div class="card stat"><div class="v">${s.interviews || 0}</div><div class="l">Interviews</div></div>
      <div class="card stat"><div class="v">${s.offers || 0}</div><div class="l">Offers</div></div>
    </div>
    <div class="grid-2">
      <div class="card">
        <h3 style="margin-top:0;font-size:14px">Recent activity</h3>
        ${recent.length === 0 ? `<div class="empty"><strong>Nothing yet.</strong>Visit a job posting on LinkedIn, Indeed, Glassdoor, etc.</div>` : `<div class="list">${recent.map(rowHtml).join('')}</div>`}
      </div>
      <div class="card">
        <h3 style="margin-top:0;font-size:14px">Sources captured from</h3>
        ${sources.length === 0 ? `<div class="empty">No applications yet.</div>` : sources.map(([src, n]) => `
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
            <span class="pill source">${escape(src)}</span>
            <strong>${n}</strong>
          </div>`).join('')}
      </div>
    </div>
    <div id="nudge-out"></div>

    ${recs.length > 0 ? `
      <div class="card" style="margin-top:14px">
        <h3 style="margin-top:0;font-size:14px">🔍 Recommended job searches ${state.recsLoading ? '<span style="font-size:11px;color:var(--muted)">(refreshing…)</span>' : ''}</h3>
        ${recs.map((r) => `
          <div class="rec-card">
            <div>
              <div class="keys">${escape(r.keywords || '')} ${r.location ? `<span style="font-weight:400;color:var(--muted);font-size:12px">in ${escape(r.location)}</span>` : ''}</div>
              <div class="why">${escape(r.rationale || '')}</div>
            </div>
            <div class="links">
              <a href="${escape(r.url)}" target="_blank" rel="noreferrer">${escape(r.source)} →</a>
            </div>
          </div>
        `).join('')}
      </div>` : ''}
  `;
}

function rowHtml(j) {
  return `<div class="list-row" data-job="${escape(j.id)}">
    <div>
      <div class="t">${escape(j.title || 'Untitled')}</div>
      <div class="s">${escape(j.company || '')}${j.location ? ' · ' + escape(j.location) : ''}</div>
    </div>
    <span class="pill source">${escape(j.source || 'Manual')}</span>
    <span class="pill ${j.status}">${STATUS_LABELS[j.status] || j.status}</span>
  </div>`;
}

function pageJobs() {
  const sources = ['all', ...new Set(state.jobs.map((j) => j.source || 'Unknown'))];
  const filtered = state.jobs.filter((j) => {
    if (state.filter.status !== 'all' && j.status !== state.filter.status) return false;
    if (state.filter.source !== 'all' && (j.source || 'Unknown') !== state.filter.source) return false;
    if (state.filter.search) {
      const q = state.filter.search.toLowerCase();
      const hay = `${j.title} ${j.company} ${j.location}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  return `
    <div class="page-h">
      <div><h1>Applications</h1><div class="sub">${filtered.length} of ${state.jobs.length}</div></div>
    </div>
    <div class="toolbar">
      <input type="text" id="search" placeholder="Search title, company, location…" value="${escape(state.filter.search)}" />
      <select id="filter-status">
        <option value="all"${state.filter.status === 'all' ? ' selected' : ''}>All statuses</option>
        ${STATUSES.map((s) => `<option value="${s}"${state.filter.status === s ? ' selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
      </select>
      <select id="filter-source">
        ${sources.map((s) => `<option value="${s}"${state.filter.source === s ? ' selected' : ''}>${s === 'all' ? 'All sources' : s}</option>`).join('')}
      </select>
    </div>
    <div class="card">
      ${filtered.length === 0 ? `<div class="empty"><strong>No matches.</strong>Try a different filter.</div>` :
        `<div class="list">${filtered.map(rowHtml).join('')}</div>`}
    </div>
  `;
}

function pageJobDetail() {
  const j = state.jobs.find((x) => x.id === state.selectedJobId);
  if (!j) return `<div class="empty"><strong>Job not found.</strong><a href="#/jobs">Back to applications</a></div>`;
  const order = ['discovered','started','submitted','received','reviewing','recruiter_replied','interview','assessment','offer'];
  const cur = order.indexOf(j.status);
  const cache = state.aiResults[j.id] || {};
  const loading = state.aiLoading[j.id] || {};

  return `
    <div class="detail-h">
      <div>
        <span class="pill source">${escape(j.source || 'Manual')}</span>
        <h2>${escape(j.title || 'Untitled')}</h2>
        <div class="meta">${escape(j.company || '')}${j.location ? ' · ' + escape(j.location) : ''}${j.compensation ? ' · ' + escape(j.compensation) : ''}</div>
      </div>
      <div style="display:flex;gap:8px">
        ${j.jobUrl ? `<a class="btn" href="${escape(j.jobUrl)}" target="_blank" rel="noreferrer">Open posting</a>` : ''}
        <button class="btn primary" id="save-detail">Save</button>
        <button class="btn danger" id="delete">Delete</button>
        <a class="btn" href="#/jobs">← Back</a>
      </div>
    </div>

    ${(j.aiWarnings && j.aiWarnings.length) ? `
      <div class="card" style="border-color:rgba(245,158,11,0.4);margin-bottom:14px;background:rgba(245,158,11,0.05)">
        <strong>⚠ AI flagged ${j.aiWarnings.length} field${j.aiWarnings.length === 1 ? '' : 's'} during capture</strong>
        <ul style="margin:8px 0 0 18px;font-size:13px">
          ${j.aiWarnings.map((w) => `<li><strong>${escape(w.field)}</strong>: ${escape(w.issue)}</li>`).join('')}
        </ul>
      </div>` : ''}

    <div class="pipeline">
      ${order.map((s, i) => {
        const cls = j.status === s ? 'current' : (cur > i && cur >= 0 ? 'passed' : '');
        return `<button class="${cls}" data-status="${s}">${STATUS_LABELS[s]}</button>`;
      }).join('')}
    </div>

    <div class="grid-2">
      <div class="card">
        <h3 style="margin-top:0;font-size:14px">Details</h3>
        <dl class="dl">
          <dt>Title</dt><dd><input type="text" id="d-title" value="${escape(j.title)}" /></dd>
          <dt>Company</dt><dd><input type="text" id="d-company" value="${escape(j.company)}" /></dd>
          <dt>Location</dt><dd><input type="text" id="d-location" value="${escape(j.location)}" /></dd>
          <dt>Compensation</dt><dd><input type="text" id="d-comp" value="${escape(j.compensation)}" /></dd>
          <dt>Work mode</dt><dd><input type="text" id="d-mode" value="${escape(j.workMode)}" /></dd>
          <dt>Employment</dt><dd><input type="text" id="d-emp" value="${escape(j.employmentType)}" /></dd>
          <dt>Recruiter</dt><dd><input type="text" id="d-rec" value="${escape(j.recruiterName)}" /></dd>
          <dt>Source</dt><dd>${escape(j.source || '')}</dd>
          <dt>External ID</dt><dd style="color:var(--muted);font-size:11px;font-family:ui-monospace,monospace">${escape(j.externalId || j.linkedinJobId || '')}</dd>
        </dl>
        <label>Notes</label>
        <textarea id="d-notes">${escape(j.notes)}</textarea>
      </div>

      <div class="card">
        <h3 style="margin-top:0;font-size:14px">✨ AI assistant</h3>
        ${state.aiStatus?.available ? `
          <div class="ai-actions">
            ${aiBtn('summarize', 'Summary', '📋', loading)}
            ${aiBtn('score', 'Fit score', '🎯', loading)}
            ${aiBtn('skills', 'Skills', '🧰', loading)}
            ${aiBtn('coverLetter', 'Cover letter', '✍️', loading)}
            ${aiBtn('questions', 'Interview Qs', '❓', loading)}
            ${aiBtn('followup', 'Follow-up', '↩', loading)}
            ${aiBtn('checklist', 'Checklist', '✅', loading)}
            ${j.status === 'offer' ? aiBtn('negotiate', 'Negotiate', '💼', loading) : ''}
          </div>
          ${aiErrorHtml(j)}
          ${aiResultHtml(j, cache)}
        ` : `<div class="empty"><strong>AI not configured.</strong><a href="#/settings">Configure in Settings</a></div>`}
      </div>
    </div>

    ${jobDocumentsSection(j)}

    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0;font-size:14px">Description</h3>
      <div style="white-space:pre-wrap;font-size:13px;line-height:1.5;color:var(--muted)">${escape(j.description || '(no description captured)')}</div>
    </div>
  `;
}

function jobDocumentsSection(j) {
  const linked = state.documents.filter((d) => (d.linkedJobIds || []).includes(j.id));
  const unlinked = state.documents.filter((d) => !(d.linkedJobIds || []).includes(j.id));
  const resumeName = j.resumeName || '';
  const coverName = j.coverLetterName || '';
  const hasResumeDoc = !resumeName || state.documents.some((d) => d.originalFilename === resumeName || d.name === resumeName);
  const hasCoverDoc = !coverName || state.documents.some((d) => d.originalFilename === coverName || d.name === coverName);
  const captured = [];
  if (resumeName) captured.push({ kind: 'Resume', name: resumeName });
  if (coverName) captured.push({ kind: 'Cover letter', name: coverName });
  for (const a of (j.attachments || [])) {
    if (a.role !== 'resume' && a.role !== 'coverLetter' && a.name && !captured.some((c) => c.name === a.name)) {
      captured.push({ kind: 'Attachment', name: a.name });
    }
  }
  return `
    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0;font-size:14px">📁 Documents</h3>
      ${captured.length ? `
        <div style="margin-bottom:10px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:rgba(99,102,241,0.05)">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted);margin-bottom:6px">Captured from application</div>
          ${captured.map((c) => `<div style="font-size:13px;display:flex;justify-content:space-between;padding:3px 0">
            <span><strong>${escape(c.kind)}:</strong> ${escape(c.name)}</span>
            ${state.documents.some((d) => d.originalFilename === c.name || d.name === c.name) ? `<span style="color:var(--success)">✓ uploaded</span>` : `<span style="color:var(--muted)">filename only</span>`}
          </div>`).join('')}
        </div>
      ` : ''}
      ${linked.length === 0 ? `<div class="empty" style="margin-bottom:10px">No documents linked to this application yet.</div>` : `
        <div class="doc-grid" style="margin-bottom:10px">
          ${linked.map(docCardHtml).join('')}
        </div>
      `}
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="link-doc-select" style="flex:1;min-width:200px">
          <option value="">— Link existing document… —</option>
          ${unlinked.map((d) => `<option value="${escape(d.id)}">${escape(d.name)} (${escape(DOC_TYPE_LABEL[d.type] || d.type)})</option>`).join('')}
        </select>
        <button class="btn primary" id="link-doc-btn" data-job-id="${escape(j.id)}">Link</button>
        <a class="btn" href="#/documents">Manage all →</a>
      </div>
      ${!hasResumeDoc ? `
        <div style="margin-top:10px;padding:10px;border:1px dashed var(--border);border-radius:8px;display:flex;gap:8px;align-items:center;justify-content:space-between">
          <div style="font-size:13px">Application references resume <strong>${escape(resumeName)}</strong> but no file is uploaded.</div>
          <button class="btn small" id="upload-resume-btn" data-job-id="${escape(j.id)}" data-doc-type="resume" data-name="${escape(resumeName)}">Upload this resume</button>
        </div>
      ` : ''}
      ${!hasCoverDoc ? `
        <div style="margin-top:10px;padding:10px;border:1px dashed var(--border);border-radius:8px;display:flex;gap:8px;align-items:center;justify-content:space-between">
          <div style="font-size:13px">Application references cover letter <strong>${escape(coverName)}</strong> but no file is uploaded.</div>
          <button class="btn small" id="upload-cover-btn" data-job-id="${escape(j.id)}" data-doc-type="coverLetter" data-name="${escape(coverName)}">Upload this cover letter</button>
        </div>
      ` : ''}
      <input type="file" id="job-doc-upload" style="display:none" />
    </div>
  `;
}

function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}
function fmtDocDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString(); } catch { return ''; }
}
function fileInitials(d) {
  const fname = d.originalFilename || d.name || '';
  const idx = fname.lastIndexOf('.');
  if (idx >= 0 && idx < fname.length - 1) {
    const ext = fname.slice(idx + 1).toUpperCase();
    if (ext.length <= 4) return ext;
  }
  return (d.type || 'DOC').slice(0, 3).toUpperCase();
}
function docCardHtml(d) {
  const linkedCount = (d.linkedJobIds || []).length;
  return `
    <div class="doc-card" data-doc-id="${escape(d.id)}">
      <div class="doc-thumb">${escape(fileInitials(d))}</div>
      <div class="doc-meta">
        <strong title="${escape(d.name)}">${escape(d.name)}</strong>
        <div class="row"><span class="pill source">${escape(DOC_TYPE_LABEL[d.type] || d.type || 'other')}</span><span class="muted">${fmtSize(d.sizeBytes)}</span></div>
        <div class="muted">Uploaded ${escape(fmtDocDate(d.createdAt))}${linkedCount ? ` · linked to ${linkedCount} job${linkedCount === 1 ? '' : 's'}` : ''}</div>
      </div>
      <div class="doc-actions">
        <button class="btn small" data-doc-open="${escape(d.id)}">Open</button>
        <button class="btn small" data-doc-download="${escape(d.id)}">Download</button>
        <button class="btn small" data-doc-edit="${escape(d.id)}">Edit</button>
        <button class="btn small danger" data-doc-delete="${escape(d.id)}">Delete</button>
      </div>
    </div>
  `;
}

function pageDocuments() {
  const docs = [...state.documents].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const tracked = new Map();
  for (const j of state.jobs) {
    if (j.resumeName) {
      const exists = state.documents.some((d) => d.originalFilename === j.resumeName || d.name === j.resumeName);
      if (!exists) {
        const k = `resume|${j.resumeName}`;
        if (!tracked.has(k)) tracked.set(k, { name: j.resumeName, type: 'resume', jobs: [] });
        tracked.get(k).jobs.push(j);
      }
    }
    if (j.coverLetterName) {
      const exists = state.documents.some((d) => d.originalFilename === j.coverLetterName || d.name === j.coverLetterName);
      if (!exists) {
        const k = `coverLetter|${j.coverLetterName}`;
        if (!tracked.has(k)) tracked.set(k, { name: j.coverLetterName, type: 'coverLetter', jobs: [] });
        tracked.get(k).jobs.push(j);
      }
    }
  }
  const trackedList = Array.from(tracked.values());

  return `
    <div class="page-h">
      <div><h1>📁 Documents</h1><div class="sub">${docs.length} file${docs.length === 1 ? '' : 's'} stored locally. Resumes, cover letters, transcripts, portfolios.</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn primary" id="doc-upload-btn">+ Upload</button>
        <button class="btn" id="doc-folder-btn" title="Bulk-import every document inside a folder">📂 Import folder</button>
        ${state.profile?.firstName === 'Pierre' ? `<button class="btn" id="doc-pierre-btn" title="Select C:\\Users\\${escape(state.profile?.firstName || 'pierr')}\\Desktop\\Importing\\Resume — Chrome can't open it directly, you must pick it once.">📁 My resumes (Pierre)</button>` : ''}
        <input type="file" id="doc-upload-input" multiple style="display:none" />
        <input type="file" id="doc-folder-upload" webkitdirectory directory multiple style="display:none" />
      </div>
    </div>

    ${docs.length === 0 ? `
      <div class="card"><div class="empty"><strong>No documents yet.</strong>Upload your resume, cover letters, transcripts, or portfolio files. They're stored locally in your browser and can be linked to specific applications.</div></div>
    ` : `
      <div class="doc-grid">
        ${docs.map(docCardHtml).join('')}
      </div>
    `}

    ${trackedList.length > 0 ? `
      <div class="card" style="margin-top:14px">
        <h3 style="margin-top:0;font-size:14px">Auto-tracked from applications</h3>
        <p style="color:var(--muted);font-size:13px;margin:0 0 10px">These filenames were captured from past applications but aren't uploaded yet. Upload them so you can re-use and version them.</p>
        ${trackedList.map((t) => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;border-bottom:1px solid var(--border);gap:8px">
            <div>
              <strong>${escape(t.name)}</strong>
              <div style="color:var(--muted);font-size:12px">${escape(DOC_TYPE_LABEL[t.type])} · referenced by ${t.jobs.length} application${t.jobs.length === 1 ? '' : 's'}</div>
            </div>
            <button class="btn small" data-tracked-upload="${escape(t.name)}" data-tracked-type="${escape(t.type)}">Upload now</button>
          </div>
        `).join('')}
      </div>
    ` : ''}
  `;
}

function aiBtn(feature, label, icon, loading) {
  return `<button class="ai-action-btn" data-ai="${feature}" ${loading[feature] ? 'disabled' : ''}>
    <span class="ico">${icon}</span>${loading[feature] ? '…' : label}
  </button>`;
}

function aiErrorHtml(j) {
  const errs = (state.aiErrors || {})[j.id] || {};
  const last = (state.aiResults[j.id] || {})._last;
  if (!last || !errs[last]) return '';
  const msg = errs[last];
  const isCors = /cors|origin|403/i.test(msg);
  const isNoModel = /not found|pull /i.test(msg);
  const isUnreach = /reach|running|cannot/i.test(msg);
  return `
    <div style="padding:12px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.4);border-radius:8px;margin-top:8px">
      <div style="font-size:13px;color:#fca5a5;margin-bottom:6px"><strong>AI failed</strong> on "${escape(last)}":</div>
      <div style="font-size:12px;font-family:ui-monospace,Consolas,monospace;white-space:pre-wrap;line-height:1.4">${escape(msg)}</div>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn small primary" data-ai-retry="${escape(last)}" data-ai-job="${escape(j.id)}">↻ Retry</button>
        ${(isCors || isNoModel || isUnreach) ? `<a class="btn small" href="#/ai">Open AI Setup Wizard →</a>` : ''}
      </div>
    </div>
  `;
}

function aiResultHtml(j, cache) {
  const last = cache._last;
  if (!last || !cache[last]) return '';
  const result = cache[last];
  if (Array.isArray(result)) {
    if (last === 'skills') return `<div>${result.map((s) => `<span class="ai-pill">${escape(s)}</span>`).join('')}</div>`;
    if (last === 'questions') return `<div class="ai-output">${result.map((q, i) => `${i + 1}. ${escape(q)}`).join('\n')}</div>`;
    if (last === 'checklist') return `<div class="ai-output">${result.map((it, i) => `${i + 1}. ${escape(it.label)}${it.rationale ? '\n   ' + escape(it.rationale) : ''}`).join('\n\n')}</div>`;
    return `<div class="ai-output">${escape(JSON.stringify(result, null, 2))}</div>`;
  }
  if (typeof result === 'object' && result !== null) {
    if (last === 'score') return `<div class="ai-output"><strong>Score: ${result.score}/100</strong>\n${result.summary || ''}\n\nStrengths:\n${(result.strengths || []).map((s) => '• ' + s).join('\n')}\n\nGaps:\n${(result.gaps || []).map((s) => '• ' + s).join('\n')}</div>`;
    if (last === 'negotiate') return `<div class="ai-output"><strong>Anchor:</strong> ${result.anchor || ''}\n\n<strong>Talking points:</strong>\n${(result.talkingPoints || []).map((p) => '• ' + p).join('\n')}\n\n<strong>Watch outs:</strong>\n${(result.watchOuts || []).map((p) => '• ' + p).join('\n')}\n\n<strong>Draft email:</strong>\n${result.draftEmail || ''}</div>`;
    return `<div class="ai-output">${escape(JSON.stringify(result, null, 2))}</div>`;
  }
  return `<div class="ai-output">${escape(String(result))}</div>`;
}

const PROFILE_FIELDS = [
  { sec: 'Identity', fields: [
    ['firstName', 'First name'], ['lastName', 'Last name'], ['preferredName', 'Preferred name'], ['pronouns', 'Pronouns'],
  ]},
  { sec: 'Contact', fields: [
    ['email', 'Primary email'], ['secondaryEmail', 'Secondary email'], ['phone', 'Phone'],
  ]},
  { sec: 'Address', fields: [
    ['address1', 'Address 1'], ['address2', 'Address 2'], ['city', 'City'], ['state', 'State / Province'], ['postalCode', 'Postal code'], ['country', 'Country'],
  ]},
  { sec: 'Online', fields: [
    ['linkedinUrl', 'LinkedIn URL'], ['githubUrl', 'GitHub URL'], ['portfolioUrl', 'Portfolio URL'], ['websiteUrl', 'Website'], ['twitterUrl', 'Twitter / X'],
  ]},
  { sec: 'Eligibility', fields: [
    ['workAuthorization', 'Work authorization'], ['sponsorshipRequired', 'Need sponsorship?'], ['citizenship', 'Citizenship'], ['securityClearance', 'Security clearance'],
  ]},
  { sec: 'Compensation & availability', fields: [
    ['salaryExpectation', 'Salary expectation'], ['salaryMin', 'Salary min'], ['salaryMax', 'Salary max'], ['currency', 'Currency'],
    ['yearsExperience', 'Years experience'], ['noticePeriod', 'Notice period'], ['earliestStartDate', 'Earliest start date'], ['willRelocate', 'Willing to relocate'], ['willTravel', 'Travel %'],
  ]},
  { sec: 'Education', fields: [
    ['highestDegree', 'Highest degree'], ['university', 'University'], ['major', 'Major / field'], ['graduationYear', 'Graduation year'], ['gpa', 'GPA'],
  ]},
  { sec: 'Demographics (optional, for EEO forms)', fields: [
    ['gender', 'Gender'], ['ethnicity', 'Ethnicity'], ['veteranStatus', 'Veteran status'], ['disabilityStatus', 'Disability status'],
  ]},
  { sec: 'Resume / cover letter', fields: [
    ['defaultResumeName', 'Default resume name'], ['defaultCoverLetterName', 'Default cover letter name'],
  ]},
];

function pageProfile() {
  const p = state.profile;
  const ans = state.answers || [];
  return `
    <div class="page-h">
      <div><h1>Profile &amp; Answers</h1><div class="sub">Used for AI features and universal autofill across all sites. Your custom answers are auto-learned as you apply.</div></div>
      <div style="display:flex;gap:8px">
        <button class="btn primary" id="p-save">Save profile</button>
        ${state.aiStatus?.available ? `<button class="btn" id="p-resume">✨ Parse resume with AI</button>` : ''}
      </div>
    </div>
    <div class="card">
      ${PROFILE_FIELDS.map((sec) => `
        <h3 style="margin:18px 0 4px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em">${sec.sec}</h3>
        <div class="grid-2">
          ${sec.fields.map(([k, label]) => `
            <div><label>${escape(label)}</label><input type="text" id="p-${k}" value="${escape(p[k] ?? '')}" /></div>
          `).join('')}
        </div>
      `).join('')}
      <h3 style="margin:18px 0 4px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em">Headline &amp; summary</h3>
      <label>Headline</label><input type="text" id="p-headline" value="${escape(p.headline || '')}" />
      <label>Summary (1-3 sentences for AI fit scoring)</label>
      <textarea id="p-summary">${escape(p.summary || '')}</textarea>
    </div>

    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0;font-size:14px">Learned answers <span style="font-weight:400;color:var(--muted);font-size:12px">(${ans.length} captured)</span></h3>
      <p style="color:var(--muted);font-size:13px;margin:0 0 12px">When you fill in custom application questions, the answer is saved here so the next time you see a similar question — even on a different site or in another language — autofill will offer it.</p>
      ${ans.length === 0 ? `<div class="empty">Nothing captured yet. Answers are recorded when you submit applications on supported sites.</div>` : `
        <div style="max-height:400px;overflow-y:auto">
          ${ans.slice(0, 50).map((a) => `
            <div style="padding:10px;border-bottom:1px solid var(--border)">
              <div style="font-weight:600;font-size:13px">${escape((a.questions && a.questions[0]) || a.key)}</div>
              <div style="margin-top:4px;color:var(--muted);font-size:12px">→ ${escape(a.answer)}</div>
              <div style="margin-top:4px;font-size:10px;color:var(--muted)">seen ${a.seenCount}x · sources: ${(a.sources || []).join(', ') || 'unknown'} <button class="btn small" data-del-answer="${escape(a.key)}" style="float:right">Delete</button></div>
            </div>
          `).join('')}
        </div>
      `}
    </div>
  `;
}

function pageSettings() {
  const s = state.settings;
  const currentTheme = s.theme || 'midnight';
  return `
    <div class="page-h"><div><h1>Settings</h1><div class="sub">Themes, AI providers, follow-ups, notifications.</div></div></div>

    <div class="card">
      <h3 style="margin-top:0;font-size:14px">🎨 Theme <span style="font-weight:400;color:var(--muted);font-size:12px">${THEMES.length} built-in</span></h3>
      <div class="theme-grid">
        ${THEMES.map((t) => `
          <div class="theme-card${t.id === currentTheme ? ' active' : ''}" data-theme="${t.id}">
            <div class="badge-mode">${t.mode}</div>
            <div class="swatch">
              <span style="background:${t.vars.bg}"></span>
              <span style="background:${t.vars.primary}"></span>
              <span style="background:${t.vars.primary2}"></span>
              <span style="background:${t.vars.success}"></span>
            </div>
            <strong><span class="ico">${t.icon}</span>${escape(t.name)}</strong>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0;font-size:14px">🖼️ Toolbar icon <span style="font-weight:400;color:var(--muted);font-size:12px">${ICON_PRESETS.length} presets · or upload your own</span></h3>
      <div class="icon-grid">
        <div class="icon-card${!s.iconPreset && !s.iconCustomDataUrl ? ' active' : ''}" data-icon-preset="">
          <div class="icon-thumb" style="background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;color:white;font-weight:700">JAT</div>
          <strong>Default</strong>
        </div>
        ${ICON_PRESETS.map((p) => `
          <div class="icon-card${s.iconPreset === p.id ? ' active' : ''}" data-icon-preset="${escape(p.id)}" title="${escape(p.name)}">
            <img class="icon-thumb" src="${presetToSvgDataUrl(p, 64)}" alt="${escape(p.name)}" />
            <strong>${escape(p.name)}</strong>
          </div>
        `).join('')}
      </div>
      <div style="margin-top:14px;display:flex;gap:8px;align-items:center">
        <button class="btn" id="icon-upload-btn">Upload custom icon</button>
        <input type="file" id="icon-upload" accept="image/*" style="display:none" />
        ${s.iconCustomDataUrl ? `<img src="${s.iconCustomDataUrl}" style="width:32px;height:32px;border-radius:6px;border:1px solid var(--border)" /> <button class="btn small danger" id="icon-clear">Clear custom</button>` : ''}
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0;font-size:14px">✨ AI provider</h3>
      <p style="color:var(--muted);font-size:13px;margin:0 0 10px">Default is Ollama with <strong>gemma4:e4b</strong> (local, free, private). To use it: install <a href="https://ollama.com" target="_blank" rel="noreferrer" style="color:var(--primary)">Ollama</a>, then run <code style="background:var(--bg);padding:2px 6px;border-radius:4px">ollama pull gemma4:e4b</code>. The extension will auto-detect when Ollama is running.</p>
      <div class="field"><label>Provider</label>
        <select id="s-aiProvider">
          ${['ollama', 'auto', 'chrome', 'openai', 'none'].map((v) => `<option value="${v}"${s.aiProvider === v ? ' selected' : ''}>${v}${v === 'ollama' ? ' (recommended — local)' : ''}</option>`).join('')}
        </select>
      </div>
      <div class="grid-2">
        <div><label>Ollama URL</label><input type="url" id="s-ollamaUrl" value="${escape(s.ollamaUrl)}" placeholder="http://localhost:11434" /></div>
        <div><label>Ollama model</label><input type="text" id="s-ollamaModel" value="${escape(s.ollamaModel)}" placeholder="gemma4:e4b" /></div>
        <div><label>OpenAI base URL</label><input type="url" id="s-openaiBaseUrl" value="${escape(s.openaiBaseUrl)}" /></div>
        <div><label>OpenAI model</label><input type="text" id="s-openaiModel" value="${escape(s.openaiModel)}" /></div>
        <div style="grid-column:1/-1"><label>OpenAI API key</label><input type="text" id="s-openaiKey" value="${escape(s.openaiKey)}" placeholder="sk-…" /></div>
      </div>
      <div class="field"><label><input type="checkbox" id="s-aiValidateCaptures" ${s.aiValidateCaptures ? 'checked' : ''}/> AI sanity-checks captured fields</label></div>
      <button class="btn primary" id="s-save">Save settings</button>
      <button class="btn" id="s-test-ai" style="margin-left:8px">Test AI connection</button>
      <span id="s-ai-test-out" style="margin-left:12px;font-size:12px"></span>
    </div>
    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0;font-size:14px">Follow-ups</h3>
      <div class="field"><label>Default follow-up after (days)</label><input type="number" id="s-defaultFollowUpDays" value="${s.defaultFollowUpDays}" min="1" max="60" /></div>
      <div class="field"><label><input type="checkbox" id="s-notificationsEnabled" ${s.notificationsEnabled ? 'checked' : ''}/> Desktop notifications when follow-up due</label></div>
      <button class="btn primary" id="s-save2">Save</button>
    </div>
  `;
}

function statusPill() {
  const a = state.aiStatus;
  if (a?.available) return `<span class="status-pill ok">✓ ${escape(a.provider)} ready</span>`;
  return `<span class="status-pill bad">✗ ${escape(a?.reason || 'not connected')}</span>`;
}

function codeBlock(code) {
  return `<div class="code-block"><code>${escape(code)}</code><button class="btn small copy-btn" data-copy="${escape(code)}">Copy</button></div>`;
}

function wizSteps(current) {
  const steps = [
    { n: 1, label: 'Pick provider' },
    { n: 2, label: 'Configure' },
    { n: 3, label: 'Try it' },
  ];
  return `<div class="wiz-steps">${steps.map((s) => `
    <div class="wiz-step${s.n === current ? ' wiz-active' : ''}${s.n < current ? ' wiz-done' : ''}">
      <div class="wiz-step-num">${s.n < current ? '✓' : s.n}</div>
      <div class="wiz-step-label">${s.label}</div>
    </div>${s.n < steps.length ? '<div class="wiz-step-bar"></div>' : ''}`).join('')}</div>`;
}

function pageAi() {
  const step = state.aiWizardStep || 1;
  const provider = state.settings.aiProvider || 'ollama';

  let body = '';
  if (step === 1) {
    body = `
      <div class="card">
        <h3 style="margin-top:0">Choose an AI provider</h3>
        <p style="color:var(--muted);font-size:13px;margin:0 0 14px">All AI features run through your chosen provider. You can change this any time.</p>
        <div class="wiz-cards">
          <div class="wiz-card${provider === 'ollama' ? ' wiz-card-active' : ''}" data-pick-provider="ollama">
            <div class="wiz-card-icon">🦙</div>
            <strong>Ollama</strong>
            <small>Local · free · private</small>
            <span class="wiz-badge">Recommended</span>
            <p>Runs on your machine. No API keys, no data leaves your computer.</p>
          </div>
          <div class="wiz-card${provider === 'openai' ? ' wiz-card-active' : ''}" data-pick-provider="openai">
            <div class="wiz-card-icon">🔌</div>
            <strong>OpenAI (or compatible)</strong>
            <small>API key · paid</small>
            <p>Use OpenAI, Groq, Together, or any OpenAI-compatible endpoint.</p>
          </div>
          <div class="wiz-card${provider === 'chrome' ? ' wiz-card-active' : ''}" data-pick-provider="chrome">
            <div class="wiz-card-icon">🧪</div>
            <strong>Chrome built-in</strong>
            <small>Gemini Nano · experimental</small>
            <p>Uses Chrome's built-in on-device model. Requires recent Chrome and a flag.</p>
          </div>
        </div>
      </div>`;
  } else if (step === 2) {
    if (provider === 'ollama') {
      body = `
        <div class="card">
          <h3 style="margin-top:0">Set up Ollama</h3>
          <ol style="font-size:13px;line-height:1.8;color:var(--text);padding-left:20px">
            <li>Install Ollama from <a href="https://ollama.com/download" target="_blank" rel="noreferrer" style="color:var(--primary)">ollama.com/download</a>.</li>
            <li>Pull the recommended model:</li>
          </ol>
          ${codeBlock('ollama pull gemma4:e4b')}
          <div style="margin-top:12px;padding:10px;border:1px dashed var(--border);border-radius:8px">
            <strong style="font-size:13px">Or run our bundled setup script</strong>
            <p style="color:var(--muted);font-size:12px;margin:4px 0 8px">It sets <code>OLLAMA_ORIGINS=chrome-extension://*</code> and pulls <code>gemma4:e4b</code> in one go.</p>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <a class="btn small" id="wiz-download-setup-win" href="https://ollama.com/download" target="_blank" rel="noreferrer">⬇ Windows (.ps1)</a>
              <a class="btn small" id="wiz-download-setup-mac" href="https://ollama.com/download" target="_blank" rel="noreferrer">⬇ macOS (.sh)</a>
              <a class="btn small" id="wiz-download-setup-linux" href="https://ollama.com/download" target="_blank" rel="noreferrer">⬇ Linux (.sh)</a>
            </div>
          </div>
          <p style="color:var(--muted);font-size:12px;margin-top:12px">Once installed, no extra setup is needed — the extension already strips the browser Origin header so Ollama accepts requests.</p>
          <div class="grid-2" style="margin-top:14px">
            <div><label>Ollama URL</label><input type="url" id="wiz-ollamaUrl" value="${escape(state.settings.ollamaUrl || 'http://localhost:11434')}" /></div>
            <div><label>Ollama model</label><input type="text" id="wiz-ollamaModel" value="${escape(state.settings.ollamaModel || 'gemma4:e4b')}" /></div>
          </div>
          <div style="margin-top:14px;display:flex;gap:8px;align-items:center">
            <button class="btn primary" id="wiz-save-test">Save & test connection</button>
            <span id="wiz-test-out" style="font-size:12px"></span>
          </div>
        </div>`;
    } else if (provider === 'openai') {
      body = `
        <div class="card">
          <h3 style="margin-top:0">Configure OpenAI</h3>
          <p style="color:var(--muted);font-size:13px">Paste your API key. For OpenAI-compatible endpoints (Groq, Together, local llama.cpp), change the base URL.</p>
          <div class="grid-2">
            <div style="grid-column:1/-1"><label>API key</label><input type="text" id="wiz-openaiKey" value="${escape(state.settings.openaiKey || '')}" placeholder="sk-…" /></div>
            <div><label>Base URL</label><input type="url" id="wiz-openaiBaseUrl" value="${escape(state.settings.openaiBaseUrl || 'https://api.openai.com/v1')}" /></div>
            <div><label>Model</label>
              <select id="wiz-openaiModel">
                ${['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'].map((m) => `<option value="${m}"${(state.settings.openaiModel || 'gpt-4o-mini') === m ? ' selected' : ''}>${m}</option>`).join('')}
              </select>
            </div>
          </div>
          <div style="margin-top:14px;display:flex;gap:8px;align-items:center">
            <button class="btn primary" id="wiz-save-test">Save & test connection</button>
            <span id="wiz-test-out" style="font-size:12px"></span>
          </div>
        </div>`;
    } else {
      body = `
        <div class="card">
          <h3 style="margin-top:0">Enable Chrome built-in AI</h3>
          <p style="color:var(--muted);font-size:13px">Chrome's built-in Gemini Nano runs locally with no setup or API keys, but requires a recent Chrome and an enabled flag.</p>
          <ol style="font-size:13px;line-height:1.8;padding-left:20px">
            <li>Use Chrome 127 or newer.</li>
            <li>Open <code>chrome://flags/#prompt-api-for-gemini-nano</code> and set it to <strong>Enabled</strong>.</li>
            <li>Restart Chrome. The model downloads automatically on first use.</li>
          </ol>
          <div style="margin-top:14px;display:flex;gap:8px;align-items:center">
            <button class="btn primary" id="wiz-save-test">Test connection</button>
            <span id="wiz-test-out" style="font-size:12px"></span>
          </div>
        </div>`;
    }
  } else {
    const tr = state.aiTestResult;
    body = `
      <div class="card">
        <h3 style="margin-top:0">Run a quick test prompt</h3>
        <p style="color:var(--muted);font-size:13px">This will ask the AI for a short insights summary using your tracked applications.</p>
        <button class="btn primary" id="wiz-run-test">Run a quick test prompt</button>
        <div id="wiz-test-prompt-out" style="margin-top:14px">${
          tr ? (tr.ok
            ? `<div class="ai-output"><strong style="color:var(--success)">✓ Success</strong>\n\n${escape(typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result, null, 2))}</div>`
            : `<div class="empty" style="color:var(--danger)"><strong>Test failed.</strong>${escape(tr.error || '')}</div>`)
          : ''
        }</div>
        ${tr?.ok ? `
          <div style="margin-top:18px;padding:14px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.3);border-radius:10px">
            <strong style="color:var(--success)">✓ All set!</strong>
            <p style="margin:6px 0 10px;font-size:13px;color:var(--muted)">AI features are now active across the app.</p>
            <a class="btn primary" href="#/">Go to Dashboard</a>
            <a class="btn" href="#/jobs" style="margin-left:6px">View applications</a>
          </div>` : ''}
      </div>`;
  }

  return `
    <div class="page-h">
      <div><h1>✨ AI Setup Wizard</h1><div class="sub">Get AI features connected in under a minute.</div></div>
      <div style="display:flex;gap:8px;align-items:center">
        ${statusPill()}
        <button class="btn small" id="wiz-retest">Re-test</button>
      </div>
    </div>
    ${wizSteps(step)}
    ${body}
    <div style="margin-top:14px;display:flex;justify-content:space-between">
      <button class="btn" id="wiz-prev" ${step === 1 ? 'disabled' : ''}>← Back</button>
      <button class="btn primary" id="wiz-next" ${step === 3 ? 'disabled' : ''}>Next →</button>
    </div>
  `;
}

const SOURCE_SYNC_URLS = {
  LinkedIn: 'https://www.linkedin.com/my-items/saved-jobs/?cardType=APPLIED',
  Indeed: 'https://myjobs.indeed.com/applied',
  Glassdoor: 'https://www.glassdoor.com/Profile/myJobs.htm',
  Greenhouse: 'https://boards.greenhouse.io',
  Lever: 'https://jobs.lever.co',
  Workday: 'https://www.workday.com/en-us/products/talent-acquisition.html',
  Generic: ''
};

function pageSources() {
  return `
    <div class="page-h">
      <div><h1>Job board sources</h1><div class="sub">v5 watches these sites automatically. Click a row to open it and sync past applications — the universal capture engine will detect them as you scroll.</div></div>
    </div>
    <div class="card">
      ${SOURCES.map((s) => {
        const url = SOURCE_SYNC_URLS[s.id];
        const count = state.jobs.filter((j) => (j.source || '') === s.id).length;
        return `
          <div class="source-card sync" data-src-url="${escape(url)}">
            <div class="icon">${s.icon}</div>
            <div class="info">
              <strong>${s.id}</strong>
              <small>${s.host} — ${s.desc}</small>
            </div>
            <div>
              <div style="text-align:right">${count} captured</div>
              ${url ? `<div class="open" style="text-align:right">Open to sync →</div>` : ''}
            </div>
          </div>
        `;
      }).join('')}
    </div>
    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0;font-size:14px">Generic JSON-LD coverage</h3>
      <p style="color:var(--muted);font-size:13px">The <strong>Generic adapter</strong> activates on any page exposing a JSON-LD <code>JobPosting</code> — covers Ashby, Workable, BambooHR, SmartRecruiters, and most modern career sites. To add a dedicated ATS adapter, drop a new file in <code>content/adapters/</code>.</p>
    </div>
  `;
}

// ============ Event wiring ============
function attach() {
  // Dashboard
  $$('.list-row').forEach((el) => el.addEventListener('click', () => { location.hash = `#/job/${el.dataset.job}`; }));

  $('#ai-nudges')?.addEventListener('click', async () => {
    if (!state.aiStatus?.available) { toast('Configure AI first.', 'danger'); return; }
    const out = $('#nudge-out');
    out.innerHTML = '<div class="card"><div class="empty">AI is reviewing…</div></div>';
    const r = await aiCall( { feature: 'nudges', jobs: state.jobs });
    if (!r?.ok) { out.innerHTML = `<div class="card empty">Failed: ${escape(r?.error || '')}</div>`; return; }
    const nudges = r.result || [];
    if (nudges.length === 0) { out.innerHTML = `<div class="card empty">Nothing urgent. Nice work.</div>`; return; }
    out.innerHTML = `<div class="card"><h3 style="margin-top:0;font-size:14px">✨ AI nudges</h3>${nudges.map((n) => {
      const job = state.jobs.find((j) => j.id === n.jobId);
      if (!job) return '';
      return `<div style="padding:10px;border-top:1px solid var(--border)">
        <strong>${escape(job.title)}</strong> · ${escape(job.company)}<br>
        <span style="color:var(--muted);font-size:13px">${escape(n.reason || '')} (${n.priority || 'medium'})</span>
      </div>`;
    }).join('')}</div>`;
  });

  // Jobs
  $('#search')?.addEventListener('input', (e) => { state.filter.search = e.target.value; render(); });
  $('#filter-status')?.addEventListener('change', (e) => { state.filter.status = e.target.value; render(); });
  $('#filter-source')?.addEventListener('change', (e) => { state.filter.source = e.target.value; render(); });

  // Detail
  $$('.pipeline button').forEach((b) => b.addEventListener('click', async () => {
    const r = await send('patch-job', { id: state.selectedJobId, patch: { status: b.dataset.status } });
    if (r?.ok) { toast('Status updated.', 'success'); }
  }));
  $('#save-detail')?.addEventListener('click', async () => {
    const patch = {
      title: $('#d-title').value, company: $('#d-company').value, location: $('#d-location').value,
      compensation: $('#d-comp').value, workMode: $('#d-mode').value, employmentType: $('#d-emp').value,
      recruiterName: $('#d-rec').value, notes: $('#d-notes').value
    };
    const r = await send('patch-job', { id: state.selectedJobId, patch });
    if (r?.ok) toast('Saved.', 'success');
  });
  $('#delete')?.addEventListener('click', async () => {
    if (!confirm('Delete this application?')) return;
    await send('delete-job', { id: state.selectedJobId });
    toast('Deleted.', 'success');
    location.hash = '#/jobs';
  });
  $$('[data-ai]').forEach((b) => b.addEventListener('click', () => runAi(b.dataset.ai, state.selectedJobId)));
  $$('[data-ai-retry]').forEach((b) => b.addEventListener('click', () => runAi(b.dataset.aiRetry, b.dataset.aiJob)));

  // Profile
  $('#p-save')?.addEventListener('click', async () => {
    const patch = {};
    const allKeys = PROFILE_FIELDS.flatMap((sec) => sec.fields.map(([k]) => k)).concat(['headline', 'summary']);
    allKeys.forEach((k) => { const el = $('#p-' + k); if (el) patch[k] = el.value; });
    const r = await send('patch-profile', patch);
    if (r?.ok) { state.profile = r.profile; toast('Profile saved.', 'success'); }
  });
  $$('[data-del-answer]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this answer?')) return;
    await send('delete-answer', { key: b.dataset.delAnswer });
    state.answers = state.answers.filter((a) => a.key !== b.dataset.delAnswer);
    toast('Deleted.', 'success'); render();
  }));
  $('#p-resume')?.addEventListener('click', async () => {
    const text = prompt('Paste your resume text here:');
    if (!text) return;
    toast('AI parsing…', 'info');
    const r = await aiCall( { feature: 'resume', resumeText: text });
    if (!r?.ok) { toast('Failed: ' + r?.error, 'danger'); return; }
    const parsed = r.result || {};
    const patch = {};
    for (const k of Object.keys(parsed)) {
      if (k === 'skills') continue;
      if (parsed[k] && !state.profile[k]) patch[k] = parsed[k];
    }
    if (Object.keys(patch).length === 0) { toast('Nothing new to add.', 'info'); return; }
    const u = await send('patch-profile', patch);
    if (u?.ok) { state.profile = u.profile; toast(`Updated ${Object.keys(patch).length} field(s).`, 'success'); render(); }
  });

  // Settings — theme picker
  $$('.theme-card').forEach((c) => c.addEventListener('click', async () => {
    const id = c.dataset.theme;
    applyTheme(id);
    await send('patch-settings', { theme: id });
    state.settings.theme = id;
    toast(`Theme: ${THEMES.find((t) => t.id === id)?.name}`, 'success');
    render();
  }));

  // Settings — icon picker (rasterize in page, then ship pre-baked ImageData
  // to background, which can't decode SVG itself)
  $$('[data-icon-preset]').forEach((c) => c.addEventListener('click', async () => {
    const id = c.dataset.iconPreset;
    try {
      if (id) {
        const preset = ICON_PRESETS.find((p) => p.id === id);
        if (!preset) { toast('Unknown preset.', 'danger'); return; }
        const bundle = await presetToIconBundle(preset);
        await applyIconBundle(bundle);
      } else {
        await clearIconBundle();
      }
      const r = await send('patch-settings', { iconPreset: id, iconCustomDataUrl: '' });
      if (r?.ok) {
        state.settings = r.settings;
        toast(id ? `Icon: ${ICON_PRESETS.find((p) => p.id === id)?.name}` : 'Icon: Default', 'success');
        render();
      }
    } catch (e) {
      toast(`Failed to apply icon: ${e.message || e}`, 'danger');
    }
  }));
  $('#icon-upload-btn')?.addEventListener('click', () => $('#icon-upload')?.click());
  $('#icon-upload')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('Please pick an image file.', 'danger'); return; }
    if (file.size > 1.5 * 1024 * 1024) { toast('Image too large (max ~1.5MB).', 'danger'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result || '');
      try {
        const bundle = await imageUrlToIconBundle(dataUrl);
        await applyIconBundle(bundle);
        const r = await send('patch-settings', { iconCustomDataUrl: dataUrl, iconPreset: '' });
        if (r?.ok) { state.settings = r.settings; toast('Custom icon applied.', 'success'); render(); }
      } catch (err) {
        toast(`Failed: ${err.message || err}`, 'danger');
      }
    };
    reader.readAsDataURL(file);
  });
  $('#icon-clear')?.addEventListener('click', async () => {
    await clearIconBundle();
    const r = await send('patch-settings', { iconCustomDataUrl: '' });
    if (r?.ok) { state.settings = r.settings; toast('Custom icon cleared.', 'success'); render(); }
  });

  // Settings
  $('#s-save')?.addEventListener('click', async () => {
    const patch = {
      aiProvider: $('#s-aiProvider').value,
      ollamaUrl: $('#s-ollamaUrl').value, ollamaModel: $('#s-ollamaModel').value,
      openaiBaseUrl: $('#s-openaiBaseUrl').value, openaiModel: $('#s-openaiModel').value,
      openaiKey: $('#s-openaiKey').value,
      aiValidateCaptures: $('#s-aiValidateCaptures').checked
    };
    const r = await send('patch-settings', patch);
    if (r?.ok) { state.settings = r.settings; toast('Saved.', 'success'); refreshAi(); }
  });
  $('#s-save2')?.addEventListener('click', async () => {
    const patch = {
      defaultFollowUpDays: Number($('#s-defaultFollowUpDays').value) || 10,
      notificationsEnabled: $('#s-notificationsEnabled').checked
    };
    const r = await send('patch-settings', patch);
    if (r?.ok) { state.settings = r.settings; toast('Saved.', 'success'); }
  });
  $('#s-test-ai')?.addEventListener('click', async () => {
    $('#s-ai-test-out').textContent = 'Testing…';
    await refreshAi();
    $('#s-ai-test-out').innerHTML = state.aiStatus?.available
      ? `<span style="color:var(--success)">✓ ${state.aiStatus.provider} ready</span>`
      : `<span style="color:var(--warn)">⚠ ${escape(state.aiStatus?.reason || 'unavailable')}</span>`;
  });

  // Shortcuts
  $('#dismiss-extension-promo')?.addEventListener('click', async () => {
    await send('patch-settings', { dismissedExtensionPromo: true });
    state.settings.dismissedExtensionPromo = true;
    toast('Hidden. Re-enable in Settings.', 'info');
    render();
  });
  $('#open-chrome-extensions')?.addEventListener('click', () => {
    if (window.jat5?.openExternal) window.jat5.openExternal('chrome://extensions/');
    else window.open('chrome://extensions/', '_blank');
  });

  $('#add-shortcut')?.addEventListener('click', async () => {
    const label = prompt('Shortcut label:');
    if (!label) return;
    const url = prompt('URL:');
    if (!url) return;
    const id = 'sh' + Date.now();
    const list = [...(state.settings.dashboardShortcuts || []), { id, label, url }];
    const r = await send('patch-settings', { dashboardShortcuts: list });
    if (r?.ok) { state.settings = r.settings; toast('Added.', 'success'); render(); }
  });
  $$('[data-rm-shortcut]').forEach((el) => el.addEventListener('click', async (e) => {
    e.preventDefault(); e.stopPropagation();
    const list = (state.settings.dashboardShortcuts || []).filter((s) => s.id !== el.dataset.rmShortcut);
    const r = await send('patch-settings', { dashboardShortcuts: list });
    if (r?.ok) { state.settings = r.settings; render(); }
  }));

  // Refresh recommendations
  $('#refresh-recs')?.addEventListener('click', async () => {
    if (!state.aiStatus?.available) { toast('Configure AI first to generate recommendations.', 'danger'); return; }
    state.recsLoading = true; render();
    const aiR = await aiCall({ feature: 'recommend', jobs: state.jobs, profile: state.profile });
    if (!aiR?.ok) {
      state.recsLoading = false; render();
      toast(`AI failed: ${aiR?.error || ''}`, 'danger'); return;
    }
    const r = await send('persist-recommendations', { queries: aiR.result || [] });
    state.recsLoading = false;
    if (r?.ok) {
      state.recommendations = r.items || [];
      toast(`Generated ${r.items.length} recommended search${r.items.length === 1 ? '' : 'es'}.`, 'success');
    } else toast(`Failed: ${r?.error || ''}`, 'danger');
    render();
  });

  // Sources page sync
  $$('.source-card.sync').forEach((el) => el.addEventListener('click', () => {
    const url = el.dataset.srcUrl;
    if (url) window.jat5.openExternal(url);
  }));

  // ===== Documents page =====
  $('#doc-upload-btn')?.addEventListener('click', () => $('#doc-upload-input')?.click());
  $('#doc-upload-input')?.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    toast(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`, 'info');
    let added = 0;
    for (const file of files) {
      try {
        const ab = await file.arrayBuffer();
        const r = await send('add-document', {
          name: file.name, originalFilename: file.name, type: 'other',
          mimeType: file.type, sizeBytes: file.size, buffer: ab
        });
        if (r?.ok) added++;
      } catch (err) { console.warn('upload failed', err); }
    }
    const r = await send('list-documents');
    if (r?.ok) state.documents = r.items || [];
    toast(`Uploaded ${added} document${added === 1 ? '' : 's'}.`, 'success');
    render();
  });

  // Bulk folder import
  const guessDocType = (name) => {
    if (/resume|cv|curriculum/i.test(name)) return 'resume';
    if (/cover/i.test(name)) return 'coverLetter';
    if (/degree|diploma|transcript/i.test(name)) return 'transcript';
    if (/portfolio/i.test(name)) return 'portfolio';
    return 'other';
  };
  const ALLOWED_DOC_EXT = /\.(pdf|doc|docx|txt|rtf|odt|png|jpg|jpeg)$/i;
  $('#doc-folder-btn')?.addEventListener('click', () => $('#doc-folder-upload')?.click());
  $('#doc-pierre-btn')?.addEventListener('click', () => {
    toast("Pick C:\\Users\\<you>\\Desktop\\Importing\\Resume — Chrome requires you to grant access to the folder once.", 'info');
    $('#doc-folder-upload')?.click();
  });
  $('#doc-folder-upload')?.addEventListener('change', async (e) => {
    const all = Array.from(e.target.files || []);
    const files = all.filter((f) => ALLOWED_DOC_EXT.test(f.name));
    if (files.length === 0) { toast('No supported files found in folder.', 'warn'); return; }
    toast(`Importing 0 of ${files.length}…`, 'info');
    let added = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const ab = await file.arrayBuffer();
        const r = await send('add-document', {
          name: file.name, originalFilename: file.name, type: guessDocType(file.name),
          mimeType: file.type, sizeBytes: file.size, buffer: ab
        });
        if (r?.ok) added++;
      } catch (err) { console.warn('folder import failed', file.name, err); }
      if ((i + 1) % 5 === 0 || i === files.length - 1) {
        toast(`Importing ${i + 1} of ${files.length}…`, 'info');
      }
    }
    const r = await send('list-documents');
    if (r?.ok) state.documents = r.items || [];
    toast(`Imported ${added} file${added === 1 ? '' : 's'}.`, 'success');
    render();
  });

  $$('[data-doc-open]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.docOpen;
    const d = state.documents.find((x) => x.id === id);
    if (!d || !d.data) { toast('No file data.', 'danger'); return; }
    try {
      const blob = makeDocBlob(d);
      const url = URL.createObjectURL(blob);
      // window.open from THIS document keeps the blob URL in the same realm
      // (an external-shell open can't reach our blob URL → fails to load)
      const w = window.open(url, '_blank');
      if (!w) { toast('Popup blocked. Allow popups for this extension page.', 'danger'); URL.revokeObjectURL(url); return; }
      // Don't revoke immediately — the new tab needs the URL alive
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) { toast('Open failed: ' + (err.message || err), 'danger'); }
  }));
  $$('[data-doc-download]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.docDownload;
    const d = state.documents.find((x) => x.id === id);
    if (!d || !d.data) { toast('No file data.', 'danger'); return; }
    try {
      const blob = makeDocBlob(d);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = d.originalFilename || d.name || 'document';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) { toast('Download failed: ' + (err.message || err), 'danger'); }
  }));
  $$('[data-doc-edit]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.docEdit;
    const d = state.documents.find((x) => x.id === id);
    if (!d) return;
    const newName = prompt('Document name:', d.name);
    if (newName == null) return;
    const types = DOC_TYPES.map(([v, l], i) => `${i + 1}. ${l}`).join('\n');
    const choice = prompt(`Type (current: ${DOC_TYPE_LABEL[d.type] || d.type}):\n${types}\n\nEnter number 1-${DOC_TYPES.length} or leave blank to keep:`, '');
    let newType = d.type;
    if (choice && /^\d+$/.test(choice.trim())) {
      const i = parseInt(choice.trim(), 10) - 1;
      if (i >= 0 && i < DOC_TYPES.length) newType = DOC_TYPES[i][0];
    }
    const r = await send('patch-document', { id, patch: { name: newName.trim() || d.name, type: newType } });
    if (r?.ok) toast('Updated.', 'success');
    else toast('Update failed.', 'danger');
  }));
  $$('[data-doc-delete]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.docDelete;
    const d = state.documents.find((x) => x.id === id);
    if (!d) return;
    if (!confirm(`Delete "${d.name}"? This cannot be undone.`)) return;
    const r = await send('delete-document', { id });
    if (r?.ok) toast('Deleted.', 'success');
  }));

  // Auto-tracked: upload picker pre-typed
  $$('[data-tracked-upload]').forEach((b) => b.addEventListener('click', () => {
    const trackedName = b.dataset.trackedUpload;
    const trackedType = b.dataset.trackedType;
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    input.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const ab = await file.arrayBuffer();
        const r = await send('add-document', {
          name: trackedName, originalFilename: file.name, type: trackedType,
          mimeType: file.type, sizeBytes: file.size, buffer: ab
        });
        if (r?.ok) toast(`Uploaded "${trackedName}".`, 'success');
        else toast('Upload failed.', 'danger');
      } catch (err) { toast('Upload failed: ' + (err.message || err), 'danger'); }
    });
    document.body.appendChild(input);
    input.click();
    setTimeout(() => input.remove(), 60000);
  }));

  // ===== Job detail: documents section =====
  $('#link-doc-btn')?.addEventListener('click', async () => {
    const sel = $('#link-doc-select');
    const docId = sel?.value;
    const jobId = $('#link-doc-btn').dataset.jobId;
    if (!docId) { toast('Pick a document first.', 'info'); return; }
    const d = state.documents.find((x) => x.id === docId);
    if (!d) return;
    const prev = d.linkedJobIds || [];
    if (prev.includes(jobId)) { toast('Already linked.', 'info'); return; }
    const r = await send('patch-document', { id: docId, patch: { linkedJobIds: [...prev, jobId] } });
    if (r?.ok) toast('Linked.', 'success');
  });
  // Inline upload for missing resume/cover
  ['upload-resume-btn', 'upload-cover-btn'].forEach((btnId) => {
    const btn = $('#' + btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const jobId = btn.dataset.jobId;
      const docType = btn.dataset.docType;
      const presetName = btn.dataset.name;
      const input = $('#job-doc-upload');
      if (!input) return;
      input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          const ab = await file.arrayBuffer();
          const r = await send('add-document', {
            name: presetName || file.name, originalFilename: file.name,
            type: docType, mimeType: file.type, sizeBytes: file.size,
            buffer: ab, linkedJobIds: [jobId]
          });
          if (r?.ok) toast(`Uploaded "${presetName}".`, 'success');
          else toast('Upload failed.', 'danger');
        } catch (err) { toast('Upload failed: ' + (err.message || err), 'danger'); }
      };
      input.click();
    });
  });

  // AI Setup Wizard
  $$('[data-pick-provider]').forEach((el) => el.addEventListener('click', async () => {
    const id = el.dataset.pickProvider;
    const r = await send('patch-settings', { aiProvider: id });
    if (r?.ok) state.settings = r.settings;
    state.aiWizardStep = 2;
    state.aiTestResult = null;
    render();
  }));
  $('#wiz-prev')?.addEventListener('click', () => {
    state.aiWizardStep = Math.max(1, (state.aiWizardStep || 1) - 1);
    render();
  });
  $('#wiz-next')?.addEventListener('click', () => {
    state.aiWizardStep = Math.min(3, (state.aiWizardStep || 1) + 1);
    render();
  });
  $('#wiz-retest')?.addEventListener('click', async () => {
    await refreshAi();
  });
  $('#wiz-save-test')?.addEventListener('click', async () => {
    const out = $('#wiz-test-out');
    if (out) out.textContent = 'Testing…';
    const provider = state.settings.aiProvider || 'ollama';
    const patch = {};
    if (provider === 'ollama') {
      patch.ollamaUrl = $('#wiz-ollamaUrl')?.value || '';
      patch.ollamaModel = $('#wiz-ollamaModel')?.value || '';
    } else if (provider === 'openai') {
      patch.openaiKey = $('#wiz-openaiKey')?.value || '';
      patch.openaiBaseUrl = $('#wiz-openaiBaseUrl')?.value || '';
      patch.openaiModel = $('#wiz-openaiModel')?.value || '';
    }
    if (Object.keys(patch).length) {
      const s = await send('patch-settings', patch);
      if (s?.ok) state.settings = s.settings;
    }
    const r = await send('ai-status');
    if (r?.ok) state.aiStatus = r.status;
    const o2 = $('#wiz-test-out');
    if (o2) {
      o2.innerHTML = state.aiStatus?.available
        ? `<span style="color:var(--success)">✓ ${escape(state.aiStatus.provider)} ready</span>`
        : `<span style="color:var(--danger)">✗ ${escape(state.aiStatus?.reason || 'unavailable')}</span>`;
    }
  });
  $('#wiz-run-test')?.addEventListener('click', async () => {
    const out = $('#wiz-test-prompt-out');
    if (out) out.innerHTML = '<div class="empty">AI thinking…</div>';
    const r = await aiCall({ feature: 'insights', jobs: state.jobs });
    state.aiTestResult = r;
    render();
  });
  $$('.copy-btn').forEach((b) => b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      const orig = b.textContent;
      b.textContent = 'Copied!';
      setTimeout(() => { b.textContent = orig; }, 1200);
    } catch (e) { toast('Copy failed', 'danger'); }
  }));
}

async function refreshAi() {
  const r = await send('ai-status');
  if (r?.ok) state.aiStatus = r.status;
  render();
}

async function runAi(feature, jobId) {
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job) return;
  state.aiErrors = state.aiErrors || {};
  state.aiLoading[jobId] = { ...(state.aiLoading[jobId] || {}), [feature]: true };
  state.aiResults[jobId] = { ...(state.aiResults[jobId] || {}), _last: feature };
  // Clear previous error for this feature
  if (state.aiErrors[jobId]) delete state.aiErrors[jobId][feature];
  render();
  const t0 = Date.now();
  try {
    const r = await aiCall({ feature, job, profile: state.profile });
    if (!r?.ok) throw new Error(r?.error || 'AI returned no result');
    state.aiResults[jobId] = { ...(state.aiResults[jobId] || {}), [feature]: r.result, _last: feature };
    toast(`AI ${feature} ready (${Math.round((Date.now() - t0) / 1000)}s).`, 'success');
  } catch (e) {
    const msg = String(e.message || e);
    state.aiErrors[jobId] = { ...(state.aiErrors[jobId] || {}), [feature]: msg };
    state.aiResults[jobId] = { ...(state.aiResults[jobId] || {}), _last: feature };
    toast(`AI failed: ${msg.slice(0, 100)}`, 'danger');
  } finally {
    if (state.aiLoading[jobId]) delete state.aiLoading[jobId][feature];
    render();
  }
}

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

setRoute();
load();
