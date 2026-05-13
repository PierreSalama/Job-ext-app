// Single-page app for v5. Hash routing, vanilla JS, no build step.
import { STATUS_LABELS, STATUSES } from '../lib/schema.js';
import { THEMES, applyTheme, subscribeThemeChanges } from '../lib/themes.js';
import { ICON_PRESETS, presetToSvgDataUrl, presetToIconBundle, imageUrlToIconBundle } from '../lib/icon-presets.js';
import { computeSidebar, groupBySection, PAGES } from '../lib/pages.js';
import { renderSidebar as renderSidebarUi, renderHiddenPicker, syncNavActiveIndicator } from './sidebar.js';
import { attachCommandPalette as attachCmdPalette } from './cmd-palette.js';
import { attachKeyboard, showShortcutsOverlay } from './keyboard.js';
// v8 page modules — each exports { render(state), attach($main, ctx) }
import * as pPipeline from './pages/pipeline.js';
import * as pCalendar from './pages/calendar.js';
import * as pReminders from './pages/reminders.js';
import * as pTodos from './pages/todos.js';
import * as pInbox from './pages/inbox.js';
import * as pThreads from './pages/threads.js';
import * as pTemplates from './pages/templates.js';
import * as pContacts from './pages/contacts.js';
import * as pCompanies from './pages/companies.js';
import * as pNotes from './pages/notes.js';
import * as pResumeBuilder from './pages/resume-builder.js';
import * as pCoverStudio from './pages/cover-studio.js';
import * as pInterviewPrep from './pages/interview-prep.js';
import * as pSalary from './pages/salary.js';
import * as pAnalytics from './pages/analytics.js';
import * as pGoals from './pages/goals.js';
import * as pAchievements from './pages/achievements.js';
import * as pSkills from './pages/skills.js';
import * as pRecommendationsPage from './pages/recommendations.js';
import * as pAudit from './pages/audit.js';
import * as pBackup from './pages/backup.js';
import * as pLogs from './pages/logs.js';
import * as pIntegrations from './pages/integrations.js';
import * as pAiLab from './pages/ai-lab.js';
import * as pTour from './pages/tour.js';
import * as pInstallApp from './pages/install-app.js';
import * as pBulkTools from './pages/bulk-tools.js';
import * as pPomodoro from './pages/pomodoro.js';
// v8 pages
import * as pMockInterview from './pages/mock-interview.js';
import * as pOfferCompare from './pages/offer-compare.js';
import * as pCompanyHub from './pages/company-hub.js';
import * as pAiCoach from './pages/ai-coach.js';
import * as pNegotiation from './pages/negotiation.js';
import * as pReferences from './pages/references.js';
import * as pRoadmap from './pages/roadmap.js';
import * as pDailyDigest from './pages/daily-digest.js';
// v8 NEW pages
import * as pFitScores from './pages/fit-scores.js';
import * as pRedFlags from './pages/red-flags.js';
import * as pAutopsy from './pages/autopsy.js';
import * as pTags from './pages/tags.js';
import * as pSavedViews from './pages/saved-views.js';
import * as pHealth from './pages/health.js';
import * as pSandbox from './pages/sandbox.js';
import * as pPermissions from './pages/permissions.js';
import * as pRecipes from './pages/recipes.js';
import * as pWebhooks from './pages/webhooks.js';
import * as pVoice from './pages/voice.js';
import * as pTimeline from './pages/timeline.js';
import { pushUndo, peekUndo, popUndo, applyUndo } from './undo.js';
import { attachExtraKeyboard } from './keyboard.js';

const PAGE_RENDERERS = {
  '/pipeline':  pPipeline,
  '/calendar':  pCalendar,
  '/reminders': pReminders,
  '/todos':     pTodos,
  '/inbox':     pInbox,
  '/threads':   pThreads,
  '/templates': pTemplates,
  '/contacts':  pContacts,
  '/companies': pCompanies,
  '/notes':            pNotes,
  '/resume-builder':   pResumeBuilder,
  '/cover-studio':     pCoverStudio,
  '/interview-prep':   pInterviewPrep,
  '/salary':           pSalary,
  '/analytics':        pAnalytics,
  '/goals':            pGoals,
  '/achievements':     pAchievements,
  '/skills':           pSkills,
  '/recommendations':  pRecommendationsPage,
  '/audit':            pAudit,
  '/backup':           pBackup,
  '/logs':             pLogs,
  '/integrations':     pIntegrations,
  '/ai-lab':           pAiLab,
  '/tour':             pTour,
  '/install-app':      pInstallApp,
  '/bulk-tools':       pBulkTools,
  '/pomodoro':         pPomodoro,
  // v8 pages
  '/mock-interview':   pMockInterview,
  '/offer-compare':    pOfferCompare,
  '/company-hub':      pCompanyHub,
  '/ai-coach':         pAiCoach,
  '/negotiation':      pNegotiation,
  '/references':       pReferences,
  '/roadmap':          pRoadmap,
  '/daily-digest':     pDailyDigest,
  // v8 NEW pages
  '/fit-scores':       pFitScores,
  '/red-flags':        pRedFlags,
  '/autopsy':          pAutopsy,
  '/tags':             pTags,
  '/saved-views':      pSavedViews,
  '/health':           pHealth,
  '/sandbox':          pSandbox,
  '/permissions':      pPermissions,
  '/recipes':          pRecipes,
  '/webhooks':         pWebhooks,
  '/voice':            pVoice,
  '/timeline':         pTimeline,
};

const send = (type, data) => new Promise((res) => chrome.runtime.sendMessage({ type, data }, res));

// Pre-rasterize an icon bundle in the page (which has full SVG → canvas
// support) and ship it to the service worker as a structure-cloneable plain
// object. SW reconstructs ImageData and calls chrome.action.setIcon.
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

// Port-based AI client. Survives MV3 service-worker idle termination during
// long Ollama calls (Chrome keeps the SW alive while the port is connected).
let _aiPort = null;
const _aiPending = new Map();
function getAiPort() {
  if (_aiPort) return _aiPort;
  _aiPort = chrome.runtime.connect({ name: 'jat5-ai' });
  _aiPort.onMessage.addListener((m) => {
    const cb = _aiPending.get(m.id);
    if (cb) { _aiPending.delete(m.id); cb(m); }
  });
  _aiPort.onDisconnect.addListener(() => {
    // Reject all pending so the UI never freezes
    for (const [id, cb] of _aiPending) cb({ ok: false, error: 'AI worker disconnected' });
    _aiPending.clear();
    _aiPort = null;
  });
  return _aiPort;
}
function aiCall(data) {
  return new Promise((resolve) => {
    const id = 'a' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    _aiPending.set(id, resolve);
    try { getAiPort().postMessage({ id, type: 'ai-call', data }); }
    catch (e) { _aiPending.delete(id); resolve({ ok: false, error: String(e.message || e) }); }
  });
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
  namedProfiles: [],
  aiErrors: {},
  syncStatus: { healthy: false, connected: false },
  // v8 stores
  events: [],
  reminders: [],
  todos: [],
  messages: [],
  emailTemplates: [],
  contacts: [],
  companies: [],
  notes: [],
  // v8.5 QoL stores
  templates: [],
  savedSearches: [],
  pomodoroSessions: [],
  dailySummaries: [],
  // Bound after function declarations below — pages call this to re-render
  __rerender: null,
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
  // Probe desktop app health on boot + every 8s thereafter
  send('probe-app-health').then((r) => {
    if (r?.health) { state.appHealth = r.health; render(); }
  });
  // v8: polls update pills in place — no full re-render. Periodic renders were
  // wiping the dashboard DOM mid-interaction and looking like "auto refresh".
  setInterval(async () => {
    try {
      const r = await send('probe-app-health');
      state.appHealth = r?.health || { ok: false };
      updateSyncPill(); // in-place DOM update, no render()
    } catch {}
  }, 15000);
  setInterval(async () => {
    try {
      const r = await send('ai-status');
      if (r?.ok) {
        state.aiStatus = r.status;
        updateAiPill(); // in-place DOM update
      }
    } catch {}
  }, 30000);
  // Live theme updates from any extension surface (popup / sibling tab)
  subscribeThemeChanges((id) => applyTheme(id));
  // Initial sync status from background
  try {
    const ss = await send('sync.status');
    if (ss?.ok) state.syncStatus = ss.status || state.syncStatus;
  } catch {}
  // Also load Q&A and recommendations
  const [qa, recs, docs, np, uinfo, ainfo] = await Promise.all([send('list-answers'), send('list-recommendations'), send('list-documents'), send('list-named-profiles'), send('get-extension-update-info'), send('get-app-update-info')]);
  if (np?.ok) state.namedProfiles = np.items || [];
  if (qa?.ok) state.answers = qa.items || [];
  if (recs?.ok) state.recommendations = recs.items || [];
  if (docs?.ok) state.documents = docs.items || [];
  if (uinfo?.ok) state.updateInfo = uinfo.info || null;
  if (ainfo?.ok) state.appUpdateInfo = ainfo.info || null;
  // v8 stores
  const v6Loads = await Promise.all([
    send('list-events'), send('list-reminders'), send('list-todos'),
    send('list-messages'), send('list-emailTemplates'),
    send('list-contacts'), send('list-companies')
  ]);
  const [ev, rem, td, msg, tpl, ct, co] = v6Loads;
  if (ev?.ok) state.events = ev.items || [];
  if (rem?.ok) state.reminders = rem.items || [];
  if (td?.ok) state.todos = td.items || [];
  if (msg?.ok) state.messages = msg.items || [];
  if (tpl?.ok) state.emailTemplates = tpl.items || [];
  if (ct?.ok) state.contacts = ct.items || [];
  if (co?.ok) state.companies = co.items || [];
  // v8 knowledge / growth stores
  const moreLoads = await Promise.all([
    send('list-notes'), send('list-salaryEntries'), send('list-goals'),
    send('list-achievements'), send('list-skills'),
    send('list-resumeVersions'), send('list-coverLetters'),
    send('list-interviewQuestions'), send('list-practice')
  ]);
  const [nt, sa, gl, ac, sk, rv, cl, iq, pr] = moreLoads;
  if (nt?.ok) state.notes = nt.items || [];
  if (sa?.ok) state.salaryEntries = sa.items || [];
  if (gl?.ok) state.goals = gl.items || [];
  if (ac?.ok) state.achievements = ac.items || [];
  if (sk?.ok) state.skills = sk.items || [];
  if (rv?.ok) state.resumeVersions = rv.items || [];
  if (cl?.ok) state.coverLetters = cl.items || [];
  if (iq?.ok) state.interviewQuestions = iq.items || [];
  if (pr?.ok) state.practice = pr.items || [];
  // v8.5 QoL stores
  try {
    const qolLoads = await Promise.all([
      send('list-templates'), send('list-savedSearches'),
      send('list-pomodoroSessions'), send('list-dailySummaries')
    ]);
    const [tpl, ss, ps, ds] = qolLoads;
    if (tpl?.ok) state.templates = tpl.items || [];
    if (ss?.ok) state.savedSearches = ss.items || [];
    if (ps?.ok) state.pomodoroSessions = ps.items || [];
    if (ds?.ok) state.dailySummaries = ds.items || [];
  } catch {}
  // v8 stores
  try {
    const v8Loads = await Promise.all([send('list-mockInterviews'), send('list-references')]);
    const [mi, rf] = v8Loads;
    if (mi?.ok) state.mockInterviews = mi.items || [];
    if (rf?.ok) state.references = rf.items || [];
  } catch {}
  // ===== v8 NEW STORES =====
  try {
    const v8Loads2 = await Promise.all([
      send('list-tags'), send('list-savedViews'), send('list-fitScores'),
      send('list-redFlags'), send('list-autopsies'), send('list-tailoredResumes'),
      send('list-snapshots'), send('list-scrapedSalary'), send('list-autoStatusEvents'),
      send('list-drafts'), send('list-digests'), send('list-healthChecks'),
      send('list-smartTagRules'), send('list-recipes'), send('list-webhooks'),
      send('list-xpEvents')
    ]);
    const keys = ['tags','savedViews','fitScores','redFlags','autopsies','tailoredResumes',
                  'snapshots','scrapedSalary','autoStatusEvents','drafts','digests',
                  'healthChecks','smartTagRules','recipes','webhooks','xpEvents'];
    v8Loads2.forEach((r, i) => { if (r?.ok) state[keys[i]] = r.items || []; });
  } catch {}
  render();

  // v8.0.8: kick off an immediate update check on every app load so users with
  // an outdated extension OR an outdated desktop app see the prompt within
  // seconds. Runs in parallel, doesn't block the initial render. Each call
  // broadcasts (extension|app).update.checked which the listener picks up and
  // re-renders cheaply.
  (async () => {
    try { await send('check-extension-update'); } catch {}
    try { await send('check-app-update'); } catch {}
  })();
}

// Reload a single store slice and re-render. Page modules call ctx.reload(name).
async function reloadStateSlice(store) {
  const r = await send('list-' + store);
  if (r?.ok) { state[store] = r.items || []; render(); }
}

function setRoute() {
  state.route = location.hash.slice(1) || '/';
  if (state.route.startsWith('/job/')) {
    state.selectedJobId = state.route.split('/')[2];
  }
  render();
}
window.addEventListener('hashchange', setRoute);

// v8: debounce broadcast-triggered renders so a burst (e.g. capture + tag-rule
// apply + webhook fire) coalesces into one re-render, not 4. Also: only render
// if the active route actually shows this store's data.
let _renderTimer = null;
let _lastRenderedRoute = null; // v8.0.10: only animate on route changes

// v8.0.10: which settings keys matter for the visible page. Changes to other
// keys (seenTips, dismissedDesktopPromo, tourLastStep, lastUpdateCheckAt, etc.)
// shouldn't trigger a full re-render — those fired multiple "visible refreshes"
// after every minor click.
const VISUAL_SETTINGS_KEYS = new Set([
  'theme', 'density', 'fontScale', 'highContrast', 'dyslexiaFriendly', 'reducedMotion',
  'sidebarOrder', 'sidebarHidden', 'sidebarPinned', 'sidebarSections',
  'iconPreset', 'iconCustomDataUrl', 'dashboardShortcuts',
  'aiProvider', 'ollamaModel', 'desktopAppEnabled'
]);
function settingsAffectVisuals(prev, next) {
  if (!prev || !next) return true;
  for (const k of VISUAL_SETTINGS_KEYS) {
    const a = JSON.stringify(prev[k]);
    const b = JSON.stringify(next[k]);
    if (a !== b) return true;
  }
  return false;
}
function scheduleRender(immediate = false) {
  if (immediate) {
    if (_renderTimer) { clearTimeout(_renderTimer); _renderTimer = null; }
    render();
    return;
  }
  if (_renderTimer) return;
  _renderTimer = setTimeout(() => { _renderTimer = null; render(); }, 150);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'jat-event') return;
  const { name, data } = msg;
  if (name === 'job.created' || name === 'job.updated') {
    const i = state.jobs.findIndex((j) => j.id === data.job.id);
    if (i >= 0) state.jobs[i] = data.job; else state.jobs.push(data.job);
    refreshSummary();
    scheduleRender();
  } else if (name === 'job.deleted') {
    state.jobs = state.jobs.filter((j) => j.id !== data.id);
    refreshSummary();
    scheduleRender();
  } else if (name === 'settings.updated') {
    // v8.0.10: only rerender when something visible changed. Tip-dismissals
    // / followup-due updates / etc. don't need a full re-render — they
    // were causing visible "page refreshes" after every minor click.
    const prev = state.settings || {};
    const next = data.settings || {};
    state.settings = next;
    if (next.theme && next.theme !== prev.theme) applyTheme(next.theme);
    if (settingsAffectVisuals(prev, next)) scheduleRender();
    else { updateAiPill?.(); updateSyncPill?.(); }
  } else if (name === 'recommendations.updated') {
    send('list-recommendations').then((r) => { if (r?.ok) { state.recommendations = r.items; scheduleRender(); } });
  } else if (name === 'documents.updated') {
    send('list-documents').then((r) => { if (r?.ok) { state.documents = r.items || []; scheduleRender(); } });
  } else if (name === 'profile.updated') {
    state.profile = data.profile || state.profile;
    send('list-answers').then((r) => { if (r?.ok) { state.answers = r.items || []; scheduleRender(); } });
  } else if (name === 'sync.status') {
    state.syncStatus = data || state.syncStatus;
    updateSyncPill(); // pill only — no full render
  } else if (name === 'sidebar.reset') {
    // v8.0.7: background just force-reset the sidebar — pull fresh settings
    // and rerender so the user immediately sees the minimal sidebar.
    send('get-settings').then((r) => {
      if (r?.ok) { state.settings = r.settings || state.settings; scheduleRender(); }
    });
  } else if (name === 'extension.update.checked') {
    state.updateInfo = { ...data, checkedAt: Date.now() };
    scheduleRender();
  } else if (name === 'app.update.checked') {
    state.appUpdateInfo = { ...data, checkedAt: Date.now() };
    scheduleRender();
  } else if (name === 'namedProfiles.updated') {
    send('list-named-profiles').then((r) => { if (r?.ok) { state.namedProfiles = r.items || []; scheduleRender(); } });
  } else {
    const m = String(name || '').match(/^(events|reminders|todos|messages|emailTemplates|contacts|companies|notes|salaryEntries|goals|achievements|skills|resumeVersions|coverLetters|interviewQuestions|practice|templates|savedSearches|pomodoroSessions|dailySummaries|mockInterviews|references|tags|savedViews|fitScores|redFlags|autopsies|tailoredResumes|snapshots|scrapedSalary|autoStatusEvents|drafts|digests|healthChecks|smartTagRules|recipes|webhooks|xpEvents)\.updated$/);
    if (m) {
      const store = m[1];
      send('list-' + store).then((r) => { if (r?.ok) { state[store] = r.items || []; scheduleRender(); } });
    }
  }
});

async function refreshSummary() {
  const r = await send('status-summary');
  if (r?.ok) state.summary = r.summary;
}

// Sidebar search query (separate from main page search/filter state)
let _sidebarSearch = '';

async function patchAppSettings(patch) {
  const r = await send('patch-settings', patch);
  if (r?.ok) state.settings = r.settings;
  render();
}

function applySectionOverrides(settings) {
  const overrides = (settings && settings.sectionOverrides) || {};
  if (!Object.keys(overrides).length) return settings;
  for (const p of PAGES) {
    if (overrides[p.id]) p.section = overrides[p.id];
  }
  return settings;
}

function renderSidebar() {
  applySectionOverrides(state.settings);
  renderSidebarUi({
    navEl: $('#nav'),
    settings: state.settings,
    currentRoute: state.route,
    search: _sidebarSearch,
    onChange: patchAppSettings,
    onNavigate: () => {}
  });
  const pill = $('#sync-pill');
  const lbl = $('#sync-label');
  if (pill && lbl) {
    if (state.syncStatus?.connected) { pill.className = 'sync-pill ok'; lbl.textContent = 'Desktop app: connected'; }
    else if (state.syncStatus?.healthy) { pill.className = 'sync-pill ok'; lbl.textContent = 'Desktop app: online'; }
    else { pill.className = 'sync-pill bad'; lbl.textContent = 'Desktop app: offline'; }
  }
}

// v8: in-place sidebar pill updates (no full re-render — prevents the
// "dashboard refreshes itself" issue caused by periodic full renders).
function updateSyncPill() {
  const pill = document.getElementById('sync-pill');
  const lbl = document.getElementById('sync-label');
  if (!pill || !lbl) return;
  if (state.syncStatus?.connected) { pill.className = 'sync-pill ok'; lbl.textContent = 'Desktop app: connected'; }
  else if (state.syncStatus?.healthy) { pill.className = 'sync-pill ok'; lbl.textContent = 'Desktop app: online'; }
  else { pill.className = 'sync-pill bad'; lbl.textContent = state.appHealth?.ok ? 'Desktop app: online' : 'Desktop app: offline'; }
}
function updateAiPill() {
  const pill = document.getElementById('ai-pill');
  if (!pill) return;
  if (state.aiStatus?.available) {
    pill.className = 'ai-status ok';
    pill.textContent = `✨ AI: ${state.aiStatus.provider} ready`;
    pill.title = `${state.aiStatus.provider}${state.aiStatus.model ? ' · ' + state.aiStatus.model : ''}`;
  } else {
    pill.className = 'ai-status bad';
    const reason = state.aiStatus?.reason || 'not configured';
    pill.textContent = `⚠ AI: ${reason.length > 40 ? reason.slice(0, 38) + '…' : reason}`;
    pill.title = reason + ' — click to fix';
  }
  pill.style.cursor = 'pointer';
  if (!pill.__bound) {
    pill.__bound = true;
    pill.addEventListener('click', () => { location.hash = '#/ai'; });
  }
}

function render() {
  renderSidebar();
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
  updateAiPill();
  updateSyncPill();

  let html;
  let activePageModule = null;
  if (state.route === '/') html = pageDashboard();
  else if (state.route === '/jobs') html = pageJobs();
  else if (state.route.startsWith('/job/')) html = pageJobDetail();
  else if (state.route === '/profile') html = pageProfile();
  else if (state.route === '/settings') html = pageSettings();
  else if (state.route === '/ai') html = pageAi();
  else if (state.route === '/documents') html = pageDocuments();
  else if (state.route === '/sources') html = pageSources();
  else if (PAGE_RENDERERS[state.route]) {
    activePageModule = PAGE_RENDERERS[state.route];
    // v8.0.10: error boundary — a single page module's throw should NOT blank
    // the entire app. Surface the error inline + a "Back to Dashboard" exit.
    try { html = activePageModule.render(state); }
    catch (err) {
      console.error('[v8] page render error:', state.route, err);
      activePageModule = null;
      html = `<div class="card"><h2 style="margin-top:0">⚠️ Something went wrong on this page</h2>
        <p style="font-size:13px;color:var(--muted)">A page module crashed while rendering. Your data is safe — only this page failed.</p>
        <pre style="background:var(--bg);padding:10px;border-radius:6px;font-size:12px;overflow:auto;max-height:200px">${escape(String(err?.stack || err?.message || err))}</pre>
        <div style="display:flex;gap:6px;margin-top:10px">
          <a class="btn primary" href="#/">← Back to Dashboard</a>
          <button class="btn" id="retry-page-render">🔁 Retry</button>
        </div>
      </div>`;
    }
  }
  else html = `<div class="empty"><strong>Coming soon.</strong>${escape(state.route)} hasn't been built yet.</div>`;
  // Global AI-unavailable banner (skip on the AI page itself to avoid duplication)
  let banner = '';
  if (state.aiStatus && state.aiStatus.available === false && state.route !== '/ai') {
    banner = `<a href="#/ai" class="ai-banner">⚠ AI unavailable${state.aiStatus.reason ? ' — ' + escape(state.aiStatus.reason) : ''} — open the AI Setup Wizard →</a>`;
  }
  // Desktop-app offline banner — only when user hasn't dismissed AND isn't already on the install page
  if (
    state.appHealth && state.appHealth.ok === false &&
    state.settings?.desktopAppEnabled !== false &&
    !state.settings?.installAppBannerDismissed &&
    state.route !== '/install-app'
  ) {
    banner += `<a href="#/install-app" class="app-banner">🖥️ Desktop app not detected — install the optional companion for real-time sync, folder watching &amp; background scrapes →</a>`;
  }
  if (state.appHealth?.ok && state.route !== '/install-app') {
    // Subtle "synced" pill in sidebar would be nicer; skip top banner when paired
  }
  // v8.0.8: prominent UPDATE-AVAILABLE banner — top of every page so users
  // with an old extension OR old desktop app see the prompt immediately.
  const eu = state.updateInfo || {};
  const au = state.appUpdateInfo || {};
  if (eu.hasUpdate && state.route !== '/settings') {
    banner += `<a href="#/settings" class="update-banner" style="background:linear-gradient(90deg,#6366f1,#ec4899);color:#fff;display:block;padding:10px 14px;text-decoration:none;font-size:13px;font-weight:600;border-radius:8px;margin-bottom:10px">⬆️ Extension update available — v${escape(eu.current)} → v${escape(eu.latest)} · click to update</a>`;
  }
  if (au.hasUpdate && state.route !== '/settings') {
    const label = au.downloaded ? '🚀 Desktop app update ready to install' : `⬆️ Desktop app update available — v${escape(au.current)} → v${escape(au.latest)}`;
    banner += `<a href="#/settings" class="update-banner" style="background:linear-gradient(90deg,#10b981,#3b82f6);color:#fff;display:block;padding:10px 14px;text-decoration:none;font-size:13px;font-weight:600;border-radius:8px;margin-bottom:10px">${label} · click to update</a>`;
  }
  const main = $('#main');
  // Prefer the dedicated page-content slot (added in v8.5) so the topbar persists
  const pc = $('#page-content');
  if (pc) {
    pc.innerHTML = banner + html;
    // Welcome overlay rides on body to avoid wiping topbar
    if (!document.getElementById('welcome-overlay')) {
      const w = welcomeOverlay();
      if (w) document.body.insertAdjacentHTML('beforeend', w);
    }
  } else {
    main.innerHTML = banner + html + welcomeOverlay();
  }
  try { renderBreadcrumbs(); } catch {}
  try { applyPageFavicon(); } catch {}
  try { renderProfileSwitcher(); } catch {}
  // v8.0.10: page-enter animation ONLY on route changes — not on every render.
  // Previously: dismissing a tip / saving a setting fired a broadcast → render
  // → 400ms slide-in animation replayed, looking like "the page refreshed twice".
  if (!document.body.classList.contains('reduced-motion') && _lastRenderedRoute !== state.route) {
    main.classList.remove('page-enter');
    requestAnimationFrame(() => main.classList.add('page-enter'));
    setTimeout(() => main.classList.remove('page-enter'), 400);
  }
  _lastRenderedRoute = state.route;
  // Density class
  const density = state.settings.density || 'comfortable';
  document.body.classList.remove('density-compact', 'density-comfortable', 'density-spacious');
  document.body.classList.add('density-' + density);
  // v8: data-attributes for css selectors
  document.body.dataset.density = density;
  document.body.dataset.reducedMotion = state.settings.reducedMotion ? 'true' : 'false';
  document.body.dataset.contrast = state.settings.highContrast ? 'high' : 'normal';
  document.body.dataset.dyslexia = state.settings.dyslexiaFriendly ? 'true' : 'false';
  // Reduced motion class
  document.body.classList.toggle('reduced-motion', !!state.settings.reducedMotion);
  // Sticky page-h
  const ph = main.querySelector('.page-h');
  if (ph) {
    ph.classList.add('sticky');
    main.addEventListener('scroll', () => {
      ph.classList.toggle('scrolled', main.scrollTop > 8);
    }, { once: false });
  }
  // Onboarding tip per page
  maybeShowOnboardingTip();
  // Sidebar active indicator slide
  syncNavActiveIndicator($('#nav'));
  attach();
  // Welcome overlay handlers
  $('#welcome-skip')?.addEventListener('click', async () => {
    await send('patch-settings', { onboardingDone: true });
    state.settings.onboardingDone = true;
    $('#welcome-overlay')?.remove();
  });
  $('#welcome-tour')?.addEventListener('click', async () => {
    await send('patch-settings', { onboardingDone: true });
    state.settings.onboardingDone = true;
    $('#welcome-overlay')?.remove();
    try {
      const [{ Tour }, { buildDefaultTour }] = await Promise.all([
        import('../lib/tour.js'),
        import('../lib/tour-steps.js')
      ]);
      const steps = buildDefaultTour();
      const tour = new Tour({
        steps,
        reducedMotion: !!state.settings?.reducedMotion,
        onAdvance: (i) => send('patch-settings', { tourLastStep: i }),
        onFinish: () => { send('patch-settings', { tourCompleted: true, tourLastStep: 0 }); toast('🎉 Tour complete! Welcome aboard.', 'success'); }
      });
      tour.start();
    } catch (e) { toast('Tour failed: ' + (e.message || e), 'danger'); }
  });
  if (activePageModule && typeof activePageModule.attach === 'function') {
    try {
      activePageModule.attach($('#main'), { send, toast, render, state, aiCall, reload: reloadStateSlice });
    } catch (e) {
      console.error('page attach failed:', e);
      toast(`Page attach failed: ${e.message || e}`, 'danger', 6000);
    }
  }
  // v8.0.10: error-boundary retry button
  $('#retry-page-render')?.addEventListener('click', () => render());
}

function escape(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

// ============ v8.5 QoL helpers ============
function renderBreadcrumbs() {
  const el = $('#breadcrumbs');
  if (!el) return;
  const route = state.route || '/';
  const crumbs = [{ label: 'Dashboard', href: '#/' }];
  if (route === '/') {
    crumbs[0].current = true;
  } else if (route.startsWith('/job/')) {
    const j = state.jobs.find((x) => x.id === state.selectedJobId);
    crumbs.push({ label: 'Applications', href: '#/jobs' });
    crumbs.push({ label: j ? `${j.title || 'Untitled'} @ ${j.company || ''}` : 'Application', current: true });
  } else {
    const page = PAGES.find((p) => p.route === route);
    if (page) crumbs.push({ label: page.label, href: '#' + page.route, current: true });
    else crumbs.push({ label: route.slice(1), current: true });
  }
  el.innerHTML = crumbs.map((c, i) => {
    const sep = i > 0 ? '<span class="sep">›</span>' : '';
    if (c.current) return `${sep}<span class="crumb-current">${escape(c.label)}</span>`;
    return `${sep}<a href="${escape(c.href)}">${escape(c.label)}</a>`;
  }).join(' ');
}

const PAGE_EMOJI_BY_ROUTE = (() => {
  const m = {};
  for (const p of PAGES) m[p.route] = p.icon;
  return m;
})();

function applyPageFavicon() {
  const link = document.getElementById('page-favicon');
  if (!link) return;
  const route = state.route || '/';
  const baseRoute = route.startsWith('/job/') ? '/jobs' : route;
  const emoji = PAGE_EMOJI_BY_ROUTE[baseRoute] || '📋';
  // Build an SVG with the emoji as text — works as favicon in modern browsers.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text y="50" font-size="52">${emoji}</text></svg>`;
  link.href = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  // Page title: "<emoji> Page · Job Tracker"
  const page = PAGES.find((p) => p.route === baseRoute);
  document.title = `${emoji} ${page?.label || 'Job Tracker'} · JAT`;
}

function renderProfileSwitcher() {
  const sel = $('#profile-switcher');
  if (!sel) return;
  const named = state.namedProfiles || [];
  if (!named.length) {
    sel.style.display = 'none';
    return;
  }
  sel.style.display = '';
  const def = named.find((p) => p.isDefault) || named[0];
  sel.innerHTML = named.map((p) => `<option value="${escape(p.id)}"${def && p.id === def.id ? ' selected' : ''}>${escape(p.name)}${p.isDefault ? ' ★' : ''}</option>`).join('');
  sel.onchange = async () => {
    const id = sel.value;
    await send('patch-named-profile', { id, patch: { isDefault: true } });
    toast('Active profile switched.', 'success');
  };
}

// Recent items modal — Cmd+J
function openRecentItemsModal() {
  document.querySelectorAll('.recent-modal').forEach((n) => n.remove());
  const recentJobs = [...state.jobs].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 8);
  const recentNotes = [...(state.notes || [])].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 5);
  const recentContacts = [...(state.contacts || [])].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 5);
  const wrap = document.createElement('div');
  wrap.className = 'cmd-palette recent-modal';
  wrap.style.zIndex = 9800;
  wrap.innerHTML = `
    <div class="cmd-backdrop"></div>
    <div class="cmd-modal">
      <div style="font-size:13px;color:var(--muted);padding:4px 4px 0">Recent items</div>
      <div class="cmd-list">
        ${recentJobs.length ? `<div class="gs-group"><h4>Applications</h4>${recentJobs.map((j) => `<a class="gs-row" href="#/job/${escape(j.id)}">📋 ${escape(j.title || 'Untitled')} <small>${escape(j.company || '')}</small></a>`).join('')}</div>` : ''}
        ${recentNotes.length ? `<div class="gs-group"><h4>Notes</h4>${recentNotes.map((n) => `<a class="gs-row" href="#/notes">🗒 ${escape(n.title || 'Untitled')}</a>`).join('')}</div>` : ''}
        ${recentContacts.length ? `<div class="gs-group"><h4>Contacts</h4>${recentContacts.map((c) => `<a class="gs-row" href="#/contacts">👤 ${escape(c.name || 'Unknown')} <small>${escape(c.company || '')}</small></a>`).join('')}</div>` : ''}
      </div>
      <div class="cmd-hint">Esc to close</div>
    </div>
  `;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.querySelector('.cmd-backdrop').addEventListener('click', close);
  wrap.querySelectorAll('.gs-row').forEach((r) => r.addEventListener('click', close));
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });
}

// Quick add overlay — `n`
function openQuickAddOverlay() {
  document.querySelectorAll('.quick-add-overlay').forEach((n) => n.remove());
  const wrap = document.createElement('div');
  wrap.className = 'quick-add-overlay';
  wrap.innerHTML = `
    <div class="quick-add-card">
      <h3>+ Add new job</h3>
      <input type="text" id="qa-title" placeholder="Title (e.g., Senior Engineer)" autofocus />
      <input type="text" id="qa-company" placeholder="Company" />
      <select id="qa-status">
        ${STATUSES.map((s) => `<option value="${s}"${s === 'started' ? ' selected' : ''}>${STATUS_LABELS[s] || s}</option>`).join('')}
      </select>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
        <button class="btn" id="qa-cancel">Cancel</button>
        <button class="btn primary" id="qa-save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);
  const close = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('#qa-cancel').addEventListener('click', close);
  wrap.querySelector('#qa-save').addEventListener('click', async () => {
    const title = wrap.querySelector('#qa-title').value.trim();
    const company = wrap.querySelector('#qa-company').value.trim();
    const status = wrap.querySelector('#qa-status').value;
    if (!title || !company) { toast('Title and company required.', 'danger'); return; }
    const r = await send('capture', { title, company, status, source: 'Manual', _source: 'quick-add' });
    if (r?.ok) { toast(`Added "${title}".`, 'success'); close(); }
    else { toast('Save failed.', 'danger'); }
  });
  // Enter key in title/company should save
  wrap.querySelectorAll('input').forEach((inp) => inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') wrap.querySelector('#qa-save').click();
    if (e.key === 'Escape') close();
  }));
  setTimeout(() => wrap.querySelector('#qa-title')?.focus(), 0);
}

// Activity heatmap — 365 days, applications per day
function activityHeatmapHtml() {
  const days = 365;
  const counts = new Map();
  for (const j of state.jobs) {
    const t = j.submittedAt || j.createdAt;
    if (!t) continue;
    const k = new Date(t).toISOString().slice(0, 10);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const max = Math.max(1, ...counts.values());
  const cells = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const k = d.toISOString().slice(0, 10);
    const c = counts.get(k) || 0;
    let lvl = 0;
    if (c > 0) lvl = Math.min(4, Math.ceil((c / max) * 4));
    cells.push(`<div class="cell${lvl ? ' l' + lvl : ''}" title="${k}: ${c}"></div>`);
  }
  return `<div class="card" style="margin-top:14px"><h3 style="margin:0 0 8px;font-size:14px">📅 Activity (last 365 days)</h3><div class="heatmap">${cells.join('')}</div></div>`;
}

// Global search across jobs/contacts/companies/notes
function runGlobalSearch(query) {
  const out = $('#global-search-results');
  if (!out) return;
  const q = String(query || '').trim();
  if (!q) { out.hidden = true; out.innerHTML = ''; return; }
  // Shortcut filters (e.g. /title:eng /company:Acme /status:interview /source:LinkedIn)
  const shortcuts = {};
  const remaining = q.replace(/\/(\w+):([^\s]+)/g, (_, k, v) => { shortcuts[k.toLowerCase()] = v.toLowerCase(); return ''; }).trim().toLowerCase();
  const matchJob = (j) => {
    if (shortcuts.title && !(j.title || '').toLowerCase().includes(shortcuts.title)) return false;
    if (shortcuts.company && !(j.company || '').toLowerCase().includes(shortcuts.company)) return false;
    if (shortcuts.status && (j.status || '').toLowerCase() !== shortcuts.status) return false;
    if (shortcuts.source && !(j.source || '').toLowerCase().includes(shortcuts.source)) return false;
    if (!remaining) return Object.keys(shortcuts).length > 0;
    const hay = `${j.title} ${j.company} ${j.location} ${j.notes || ''}`.toLowerCase();
    return hay.includes(remaining);
  };
  const jobs = state.jobs.filter(matchJob).slice(0, 8);
  const contacts = (state.contacts || []).filter((c) => !remaining || `${c.name} ${c.company} ${c.email || ''}`.toLowerCase().includes(remaining)).slice(0, 5);
  const companies = (state.companies || []).filter((c) => !remaining || (c.name || '').toLowerCase().includes(remaining)).slice(0, 5);
  const notes = (state.notes || []).filter((n) => !remaining || `${n.title} ${n.body || ''}`.toLowerCase().includes(remaining)).slice(0, 5);
  if (!jobs.length && !contacts.length && !companies.length && !notes.length) {
    out.hidden = false;
    out.innerHTML = '<div class="empty">No matches.</div>';
    return;
  }
  out.hidden = false;
  out.innerHTML = `
    ${jobs.length ? `<div class="gs-group"><h4>Applications (${jobs.length})</h4>${jobs.map((j) => `<a class="gs-row" href="#/job/${escape(j.id)}">📋 ${escape(j.title || 'Untitled')} <small>${escape(j.company || '')} · ${escape(j.status || '')}</small></a>`).join('')}</div>` : ''}
    ${contacts.length ? `<div class="gs-group"><h4>Contacts (${contacts.length})</h4>${contacts.map((c) => `<a class="gs-row" href="#/contacts">👤 ${escape(c.name || 'Unknown')} <small>${escape(c.company || '')}</small></a>`).join('')}</div>` : ''}
    ${companies.length ? `<div class="gs-group"><h4>Companies (${companies.length})</h4>${companies.map((c) => `<a class="gs-row" href="#/companies">🏢 ${escape(c.name || 'Unknown')}</a>`).join('')}</div>` : ''}
    ${notes.length ? `<div class="gs-group"><h4>Notes (${notes.length})</h4>${notes.map((n) => `<a class="gs-row" href="#/notes">🗒 ${escape(n.title || 'Untitled')}</a>`).join('')}</div>` : ''}
  `;
}

async function undoLastAction() {
  const top = peekUndo();
  if (!top) { toast('Nothing to undo.', 'info'); return; }
  const r = await applyUndo(top, send);
  if (r?.ok || r?.action) {
    await popUndo();
    toast(`Undid: ${top.label || top.kind}`, 'success');
    // Refresh affected stores
    const refreshes = ['list-jobs', 'list-documents', 'list-notes', 'list-todos'];
    for (const t of refreshes) {
      const r = await send(t).catch(() => null);
      if (r?.ok) {
        const key = t.replace('list-', '');
        if (key === 'jobs') state.jobs = r.items || [];
        else state[key] = r.items || [];
      }
    }
    render();
  } else {
    toast('Undo failed: ' + (r?.error || ''), 'danger');
  }
}

function offerUndoToast(label, snapshot) {
  pushUndo({ kind: snapshot.kind, label, payload: snapshot.payload });
  // Show a toast with an undo link
  const el = document.createElement('div');
  el.className = 'toast info';
  el.innerHTML = `${escape(label)} <span class="undo-link">Undo</span>`;
  $('#toast').appendChild(el);
  el.querySelector('.undo-link').addEventListener('click', async () => {
    el.remove();
    await undoLastAction();
  });
  setTimeout(() => el.remove(), 8000);
}

function welcomeOverlay() {
  if (state.settings.onboardingDone) return '';
  // Don't render the welcome card while the interactive tour is running — its
  // own overlay would compete with our backdrop and make both feel broken.
  if (document.getElementById('jat-tour-root')) return '';
  // Only show on Dashboard. Avoids the card flashing in during route changes
  // (rapid hashchange during tour, etc.).
  if (state.route !== '/' && state.route !== '') return '';
  return `
    <div class="welcome-overlay" id="welcome-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(8px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px">
      <div class="card" style="max-width:560px;width:100%;padding:32px;border:1px solid var(--primary)">
        <div style="font-size:48px;margin-bottom:8px">👋</div>
        <h1 style="margin:0 0 6px;font-size:24px">Welcome to Job Tracker v8</h1>
        <p style="color:var(--muted);font-size:14px;margin:0 0 20px;line-height:1.6">You're set up with the Chrome extension. Here's what to do next:</p>
        <ol style="margin:0 0 20px 20px;font-size:14px;line-height:1.8;color:var(--text)">
          <li><strong>Connect AI</strong> (optional but powerful). Open <a href="#/ai" style="color:var(--primary)">AI Setup Wizard</a> — defaults to local Ollama with gemma4:e4b.</li>
          <li><strong>Start applying.</strong> Visit a job on LinkedIn, Indeed, Glassdoor, etc. The extension captures it automatically.</li>
          <li><strong>Take the interactive tour.</strong> 60+ steps walk you through every page with animated spotlights.</li>
          <li><strong>Optional: install the desktop app</strong> for durable storage, background scraping, and uninterruptible AI.</li>
        </ol>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn" id="welcome-skip">Skip for now</button>
          <button class="btn primary" id="welcome-tour">🎓 Start the interactive tour</button>
        </div>
      </div>
    </div>
  `;
}

function desktopAppPromoCard() {
  // Only show when desktop sync is offline AND user hasn't dismissed it
  if (state.syncStatus?.connected) return '';
  if (state.settings.dismissedDesktopPromo) return '';
  return `
    <div class="card desktop-promo" style="margin-bottom:14px;padding:18px;background:linear-gradient(135deg,rgba(99,102,241,0.10),rgba(139,92,246,0.06));border:1px solid rgba(99,102,241,0.3)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px">
        <div style="flex:1">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--primary);font-weight:700;margin-bottom:6px">🖥️ OPTIONAL DESKTOP COMPANION</div>
          <h3 style="margin:0 0 6px;font-size:16px">Unlock more with the desktop app</h3>
          <p style="margin:0 0 10px;color:var(--muted);font-size:13px;line-height:1.5">
            The extension works great alone. The desktop app adds: durable SQLite storage (survives Chrome cache wipes), <strong>uninterruptible AI calls</strong>, background folder watching for resumes, and headless source profile sync.
          </p>
          <div style="font-size:12px;color:var(--muted);margin-bottom:12px"><strong>3-step setup:</strong></div>
          <ol style="margin:0 0 12px 20px;font-size:13px;line-height:1.7;color:var(--text)">
            <li>In a terminal: <code style="background:var(--bg);padding:2px 6px;border-radius:4px;font-family:ui-monospace,Consolas,monospace">cd v8/app</code></li>
            <li><code style="background:var(--bg);padding:2px 6px;border-radius:4px;font-family:ui-monospace,Consolas,monospace">npm install</code> (one-time)</li>
            <li><code style="background:var(--bg);padding:2px 6px;border-radius:4px;font-family:ui-monospace,Consolas,monospace">npm start</code> — extension auto-detects within 5s</li>
          </ol>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn primary" id="copy-app-cmd">Copy install commands</button>
            <a class="btn" href="https://nodejs.org/" target="_blank" rel="noreferrer">Need Node.js?</a>
            <button class="btn" id="dismiss-desktop-promo">Dismiss</button>
          </div>
        </div>
        <div style="font-size:48px;opacity:0.5">🖥️</div>
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
      <div style="display:flex;gap:8px"><button class="btn" id="tour-start-btn">🎓 Take the tour</button><button class="btn" id="refresh-recs">🔍 Refresh recommendations</button><button class="btn primary" id="ai-nudges">✨ AI nudges</button></div>
    </div>
    ${desktopAppPromoCard()}
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

    ${activityHeatmapHtml()}

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
  const sort = state.jobsSort || { key: 'updatedAt', dir: 'desc' };
  const quick = state.jobsQuickFilter || null;
  const pinnedIds = new Set(state.settings.pinnedJobs || []);
  const ACTIVE_STATUSES = new Set(['discovered', 'started', 'submitted', 'received', 'reviewing', 'recruiter_replied']);
  const INTERVIEW_STATUSES = new Set(['interview', 'assessment']);
  const oneWeekAgo = Date.now() - 7 * 86400000;

  const filtered = state.jobs.filter((j) => {
    if (state.filter.status !== 'all' && j.status !== state.filter.status) return false;
    if (state.filter.source !== 'all' && (j.source || 'Unknown') !== state.filter.source) return false;
    if (state.filter.search) {
      const q = state.filter.search.toLowerCase();
      const hay = `${j.title} ${j.company} ${j.location}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (quick === 'active' && !ACTIVE_STATUSES.has(j.status)) return false;
    if (quick === 'interviewing' && !INTERVIEW_STATUSES.has(j.status)) return false;
    if (quick === 'week' && new Date(j.updatedAt || 0).getTime() < oneWeekAgo) return false;
    if (quick === 'followup' && !j.followUpDate) return false;
    return true;
  }).sort((a, b) => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    const av = (a[sort.key] || '').toString();
    const bv = (b[sort.key] || '').toString();
    return av.localeCompare(bv) * dir;
  });
  const pinnedRows = filtered.filter((j) => pinnedIds.has(j.id));
  const otherRows = filtered.filter((j) => !pinnedIds.has(j.id));

  const savedViews = state.settings.savedViews || [];
  const selected = state.jobsSelected || new Set();
  const selectable = state.jobsMulti || false;
  const density = state.settings.density || 'comfortable';

  const headerExtras = `
    <div style="display:flex;gap:8px;align-items:center">
      <div class="density-toggle" data-density-toggle>
        <button data-d="compact" class="${density==='compact'?'on':''}" title="Compact">▤</button>
        <button data-d="comfortable" class="${density==='comfortable'?'on':''}" title="Comfortable">▦</button>
        <button data-d="spacious" class="${density==='spacious'?'on':''}" title="Spacious">▣</button>
      </div>
      <button class="btn small" id="toggle-light-dark" title="Toggle dark / light">🌓</button>
      <button class="btn small" id="toggle-multi">${selectable ? '✓ Selecting' : '☐ Select'}</button>
    </div>`;

  const chipRow = `
    <div class="chip-row">
      <span class="chip ${!quick?'active':''}" data-quick="">All</span>
      <span class="chip ${quick==='active'?'active':''}" data-quick="active">Active</span>
      <span class="chip ${quick==='interviewing'?'active':''}" data-quick="interviewing">Interviewing</span>
      <span class="chip ${quick==='week'?'active':''}" data-quick="week">This week</span>
      <span class="chip ${quick==='followup'?'active':''}" data-quick="followup">Has follow-up</span>
      ${savedViews.map((v, i) => `<span class="chip" data-view="${i}" title="Saved view">★ ${escape(v.name)}</span>`).join('')}
      <span class="chip" id="save-view" title="Save current filter as view">＋ Save view</span>
    </div>`;

  const batch = (selectable && selected.size > 0) ? `
    <div class="batch-toolbar">
      <strong>${selected.size} selected</strong>
      <button class="btn small" data-batch="archive">Archive</button>
      <button class="btn small" data-batch="status">Change status…</button>
      <button class="btn small" data-batch="export">Export</button>
      <button class="btn small danger" data-batch="delete">Delete</button>
      <span style="flex:1"></span>
      <button class="btn small" data-batch="clear">Clear</button>
    </div>` : '';

  const sortHeader = `
    <div class="sortable-h">
      <button data-sort="title" class="${sort.key==='title'?'sort-active':''}">Title ${sortArrow(sort, 'title')}</button>
      <button data-sort="company" class="${sort.key==='company'?'sort-active':''}">Company ${sortArrow(sort, 'company')}</button>
      <button data-sort="status" class="${sort.key==='status'?'sort-active':''}">Status ${sortArrow(sort, 'status')}</button>
      <button data-sort="updatedAt" class="${sort.key==='updatedAt'?'sort-active':''}">Updated ${sortArrow(sort, 'updatedAt')}</button>
    </div>`;

  return `
    <div class="page-h">
      <div><h1>Applications</h1><div class="sub">${filtered.length} of ${state.jobs.length}</div></div>
      ${headerExtras}
    </div>
    ${chipRow}
    ${batch}
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
      ${filtered.length === 0 ? emptyStateJobs() : `
        ${sortHeader}
        ${pinnedRows.length ? `<div style="font-size:11px;color:var(--muted);margin:8px 0 4px;text-transform:uppercase;letter-spacing:0.06em">📌 Pinned</div><div class="list stagger">${pinnedRows.map((j) => rowHtmlExt(j, selectable, selected, true)).join('')}</div>` : ''}
        <div class="list stagger" style="${pinnedRows.length?'margin-top:10px':''}">${otherRows.map((j) => rowHtmlExt(j, selectable, selected, false)).join('')}</div>
      `}
    </div>
  `;
}

function sortArrow(sort, key) { return sort.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : ''; }

function rowHtmlExt(j, selectable, selected, isPinned) {
  const checked = selected && selected.has(j.id);
  const cb = selectable ? `<input type="checkbox" class="row-check" data-job="${escape(j.id)}" ${checked?'checked':''} />` : '';
  return `<div class="list-row card lift ${selectable?'selectable':''}" data-job="${escape(j.id)}">
    ${cb}
    <div>
      <div class="t">${isPinned ? '📌 ' : ''}${escape(j.title || 'Untitled')}</div>
      <div class="s">${escape(j.company || '')}${j.location ? ' · ' + escape(j.location) : ''}</div>
    </div>
    <span class="pill source">${escape(j.source || 'Manual')}</span>
    <span class="pill ${j.status}">${STATUS_LABELS[j.status] || j.status}</span>
  </div>`;
}

function emptyStateJobs() {
  return `<div class="empty">
    ${emptySvg()}
    <strong>No applications yet</strong>
    <p style="margin:6px 0 12px">Visit a job posting on LinkedIn, Indeed, or Glassdoor to capture it automatically.</p>
    <div style="display:flex;gap:8px;justify-content:center">
      <a class="btn primary" href="https://www.linkedin.com/jobs" target="_blank">Browse LinkedIn jobs</a>
      <a class="btn" href="#/sources">View sources</a>
    </div>
  </div>`;
}

function emptySvg() {
  return `<svg class="empty-svg" width="120" height="120" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="20" y="30" width="80" height="70" rx="10" stroke="var(--primary)" />
    <line x1="20" y1="48" x2="100" y2="48" stroke="var(--border)" />
    <circle cx="32" cy="39" r="2.5" fill="var(--primary)" stroke="none" />
    <circle cx="42" cy="39" r="2.5" fill="var(--primary2)" stroke="none" />
    <line x1="32" y1="62" x2="78" y2="62" stroke="var(--muted)" />
    <line x1="32" y1="72" x2="62" y2="72" stroke="var(--muted)" />
    <line x1="32" y1="82" x2="70" y2="82" stroke="var(--muted)" />
  </svg>`;
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
        <h2 class="inline-edit" data-field="title" title="Click to edit">${escape(j.title || 'Untitled')}</h2>
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
        <textarea id="d-notes" data-ai-ghost>${escape(j.notes)}</textarea>
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
      <h3 style="margin-top:0;font-size:14px;display:flex;justify-content:space-between;align-items:center">
        <span>Quick actions</span>
      </h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn small" id="job-clone" data-job-id="${escape(j.id)}">📑 Duplicate</button>
        <button class="btn small" id="job-template" data-job-id="${escape(j.id)}">📋 Save as template</button>
        <button class="btn small" id="job-toggle-archive" data-job-id="${escape(j.id)}">${j.autoArchiveOptOut ? '🔒 Re-enable auto-archive' : '🔓 Opt out of auto-archive'}</button>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <h3 style="margin-top:0;font-size:14px">📜 Activity timeline</h3>
      ${(j.timeline || []).length === 0 ? `<div class="empty">No activity recorded yet.</div>` : `
        <div class="timeline">
          ${[...(j.timeline || [])].reverse().map((ev) => `
            <div class="timeline-event">
              <span></span>
              <span><strong style="font-size:12px">${escape(ev.summary || ev.type || 'event')}</strong> <small>${escape(ev.source || '')}</small></span>
              <small>${escape(new Date(ev.timestamp).toLocaleString())}</small>
            </div>
          `).join('')}
        </div>
      `}
    </div>

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

const SOURCE_PROFILE_URLS = {
  LinkedIn: 'https://www.linkedin.com/in/me/',
  Indeed: 'https://profile.indeed.com/',
  Glassdoor: 'https://www.glassdoor.com/member/profile/index.htm',
};

function pageProfile() {
  const p = state.profile;
  const ans = state.answers || [];
  const named = state.namedProfiles || [];
  return `
    <div class="page-h">
      <div><h1>Profile &amp; Answers</h1><div class="sub">Used for AI features and universal autofill across all sites. Your custom answers are auto-learned as you apply.</div></div>
      <div style="display:flex;gap:8px">
        <button class="btn primary" id="p-save">Save default profile</button>
        ${state.aiStatus?.available ? `<button class="btn" id="p-resume">✨ Parse resume with AI</button>` : ''}
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-top:0;font-size:14px">🌐 Sync profile from a source</h3>
      <p style="color:var(--muted);font-size:13px;margin:0 0 10px">Open a source profile page — when you're signed in, a green "Sync this profile" prompt appears in the top-right. It captures your name, headline, location, summary, and skills as a new named profile.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${Object.entries(SOURCE_PROFILE_URLS).map(([src, url]) => `<a class="btn" href="${escape(url)}" target="_blank" rel="noreferrer">Open ${escape(src)} →</a>`).join('')}
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-top:0;font-size:14px">📇 Named profiles <span style="font-weight:400;color:var(--muted);font-size:12px">${named.length} saved</span></h3>
      <p style="color:var(--muted);font-size:13px;margin:0 0 10px">Create multiple profiles (e.g., "Senior eng", "Career switch") and assign each to a specific source. The autofill engine uses the assigned profile when you apply on that source.</p>
      ${named.length === 0 ? `<div class="empty" style="margin-bottom:10px">No named profiles yet. Create one below or sync from a source above.</div>` : `
        <div style="display:flex;flex-direction:column;gap:6px">
          ${named.map((np) => `
            <div style="display:grid;grid-template-columns:1fr auto auto auto;gap:10px;padding:10px;border:1px solid var(--border);border-radius:8px;align-items:center">
              <div>
                <div style="font-weight:600">${escape(np.name)}${np.isDefault ? ' <span class="pill source" style="margin-left:6px">default</span>' : ''}</div>
                <div style="color:var(--muted);font-size:12px">${escape(np.data?.firstName || '')} ${escape(np.data?.lastName || '')} · ${escape(np.data?.email || '')}</div>
                <div style="color:var(--muted);font-size:11px;margin-top:2px">Assigned to: ${Object.keys(np.sourceAssignments || {}).join(', ') || '— none —'}</div>
              </div>
              <select data-np-assign="${escape(np.id)}" style="min-width:130px">
                <option value="">+ Assign source…</option>
                ${['LinkedIn','Indeed','Glassdoor','Greenhouse','Lever','Workday'].map((s) => `<option value="${s}">${s}</option>`).join('')}
              </select>
              <button class="btn small" data-np-default="${escape(np.id)}" ${np.isDefault ? 'disabled' : ''}>Set default</button>
              <button class="btn small danger" data-np-delete="${escape(np.id)}">Delete</button>
            </div>
          `).join('')}
        </div>
      `}
      <div style="margin-top:10px;display:flex;gap:8px">
        <button class="btn" id="np-new-from-default">+ New profile from default</button>
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
  const u = state.updateInfo || {};
  const a = state.appUpdateInfo || {};
  const checkedAt = u.checkedAt ? new Date(u.checkedAt).toLocaleString() : 'never';
  const aCheckedAt = a.checkedAt ? new Date(a.checkedAt).toLocaleString() : 'never';
  const appReachable = state.appHealth?.ok || a.current;
  return `
    <div class="page-h"><div><h1>Settings</h1><div class="sub">Themes, AI providers, follow-ups, notifications.</div></div></div>

    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-top:0;font-size:14px">⬆️ Updates</h3>

      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding-bottom:12px;border-bottom:1px solid var(--border)">
        <div style="flex:1;min-width:200px">
          <div style="font-size:13px">
            <strong>🧩 Extension</strong>:
            v${escape(chrome.runtime.getManifest().version)}
            ${u.hasUpdate ? `<span class="pill" style="background:#ef4444;color:#fff;margin-left:6px">Update available → v${escape(u.latest)}</span>` : (u.latest ? `<span class="pill" style="background:rgba(16,185,129,0.18);color:#10b981;margin-left:6px">Up to date</span>` : '')}
          </div>
          <div class="s" style="font-size:11px;color:var(--muted);margin-top:2px">Last checked: ${escape(checkedAt)}</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn" id="check-update-btn">Check now</button>
          ${u.hasUpdate ? `<a class="btn primary" href="${escape(u.url || '#')}" target="_blank" rel="noreferrer">Download v${escape(u.latest)}</a>` : ''}
        </div>
      </div>

      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding-top:12px">
        <div style="flex:1;min-width:200px">
          <div style="font-size:13px">
            <strong>🖥️ Desktop app</strong>:
            ${appReachable ? `v${escape(a.current || '?')}` : `<span style="color:var(--muted)">not running</span>`}
            ${a.hasUpdate ? `<span class="pill" style="background:#ef4444;color:#fff;margin-left:6px">Update available → v${escape(a.latest)}</span>` : (a.current && a.latest ? `<span class="pill" style="background:rgba(16,185,129,0.18);color:#10b981;margin-left:6px">Up to date</span>` : '')}
            ${a.downloaded ? `<span class="pill" style="background:rgba(99,102,241,0.18);color:#6366f1;margin-left:6px">Downloaded — ready to install</span>` : (a.hasUpdate && a.downloadProgress > 0 ? `<span class="s" style="margin-left:6px;font-size:11px;color:var(--muted)">${a.downloadProgress}% downloaded…</span>` : '')}
          </div>
          <div class="s" style="font-size:11px;color:var(--muted);margin-top:2px">Last checked: ${escape(aCheckedAt)}</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn" id="check-app-update-btn" ${appReachable ? '' : 'disabled'}>Check now</button>
          ${a.hasUpdate && !a.downloaded ? `<button class="btn primary" id="trigger-app-update-btn">⬇ Download update</button>` : ''}
          ${a.downloaded ? `<button class="btn primary" id="install-app-update-btn">🚀 Install &amp; restart</button>` : ''}
        </div>
      </div>
      ${!appReachable ? `<div class="s" style="font-size:11px;color:var(--muted);margin-top:8px">Launch the desktop app to enable update controls (or <a href="#/install-app" style="color:var(--primary)">install it</a>).</div>` : ''}
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-top:0;font-size:14px">🧭 Sidebar</h3>
      <p style="margin:0 0 10px;font-size:12px;color:var(--muted)">
        Reset the sidebar back to the strict job-tracker minimum (10 visible pages: Dashboard, Applications, Pipeline, Calendar, Reminders, Inbox, Profile, Documents, Install desktop app, Settings). All other pages are still one click away under "+ Add a page" in the sidebar footer.
      </p>
      <button class="btn" id="reset-sidebar-btn">Reset sidebar to defaults</button>
    </div>

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
      <h3 style="margin-top:0;font-size:14px">📐 Sidebar customization</h3>
      <div style="display:flex;flex-direction:column;gap:10px;font-size:13px">
        <label style="display:flex;align-items:center;gap:10px">
          <input type="number" id="sidebar-sync-interval" min="1" max="120" value="${s.syncIntervalSeconds || 5}" style="width:80px;padding:6px;border-radius:6px;background:var(--bg2);color:var(--text);border:1px solid var(--border)">
          <span>Sync probe interval (seconds)</span>
        </label>
        <div>
          <strong>Pinned pages:</strong>
          <span style="color:var(--muted)">${(s.sidebarPinned || []).length ? (s.sidebarPinned).join(', ') : '(none)'}</span>
        </div>
        <div>
          <strong>Hidden pages:</strong>
          <span style="color:var(--muted)">${(s.sidebarHidden || []).length ? (s.sidebarHidden).join(', ') : '(none)'}</span>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn" id="settings-sidebar-reset">Reset sidebar to defaults</button>
        </div>
        <div style="color:var(--muted);font-size:11px">Use the ⋮ menu on each sidebar page to pin / hide / move. Drag pages to reorder. Press Cmd/Ctrl+K for the command palette.</div>
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
              <a class="btn small" id="wiz-download-setup-win" href="${chrome.runtime.getURL('setup/install-ollama-windows.ps1')}" download="install-ollama-windows.ps1">⬇ Windows (.ps1)</a>
              <a class="btn small" id="wiz-download-setup-mac" href="${chrome.runtime.getURL('setup/install-ollama-mac.sh')}" download="install-ollama-mac.sh">⬇ macOS (.sh)</a>
              <a class="btn small" id="wiz-download-setup-linux" href="${chrome.runtime.getURL('setup/install-ollama-linux.sh')}" download="install-ollama-linux.sh">⬇ Linux (.sh)</a>
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

  $('#tour-start-btn')?.addEventListener('click', async () => {
    const startAt = state.settings?.tourLastStep && !state.settings?.tourCompleted ? state.settings.tourLastStep : 0;
    // Mark onboarding as done so the welcome overlay never re-injects during the
    // tour's repeated hash-driven re-renders. The welcome overlay also self-checks
    // for the tour root, but this is belt-and-suspenders.
    if (!state.settings.onboardingDone) {
      state.settings.onboardingDone = true;
      send('patch-settings', { onboardingDone: true });
      $('#welcome-overlay')?.remove();
    }
    try {
      const [tourMod, stepsMod] = await Promise.all([
        import('../lib/tour.js'),
        import('../lib/tour-steps.js')
      ]);
      const steps = stepsMod.buildDefaultTour();
      const tour = new tourMod.Tour({
        steps,
        startAt,
        reducedMotion: !!state.settings?.reducedMotion,
        onAdvance: (i) => { send('patch-settings', { tourLastStep: i }); },
        onFinish: () => { send('patch-settings', { tourCompleted: true, tourLastStep: 0 }); toast('🎉 Tour complete!', 'success'); }
      });
      tour.start();
    } catch (e) {
      toast('Tour failed to load: ' + (e.message || e), 'danger');
    }
  });

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
  // Quick filter chips
  $$('.chip[data-quick]').forEach((c) => c.addEventListener('click', () => { state.jobsQuickFilter = c.dataset.quick || null; render(); }));
  $$('.chip[data-view]').forEach((c) => c.addEventListener('click', () => {
    const v = (state.settings.savedViews || [])[Number(c.dataset.view)]; if (!v) return;
    state.filter = { ...state.filter, ...(v.filter || {}) };
    state.jobsQuickFilter = v.quick || null;
    if (v.sort) state.jobsSort = v.sort;
    render();
  }));
  $('#save-view')?.addEventListener('click', async () => {
    const name = prompt('Name this view'); if (!name) return;
    const v = { name, filter: { status: state.filter.status, source: state.filter.source, search: state.filter.search }, quick: state.jobsQuickFilter, sort: state.jobsSort };
    const list = [...(state.settings.savedViews || []), v];
    await patchAppSettings({ savedViews: list });
    toast('Saved view: ' + name, 'success');
  });
  // Sortable headers
  $$('.sortable-h button[data-sort]').forEach((b) => b.addEventListener('click', () => {
    const key = b.dataset.sort;
    const cur = state.jobsSort || { key: 'updatedAt', dir: 'desc' };
    state.jobsSort = (cur.key === key) ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
    render();
  }));
  // Multi-select toggle
  $('#toggle-multi')?.addEventListener('click', () => {
    state.jobsMulti = !state.jobsMulti;
    if (!state.jobsMulti) state.jobsSelected = new Set();
    render();
  });
  $$('.row-check').forEach((cb) => cb.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.jobsSelected) state.jobsSelected = new Set();
    if (cb.checked) state.jobsSelected.add(cb.dataset.job); else state.jobsSelected.delete(cb.dataset.job);
    render();
  }));
  $$('.batch-toolbar [data-batch]').forEach((b) => b.addEventListener('click', async () => {
    const act = b.dataset.batch;
    const ids = Array.from(state.jobsSelected || []);
    if (act === 'clear') { state.jobsSelected = new Set(); render(); return; }
    if (act === 'delete') {
      if (!confirm(`Delete ${ids.length} application(s)?`)) return;
      for (const id of ids) await send('delete-job', { id });
      state.jobsSelected = new Set(); toast('Deleted ' + ids.length, 'success'); return;
    }
    if (act === 'archive') {
      for (const id of ids) await send('patch-job', { id, patch: { status: 'archived' } });
      state.jobsSelected = new Set(); toast('Archived ' + ids.length, 'success'); return;
    }
    if (act === 'status') {
      const next = prompt('New status (' + STATUSES.join(', ') + ')');
      if (!next || !STATUSES.includes(next)) return;
      for (const id of ids) await send('patch-job', { id, patch: { status: next } });
      state.jobsSelected = new Set(); toast('Updated ' + ids.length, 'success'); return;
    }
    if (act === 'export') {
      const data = state.jobs.filter((j) => state.jobsSelected.has(j.id));
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'jobs-export.json'; a.click();
    }
  }));
  // Density toggle
  $$('.density-toggle button[data-d]').forEach((b) => b.addEventListener('click', () => {
    patchAppSettings({ density: b.dataset.d });
  }));
  // Light/dark cycle button
  $('#toggle-light-dark')?.addEventListener('click', () => toggleLightDark());
  // Right-click context menu on list rows
  $$('.list-row[data-job]').forEach((row) => {
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openListContextMenu(e.clientX, e.clientY, row.dataset.job);
    });
  });

  // Detail
  $$('.pipeline button').forEach((b) => b.addEventListener('click', async () => {
    const newStatus = b.dataset.status;
    const r = await send('patch-job', { id: state.selectedJobId, patch: { status: newStatus } });
    if (r?.ok) {
      toast('Status updated.', 'success');
      if (newStatus === 'offer') confetti();
      // Pulse the pill
      setTimeout(() => window.__jatPulsePill && window.__jatPulsePill(state.selectedJobId), 50);
    }
  }));
  // Inline edit on detail fields — click to edit, blur to save
  $$('.inline-edit').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.classList.contains('editing')) return;
      el.classList.add('editing');
      el.contentEditable = 'true';
      el.focus();
    });
    el.addEventListener('blur', async () => {
      el.classList.remove('editing');
      el.contentEditable = 'false';
      const field = el.dataset.field;
      const val = el.textContent.trim();
      if (field && state.selectedJobId) {
        await send('patch-job', { id: state.selectedJobId, patch: { [field]: val } });
        toast('Saved', 'success', 1500);
      }
    });
  });
  // Inline AI ghost text in textareas marked data-ai-ghost
  $$('textarea[data-ai-ghost]').forEach((ta) => attachGhostText(ta));
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
    const j = state.jobs.find((x) => x.id === state.selectedJobId);
    await send('delete-job', { id: state.selectedJobId });
    if (j) offerUndoToast(`Deleted "${j.title}"`, { kind: 'job.delete', payload: { job: j } });
    else toast('Deleted.', 'success');
    location.hash = '#/jobs';
  });
  // Clone / template / auto-archive opt-out buttons
  $('#job-clone')?.addEventListener('click', async () => {
    const j = state.jobs.find((x) => x.id === state.selectedJobId);
    if (!j) return;
    const r = await send('capture', {
      title: j.title, company: j.company, location: j.location, jobUrl: j.jobUrl,
      description: j.description, compensation: j.compensation, workMode: j.workMode,
      employmentType: j.employmentType, source: j.source, status: 'discovered',
      tags: [...(j.tags || []), 'clone'],
      _source: 'clone'
    });
    if (r?.ok) toast(`Duplicated "${j.title}".`, 'success');
    else toast('Clone failed.', 'danger');
  });
  $('#job-template')?.addEventListener('click', async () => {
    const j = state.jobs.find((x) => x.id === state.selectedJobId);
    if (!j) return;
    const name = prompt('Template name:', j.title || 'Job template');
    if (!name) return;
    const r = await send('add-templates', {
      name, title: j.title, description: j.description,
      tags: j.tags || [], industry: j.industry, source: j.source
    });
    if (r?.ok) toast(`Saved template "${name}".`, 'success');
  });
  $('#job-toggle-archive')?.addEventListener('click', async () => {
    const j = state.jobs.find((x) => x.id === state.selectedJobId);
    if (!j) return;
    const r = await send('patch-job', { id: j.id, patch: { autoArchiveOptOut: !j.autoArchiveOptOut } });
    if (r?.ok) toast(j.autoArchiveOptOut ? 'Auto-archive re-enabled.' : 'Opted out of auto-archive.', 'success');
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
  // Named profiles
  $('#np-new-from-default')?.addEventListener('click', async () => {
    const name = prompt('Profile name (e.g., "Senior eng", "Career switch"):', 'New profile');
    if (!name) return;
    const r = await send('create-named-profile', { name, data: { ...state.profile }, sourceAssignments: {} });
    if (r?.ok) { toast('Created.', 'success'); }
  });
  $$('[data-np-default]').forEach((b) => b.addEventListener('click', async () => {
    await send('patch-named-profile', { id: b.dataset.npDefault, patch: { isDefault: true } });
    toast('Default updated.', 'success');
  }));
  $$('[data-np-delete]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this profile?')) return;
    await send('delete-named-profile', { id: b.dataset.npDelete });
    toast('Deleted.', 'success');
  }));
  $$('[data-np-assign]').forEach((sel) => sel.addEventListener('change', async () => {
    const npId = sel.dataset.npAssign;
    const src = sel.value;
    if (!src) return;
    const np = state.namedProfiles.find((p) => p.id === npId);
    if (!np) return;
    const next = { ...(np.sourceAssignments || {}), [src]: npId };
    await send('patch-named-profile', { id: npId, patch: { sourceAssignments: next } });
    toast(`Assigned to ${src}.`, 'success');
    sel.value = '';
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
  // v8.0.7: Reset sidebar button
  $('#reset-sidebar-btn')?.addEventListener('click', async (e) => {
    if (!confirm('Reset the sidebar to the job-tracker minimum (10 visible pages)? Hidden pages can be re-added at any time via "+ Add a page".')) return;
    const btn = e.currentTarget;
    btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Resetting…';
    try {
      const r = await send('reset-sidebar');
      if (r?.ok) {
        state.settings = r.settings;
        toast('Sidebar reset to defaults.', 'success');
        render();
      } else { toast('Reset failed.', 'danger'); }
    } finally { btn.disabled = false; btn.textContent = orig; }
  });

  // v8.0.2: Manual "Check for updates" button (extension)
  $('#check-update-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Checking…';
    try {
      const r = await send('check-extension-update');
      if (r?.ok) {
        state.updateInfo = { current: r.current, latest: r.latest, hasUpdate: r.hasUpdate, checkedAt: Date.now(), url: r.url };
        toast(r.hasUpdate ? `New version available: v${r.latest}` : `Up to date (v${r.current})`, 'success');
        render();
      } else {
        toast(`Check failed: ${r?.error || 'unknown'}`, 'danger');
      }
    } finally { btn.disabled = false; btn.textContent = orig; }
  });
  // v8.0.5: Desktop app update controls
  $('#check-app-update-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Checking…';
    try {
      const r = await send('check-app-update');
      if (r?.ok) {
        state.appUpdateInfo = { current: r.current, latest: r.latest, hasUpdate: r.hasUpdate, downloaded: r.downloaded, downloadProgress: r.downloadProgress, checkedAt: Date.now() };
        toast(r.hasUpdate ? `Desktop app update available: v${r.latest}` : `Desktop app up to date (v${r.current})`, 'success');
        render();
      } else {
        toast(`Check failed: ${r?.error || 'unknown'}`, 'danger');
      }
    } finally { btn.disabled = false; btn.textContent = orig; }
  });
  $('#trigger-app-update-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Starting download…';
    try {
      const r = await send('trigger-app-update-check');
      if (r?.ok) {
        toast(r.available ? `Downloading v${r.version}… The app will show a Restart prompt when ready.` : 'No update available.', 'success', 6000);
        // Re-check status in a moment
        setTimeout(() => send('check-app-update').then(() => { /* broadcast triggers render */ }), 2000);
      } else {
        toast(`Failed: ${r?.error || 'unknown'}`, 'danger');
      }
    } finally { btn.disabled = false; btn.textContent = orig; }
  });
  $('#install-app-update-btn')?.addEventListener('click', async (e) => {
    if (!confirm('The desktop app will quit and re-launch with the new version. Continue?')) return;
    const btn = e.currentTarget;
    btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Restarting…';
    try {
      const r = await send('install-app-update');
      if (r?.ok) {
        toast('Desktop app is restarting with the new version. ✨', 'success', 6000);
      } else {
        toast(`Install failed: ${r?.error || 'unknown'}`, 'danger');
        btn.disabled = false; btn.textContent = orig;
      }
    } catch (err) { btn.disabled = false; btn.textContent = orig; }
  });
  // Settings — sidebar customization
  $('#settings-sidebar-reset')?.addEventListener('click', async () => {
    await patchAppSettings({ sidebarOrder: [], sidebarHidden: [], sidebarPinned: [], sectionOverrides: {} });
    toast('Sidebar reset to defaults.', 'success');
  });
  $('#sidebar-sync-interval')?.addEventListener('change', async (e) => {
    const n = Math.max(1, Math.min(120, Number(e.target.value) || 5));
    await patchAppSettings({ syncIntervalSeconds: n });
    toast(`Sync probe interval set to ${n}s.`, 'success');
  });

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
  $('#dismiss-desktop-promo')?.addEventListener('click', async () => {
    await send('patch-settings', { dismissedDesktopPromo: true });
    state.settings.dismissedDesktopPromo = true;
    toast('Hidden. Re-enable in Settings → Sync.', 'info');
    render();
  });
  $('#copy-app-cmd')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText('cd v8/app && npm install && npm start');
      toast('Commands copied. Paste into a terminal.', 'success');
    } catch { toast('Copy failed — copy manually from the card.', 'danger'); }
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
    if (url) chrome.tabs.create({ url });
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
      // (chrome.tabs.create opens a tab that can't reach our blob URL → fails to load)
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

function toast(msg, kind = 'info', life = 3000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.style.setProperty('--toast-life', life + 'ms');
  el.innerHTML = `<span></span><span class="toast-progress"></span>`;
  el.firstChild.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => { el.style.animation = 'slide-down-out var(--motion-base) var(--ease-out) forwards'; setTimeout(() => el.remove(), 220); }, life);
}

// Animated theme transition: fade overlay, swap, fade out.
function fadedApplyTheme(id) {
  if (document.body.classList.contains('reduced-motion')) { applyTheme(id); return; }
  let ov = document.querySelector('.theme-fade-overlay');
  if (!ov) { ov = document.createElement('div'); ov.className = 'theme-fade-overlay'; document.body.appendChild(ov); }
  ov.classList.add('on');
  setTimeout(() => { applyTheme(id); ov.classList.remove('on'); setTimeout(() => ov.remove(), 220); }, 100);
}

// Confetti burst — 30 staggered spans dropping from top.
function confetti(durationMs = 2400) {
  if (document.body.classList.contains('reduced-motion')) return;
  const host = document.createElement('div');
  host.className = 'confetti-host';
  for (let i = 0; i < 30; i++) {
    const s = document.createElement('span');
    s.style.left = (Math.random() * 100) + '%';
    s.style.setProperty('--cx', (Math.random() * 200 - 100) + 'px');
    s.style.animationDelay = (Math.random() * 400) + 'ms';
    s.style.animationDuration = (1800 + Math.random() * 1200) + 'ms';
    host.appendChild(s);
  }
  document.body.appendChild(host);
  setTimeout(() => host.remove(), durationMs + 600);
}
window.__jatConfetti = confetti;

// Inline AI ghost text — debounce keystrokes, ask AI for completion, render
// faded suggestion. Tab accepts. Gracefully no-ops when AI unavailable.
function attachGhostText(ta) {
  if (!ta || ta.dataset.ghostAttached) return;
  ta.dataset.ghostAttached = '1';
  const wrap = document.createElement('div'); wrap.className = 'ghost-wrap';
  ta.parentNode.insertBefore(wrap, ta);
  wrap.appendChild(ta);
  const ghost = document.createElement('div'); ghost.className = 'ghost-text';
  wrap.appendChild(ghost);
  let timer = null; let suggestion = '';
  function paint() {
    ghost.textContent = ta.value + (suggestion || '');
    ghost.firstChild && ghost.firstChild.remove?.();
  }
  ta.addEventListener('input', () => {
    suggestion = ''; paint();
    clearTimeout(timer);
    if (!state.aiStatus?.available) return;
    timer = setTimeout(async () => {
      const text = ta.value;
      if (text.length < 6) return;
      try {
        const r = await aiCall({ feature: 'complete', text });
        if (r?.ok && typeof r.result === 'string') { suggestion = r.result.slice(0, 200); paint(); }
      } catch {}
    }, 700);
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && suggestion) {
      e.preventDefault();
      ta.value += suggestion;
      suggestion = '';
      paint();
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (e.key === 'Escape') { suggestion = ''; paint(); }
  });
}

// Right-click menu on a job row.
function openListContextMenu(x, y, jobId) {
  document.querySelectorAll('.ctx-menu').forEach((n) => n.remove());
  const job = state.jobs.find((j) => j.id === jobId); if (!job) return;
  const pinned = new Set(state.settings.pinnedJobs || []);
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = Math.min(window.innerWidth - 200, x) + 'px';
  menu.style.top = Math.min(window.innerHeight - 240, y) + 'px';
  menu.innerHTML = `
    <button data-act="open">Open</button>
    <button data-act="newtab">Open in new tab</button>
    <div class="sep"></div>
    <button data-act="pin">${pinned.has(jobId) ? 'Unpin' : 'Pin'}</button>
    <button data-act="archive">Archive</button>
    <button data-act="copy">Copy URL</button>
    <div class="sep"></div>
    <button data-act="delete">Delete</button>
  `;
  document.body.appendChild(menu);
  const close = () => { menu.remove(); document.removeEventListener('mousedown', onDoc, true); };
  const onDoc = (e) => { if (!menu.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
  menu.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
    const act = b.dataset.act;
    if (act === 'open') location.hash = '#/job/' + jobId;
    else if (act === 'newtab') window.open(location.origin + location.pathname + '#/job/' + jobId, '_blank');
    else if (act === 'pin') {
      const next = new Set(pinned); if (next.has(jobId)) next.delete(jobId); else next.add(jobId);
      await patchAppSettings({ pinnedJobs: Array.from(next) });
    } else if (act === 'archive') {
      await send('patch-job', { id: jobId, patch: { status: 'archived' } });
      toast('Archived', 'success');
    } else if (act === 'copy') {
      const url = job.jobUrl || (location.origin + location.pathname + '#/job/' + jobId);
      try { await navigator.clipboard.writeText(url); toast('URL copied', 'success'); } catch { toast('Copy failed', 'danger'); }
    } else if (act === 'delete') {
      if (confirm('Delete this application?')) { await send('delete-job', { id: jobId }); toast('Deleted', 'success'); }
    }
    close();
  }));
}

// Drag-drop file upload — overlay shown when files dragged anywhere on Documents.
function attachGlobalDropZone() {
  let depth = 0;
  let overlay = null;
  function show() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'drop-overlay';
    overlay.innerHTML = '📁 Drop files anywhere to upload';
    document.body.appendChild(overlay);
  }
  function hide() { overlay && overlay.remove(); overlay = null; }
  document.addEventListener('dragenter', (e) => {
    if (state.route !== '/documents') return;
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    depth++; show();
  });
  document.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (depth === 0) hide(); });
  document.addEventListener('dragover', (e) => { if (overlay) e.preventDefault(); });
  document.addEventListener('drop', async (e) => {
    if (!overlay) return;
    e.preventDefault(); depth = 0; hide();
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        await send('add-document', { doc: { name: f.name, originalFilename: f.name, mimeType: f.type, type: 'other', data: Array.from(new Uint8Array(buf)) } });
      } catch (err) { console.error(err); }
    }
    toast('Uploaded ' + files.length + ' file(s)', 'success');
  });
}

// Status pill change pulse. Call after a status update on a row.
window.__jatPulsePill = function pulsePill(jobId) {
  document.querySelectorAll(`.list-row[data-job="${jobId}"] .pill, .pipeline button.current`).forEach((p) => {
    p.classList.remove('changed');
    void p.offsetWidth;
    p.classList.add('changed');
  });
};

// One-line onboarding tip per page on first visit. Anchored to .page-h.
const TIPS = {
  '/':         'This is your home — daily nudges, recent activity, and quick stats.',
  '/jobs':     'Every application across every source. Use quick filters or saved views.',
  '/pipeline': 'Drag cards across columns to update status. Drag column headers to reorder.',
  '/calendar': 'Interviews, follow-ups, and deadlines on one calendar.',
  '/profile':  'Your master profile. Add named profiles for different role types.',
  '/documents':'Drop files anywhere on this page to upload.',
  '/contacts': 'Right-click any contact for actions like Star or Archive.',
  '/settings': 'Themes, density, AI providers, and customization live here.',
};
// v8: track session-scope dismissals so re-renders during the same session
// don't keep re-injecting the tip even before settings.seenTips persists.
const _dismissedTipsThisSession = new Set();
let _tipTimer = null;
function maybeShowOnboardingTip() {
  const tip = TIPS[state.route]; if (!tip) return;
  const seen = state.settings.seenTips || {};
  if (seen[state.route]) return;
  if (_dismissedTipsThisSession.has(state.route)) return;
  // Already an open tip for this route? Don't spawn another.
  if (document.querySelector('.tip-bubble[data-tip-route="' + state.route + '"]')) return;
  // Coalesce repeated render calls — only show once they settle.
  if (_tipTimer) clearTimeout(_tipTimer);
  _tipTimer = setTimeout(() => {
    _tipTimer = null;
    // Re-check after the debounce — route may have changed, or user dismissed.
    if (_dismissedTipsThisSession.has(state.route)) return;
    if ((state.settings.seenTips || {})[state.route]) return;
    if (document.querySelector('.tip-bubble[data-tip-route="' + state.route + '"]')) return;
    const ph = document.querySelector('#main .page-h');
    if (!ph) return;
    // Remove any stale bubbles from other routes
    document.querySelectorAll('.tip-bubble').forEach((n) => n.remove());
    const r = ph.getBoundingClientRect();
    const bub = document.createElement('div');
    bub.className = 'tip-bubble';
    bub.dataset.tipRoute = state.route;
    bub.style.top = (r.bottom + 6) + 'px';
    bub.style.left = Math.min(window.innerWidth - 300, r.left) + 'px';
    bub.innerHTML = `<div>💡 ${escape(tip)}</div><button>Got it</button>`;
    document.body.appendChild(bub);
    bub.querySelector('button').addEventListener('click', async () => {
      _dismissedTipsThisSession.add(state.route);
      const seen2 = { ...(state.settings.seenTips || {}) }; seen2[state.route] = true;
      state.settings.seenTips = seen2; // optimistic update so next render skips
      bub.remove();
      try { await patchAppSettings({ seenTips: seen2 }); } catch {}
    });
  }, 600);
}

// Expose render to page modules for self-driven re-renders.
state.__rerender = render;

// ---------- Sidebar interactions (search / add / reset / palette) ----------
function bootSidebarChrome() {
  // v8.0.3: show real manifest version in the sidebar brand, and route clicks
  // to the Settings → Updates section so users have a 1-click update check.
  try {
    const ver = chrome.runtime.getManifest().version;
    const bv = $('#brand-version');
    if (bv) {
      bv.textContent = 'v' + ver;
      bv.style.cursor = 'pointer';
      bv.addEventListener('click', () => { location.hash = '#/settings'; });
    }
  } catch {}
  const search = $('#sidebar-search');
  if (search) {
    search.addEventListener('input', () => {
      _sidebarSearch = search.value;
      renderSidebar();
    });
  }
  const addBtn = $('#sidebar-add');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      // Inline picker — show hidden + new pages, click to unhide
      const html = `<div class="picker-modal" id="picker-modal">
        <div class="picker-backdrop"></div>
        <div class="picker-card">
          <h3 style="margin:0 0 8px">Add a page to the sidebar</h3>
          <div class="picker-list">${renderHiddenPicker(state.settings)}</div>
          <button id="picker-close" class="btn">Close</button>
        </div>
      </div>`;
      const wrap = document.createElement('div');
      wrap.innerHTML = html;
      const node = wrap.firstChild;
      document.body.appendChild(node);
      node.querySelector('.picker-backdrop').addEventListener('click', () => node.remove());
      node.querySelector('#picker-close').addEventListener('click', () => node.remove());
      node.querySelectorAll('.picker-row').forEach((row) => {
        row.addEventListener('click', async () => {
          const id = row.dataset.id;
          const hidden = new Set(state.settings.sidebarHidden || []);
          hidden.delete(id);
          // Also append to user's order if missing
          const order = Array.isArray(state.settings.sidebarOrder) ? [...state.settings.sidebarOrder] : [];
          if (!order.includes(id)) order.push(id);
          await patchAppSettings({ sidebarHidden: Array.from(hidden), sidebarOrder: order });
          node.remove();
        });
      });
    });
  }
  const resetBtn = $('#sidebar-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      patchAppSettings({ sidebarOrder: [], sidebarHidden: [], sidebarPinned: [], sectionOverrides: {} });
    });
  }
  // Command palette (Cmd/Ctrl+K) — extended fuzzy search over pages, jobs, contacts, commands.
  attachCmdPalette({
    paletteEl: $('#cmd-palette'),
    inputEl: $('#cmd-input'),
    listEl: $('#cmd-list'),
    getState: () => state,
    getCommands: () => [
      { icon: '🎨', label: 'Open theme picker', sub: 'Settings · Theme', run: () => { location.hash = '#/settings'; } },
      { icon: '🌓', label: 'Toggle light/dark mode', sub: 'Theme', run: () => toggleLightDark() },
      { icon: '⌨', label: 'Show keyboard shortcuts', sub: 'Help', run: () => showShortcutsOverlay() },
      { icon: '✨', label: 'Open AI setup wizard', sub: 'AI', run: () => { location.hash = '#/ai'; } },
      { icon: '🖥', label: 'Install desktop app', sub: 'System', run: () => { location.hash = '#/install-app'; } },
      { icon: '🔄', label: 'Reset sidebar to defaults', sub: 'Sidebar', run: () => patchAppSettings({ sidebarOrder: [], sidebarHidden: [], sidebarPinned: [], sectionOverrides: {} }) },
      { icon: '🎉', label: 'Trigger confetti (test)', sub: 'Fun', run: () => confetti() },
    ],
    onPickRoute: (route) => { location.hash = '#' + route; }
  });
  // Keyboard shortcuts
  attachKeyboard({
    getState: () => state,
    navigate: (r) => { location.hash = '#' + r; },
    toggleTheme: toggleLightDark,
    openHelp: showShortcutsOverlay,
  });
  // v8.5 extra shortcuts
  attachExtraKeyboard({
    openQuickAdd: openQuickAddOverlay,
    openRecent: openRecentItemsModal,
    undoLast: undoLastAction,
    openPomodoro: () => { location.hash = '#/pomodoro'; }
  });
  // Wire global topbar search
  const gs = $('#global-search');
  if (gs) {
    gs.addEventListener('input', () => runGlobalSearch(gs.value));
    gs.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { gs.value = ''; runGlobalSearch(''); gs.blur(); }
    });
    // Hide results when clicking outside
    document.addEventListener('mousedown', (e) => {
      const out = $('#global-search-results');
      if (!out || out.hidden) return;
      if (out.contains(e.target) || gs.contains(e.target)) return;
      out.hidden = true;
    });
  }
}

// Cycle between dark and light themes from the registry.
function toggleLightDark() {
  const cur = state.settings.theme || 'midnight';
  const t = THEMES.find((x) => x.id === cur);
  const target = (t && t.mode === 'dark') ? THEMES.find((x) => x.mode === 'light') : THEMES.find((x) => x.mode === 'dark');
  if (target) {
    fadedApplyTheme(target.id);
    patchAppSettings({ theme: target.id });
    toast('Theme: ' + target.name, 'success');
  }
}

setRoute();
load().then(() => { bootSidebarChrome(); attachGlobalDropZone(); });
