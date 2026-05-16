// JAT v10 desktop companion — SQLite store.
// File lives at app.getPath('userData')/jat.db. Two tables: `jobs` and
// `events`. The extension and the dashboard both talk to this DB through
// localhost:7744 — never directly. Forward-only status elevation is enforced
// here in upsertJob so the same logic runs whether the write comes from a
// content-script capture or a manual dashboard edit.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ---- Status FSM (mirror of extension/lib/status.js) ----
const STATUS_ORDER = {
  started: 10, submitted: 20, contacted: 30,
  interview_1: 40, interview_2: 50, interview_final: 60,
  offer: 70, hired: 80,
  rejected: 90, withdrawn: 91, ghosted: 92,
};
const TERMINAL = new Set(['hired', 'rejected', 'withdrawn', 'ghosted']);

function uid(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}
function now() { return new Date().toISOString(); }

function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

let db = null;

function open(userDataDir) {
  if (db) return db;
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  const file = path.join(userDataDir, 'jat.db');
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id              TEXT PRIMARY KEY,
      external_id     TEXT,
      source          TEXT,
      status          TEXT NOT NULL,
      title           TEXT,
      company         TEXT,
      location        TEXT,
      job_url         TEXT,
      description     TEXT,
      compensation    TEXT,
      work_mode       TEXT,
      employment_type TEXT,
      attachments     TEXT,           -- JSON array
      answers         TEXT,           -- JSON object
      notes           TEXT,
      next_action     TEXT,
      due_at          TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      submitted_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status   ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_external ON jobs(source, external_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_updated  ON jobs(updated_at DESC);

    CREATE TABLE IF NOT EXISTS events (
      id        TEXT PRIMARY KEY,
      job_id    TEXT NOT NULL,
      type      TEXT NOT NULL,
      source    TEXT,
      timestamp TEXT NOT NULL,
      summary   TEXT,
      data      TEXT,
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id, timestamp DESC);
  `);
  console.log('[jat10:db] opened', file);
  return db;
}

function close() {
  if (db) { try { db.close(); } catch {} db = null; }
}

// ---- Row mapping ----
function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    externalId: row.external_id || null,
    source: row.source || null,
    status: row.status,
    title: row.title || '',
    company: row.company || '',
    location: row.location || '',
    jobUrl: row.job_url || '',
    description: row.description || '',
    compensation: row.compensation || '',
    workMode: row.work_mode || '',
    employmentType: row.employment_type || '',
    attachments: row.attachments ? JSON.parse(row.attachments) : [],
    answers: row.answers ? JSON.parse(row.answers) : {},
    notes: row.notes || '',
    nextAction: row.next_action || '',
    dueAt: row.due_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at || null,
  };
}
function rowToEvent(row) {
  if (!row) return null;
  return {
    id: row.id, jobId: row.job_id, type: row.type, source: row.source,
    timestamp: row.timestamp, summary: row.summary,
    data: row.data ? JSON.parse(row.data) : null,
  };
}

// ---- Dedup lookup ----
// 4-point match, in order of strength.
function findExisting({ externalId, source, jobUrl, title, company }) {
  if (externalId && source) {
    const r = db.prepare('SELECT * FROM jobs WHERE source = ? AND external_id = ? LIMIT 1')
      .get(source, externalId);
    if (r) return r;
  }
  if (jobUrl) {
    const r = db.prepare('SELECT * FROM jobs WHERE job_url = ? LIMIT 1').get(jobUrl);
    if (r) return r;
  }
  if (title && company) {
    const all = db.prepare('SELECT * FROM jobs').all();
    const want = normKey(title) + '|' + normKey(company);
    return all.find((r) => normKey(r.title) + '|' + normKey(r.company) === want) || null;
  }
  return null;
}

// ---- Status elevation ----
// Forward-only when called from the pipeline (extension captures). Manual
// edits from the dashboard go through patchJob and can move to any status.
function elevatedStatus(current, incoming) {
  const co = STATUS_ORDER[current] || 0;
  const ino = STATUS_ORDER[incoming] || 0;
  if (TERMINAL.has(current)) return current;       // never advance past terminal automatically
  if (ino > co) return incoming;
  return current;
}

// ---- Public API ----

function listJobs({ status, source, limit } = {}) {
  let sql = 'SELECT * FROM jobs WHERE 1=1';
  const args = [];
  if (status) { sql += ' AND status = ?'; args.push(status); }
  if (source) { sql += ' AND source = ?'; args.push(source); }
  sql += ' ORDER BY updated_at DESC';
  if (limit) { sql += ' LIMIT ?'; args.push(limit); }
  return db.prepare(sql).all(...args).map(rowToJob);
}

function getJob(id) {
  return rowToJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(id));
}

function listEvents(jobId, limit = 200) {
  return db.prepare('SELECT * FROM events WHERE job_id = ? ORDER BY timestamp DESC LIMIT ?')
    .all(jobId, limit).map(rowToEvent);
}

function recordEvent({ jobId, type, source, summary, data }) {
  const ev = {
    id: uid('evt'),
    job_id: jobId,
    type: String(type || 'note'),
    source: source || 'extension',
    timestamp: now(),
    summary: summary || '',
    data: data ? JSON.stringify(data) : null,
  };
  db.prepare(`INSERT INTO events (id, job_id, type, source, timestamp, summary, data)
              VALUES (@id, @job_id, @type, @source, @timestamp, @summary, @data)`).run(ev);
  return rowToEvent(ev);
}

// upsertJob: server-side dedup + forward-only status elevation.
// Returns { job, action: 'created'|'updated', previousStatus, statusChanged }
function upsertJob(input) {
  const incoming = {
    externalId: input.externalId || null,
    source: input.source || null,
    title: input.title || '',
    company: input.company || '',
    location: input.location || '',
    jobUrl: input.jobUrl || '',
    description: input.description || '',
    compensation: input.compensation || '',
    workMode: input.workMode || '',
    employmentType: input.employmentType || '',
    status: input.status || 'started',
    attachments: input.attachments || null,
    answers: input.answers || null,
  };

  const existing = findExisting(incoming);
  const ts = now();

  if (!existing) {
    // INSERT
    const id = uid('job');
    const submittedAt = incoming.status === 'submitted' ? ts : null;
    db.prepare(`INSERT INTO jobs (
      id, external_id, source, status, title, company, location, job_url,
      description, compensation, work_mode, employment_type,
      attachments, answers, created_at, updated_at, submitted_at
    ) VALUES (
      @id, @external_id, @source, @status, @title, @company, @location, @job_url,
      @description, @compensation, @work_mode, @employment_type,
      @attachments, @answers, @created_at, @updated_at, @submitted_at
    )`).run({
      id,
      external_id: incoming.externalId,
      source: incoming.source,
      status: incoming.status,
      title: incoming.title,
      company: incoming.company,
      location: incoming.location,
      job_url: incoming.jobUrl,
      description: incoming.description,
      compensation: incoming.compensation,
      work_mode: incoming.workMode,
      employment_type: incoming.employmentType,
      attachments: incoming.attachments ? JSON.stringify(incoming.attachments) : null,
      answers: incoming.answers ? JSON.stringify(incoming.answers) : null,
      created_at: ts,
      updated_at: ts,
      submitted_at: submittedAt,
    });
    return { job: getJob(id), action: 'created', previousStatus: null, statusChanged: true };
  }

  // UPDATE — merge non-empty incoming fields, elevate status forward
  const prev = rowToJob(existing);
  const merged = {
    title: incoming.title || prev.title,
    company: incoming.company || prev.company,
    location: incoming.location || prev.location,
    job_url: incoming.jobUrl || prev.jobUrl,
    description: incoming.description || prev.description,
    compensation: incoming.compensation || prev.compensation,
    work_mode: incoming.workMode || prev.workMode,
    employment_type: incoming.employmentType || prev.employmentType,
    external_id: incoming.externalId || prev.externalId,
    source: incoming.source || prev.source,
    status: elevatedStatus(prev.status, incoming.status),
    attachments: incoming.attachments
      ? JSON.stringify(mergeAttachments(prev.attachments, incoming.attachments))
      : (prev.attachments?.length ? JSON.stringify(prev.attachments) : null),
    answers: incoming.answers
      ? JSON.stringify({ ...prev.answers, ...incoming.answers })
      : (Object.keys(prev.answers || {}).length ? JSON.stringify(prev.answers) : null),
    updated_at: ts,
    submitted_at: prev.submittedAt || (merged_status_is_submitted(prev.status, incoming.status) ? ts : null),
    id: existing.id,
  };
  db.prepare(`UPDATE jobs SET
    title=@title, company=@company, location=@location, job_url=@job_url,
    description=@description, compensation=@compensation,
    work_mode=@work_mode, employment_type=@employment_type,
    external_id=@external_id, source=@source,
    status=@status, attachments=@attachments, answers=@answers,
    updated_at=@updated_at, submitted_at=@submitted_at
    WHERE id=@id`).run(merged);
  const after = getJob(existing.id);
  return {
    job: after,
    action: 'updated',
    previousStatus: prev.status,
    statusChanged: prev.status !== after.status,
  };
}

function merged_status_is_submitted(prev, incoming) {
  // First time we cross into 'submitted' or beyond, stamp submitted_at.
  return (STATUS_ORDER[incoming] || 0) >= STATUS_ORDER.submitted
      && (STATUS_ORDER[prev] || 0) < STATUS_ORDER.submitted;
}

function mergeAttachments(prev, incoming) {
  const seen = new Set((prev || []).map((a) => `${a.role}|${a.name}`));
  const out = [...(prev || [])];
  for (const a of incoming) {
    const k = `${a.role}|${a.name}`;
    if (!seen.has(k)) { out.push(a); seen.add(k); }
  }
  return out;
}

// patchJob: manual edits from the dashboard. Allows any status transition.
function patchJob(id, patch) {
  const cur = getJob(id);
  if (!cur) return null;
  const ts = now();
  const next = {
    title: patch.title ?? cur.title,
    company: patch.company ?? cur.company,
    location: patch.location ?? cur.location,
    job_url: patch.jobUrl ?? cur.jobUrl,
    description: patch.description ?? cur.description,
    compensation: patch.compensation ?? cur.compensation,
    work_mode: patch.workMode ?? cur.workMode,
    employment_type: patch.employmentType ?? cur.employmentType,
    status: patch.status ?? cur.status,
    notes: patch.notes ?? cur.notes,
    next_action: patch.nextAction ?? cur.nextAction,
    due_at: patch.dueAt ?? cur.dueAt,
    submitted_at: (
      patch.status && merged_status_is_submitted(cur.status, patch.status) && !cur.submittedAt
    ) ? ts : cur.submittedAt,
    updated_at: ts,
    id,
  };
  db.prepare(`UPDATE jobs SET
    title=@title, company=@company, location=@location, job_url=@job_url,
    description=@description, compensation=@compensation,
    work_mode=@work_mode, employment_type=@employment_type,
    status=@status, notes=@notes, next_action=@next_action, due_at=@due_at,
    submitted_at=@submitted_at, updated_at=@updated_at
    WHERE id=@id`).run(next);
  return { job: getJob(id), previousStatus: cur.status, statusChanged: cur.status !== next.status };
}

function deleteJob(id) {
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
}

function stats() {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all();
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = r.n;
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const weekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  const thisWeek = db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE created_at >= ?').get(weekAgo).n;
  return { total, thisWeek, byStatus };
}

module.exports = {
  open, close,
  listJobs, getJob, upsertJob, patchJob, deleteJob, stats,
  listEvents, recordEvent,
};
