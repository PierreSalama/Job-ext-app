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
  'parked', 'done', 'failed', 'skipped',
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

  // v2 — dynamic profile store + document indexing/folders
  () => {
    exec(`
      CREATE TABLE profile_fields (
        id            TEXT PRIMARY KEY,
        key_norm      TEXT NOT NULL UNIQUE,   -- canonical (EN+FR-collapsed) question key
        label         TEXT NOT NULL,          -- human label, original language
        locale        TEXT NOT NULL DEFAULT 'en',
        value         TEXT,
        field_type    TEXT,                   -- text | select | checkbox | …
        source_job_id TEXT,                   -- last application this came from
        source        TEXT,                   -- host/board it was learned on
        confidence    REAL NOT NULL DEFAULT 0.5,
        locked        INTEGER NOT NULL DEFAULT 0,  -- user edited → harvest won't overwrite
        seen_count    INTEGER NOT NULL DEFAULT 1,
        updated_at    TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX idx_pf_norm ON profile_fields(key_norm);

      CREATE TABLE document_folders (
        id            TEXT PRIMARY KEY,
        path          TEXT NOT NULL UNIQUE,
        label         TEXT,
        role_hint     TEXT,                   -- default role for files found here
        file_count    INTEGER NOT NULL DEFAULT 0,
        last_scan_at  TEXT,
        enabled       INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL
      );

      ALTER TABLE documents ADD COLUMN keywords      TEXT;     -- JSON array
      ALTER TABLE documents ADD COLUMN last_modified TEXT;     -- source file mtime
      ALTER TABLE documents ADD COLUMN indexed_at    TEXT;     -- when text/keywords computed
      ALTER TABLE documents ADD COLUMN folder_id     TEXT;     -- → document_folders.id
      ALTER TABLE documents ADD COLUMN source        TEXT;     -- upload | application | folder

      UPDATE documents SET role = 'cover_letter' WHERE role = 'coverLetter';
      UPDATE documents SET source = 'upload' WHERE source IS NULL;
    `);
  },

  // v3 — document designations + index ranking
  () => {
    exec(`
      ALTER TABLE documents ADD COLUMN label      TEXT;                       -- user designation ("Master CV")
      ALTER TABLE documents ADD COLUMN importance INTEGER NOT NULL DEFAULT 0; -- index ranking (folder scan)
    `);
  },

  // v4 — auto-apply self-healing: park metadata on a task
  () => {
    exec(`
      ALTER TABLE auto_apply_tasks ADD COLUMN park_reason       TEXT;   -- why it didn't go through
      ALTER TABLE auto_apply_tasks ADD COLUMN pending_questions TEXT;   -- JSON [{question,fieldType,options,reason}]
    `);
  },

  // v5 — email integration: a synced-emails table associated to jobs.
  () => {
    exec(`
      CREATE TABLE emails (
        id            TEXT PRIMARY KEY,
        account_id    TEXT NOT NULL,                 -- which connected mailbox
        provider      TEXT,                          -- gmail | outlook | yahoo | imap
        uid           INTEGER,                        -- IMAP UID (per account+folder) — dedup key
        message_id    TEXT,                           -- RFC822 Message-ID (cross-account dedup)
        thread_id     TEXT,
        from_addr     TEXT,
        from_name     TEXT,
        to_addr       TEXT,
        subject       TEXT,
        snippet       TEXT,                           -- short preview
        body          TEXT,                           -- plain-text body (capped)
        sent_at       TEXT,                           -- ISO; the email's Date
        category      TEXT,                           -- application_confirmation|recruiter|interview|offer|rejection|other
        matched_job_id   TEXT,                        -- the job this email belongs to (NULL = unmatched)
        match_confidence REAL DEFAULT 0,              -- 0..1
        match_source     TEXT,                        -- 'auto' | 'suggested' | 'manual' | 'dismissed'
        created_at    TEXT NOT NULL,
        FOREIGN KEY (matched_job_id) REFERENCES jobs(id) ON DELETE SET NULL
      );
      CREATE UNIQUE INDEX idx_emails_acct_uid ON emails(account_id, uid);
      CREATE INDEX idx_emails_msgid  ON emails(message_id);
      CREATE INDEX idx_emails_job    ON emails(matched_job_id);
      CREATE INDEX idx_emails_sent   ON emails(sent_at DESC);
      CREATE INDEX idx_emails_match  ON emails(match_source);
    `);
  },

  // v6 — scope learned memory (profile_fields + qa) to a profile, so each profile
  // has its OWN memory. Rebuild both tables with a profile_id + composite uniqueness,
  // and adopt all existing (global) memory into the default profile.
  () => {
    let homeId = get('SELECT id FROM profiles WHERE is_default = 1 LIMIT 1')?.id
      || get('SELECT id FROM profiles LIMIT 1')?.id;
    if (!homeId) {
      homeId = uid('prof');
      run("INSERT INTO profiles (id, name, is_default, source_assignments, data, updated_at) VALUES (?, 'Main', 1, '[]', '{}', ?)", [homeId, now()]);
    }
    exec(`
      CREATE TABLE profile_fields_new (
        id            TEXT PRIMARY KEY,
        profile_id    TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        key_norm      TEXT NOT NULL,
        label         TEXT NOT NULL,
        locale        TEXT NOT NULL DEFAULT 'en',
        value         TEXT,
        field_type    TEXT,
        source_job_id TEXT,
        source        TEXT,
        confidence    REAL NOT NULL DEFAULT 0.5,
        locked        INTEGER NOT NULL DEFAULT 0,
        seen_count    INTEGER NOT NULL DEFAULT 1,
        updated_at    TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        UNIQUE(profile_id, key_norm)
      );
    `);
    run(`INSERT INTO profile_fields_new
         (id, profile_id, key_norm, label, locale, value, field_type, source_job_id, source, confidence, locked, seen_count, updated_at, created_at)
         SELECT id, ?, key_norm, label, locale, value, field_type, source_job_id, source, confidence, locked, seen_count, updated_at, created_at
         FROM profile_fields`, [homeId]);
    exec('DROP TABLE profile_fields');
    exec('ALTER TABLE profile_fields_new RENAME TO profile_fields');

    exec(`
      CREATE TABLE qa_new (
        id            TEXT PRIMARY KEY,
        profile_id    TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        question_norm TEXT NOT NULL,
        question      TEXT NOT NULL,
        answer        TEXT NOT NULL,
        seen_count    INTEGER NOT NULL DEFAULT 1,
        sources       TEXT,
        updated_at    TEXT NOT NULL,
        UNIQUE(profile_id, question_norm)
      );
    `);
    run(`INSERT INTO qa_new (id, profile_id, question_norm, question, answer, seen_count, sources, updated_at)
         SELECT id, ?, question_norm, question, answer, seen_count, sources, updated_at FROM qa`, [homeId]);
    exec('DROP TABLE qa');
    exec('ALTER TABLE qa_new RENAME TO qa');
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
  migrateSecrets();
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

// Bound the database: prune stale rows past their retention, then (at most once per
// vacuumEveryDays) compact the file to reclaim disk. Never touches jobs, matched/
// manual emails, profiles, qa, documents — only churny logs. Safe to call repeatedly.
function maintenance() {
  if (!db) return { events: 0, tasks: 0, emails: 0, vacuumed: false };
  const m = getSettings().maintenance || {};
  const cut = (days, fallback) => new Date(Date.now() - Math.max(1, days || fallback) * 86400 * 1000).toISOString();
  let events = 0, tasks = 0, emails = 0;
  transaction(() => {
    events = run('DELETE FROM events WHERE timestamp < ?', [cut(m.eventRetentionDays, 400)])?.changes || 0;
    tasks = run("DELETE FROM auto_apply_tasks WHERE state IN ('skipped','failed') AND updated_at < ?", [cut(m.taskRetentionDays, 60)])?.changes || 0;
    // unmatched only; keep user-dismissed ones so a stale dismissal can't resurface as a suggestion.
    emails = run("DELETE FROM emails WHERE matched_job_id IS NULL AND (match_source IS NULL OR match_source NOT IN ('dismissed','manual')) AND created_at < ?", [cut(m.emailRetentionDays, 365)])?.changes || 0;
  });
  // VACUUM must run OUTSIDE a transaction; gate it so it doesn't run every call.
  let vacuumed = false;
  const last = kvGet('lastVacuumAt');
  const everyMs = Math.max(1, m.vacuumEveryDays || 7) * 86400 * 1000;
  if (!last || (Date.now() - Date.parse(last)) > everyMs) {
    try { exec('VACUUM'); kvSet('lastVacuumAt', new Date().toISOString()); vacuumed = true; } catch (e) { log.warn('VACUUM failed', e.message); }
  }
  if (events || tasks || emails || vacuumed) log.info(`maintenance: pruned ${events} events, ${tasks} tasks, ${emails} emails${vacuumed ? ' + vacuumed' : ''}`);
  return { events, tasks, emails, vacuumed };
}

// ============================================================
// Secrets at rest (Electron safeStorage; see secretstore.js)
// ============================================================
const secrets = require('./secretstore');

// Settings paths + kv keys that hold credentials → sealed at rest, opened in memory.
// Everything else stays plaintext.
const SECRET_SETTINGS = [
  ['ai', 'claude.apiKey'],
  ['ai', 'chatgpt.apiKey'],
  ['gmail', 'clientSecret'],
];
const SECRET_KV = new Set(['gmailTokens', 'emailAccounts']);

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, dotted, val) {
  const keys = dotted.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = val;
}

// On upgrade, re-write existing plaintext secrets through the sealing path. Idempotent,
// gated by a flag; a no-op when no keychain is available (leaves plaintext, retries next
// launch) and under tests (non-Electron).
function migrateSecrets() {
  if (!secrets.available() || kvGet('secretsEncrypted')) return;
  try {
    transaction(() => {
      for (const key of SECRET_KV) {
        const v = kvGet(key);           // open() passes legacy plaintext through
        if (v != null) kvSet(key, v);   // seal() tags it
      }
      for (const [section, dotted] of SECRET_SETTINGS) {
        const raw = safeParse(get('SELECT value FROM settings WHERE section = ?', [section])?.value, null);
        if (!raw) continue;
        const v = getPath(raw, dotted);
        if (typeof v === 'string' && v && !secrets.isSealed(v)) {
          setPath(raw, dotted, secrets.seal(v));
          run('INSERT INTO settings (section, value) VALUES (?, ?) ON CONFLICT(section) DO UPDATE SET value = excluded.value', [section, JSON.stringify(raw)]);
        }
      }
      kvSet('secretsEncrypted', true);   // atomic with the sealing — a rollback clears it so a failed run retries cleanly
    });
    log.info('secrets migrated to encrypted-at-rest');
  } catch (e) { log.warn('secret migration failed (will retry next launch)', e.message); }
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
  // Decrypt secret fields for in-memory use (callers like the AI/email layers need the
  // real value). The API layer re-redacts before sending anything to a client.
  for (const [section, dotted] of SECRET_SETTINGS) {
    const v = getPath(merged[section], dotted);
    if (secrets.isSealed(v)) setPath(merged[section], dotted, secrets.open(v));
  }
  return merged;
}

function patchSettings(patch) {
  transaction(() => {
    for (const [section, value] of Object.entries(patch || {})) {
      if (!(section in DEFAULTS)) continue;
      const cur = safeParse(get('SELECT value FROM settings WHERE section = ?', [section])?.value, {});
      const next = deepMerge(cur, value);
      // Secret fields: a blank incoming value PRESERVES the stored secret (so the UI,
      // which never receives the real key, can't erase it by saving a blank field);
      // a non-blank value is sealed before it hits disk.
      for (const [sec, dotted] of SECRET_SETTINGS) {
        if (sec !== section) continue;
        const incoming = getPath(value, dotted);
        if (incoming === undefined) continue;           // not in this patch → deepMerge kept cur (already sealed)
        if (typeof incoming !== 'string') { setPath(next, dotted, getPath(cur, dotted) || ''); continue; }   // non-string → never store; preserve
        const trimmed = incoming.trim();
        if (!trimmed) setPath(next, dotted, getPath(cur, dotted) || '');         // blank → preserve the stored (sealed) value
        else if (!secrets.isSealed(trimmed)) setPath(next, dotted, secrets.seal(trimmed));
      }
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
  if (!r) return null;
  const raw = SECRET_KV.has(key) ? secrets.open(r.value) : r.value;
  return safeParse(raw, null);
}
function kvSet(key, value) {
  if (!db) return;
  let stored = JSON.stringify(value);
  if (SECRET_KV.has(key)) stored = secrets.seal(stored);
  run('INSERT INTO kv (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [key, stored]);
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
    submittedAt: (() => { const d = input.submittedAt ? Date.parse(input.submittedAt) : NaN; return Number.isNaN(d) ? null : new Date(d).toISOString(); })(),
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
      incoming.status === 'submitted' ? (incoming.submittedAt || ts) : null,   // historical date for imports
    ]);
    if (!opts.skipHarvest) harvestAnswersToProfile(incoming.answers, { jobId: id, source: incoming.source });
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
    incoming.tags ? JSON.stringify([...new Set([...(prev.tags || []), ...incoming.tags])])
                  : (prev.tags?.length ? JSON.stringify(prev.tags) : null),
    ts,
    prev.submittedAt || (crossedSubmitted(prev.status, nextStatus) ? (incoming.submittedAt || ts) : null),
    existing.id,
  ]);

  if (!opts.skipHarvest) harvestAnswersToProfile(incoming.answers, { jobId: existing.id, source: incoming.source || prev.source });

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
// Filler tokens dropped before keying — English first, then common French so a
// bilingual user's EN/FR variants of the same question collapse to one key.
const QA_FILLERS = new Set((
  'please kindly select choose enter provide specify the a an your you do did does ' +
  'are is have has had will would can could how many much what which with in for of to at on ' +
  // French
  'veuillez selectionnez choisissez entrez indiquez precisez votre vos le la les un une des du de ' +
  'est sont avez quel quelle quels quelles combien dans pour sur au aux et ou si vous tu ton ta tes ' +
  // French elided articles (d', l', j', qu', n', c', s', t', m') leave a bare letter after folding
  'd l j c s t m n qu etes etre suis es a ont'
).split(' '));

// Bilingual canonicalization: rewrite a French (accent-folded) token onto its
// shared English token so "Parlez-vous français" and "Do you speak French" key
// alike. English tokens map to themselves (identity), so existing keys are
// unchanged — only French is rewritten.
const QA_CANON = {
  francais: 'french', anglais: 'english', espagnol: 'spanish', allemand: 'german',
  annee: 'years', annees: 'years', ans: 'years', an: 'years',
  experiences: 'experience',
  courriel: 'email', mail: 'email', adresse: 'address',
  prenom: 'firstname', telephone: 'phone', tel: 'phone', portable: 'phone',
  ville: 'city', pays: 'country', langue: 'language', langues: 'language',
  numero: 'number', mois: 'months', semaine: 'weeks', semaines: 'weeks',
  niveau: 'level', nom: 'name', noms: 'name',
  parlez: 'speak', parler: 'speak', parle: 'speak', parlons: 'speak',
  salaire: 'salary', remuneration: 'salary', poste: 'position',
  diplome: 'degree', formation: 'education',
  competence: 'skill', competences: 'skill',
  autorisation: 'authorization', autorise: 'authorized',
  travail: 'work', travailler: 'work', travaille: 'work', emploi: 'work',
  disponibilite: 'availability', disponible: 'available', preavis: 'notice',
};
function normalizeQuestion(q) {
  const folded = String(q || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Bag-of-words key: canonicalize, drop fillers, dedup, and SORT so word order
  // ("email address" vs "address email" / EN vs FR) doesn't fork the key.
  const toks = new Set();
  for (let t of folded.split(/[^a-z0-9]+/)) {
    if (!t) continue;
    t = QA_CANON[t] || t;
    if (QA_FILLERS.has(t)) continue;
    toks.add(t);
  }
  return [...toks].sort().join(' ').slice(0, 120);
}

// Heuristic language tag for a label/answer — advisory only (drives the UI
// badge), never a hard part of the key (the key is already EN/FR-collapsed).
const FR_HINT_RX = /\b(vous|votre|vos|français|francais|combien|années|prénom|courriel|veuillez|quel|quelle|salaire|expérience|téléphone|adresse|disponibilité|formation|compétences?)\b/i;
function guessLocale(text) { return FR_HINT_RX.test(String(text || '')) ? 'fr' : 'en'; }

function qaRecord({ profileId, question, answer, source }) {
  const qn = normalizeQuestion(question);
  if (!qn || answer == null || answer === '') return null;
  if (!profileId) { log.warn('qaRecord: missing profileId — answer not saved'); return null; }
  const cur = get('SELECT * FROM qa WHERE profile_id = ? AND question_norm = ?', [profileId, qn]);
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
  run(`INSERT INTO qa (id, profile_id, question_norm, question, answer, seen_count, sources, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [row.id, profileId, row.qn, row.question, row.answer, row.sources, row.ts]);
  return get('SELECT * FROM qa WHERE id = ?', [row.id]);
}

function qaLookup(profileId, question) {
  const qn = normalizeQuestion(question);
  if (!qn || !profileId) return null;
  const exact = get('SELECT * FROM qa WHERE profile_id = ? AND question_norm = ?', [profileId, qn]);
  if (exact) return { ...exact, match: 'exact', score: 1 };
  const want = new Set(qn.split(' ').filter(Boolean));
  if (!want.size) return null;
  let best = null;
  for (const row of all('SELECT * FROM qa WHERE profile_id = ?', [profileId])) {
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

function qaList(profileId, limit = 500) {
  if (!profileId) return [];
  return all('SELECT * FROM qa WHERE profile_id = ? ORDER BY updated_at DESC LIMIT ?', [profileId, limit]);
}
function qaDelete(id) { return (run('DELETE FROM qa WHERE id = ?', [id])?.changes ?? 0) > 0; }

// ============================================================
// Profile fields — dynamic, auto-harvested, EN/FR-keyed store.
// As applications are captured, every answer fans out here keyed by a
// language-collapsed question. Newest non-empty answer wins, unless the user
// locked the row by editing it in the dashboard. Powers the Profile page and
// the reverse-autofill of new applications.
// ============================================================
function humanizeKey(slug) {
  return String(slug || '').replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function pfRow(r) {
  if (!r) return null;
  return {
    id: r.id, profileId: r.profile_id, keyNorm: r.key_norm, label: r.label, locale: r.locale,
    value: r.value || '', fieldType: r.field_type || '',
    sourceJobId: r.source_job_id || null, source: r.source || '',
    confidence: r.confidence, locked: !!r.locked, seenCount: r.seen_count,
    updatedAt: r.updated_at,
  };
}

function profileFieldUpsert({ profileId, question, value, locale, fieldType, sourceJobId, source, confidence, fromUser }) {
  const label = String(question || '').trim();
  const keyNorm = normalizeQuestion(label);
  const val = value == null ? '' : String(value).trim().slice(0, 2000);
  if (!keyNorm || !val) return null;
  if (!profileId) { log.warn('profileFieldUpsert: missing profileId — answer not saved:', label); return null; }
  const ts = now();
  const loc = locale || guessLocale(label) || 'en';
  const cur = get('SELECT * FROM profile_fields WHERE profile_id = ? AND key_norm = ?', [profileId, keyNorm]);
  const suppressed = cur && cur.locked && !fromUser;   // user-locked row, auto harvest
  if (cur) {
    if (suppressed) {
      run('UPDATE profile_fields SET seen_count = seen_count + 1, updated_at = ? WHERE id = ?', [ts, cur.id]);
    } else {
      run(`UPDATE profile_fields SET value=?, label=?, locale=?,
           field_type=COALESCE(?, field_type), source_job_id=COALESCE(?, source_job_id),
           source=COALESCE(?, source), confidence=?, locked=?, seen_count=seen_count+1, updated_at=?
           WHERE id=?`,
          [val, label || cur.label, loc, fieldType || null, sourceJobId || null, source || null,
           confidence != null ? confidence : cur.confidence, fromUser ? 1 : cur.locked, ts, cur.id]);
    }
  } else {
    run(`INSERT INTO profile_fields
         (id, profile_id, key_norm, label, locale, value, field_type, source_job_id, source, confidence, locked, seen_count, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [uid('pf'), profileId, keyNorm, label || keyNorm, loc, val, fieldType || null, sourceJobId || null,
         source || null, confidence != null ? confidence : 0.5, fromUser ? 1 : 0, ts, ts]);
  }
  // Keep this profile's executor free-text memory in sync, except when a locked
  // row suppressed the write.
  if (!suppressed) { try { qaRecord({ profileId, question: label, answer: val, source }); } catch {} }
  return pfRow(get('SELECT * FROM profile_fields WHERE profile_id = ? AND key_norm = ?', [profileId, keyNorm]));
}

function profileFieldList(profileId) {
  if (!profileId) return [];
  return all('SELECT * FROM profile_fields WHERE profile_id = ? ORDER BY locked DESC, seen_count DESC, updated_at DESC', [profileId]).map(pfRow);
}
function profileFieldSet(id, { value, locked, label }) {
  const cur = get('SELECT * FROM profile_fields WHERE id = ?', [id]);
  if (!cur) return null;
  run('UPDATE profile_fields SET value=?, label=?, locked=?, updated_at=? WHERE id=?',
      [value !== undefined ? String(value).slice(0, 2000) : cur.value,
       label !== undefined ? String(label).slice(0, 300) : cur.label,
       locked !== undefined ? (locked ? 1 : 0) : cur.locked, now(), id]);
  const row = pfRow(get('SELECT * FROM profile_fields WHERE id = ?', [id]));
  if (row && row.value) { try { qaRecord({ profileId: cur.profile_id, question: row.label, answer: row.value }); } catch {} }
  return row;
}
function profileFieldDelete(id) { return (run('DELETE FROM profile_fields WHERE id = ?', [id])?.changes ?? 0) > 0; }

function profileFieldLookup(profileId, question) {
  const qn = normalizeQuestion(question);
  if (!qn || !profileId) return null;
  const exact = get('SELECT * FROM profile_fields WHERE profile_id = ? AND key_norm = ?', [profileId, qn]);
  if (exact) return { ...pfRow(exact), match: 'exact', score: 1 };
  const want = new Set(qn.split(' ').filter(Boolean));
  if (!want.size) return null;
  let best = null;
  for (const r of all('SELECT * FROM profile_fields WHERE profile_id = ?', [profileId])) {
    const have = new Set(String(r.key_norm).split(' ').filter(Boolean));
    let hit = 0; for (const t of want) if (have.has(t)) hit++;
    const coverage = hit / want.size;
    const symmetric = hit / Math.max(want.size, have.size);
    const score = (hit >= 2 && coverage >= 0.75) ? coverage : symmetric;
    if (score >= 0.6 && (!best || score > best.score)) best = { ...pfRow(r), match: 'fuzzy', score };
  }
  return best;
}

// Build a structured profile.data from harvested learned answers (so the
// PROFILE_PATTERNS autofill path works even when the user never saved a
// structured profile). Used as the last fallback in queueNext.
const LEARNED_TO_PROFILE = [
  [/first.?name|given.?name|prenom|firstname/, 'firstName'],
  [/last.?name|surname|family.?name|lastname/, 'lastName'],
  [/full.?name|legal.?name|^name$/, 'fullName'],
  [/preferred.?name|nickname/, 'preferredName'],
  [/email|courriel/, 'email'],
  [/phone|mobile|telephone|cell/, 'phone'],
  [/address.?2|apartment|unit|suite/, 'address2'],
  [/address|street/, 'address1'],
  [/^city$|\bcity\b|ville/, 'city'],
  [/province|state\b|region/, 'state'],
  [/postal|zip/, 'postalCode'],
  [/country|pays/, 'country'],
  [/linkedin/, 'linkedinUrl'],
  [/github/, 'githubUrl'],
  [/portfolio|website/, 'portfolioUrl'],
  [/work.?authoriz|authorized.?work/, 'workAuthorization'],
  [/sponsor|visa/, 'sponsorshipRequired'],
  [/salary|compensation|remuneration/, 'salaryExpectation'],
  [/years?.*experience|experience.*years?/, 'yearsExperience'],
  [/notice|start.?date|availab/, 'noticePeriod'],
  [/degree|diploma/, 'highestDegree'],
  [/university|college|school/, 'university'],
  [/major|field.?of.?study/, 'major'],
  [/graduation/, 'graduationYear'],
  [/citizen/, 'citizenship'],
];
// Bridge (memory → profile): derive structured profile values from a profile's
// OWN learned memory. Highest-confidence learned value wins per mapped key.
function memoryToProfileData(profileId) {
  const out = {}; const best = {};
  for (const f of profileFieldList(profileId)) {
    if (!f.value) continue;
    const hay = (f.label || f.keyNorm || '').toLowerCase();
    for (const [rx, key] of LEARNED_TO_PROFILE) {
      if (rx.test(hay)) {
        if (best[key] === undefined || f.confidence > best[key]) { out[key] = f.value; best[key] = f.confidence; }
        break;
      }
    }
  }
  return out;
}
function deriveProfileFromLearned(profileId) {
  const data = memoryToProfileData(profileId);
  return Object.keys(data).length ? { id: 'derived', name: 'From learned answers', data } : null;
}

// Everything the extension needs to pre-fill a new application: the source-matched
// profile + THAT profile's harvested memory fields.
function profileAutofillBundle(source) {
  const profile = profileForSource(source);
  const fields = profile ? profileFieldList(profile.id).filter((f) => f.value) : [];
  return { profileId: profile ? profile.id : null, fields, profile: profile ? { id: profile.id, name: profile.name, data: profile.data } : null };
}

// Fan a job's captured answers into a profile's memory (called from upsertJob).
// The owning profile = the source-matched profile (else the default).
function harvestAnswersToProfile(answers, { profileId, jobId, source } = {}) {
  if (!answers || typeof answers !== 'object') return 0;
  let enabled = true;
  try { enabled = getSettings().harvest.enabled !== false; } catch {}
  if (!enabled) return 0;
  const pid = profileId || resolveProfileId(source);
  let n = 0;
  for (const [key, raw] of Object.entries(answers)) {
    const value = Array.isArray(raw) ? raw.join(', ') : raw;
    if (value == null || String(value).trim() === '') continue;
    try {
      if (profileFieldUpsert({ profileId: pid, question: humanizeKey(key), value, sourceJobId: jobId, source, confidence: 0.6 })) n++;
    } catch {}
  }
  return n;
}

// One-shot backfill: harvest answers from EVERY past application into the GIVEN
// profile's memory. Oldest first so the newest answer to a repeated question wins.
// Bypasses the harvest setting — this is an explicit user action.
function backfillProfileFromJobs(profileId) {
  const pid = profileId || ensureDefaultProfileId();
  let fields = 0, jobs = 0;
  const allJobs = listJobs({});
  allJobs.sort((a, b) => new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0));
  for (const j of allJobs) {
    const ans = j.answers;
    if (!ans || typeof ans !== 'object' || !Object.keys(ans).length) continue;
    let got = 0;
    for (const [key, raw] of Object.entries(ans)) {
      const value = Array.isArray(raw) ? raw.join(', ') : raw;
      if (value == null || String(value).trim() === '') continue;
      try { if (profileFieldUpsert({ profileId: pid, question: humanizeKey(key), value, sourceJobId: j.id, source: j.source, confidence: 0.6 })) got++; } catch {}
    }
    if (got) { fields += got; jobs++; }
  }
  return { jobs, fields };
}

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

// There must always be a home profile for memory; create a default one if the
// user has none (e.g. deleted them all).
function ensureDefaultProfileId() {
  const cur = get('SELECT id FROM profiles WHERE is_default = 1 LIMIT 1')?.id || get('SELECT id FROM profiles LIMIT 1')?.id;
  if (cur) return cur;
  const nid = uid('prof');
  run("INSERT INTO profiles (id, name, is_default, source_assignments, data, updated_at) VALUES (?, 'Main', 1, '[]', '{}', ?)", [nid, now()]);
  return nid;
}
// Which profile a job's memory belongs to: the source-matched profile, else the default.
function resolveProfileId(source) {
  const p = profileForSource(source);
  return (p && p.id && p.id !== 'derived') ? p.id : ensureDefaultProfileId();
}

// Canonical labels for the structured profile keys (used when pushing the
// structured profile down into memory as learned answers).
const PROFILE_KEY_LABELS = {
  firstName: 'First name', lastName: 'Last name', fullName: 'Full name', preferredName: 'Preferred name',
  email: 'Email', phone: 'Phone', address1: 'Address', address2: 'Address line 2', city: 'City',
  state: 'State / Province', postalCode: 'Postal / ZIP code', country: 'Country',
  linkedinUrl: 'LinkedIn URL', githubUrl: 'GitHub URL', portfolioUrl: 'Portfolio / website',
  workAuthorization: 'Work authorization', sponsorshipRequired: 'Sponsorship required',
  salaryExpectation: 'Salary expectation', yearsExperience: 'Years of experience',
  noticePeriod: 'Notice period / availability', highestDegree: 'Highest degree',
  university: 'University / college', major: 'Major / field of study', graduationYear: 'Graduation year',
  citizenship: 'Citizenship', headline: 'Headline', summary: 'Summary', securityClearance: 'Security clearance',
};

// Bridge (profile → memory): push a profile's structured fields down into its OWN
// memory as locked, high-confidence learned answers, so auto-apply + the answer
// ladder know them. Skips empty/non-scalar + skills/summary/internal keys.
function pushProfileDataToMemory(profileId, data) {
  if (!profileId || !data || typeof data !== 'object') return { pushed: 0 };
  let pushed = 0;
  for (const [key, raw] of Object.entries(data)) {
    // Only scalar fields belong in Q&A memory — skip skills/summary, the
    // work/education history arrays, internal keys, and any non-scalar value.
    if (key === 'skills' || key === 'summary' || key === 'workHistory' || key === 'educationHistory' || String(key).startsWith('_')) continue;
    if (raw && typeof raw === 'object') continue;
    const value = raw;
    if (value == null || String(value).trim() === '') continue;
    const label = PROFILE_KEY_LABELS[key] || humanizeKey(key);
    try { if (profileFieldUpsert({ profileId, question: label, value, fromUser: true, confidence: 1, source: 'profile' })) pushed++; } catch {}
  }
  return { pushed };
}

// ============================================================
// Documents
// ============================================================
// Normalize legacy role spellings on read so old rows match the canonical
// vocabulary the UI/filters use (resume | cover_letter | other).
function canonRole(role) {
  const r = String(role || 'resume');
  if (r === 'coverLetter') return 'cover_letter';
  return r;
}

function docRow(r, { withText } = {}) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, role: canonRole(r.role), filePath: r.file_path,
    hasText: !!r.text_content,
    textContent: withText ? (r.text_content || '') : undefined,
    keywords: safeParse(r.keywords, []),
    lastModified: r.last_modified || null,
    indexedAt: r.indexed_at || null,
    folderId: r.folder_id || null,
    source: r.source || 'upload',
    label: r.label || '',
    importance: r.importance || 0,
    sizeBytes: r.size_bytes, mime: r.mime, isDefault: !!r.is_default, createdAt: r.created_at,
  };
}

function listDocuments(filter = {}) {
  const where = [], params = [];
  if (filter.role && filter.role !== 'all') { where.push('role = ?'); params.push(filter.role); }
  if (filter.source) { where.push('source = ?'); params.push(filter.source); }
  if (filter.folderId) { where.push('folder_id = ?'); params.push(filter.folderId); }
  let sql = 'SELECT * FROM documents';
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY is_default DESC, importance DESC, created_at DESC';
  let rows = all(sql, params).map((r) => docRow(r));
  if (filter.q) {
    const q = String(filter.q).toLowerCase();
    rows = rows.filter((d) => d.name.toLowerCase().includes(q)
      || (d.keywords || []).some((k) => String(k).toLowerCase().includes(q)));
  }
  return rows;
}
function getDocument(id, opts = {}) {
  return docRow(get('SELECT * FROM documents WHERE id = ?', [id]), opts);
}
function documentByPath(filePath) {
  return docRow(get('SELECT * FROM documents WHERE file_path = ?', [filePath]));
}
function addDocument({ name, role, filePath, textContent, sizeBytes, mime, isDefault, source, keywords, lastModified, folderId, importance, label }) {
  const id = uid('doc');
  const ts = now();
  role = canonRole(role);
  transaction(() => {
    if (isDefault) run('UPDATE documents SET is_default = 0 WHERE role = ?', [role]);
    run(`INSERT INTO documents (id, name, role, file_path, text_content, size_bytes, mime, is_default, created_at, keywords, last_modified, indexed_at, folder_id, source, importance, label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, name, role, filePath, textContent || null,
         sizeBytes || 0, mime || '', isDefault ? 1 : 0, ts,
         keywords ? JSON.stringify(keywords) : null, lastModified || null,
         textContent ? ts : null, folderId || null, source || 'upload', importance || 0, label || null]);
  });
  return getDocument(id);
}
function patchDocument(id, { name, role, isDefault, textContent, label }) {
  const cur = get('SELECT * FROM documents WHERE id = ?', [id]);
  if (!cur) return null;
  role = role !== undefined ? canonRole(role) : cur.role;
  transaction(() => {
    if (isDefault) run('UPDATE documents SET is_default = 0 WHERE role = ?', [role]);
    run('UPDATE documents SET name=?, role=?, is_default=?, text_content=?, label=? WHERE id=?',
        [name ?? cur.name, role,
         isDefault !== undefined ? (isDefault ? 1 : 0) : cur.is_default,
         textContent !== undefined ? textContent : cur.text_content,
         label !== undefined ? label : cur.label, id]);
  });
  return getDocument(id);
}
function deleteDocument(id) {
  const cur = get('SELECT * FROM documents WHERE id = ?', [id]);
  if (!cur) return false;
  run('DELETE FROM documents WHERE id = ?', [id]);
  // Only remove files WE created (uploads/harvests under userData/documents);
  // a linked folder merely INDEXES the user's own files — never delete those.
  if (cur.source !== 'folder') {
    try { if (cur.file_path && fs.existsSync(cur.file_path)) fs.rmSync(cur.file_path); } catch {}
  }
  return true;
}
function defaultDocument(role = 'resume') {
  const r = get('SELECT * FROM documents WHERE role = ? ORDER BY is_default DESC, created_at DESC LIMIT 1', [canonRole(role)]);
  return r ? docRow(r, { withText: true }) : null;
}

// ---- keyword extraction (deterministic, offline) ----
const KW_STOP = new Set((
  'the of and to a an in for on with is are was were be been being at by from as it this that these those ' +
  'or if then else not no yes you your our we us they them their his her its will would can could should may ' +
  'have has had do does did but so than into over under about above below up down out off all any each more ' +
  'most some such only own same other which who whom what when where why how also per via etc using used use ' +
  'work working experience years year team teams role roles within across ability able strong excellent good'
).split(' '));
function extractKeywords(text, topN = 12) {
  const freq = new Map();
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9+#.]+/)) {
    const t = raw.replace(/^\.+|\.+$/g, '');
    if (t.length < 3 || t.length > 30) continue;
    if (KW_STOP.has(t) || /^\d+$/.test(t)) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([t]) => t);
}

// ============================================================
// Document folders — link a local directory and index its files (filename +
// mtime + extracted text + keywords) into the library. The crawl/extract lives
// in server.js (async); these helpers are the sync store side.
// ============================================================
function folderRow(r) {
  if (!r) return null;
  return {
    id: r.id, path: r.path, label: r.label || '', roleHint: r.role_hint || 'other',
    fileCount: r.file_count, lastScanAt: r.last_scan_at || null,
    enabled: !!r.enabled, createdAt: r.created_at,
  };
}
function folderList() { return all('SELECT * FROM document_folders ORDER BY created_at DESC').map(folderRow); }
function folderGet(id) { return folderRow(get('SELECT * FROM document_folders WHERE id = ?', [id])); }
function folderAdd({ path: p, label, roleHint }) {
  const ex = get('SELECT * FROM document_folders WHERE path = ?', [p]);
  if (ex) return folderRow(ex);
  const id = uid('fold');
  run('INSERT INTO document_folders (id, path, label, role_hint, file_count, enabled, created_at) VALUES (?, ?, ?, ?, 0, 1, ?)',
      [id, p, label || '', roleHint || 'auto', now()]);
  return folderGet(id);
}
function folderTouch(id, fileCount) {
  run('UPDATE document_folders SET file_count=?, last_scan_at=? WHERE id=?', [fileCount || 0, now(), id]);
  return folderGet(id);
}
function folderDelete(id, { pruneDocs } = {}) {
  if (!get('SELECT id FROM document_folders WHERE id = ?', [id])) return false;
  if (pruneDocs) run('DELETE FROM documents WHERE folder_id = ?', [id]);   // never unlinks disk files (source='folder')
  else run('UPDATE documents SET folder_id = NULL WHERE folder_id = ?', [id]);
  run('DELETE FROM document_folders WHERE id = ?', [id]);
  return true;
}
// Insert-or-update a folder-indexed file, deduped by its real path so re-scans
// don't duplicate. Never sets is_default.
function upsertFolderDocument({ folderId, name, filePath, role, textContent, sizeBytes, mime, lastModified, keywords, importance }) {
  const ex = get('SELECT * FROM documents WHERE file_path = ?', [filePath]);
  const ts = now();
  role = canonRole(role || 'other');
  if (ex) {
    run(`UPDATE documents SET name=?, role=?, text_content=?, size_bytes=?, mime=?, keywords=?, last_modified=?, indexed_at=?, folder_id=?, importance=?, source='folder' WHERE id=?`,
        [name, role, textContent || null, sizeBytes || 0, mime || '',
         keywords ? JSON.stringify(keywords) : null, lastModified || null, ts, folderId || ex.folder_id, importance || 0, ex.id]);
    return getDocument(ex.id);
  }
  return addDocument({ name, role, filePath, textContent, sizeBytes, mime, source: 'folder', keywords, lastModified, folderId, importance });
}

// Remove all folder-indexed docs whose source file no longer exists on disk
// (so an auto-rescan after a delete/rename prunes stale entries).
function pruneMissingFolderDocs(folderId) {
  let removed = 0;
  for (const r of all('SELECT id, file_path FROM documents WHERE folder_id = ? AND source = ?', [folderId, 'folder'])) {
    try { if (!fs.existsSync(r.file_path)) { run('DELETE FROM documents WHERE id = ?', [r.id]); removed++; } } catch {}
  }
  return removed;
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
    parkReason: r.park_reason || null,
    pendingQuestions: safeParse(r.pending_questions, []),
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

// Auto-apply OUTCOME history for the dashboard's "submissions data" view: every
// task touched in the last N days, joined to its job, projected to a single 'reason'
// + an 'outcome' bucket, plus rollup counts. Time signal is updated_at (the last
// state transition — auto_apply_tasks has no separate finished_at column).
function queueHistory({ days = 7, state } = {}) {
  const cutoff = new Date(Date.now() - Math.max(1, days) * 86400 * 1000).toISOString();
  let sql = `SELECT t.*, j.title AS _title, j.company AS _company, j.job_url AS _url,
                    j.source AS _src, j.status AS _status, j.submitted_at AS _submittedAt
             FROM auto_apply_tasks t JOIN jobs j ON j.id = t.job_id
             WHERE t.updated_at >= ?`;
  const args = [cutoff];
  if (state) { sql += ' AND t.state = ?'; args.push(state); }
  sql += ' ORDER BY t.updated_at DESC';
  const OUTCOME = {
    done: 'submitted', awaiting_review: 'submitted', failed: 'failed',
    parked: 'needs_you', awaiting_input: 'needs_you', skipped: 'skipped',
    queued: 'pending', scheduled: 'pending', running: 'running',
  };
  const items = all(sql, args).map((r) => {
    const t = rowToTask(r);
    const reason = t.lastError || t.parkReason || (t.pendingQuestions[0] && t.pendingQuestions[0].reason) || '';
    return {
      taskId: t.id, jobId: t.jobId, state: t.state, mode: t.mode,
      outcome: OUTCOME[t.state] || t.state, reason,
      updatedAt: t.updatedAt, createdAt: t.createdAt, pendingQuestions: t.pendingQuestions,
      job: { title: r._title, company: r._company, jobUrl: r._url, source: r._src, status: r._status, submittedAt: r._submittedAt },
    };
  });
  const rollup = { submitted: 0, failed: 0, needs_you: 0, skipped: 0, pending: 0, running: 0, total: items.length };
  for (const it of items) rollup[it.outcome] = (rollup[it.outcome] || 0) + 1;
  return { items, rollup };
}

function queueAdd(jobId, { mode } = {}) {
  if (!getJob(jobId)) return null;
  const dup = get(
    `SELECT id FROM auto_apply_tasks WHERE job_id = ?
     AND state IN ('queued','scheduled','running','awaiting_review','awaiting_input','parked') LIMIT 1`,
    [jobId]);
  if (dup) return rowToTask(get('SELECT * FROM auto_apply_tasks WHERE id = ?', [dup.id]));
  const id = uid('task');
  const ts = now();
  run(`INSERT INTO auto_apply_tasks (id, job_id, state, mode, created_at, updated_at)
       VALUES (?, ?, 'queued', ?, ?, ?)`,
      [id, jobId, mode === 'auto' ? 'auto' : 'review', ts, ts]);
  return rowToTask(get('SELECT * FROM auto_apply_tasks WHERE id = ?', [id]));
}

function queuePatch(id, { state, scheduledAt, lastError, transcriptAppend, attemptsDelta, mode, parkReason, pendingQuestions }) {
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
       transcript = ?, park_reason = ?, pending_questions = ?, updated_at = ? WHERE id = ?`,
      [state || cur.state,
       mode || cur.mode,
       scheduledAt !== undefined ? scheduledAt : cur.scheduled_at,
       attemptsDelta || 0,
       lastError !== undefined ? lastError : cur.last_error,
       JSON.stringify(transcript.slice(-200)),
       parkReason !== undefined ? parkReason : cur.park_reason,
       pendingQuestions !== undefined ? JSON.stringify((pendingQuestions || []).slice(0, 40)) : cur.pending_questions,
       now(), id]);
  return rowToTask(get('SELECT * FROM auto_apply_tasks WHERE id = ?', [id]));
}

// ---- self-healing intake ----
// Distinct outstanding questions across all parked tasks, dropping any the
// knowledge base can now answer (so the intake only asks what's truly missing).
function queueParkedQuestions() {
  const out = [];
  const seen = new Set();
  for (const t of all("SELECT * FROM auto_apply_tasks WHERE state = 'parked'").map(rowToTask)) {
    const pid = resolveProfileId(getJob(t.jobId)?.source);   // check against THIS job's profile memory
    for (const q of t.pendingQuestions || []) {
      if (!q || !q.question) continue;
      const key = normalizeQuestion(q.question);
      if (!key || seen.has(key)) continue;
      // already learned it (for this job's profile)? then it's not outstanding.
      if (profileFieldLookup(pid, q.question) || qaLookup(pid, q.question)) continue;
      seen.add(key);
      out.push({ question: q.question, fieldType: q.fieldType || 'text', options: q.options || null, reason: q.reason || 'missing answer', taskId: t.id, jobId: t.jobId });
    }
  }
  return out;
}

// Re-check every parked task; if its profile's memory now answers ALL its pending
// questions, flip it back to 'queued' so the next paced tick retries it.
function queueRetryParked() {
  let requeued = 0;
  for (const t of all("SELECT * FROM auto_apply_tasks WHERE state = 'parked'").map(rowToTask)) {
    const pid = resolveProfileId(getJob(t.jobId)?.source);
    const pend = t.pendingQuestions || [];
    const stillMissing = pend.filter((q) => q && q.question && !profileFieldLookup(pid, q.question) && !qaLookup(pid, q.question));
    if (pend.length && stillMissing.length === 0) {
      run("UPDATE auto_apply_tasks SET state = 'queued', park_reason = NULL, pending_questions = NULL, updated_at = ? WHERE id = ?", [now(), t.id]);
      requeued++;
    }
  }
  return requeued;
}

// Intake: the user answered a parked question. Save it into the memory of EVERY
// profile that has a parked task asking it (so each of those tasks can retry),
// or the default profile if none match.
function saveIntakeAnswer({ question, value, fieldType }) {
  if (!question || value == null || String(value).trim() === '') return 0;
  const key = normalizeQuestion(question);
  const pids = new Set();
  for (const t of all("SELECT * FROM auto_apply_tasks WHERE state = 'parked'").map(rowToTask)) {
    if ((t.pendingQuestions || []).some((q) => q && q.question && normalizeQuestion(q.question) === key)) {
      pids.add(resolveProfileId(getJob(t.jobId)?.source));
    }
  }
  if (!pids.size) pids.add(ensureDefaultProfileId());
  let n = 0;
  for (const pid of pids) { try { if (profileFieldUpsert({ profileId: pid, question, value, fieldType, fromUser: true, confidence: 1 })) n++; } catch {} }
  return n > 0 ? 1 : 0;
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
    qa: all('SELECT * FROM qa').map((r) => ({ profileId: r.profile_id, question: r.question, answer: r.answer })),
    profiles: listProfiles(),
    documents: listDocuments(),
    queue: queueList(),
  };
}

function importAll(payload) {
  let jobs = 0, events = 0, qa = 0;
  const importPid = ensureDefaultProfileId();   // imported free-text answers land in the default profile's memory
  transaction(() => {
    for (const j of payload.jobs || []) { upsertJob(j); jobs++; }
    for (const e of payload.events || []) {
      if (e.jobId && getJob(e.jobId)) { recordEvent(e); events++; }
    }
    for (const q of payload.qa || []) {
      if (q.question && q.answer) { qaRecord({ profileId: q.profileId || importPid, question: q.question, answer: q.answer }); qa++; }
    }
  });
  return { jobs, events, qa };
}

// Irreversible "delete all my data": clears every user-data table and disconnects linked
// accounts (Gmail/IMAP) + clears API keys. Keeps the pairing token + non-secret app prefs
// so the app stays usable + paired. Returns per-table deleted counts.
function wipeAllData() {
  if (!db) return { ok: false, deleted: {} };
  const tables = ['emails', 'auto_apply_tasks', 'events', 'ai_log', 'qa', 'profile_fields', 'profiles', 'documents', 'document_folders', 'jobs'];
  const deleted = {};
  transaction(() => {
    for (const t of tables) deleted[t] = run(`DELETE FROM ${t}`)?.changes || 0;
    run("DELETE FROM kv WHERE key IN ('gmailTokens', 'emailAccounts')");
    for (const [section, dotted] of SECRET_SETTINGS) {
      const raw = safeParse(get('SELECT value FROM settings WHERE section = ?', [section])?.value, null);
      if (!raw) continue;
      setPath(raw, dotted, '');
      run('INSERT INTO settings (section, value) VALUES (?, ?) ON CONFLICT(section) DO UPDATE SET value = excluded.value', [section, JSON.stringify(raw)]);
    }
  });
  try { exec('VACUUM'); } catch (e) { log.warn('post-wipe VACUUM failed', e.message); }
  log.warn('wipeAllData: cleared all user data + disconnected accounts');
  return { ok: true, deleted };
}

// Import the user's pre-existing applications (scraped from LinkedIn/Indeed "applied
// jobs"). Each goes through upsertJob (so dedup + forward-only status are reused),
// forced to status 'submitted' with the REAL applied date, tagged 'imported', and
// with answer-harvest skipped (an import must not teach the profile). New rows count
// as 'created', dedup hits as 'merged'.
function bulkImportApplications(items, { source } = {}) {
  const list = (Array.isArray(items) ? items : []).slice(0, 800);
  let created = 0, merged = 0, skipped = 0;
  transaction(() => {
    for (const it of list) {
      const title = String(it.title || '').trim();
      if (!title) { skipped++; continue; }
      const r = upsertJob({
        externalId: it.externalId || null,
        source: it.source || source || null,
        title,
        company: String(it.company || '').trim(),
        location: it.location || '',
        jobUrl: it.jobUrl || '',
        status: 'submitted',
        submittedAt: it.appliedAt || it.submittedAt || null,
        tags: ['imported'],
      }, { skipHarvest: true });
      if (r.action === 'created') created++; else merged++;
      try { recordEvent({ jobId: r.job.id, type: 'imported', source: 'import', summary: `Imported from ${it.source || source || 'sync'}` }); } catch {}
    }
  });
  return { created, merged, skipped, total: list.length };
}

// ============================================================
// Email integration (synced mailbox emails associated to jobs)
// ============================================================
function rowToEmail(r) {
  if (!r) return null;
  return {
    id: r.id, accountId: r.account_id, provider: r.provider, uid: r.uid,
    messageId: r.message_id, threadId: r.thread_id,
    from: r.from_addr, fromName: r.from_name, to: r.to_addr,
    subject: r.subject, snippet: r.snippet, body: r.body, sentAt: r.sent_at,
    category: r.category, matchedJobId: r.matched_job_id,
    matchConfidence: r.match_confidence, matchSource: r.match_source, createdAt: r.created_at,
  };
}
// Insert or update a synced email (dedup by account+uid). A user override
// (manual/dismissed) is never clobbered by a later re-sync.
function emailUpsert(e) {
  const existing = get('SELECT * FROM emails WHERE account_id = ? AND uid = ?', [e.accountId, e.uid]);
  if (existing) {
    const pinned = existing.match_source === 'manual' || existing.match_source === 'dismissed' ? 1 : 0;
    run(`UPDATE emails SET from_addr=?, from_name=?, to_addr=?, subject=?, snippet=?, body=?, sent_at=?, message_id=?, thread_id=?,
         category = COALESCE(?, category),
         matched_job_id   = CASE WHEN ? THEN matched_job_id ELSE ? END,
         match_confidence = CASE WHEN ? THEN match_confidence ELSE ? END,
         match_source     = CASE WHEN ? THEN match_source ELSE ? END
         WHERE id = ?`,
      [e.from || '', e.fromName || '', e.to || '', e.subject || '', e.snippet || '', e.body || '', e.sentAt || null, e.messageId || null, e.threadId || null,
       e.category || null,
       pinned, e.matchedJobId || null, pinned, e.matchConfidence || 0, pinned, e.matchSource || null, existing.id]);
    return { id: existing.id, action: 'updated' };
  }
  const id = uid('email');
  run(`INSERT INTO emails (id, account_id, provider, uid, message_id, thread_id, from_addr, from_name, to_addr,
       subject, snippet, body, sent_at, category, matched_job_id, match_confidence, match_source, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, e.accountId, e.provider || null, e.uid ?? null, e.messageId || null, e.threadId || null,
     e.from || '', e.fromName || '', e.to || '', e.subject || '', e.snippet || '', e.body || '', e.sentAt || null,
     e.category || null, e.matchedJobId || null, e.matchConfidence || 0, e.matchSource || null, now()]);
  return { id, action: 'created' };
}
function emailsForJob(jobId) {
  return all(`SELECT * FROM emails WHERE matched_job_id = ? AND match_source IN ('auto','manual') ORDER BY sent_at DESC`, [jobId]).map(rowToEmail);
}
function emailSuggestionsForJob(jobId) {
  return all(`SELECT * FROM emails WHERE matched_job_id = ? AND match_source = 'suggested' ORDER BY match_confidence DESC`, [jobId]).map(rowToEmail);
}
function setEmailMatch(emailId, { jobId, source, confidence } = {}) {
  if (!get('SELECT id FROM emails WHERE id = ?', [emailId])) return null;
  run('UPDATE emails SET matched_job_id = ?, match_source = ?, match_confidence = ? WHERE id = ?',
    [jobId || null, source || (jobId ? 'manual' : 'dismissed'), confidence ?? (jobId ? 1 : 0), emailId]);
  return rowToEmail(get('SELECT * FROM emails WHERE id = ?', [emailId]));
}
function listEmails({ q, unmatchedOnly, limit = 100 } = {}) {
  let sql = 'SELECT * FROM emails'; const args = []; const where = [];
  if (unmatchedOnly) where.push('matched_job_id IS NULL');   // no job → available to link (incl. orphaned-by-delete)
  if (q) { const k = '%' + q + '%'; where.push('(subject LIKE ? OR from_addr LIKE ? OR from_name LIKE ?)'); args.push(k, k, k); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY sent_at DESC LIMIT ?'; args.push(Math.min(500, limit));
  return all(sql, args).map(rowToEmail);
}
function emailStats() {
  const one = (sql) => get(sql)?.n || 0;
  const total = one('SELECT COUNT(*) n FROM emails');
  const matched = one("SELECT COUNT(*) n FROM emails WHERE match_source IN ('auto','manual') AND matched_job_id IS NOT NULL");
  const suggested = one("SELECT COUNT(*) n FROM emails WHERE match_source = 'suggested' AND matched_job_id IS NOT NULL");
  const byCategory = {}; for (const r of all('SELECT category, COUNT(*) n FROM emails GROUP BY category')) byCategory[r.category || 'other'] = r.n;
  const byAccount = {}; for (const r of all('SELECT account_id, COUNT(*) n, MAX(sent_at) latest FROM emails GROUP BY account_id')) byAccount[r.account_id] = { count: r.n, latest: r.latest };
  return { total, matched, suggested, unmatched: total - matched - suggested, byCategory, byAccount };
}
// Per-account resumable sync cursor (highest IMAP UID synced).
function emailCursor(accountId) { return kvGet('emailCursor:' + accountId) || { uid: 0, syncedAt: null }; }
function setEmailCursor(accountId, cur) { kvSet('emailCursor:' + accountId, cur); }
// Jobs the matcher considers when associating an incoming email.
function jobsForMatching() {
  return all('SELECT id, title, company, source, submitted_at, created_at FROM jobs ORDER BY created_at DESC LIMIT 2000')
    .map((r) => ({ id: r.id, title: r.title, company: r.company, source: r.source, submittedAt: r.submitted_at, createdAt: r.created_at }));
}

module.exports = {
  open, close, backupNow, dailyBackup, maintenance, transaction,
  getSettings, patchSettings, kvGet, kvSet,
  listJobs, getJob, upsertJob, patchJob, deleteJob, stats,
  listEvents, listRecentEvents, recordEvent,
  qaRecord, qaLookup, qaList, qaDelete, normalizeQuestion, guessLocale,
  profileFieldUpsert, profileFieldList, profileFieldSet, profileFieldDelete,
  profileFieldLookup, profileAutofillBundle, harvestAnswersToProfile, backfillProfileFromJobs, deriveProfileFromLearned,
  memoryToProfileData, pushProfileDataToMemory, ensureDefaultProfileId, resolveProfileId,
  listProfiles, saveProfile, deleteProfile, profileForSource,
  listDocuments, getDocument, addDocument, patchDocument, deleteDocument, defaultDocument,
  extractKeywords, folderList, folderGet, folderAdd, folderTouch, folderDelete, upsertFolderDocument,
  documentByPath, pruneMissingFolderDocs, listFolderEnabled: () => folderList().filter((f) => f.enabled),
  queueList, queueHistory, queueAdd, queuePatch, queueDelete, queueRunStats, queueParkedQuestions, queueRetryParked, saveIntakeAnswer,
  aiLog, aiLogList, aiUsage,
  exportAll, importAll, bulkImportApplications, wipeAllData,
  emailUpsert, emailsForJob, emailSuggestionsForJob, setEmailMatch, listEmails, emailStats, emailCursor, setEmailCursor, jobsForMatching,
  STATUS_ORDER, TERMINAL, normJobUrl, normKey,
};
