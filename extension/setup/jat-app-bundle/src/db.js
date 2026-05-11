// SQLite-backed mirror of the extension's IDB store layout.
//
// Why SQLite and not just dump JSON: we want crash-safe writes, indexed
// lookups for `findExistingJob`, and a stable on-disk format the user can
// back up. better-sqlite3 is synchronous, which makes the call sites read
// like the original IDB helpers without sprinkling awaits everywhere.
//
// Stores mirror lib/db.js: jobs, documents, gmailMessages, notifications,
// logs, qa, recommendations, plus KV `settings` and a multi-row `profiles`
// table (the desktop adds named profiles on top of the single-profile model
// the extension uses today).

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DEFAULT_SETTINGS = {
  theme: 'midnight',
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
  aiProvider: 'ollama',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'gemma4:e4b',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiKey: '',
  openaiModel: 'gpt-4o-mini',
  aiValidateCaptures: false,
  aiClassifyEmails: false,
  iconPreset: '',
  iconCustomDataUrl: '',
  dashboardShortcuts: [
    { id: 'sh1', label: 'LinkedIn Jobs', url: 'https://www.linkedin.com/jobs/' },
    { id: 'sh2', label: 'Indeed', url: 'https://www.indeed.com/' },
    { id: 'sh3', label: 'Glassdoor', url: 'https://www.glassdoor.com/Job/index.htm' }
  ]
};

const DEFAULT_PROFILE = {
  firstName: '', lastName: '', fullName: '', preferredName: '', pronouns: '',
  email: '', phone: '', secondaryEmail: '',
  address1: '', address2: '', city: '', state: '', postalCode: '', country: '',
  linkedinUrl: '', githubUrl: '', portfolioUrl: '', twitterUrl: '', websiteUrl: '',
  workAuthorization: 'Yes', sponsorshipRequired: 'No', securityClearance: '', citizenship: '',
  salaryExpectation: '', salaryMin: '', salaryMax: '', currency: 'USD',
  yearsExperience: '', noticePeriod: '', earliestStartDate: '', willRelocate: 'Maybe', willTravel: 'Up to 25%',
  gender: '', ethnicity: '', veteranStatus: '', disabilityStatus: '', age: '',
  highestDegree: '', university: '', graduationYear: '', major: '', gpa: '',
  defaultResumeName: '', defaultCoverLetterName: '',
  summary: '', headline: '', skills: [],
  customAnswers: {}
};

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeQuestion(q) {
  if (!q) return '';
  let s = String(q).toLowerCase();
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^a-z0-9\s]+/g, ' ');
  s = s.replace(/\b(please|kindly|veuillez|por\s*favor|bitte|svp|sil\s*vous\s*plait|prego)\b/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 120);
}

class JatDb {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._migrate();
  }

  _migrate() {
    // Each row stores its full JSON payload — keeps the IDB shape intact —
    // plus a few hot columns promoted out for indexing/filtering.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        linkedinJobId TEXT, externalId TEXT, source TEXT, jobUrl TEXT,
        title TEXT, company TEXT, status TEXT,
        updatedAt TEXT, createdAt TEXT, submittedAt TEXT,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_lkid ON jobs(linkedinJobId);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_updated ON jobs(updatedAt);

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        name TEXT, originalFilename TEXT, type TEXT, mimeType TEXT,
        sizeBytes INTEGER, updatedAt TEXT, createdAt TEXT,
        linkedJobIds TEXT, blob BLOB,
        meta TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gmailMessages (
        id TEXT PRIMARY KEY, gmailMessageId TEXT, linkedJobId TEXT,
        receivedAt TEXT, data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY, createdAt TEXT, readAt TEXT, data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY, timestamp TEXT, level TEXT, ctx TEXT, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(timestamp);

      CREATE TABLE IF NOT EXISTS qa (
        key TEXT PRIMARY KEY, updatedAt TEXT, data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recommendations (
        id TEXT PRIMARY KEY, createdAt TEXT, data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        k TEXT PRIMARY KEY, v TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        isDefault INTEGER NOT NULL DEFAULT 0,
        sourceAssignments TEXT NOT NULL DEFAULT '{}',
        data TEXT NOT NULL,
        createdAt TEXT, updatedAt TEXT
      );
    `);
    // Seed the default profile if there isn't one yet.
    const row = this.db.prepare(`SELECT id FROM profiles WHERE isDefault = 1 LIMIT 1`).get();
    if (!row) {
      const now = new Date().toISOString();
      this.db.prepare(
        `INSERT INTO profiles (id, name, isDefault, sourceAssignments, data, createdAt, updatedAt)
         VALUES (?, ?, 1, '{}', ?, ?, ?)`
      ).run(uuid(), 'Default', JSON.stringify(DEFAULT_PROFILE), now, now);
    }
  }

  // ===== Jobs =====
  listJobs() {
    return this.db.prepare(`SELECT data FROM jobs`).all().map((r) => JSON.parse(r.data));
  }
  getJob(id) {
    const r = this.db.prepare(`SELECT data FROM jobs WHERE id = ?`).get(id);
    return r ? JSON.parse(r.data) : null;
  }
  putJob(job) {
    this.db.prepare(
      `INSERT INTO jobs (id, linkedinJobId, externalId, source, jobUrl, title, company, status,
                         updatedAt, createdAt, submittedAt, data)
       VALUES (@id, @linkedinJobId, @externalId, @source, @jobUrl, @title, @company, @status,
               @updatedAt, @createdAt, @submittedAt, @data)
       ON CONFLICT(id) DO UPDATE SET
         linkedinJobId=excluded.linkedinJobId, externalId=excluded.externalId,
         source=excluded.source, jobUrl=excluded.jobUrl, title=excluded.title,
         company=excluded.company, status=excluded.status, updatedAt=excluded.updatedAt,
         submittedAt=excluded.submittedAt, data=excluded.data`
    ).run({
      id: job.id,
      linkedinJobId: job.linkedinJobId || '',
      externalId: job.externalId || '',
      source: job.source || '',
      jobUrl: job.jobUrl || '',
      title: job.title || '',
      company: job.company || '',
      status: job.status || '',
      updatedAt: job.updatedAt || '',
      createdAt: job.createdAt || '',
      submittedAt: job.submittedAt || '',
      data: JSON.stringify(job)
    });
    return job;
  }
  deleteJob(id) { this.db.prepare(`DELETE FROM jobs WHERE id = ?`).run(id); }

  findExistingJob(payload) {
    const lkid = String(payload.linkedinJobId || '');
    const ext = String(payload.externalId || '');
    const src = String(payload.source || '');
    const url = String(payload.jobUrl || '');
    if (lkid) {
      const r = this.db.prepare(`SELECT data FROM jobs WHERE linkedinJobId = ? LIMIT 1`).get(lkid);
      if (r) return JSON.parse(r.data);
    }
    if (ext && src) {
      const r = this.db.prepare(`SELECT data FROM jobs WHERE externalId = ? AND source = ? LIMIT 1`).get(ext, src);
      if (r) return JSON.parse(r.data);
    }
    if (url) {
      const r = this.db.prepare(`SELECT data FROM jobs WHERE jobUrl = ? LIMIT 1`).get(url);
      if (r) return JSON.parse(r.data);
    }
    const t = normKey(payload.title);
    const c = normKey(payload.company);
    if (!t || !c) return null;
    const all = this.listJobs();
    return all.find((j) => normKey(j.title) === t && normKey(j.company) === c) || null;
  }

  // Mirror of lib/db.js#upsertJob — preserves status escalation rules and
  // appends a timeline event. Returns { action, job, previousStatus? }.
  upsertJob(rawPayload, { statusPriority, normalizeStatus } = {}) {
    const now = new Date().toISOString();
    const payload = { ...(rawPayload || {}) };
    const incomingStatus = (normalizeStatus ? normalizeStatus(payload.status || (payload.applied ? 'submitted' : 'started')) : (payload.status || 'started'));
    const existing = this.findExistingJob(payload);
    const prio = statusPriority || {};

    if (existing) {
      const before = existing.status;
      const newStatus = (prio[incomingStatus] || 0) >= (prio[before] || 0) ? incomingStatus : before;
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
            source: payload._source || 'desktop',
            summary: before !== newStatus ? `${before} → ${newStatus}` : 'Updated'
          }
        ]
      };
      this.putJob(updated);
      return { action: 'updated', job: updated, previousStatus: before };
    }

    const job = {
      id: uuid(),
      title: payload.title || '',
      company: payload.company || '',
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
      timeline: [{ id: uuid(), timestamp: now, type: 'created', source: payload._source || 'desktop', summary: `Created (${incomingStatus})` }]
    };
    this.putJob(job);
    return { action: 'created', job };
  }

  patchJobShallow(id, patch) {
    const job = this.getJob(id);
    if (!job) return null;
    const before = job.status;
    const next = { ...job, ...(patch || {}), updatedAt: new Date().toISOString() };
    if (patch?.status && patch.status !== before) {
      next.status = patch.status;
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
    this.putJob(next);
    return next;
  }

  statusSummary() {
    const all = this.listJobs();
    const counts = {};
    for (const j of all) counts[j.status] = (counts[j.status] || 0) + 1;
    const sameDay = (v) => v && new Date(v).toDateString() === new Date().toDateString();
    const within = (v, days) => v && new Date(v).getTime() >= Date.now() - days * 86400000;
    const today = all.filter((j) => sameDay(j.submittedAt || j.createdAt)).length;
    const week = all.filter((j) => within(j.submittedAt || j.createdAt, 7)).length;
    const followUps = all.filter((j) => j.followUpDueAt && new Date(j.followUpDueAt).getTime() <= Date.now()
      && !['offer', 'rejected', 'withdrawn', 'archived'].includes(j.status)).length;
    const responseEligible = all.filter((j) => ['received', 'reviewing', 'recruiter_replied', 'interview', 'assessment', 'offer', 'rejected'].includes(j.status)).length;
    return {
      total: all.length, today, week, followUps, counts,
      responseRate: all.length ? Math.round((responseEligible / all.length) * 100) : 0,
      active: all.filter((j) => !['offer', 'rejected', 'withdrawn', 'archived'].includes(j.status)).length,
      interviews: all.filter((j) => j.status === 'interview').length,
      offers: all.filter((j) => j.status === 'offer').length,
      rejected: all.filter((j) => j.status === 'rejected').length
    };
  }

  // ===== Documents =====
  listDocuments() {
    return this.db.prepare(`SELECT meta, blob FROM documents`).all().map((r) => {
      const m = JSON.parse(r.meta);
      // Mirror the extension's IDB shape: `data` holds the file bytes.
      m.data = r.blob ? r.blob.buffer.slice(r.blob.byteOffset, r.blob.byteOffset + r.blob.byteLength) : null;
      return m;
    });
  }
  getDocument(id) {
    const r = this.db.prepare(`SELECT meta, blob FROM documents WHERE id = ?`).get(id);
    if (!r) return null;
    const m = JSON.parse(r.meta);
    m.data = r.blob ? r.blob.buffer.slice(r.blob.byteOffset, r.blob.byteOffset + r.blob.byteLength) : null;
    return m;
  }
  getDocumentBlob(id) {
    const r = this.db.prepare(`SELECT meta, blob FROM documents WHERE id = ?`).get(id);
    if (!r) return null;
    return { meta: JSON.parse(r.meta), buffer: r.blob };
  }
  addDocument({ name, originalFilename, type, mimeType, sizeBytes, buffer, linkedJobIds = [] }) {
    const id = uuid();
    const now = new Date().toISOString();
    const meta = {
      id, name, originalFilename, type, mimeType, sizeBytes,
      linkedJobIds, createdAt: now, updatedAt: now
    };
    let blob = null;
    if (buffer) {
      // Accept ArrayBuffer, Uint8Array, Buffer, or array of bytes.
      if (Buffer.isBuffer(buffer)) blob = buffer;
      else if (buffer instanceof Uint8Array) blob = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      else if (buffer instanceof ArrayBuffer) blob = Buffer.from(buffer);
      else if (Array.isArray(buffer)) blob = Buffer.from(buffer);
      else if (typeof buffer === 'object') {
        // Plain {0:n,1:n,...} from JSON roundtrip
        const keys = Object.keys(buffer);
        if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
          const arr = new Uint8Array(keys.length);
          for (const k of keys) arr[+k] = buffer[k];
          blob = Buffer.from(arr.buffer);
        }
      }
    }
    this.db.prepare(
      `INSERT INTO documents (id, name, originalFilename, type, mimeType, sizeBytes,
                              updatedAt, createdAt, linkedJobIds, blob, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, name || '', originalFilename || '', type || '', mimeType || '',
          sizeBytes || 0, now, now, JSON.stringify(linkedJobIds || []),
          blob, JSON.stringify(meta));
    const out = { ...meta };
    out.data = blob ? blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) : null;
    return out;
  }
  patchDocument(id, patch) {
    const r = this.db.prepare(`SELECT meta FROM documents WHERE id = ?`).get(id);
    if (!r) return null;
    const meta = JSON.parse(r.meta);
    const next = { ...meta, ...patch, updatedAt: new Date().toISOString() };
    this.db.prepare(
      `UPDATE documents SET name = ?, type = ?, linkedJobIds = ?, updatedAt = ?, meta = ?
       WHERE id = ?`
    ).run(next.name || '', next.type || '', JSON.stringify(next.linkedJobIds || []),
          next.updatedAt, JSON.stringify(next), id);
    return next;
  }
  deleteDocument(id) { this.db.prepare(`DELETE FROM documents WHERE id = ?`).run(id); }

  // ===== Notifications =====
  listNotifications() {
    return this.db.prepare(`SELECT data FROM notifications ORDER BY createdAt DESC`).all()
      .map((r) => JSON.parse(r.data));
  }
  pushNotification(n) {
    const id = uuid();
    const row = { id, createdAt: new Date().toISOString(), readAt: '', ...n };
    this.db.prepare(`INSERT INTO notifications (id, createdAt, readAt, data) VALUES (?, ?, ?, ?)`)
      .run(id, row.createdAt, '', JSON.stringify(row));
    return row;
  }

  // ===== Logs =====
  appendLog(level, ctx, message, data) {
    const id = uuid();
    const row = { id, timestamp: new Date().toISOString(), level, ctx, message, data: data || null };
    this.db.prepare(`INSERT INTO logs (id, timestamp, level, ctx, data) VALUES (?, ?, ?, ?, ?)`)
      .run(id, row.timestamp, level, ctx, JSON.stringify(row));
    return row;
  }
  listLogs(limit = 200) {
    return this.db.prepare(`SELECT data FROM logs ORDER BY timestamp DESC LIMIT ?`).all(limit)
      .map((r) => JSON.parse(r.data));
  }

  // ===== QA =====
  recordAnswer({ question, answer, fieldType, source, jobId }) {
    if (!question || answer == null || answer === '') return null;
    const key = normalizeQuestion(question);
    if (!key) return null;
    const now = new Date().toISOString();
    const r = this.db.prepare(`SELECT data FROM qa WHERE key = ?`).get(key);
    const existing = r ? JSON.parse(r.data) : null;
    const entry = {
      key,
      questions: [...new Set([...((existing?.questions) || []), String(question)])].slice(0, 6),
      answer: String(answer),
      fieldType: fieldType || existing?.fieldType || '',
      seenCount: (existing?.seenCount || 0) + 1,
      sources: [...new Set([...((existing?.sources) || []), source].filter(Boolean))].slice(0, 8),
      lastJobId: jobId || existing?.lastJobId || '',
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    this.db.prepare(`INSERT INTO qa (key, updatedAt, data) VALUES (?, ?, ?)
                     ON CONFLICT(key) DO UPDATE SET updatedAt = excluded.updatedAt, data = excluded.data`)
      .run(key, now, JSON.stringify(entry));
    return entry;
  }
  lookupAnswer(question) {
    const key = normalizeQuestion(question);
    if (!key) return null;
    const r = this.db.prepare(`SELECT data FROM qa WHERE key = ?`).get(key);
    if (r) return JSON.parse(r.data);
    const tokens = new Set(key.split(' ').filter((t) => t.length > 2));
    if (tokens.size === 0) return null;
    let best = null, bestScore = 0;
    for (const e of this.listAnswers()) {
      const eTokens = new Set(e.key.split(' ').filter((t) => t.length > 2));
      if (eTokens.size === 0) continue;
      let overlap = 0;
      for (const t of tokens) if (eTokens.has(t)) overlap++;
      const score = overlap / Math.max(tokens.size, eTokens.size);
      if (score > bestScore && score >= 0.6) { best = e; bestScore = score; }
    }
    return best;
  }
  listAnswers() {
    return this.db.prepare(`SELECT data FROM qa ORDER BY updatedAt DESC`).all()
      .map((r) => JSON.parse(r.data));
  }
  deleteAnswer(key) { this.db.prepare(`DELETE FROM qa WHERE key = ?`).run(key); }

  // ===== Recommendations =====
  saveRecommendations(items) {
    const tx = this.db.transaction((rows) => {
      this.db.prepare(`DELETE FROM recommendations`).run();
      const now = new Date().toISOString();
      const ins = this.db.prepare(`INSERT INTO recommendations (id, createdAt, data) VALUES (?, ?, ?)`);
      for (const item of rows) {
        const id = uuid();
        ins.run(id, now, JSON.stringify({ id, createdAt: now, ...item }));
      }
    });
    tx(items || []);
  }
  listRecommendations() {
    return this.db.prepare(`SELECT data FROM recommendations ORDER BY createdAt DESC`).all()
      .map((r) => JSON.parse(r.data));
  }

  // ===== Settings (KV) =====
  getSettings() {
    const r = this.db.prepare(`SELECT v FROM settings WHERE k = 'jat5.settings'`).get();
    const stored = r ? JSON.parse(r.v) : {};
    return { ...DEFAULT_SETTINGS, ...stored };
  }
  patchSettings(patch) {
    const next = { ...this.getSettings(), ...(patch || {}) };
    this.db.prepare(`INSERT INTO settings (k, v) VALUES ('jat5.settings', ?)
                     ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
      .run(JSON.stringify(next));
    return next;
  }

  // ===== Profile (default) — backed by the default row in `profiles` =====
  _defaultProfileRow() {
    return this.db.prepare(`SELECT id, data FROM profiles WHERE isDefault = 1 LIMIT 1`).get();
  }
  getProfile() {
    const r = this._defaultProfileRow();
    const stored = r ? JSON.parse(r.data) : {};
    return {
      ...DEFAULT_PROFILE,
      ...stored,
      customAnswers: { ...(stored?.customAnswers || {}) }
    };
  }
  patchProfile(patch) {
    const cur = this.getProfile();
    const next = { ...cur, ...(patch || {}) };
    if (patch?.customAnswers) next.customAnswers = { ...cur.customAnswers, ...patch.customAnswers };
    const r = this._defaultProfileRow();
    if (r) {
      this.db.prepare(`UPDATE profiles SET data = ?, updatedAt = ? WHERE id = ?`)
        .run(JSON.stringify(next), new Date().toISOString(), r.id);
    } else {
      const now = new Date().toISOString();
      this.db.prepare(
        `INSERT INTO profiles (id, name, isDefault, sourceAssignments, data, createdAt, updatedAt)
         VALUES (?, 'Default', 1, '{}', ?, ?, ?)`
      ).run(uuid(), JSON.stringify(next), now, now);
    }
    return next;
  }

  // ===== Named profiles =====
  listProfiles() {
    return this.db.prepare(`SELECT id, name, isDefault, sourceAssignments, data, createdAt, updatedAt FROM profiles`)
      .all().map((r) => ({
        id: r.id, name: r.name, isDefault: !!r.isDefault,
        sourceAssignments: JSON.parse(r.sourceAssignments || '{}'),
        data: { ...DEFAULT_PROFILE, ...JSON.parse(r.data || '{}') },
        createdAt: r.createdAt, updatedAt: r.updatedAt
      }));
  }
  createProfile({ name, data, sourceAssignments }) {
    const id = uuid();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO profiles (id, name, isDefault, sourceAssignments, data, createdAt, updatedAt)
       VALUES (?, ?, 0, ?, ?, ?, ?)`
    ).run(id, name || 'Profile',
          JSON.stringify(sourceAssignments || {}),
          JSON.stringify({ ...DEFAULT_PROFILE, ...(data || {}) }),
          now, now);
    return this.db.prepare(`SELECT id, name, isDefault, sourceAssignments, data, createdAt, updatedAt FROM profiles WHERE id = ?`).get(id);
  }
  patchProfileById(id, patch) {
    const r = this.db.prepare(`SELECT name, isDefault, sourceAssignments, data FROM profiles WHERE id = ?`).get(id);
    if (!r) return null;
    const next = {
      name: patch?.name ?? r.name,
      isDefault: patch?.isDefault != null ? (patch.isDefault ? 1 : 0) : r.isDefault,
      sourceAssignments: JSON.stringify(patch?.sourceAssignments ?? JSON.parse(r.sourceAssignments || '{}')),
      data: JSON.stringify({ ...JSON.parse(r.data || '{}'), ...(patch?.data || {}) }),
      updatedAt: new Date().toISOString()
    };
    if (next.isDefault) {
      // Only one default at a time.
      this.db.prepare(`UPDATE profiles SET isDefault = 0 WHERE id != ?`).run(id);
    }
    this.db.prepare(
      `UPDATE profiles SET name = ?, isDefault = ?, sourceAssignments = ?, data = ?, updatedAt = ? WHERE id = ?`
    ).run(next.name, next.isDefault, next.sourceAssignments, next.data, next.updatedAt, id);
    return this.db.prepare(`SELECT id, name, isDefault, sourceAssignments, data, createdAt, updatedAt FROM profiles WHERE id = ?`).get(id);
  }
  deleteProfile(id) {
    const r = this.db.prepare(`SELECT isDefault FROM profiles WHERE id = ?`).get(id);
    if (!r) return false;
    if (r.isDefault) return false; // Refuse — caller must promote another first.
    this.db.prepare(`DELETE FROM profiles WHERE id = ?`).run(id);
    return true;
  }

  // ===== Sync helpers =====
  // Bulk import an extension snapshot ({ jobs: [...], documents: [...], qa: [...], ... }).
  // Strategy: upsert by primary key. Newer updatedAt wins on jobs.
  importSnapshot(snap) {
    const tx = this.db.transaction(() => {
      if (Array.isArray(snap.jobs)) {
        for (const j of snap.jobs) {
          if (!j || !j.id) continue;
          const existing = this.getJob(j.id);
          if (!existing || (j.updatedAt || '') >= (existing.updatedAt || '')) this.putJob(j);
        }
      }
      if (Array.isArray(snap.qa)) {
        for (const e of snap.qa) {
          if (!e || !e.key) continue;
          this.db.prepare(`INSERT INTO qa (key, updatedAt, data) VALUES (?, ?, ?)
                           ON CONFLICT(key) DO UPDATE SET updatedAt = excluded.updatedAt, data = excluded.data`)
            .run(e.key, e.updatedAt || new Date().toISOString(), JSON.stringify(e));
        }
      }
      if (snap.profile) this.patchProfile(snap.profile);
      if (snap.settings) this.patchSettings(snap.settings);
    });
    tx();
    return { ok: true };
  }
  exportSnapshot() {
    return {
      jobs: this.listJobs(),
      documents: this.listDocuments().map((d) => ({ ...d, data: undefined })), // metadata only, files stay server-side
      qa: this.listAnswers(),
      profile: this.getProfile(),
      settings: this.getSettings(),
      recommendations: this.listRecommendations()
    };
  }

  close() { this.db.close(); }
}

module.exports = { JatDb, DEFAULT_SETTINGS, DEFAULT_PROFILE, uuid, normalizeQuestion };
