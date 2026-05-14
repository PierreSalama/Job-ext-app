// IndexedDB wrapper — single point of access for jobs, documents, gmail messages,
// notifications, logs. All extension contexts (background, content scripts,
// app page, popup) share this same DB.
import { sanitizeApplication, STATUS_FLOW, STATUSES, isHigherStatus } from './schema.js';

const DB_NAME = 'jat9';
const DB_VERSION = 4;

const STORES = {
  jobs: { keyPath: 'id', indexes: [['linkedinJobId', 'linkedinJobId'], ['status', 'status'], ['updatedAt', 'updatedAt'], ['company', 'company']] },
  documents: { keyPath: 'id', indexes: [['type', 'type'], ['updatedAt', 'updatedAt']] },
  gmailMessages: { keyPath: 'id', indexes: [['gmailMessageId', 'gmailMessageId'], ['linkedJobId', 'linkedJobId'], ['receivedAt', 'receivedAt']] },
  notifications: { keyPath: 'id', indexes: [['createdAt', 'createdAt'], ['readAt', 'readAt']] },
  logs: { keyPath: 'id', indexes: [['timestamp', 'timestamp']] },
  // Learned answers: questionKey (normalized lowercase question) -> answer + metadata.
  // One per question, updated on every new answer the user gives.
  qa: { keyPath: 'key', indexes: [['updatedAt', 'updatedAt']] },
  // Recommended jobs feed (cached AI recommendations + scrape results)
  recommendations: { keyPath: 'id', indexes: [['createdAt', 'createdAt']] },
  // Named profiles. Each row: { id, name, isDefault, sourceAssignments: { LinkedIn: 'profileId', ... }, data: <full profile shape> }
  // The legacy single profile in chrome.storage continues to act as the "Default" mirror for back-compat.
  namedProfiles: { keyPath: 'id', indexes: [['updatedAt', 'updatedAt']] },

  // ============ v9 NEW STORES ============
  messages: { keyPath: 'id', indexes: [['source', 'source'], ['threadId', 'threadId'], ['contactId', 'contactId'], ['receivedAt', 'receivedAt']] },
  contacts: { keyPath: 'id', indexes: [['name', 'name'], ['company', 'company'], ['source', 'source'], ['updatedAt', 'updatedAt']] },
  companies: { keyPath: 'id', indexes: [['name', 'name'], ['updatedAt', 'updatedAt']] },
  events: { keyPath: 'id', indexes: [['startsAt', 'startsAt'], ['jobId', 'jobId'], ['kind', 'kind']] }, // calendar events: interview, follow-up, deadline
  notes: { keyPath: 'id', indexes: [['updatedAt', 'updatedAt'], ['jobId', 'jobId'], ['pinned', 'pinned']] },
  emailTemplates: { keyPath: 'id', indexes: [['updatedAt', 'updatedAt'], ['kind', 'kind']] },
  salaryEntries: { keyPath: 'id', indexes: [['company', 'company'], ['title', 'title'], ['updatedAt', 'updatedAt']] },
  goals: { keyPath: 'id', indexes: [['period', 'period'], ['updatedAt', 'updatedAt']] },
  achievements: { keyPath: 'id', indexes: [['unlockedAt', 'unlockedAt']] },
  reminders: { keyPath: 'id', indexes: [['fireAt', 'fireAt'], ['done', 'done']] },
  audit: { keyPath: 'id', indexes: [['timestamp', 'timestamp'], ['actor', 'actor'], ['kind', 'kind']] }, // signed audit log
  searches: { keyPath: 'id', indexes: [['updatedAt', 'updatedAt']] }, // saved job searches
  skills: { keyPath: 'id', indexes: [['name', 'name'], ['updatedAt', 'updatedAt']] }, // tracked skills + level
  interviewQuestions: { keyPath: 'id', indexes: [['jobId', 'jobId'], ['practicedAt', 'practicedAt']] },
  practice: { keyPath: 'id', indexes: [['questionId', 'questionId'], ['createdAt', 'createdAt']] }, // recorded practice answers
  resumeVersions: { keyPath: 'id', indexes: [['createdAt', 'createdAt']] }, // AI-generated resume drafts
  coverLetters: { keyPath: 'id', indexes: [['jobId', 'jobId'], ['createdAt', 'createdAt']] },
  reports: { keyPath: 'id', indexes: [['createdAt', 'createdAt'], ['kind', 'kind']] }, // generated/exported reports
  integrations: { keyPath: 'id', indexes: [['kind', 'kind']] }, // calendars, email, slack, etc.
  pinned: { keyPath: 'id' }, // pinned items across the app
  todos: { keyPath: 'id', indexes: [['done', 'done'], ['dueAt', 'dueAt'], ['jobId', 'jobId']] },
  network: { keyPath: 'id', indexes: [['name', 'name'], ['updatedAt', 'updatedAt']] }, // referrer / network graph
  experiments: { keyPath: 'id', indexes: [['createdAt', 'createdAt']] }, // AI lab experiments
  workspaces: { keyPath: 'id' }, // saved sidebar/page customization sets
  signatures: { keyPath: 'id', indexes: [['createdAt', 'createdAt']] }, // cryptographic signatures over audit batches

  // ============ v8.5 QoL stores ============
  dailySummaries: { keyPath: 'id', indexes: [['createdAt', 'createdAt']] },
  templates: { keyPath: 'id', indexes: [['updatedAt', 'updatedAt']] }, // Job templates
  savedSearches: { keyPath: 'id', indexes: [['updatedAt', 'updatedAt']] }, // Saved search chips
  pomodoroSessions: { keyPath: 'id', indexes: [['startedAt', 'startedAt'], ['day', 'day']] },

  // ============ v9 stores ============
  mockInterviews: { keyPath: 'id', indexes: [['createdAt', 'createdAt'], ['jobId', 'jobId']] },
  references: { keyPath: 'id', indexes: [['name', 'name'], ['updatedAt', 'updatedAt']] },

  // ============ v9 NEW STORES (DB v4) ============
  tags: { keyPath: 'id', indexes: [['name', 'name'], ['updatedAt', 'updatedAt']] },
  savedViews: { keyPath: 'id', indexes: [['updatedAt', 'updatedAt']] }, // saved filter combos for jobs page
  fitScores: { keyPath: 'jobId', indexes: [['score', 'score'], ['computedAt', 'computedAt']] },
  redFlags: { keyPath: 'jobId', indexes: [['count', 'count'], ['computedAt', 'computedAt']] },
  autopsies: { keyPath: 'jobId', indexes: [['createdAt', 'createdAt']] },
  tailoredResumes: { keyPath: 'id', indexes: [['jobId', 'jobId'], ['createdAt', 'createdAt']] },
  snapshots: { keyPath: 'id', indexes: [['jobId', 'jobId'], ['createdAt', 'createdAt']] }, // submitted-form snapshots
  scrapedSalary: { keyPath: 'id', indexes: [['company', 'company'], ['title', 'title'], ['scrapedAt', 'scrapedAt']] },
  autoStatusEvents: { keyPath: 'id', indexes: [['jobId', 'jobId'], ['createdAt', 'createdAt']] },
  embeddings: { keyPath: 'id', indexes: [['kind', 'kind'], ['ownerId', 'ownerId']] }, // job/resume vector cache
  drafts: { keyPath: 'id', indexes: [['kind', 'kind'], ['updatedAt', 'updatedAt']] }, // crash-recovery autosave
  digests: { keyPath: 'id', indexes: [['createdAt', 'createdAt']] }, // weekly AI digests
  healthChecks: { keyPath: 'id', indexes: [['runAt', 'runAt']] },
  smartTagRules: { keyPath: 'id', indexes: [['updatedAt', 'updatedAt']] },
  recipes: { keyPath: 'id', indexes: [['updatedAt', 'updatedAt']] },
  webhooks: { keyPath: 'id', indexes: [['kind', 'kind']] },
  xpEvents: { keyPath: 'id', indexes: [['createdAt', 'createdAt']] }
};

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const txn = e.target.transaction;
      for (const [name, def] of Object.entries(STORES)) {
        let store;
        if (!db.objectStoreNames.contains(name)) {
          store = db.createObjectStore(name, { keyPath: def.keyPath });
        } else {
          store = txn.objectStore(name);
        }
        for (const [idxName, idxKey] of def.indexes || []) {
          if (!store.indexNames.contains(idxName)) {
            try { store.createIndex(idxName, idxKey, { unique: false }); } catch {}
          }
        }
      }
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
  return dbPromise;
}

function tx(storeName, mode = 'readonly') {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

function awaitReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  async put(storeName, value) {
    const store = await tx(storeName, 'readwrite');
    return awaitReq(store.put(value));
  },
  async get(storeName, key) {
    const store = await tx(storeName);
    return awaitReq(store.get(key));
  },
  async getAll(storeName) {
    const store = await tx(storeName);
    return awaitReq(store.getAll());
  },
  async delete(storeName, key) {
    const store = await tx(storeName, 'readwrite');
    return awaitReq(store.delete(key));
  },
  async getByIndex(storeName, indexName, value) {
    const store = await tx(storeName);
    return awaitReq(store.index(indexName).getAll(value));
  },
  async clear(storeName) {
    const store = await tx(storeName, 'readwrite');
    return awaitReq(store.clear());
  }
};

// ---------- Job helpers ----------
// Status definitions live in schema.js. Re-export here for back-compat.
export { STATUSES } from './schema.js';
export { STATUS_LABELS } from './schema.js';
export { STATUS_COLORS } from './schema.js';

const STATUS_PRIORITY = Object.fromEntries(
  STATUSES.map((s) => [s, STATUS_FLOW[s]?.order || 0])
);

export function normalizeStatus(s) {
  const v = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return STATUSES.includes(v) ? v : 'started';
}

export function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export async function findExistingJob(payload) {
  const all = await db.getAll('jobs');
  const lkid = String(payload.linkedinJobId || '');
  const ext = String(payload.externalId || '');
  const src = String(payload.source || '');
  const url = String(payload.jobUrl || '');
  const t = normKey(payload.title);
  const c = normKey(payload.company);
  return all.find((j) => {
    if (lkid && String(j.linkedinJobId) === lkid) return true;
    if (ext && src && String(j.externalId) === ext && j.source === src) return true;
    if (url && j.jobUrl === url) return true;
    return t && c && normKey(j.title) === t && normKey(j.company) === c;
  });
}

export async function upsertJob(rawPayload) {
  // Sanitize EVERYTHING before save. Any field that fails its validator is
  // dropped (kept blank rather than polluting the record with UI text).
  const rejected = [];
  const payload = sanitizeApplication(rawPayload, (field, reason, original) => {
    rejected.push({ field, reason, original: String(original || '').slice(0, 80) });
  });
  // Pass through fields that aren't in schema sanitizer
  for (const k of ['linkedinJobId', 'externalId', 'jobUrl', '_source', 'submittedAt', 'followUpDueAt']) {
    if (rawPayload[k] !== undefined && payload[k] === undefined) payload[k] = rawPayload[k];
  }
  const now = new Date().toISOString();
  const incomingStatus = normalizeStatus(payload.status || (rawPayload.applied ? 'submitted' : 'started'));
  const existing = await findExistingJob(payload);

  if (rejected.length) {
    // Log rejections so we can see what scrapes are dirty
    state_logRejections(payload, rejected);
  }

  if (existing) {
    const before = existing.status;
    const newStatus = (STATUS_PRIORITY[incomingStatus] || 0) >= (STATUS_PRIORITY[before] || 0) ? incomingStatus : before;
    const updated = {
      ...existing,
      title: payload.title || existing.title,
      company: payload.company || existing.company,
      location: payload.location || existing.location,
      jobUrl: payload.jobUrl || existing.jobUrl,
      linkedinJobId: payload.linkedinJobId || existing.linkedinJobId,
      externalId: payload.externalId || existing.externalId,
      description: payload.description || existing.description,
      compensation: payload.compensation || existing.compensation,
      workMode: payload.workMode || existing.workMode,
      employmentType: payload.employmentType || existing.employmentType,
      recruiterName: payload.recruiterName || existing.recruiterName,
      recruiterTitle: payload.recruiterTitle || existing.recruiterTitle,
      source: payload.source || existing.source,
      status: newStatus,
      applied: payload.applied || existing.applied,
      submittedAt: (payload.applied && !existing.submittedAt) ? (payload.submittedAt || now) : existing.submittedAt,
      followUpDueAt: payload.followUpDueAt || existing.followUpDueAt,
      resumeName: payload.resumeName || existing.resumeName,
      questions: payload.questions || existing.questions,
      answers: { ...(existing.answers || {}), ...(payload.answers || {}) },
      tags: payload.tags || existing.tags,
      notes: payload.notes ?? existing.notes,
      starred: payload.starred ?? existing.starred,
      updatedAt: now,
      timeline: [
        ...(existing.timeline || []),
        {
          id: uuid(), timestamp: now,
          type: before !== newStatus ? 'status_changed' : 'updated',
          source: payload._source || 'extension',
          summary: before !== newStatus ? `${before} → ${newStatus}` : 'Updated'
        }
      ]
    };
    await db.put('jobs', updated);
    return { action: 'updated', job: updated, previousStatus: before };
  }

  const job = {
    id: uuid(),
    title: payload.title,
    company: payload.company,
    location: payload.location || '',
    jobUrl: payload.jobUrl || '',
    linkedinJobId: payload.linkedinJobId || '',
    externalId: payload.externalId || '',
    description: payload.description || '',
    compensation: payload.compensation || '',
    workMode: payload.workMode || '',
    employmentType: payload.employmentType || '',
    recruiterName: payload.recruiterName || '',
    recruiterTitle: payload.recruiterTitle || '',
    source: payload.source || 'LinkedIn',
    status: incomingStatus,
    applied: Boolean(payload.applied),
    submittedAt: payload.applied ? (payload.submittedAt || now) : '',
    followUpDueAt: payload.followUpDueAt || '',
    resumeName: payload.resumeName || '',
    questions: payload.questions || [],
    answers: payload.answers || {},
    tags: payload.tags || [],
    notes: payload.notes || '',
    starred: false,
    createdAt: now,
    updatedAt: now,
    timeline: [{ id: uuid(), timestamp: now, type: 'created', source: payload._source || 'extension', summary: `Created (${incomingStatus})` }]
  };
  await db.put('jobs', job);
  return { action: 'created', job };
}

export async function listJobs() {
  return db.getAll('jobs');
}

export async function getJob(id) {
  return db.get('jobs', id);
}

export async function patchJob(id, patch) {
  const job = await getJob(id);
  if (!job) return null;
  const before = job.status;
  const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
  if (patch.status && patch.status !== before) {
    next.status = normalizeStatus(patch.status);
    next.timeline = [
      ...(job.timeline || []),
      { id: uuid(), timestamp: next.updatedAt, type: 'status_changed', source: 'manual', summary: `${before} → ${next.status}` }
    ];
  } else {
    next.timeline = [
      ...(job.timeline || []),
      { id: uuid(), timestamp: next.updatedAt, type: 'updated', source: 'manual', summary: 'Edited' }
    ];
  }
  await db.put('jobs', next);
  return next;
}

export async function deleteJob(id) { return db.delete('jobs', id); }

export async function statusSummary() {
  const all = await listJobs();
  const counts = {};
  for (const j of all) counts[j.status] = (counts[j.status] || 0) + 1;
  const today = all.filter((j) => sameDay(j.submittedAt || j.createdAt)).length;
  const week = all.filter((j) => withinDays(j.submittedAt || j.createdAt, 7)).length;
  const followUps = all.filter((j) => j.followUpDueAt && new Date(j.followUpDueAt).getTime() <= Date.now() && !['offer', 'rejected', 'withdrawn', 'archived'].includes(j.status)).length;
  const responseEligible = all.filter((j) => ['received', 'reviewing', 'recruiter_replied', 'interview', 'assessment', 'offer', 'rejected'].includes(j.status)).length;
  return {
    total: all.length,
    today, week,
    followUps,
    counts,
    responseRate: all.length ? Math.round((responseEligible / all.length) * 100) : 0,
    active: all.filter((j) => !['offer', 'rejected', 'withdrawn', 'archived'].includes(j.status)).length,
    interviews: all.filter((j) => j.status === 'interview').length,
    offers: all.filter((j) => j.status === 'offer').length,
    rejected: all.filter((j) => j.status === 'rejected').length
  };
}

function sameDay(value) {
  if (!value) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime()) && d.toDateString() === new Date().toDateString();
}
function withinDays(value, days) {
  if (!value) return false;
  const t = new Date(value).getTime();
  return !Number.isNaN(t) && t >= Date.now() - days * 86400000;
}

// ---------- Documents ----------
// Files are stored as ArrayBuffers — they survive structured-clone through
// chrome.runtime.sendMessage and IDB roundtrips reliably (Blobs sometimes
// get stripped to {} depending on the Chrome version + path).
export async function addDocument({ name, originalFilename, type, mimeType, sizeBytes, buffer, blob, linkedJobIds = [] }) {
  // Accept either ArrayBuffer (preferred) or Blob (back-compat). Convert to AB.
  let arrayBuffer = buffer;
  if (!arrayBuffer && blob && typeof blob.arrayBuffer === 'function') {
    arrayBuffer = await blob.arrayBuffer();
  }
  const doc = {
    id: uuid(),
    name, originalFilename, type, mimeType, sizeBytes,
    data: arrayBuffer || null, // canonical field — ArrayBuffer
    linkedJobIds,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await db.put('documents', doc);
  return doc;
}
export async function listDocuments() { return db.getAll('documents'); }
export async function patchDocument(id, patch) {
  const doc = await db.get('documents', id);
  if (!doc) return null;
  const next = { ...doc, ...patch, updatedAt: new Date().toISOString() };
  await db.put('documents', next);
  return next;
}
export async function deleteDocument(id) { return db.delete('documents', id); }

// ---------- Logs ----------
// Legacy appendLog — kept for back-compat. New code uses logger.js's writeLog.
export async function appendLog(level, message, context = {}) {
  const ctx = (context && typeof context === 'object' && context.source) ? String(context.source) : 'app';
  const data = (context && typeof context === 'object') ? { ...context } : null;
  if (data && data.source) delete data.source;
  await db.put('logs', { id: uuid(), timestamp: new Date().toISOString(), level, ctx, message, data });
}
export async function listLogs(limit = 200) {
  const all = await db.getAll('logs');
  return all.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
}

// ---------- Notifications ----------
export async function pushNotification({ title, body, kind = 'info', jobId = '' }) {
  const n = { id: uuid(), createdAt: new Date().toISOString(), readAt: '', title, body, kind, jobId };
  await db.put('notifications', n);
  return n;
}
export async function listNotifications() { return db.getAll('notifications'); }

// ---------- Settings + Profile (chrome.storage.local) ----------
const SETTINGS_KEY = 'jat9.settings';
const PROFILE_KEY = 'jat9.profile';

const DEFAULT_SETTINGS = {
  theme: 'system', // 'light' | 'dark' | 'system'
  defaultFollowUpDays: 10,
  notificationsEnabled: true,
  automationLevel: 'high_confidence',
  gmailClientId: '',
  gmailClientSecret: '',
  scheduledGmailSync: false,
  gmailSyncIntervalMinutes: 30,
  storeFullEmailBody: false,
  devMode: false,
  onboardingDone: false,
  // AI — Ollama (local) is the default. Gemma 3 4B if pulled, else falls back to any available model.
  aiProvider: 'ollama', // 'auto' | 'chrome' | 'ollama' | 'openai' | 'none'
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'gemma4:e4b',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiKey: '',
  openaiModel: 'gpt-4o-mini',
  // AI feature toggles
  aiValidateCaptures: false,
  aiClassifyEmails: false,
  // Theme + icon
  theme: 'midnight',
  iconPreset: '',          // ID of a preset from icon-presets.js (empty = use default packaged PNGs)
  iconCustomDataUrl: '',   // Custom user-uploaded icon (data URL of the largest size)
  // Dashboard customizations
  dashboardShortcuts: [
    { id: 'sh1', label: 'LinkedIn Jobs', url: 'https://www.linkedin.com/jobs/' },
    { id: 'sh2', label: 'Indeed', url: 'https://www.indeed.com/' },
    { id: 'sh3', label: 'Glassdoor', url: 'https://www.glassdoor.com/Job/index.htm' }
  ],
  // ============ v9 SETTINGS ============
  // Sidebar / page customization. User-editable. The default value is computed
  // from the page registry (lib/pages.js). null = "use registry default".
  sidebarOrder: null,           // null OR array of page IDs in user's chosen order
  // v9.0.0: Strictest possible default. Only job-application essentials are
  // visible out of the box: Dashboard, Applications, Pipeline, Calendar,
  // Reminders, Inbox, Profile, Documents, Install desktop app, Settings.
  // Everything else (40+ pages) is one click away under "+ Add a page".
  sidebarHidden: [
    // v9.0.0: ULTRA-MINIMAL default. Only the daily core remains visible.
    // Visible: dashboard, jobs, profile, documents, install-app, settings.
    // Everything else is one click away under "+ Add a page".
    'pipeline', 'calendar', 'reminders', 'todos',
    'inbox', 'threads', 'templates',
    'contacts', 'companies', 'network', 'sources',
    'resume-builder', 'cover-studio', 'interview-prep', 'salary', 'notes',
    'mock-interview', 'company-hub', 'references',
    'analytics', 'goals', 'achievements', 'skills', 'recommendations',
    'offer-compare', 'negotiation', 'roadmap',
    'ai', 'ai-lab', 'integrations', 'tour', 'bulk-tools', 'pomodoro',
    'ai-coach', 'daily-digest',
    'audit', 'backup', 'logs',
    'fit-scores', 'red-flags', 'autopsy', 'tags', 'saved-views', 'health',
    'sandbox', 'permissions', 'recipes', 'webhooks', 'voice', 'timeline'
  ],
  // Migration marker — bump when defaults change. Background applies the
  // newer hidden list when the stored value here is lower than the constant.
  // v3 (2026-05-13): force-rewrite to make sure stricter list actually applies
  // for users where v2 ran but somehow didn't stick (no broadcast / cached
  // state in open tabs / etc.). Same hidden list, different marker = re-runs.
  // v4 (2026-05-13): tightened to ULTRA-MINIMAL — hides pipeline, calendar,
  // reminders, inbox too. Only 6 daily-essential pages visible by default.
  // v5 (v9.0.0): bump on major release so v9 re-applies for v8 upgraders.
  sidebarDefaultsVersion: 5,
  sidebarPinned: [],            // array of page IDs pinned to top
  sidebarSections: null,        // optional grouping {label, pageIds[]}[]
  // Tour
  tourCompleted: false,
  tourLastStep: 0,
  // Sync
  desktopAppUrl: 'http://localhost:7733',
  desktopAppEnabled: true,
  syncIntervalSeconds: 5,
  dismissedDesktopPromo: false,
  dismissedExtensionPromo: false,
  extensionEverConnected: false,
  // Audit
  auditEnabled: true,
  auditRetentionDays: 365,
  // Privacy
  redactInLogs: true,
  // Production polish
  reducedMotion: false,
  density: 'comfortable', // 'compact' | 'comfortable' | 'spacious'
  fontScale: 1.0,
  shareAnonymousMetrics: false,
  // ============ v9 NEW SETTINGS ============
  // Auto-status inference: when emails/events are detected, auto-advance status
  autoStatusInference: true,
  // Job-fit scoring: compute and surface score on every job card
  fitScoreEnabled: true,
  fitScoreModel: 'auto', // 'auto' | 'embeddings' | 'llm'
  // Red-flag detection in JDs
  redFlagsEnabled: true,
  // Crash recovery autosave (cover letters, notes, messages)
  autosaveEnabled: true,
  autosaveIntervalMs: 1500,
  // Privacy + lock
  localOnlyMode: false,
  autoLockMinutes: 0, // 0 = disabled
  // Gamification
  xpEnabled: true,
  confettiOnMilestones: true,
  // PWA / offline
  offlineFirst: true,
  // Voice
  voiceQuickAdd: true,
  // Mobile / density auto
  mobileLayout: 'auto', // 'auto' | 'desktop' | 'compact'
  // Webhooks
  outgoingWebhooksEnabled: false,
  // Self-test
  selfTestOnStartup: false,
  // Theme: high-contrast / dyslexia friendly
  highContrast: false,
  dyslexiaFriendly: false,
  // Welcome / sandbox
  sandboxSeeded: false,
  // v9.0.1: Resume-tailor feature
  autoTailorEnabled: 'ask',     // 'ask' | 'always' | 'never'
  defaultResumeId: '',          // documents row id
  // v9.0.1: Auto-Apply (RPA) feature
  autoApplyEnabled: false,      // bool — show the toolbar trigger
  autoApplyMaxSteps: 20,
  // Per-route tips dismissal map (v8). { '/jobs': true, ... }
  seenTips: {},
  // v8: GitHub Releases — where the desktop installers are hosted.
  // GitHub Actions (.github/workflows/release.yml) auto-builds installers on
  // every tag push and attaches them here. The extension always points at
  // /releases/latest/download so a new tag instantly updates the installer
  // for every existing extension install, with no extension re-deploy.
  releasesBaseUrl: 'https://github.com/PierreSalama/Job-ext-app/releases/latest/download'
};

const DEFAULT_PROFILE = {
  // Identity
  firstName: '', lastName: '', fullName: '', preferredName: '', pronouns: '',
  // Contact
  email: '', phone: '', secondaryEmail: '',
  // Address
  address1: '', address2: '', city: '', state: '', postalCode: '', country: '',
  // Online presence
  linkedinUrl: '', githubUrl: '', portfolioUrl: '', twitterUrl: '', websiteUrl: '',
  // Eligibility
  workAuthorization: 'Yes', sponsorshipRequired: 'No', securityClearance: '', citizenship: '',
  // Compensation / availability
  salaryExpectation: '', salaryMin: '', salaryMax: '', currency: 'USD',
  yearsExperience: '', noticePeriod: '', earliestStartDate: '', willRelocate: 'Maybe', willTravel: 'Up to 25%',
  // Demographics (optional EEO fields)
  gender: '', ethnicity: '', veteranStatus: '', disabilityStatus: '', age: '',
  // Education
  highestDegree: '', university: '', graduationYear: '', major: '', gpa: '',
  // Resume / cover letter
  defaultResumeName: '', defaultCoverLetterName: '',
  // Summary + skills
  summary: '', headline: '', skills: [],
  // Free-form answer cache (legacy; new code uses the qa store)
  customAnswers: {}
};

export async function getSettings() {
  const v = await chrome.storage.local.get([SETTINGS_KEY]);
  return { ...DEFAULT_SETTINGS, ...(v[SETTINGS_KEY] || {}) };
}
export async function patchSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}
export async function getProfile() {
  const v = await chrome.storage.local.get([PROFILE_KEY]);
  return { ...DEFAULT_PROFILE, ...(v[PROFILE_KEY] || {}), customAnswers: { ...(v[PROFILE_KEY]?.customAnswers || {}) } };
}
export async function patchProfile(patch) {
  const current = await getProfile();
  const next = { ...current, ...patch };
  if (patch.customAnswers) next.customAnswers = { ...current.customAnswers, ...patch.customAnswers };
  await chrome.storage.local.set({ [PROFILE_KEY]: next });
  return next;
}

function state_logRejections(payload, rejected) {
  // Fire-and-forget log entry recording sanitizer rejections
  const entry = {
    id: uuid(),
    timestamp: new Date().toISOString(),
    level: 'warn',
    ctx: 'sanitize',
    message: `Rejected ${rejected.length} field(s) for ${payload.title || '?'} at ${payload.company || '?'}`,
    data: { jobId: payload.linkedinJobId || '', rejected }
  };
  db.put('logs', entry).catch(() => {});
}

// ---------- Q&A learning store ----------
// Normalize a question into a stable key. Strips punctuation, collapses whitespace,
// lowercases, and removes common multilingual fillers ("please", "veuillez", "por favor").
export function normalizeQuestion(q) {
  if (!q) return '';
  let s = String(q).toLowerCase();
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); // strip accents
  s = s.replace(/[^a-z0-9\s]+/g, ' ');
  s = s.replace(/\b(please|kindly|veuillez|por\s*favor|bitte|svp|sil\s*vous\s*plait|prego)\b/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // Truncate so trivial wording differences map together
  return s.slice(0, 120);
}

export async function recordAnswer({ question, answer, fieldType, source, jobId }) {
  if (!question || answer == null || answer === '') return null;
  const key = normalizeQuestion(question);
  if (!key) return null;
  const now = new Date().toISOString();
  const existing = await db.get('qa', key);
  const entry = {
    key,
    questions: [...new Set([...(existing?.questions || []), String(question)])].slice(0, 6),
    answer: String(answer),
    fieldType: fieldType || existing?.fieldType || '',
    seenCount: (existing?.seenCount || 0) + 1,
    sources: [...new Set([...(existing?.sources || []), source].filter(Boolean))].slice(0, 8),
    lastJobId: jobId || existing?.lastJobId || '',
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  await db.put('qa', entry);
  return entry;
}

export async function lookupAnswer(question) {
  const key = normalizeQuestion(question);
  if (!key) return null;
  const exact = await db.get('qa', key);
  if (exact) return exact;
  // Fuzzy: any stored key whose tokens fully overlap with the lookup tokens
  const tokens = new Set(key.split(' ').filter((t) => t.length > 2));
  if (tokens.size === 0) return null;
  const all = await db.getAll('qa');
  let best = null, bestScore = 0;
  for (const e of all) {
    const eTokens = new Set(e.key.split(' ').filter((t) => t.length > 2));
    if (eTokens.size === 0) continue;
    let overlap = 0;
    for (const t of tokens) if (eTokens.has(t)) overlap++;
    const score = overlap / Math.max(tokens.size, eTokens.size);
    if (score > bestScore && score >= 0.6) { best = e; bestScore = score; }
  }
  return best;
}

export async function listAnswers() { return db.getAll('qa'); }
export async function deleteAnswer(key) { return db.delete('qa', key); }

// ---------- Named profiles ----------
// Each user can keep multiple named profiles (e.g., "Default", "Senior eng",
// "Career switch") and assign one per source. When the autofill engine runs on
// a given source, it asks for the profile assigned to that source — falling
// back to the default profile if none.
function pUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'p-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}
export async function listNamedProfiles() {
  const all = await db.getAll('namedProfiles');
  return all.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}
export async function getNamedProfile(id) { return db.get('namedProfiles', id); }
export async function createNamedProfile({ name, data, sourceAssignments }) {
  const now = new Date().toISOString();
  const all = await listNamedProfiles();
  const isDefault = all.length === 0;
  const row = {
    id: pUuid(),
    name: String(name || 'Untitled').slice(0, 80),
    isDefault,
    sourceAssignments: sourceAssignments || {},
    data: data || {},
    createdAt: now, updatedAt: now
  };
  await db.put('namedProfiles', row);
  return row;
}
export async function patchNamedProfile(id, patch) {
  const cur = await getNamedProfile(id);
  if (!cur) return null;
  const next = { ...cur, ...patch, data: { ...(cur.data || {}), ...((patch || {}).data || {}) }, updatedAt: new Date().toISOString() };
  // Ensure exactly one default
  if (patch.isDefault) {
    for (const p of await listNamedProfiles()) if (p.id !== id && p.isDefault) {
      await db.put('namedProfiles', { ...p, isDefault: false });
    }
  }
  await db.put('namedProfiles', next);
  return next;
}
export async function deleteNamedProfile(id) { return db.delete('namedProfiles', id); }
// Lookup the correct profile for a source. Falls back to default profile then the
// chrome.storage legacy profile.
export async function getProfileForSource(source) {
  const all = await listNamedProfiles();
  if (all.length === 0) return getProfile();
  const def = all.find((p) => p.isDefault) || all[0];
  if (!source) return def.data || {};
  for (const p of all) {
    if (p.sourceAssignments && p.sourceAssignments[source] === p.id) return p.data || {};
  }
  // Or check the source mapping with assignment by source -> profileId
  for (const p of all) {
    const assigned = (p.sourceAssignments && p.sourceAssignments[source]);
    if (assigned) {
      const target = await getNamedProfile(assigned);
      if (target) return target.data || {};
    }
  }
  return def.data || {};
}

// ---------- Recommendations ----------
export async function saveRecommendations(items) {
  // Wipe and replace — we treat this as a refreshing feed
  const all = await db.getAll('recommendations');
  for (const r of all) await db.delete('recommendations', r.id);
  const now = new Date().toISOString();
  for (const item of items) {
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random());
    await db.put('recommendations', { id, createdAt: now, ...item });
  }
}
export async function listRecommendations() {
  return (await db.getAll('recommendations')).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

// ---------- Live event broadcast ----------
// Background broadcasts to all open extension pages (app.html, popup, etc.)
// via runtime.sendMessage with { type: 'jat-event', name, data }.
// App page subscribes via chrome.runtime.onMessage and patches local state.
export async function broadcast(name, data = {}) {
  try {
    await chrome.runtime.sendMessage({ type: 'jat-event', name, data });
  } catch {
    // No listeners — fine.
  }
}
