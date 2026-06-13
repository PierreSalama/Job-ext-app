// JAT v11 — SQLite store (node-sqlite3-wasm).
// File: userData/jat.db. All access goes through this module; the extension
// and both dashboard hosts talk to it via the REST server only.
//
// Engine choice: node-sqlite3-wasm = real SQLite compiled to WASM with
// synchronous file-backed I/O and ZERO native compilation. better-sqlite3
// required the ClangCL MSVC toolset for Electron-ABI rebuilds (MSB8020 on
// this machine, and a per-Electron-version rebuild treadmill on CI). At
// personal-tracker scale the WASM engine is more than fast enough, and the
// entire native-build failure class disappears.
//
// Design notes:
//  • Versioned migrations via PRAGMA user_version; pre-upgrade backup copy.
//  • Dedup via normalized columns (norm_key, job_url_norm) with indexes.
//  • upsertJob is forward-only on status (pipeline); patchJob (manual) can
//    move anywhere and distinguishes null (clear) from undefined (keep).
//  • All SQL uses positional '?' params (wasm driver's safest binding mode).

const { Database } = require('node-sqlite3-wasm');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DEFAULTS } = require('./config');
const { scope } = require('./logger');

const log = scope('db');

// ---- Status FSM (mirror of extension/lib/status.js — keep in lockstep) ----
const STATUS_ORDER = {
  started: 10, submitted: 20, contacted: 30,
  interview_1: 40, interview_2: 50, interview_final: 60,
  offer: 70, hired: 80,
  rejected: 90, withdrawn: 91, ghosted: 92,
};
const TERMINAL = new Set(['hired', 'rejected', 'withdrawn', 'ghosted']);

const QUEUE_STATES = new Set([
  'queued', 'scheduled', 'running', 'awaiting_review', 'awaiting_input',
  'done', 'failed', 'skipped',
]);

function uid(prefix) { return `${prefix}_${crypto.randomUUID()}`; }
function now() { return new Date().toISOString(); }
function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const KEEP_PARAMS = new Set(['currentjobid', 'jk', 'gh_jid', 'ashby_jid', 'jobid', 'job_id']);
function normJobUrl(raw) {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const keep = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (KEEP_PARAMS.has(k.toLowerCase())) keep.set(k.toLowerCase(), v);
    }
    const q = keep.toString();
    return (u.origin + u.pathname.replace(/\/+$/, '')).toLowerCase() + (q ? `?${q}` : '');
  } catch { return String(raw).toLowerCase(); }
}

function safeParse(json, fallback) {
  if (json == null || json === '') return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}

function deepMerge(base, over) {
  if (over === undefined) return base;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return over;
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

let db = null;
let userDir = null;

// ---- thin driver helpers (positional params only) ----
// Guard against use after close() (e.g. an in-flight gmail tick racing
// will-quit) — fail loudly rather than dereferencing a null handle.
function run(sql, params = []) { if (!db) throw new Error('database is closed'); return db.run(sql, params); }
function get(sql, params = []) { if (!db) throw new Error('database is closed'); return db.get(sql, params); }
function all(sql, params = []) { if (!db) throw new Error('database is closed'); return db.all(sql, params); }
function exec(sql) { if (!db) throw new Error('database is closed'); return db.exec(sql); }

// Reentrant transaction: only the OUTERMOST call issues BEGIN/COMMIT/ROLLBACK.
// node-sqlite3-wasm throws on nested BEGIN, so this lets db helpers that each
// open a transaction (saveProfile, patchJob, …) be safely composed inside a
// larger one (server-side job+event atomicity, importAll, …).
let txDepth = 0;
function transaction(fn) {
  const outer = txDepth === 0;
  if (outer) exec('BEGIN');
  txDepth++;
  try {
    const r = fn();
    txDepth--;
    if (outer) exec('COMMIT');
    return r;
  } catch (e) {
    txDepth--;
    if (outer) { try { exec('ROLLBACK'); } catch {} }
    throw e;
  }
}

// ============================================================
// Migrations
// ============================================================
const MIGRATIONS = [
  // v1 — full v11 schema
  () => {
    exec(`
      CREATE TABLE jobs (
        id              TEXT PRIMARY KEY,
        external_id     TEXT,
        source          TEXT,
        status          TEXT NOT NULL,
        title           TEXT,
        company         TEXT,
        location        TEXT,
        job_url         TEXT,
        job_url_norm    TEXT,
        norm_key        TEXT,
        description     TEXT,
        compensation    TEXT,
        work_mode       TEXT,
        employment_type TEXT,
        attachments     TEXT,
        answers         TEXT,
        notes           TEXT,
        next_action     TEXT,
        due_at          TEXT,
        needs_review    INTEGER NOT NULL DEFAULT 0,
        fit_score       INTEGER,
        fit_data        TEXT,
        tags            TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        submitted_at    TEXT
      );
      CREATE INDEX idx_jobs_status   ON jobs(status);
      CREATE INDEX idx_jobs_external ON jobs(source, external_id);
      CREATE INDEX idx_jobs_updated  ON jobs(updated_at DESC);
      CREATE INDEX idx_jobs_normkey  ON jobs(norm_key);
      CREATE INDEX idx_jobs_urlnorm  ON jobs(job_url_norm);

      CREATE TABLE events (
        id        TEXT PRIMARY KEY,
        job_id    TEXT NOT NULL,
        type      TEXT NOT NULL,
        source    TEXT,
        timestamp TEXT NOT NULL,
        summary   TEXT,
        data      TEXT,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_events_job ON events(job_id, timestamp DESC);
      CREATE INDEX idx_events_ts  ON events(timestamp DESC);

      CREATE TABLE settings (
        section TEXT PRIMARY KEY,
        value   TEXT NOT NULL
      );

      CREATE TABLE qa (
        id            TEXT PRIMARY KEY,
        question_norm TEXT NOT NULL UNIQUE,
        question      TEXT NOT NULL,
        answer        TEXT NOT NULL,
        seen_count    INTEGER NOT NULL DEFAULT 1,
        sources       TEXT,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX idx_qa_norm ON qa(question_norm);

      CREATE TABLE profiles (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        is_default         INTEGER NOT NULL DEFAULT 0,
        source_assignments TEXT,
        data               TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );

      CREATE TABLE documents (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        role         TEXT NOT NULL DEFAULT 'resume',
        file_path    TEXT NOT NULL,
        text_content TEXT,
        size_bytes   INTEGER NOT NULL DEFAULT 0,
        mime         TEXT,
        is_default   INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL
      );

      CREATE TABLE auto_apply_tasks (
        id           TEXT PRIMARY KEY,
        job_id       TEXT NOT NULL,
        state        TEXT NOT NULL DEFAULT 'queued',
        mode         TEXT NOT NULL DEFAULT 'review',
        scheduled_at TEXT,
        attempts     INTEGER NOT NULL DEFAULT 0,
        last_error   TEXT,
        transcript   TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_queue_state ON auto_apply_tasks(state, scheduled_at);

      CREATE TABLE ai_log (
        id             TEXT PRIMARY KEY,
        ts             TEXT NOT NULL,
        provider       TEXT,
        model          TEXT,
        kind           TEXT,
        ms             INTEGER,
        ok             INTEGER NOT NULL DEFAULT 1,
        error          TEXT,
        prompt_chars   INTEGER,
        response_chars INTEGER
      );
      CREATE INDEX idx_ailog_ts ON ai_log(ts DESC);

      CREATE TABLE kv (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  },
];

function userVersion() {
  const r = get('PRAGMA user_version');
  return r ? (r.user_version ?? Object.values(r)[0] ?? 0) : 0;
}

function runMigrations() {
  const current = userVersion();
  if (current >= MIGRATIONS.length) return;
  for (let v = current; v < MIGRATIONS.length; v++) {
    if (v > 0) backupNow(`pre-v${v + 1}`);
    transaction(() => {
      MIGRATIONS[v]();
      exec('PRAGMA user_version = ' + String(v + 1));
    });
    log.info(`migrated schema → v${v + 1}`);
  }
}

// ============================================================
// Open / close / backup
// ============================================================
function open(userDataDir) {
  if (db) return db;
  userDir = userDataDir;
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
  const file = path.join(userDataDir, 'jat.db');
  db = new Database(file);
  exec('PRAGMA foreign_keys = ON');
  runMigrations();
  log.info('opened', file);
  return db;
}

function close() {
  if (db) { try { db.close(); } catch {} db = null; }
}

function backupDir() {
  const dir = path.join(userDir, 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function backupNow(tag) {
  if (!db || !userDir) return null;
  const name = `jat-${tag || new Date().toISOString().slice(0, 10)}.db`;
  const dest = path.join(backupDir(), name);
  try {
    const escaped = (dest + '.tmp').replace(/'/g, "''");
    exec(`VACUUM INTO '${escaped}'`);
    if (fs.existsSync(dest)) fs.rmSync(dest);
    fs.renameSync(dest + '.tmp', dest);
    log.info('backup →', dest);
    return dest;
  } catch (e) {
    try { fs.rmSync(dest + '.tmp', { force: true }); } catch {}
    log.error('backup failed', e.message);
    return null;
  }
}

function dailyBackup() {
  const keep = getSettings().backups.keep || 14;
  const today = new Date().toISOString().slice(0, 10);
  const dest = path.join(backupDir(), `jat-${today}.db`);
  if (!fs.existsSync(dest)) backupNow(today);
  const files = fs.readdirSync(backupDir())
    .filter((f) => /^jat-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  while (files.length > keep) {
    const victim = files.shift();
    try { fs.rmSync(path.join(backupDir(), victim)); } catch {}
  }
}

// ============================================================
// Settings
// ============================================================
function getSettings() {
  const rows = db ? all('SELECT section, value FROM settings') : [];
  const stored = {};
  for (const r of rows) stored[r.section] = safeParse(r.value, {});
  const merged = {};
  for (const k of Object.keys(DEFAULTS)) merged[k] = deepMerge(DEFAULTS[k], stored[k]);
  return merged;
}

function patchSettings(patch) {
  transaction(() => {
    for (const [section, value] of Object.entries(patch || {})) {
      if (!(section in DEFAULTS)) continue;
      const cur = safeParse(get('SELECT value FROM settings WHERE section = ?', [section])?.value, {});
      const next = deepMerge(cur, value);
      run('INSERT INTO settings (section, value) VALUES (?, ?) ' +
          'ON CONFLICT(section) DO UPDATE SET value = excluded.value',
          [section, JSON.stringify(next)]);
    }
  });
  return getSettings();
}

// ---- kv ----
function kvGet(key) {
  if (!db) return null;
  const r = get('SELECT value FROM kv WHERE key = ?', [key]);
  return r ? safeParse(r.value, null) : null;
}
function kvSet(key, value) {
  if (!db) return;
  run('INSERT INTO kv (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, JSON.stringify(value)]);
}

// ============================================================
// Jobs
// ============================================================
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
    attachments: safeParse(row.attachments, []),
    answers: safeParse(row.answers, {}),
    notes: row.notes || '',
    nextAction: row.next_action || '',
    dueAt: row.due_at || null,
    needsReview: !!row.needs_review,
    fitScore: row.fit_score ?? null,
    fitData: safeParse(row.fit_data, null),
    tags: safeParse(row.tags, []),
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
    data: safeParse(row.data, null),
  };
}

function findExisting({ externalId, source, jobUrl, title, company }) {
  if (externalId && source) {
    const r = get('SELECT * FROM jobs WHERE source = ? AND external_id = ? LIMIT 1', [source, externalId]);
    if (r) return r;
  }
  const urlNorm = normJobUrl(jobUrl);
  if (urlNorm) {
    const r = get('SELECT * FROM jobs WHERE job_url_norm = ? LIMIT 1', [urlNorm]);
    if (r) return r;
  }
  if (title && company) {
    const r = get('SELECT * FROM jobs WHERE norm_key = ? LIMIT 1', [normKey(title) + '|' + normKey(company)]);
    if (r) return r;
  }
  return null;
}

function elevatedStatus(current, incoming) {
  const co = STATUS_ORDER[current] || 0;
  const ino = STATUS_ORDER[incoming] || 0;
  if (TERMINAL.has(current)) return current;
  if (ino > co) return incoming;
  return current;
}

function crossedSubmitted(prev, incoming) {
  return (STATUS_ORDER[incoming] || 0) >= STATUS_ORDER.submitted
      && (STATUS_ORDER[prev] || 0) < STATUS_ORDER.submitted;
}

function mergeAttachments(prev, incoming) {
  const seen = new Set((prev || []).map((a) => `${a.role}|${a.name}`));
  const out = [...(prev || [])];
  for (const a of incoming || []) {
    const k = `${a.role}|${a.name}`;
    if (!seen.has(k)) { out.push(a); seen.add(k); }
  }
  return out;
}

function listJobs({ status, source, needsReview, q, limit, offset } = {}) {
  let sql = 'SELECT * FROM jobs WHERE 1=1';
  const args = [];
  if (status) { sql += ' AND status = ?'; args.push(status); }
  if (source) { sql += ' AND source = ?'; args.push(source); }
  if (needsReview !== undefined) { sql += ' AND needs_review = ?'; args.push(needsReview ? 1 : 0); }
  if (q) {
    sql += ' AND (title LIKE ? OR company LIKE ? OR location LIKE ? OR notes LIKE ?)';
    const like = `%${q}%`;
    args.push(like, like, like, like);
  }
  sql += ' ORDER BY updated_at DESC';
  const lim = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 0;
  if (lim) { sql += ' LIMIT ?'; args.push(lim); }
  const off = Number.isFinite(Number(offset)) && Number(offset) > 0 ? Number(offset) : 0;
  if (lim && off) { sql += ' OFFSET ?'; args.push(off); }
  return all(sql, args).map(rowToJob);
}

function getJob(id) {
  return rowToJob(get('SELECT * FROM jobs WHERE id = ?', [id]));
}

function listEvents(jobId, limit = 200) {
  const lim = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 200;
  return all('SELECT * FROM events WHERE job_id = ? ORDER BY timestamp DESC LIMIT ?', [jobId, lim])
    .map(rowToEvent);
}

function listRecentEvents(limit = 100) {
  const lim = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 100;
  return all('SELECT * FROM events ORDER BY timestamp DESC LIMIT ?', [lim]).map(rowToEvent);
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
  run(`INSERT INTO events (id, job_id, type, source, timestamp, summary, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ev.id, ev.job_id, ev.type, ev.source, ev.timestamp, ev.summary, ev.data]);
  return rowToEvent(ev);
}

// upsertJob — pipeline + manual create. opts.manual=true bypasses dedup.
function upsertJob(input, opts = {}) {
  const incoming = {
    externalId: input.externalId || null,
    source: input.source || null,
    title: String(input.title || '').slice(0, 300),
    company: String(input.company || '').slice(0, 300),
    location: String(input.location || '').slice(0, 300),
    jobUrl: String(input.jobUrl || '').slice(0, 2000),
    description: String(input.description || '').slice(0, 16000),
    compensation: String(input.compensation || '').slice(0, 300),
    workMode: String(input.workMode || '').slice(0, 100),
    employmentType: String(input.employmentType || '').slice(0, 100),
    status: STATUS_ORDER[input.status] ? input.status : 'started',
    attachments: Array.isArray(input.attachments) ? input.attachments : null,
    answers: (input.answers && typeof input.answers === 'object') ? input.answers : null,
    notes: input.notes !== undefined ? String(input.notes || '') : undefined,
    nextAction: input.nextAction !== undefined ? String(input.nextAction || '') : undefined,
    dueAt: input.dueAt !== undefined ? (input.dueAt || null) : undefined,
    needsReview: !!input.needsReview,
    tags: Array.isArray(input.tags) ? input.tags : undefined,
  };

  const existing = opts.manual ? null : findExisting(incoming);
  const ts = now();

  if (!existing) {
    const id = uid('job');
    run(`INSERT INTO jobs (
      id, external_id, source, status, title, company, location, job_url,
      job_url_norm, norm_key, description, compensation, work_mode, employment_type,
      attachments, answers, notes, next_action, due_at, needs_review, tags,
      created_at, updated_at, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, incoming.externalId, incoming.source, incoming.status,
      incoming.title, incoming.company, incoming.location, incoming.jobUrl,
      normJobUrl(incoming.jobUrl) || null,
      (incoming.title && incoming.company) ? normKey(incoming.title) + '|' + normKey(incoming.company) : null,
      incoming.description, incoming.compensation, incoming.workMode, incoming.employmentType,
      incoming.attachments ? JSON.stringify(incoming.attachments) : null,
      incoming.answers ? JSON.stringify(incoming.answers) : null,
      incoming.notes ?? '', incoming.nextAction ?? '', incoming.dueAt ?? null,
      incoming.needsReview ? 1 : 0,
      incoming.tags ? JSON.stringify(incoming.tags) : null,
      ts, ts,
      incoming.status === 'submitted' ? ts : null,
    ]);
    return { job: getJob(id), action: 'created', previousStatus: null, statusChanged: true };
  }

  const prev = rowToJob(existing);
  let action = 'updated';
  let nextStatus = elevatedStatus(prev.status, incoming.status);

  // Re-application: a fresh pipeline capture against a terminal job re-opens it.
  if (TERMINAL.has(prev.status) && !opts.manual && input._source === 'extension'
      && (STATUS_ORDER[incoming.status] || 0) <= STATUS_ORDER.submitted) {
    nextStatus = incoming.status;
    action = 'reopened';
  }

  const title = incoming.title || prev.title;
  const company = incoming.company || prev.company;
  const jobUrl = incoming.jobUrl || prev.jobUrl;

  run(`UPDATE jobs SET
    title=?, company=?, location=?, job_url=?, job_url_norm=?, norm_key=?,
    description=?, compensation=?, work_mode=?, employment_type=?,
    external_id=?, source=?, status=?, attachments=?, answers=?,
    notes=?, next_action=?, due_at=?, needs_review=?, tags=?,
    updated_at=?, submitted_at=?
    WHERE id=?`,
  [
    title, company,
    incoming.location || prev.location,
    jobUrl,
    normJobUrl(jobUrl) || null,
    (title && company) ? normKey(title) + '|' + normKey(company) : null,
    incoming.description || prev.description,
    incoming.compensation || prev.compensation,
    incoming.workMode || prev.workMode,
    incoming.employmentType || prev.employmentType,
    incoming.externalId || prev.externalId,
    incoming.source || prev.source,
    nextStatus,
    incoming.attachments
      ? JSON.stringify(mergeAttachments(prev.attachments, incoming.attachments))
      : (prev.attachments?.length ? JSON.stringify(prev.attachments) : null),
    incoming.answers
      ? JSON.stringify({ ...prev.answers, ...incoming.answers })
      : (Object.keys(prev.answers || {}).length ? JSON.stringify(prev.answers) : null),
    incoming.notes !== undefined ? incoming.notes : prev.notes,
    incoming.nextAction !== undefined ? incoming.nextAction : prev.nextAction,
    incoming.dueAt !== undefined ? incoming.dueAt : prev.dueAt,
    incoming.needsReview ? 1 : (prev.needsReview ? 1 : 0),
    incoming.tags ? JSON.stringify(incoming.tags)
                  : (prev.tags?.length ? JSON.stringify(prev.tags) : null),
    ts,
    prev.submittedAt || (crossedSubmitted(prev.status, nextStatus) ? ts : null),
    existing.id,
  ]);

  const after = getJob(existing.id);
  return {
    job: after,
    action,
    previousStatus: prev.status,
    statusChanged: prev.status !== after.status,
  };
}

// patchJob — manual edits. null clears; undefined keeps.
// Wrapped in a (reentrant) transaction so the read-modify-read cycle is atomic
// against concurrent writers (dashboard + extension + gmail can all PATCH).
function patchJob(id, patch) {
  return transaction(() => patchJobInner(id, patch));
}
function patchJobInner(id, patch) {
  const cur = getJob(id);
  if (!cur) return null;
  const ts = now();
  const pick = (key, curVal) => {
    if (!(key in patch)) return curVal;
    return patch[key] === null ? '' : patch[key];
  };
  const title = pick('title', cur.title);
  const company = pick('company', cur.company);
  const jobUrl = pick('jobUrl', cur.jobUrl);
  const status = STATUS_ORDER[patch.status] ? patch.status : cur.status;
  const fitData = ('fitData' in patch) ? patch.fitData : cur.fitData;
  const tags = ('tags' in patch) ? patch.tags : cur.tags;

  run(`UPDATE jobs SET
    title=?, company=?, location=?, job_url=?, job_url_norm=?, norm_key=?,
    description=?, compensation=?, work_mode=?, employment_type=?, source=?,
    status=?, notes=?, next_action=?, due_at=?, needs_review=?,
    fit_score=?, fit_data=?, tags=?, submitted_at=?, updated_at=?
    WHERE id=?`,
  [
    title, company,
    pick('location', cur.location),
    jobUrl,
    normJobUrl(jobUrl) || null,
    (title && company) ? normKey(title) + '|' + normKey(company) : null,
    pick('description', cur.description),
    pick('compensation', cur.compensation),
    pick('workMode', cur.workMode),
    pick('employmentType', cur.employmentType),
    pick('source', cur.source),
    status,
    pick('notes', cur.notes),
    pick('nextAction', cur.nextAction),
    ('dueAt' in patch) ? (patch.dueAt || null) : cur.dueAt,
    ('needsReview' in patch) ? (patch.needsReview ? 1 : 0) : (cur.needsReview ? 1 : 0),
    ('fitScore' in patch) ? patch.fitScore : cur.fitScore,
    fitData ? JSON.stringify(fitData) : null,
    (Array.isArray(tags) && tags.length) ? JSON.stringify(tags) : null,
    (patch.status && crossedSubmitted(cur.status, patch.status) && !cur.submittedAt) ? ts : cur.submittedAt,
    ts,
    id,
  ]);
  return { job: getJob(id), previousStatus: cur.status, statusChanged: cur.status !== status };
}

function deleteJob(id) {
  const r = run('DELETE FROM jobs WHERE id = ?', [id]);
  return (r?.changes ?? 0) > 0;
}

function stats() {
  const rows = all('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status');
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = r.n;
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const weekAgo = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  const thisWeek = get('SELECT COUNT(*) AS n FROM jobs WHERE created_at >= ?', [weekAgo]).n;
  const needsReview = get('SELECT COUNT(*) AS n FROM jobs WHERE needs_review = 1').n;
  const bySource = {};
  for (const r of all('SELECT source, COUNT(*) AS n FROM jobs GROUP BY source')) {
    bySource[r.source || 'unknown'] = r.n;
  }
  return { total, thisWeek, needsReview, byStatus, bySource };
}

// ============================================================
// QA (learned answers)
// ============================================================
const QA_FILLERS = /\b(please|kindly|select|choose|enter|provide|specify|the|a|an|your|you|do|did|does|are|is|have|has|had|will|would|can|could|how|many|much|what|which|with|in|for|of|to|at|on)\b/g;
function normalizeQuestion(q) {
  return String(q || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(QA_FILLERS, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 120);
}

function qaRecord({ question, answer, source }) {
  const qn = normalizeQuestion(question);
  if (!qn || answer == null || answer === '') return null;
  const cur = get('SELECT * FROM qa WHERE question_norm = ?', [qn]);
  const ts = now();
  if (cur) {
    const sources = new Set(safeParse(cur.sources, []));
    if (source) sources.add(source);
    run('UPDATE qa SET answer = ?, seen_count = seen_count + 1, sources = ?, updated_at = ? WHERE id = ?',
        [String(answer).slice(0, 2000), JSON.stringify([...sources]), ts, cur.id]);
    return get('SELECT * FROM qa WHERE id = ?', [cur.id]);
  }
  const row = {
    id: uid('qa'), qn, question: String(question).slice(0, 500),
    answer: String(answer).slice(0, 2000),
    sources: JSON.stringify(source ? [source] : []), ts,
  };
  run(`INSERT INTO qa (id, question_norm, question, answer, seen_count, sources, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      [row.id, row.qn, row.question, row.answer, row.sources, row.ts]);
  return get('SELECT * FROM qa WHERE id = ?', [row.id]);
}

function qaLookup(question) {
  const qn = normalizeQuestion(question);
  if (!qn) return null;
  const exact = get('SELECT * FROM qa WHERE question_norm = ?', [qn]);
  if (exact) return { ...exact, match: 'exact', score: 1 };
  const want = new Set(qn.split(' ').filter(Boolean));
  if (!want.size) return null;
  let best = null;
  for (const row of all('SELECT * FROM qa')) {
    const have = new Set(row.question_norm.split(' ').filter(Boolean));
    let hit = 0;
    for (const t of want) if (have.has(t)) hit++;
    // Query-coverage scoring: a short query fully contained in a wordier
    // stored question is a match. Require ≥2 shared tokens to avoid
    // single-word coincidences, falling back to symmetric overlap.
    const coverage = hit / want.size;
    const symmetric = hit / Math.max(want.size, have.size);
    const score = (hit >= 2 && coverage >= 0.75) ? coverage : symmetric;
    if (score >= 0.6 && (!best || score > best.score)) best = { ...row, match: 'fuzzy', score };
  }
  return best;
}

function qaList(limit = 500) {
  return all('SELECT * FROM qa ORDER BY updated_at DESC LIMIT ?', [limit]);
}
function qaDelete(id) { return (run('DELETE FROM qa WHERE id = ?', [id])?.changes ?? 0) > 0; }

// ============================================================
// Profiles
// ============================================================
function listProfiles() {
  return all('SELECT * FROM profiles ORDER BY is_default DESC, name')
    .map((r) => ({
      id: r.id, name: r.name, isDefault: !!r.is_default,
      sourceAssignments: safeParse(r.source_assignments, []),
      data: safeParse(r.data, {}), updatedAt: r.updated_at,
    }));
}

function saveProfile({ id, name, isDefault, sourceAssignments, data }) {
  const ts = now();
  const savedId = transaction(() => {
    if (isDefault) run('UPDATE profiles SET is_default = 0');
    if (id && get('SELECT id FROM profiles WHERE id = ?', [id])) {
      run('UPDATE profiles SET name=?, is_default=?, source_assignments=?, data=?, updated_at=? WHERE id=?',
          [name || 'Profile', isDefault ? 1 : 0, JSON.stringify(sourceAssignments || []),
           JSON.stringify(data || {}), ts, id]);
      return id;
    }
    const nid = uid('prof');
    run('INSERT INTO profiles (id, name, is_default, source_assignments, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [nid, name || 'Profile', isDefault ? 1 : 0,
         JSON.stringify(sourceAssignments || []), JSON.stringify(data || {}), ts]);
    return nid;
  });
  return listProfiles().find((p) => p.id === savedId);
}

function deleteProfile(id) { return (run('DELETE FROM profiles WHERE id = ?', [id])?.changes ?? 0) > 0; }

function profileForSource(source) {
  const allP = listProfiles();
  if (!allP.length) return null;
  const norm = String(source || '').toLowerCase();
  return allP.find((p) => (p.sourceAssignments || []).some((s) => norm.includes(String(s).toLowerCase())))
      || allP.find((p) => p.isDefault)
      || allP[0];
}

// ============================================================
// Documents
// ============================================================
function docRow(r, { withText } = {}) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, role: r.role, filePath: r.file_path,
    hasText: !!r.text_content,
    textContent: withText ? (r.text_content || '') : undefined,
    sizeBytes: r.size_bytes, mime: r.mime, isDefault: !!r.is_default, createdAt: r.created_at,
  };
}

function listDocuments() {
  return all('SELECT * FROM documents ORDER BY is_default DESC, created_at DESC').map((r) => docRow(r));
}
function getDocument(id, opts = {}) {
  return docRow(get('SELECT * FROM documents WHERE id = ?', [id]), opts);
}
function addDocument({ name, role, filePath, textContent, sizeBytes, mime, isDefault }) {
  const id = uid('doc');
  transaction(() => {
    if (isDefault) run('UPDATE documents SET is_default = 0 WHERE role = ?', [role || 'resume']);
    run(`INSERT INTO documents (id, name, role, file_path, text_content, size_bytes, mime, is_default, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, name, role || 'resume', filePath, textContent || null,
         sizeBytes || 0, mime || '', isDefault ? 1 : 0, now()]);
  });
  return getDocument(id);
}
function patchDocument(id, { name, role, isDefault, textContent }) {
  const cur = get('SELECT * FROM documents WHERE id = ?', [id]);
  if (!cur) return null;
  transaction(() => {
    if (isDefault) run('UPDATE documents SET is_default = 0 WHERE role = ?', [role || cur.role]);
    run('UPDATE documents SET name=?, role=?, is_default=?, text_content=? WHERE id=?',
        [name ?? cur.name, role ?? cur.role,
         isDefault !== undefined ? (isDefault ? 1 : 0) : cur.is_default,
         textContent !== undefined ? textContent : cur.text_content, id]);
  });
  return getDocument(id);
}
function deleteDocument(id) {
  const cur = get('SELECT * FROM documents WHERE id = ?', [id]);
  if (!cur) return false;
  run('DELETE FROM documents WHERE id = ?', [id]);
  try { if (cur.file_path && fs.existsSync(cur.file_path)) fs.rmSync(cur.file_path); } catch {}
  return true;
}
function defaultDocument(role = 'resume') {
  const r = get('SELECT * FROM documents WHERE role = ? ORDER BY is_default DESC, created_at DESC LIMIT 1', [role]);
  return r ? docRow(r, { withText: true }) : null;
}

// ============================================================
// Auto-apply queue
// ============================================================
function rowToTask(r) {
  if (!r) return null;
  return {
    id: r.id, jobId: r.job_id, state: r.state, mode: r.mode,
    scheduledAt: r.scheduled_at, attempts: r.attempts, lastError: r.last_error,
    transcript: safeParse(r.transcript, []),
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function queueList({ state } = {}) {
  let sql = `SELECT t.*, j.title AS _title, j.company AS _company, j.job_url AS _url, j.source AS _src
             FROM auto_apply_tasks t JOIN jobs j ON j.id = t.job_id`;
  const args = [];
  if (state) { sql += ' WHERE t.state = ?'; args.push(state); }
  sql += ' ORDER BY t.created_at DESC';
  return all(sql, args).map((r) => ({
    ...rowToTask(r),
    job: { title: r._title, company: r._company, jobUrl: r._url, source: r._src },
  }));
}

function queueAdd(jobId, { mode } = {}) {
  if (!getJob(jobId)) return null;
  const dup = get(
    `SELECT id FROM auto_apply_tasks WHERE job_id = ?
     AND state IN ('queued','scheduled','running','awaiting_review','awaiting_input') LIMIT 1`,
    [jobId]);
  if (dup) return rowToTask(get('SELECT * FROM auto_apply_tasks WHERE id = ?', [dup.id]));
  const id = uid('task');
  const ts = now();
  run(`INSERT INTO auto_apply_tasks (id, job_id, state, mode, created_at, updated_at)
       VALUES (?, ?, 'queued', ?, ?, ?)`,
      [id, jobId, mode === 'auto' ? 'auto' : 'review', ts, ts]);
  return rowToTask(get('SELECT * FROM auto_apply_tasks WHERE id = ?', [id]));
}

function queuePatch(id, { state, scheduledAt, lastError, transcriptAppend, attemptsDelta, mode }) {
  const cur = get('SELECT * FROM auto_apply_tasks WHERE id = ?', [id]);
  if (!cur) return null;
  if (state && !QUEUE_STATES.has(state)) return null;
  const transcript = safeParse(cur.transcript, []);
  if (transcriptAppend) {
    const items = Array.isArray(transcriptAppend) ? transcriptAppend : [transcriptAppend];
    for (const it of items) transcript.push({ ts: now(), ...((typeof it === 'object') ? it : { note: String(it) }) });
  }
  run(`UPDATE auto_apply_tasks SET
       state = ?, mode = ?, scheduled_at = ?, attempts = attempts + ?, last_error = ?,
       transcript = ?, updated_at = ? WHERE id = ?`,
      [state || cur.state,
       mode || cur.mode,
       scheduledAt !== undefined ? scheduledAt : cur.scheduled_at,
       attemptsDelta || 0,
       lastError !== undefined ? lastError : cur.last_error,
       JSON.stringify(transcript.slice(-200)),
       now(), id]);
  return rowToTask(get('SELECT * FROM auto_apply_tasks WHERE id = ?', [id]));
}

function queueDelete(id) {
  return (run('DELETE FROM auto_apply_tasks WHERE id = ?', [id])?.changes ?? 0) > 0;
}

function queueRunStats() {
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const doneDay = get(
    `SELECT COUNT(*) AS n FROM auto_apply_tasks WHERE state IN ('done','awaiting_review') AND updated_at >= ?`,
    [dayAgo]).n;
  const doneHour = get(
    `SELECT COUNT(*) AS n FROM auto_apply_tasks WHERE state IN ('done','awaiting_review') AND updated_at >= ?`,
    [hourAgo]).n;
  const lastRun = get(
    `SELECT MAX(updated_at) AS t FROM auto_apply_tasks WHERE state IN ('done','awaiting_review','failed')`).t;
  return { doneDay, doneHour, lastRun };
}

// ============================================================
// AI log
// ============================================================
function aiLog(entry) {
  run(`INSERT INTO ai_log (id, ts, provider, model, kind, ms, ok, error, prompt_chars, response_chars)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uid('ai'), now(), entry.provider || '', entry.model || '', entry.kind || '',
       entry.ms || 0, entry.ok ? 1 : 0, entry.error || null,
       entry.promptChars || 0, entry.responseChars || 0]);
}
function aiLogList(limit = 100) {
  return all('SELECT * FROM ai_log ORDER BY ts DESC LIMIT ?', [limit]);
}
function aiUsage() {
  return all(`SELECT provider, COUNT(*) AS calls, SUM(ms) AS total_ms,
              SUM(ok) AS ok_calls FROM ai_log GROUP BY provider`);
}

// ============================================================
// Export / import
// ============================================================
function exportAll() {
  return {
    exportedAt: now(),
    schema: userVersion(),
    jobs: listJobs(),
    events: all('SELECT * FROM events').map(rowToEvent),
    settings: getSettings(),
    qa: qaList(100000),
    profiles: listProfiles(),
    documents: listDocuments(),
    queue: queueList(),
  };
}

function importAll(payload) {
  let jobs = 0, events = 0, qa = 0;
  transaction(() => {
    for (const j of payload.jobs || []) { upsertJob(j); jobs++; }
    for (const e of payload.events || []) {
      if (e.jobId && getJob(e.jobId)) { recordEvent(e); events++; }
    }
    for (const q of payload.qa || []) {
      if (q.question && q.answer) { qaRecord({ question: q.question, answer: q.answer }); qa++; }
    }
  });
  return { jobs, events, qa };
}

module.exports = {
  open, close, backupNow, dailyBackup, transaction,
  getSettings, patchSettings, kvGet, kvSet,
  listJobs, getJob, upsertJob, patchJob, deleteJob, stats,
  listEvents, listRecentEvents, recordEvent,
  qaRecord, qaLookup, qaList, qaDelete, normalizeQuestion,
  listProfiles, saveProfile, deleteProfile, profileForSource,
  listDocuments, getDocument, addDocument, patchDocument, deleteDocument, defaultDocument,
  queueList, queueAdd, queuePatch, queueDelete, queueRunStats,
  aiLog, aiLogList, aiUsage,
  exportAll, importAll,
  STATUS_ORDER, TERMINAL, normJobUrl, normKey,
};
