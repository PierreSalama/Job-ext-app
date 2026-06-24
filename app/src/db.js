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
const { score: fitScore } = require('./fit');   // P7: deterministic fit baseline for rankJob

const log = scope('db');

// ---- Status FSM (mirror of extension/lib/status.js — keep in lockstep) ----
const STATUS_ORDER = {
  started: 10, submitted: 20, contacted: 30,
  assessment: 35,                                  // online assessment / coding challenge / take-home
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

// Work-mode words a user may have (wrongly) typed into `locations`. A location is
// ALWAYS a geography; remote/hybrid/onsite is a SEPARATE filter. Folding these out of
// `locations` fixes the borderless-"remote" bug (dad set "remote" → applied worldwide).
const WORK_MODE_BY_WORD = {
  'remote': 'remote', 'work from home': 'remote', 'wfh': 'remote', 'anywhere': 'remote',
  'hybrid': 'hybrid',
  'onsite': 'onsite', 'on-site': 'onsite', 'on site': 'onsite', 'in office': 'onsite', 'in-office': 'onsite',
};

// Pure, idempotent repair of an autoApply settings object: a location is always a
// geography; work-mode words are stripped from `locations` and folded into `workModes`;
// if `locations` ends up empty it defaults to [country] so EVERY search is geo-scoped
// (a search can never be borderless again). Runs on every load → auto-repairs bad
// stored configs (e.g. dad's "remote" location) without a one-shot migration. Safe to
// run twice: a clean config is returned unchanged.
function normalizeAutoApply(aa) {
  if (!aa || typeof aa !== 'object') return aa;
  const country = (typeof aa.country === 'string' && aa.country.trim()) ? aa.country.trim() : 'Canada';
  const rawLocations = Array.isArray(aa.locations) ? aa.locations : [];
  const rawModes = Array.isArray(aa.workModes) ? aa.workModes : [];
  const modes = new Set(rawModes.map((m) => String(m).trim().toLowerCase()).filter((m) => ['remote', 'hybrid', 'onsite'].includes(m)));
  const cleanLocations = [];
  const seen = new Set();
  for (const raw of rawLocations) {
    const loc = String(raw == null ? '' : raw).trim();
    if (!loc) continue;
    const mode = WORK_MODE_BY_WORD[loc.toLowerCase()];
    if (mode) { modes.add(mode); continue; }   // it was a work-mode masquerading as a location → fold out
    const key = loc.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleanLocations.push(loc);
  }
  // A search must ALWAYS be geo-scoped — never borderless.
  if (!cleanLocations.length) cleanLocations.push(country);
  const order = ['remote', 'hybrid', 'onsite'];
  const workModes = order.filter((m) => modes.has(m));
  return { ...aa, country, locations: cleanLocations, workModes };
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

  // v7 — record which route an auto-apply task took (easy-apply | external).
  () => {
    exec('ALTER TABLE auto_apply_tasks ADD COLUMN apply_route TEXT;');
  },

  // v8 — indexes for the auto-apply hot paths. queueRunStats (gates EVERY dispatch
  // + polled by the live panel every 2.5s), queueHistory/Breakdown/Live all filter
  // auto_apply_tasks by updated_at and JOIN on job_id; the table only had an index
  // on (state, scheduled_at). (profile_fields/qa already have composite indexes via
  // their v6 UNIQUE(profile_id, …) constraints, so they need nothing here.)
  () => {
    exec('CREATE INDEX IF NOT EXISTS idx_tasks_updated ON auto_apply_tasks(updated_at)');
    exec('CREATE INDEX IF NOT EXISTS idx_tasks_job ON auto_apply_tasks(job_id)');
  },

  // v9 — Apprenticeship Engine foundation. Recipe store (keyed independently by ATS and
  // by company), human navigation log, the reward ledger, user punishments, plus
  // per-answer lineage/reward columns. ALL ids are TEXT (uid), matching the existing
  // schema (the design doc's INTEGER sketch was wrong). New tables FK-cascade to
  // profiles, so per-profile isolation is structural.
  () => {
    exec(`
      CREATE TABLE ats_recipes (
        id            TEXT PRIMARY KEY,
        profile_id    TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        scope         TEXT NOT NULL,            -- 'ats' | 'company'
        ats           TEXT NOT NULL,            -- workday|greenhouse|lever|icims|successfactors|taleo|bamboo|ashby|direct
        company_key   TEXT,                     -- normKey(company); NULL for scope='ats'
        site_domain   TEXT,
        confidence    REAL    DEFAULT 0.5,
        reward_score  REAL    DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count    INTEGER DEFAULT 0,
        seen_count    INTEGER DEFAULT 1,
        created_at    TEXT,
        updated_at    TEXT,
        UNIQUE(profile_id, scope, ats, company_key)
      );
    `);
    exec(`
      CREATE TABLE recipe_steps (
        id                 TEXT PRIMARY KEY,
        recipe_id          TEXT NOT NULL REFERENCES ats_recipes(id) ON DELETE CASCADE,
        step_index         INTEGER NOT NULL,
        action             TEXT NOT NULL,       -- fill|select|combobox|upload|advance|wait|handoff
        label_pattern      TEXT,                -- normalized (normalizeQuestion)
        field_type         TEXT,
        strategy           TEXT,
        options            TEXT,                -- JSON
        validation_pattern TEXT,
        advance_text       TEXT,
        median_delay_ms    INTEGER,             -- learned human pacing (anti-detection floor)
        confidence         REAL,
        updated_at         TEXT
      );
    `);
    exec('CREATE INDEX idx_recipe_steps_recipe ON recipe_steps(recipe_id, step_index);');
    exec(`
      CREATE TABLE nav_events (
        id            TEXT PRIMARY KEY,
        profile_id    TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        session_id    TEXT,
        url_norm      TEXT,
        host          TEXT,
        ats           TEXT,
        company_key   TEXT,
        referrer_norm TEXT,
        kind          TEXT,                     -- visit|apply_click|step_advance|handoff|submit
        ts            TEXT
      );
    `);
    exec('CREATE INDEX idx_nav_events_profile_ts ON nav_events(profile_id, ts);');
    exec(`
      CREATE TABLE application_outcomes (
        id          TEXT PRIMARY KEY,
        job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        recipe_id   TEXT REFERENCES ats_recipes(id) ON DELETE SET NULL,
        ats         TEXT,
        company_key TEXT,
        reward      REAL NOT NULL,              -- +interview/offer, mild-neg rejection, star delta, punish
        reward_kind TEXT NOT NULL,              -- email_reply|rejection|star|punish|submitted
        email_id    TEXT REFERENCES emails(id) ON DELETE SET NULL,
        credited    TEXT,                       -- JSON {qa_ids,step_indices}
        ts          TEXT
      );
    `);
    exec('CREATE INDEX idx_outcomes_job ON application_outcomes(job_id);');
    exec(`
      CREATE TABLE punishments (
        id          TEXT PRIMARY KEY,
        profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL,              -- job | job_type | company
        pattern     TEXT NOT NULL,              -- company_key | title regex | job_id
        weight      REAL DEFAULT 1.0,
        decay_at    TEXT,                       -- NULL = permanent
        created_at  TEXT
      );
    `);
    exec('CREATE INDEX idx_punish_profile ON punishments(profile_id, kind);');
    // Additive columns: per-answer lineage + reward (credit assignment), light staleness.
    exec('ALTER TABLE qa ADD COLUMN answer_lineage TEXT;');
    exec('ALTER TABLE qa ADD COLUMN reward_score REAL DEFAULT 0;');
    exec('ALTER TABLE profile_fields ADD COLUMN reward_score REAL DEFAULT 0;');
    exec('ALTER TABLE profile_fields ADD COLUMN last_validated_at TEXT;');
    exec('ALTER TABLE auto_apply_tasks ADD COLUMN recipe_id TEXT;');   // nullable; no FK (avoid lock churn)
  },

  // v10 — Teach & Correct (Apprenticeship Engine v2). Full-fidelity demonstrations
  // (the user's real clicks/fills with the exact locator bundle + screenshot + timing),
  // a screenshots ledger (files on disk, referenced by id, pruned), and the real locator
  // bundle on recipe_steps so replay targets the exact element instead of a label guess.
  () => {
    exec(`
      CREATE TABLE demonstrations (
        id            TEXT PRIMARY KEY,
        profile_id    TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        session_id    TEXT,
        job_id        TEXT,
        ats           TEXT,
        company_key   TEXT,
        step_index    INTEGER,
        action        TEXT,                     -- click|fill|select|upload|advance
        label         TEXT,
        label_norm    TEXT,
        field_type    TEXT,
        selector      TEXT,                     -- CSS selector
        xpath         TEXT,
        attrs         TEXT,                     -- JSON attribute signature
        html          TEXT,                     -- trimmed outerHTML snippet
        value         TEXT,                     -- rail-guarded (null for sensitive)
        screenshot_id TEXT,
        delay_ms      INTEGER,                  -- ms before the NEXT action (human pacing)
        source        TEXT,                     -- manual|teach|correction
        ts            TEXT
      );
    `);
    exec('CREATE INDEX idx_demos_key ON demonstrations(profile_id, ats, label_norm);');
    exec('CREATE INDEX idx_demos_session ON demonstrations(session_id, step_index);');
    exec(`
      CREATE TABLE teach_screenshots (
        id          TEXT PRIMARY KEY,
        profile_id  TEXT,
        path        TEXT,
        w           INTEGER,
        h           INTEGER,
        bytes       INTEGER,
        ts          TEXT
      );
    `);
    // The real locator bundle on each recipe step → selector-first replay (T3).
    exec('ALTER TABLE recipe_steps ADD COLUMN selector TEXT;');
    exec('ALTER TABLE recipe_steps ADD COLUMN xpath TEXT;');
    exec('ALTER TABLE recipe_steps ADD COLUMN attrs TEXT;');
    exec('ALTER TABLE recipe_steps ADD COLUMN html TEXT;');
    exec('ALTER TABLE recipe_steps ADD COLUMN screenshot_id TEXT;');
    exec('ALTER TABLE recipe_steps ADD COLUMN source TEXT;');
    exec('ALTER TABLE recipe_steps ADD COLUMN default_value TEXT;');
  },

  // v11 — durable discovery ledger + provider fallback queue. Discovery now runs in
  // the desktop app (JobSpy primary) and asks the extension to scrape only when a
  // provider reports a typed failure. Keeping batches makes zero-results, blocking,
  // parser drift and dedup visible instead of overwriting one opaque status value.
  () => {
    exec(`
      CREATE TABLE discovery_batches (
        id              TEXT PRIMARY KEY,
        provider        TEXT NOT NULL,
        source          TEXT NOT NULL,
        keyword         TEXT,
        location        TEXT,
        status          TEXT NOT NULL,
        found_count     INTEGER NOT NULL DEFAULT 0,
        accepted_count  INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        rejected_count  INTEGER NOT NULL DEFAULT 0,
        error           TEXT,
        diagnostics     TEXT,
        fallback_of     TEXT,
        started_at      TEXT NOT NULL,
        completed_at    TEXT,
        FOREIGN KEY (fallback_of) REFERENCES discovery_batches(id) ON DELETE SET NULL
      );
      CREATE INDEX idx_discovery_batches_time ON discovery_batches(started_at DESC);
      CREATE INDEX idx_discovery_batches_source ON discovery_batches(source, started_at DESC);

      CREATE TABLE discovery_fallbacks (
        id          TEXT PRIMARY KEY,
        batch_id    TEXT NOT NULL REFERENCES discovery_batches(id) ON DELETE CASCADE,
        source      TEXT NOT NULL,
        keyword     TEXT,
        location    TEXT,
        state       TEXT NOT NULL DEFAULT 'queued',
        reason      TEXT,
        created_at  TEXT NOT NULL,
        claimed_at  TEXT,
        completed_at TEXT,
        UNIQUE(batch_id, source)
      );
      CREATE INDEX idx_discovery_fallback_state ON discovery_fallbacks(state, created_at);

      CREATE TABLE job_discovery_provenance (
        job_id           TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        batch_id         TEXT NOT NULL REFERENCES discovery_batches(id) ON DELETE CASCADE,
        provider         TEXT NOT NULL,
        source           TEXT NOT NULL,
        raw_url          TEXT,
        apply_capability TEXT NOT NULL DEFAULT 'unknown',
        discovered_at    TEXT NOT NULL,
        PRIMARY KEY (job_id, batch_id)
      );
      CREATE INDEX idx_job_discovery_job ON job_discovery_provenance(job_id, discovered_at DESC);

      ALTER TABLE auto_apply_tasks ADD COLUMN route_state TEXT;
      ALTER TABLE auto_apply_tasks ADD COLUMN submission_evidence TEXT;
      ALTER TABLE auto_apply_tasks ADD COLUMN handoff_token TEXT;
    `);
  },

  // SUCCESS-TRUTH quarantine. Historical `done` rows were minted with evidence that
  // is not TRUSTWORTHY: either no submission_evidence at all, or the old static
  // `success-signal` type whose detail was "confirmation text"/"confirmation URL"
  // (regex-matched against pre-existing page text with no before/after baseline —
  // the Activision / Canada Job Bank false positives). Downgrade those to
  // awaiting_review so they are RE-VERIFIED by a human, not silently trusted. Rows
  // with trustworthy evidence (the new `verified` type, or the genuine `confirmed`
  // modal-close) are left untouched. Idempotent and append-only.
  () => { quarantineUntrustworthyDone(); },

  // Recover race-lost VERIFIED submissions that were downgraded to awaiting_review because the
  // executor's evidence-bearing PATCH was dropped on tab-teardown (only the state-only reconcile
  // landed). Promotes back to `done` ONLY rows whose transcript proves R1 post-click verification
  // (NOT the legacy static "(confirmation)" markers). Append-only + idempotent. See
  // recoverRaceLostSubmissions / recoverVerifiedEvidenceFromTranscript.
  () => { recoverRaceLostSubmissions(); },
];

// SUCCESS-TRUTH quarantine (shared by the migration above and exported for tests).
// Returns the number of rows downgraded. Idempotent: trustworthy rows are skipped,
// already-quarantined rows are no longer `done` so they won't match again.
function quarantineUntrustworthyDone() {
  const before = get(
    `SELECT COUNT(*) AS n FROM auto_apply_tasks
      WHERE state = 'done'
        AND ( submission_evidence IS NULL
           OR TRIM(submission_evidence) = ''
           OR submission_evidence LIKE '%"type":"success-signal"%'
           OR submission_evidence LIKE '%"type": "success-signal"%'
           OR submission_evidence LIKE '%confirmation text%' )`).n;
  exec(`
    UPDATE auto_apply_tasks
       SET state = 'awaiting_review',
           last_error = 'submit evidence was not trustworthy (legacy/static success signal) — please re-verify'
     WHERE state = 'done'
       AND (
            submission_evidence IS NULL
         OR TRIM(submission_evidence) = ''
         OR submission_evidence LIKE '%"type":"success-signal"%'
         OR submission_evidence LIKE '%"type": "success-signal"%'
         OR submission_evidence LIKE '%confirmation text%'
       );
  `);
  return before;
}

// Is a submission_evidence object TRUSTWORTHY (the inverse of the quarantine criteria above)?
// Trustworthy = present, NOT the legacy static `success-signal` type, and NOT a "confirmation
// text/url" detail that was regex-matched against pre-existing page copy with no before/after
// baseline. The R1 `verified` type and the genuine `confirmation`/`confirmed` modal-close are
// trustworthy. Used by queuePatch (FIX 2) to clear stale failure text off a verified done.
// Accepts the parsed object OR a JSON string; any malformed input → false (treat as untrusted).
function isTrustworthyEvidence(evidence) {
  if (!evidence) return false;
  let e = evidence;
  if (typeof e === 'string') { e = safeParse(e, null); if (!e) return false; }
  if (typeof e !== 'object') return false;
  const type = String(e.type || '').toLowerCase();
  if (!type || type === 'success-signal') return false;
  const detail = String(e.detail || '').toLowerCase();
  if (/confirmation text/.test(detail)) return false;
  return true;
}

// Recover R1-trustworthy submission evidence from a task TRANSCRIPT when the evidence object
// itself was lost in transit. The executor's evidence-bearing task-progress PATCH is fire-and-
// forget (executor.js report → .catch(()=>{})); when the apply tab is torn down right after a
// verified submit, that PATCH can be dropped and only background's STATE-ONLY reconcile lands —
// so queuePatch saw `done` with no evidence and downgraded a genuinely VERIFIED submission to
// awaiting_review. But the executor logs its R1 verdict into the transcript BEFORE that final
// report, and it ONLY logs these markers AFTER R1's strict POST-CLICK verification passed:
//   • "trace:submit → DONE evidence=verified:<reason>"      (vlog)
//   • "submitted — verified (<reason>)"                      (done report transcriptAppend)
//   • "✓ application submitted (<reason>)"                   (logLine)
// where <reason> ∈ {text-became-success, new-confirmation-node, confirm-signal:*}. Those are
// POST-CLICK NEW-evidence DIFF signals — the strongest, unambiguous proof a submit landed.
// We DELIBERATELY do NOT auto-recover on two weaker/legacy markers:
//   • "application submitted (confirmation)" / "success-signal" — the legacy pre-R1 STATIC
//     signal (Activision / Canada Job Bank false positives) R1+quarantine exist to reject.
//   • "apply-form-closed" — a corroborating (form-dismissed-after-submit) signal the executor
//     accepts live, but an adversarial audit flagged it as borderline when the evidence object
//     is GONE; rather than risk telling the user they applied when they may not have, those
//     stay in awaiting_review for human confirmation. (Trustworthiness > recall here.)
const R1_TRUSTWORTHY_TRANSCRIPT_RX =
  /evidence=verified:(text-became-success|new-confirmation-node|confirm-signal[^\s|]*)|(?:application submitted|submitted — verified) \((text-became-success|new-confirmation-node|confirm-signal[^)]*)\)/i;
function recoverVerifiedEvidenceFromTranscript(transcript) {
  let steps = transcript;
  if (typeof steps === 'string') steps = safeParse(steps, []);
  if (!Array.isArray(steps)) return null;
  for (let i = steps.length - 1; i >= 0; i--) {   // scan newest→oldest; the verdict is near the end
    const s = steps[i];
    const text = String((s && (s.text || s.note)) || '');
    const m = text.match(R1_TRUSTWORTHY_TRANSCRIPT_RX);
    if (m) {
      const reason = String(m[1] || m[2] || '').toLowerCase();
      if (!reason || reason === 'confirmation' || reason === 'success-signal') continue;   // never the legacy static signal
      return { type: 'verified', reason, detail: 'recovered-from-transcript', at: now() };
    }
  }
  return null;
}

// RECOVER race-lost verified submissions already sitting in awaiting_review. Promote BACK to
// `done` the rows whose TRANSCRIPT carries an R1-trustworthy post-click marker (so the lost
// evidence object is reconstructed from the proven verdict), stamping recovered evidence and
// clearing the stale downgrade error. Skips the legacy "(confirmation)"/success-signal rows
// (no trustworthy marker → recoverVerifiedEvidenceFromTranscript returns null). Idempotent:
// once promoted to `done` a row no longer matches the awaiting_review filter. Returns the count.
function recoverRaceLostSubmissions() {
  const rows = all(
    `SELECT id, transcript FROM auto_apply_tasks
      WHERE state = 'awaiting_review'
        AND ( transcript LIKE '%evidence=verified:%'
           OR transcript LIKE '%submitted — verified (%'
           OR transcript LIKE '%application submitted (text-became-success%'
           OR transcript LIKE '%application submitted (new-confirmation-node%'
           OR transcript LIKE '%application submitted (apply-form-closed%'
           OR transcript LIKE '%application submitted (confirm-signal%' )`);
  let n = 0;
  for (const r of rows) {
    const ev = recoverVerifiedEvidenceFromTranscript(r.transcript);
    if (!ev) continue;
    run(`UPDATE auto_apply_tasks
            SET state = 'done', submission_evidence = ?, last_error = NULL,
                park_reason = NULL, pending_questions = '[]', updated_at = ?
          WHERE id = ?`, [JSON.stringify(ev), now(), r.id]);
    n++;
  }
  return n;
}

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
  if (!db) return { events: 0, tasks: 0, emails: 0, discovery: 0, vacuumed: false };
  const m = getSettings().maintenance || {};
  const cut = (days, fallback) => new Date(Date.now() - Math.max(1, days || fallback) * 86400 * 1000).toISOString();
  let events = 0, tasks = 0, emails = 0, discovery = 0;
  transaction(() => {
    events = run('DELETE FROM events WHERE timestamp < ?', [cut(m.eventRetentionDays, 400)])?.changes || 0;
    tasks = run("DELETE FROM auto_apply_tasks WHERE state IN ('skipped','failed') AND updated_at < ?", [cut(m.taskRetentionDays, 60)])?.changes || 0;
    // unmatched only; keep user-dismissed ones so a stale dismissal can't resurface as a suggestion.
    emails = run("DELETE FROM emails WHERE matched_job_id IS NULL AND (match_source IS NULL OR match_source NOT IN ('dismissed','manual')) AND created_at < ?", [cut(m.emailRetentionDays, 365)])?.changes || 0;
    discovery = run('DELETE FROM discovery_batches WHERE started_at < ?', [cut(m.discoveryRetentionDays, 90)])?.changes || 0;
  });
  // VACUUM must run OUTSIDE a transaction; gate it so it doesn't run every call.
  let vacuumed = false;
  const last = kvGet('lastVacuumAt');
  const everyMs = Math.max(1, m.vacuumEveryDays || 7) * 86400 * 1000;
  if (!last || (Date.now() - Date.parse(last)) > everyMs) {
    try { exec('VACUUM'); kvSet('lastVacuumAt', new Date().toISOString()); vacuumed = true; } catch (e) { log.warn('VACUUM failed', e.message); }
  }
  if (events || tasks || emails || discovery || vacuumed) log.info(`maintenance: pruned ${events} events, ${tasks} tasks, ${emails} emails, ${discovery} discovery batches${vacuumed ? ' + vacuumed' : ''}`);
  return { events, tasks, emails, discovery, vacuumed };
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
  // Auto-repair the work-mode/location split on every read (idempotent). This makes a
  // bad stored config — e.g. "remote" typed as a location — heal itself the next time
  // any code path reads settings, with no separate migration step.
  if (merged.autoApply) merged.autoApply = normalizeAutoApply(merged.autoApply);
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

// Annotate jobs with auto-apply PROVENANCE for the UI: whether the auto-apply pipeline
// ever touched the job (`autoApply`), and HOW it was submitted (`via`: 'auto' if a
// completed auto-apply task exists, 'manual' if it reached submitted+ without one, else
// null = not submitted yet). One batched query, so list views stay cheap.
const SUBMITTED_PLUS = new Set(['submitted', 'contacted', 'interview_1', 'interview_2', 'interview_final', 'offer', 'hired', 'rejected', 'ghosted']);
function annotateAutoApply(jobs) {
  if (!jobs || !jobs.length) return jobs || [];
  const ids = jobs.map((j) => j.id);
  const place = ids.map(() => '?').join(',');
  const map = {};
  // "Submitted via auto-apply" = the executor reached a done OR awaiting_review task
  // (awaiting_review = submit was clicked, pending confirm). A merely failed/skipped
  // task does NOT count — those never actually submitted. hasAutoTask flags that an AUTO
  // (mode='auto') task existed at all, so a manual finish on top of it is "auto-assisted".
  for (const r of all(
    `SELECT job_id,
            MAX(CASE WHEN state IN ('done','awaiting_review') THEN 1 ELSE 0 END) AS hasSubmitted,
            MAX(CASE WHEN mode = 'auto' THEN 1 ELSE 0 END) AS hasAutoTask
       FROM auto_apply_tasks WHERE job_id IN (${place}) GROUP BY job_id`, ids)) map[r.job_id] = r;
  for (const j of jobs) {
    const m = map[j.id];
    j.autoApply = !!m || (Array.isArray(j.tags) && j.tags.includes('auto-apply'));
    // via: 'auto' = the auto pipeline submitted it; 'auto-assisted' = an auto task ran but
    // the human finished/stepped in to reach submitted; 'manual' = submitted with no auto
    // task involved; null = not submitted yet.
    if (m && m.hasSubmitted) j.via = 'auto';
    else if (SUBMITTED_PLUS.has(j.status)) j.via = (m && m.hasAutoTask) ? 'auto-assisted' : 'manual';
    else j.via = null;
  }
  return jobs;
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
  return annotateAutoApply(all(sql, args).map(rowToJob));
}

function getJob(id) {
  const j = rowToJob(get('SELECT * FROM jobs WHERE id = ?', [id]));
  return j ? annotateAutoApply([j])[0] : j;
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
    if (!opts.skipHarvest) harvestAnswersToProfile(incoming.answers, { jobId: id, source: incoming.source, status: incoming.status });
    // P3: a job created already-submitted (e.g. a manual apply captured at submit) distills
    // into recipes. Lazy-require avoids a circular load (distiller requires db); best-effort.
    if (incoming.status === 'submitted') { try { require('./distiller').distillJob(id, resolveProfileId(incoming.source)); } catch {} }
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

  if (!opts.skipHarvest) harvestAnswersToProfile(incoming.answers, { jobId: existing.id, source: incoming.source || prev.source, status: incoming.status || prev.status });

  const after = getJob(existing.id);
  // P3: a job that just crossed into 'submitted' distills its answers into recipes. Lazy
  // require (distiller requires db) avoids a circular load; best-effort, never fatal.
  if (crossedSubmitted(prev.status, nextStatus)) {
    try { require('./distiller').distillJob(existing.id, resolveProfileId(incoming.source || prev.source)); } catch {}
  }
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
  // Manual vs auto-apply split of submitted applications (the dashboard distinction the
  // user asked for): a job counts as AUTO if a completed auto-apply task exists for it;
  // the rest of the submitted-or-beyond jobs were applied to by hand.
  const submittedTotal = [...SUBMITTED_PLUS].reduce((s, st) => s + (byStatus[st] || 0), 0);
  const submittedAuto = get(
    `SELECT COUNT(DISTINCT t.job_id) AS n FROM auto_apply_tasks t WHERE t.state = 'done'`).n;
  const submittedManual = Math.max(0, submittedTotal - submittedAuto);
  const dayAgo = new Date(Date.now() - 86400 * 1000).toISOString();
  const submittedToday = get("SELECT COUNT(*) AS n FROM auto_apply_tasks WHERE state = 'done' AND updated_at >= ?", [dayAgo]).n;
  // Pipeline funnel + response signal for the dashboard.
  const reached = (sts) => sts.reduce((s, st) => s + (byStatus[st] || 0), 0);
  const responded = reached(['contacted', 'interview_1', 'interview_2', 'interview_final', 'offer', 'hired']);
  const interviews = reached(['interview_1', 'interview_2', 'interview_final', 'offer', 'hired']);
  const offers = reached(['offer', 'hired']);
  const responseRate = submittedTotal ? Math.round(100 * responded / submittedTotal) : null;
  return {
    total, thisWeek, needsReview, byStatus, bySource,
    submittedTotal, submittedAuto, submittedManual, submittedToday,
    funnel: { submitted: submittedTotal, responded, interviews, offers, responseRate },
  };
}

// Per-day submission activity for the dashboard sparkline — auto (completed auto-apply
// tasks) vs manual (jobs that reached submitted+ without one). Last `days` days, oldest→newest.
function activityTrend({ days = 14 } = {}) {
  const n = Math.max(1, Math.min(60, Number(days) || 14));
  const out = [];
  const idx = {};
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400 * 1000).toISOString().slice(0, 10);
    const row = { date: d, auto: 0, manual: 0 };
    idx[d] = row; out.push(row);
  }
  const since = out[0].date;
  for (const r of all("SELECT substr(updated_at,1,10) AS d, COUNT(*) AS n FROM auto_apply_tasks WHERE state='done' AND substr(updated_at,1,10) >= ? GROUP BY d", [since])) {
    if (idx[r.d]) idx[r.d].auto = r.n;
  }
  // Manual = a job's status became submitted via a NON-auto-apply event (passive capture,
  // manual change, sync), counted on the event day.
  for (const r of all(
    `SELECT substr(e.timestamp,1,10) AS d, COUNT(DISTINCT e.job_id) AS n
       FROM events e
      WHERE e.type='status_changed' AND e.source NOT IN ('auto-apply','system')
        AND substr(e.timestamp,1,10) >= ?
        AND NOT EXISTS (SELECT 1 FROM auto_apply_tasks t WHERE t.job_id=e.job_id AND t.state IN ('done','awaiting_review'))
      GROUP BY d`, [since])) {
    if (idx[r.d]) idx[r.d].manual = r.n;
  }
  return out;
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

function qaRecord({ profileId, question, answer, source, fieldType, lineageSource }) {
  if (isSensitiveKey(question)) return null;   // write-boundary safety rail (see profileFieldUpsert)
  const qn = normalizeQuestion(question);
  if (!qn || answer == null || answer === '') return null;
  if (!profileId) { log.warn('qaRecord: missing profileId — answer not saved'); return null; }
  const cur = get('SELECT * FROM qa WHERE profile_id = ? AND question_norm = ?', [profileId, qn]);
  const ts = now();
  // answer_lineage (P1): a capped JSON trail of HOW each answer was obtained
  // ({source,matched_label,field_type,ts}) — the Observer stamps 'manual' for answers
  // the user entered by hand; this powers P3/P6 credit assignment (boost answers that
  // led to interviews) without changing the stored answer itself.
  const lineEntry = { source: lineageSource || source || 'capture', matched_label: String(question).slice(0, 120), field_type: fieldType || null, ts };
  const lineage = cur ? safeParse(cur.answer_lineage, []) : [];
  lineage.push(lineEntry);
  const lineageJson = JSON.stringify(lineage.slice(-10));
  if (cur) {
    const sources = new Set(safeParse(cur.sources, []));
    if (source) sources.add(source);
    run('UPDATE qa SET answer = ?, seen_count = seen_count + 1, sources = ?, answer_lineage = ?, updated_at = ? WHERE id = ?',
        [String(answer).slice(0, 2000), JSON.stringify([...sources]), lineageJson, ts, cur.id]);
    return get('SELECT * FROM qa WHERE id = ?', [cur.id]);
  }
  const row = {
    id: uid('qa'), qn, question: String(question).slice(0, 500),
    answer: String(answer).slice(0, 2000),
    sources: JSON.stringify(source ? [source] : []), ts,
  };
  run(`INSERT INTO qa (id, profile_id, question_norm, question, answer, seen_count, sources, answer_lineage, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [row.id, profileId, row.qn, row.question, row.answer, row.sources, lineageJson, row.ts]);
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

function profileFieldUpsert({ profileId, question, value, locale, fieldType, sourceJobId, source, confidence, fromUser, lineageSource }) {
  const label = String(question || '').trim();
  // WRITE-BOUNDARY SAFETY RAIL (non-negotiable): never persist credentials/payment/EEO,
  // no matter who calls this (Observer, harvest, import, AI). Layered with the caller-side
  // filters so a single missed check can't leak a password/CVV/security-answer to memory.
  if (isSensitiveKey(label)) return null;
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
  if (!suppressed) { try { qaRecord({ profileId, question: label, answer: val, source, fieldType, lineageSource: lineageSource || (fromUser ? 'user' : 'manual') }); } catch {} }
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

// EEO / demographic / sensitive questions are NEVER retained in memory — the
// server-side backstop to the extension's NEVER_AUTOFILL_RX, so even a buggy or
// malicious client can't POST protected-class answers (race/gender/disability/
// veteran/criminal-history/SSN/DOB) into long-lived profile memory.
// Two classes are blocked: (1) EEO / demographic / protected-class, and (2) — added for
// the always-on Observer — CREDENTIALS & PAYMENT. The credential terms are deliberately
// precise so they never eat legitimate fields: `security.?(question|answer)` (NOT bare
// "security", so "security clearance" passes), `\bpin\b` (word-bounded, so "Pinterest"/
// "shipping" pass), `pass(word|code|phrase)` (so "passport"/"compass" don't false-match).
const SENSITIVE_RX = /(ethnic|race\b|gender|\bsex\b|disabilit|veteran|criminal|background.?check|felony|conviction|pronoun|sexual.?orientation|\blgbtq?|\bssn\b|social.?security|date.?of.?birth|\bdob\b|pass(word|code|phrase)|\bpwd\b|payment|credit.?card|card.?number|\bcardnum|\bcvv\b|\bcvc2?\b|security.?code|\bpin\b|\biban\b|routing.?number|bank.?account|sort.?code|\bpassport\b|credential|security.?(question|answer)|secret.?(question|answer))/i;
function isSensitiveKey(key) {
  const k = String(key || '');
  try { return SENSITIVE_RX.test(k) || SENSITIVE_RX.test(humanizeKey(k)); } catch { return SENSITIVE_RX.test(k); }
}

// UI-noise guard: passive capture occasionally scrapes job-board chrome (the search
// box, filter sliders, nav) into "answers". Never let that pollute profile memory.
const JUNK_KEY_RX = /^(search( search)?|filter|sort( by)?|skip to (main )?content|menu|home|messaging|notifications|my network|jobs?|sign in|join now|easy apply|save[d]?|dismiss|rd|rb|rm|show more|see more|distance|date posted)$/i;
function isJunkAnswer(key, value) {
  let k = '';
  try { k = humanizeKey(String(key || '')).trim().toLowerCase(); } catch { k = String(key || '').trim().toLowerCase(); }
  if (!k || k.length < 2) return true;
  if (JUNK_KEY_RX.test(k)) return true;
  const v = String(value == null ? '' : value).trim();
  if (!v) return true;
  if (v.toLowerCase() === k) return true;                          // "search search"-style echo
  if (/slider|range/.test(k) && /^[\d.\s-]{1,4}$/.test(v)) return true;  // filter-slider thumb values
  return false;
}

// Fan a job's captured answers into a profile's memory (called from upsertJob).
// The owning profile = the source-matched profile (else the default).
function harvestAnswersToProfile(answers, { profileId, jobId, source, status } = {}) {
  if (!answers || typeof answers !== 'object') return 0;
  let enabled = true;
  try { enabled = getSettings().harvest.enabled !== false; } catch {}
  if (!enabled) return 0;
  const pid = profileId || resolveProfileId(source);
  // SELF-LEARNING: answers from an application that actually went through (submitted —
  // manual OR auto) demonstrably worked, so learn them with HIGH confidence; in-progress
  // captures stay tentative. High-confidence answers are preferred next time.
  const confidence = status === 'submitted' ? 0.85 : 0.6;
  // LINEAGE: a passive/manual capture is normally 'manual'. But if an AUTO auto-apply task
  // exists for this job (mode='auto', regardless of how it ended), then the user finishing
  // or stepping in on that apply is an AUTO-ASSISTED capture — the auto run set it up and a
  // human assisted. Distinguish it so the apply-method breakdown can show "auto (assisted)"
  // vs pure "manual". (A 'supervised'/'review' task is NOT auto — leave those as manual.)
  let lineageSource = 'manual';
  if (jobId) {
    try {
      const autoTask = get(
        "SELECT 1 FROM auto_apply_tasks WHERE job_id = ? AND mode = 'auto' LIMIT 1", [jobId]);
      if (autoTask) lineageSource = 'auto-assisted';
    } catch {}
  }
  let n = 0;
  for (const [key, raw] of Object.entries(answers)) {
    if (isSensitiveKey(key)) continue;
    const value = Array.isArray(raw) ? raw.join(', ') : raw;
    if (value == null || String(value).trim() === '') continue;
    if (isJunkAnswer(key, value)) continue;   // never harvest job-board UI noise
    try {
      if (profileFieldUpsert({ profileId: pid, question: humanizeKey(key), value, sourceJobId: jobId, source, confidence, lineageSource })) n++;
    } catch {}
  }
  return n;
}

// ============================================================
// Apprenticeship Engine — Observer (navigation log + ATS classifier)  [P2]
// ============================================================
// The Observer records the human navigation path (page visits, board→ATS handoff
// edges, submits) so recipes can attribute every step to an (ats, company) pair and
// learn which boards funnel to which ATS. classifyAts is the single, node-testable
// source of truth for "what ATS is this URL and which company does it encode" — it
// mirrors the extension's detectSource() (sites/index.js) but adds the iCIMS/
// SuccessFactors/Taleo/Bamboo/Ashby/SmartRecruiters/Jobvite/direct families the
// design needs. Anything unrecognized with an apply-looking URL is 'direct'.

const APPLY_URL_RX = /(apply|application|career|jobs?|gh_jid|requisition|posting)/i;
// Boards = aggregators a human starts on; ATS = the system a real apply runs in. A
// board→ATS transition across a referrer is a 'handoff' edge (the whole point of P2).
const ATS_BOARDS = new Set(['linkedin', 'indeed', 'glassdoor']);
const ATS_SYSTEMS = new Set(['workday', 'greenhouse', 'lever', 'icims', 'successfactors', 'taleo', 'bamboo', 'ashby', 'smartrecruiters', 'jobvite']);

// normKey-style company canonicalization (lowercase + strip non-alphanumerics), reused
// from the company_key convention so attribution joins the recipe tables cleanly.
function normCompanyKey(s) {
  const k = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return k || null;
}

// classifyAts(url) → { ats, companyKey, host }. Robust to bad/relative URLs.
// companyKey is extracted only where the ATS encodes it in the URL (greenhouse/lever/
// workday/ashby/icims/smartrecruiters); null otherwise (the caller passes the known
// company separately for linkedin/indeed/direct).
function classifyAts(url) {
  let u;
  try { u = new URL(String(url)); } catch { return { ats: 'direct', companyKey: null, host: '' }; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);

  // Workday — <company>.wdN.myworkdayjobs.com / wdN.myworkdaysite.com
  let mm = host.match(/^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/) || host.match(/^([a-z0-9-]+)\.wd\d+\.myworkdaysite\.com$/);
  if (mm) return { ats: 'workday', companyKey: normCompanyKey(mm[1]), host };
  if (/myworkdayjobs\.com$|myworkdaysite\.com$|\.workday\.com$/.test(host)) return { ats: 'workday', companyKey: null, host };

  // Greenhouse — boards.greenhouse.io/<company>/... (also job-boards.* + embed host)
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    return { ats: 'greenhouse', companyKey: (segs[0] && segs[0] !== 'embed') ? normCompanyKey(segs[0]) : null, host };
  }

  // Lever — jobs.lever.co/<company>/...
  if (/(^|\.)lever\.co$/.test(host)) return { ats: 'lever', companyKey: normCompanyKey(segs[0]), host };

  // Ashby — jobs.ashbyhq.com/<company>/...
  if (/(^|\.)ashbyhq\.com$/.test(host)) return { ats: 'ashby', companyKey: normCompanyKey(segs[0]), host };

  // iCIMS — careers-<company>.icims.com  (also <company>.icims.com)
  if (/(^|\.)icims\.com$/.test(host)) {
    const sub = host.replace(/\.icims\.com$/, '').replace(/^careers[-.]?/, '');
    return { ats: 'icims', companyKey: normCompanyKey(sub), host };
  }

  // SmartRecruiters — careers.smartrecruiters.com/<company>/... / <company>.smartrecruiters.com
  if (/(^|\.)smartrecruiters\.com$/.test(host)) {
    const sub = host.replace(/\.smartrecruiters\.com$/, '');
    const co = (sub && sub !== 'careers' && sub !== 'jobs' && sub !== 'www') ? sub : segs[0];
    return { ats: 'smartrecruiters', companyKey: normCompanyKey(co), host };
  }

  // SuccessFactors — *.successfactors.com / careers*.sap (SAP-hosted)
  if (/(^|\.)successfactors\.com$/.test(host) || /(^|\.)successfactors\.eu$/.test(host) || /^careers.*\.sap\b/.test(host)) {
    return { ats: 'successfactors', companyKey: null, host };
  }

  // Taleo — *.taleo.net
  if (/(^|\.)taleo\.net$/.test(host)) return { ats: 'taleo', companyKey: null, host };

  // BambooHR — <company>.bamboohr.com
  if (/(^|\.)bamboohr\.com$/.test(host)) {
    const sub = host.replace(/\.bamboohr\.com$/, '');
    return { ats: 'bamboo', companyKey: (sub && sub !== 'www') ? normCompanyKey(sub) : null, host };
  }

  // Jobvite — *.jobvite.com / jobs.jobvite.com/<company>/...
  if (/(^|\.)jobvite\.com$/.test(host)) {
    const sub = host.replace(/\.jobvite\.com$/, '');
    const co = (sub && sub !== 'jobs' && sub !== 'app' && sub !== 'www') ? sub : segs[0];
    return { ats: 'jobvite', companyKey: normCompanyKey(co), host };
  }

  // Boards — company lives in query/path, not the host → companyKey null (caller supplies).
  if (/(^|\.)linkedin\.com$/.test(host)) return { ats: 'linkedin', companyKey: null, host };
  if (/(^|\.)indeed\.[a-z.]+$/.test(host)) return { ats: 'indeed', companyKey: null, host };
  // Glassdoor — a board (like LinkedIn/Indeed). The company is encoded in the slug, not the
  // host, so companyKey is null here UNLESS the URL exposes a derivable employer slug
  // (/Overview/Working-at-<Company>-EI_... or job-listing/<title>-at-<company>-JV_...). When
  // it derives one we pass it; otherwise null and the caller supplies job.company. Glassdoor
  // frequently REDIRECTS to an external ATS — that handoff is already handled by the P2
  // nav/handoff edge + classifyAts on the destination, so we only classify the host itself.
  if (/(^|\.)glassdoor\.[a-z.]+$/.test(host)) {
    let companyKey = null;
    let m = u.pathname.match(/\/Overview\/Working-at-([\w.-]+?)-EI_/i)
      || u.pathname.match(/\/job-listing\/.*?-at-([\w.-]+?)-(?:JV_|SRCH_)/i);
    if (m && m[1]) companyKey = normCompanyKey(m[1]);
    return { ats: 'glassdoor', companyKey: companyKey || null, host };
  }

  // Anything else that looks like an apply/careers page → a direct company-site apply.
  return { ats: 'direct', companyKey: null, host };
}

// nav_events rolling cap: keep the newest N events per profile, pruned on insert, so the
// log can't grow unbounded (design Risk #8). 2000 ≈ weeks of heavy manual applying.
const NAV_EVENTS_CAP = 2000;

// recordNavEvent — write one navigation event for the Observer. Classifies the url (and
// referrer) via classifyAts, infers 'handoff' on a board→ATS transition when kind isn't
// given, falls back the company attribution to the caller-supplied company, then enforces
// the rolling cap. All ids TEXT (uid). Returns the inserted row.
function recordNavEvent({ profileId, url, referrer, kind, sessionId, company } = {}) {
  const pid = profileId || ensureDefaultProfileId();
  const cur = classifyAts(url);
  const ref = referrer ? classifyAts(referrer) : { ats: null, companyKey: null, host: '' };
  // Handoff edge: the referrer and the current page are different ATS families AND the
  // pair is exactly board↔ATS-system (e.g. linkedin → workday) — the moment a human
  // leaves an aggregator for the real applicant-tracking system.
  const isHandoff = !!ref.ats && ref.ats !== cur.ats
    && ((ATS_BOARDS.has(ref.ats) && ATS_SYSTEMS.has(cur.ats)) || (ATS_SYSTEMS.has(ref.ats) && ATS_BOARDS.has(cur.ats)));
  const finalKind = kind || (isHandoff ? 'handoff' : 'visit');
  const companyKey = cur.companyKey || normCompanyKey(company);
  const row = {
    id: uid('nav'), profile_id: pid, session_id: sessionId || null,
    url_norm: normJobUrl(url) || (url ? String(url).toLowerCase() : null),
    host: cur.host || null, ats: cur.ats, company_key: companyKey,
    referrer_norm: referrer ? (normJobUrl(referrer) || String(referrer).toLowerCase()) : null,
    kind: finalKind, ts: now(),
  };
  run(`INSERT INTO nav_events (id, profile_id, session_id, url_norm, host, ats, company_key, referrer_norm, kind, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.profile_id, row.session_id, row.url_norm, row.host, row.ats, row.company_key, row.referrer_norm, row.kind, row.ts]);
  // Enforce the rolling cap: drop everything past the newest NAV_EVENTS_CAP for this profile.
  run('DELETE FROM nav_events WHERE profile_id = ? AND id NOT IN (SELECT id FROM nav_events WHERE profile_id = ? ORDER BY ts DESC LIMIT ?)',
      [pid, pid, NAV_EVENTS_CAP]);
  return row;
}

// Read helper (newest-first), mainly for tests + the future distiller session grouping.
function navEventsForProfile(profileId, limit = NAV_EVENTS_CAP) {
  const lim = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : NAV_EVENTS_CAP;
  return all('SELECT * FROM nav_events WHERE profile_id = ? ORDER BY ts DESC LIMIT ?', [profileId, lim]);
}

// ============================================================
// Apprenticeship Engine — Recipe Store + Transfer  [P3]
// ============================================================
// Recipes are the transfer unit: a target page resolves to (ats, company_key), and
// `resolveRecipe` blends the scope='ats' recipe (transfers furthest — one Workday apply
// teaches every Workday company) with the scope='company' overlay (company-specific
// screening), company winning on label-pattern conflict. The distiller (distiller.js)
// synthesizes these rows from a completed application's harvested answers; replay (P5)
// consumes them. All ids TEXT (uid), matching the rest of the schema.

function rowToRecipe(r) {
  if (!r) return null;
  return {
    id: r.id, profileId: r.profile_id, scope: r.scope, ats: r.ats,
    companyKey: r.company_key || null, siteDomain: r.site_domain || null,
    confidence: r.confidence, rewardScore: r.reward_score,
    successCount: r.success_count, failCount: r.fail_count, seenCount: r.seen_count,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// upsertRecipe — insert-or-update an ats_recipes row keyed by UNIQUE(profile_id, scope,
// ats, company_key). On a repeat, bump seen_count + updated_at (and refresh site_domain
// if newly known). company_key is normalized; NULL for scope='ats'. Returns the row.
function upsertRecipe({ profileId, scope, ats, companyKey, siteDomain } = {}) {
  const pid = profileId || ensureDefaultProfileId();
  const sc = scope === 'company' ? 'company' : 'ats';
  const at = String(ats || '').toLowerCase().trim();
  if (!at) return null;
  // scope='ats' recipes are company-agnostic — never key them to a company.
  const ck = sc === 'company' ? (normCompanyKey(companyKey) || null) : null;
  const ts = now();
  const cur = ck == null
    ? get('SELECT * FROM ats_recipes WHERE profile_id = ? AND scope = ? AND ats = ? AND company_key IS NULL', [pid, sc, at])
    : get('SELECT * FROM ats_recipes WHERE profile_id = ? AND scope = ? AND ats = ? AND company_key = ?', [pid, sc, at, ck]);
  if (cur) {
    run('UPDATE ats_recipes SET seen_count = seen_count + 1, site_domain = COALESCE(?, site_domain), updated_at = ? WHERE id = ?',
        [siteDomain || null, ts, cur.id]);
    return rowToRecipe(get('SELECT * FROM ats_recipes WHERE id = ?', [cur.id]));
  }
  const id = uid('recipe');
  run(`INSERT INTO ats_recipes (id, profile_id, scope, ats, company_key, site_domain, confidence, reward_score, success_count, fail_count, seen_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0.5, 0, 0, 0, 1, ?, ?)`,
      [id, pid, sc, at, ck, siteDomain || null, ts, ts]);
  return rowToRecipe(get('SELECT * FROM ats_recipes WHERE id = ?', [id]));
}

function getRecipe(profileId, scope, ats, companyKey) {
  const pid = profileId;
  const sc = scope === 'company' ? 'company' : 'ats';
  const at = String(ats || '').toLowerCase().trim();
  if (!pid || !at) return null;
  const ck = sc === 'company' ? (normCompanyKey(companyKey) || null) : null;
  const r = ck == null
    ? get('SELECT * FROM ats_recipes WHERE profile_id = ? AND scope = ? AND ats = ? AND company_key IS NULL', [pid, sc, at])
    : get('SELECT * FROM ats_recipes WHERE profile_id = ? AND scope = ? AND ats = ? AND company_key = ?', [pid, sc, at, ck]);
  return rowToRecipe(r);
}

function rowToStep(r) {
  if (!r) return null;
  return {
    id: r.id, recipeId: r.recipe_id, stepIndex: r.step_index, action: r.action,
    labelPattern: r.label_pattern || null, fieldType: r.field_type || null,
    strategy: r.strategy || null, options: safeParse(r.options, null),
    validationPattern: r.validation_pattern || null, advanceText: r.advance_text || null,
    medianDelayMs: r.median_delay_ms ?? null, confidence: r.confidence ?? null,
    // T3 locator bundle (additive; null on pre-enrichment steps).
    selector: r.selector || null, xpath: r.xpath || null, attrs: r.attrs || null,
    html: r.html || null, screenshotId: r.screenshot_id || null,
    source: r.source || null, defaultValue: r.default_value ?? null,
    updatedAt: r.updated_at,
  };
}

// upsertRecipeStep — a recipe's step is identified by (recipe_id, label_pattern). If a step
// with the same label_pattern already exists, update it in place; otherwise append at the
// next free step_index. `options` is stored as JSON. Returns the step row.
//
// T3: ALSO accepts + persists the locator bundle (selector/xpath/attrs/html/screenshotId/
// source/defaultValue). All optional + backward-compatible (existing answer-only callers
// pass none, write nothing new). `attrs` is JSON-stringified if an object. On UPDATE of an
// existing step, the locator columns are refreshed ONLY when the incoming value is non-null
// (COALESCE) so a fresh demonstration without a selector never wipes a good one.
function upsertRecipeStep({ recipeId, stepIndex, action, labelPattern, fieldType, strategy, options, advanceText, medianDelayMs, confidence,
                            selector, xpath, attrs, html, screenshotId, source, defaultValue } = {}) {
  if (!recipeId) return null;
  const lp = labelPattern != null ? String(labelPattern) : null;
  const ts = now();
  const opts = options == null ? null : (typeof options === 'string' ? options : JSON.stringify(options));
  const attrsStr = attrs == null ? null : (typeof attrs === 'string' ? attrs : JSON.stringify(attrs));
  const cur = lp != null
    ? get('SELECT * FROM recipe_steps WHERE recipe_id = ? AND label_pattern = ?', [recipeId, lp])
    : null;
  if (cur) {
    run(`UPDATE recipe_steps SET
         action=COALESCE(?, action), field_type=COALESCE(?, field_type),
         strategy=COALESCE(?, strategy), options=COALESCE(?, options),
         advance_text=COALESCE(?, advance_text), median_delay_ms=COALESCE(?, median_delay_ms),
         confidence=COALESCE(?, confidence),
         selector=COALESCE(?, selector), xpath=COALESCE(?, xpath), attrs=COALESCE(?, attrs),
         html=COALESCE(?, html), screenshot_id=COALESCE(?, screenshot_id),
         source=COALESCE(?, source), default_value=COALESCE(?, default_value),
         updated_at=?
         WHERE id=?`,
        [action || null, fieldType || null, strategy || null, opts,
         advanceText ?? null, medianDelayMs ?? null, confidence ?? null,
         selector ?? null, xpath ?? null, attrsStr, html ?? null, screenshotId ?? null,
         source ?? null, defaultValue ?? null, ts, cur.id]);
    return rowToStep(get('SELECT * FROM recipe_steps WHERE id = ?', [cur.id]));
  }
  // Append: next index = caller-supplied, else max+1 for this recipe.
  let idx = Number.isFinite(Number(stepIndex)) ? Number(stepIndex)
    : ((get('SELECT MAX(step_index) AS m FROM recipe_steps WHERE recipe_id = ?', [recipeId])?.m ?? -1) + 1);
  const id = uid('step');
  run(`INSERT INTO recipe_steps (id, recipe_id, step_index, action, label_pattern, field_type, strategy, options, validation_pattern, advance_text, median_delay_ms, confidence,
       selector, xpath, attrs, html, screenshot_id, source, default_value, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, recipeId, idx, String(action || 'fill'), lp, fieldType || null, strategy || null, opts,
       advanceText ?? null, medianDelayMs ?? null, confidence ?? null,
       selector ?? null, xpath ?? null, attrsStr, html ?? null, screenshotId ?? null,
       source ?? null, defaultValue ?? null, ts]);
  return rowToStep(get('SELECT * FROM recipe_steps WHERE id = ?', [id]));
}

// Ordered steps for a recipe (step_index ascending = replay order).
function recipeSteps(recipeId) {
  if (!recipeId) return [];
  return all('SELECT * FROM recipe_steps WHERE recipe_id = ? ORDER BY step_index ASC', [recipeId]).map(rowToStep);
}

// markRecipeOutcome — bump the mechanical success/fail counters after a replay (or a
// distilled completed application). Used now by the distiller; later by the replayer.
function markRecipeOutcome(recipeId, { success } = {}) {
  if (!recipeId) return null;
  const col = success ? 'success_count' : 'fail_count';
  run(`UPDATE ats_recipes SET ${col} = ${col} + 1, updated_at = ? WHERE id = ?`, [now(), recipeId]);
  return rowToRecipe(get('SELECT * FROM ats_recipes WHERE id = ?', [recipeId]));
}

// recordRecipeCorrection(recipeId, payload) — the replay/teach feedback surface [P5 + T4].
//
// TWO modes, decided by whether a REPLACEMENT bundle is supplied:
//
//  • AUTHORITATIVE REWRITE (T4 — Live Teach & Correct): when the user watches a
//    supervised run, hits "Fix this", and picks the correct element / value, the
//    payload carries a replacement locator/value
//    ({ labelPattern, selector, xpath, attrs, html, value, fieldType, action }).
//    We find the step matching labelPattern (or CREATE it), upsertRecipeStep it with
//    the new selector/xpath/attrs/html/default_value/field_type, source:'correction',
//    and HIGH confidence (0.95 — user-authoritative). A confirmed correction is a
//    POSITIVE signal, so we BUMP the recipe's confidence (not decay) and credit it.
//    The credential rail holds: a sensitive label NEVER stores a value or html.
//
//  • DECAY (today's P5 behavior): with NO replacement (a plain "this was wrong" with
//    no fix), we DECAY the recipe's confidence (*0.8, floored at 0.1 so it stays
//    revivable), bump fail_count, and decay the named step's confidence too.
//
// Backward-compatible: existing callers pass only { labelPattern } → pure decay path.
function recordRecipeCorrection(recipeId, payload = {}) {
  if (!recipeId) return null;
  const ts = now();
  const r = get('SELECT * FROM ats_recipes WHERE id = ?', [recipeId]);
  if (!r) return null;

  const { labelPattern, selector, xpath, attrs, html, value, fieldType, action } = payload || {};
  // A replacement is given when any locator OR a value is supplied alongside a label.
  const hasReplacement = labelPattern != null && String(labelPattern).trim() &&
    (selector != null || xpath != null || attrs != null || html != null || value != null);

  if (hasReplacement) {
    const lp = String(labelPattern);
    // Credential rail (authoritative): never persist a value/html for a sensitive field.
    const sensitive = isSensitiveKey(lp);
    const CONF = 0.95;   // user-confirmed → authoritative
    upsertRecipeStep({
      recipeId,
      action: action || null,
      labelPattern: lp,
      fieldType: fieldType || null,
      selector: selector != null ? String(selector) : null,
      xpath: xpath != null ? String(xpath) : null,
      attrs: attrs != null ? attrs : null,
      html: sensitive ? null : (html != null ? String(html) : null),
      defaultValue: sensitive ? null : (value != null ? String(value) : null),
      source: 'correction',
      confidence: CONF,
    });
    // A confirmed correction is a positive signal: raise the recipe's confidence
    // toward CONF (never lower it), credit a success, and touch updated_at.
    const bumped = Math.min(CONF, Math.max(Number(r.confidence) || 0.5, (Number(r.confidence) || 0.5) * 0.5 + CONF * 0.5));
    run('UPDATE ats_recipes SET confidence = ?, success_count = success_count + 1, updated_at = ? WHERE id = ?',
        [bumped, ts, recipeId]);
    return rowToRecipe(get('SELECT * FROM ats_recipes WHERE id = ?', [recipeId]));
  }

  // --- no replacement → today's decay behavior ---
  const decayed = Math.max(0.1, (Number(r.confidence) || 0.5) * 0.8);
  run('UPDATE ats_recipes SET confidence = ?, fail_count = fail_count + 1, updated_at = ? WHERE id = ?',
      [decayed, ts, recipeId]);
  if (labelPattern != null && String(labelPattern).trim()) {
    const lp = String(labelPattern);
    const step = get('SELECT * FROM recipe_steps WHERE recipe_id = ? AND label_pattern = ?', [recipeId, lp]);
    if (step) {
      const sc = Math.max(0.1, (Number(step.confidence) || 0.5) * 0.8);
      run('UPDATE recipe_steps SET confidence = ?, updated_at = ? WHERE id = ?', [sc, ts, step.id]);
    }
  }
  return rowToRecipe(get('SELECT * FROM ats_recipes WHERE id = ?', [recipeId]));
}

// resolveRecipe(ats, companyKey, profileId) — the transfer engine. Fetch the scope='ats'
// recipe (transfers across every company on that ATS) and the scope='company' overlay
// (this company's specifics), then merge their steps by label_pattern: COMPANY OVERLAY
// WINS on conflict, the ATS recipe fills the rest. Returns the merged ordered steps plus a
// 0..1 coverage score and a blended confidence, so discovery can prefer ATSes it knows.
function resolveRecipe(ats, companyKey, profileId) {
  const pid = profileId || ensureDefaultProfileId();
  const atsRecipe = getRecipe(pid, 'ats', ats, null);
  const companyRecipe = companyKey ? getRecipe(pid, 'company', ats, companyKey) : null;
  const atsSteps = atsRecipe ? recipeSteps(atsRecipe.id) : [];
  const companySteps = companyRecipe ? recipeSteps(companyRecipe.id) : [];

  // Merge by label_pattern, company overlay winning. Company steps come first (their
  // specifics gate the flow), then any ATS steps not already covered by a company label.
  const byLabel = new Map();
  const merged = [];
  for (const s of companySteps) {
    const key = s.labelPattern || `__co_${merged.length}`;
    if (!byLabel.has(key)) { byLabel.set(key, true); merged.push({ ...s, scope: 'company' }); }
  }
  for (const s of atsSteps) {
    const key = s.labelPattern || `__ats_${merged.length}`;
    if (byLabel.has(key)) continue;   // company overlay already provides this field
    byLabel.set(key, true);
    merged.push({ ...s, scope: 'ats' });
  }
  merged.forEach((s, i) => { s.stepIndex = i; });

  // Coverage (0..1): how complete this resolution is. With no steps at all it's 0. With an
  // ATS recipe it covers the generic fields; a company overlay adds the company specifics.
  // Define it as the distinct merged-step count saturating toward 1 (≥6 fields ≈ a full
  // form), with a small bonus when a company overlay is present (specifics are covered).
  const base = merged.length ? Math.min(1, merged.length / 6) : 0;
  const overlayBonus = (companyRecipe && companySteps.length) ? 0.15 : 0;
  const coverage = merged.length ? Math.min(1, base * 0.85 + overlayBonus) : 0;
  // Blend confidence: company overlay weighted toward, falling back to whichever exists.
  const ac = atsRecipe ? (atsRecipe.confidence ?? 0.5) : null;
  const cc = companyRecipe ? (companyRecipe.confidence ?? 0.5) : null;
  let confidence = 0;
  if (ac != null && cc != null) confidence = cc * 0.6 + ac * 0.4;
  else if (cc != null) confidence = cc;
  else if (ac != null) confidence = ac;

  return {
    steps: merged,
    coverage,
    confidence,
    atsRecipeId: atsRecipe ? atsRecipe.id : null,
    companyRecipeId: companyRecipe ? companyRecipe.id : null,
  };
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
      if (isSensitiveKey(key)) continue;
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
// Discovery ledger (JobSpy primary, browser fallback)
// ============================================================
const DISCOVERY_STATUSES = new Set(['running', 'ok', 'empty', 'blocked', 'rate_limited', 'parser_drift', 'timeout', 'unavailable', 'failed']);

function discoveryBatchStart({ provider, source, keyword, location, fallbackOf } = {}) {
  const id = uid('disc');
  run(`INSERT INTO discovery_batches
       (id, provider, source, keyword, location, status, fallback_of, started_at)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
      [id, String(provider || 'unknown'), String(source || 'unknown'), keyword || '', location || '', fallbackOf || null, now()]);
  return discoveryBatchGet(id);
}

function discoveryBatchGet(id) {
  const r = get('SELECT * FROM discovery_batches WHERE id = ?', [id]);
  if (!r) return null;
  return {
    id: r.id, provider: r.provider, source: r.source, keyword: r.keyword || '', location: r.location || '',
    status: r.status, found: r.found_count || 0, accepted: r.accepted_count || 0,
    duplicates: r.duplicate_count || 0, rejected: r.rejected_count || 0,
    error: r.error || null, diagnostics: safeParse(r.diagnostics, {}), fallbackOf: r.fallback_of || null,
    startedAt: r.started_at, completedAt: r.completed_at || null,
  };
}

function discoveryBatchComplete(id, { status, found, accepted, duplicates, rejected, error, diagnostics } = {}) {
  const finalStatus = DISCOVERY_STATUSES.has(status) ? status : 'failed';
  run(`UPDATE discovery_batches SET status=?, found_count=?, accepted_count=?, duplicate_count=?, rejected_count=?,
       error=?, diagnostics=?, completed_at=? WHERE id=?`,
      [finalStatus, Number(found) || 0, Number(accepted) || 0, Number(duplicates) || 0, Number(rejected) || 0,
       error ? String(error).slice(0, 2000) : null, JSON.stringify(diagnostics || {}), now(), id]);
  return discoveryBatchGet(id);
}

function discoveryBatchList({ limit = 50, source } = {}) {
  const n = Math.max(1, Math.min(500, Number(limit) || 50));
  const rows = source
    ? all('SELECT id FROM discovery_batches WHERE source=? ORDER BY started_at DESC LIMIT ?', [source, n])
    : all('SELECT id FROM discovery_batches ORDER BY started_at DESC LIMIT ?', [n]);
  return rows.map((r) => discoveryBatchGet(r.id));
}

function discoveryRecordJob({ jobId, batchId, provider, source, rawUrl, applyCapability = 'unknown' } = {}) {
  if (!jobId || !batchId) return false;
  run(`INSERT OR REPLACE INTO job_discovery_provenance
       (job_id, batch_id, provider, source, raw_url, apply_capability, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [jobId, batchId, provider || 'unknown', source || 'unknown', rawUrl || null,
       ['easy_apply', 'external', 'unknown'].includes(applyCapability) ? applyCapability : 'unknown', now()]);
  return true;
}

function discoveryFallbackQueue({ batchId, source, keyword, location, reason } = {}) {
  if (!batchId || !source) return null;
  const id = uid('dfb');
  run(`INSERT OR IGNORE INTO discovery_fallbacks
       (id, batch_id, source, keyword, location, state, reason, created_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
      [id, batchId, source, keyword || '', location || '', reason || 'primary provider failed', now()]);
  return get('SELECT * FROM discovery_fallbacks WHERE batch_id=? AND source=?', [batchId, source]);
}

function discoveryFallbackNext() {
  const stale = new Date(Date.now() - 5 * 60000).toISOString();
  run("UPDATE discovery_fallbacks SET state='queued', claimed_at=NULL WHERE state='claimed' AND claimed_at < ?", [stale]);
  const r = get("SELECT * FROM discovery_fallbacks WHERE state='queued' ORDER BY created_at ASC LIMIT 1");
  if (!r) return null;
  run("UPDATE discovery_fallbacks SET state='claimed', claimed_at=? WHERE id=? AND state='queued'", [now(), r.id]);
  return get('SELECT * FROM discovery_fallbacks WHERE id=?', [r.id]);
}

function discoveryFallbackComplete(id, { ok, error } = {}) {
  const r = get('SELECT * FROM discovery_fallbacks WHERE id=?', [id]);
  if (!r) return null;
  run("UPDATE discovery_fallbacks SET state=?, reason=COALESCE(?,reason), completed_at=? WHERE id=?",
      [ok ? 'done' : 'failed', error ? String(error).slice(0, 1000) : null, now(), id]);
  return get('SELECT * FROM discovery_fallbacks WHERE id=?', [id]);
}

function discoveryHealth() {
  const latest = all(`SELECT b.* FROM discovery_batches b
    JOIN (SELECT source, MAX(started_at) AS mx FROM discovery_batches GROUP BY source) x
      ON x.source=b.source AND x.mx=b.started_at ORDER BY b.source`).map((r) => discoveryBatchGet(r.id));
  const pending = get("SELECT COUNT(*) AS n FROM discovery_fallbacks WHERE state IN ('queued','claimed')")?.n || 0;
  const lastSuccess = get("SELECT MAX(completed_at) AS at FROM discovery_batches WHERE status IN ('ok','empty')")?.at || null;
  return { providers: latest, pendingFallbacks: pending, lastSuccess };
}

function reconcileDiscovery({ olderThanMinutes = 10 } = {}) {
  const cutoff = new Date(Date.now() - Math.max(1, olderThanMinutes) * 60000).toISOString();
  const interrupted = run(`UPDATE discovery_batches SET status='failed', error=COALESCE(error,'discovery interrupted before completion'), completed_at=?
    WHERE status='running' AND started_at < ?`, [now(), cutoff])?.changes || 0;
  const staleClaims = run("UPDATE discovery_fallbacks SET state='queued', claimed_at=NULL WHERE state='claimed' AND claimed_at < ?", [cutoff])?.changes || 0;
  return { interrupted, staleClaims };
}

function pipelineHealth() {
  const staleCutoff = new Date(Date.now() - 8 * 60000).toISOString();
  const lastTaskActivity = get('SELECT MAX(updated_at) AS at FROM auto_apply_tasks')?.at || null;
  const lastSubmission = get("SELECT MAX(updated_at) AS at FROM auto_apply_tasks WHERE state='done'")?.at || null;
  const staleTasks = get("SELECT COUNT(*) AS n FROM auto_apply_tasks WHERE state IN ('running','scheduled') AND updated_at < ?", [staleCutoff])?.n || 0;
  const invalidWaits = get(`SELECT COUNT(*) AS n FROM auto_apply_tasks WHERE state IN ('awaiting_input','parked')
    AND (pending_questions IS NULL OR TRIM(pending_questions) IN ('','[]','null'))`)?.n || 0;
  return { discovery: discoveryHealth(), lastTaskActivity, lastSubmission, staleTasks, invalidWaits };
}

// ============================================================
// Auto-apply queue
// ============================================================
function taskSiteKey(job) {
  const source = String(job?.source || job?._src || '').trim().toLowerCase();
  const url = String(job?.jobUrl || job?.job_url || job?._url || '').trim();
  try {
    const cls = classifyAts(url);
    if (cls?.ats && cls.ats !== 'direct') return `ats:${cls.ats}`;
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (host) return `host:${host}`;
  } catch {}
  if (source) return `source:${source}`;
  return '';
}

function classifyQueueFailure(input = {}) {
  const pending = Array.isArray(input.pendingQuestions) ? input.pendingQuestions : safeParse(input.pending_questions, []);
  const tr = Array.isArray(input.transcript) ? input.transcript : safeParse(input.transcript, []);
  const trail = tr.slice(-8).map((e) => e && (e.text || e.note || e.step || '')).join(' ');
  const text = [
    input.lastError || input.last_error || '',
    input.parkReason || input.park_reason || '',
    pending.map((q) => `${q?.question || ''} ${q?.reason || ''}`).join(' '),
    trail,
  ].join(' ').toLowerCase();
  const source = String(input.source || input._src || input.job?.source || '').toLowerCase();
  const state = String(input.state || '').toLowerCase();
  const fingerprints = tr.filter((e) => e?.kind === 'recovery' && e?.fingerprint).map((e) => e.fingerprint);
  const repeatedFingerprint = fingerprints.length >= 2 && fingerprints.slice(-2).every((f) => f === fingerprints[fingerprints.length - 1]);
  const mk = (failureClass, action, label) => ({ failureClass, action, label });
  if (state === 'done') return mk('submitted', 'complete', 'Submitted');
  if (state === 'awaiting_review') return mk('review_gate', 'user', 'Ready for review');
  if (['queued', 'scheduled', 'running'].includes(state)) return mk('in_flight', 'wait', 'In flight');
  if (pending.length || state === 'parked' || state === 'awaiting_input' || /missing answer|needs your answer|no confident answer|legal\/eligibility|unanswered question/.test(text)) {
    return mk('missing_info', 'user', 'Needs your answer, then retries');
  }
  if (/easyapply-limit|easy apply.*limit|daily.*limit/.test(text)) return mk('easyapply_cooldown', 'wait', 'Easy Apply cooldown');
  // SITE BOT-GATE (Cloudflare / CAPTCHA / verify wall, or a host under the dispatch
  // breaker's cooldown). This is the SITE blocking automation — NOT a failure of our
  // flow, and distinct from a benign "sign in / captcha" gate the user can clear inline.
  // Must precede `site_gate` (its regex also matches "human"). Honest metrics (R3) read
  // this as the "site bot-gate" bucket, separate from our-flow failures and real submits.
  if (input.parkReason === 'bot_challenge' || input.park_reason === 'bot_challenge'
      || /bot.?challenge|bot-challenge cooldown|verification wall|needs human verification/.test(text)) {
    return mk('bot_challenge', 'inspect', 'Site bot-challenge (Cloudflare/CAPTCHA)');
  }
  if (/captcha|human|unusual activity|login required|sign into|sign-in required|sign in required|sign.?in required|site sign.?in|required before applying|connectez-vous/.test(text)) return mk('site_gate', 'user', 'Site gate needs you');
  if (/external|company site|employer site|not auto-applicable|apply on the company site|postuler sur le site/.test(text)) return mk('external_site', 'inspect', 'External site skipped');
  if (source === 'glassdoor' && /hydrate|no advance|did not open|application not open/.test(text)) return mk('external_site', 'inspect', 'Glassdoor posting was not auto-applicable');
  if (state === 'failed' && repeatedFingerprint) return mk('repeated_failure', 'inspect', 'Same screen failed repeatedly, needs inspection');
  if (/occlud|throttl|hydrate|not top frame|not loaded|component|timed out|interrupted|page stopped|stuck|no advance|did not change|did not attach|max steps|resume attachment|résumé did not attach|could not complete/.test(text)) {
    return mk('transient_page', 'retry', 'Transient page/load issue, retries');
  }
  if (/already applied|punished|excluded keyword|above your level|academic\/research|relevance skip|needs ~\d+ yrs/.test(text)) return mk('relevance_skip', 'skip', 'Skipped by rules');
  if (state === 'skipped') return mk('skipped_other', 'inspect', 'Skipped, inspectable');
  if (state === 'failed') return mk('unknown_failure', 'inspect', 'Failed, needs inspection');
  return mk('none', 'wait', 'No issue');
}

function rowToTask(r) {
  if (!r) return null;
  const failure = classifyQueueFailure(r);
  return {
    id: r.id, jobId: r.job_id, state: r.state, mode: r.mode,
    scheduledAt: r.scheduled_at, attempts: r.attempts, lastError: r.last_error,
    transcript: safeParse(r.transcript, []),
    parkReason: r.park_reason || null,
    applyRoute: r.apply_route || null,
    routeState: r.route_state || null,
    submissionEvidence: safeParse(r.submission_evidence, null),
    handoffToken: r.handoff_token || null,
    pendingQuestions: safeParse(r.pending_questions, []),
    failureClass: failure.failureClass,
    failureAction: failure.action,
    failureLabel: failure.label,
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

function queueActiveSiteKeys() {
  return all(
    `SELECT t.id AS task_id, t.state, j.title, j.company, j.source, j.job_url
       FROM auto_apply_tasks t JOIN jobs j ON j.id = t.job_id
      WHERE t.state IN ('scheduled','running')
      ORDER BY t.scheduled_at ASC`
  ).map((r) => ({
    taskId: r.task_id,
    state: r.state,
    siteKey: taskSiteKey(r),
    source: r.source || '',
    title: r.title || '',
    company: r.company || '',
    jobUrl: r.job_url || '',
  })).filter((r) => r.siteKey);
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
    done: 'submitted', awaiting_review: 'needs_you', failed: 'failed',
    parked: 'needs_you', awaiting_input: 'needs_you', skipped: 'skipped',
    queued: 'pending', scheduled: 'pending', running: 'running',
  };
  const items = all(sql, args).map((r) => {
    const t = rowToTask(r);
    const reason = t.lastError || t.parkReason || (t.pendingQuestions[0] && t.pendingQuestions[0].reason) || '';
    return {
      taskId: t.id, jobId: t.jobId, state: t.state, mode: t.mode,
      outcome: OUTCOME[t.state] || t.state, reason,
      failureClass: t.failureClass, failureAction: t.failureAction, failureLabel: t.failureLabel,
      updatedAt: t.updatedAt, createdAt: t.createdAt, pendingQuestions: t.pendingQuestions,
      job: { title: r._title, company: r._company, jobUrl: r._url, source: r._src, status: r._status, submittedAt: r._submittedAt },
    };
  });
  const rollup = { submitted: 0, failed: 0, needs_you: 0, skipped: 0, pending: 0, running: 0, total: items.length };
  for (const it of items) rollup[it.outcome] = (rollup[it.outcome] || 0) + 1;
  return { items, rollup };
}

// Aggregated breakdown for the Auto-apply chart: how many applications total,
// split by OUTCOME (submitted/failed/needs_you/skipped/pending), by BOARD
// (linkedin/indeed/…), by ROUTE (easy-apply vs external), plus the top skip/fail
// reasons — all over the last N days. updated_at is the time signal.
function queueBreakdown({ days = 30 } = {}) {
  const cutoff = new Date(Date.now() - Math.max(1, days) * 86400 * 1000).toISOString();
  const rows = all(
    `SELECT t.state, t.last_error, t.park_reason, t.apply_route, j.source AS src
     FROM auto_apply_tasks t JOIN jobs j ON j.id = t.job_id
     WHERE t.updated_at >= ?`, [cutoff]);
  const OUTCOME = {
    done: 'submitted', awaiting_review: 'needs_you', failed: 'failed',
    parked: 'needs_you', awaiting_input: 'needs_you', skipped: 'skipped',
    queued: 'pending', scheduled: 'pending', running: 'running',
  };
  const byOutcome = {}, byBoard = {}, byRoute = {}, byFailureClass = {}, byFailureAction = {}, reasons = {};
  const bump = (obj, k1, k2) => {
    if (!obj[k1]) obj[k1] = {};
    obj[k1][k2] = (obj[k1][k2] || 0) + 1;
  };
  for (const r of rows) {
    const oc = OUTCOME[r.state] || r.state;
    byOutcome[oc] = (byOutcome[oc] || 0) + 1;
    bump(byBoard, (r.src || 'other').toLowerCase(), oc);
    bump(byRoute, r.apply_route || 'unknown', oc);
    const failure = classifyQueueFailure(r);
    if (failure.failureClass && failure.failureClass !== 'none') byFailureClass[failure.failureClass] = (byFailureClass[failure.failureClass] || 0) + 1;
    if (failure.action) byFailureAction[failure.action] = (byFailureAction[failure.action] || 0) + 1;
    if (oc === 'failed' || oc === 'skipped' || oc === 'needs_you') {
      const reason = String(r.last_error || r.park_reason || '').slice(0, 80) || '(unspecified)';
      reasons[reason] = (reasons[reason] || 0) + 1;
    }
  }
  const topReasons = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([reason, count]) => ({ reason, count }));
  return { total: rows.length, days, byOutcome, byBoard, byRoute, byFailureClass, byFailureAction, topReasons };
}

// ============================================================
// R3 — HONEST run-scoped metrics.
// ============================================================
// A "done" now means a VERIFIED submit (R1 success-truth + terminal-integrity guard),
// bot-gates/site-gates are a DISTINCT category (R2), not our failures, and unverified
// submits sit in their own honest "maybe" bucket. summarizeRun is a PURE function over
// raw auto_apply_tasks rows (the same shape classifyQueueFailure already reads) so it is
// importable + testable under node with no DB. It buckets every row through the single
// source of truth (classifyQueueFailure → failureClass) and computes two clearly-labelled
// rates so the headline can never be inflated by false positives or by site gates.
//
// Buckets (mutually exclusive, every dispatched row lands in exactly one):
//   verified_done   — failureClass 'submitted' (R1-trustworthy submit ONLY)
//   awaiting_review — 'review_gate' (submitted-but-unverified; the honest "maybe")
//   bot_challenge   — 'bot_challenge' (R2: Cloudflare/CAPTCHA/verify-wall — SITE blocked us)
//   site_gate       — 'site_gate' (benign sign-in/captcha wall — site blocked us)
//   flow_failed     — our flow genuinely failed (no-advance, missing form, executor error,
//                     repeated failure, unknown failure)
//   needs_you       — 'missing_info' (a real unanswered question — neither a submit nor a
//                     flow failure; pending on the human)
//   skipped         — out-of-scope: filters/dupes/non-applicable (external site, relevance)
//   in_flight       — queued/scheduled/running (counted in dispatched but not yet resolved)
//
// RATES (both labelled; awaiting_review NEVER counts as verified):
//   rawRate       = verified_done / dispatched                        (brutally honest)
//   supportedRate = verified_done / (dispatched − bot_challenge − site_gate − skipped − in_flight)
//                   (rate over jobs we could actually drive to a submit decision)
const RUN_BUCKET = {
  submitted: 'verified_done',
  review_gate: 'awaiting_review',
  bot_challenge: 'bot_challenge',
  site_gate: 'site_gate',
  external_site: 'skipped',
  relevance_skip: 'skipped',
  missing_info: 'needs_you',
  in_flight: 'in_flight',
  easyapply_cooldown: 'in_flight',
};
function summarizeRun(rows = []) {
  const counts = {
    dispatched: 0, verified_done: 0, awaiting_review: 0,
    site_gate: 0, bot_challenge: 0, flow_failed: 0,
    needs_you: 0, skipped: 0, in_flight: 0,
  };
  for (const r of rows || []) {
    counts.dispatched++;
    const fc = classifyQueueFailure(r).failureClass;
    const bucket = RUN_BUCKET[fc] || 'flow_failed';   // transient/repeated/unknown/other → our failure
    counts[bucket]++;
  }
  const rate = (num, den) => (den > 0 ? num / den : 0);
  const drivable = counts.dispatched - counts.bot_challenge - counts.site_gate - counts.skipped - counts.in_flight;
  return {
    counts,
    rawRate: rate(counts.verified_done, counts.dispatched),
    supportedRate: rate(counts.verified_done, drivable),
    drivable: Math.max(0, drivable),
  };
}

// Run-scoped honest breakdown for the dashboard. The "current run" is the auto-apply
// session that began when the master switch was last turned ON (settings.autoApply.startedAt,
// stamped in server.js). Falls back to the last 24h when no run marker exists. Loads the raw
// rows touched since the run started and feeds them to the pure summarizeRun.
function queueRunSummary({ startedAt } = {}) {
  const since = startedAt || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = all(
    `SELECT t.state, t.last_error, t.park_reason, t.pending_questions, t.transcript, j.source AS source
       FROM auto_apply_tasks t JOIN jobs j ON j.id = t.job_id
      WHERE t.updated_at >= ?`, [since]);
  return { since, ...summarizeRun(rows) };
}

// Live snapshot for the Auto-apply "Running now" panel: the in-flight workers
// (state='running' tasks — their count IS the live parallel-worker number) with
// each one's current step + elapsed, the queue depth, and a session tally by
// outcome since the user pressed Start. Submitted = done ONLY (review-stops and
// parks are counted separately, honestly).
function queueLive({ startedAt } = {}) {
  const running = all(
    `SELECT t.*, j.title AS _title, j.company AS _company, j.source AS _src, j.job_url AS _url
     FROM auto_apply_tasks t JOIN jobs j ON j.id = t.job_id
     WHERE t.state = 'running' ORDER BY t.scheduled_at ASC`
  ).map((r) => {
    const tk = rowToTask(r);
    const tr = tk.transcript || [];
    const last = tr[tr.length - 1] || null;
    const seen = tr.filter((e) => e && e.kind === 'seen').slice(-2);
    return {
      taskId: tk.id, title: r._title || '', company: r._company || '', source: r._src || '',
      step: last ? String(last.text || last.note || last.step || '').slice(0, 120) : 'starting…',
      // Rich live detail — the app's Auto-apply page renders a per-worker card from this:
      // the last several transcript lines ARE what the runner is seeing / filling /
      // answering right now, plus its route, attempt count, any pending questions + URL.
      trail: tr.slice(-9).map((e) => ({
        ts: e.ts || null,
        kind: e.kind || 'log',
        level: e.level || 'info',
        text: String(e.text || e.note || e.step || '').slice(0, 170),
        fields: Array.isArray(e.fields) ? e.fields.slice(0, 8) : [],
        buttons: Array.isArray(e.buttons) ? e.buttons.slice(0, 8) : [],
        url: e.url || '',
      })),
      seen: seen.map((e) => ({
        ts: e.ts || null,
        text: String(e.text || '').slice(0, 260),
        fields: Array.isArray(e.fields) ? e.fields.slice(0, 10) : [],
        buttons: Array.isArray(e.buttons) ? e.buttons.slice(0, 10) : [],
        url: e.url || '',
      })),
      route: tk.applyRoute || null,
      attempts: tk.attempts || 0,
      siteKey: taskSiteKey(r),
      failureClass: tk.failureClass, failureAction: tk.failureAction, failureLabel: tk.failureLabel,
      pendingQuestions: (tk.pendingQuestions || []).slice(0, 6),
      jobUrl: r._url || '',
      startedAt: tk.scheduledAt || tk.updatedAt, mode: tk.mode,
    };
  });
  const cnt = (st) => get('SELECT COUNT(*) AS n FROM auto_apply_tasks WHERE state = ?', [st]).n;
  const scheduled = cnt('scheduled');
  const queuedDepth = cnt('queued');
  // Session window = since the master switch was last turned ON (fallback: 24h).
  const since = startedAt || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const by = {};
  for (const r of all('SELECT state, COUNT(*) AS n FROM auto_apply_tasks WHERE updated_at >= ? GROUP BY state', [since])) by[r.state] = r.n;
  const session = {
    submitted: by.done || 0,
    readyForReview: by.awaiting_review || 0,
    parked: by.parked || 0,
    needsYou: by.awaiting_input || 0,
    skipped: by.skipped || 0,
    failed: by.failed || 0,
  };
  session.finished = session.submitted + session.readyForReview + session.parked + session.needsYou + session.skipped + session.failed;
  return { running, active: running.length, scheduled, queuedDepth, session, activeSites: queueActiveSiteKeys() };
}

// Pool refresh when discovery is exhausted (found jobs but all already tried):
// re-queue stale FAILED tasks (transient errors like the old "not top frame" race,
// which the current engine no longer hits) whose job isn't already submitted, capped
// by attempts so a permanently-dead job can't churn forever. Excludes skipped
// (relevance won't change) and awaiting_input/parked (those genuinely need the user).
// Environmental failures — Chrome backgrounded/occluded/THROTTLED the apply tab, or LinkedIn's
// SPA simply hadn't hydrated yet. These are NOT the job's fault: the same posting usually applies
// fine once its window is uncovered. We retry them WITHOUT charging an attempt, so a few unlucky
// backgrounded passes can't exile an otherwise-applyable Easy-Apply job to the permanent dead
// pool (the live DB had 163 transient LinkedIn failures stuck at the attempt cap from exactly
// this). Genuine flow failures (stuck/max-steps/no-advance) still consume an attempt so a truly
// broken job retires at maxAttempts. The maxAgeHours ceiling retires anything (even environmental)
// that has been failing for a full day, so nothing retries forever.
const ENVIRONMENTAL_FAILURE_RX = /occlud|throttl|hydrat|page stopped advancing|backgrounded|never hydrated/i;
function retryStaleQueue({ olderThanMinutes = 30, maxAttempts = 3, limit = 25, maxAgeHours = 24 } = {}) {
  const cutoff = new Date(Date.now() - Math.max(1, olderThanMinutes) * 60000).toISOString();
  const ageFloor = new Date(Date.now() - Math.max(1, maxAgeHours) * 3600000).toISOString();
  const rows = all(
    `SELECT t.*, j.source AS _src, j.job_url AS _url FROM auto_apply_tasks t JOIN jobs j ON j.id = t.job_id
     WHERE t.state = 'failed' AND t.updated_at < ? AND t.updated_at >= ?
       AND COALESCE(t.attempts, 0) < ?
       AND j.status != 'submitted'
     ORDER BY t.updated_at ASC LIMIT ?`, [cutoff, ageFloor, maxAttempts, limit]);
  let n = 0;
  for (const r of rows) {
    const failure = classifyQueueFailure(r);
    if (failure.action !== 'retry') continue;
    const environmental = ENVIRONMENTAL_FAILURE_RX.test(String(r.last_error || ''));
    if (queuePatch(r.id, {
      state: 'queued', lastError: null, handoffToken: null,
      attemptsDelta: environmental ? 0 : 1,
      transcriptAppend: { note: `self-heal retry after ${failure.failureClass}${environmental ? ' (environmental — no attempt charged)' : ''}` },
    })) n++;
  }
  return n;
}

// Tasks stuck in 'running'/'scheduled' (an SW eviction abandoned the launch, or the
// executor hung on a frozen tab) never reconcile themselves — they hold the pool slot
// and STALL the whole pipeline (zero new applies). Flip ones with no activity for
// `olderThanMinutes` back to retriable 'failed' so the slot frees + the job retries.
function reconcileStaleRunning({ olderThanMinutes = 8 } = {}) {
  const cutoff = new Date(Date.now() - Math.max(1, olderThanMinutes) * 60000).toISOString();
  const rows = all("SELECT id FROM auto_apply_tasks WHERE state IN ('running','scheduled') AND updated_at < ?", [cutoff]);
  for (const r of rows) run("UPDATE auto_apply_tasks SET state='failed', last_error=COALESCE(NULLIF(last_error,''),'timed out / interrupted — will retry'), updated_at=? WHERE id=?", [now(), r.id]);
  return rows.length;
}

// One-shot cleanup: tasks misfiled as awaiting_input/parked that carry NO real
// pending question are transient automation failures (the Easy-Apply form never
// hydrated, the page stalled, max steps, etc.) — NOT genuine "needs you" intake.
// Flip them to 'failed' so they (a) stop blocking discovery from re-queueing the
// job, (b) become retriable via retryStaleQueue, and (c) stop inflating a phantom
// "needs you" count. Genuine intake (real pending questions) is left untouched.
function reclaimDeadParks() {
  const rows = all(
    `SELECT id FROM auto_apply_tasks
      WHERE state IN ('awaiting_input','parked')
        AND (pending_questions IS NULL OR TRIM(pending_questions) IN ('', '[]', 'null'))`);
  for (const r of rows) {
    run("UPDATE auto_apply_tasks SET state='failed', last_error=COALESCE(NULLIF(last_error,''), park_reason, 'auto-apply could not complete'), updated_at=? WHERE id=?", [now(), r.id]);
  }
  return rows.length;
}

// Repair PASSIVE-CAPTURE false submits: auto-apply-discovered jobs that the page
// detector stamped 'submitted' even though their auto-apply task never actually
// completed (a clicked-but-failed Easy-Apply / external flow — the "I never applied to
// that" bug). Conservative: only jobs tagged auto-apply, currently 'submitted', with at
// least one auto-apply task but NONE done/awaiting_review, and whose submit was NOT a
// manual user change. Reverts them to 'started' so the ledger is honest. Idempotent.
function reconcileFalseSubmits() {
  const rows = all(
    `SELECT j.id FROM jobs j
      WHERE j.status = 'submitted' AND j.tags LIKE '%auto-apply%'
        AND EXISTS (SELECT 1 FROM auto_apply_tasks t WHERE t.job_id = j.id)
        AND NOT EXISTS (SELECT 1 FROM auto_apply_tasks t WHERE t.job_id = j.id AND t.state IN ('done','awaiting_review'))
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.job_id = j.id AND e.type = 'status_changed' AND e.source IN ('manual','user'))`);
  for (const r of rows) {
    run("UPDATE jobs SET status='started', updated_at=? WHERE id=?", [now(), r.id]);
    recordEvent({ jobId: r.id, type: 'status_changed', source: 'system', summary: 'Reverted a false auto-apply submit (the application never actually completed)', data: {} });
  }
  return rows.length;
}

function queueAdd(jobId, { mode, force = false } = {}) {
  if (!getJob(jobId)) return null;
  // The MOST RECENT task for this job governs whether it may be (re)queued.
  const last = get('SELECT * FROM auto_apply_tasks WHERE job_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1', [jobId]);
  if (last) {
    // Discovery path: only ever queues a BRAND-NEW job. Any existing task (in-flight,
    // genuine intake, already applied, OR a transient failure) is left to the retry /
    // intake systems (retryStaleQueue, queueRetryParked). This is the fix for the
    // starvation bug: a transient failure misfiled as awaiting_input used to block
    // re-queue forever, so a saturated search space zeroed out the whole queue.
    if (!force) return null;
    // force = manual "queue this job": re-attempt unless it's genuinely in flight.
    const inFlight = ['queued', 'scheduled', 'running', 'awaiting_review'].includes(last.state);
    if (inFlight) return rowToTask(last);
    if (last.state !== 'done') {
      run("UPDATE auto_apply_tasks SET state='queued', last_error=NULL, park_reason=NULL, pending_questions=NULL, handoff_token=NULL, submission_evidence=NULL, updated_at=? WHERE id=?", [now(), last.id]);
      return rowToTask(get('SELECT * FROM auto_apply_tasks WHERE id=?', [last.id]));
    }
    // already applied (done) + force → fall through and create a fresh task.
  }
  const id = uid('task');
  const ts = now();
  run(`INSERT INTO auto_apply_tasks (id, job_id, state, mode, created_at, updated_at)
       VALUES (?, ?, 'queued', ?, ?, ?)`,
      [id, jobId, mode === 'auto' ? 'auto' : 'review', ts, ts]);
  return rowToTask(get('SELECT * FROM auto_apply_tasks WHERE id = ?', [id]));
}

function queuePatch(id, { state, scheduledAt, lastError, transcriptAppend, attemptsDelta, mode, parkReason, pendingQuestions, applyRoute, routeState, submissionEvidence, handoffToken }) {
  const cur = get('SELECT * FROM auto_apply_tasks WHERE id = ?', [id]);
  if (!cur) return null;
  if (state && !QUEUE_STATES.has(state)) return null;
  let nextState = state || cur.state;
  let nextError = lastError !== undefined ? lastError : cur.last_error;
  let nextParkReason = parkReason !== undefined ? parkReason : cur.park_reason;
  let nextPending = pendingQuestions !== undefined ? (pendingQuestions || []).slice(0, 40) : safeParse(cur.pending_questions, []);
  let nextEvidence = submissionEvidence !== undefined ? submissionEvidence : safeParse(cur.submission_evidence, null);

  // Terminal-state integrity is enforced at the storage boundary. Executors can be
  // interrupted or old extension versions can omit fields, but the ledger must never
  // contain an unexplained failure, a fake user-wait, or an unproven submission.
  if (nextState === 'failed' && !String(nextError || '').trim()) nextError = 'auto-apply failed without a diagnostic';
  if (nextState === 'skipped' && !String(nextError || '').trim()) nextError = 'auto-apply skipped without a diagnostic';
  if ((nextState === 'awaiting_input' || nextState === 'parked') && !nextPending.some((q) => q && String(q.question || q.reason || '').trim())) {
    nextState = 'failed';
    nextError = String(nextError || nextParkReason || 'user-wait state had no actionable question');
    nextParkReason = null;
    nextPending = [];
  }
  if (nextState === 'done' && !nextEvidence) {
    // The evidence object can be lost in transit: the executor's evidence-bearing task-progress
    // PATCH is fire-and-forget and gets dropped when the apply tab is torn down right after a
    // verified submit, leaving only background's STATE-ONLY reconcile — which would downgrade a
    // genuinely VERIFIED submission. Before downgrading, try to RECOVER the evidence from the
    // transcript (already persisted by earlier task-progress writes): the executor logs its R1
    // post-click verdict there and ONLY for trustworthy reasons. If found, the submit was proven
    // → keep it `done`. Otherwise (no trustworthy marker) downgrade for honest human re-verify.
    const recovered = recoverVerifiedEvidenceFromTranscript(cur.transcript);
    if (recovered) {
      nextEvidence = recovered;
    } else {
      nextState = 'awaiting_review';
      nextError = 'submit was reported without confirmation evidence — please verify';
    }
  }
  // FIX 2: a VERIFIED done must carry NO contradictory failure text. An earlier retry attempt
  // on this row commonly left a stale last_error ("submit was reported without confirmation —
  // please confirm") / park_reason / pending_questions, so a genuinely verified submission
  // LOOKED unconfirmed/false. When a done lands with TRUSTWORTHY evidence (the R1 `verified`
  // type or the genuine `confirmation`/`confirmed` modal-close — NOT the legacy static
  // `success-signal`), null out the stale failure fields. This NEVER weakens the guard above
  // (an evidence-LESS done is still downgraded to awaiting_review first); it only cleans a
  // contradictory error off a done that IS trustworthy. Defensive mirror of the executor's
  // own done report (which now sets lastError:null at the source).
  if (nextState === 'done' && isTrustworthyEvidence(nextEvidence)) {
    nextError = null; nextParkReason = null; nextPending = [];
  }
  const transcript = safeParse(cur.transcript, []);
  if (transcriptAppend) {
    const items = Array.isArray(transcriptAppend) ? transcriptAppend : [transcriptAppend];
    for (const it of items) transcript.push({ ts: now(), ...((typeof it === 'object') ? it : { note: String(it) }) });
  }
  run(`UPDATE auto_apply_tasks SET
       state = ?, mode = ?, scheduled_at = ?, attempts = attempts + ?, last_error = ?,
       transcript = ?, park_reason = ?, pending_questions = ?, apply_route = COALESCE(?, apply_route),
       route_state = COALESCE(?, route_state), submission_evidence = ?, handoff_token = ?,
       updated_at = ? WHERE id = ?`,
      [nextState,
       mode || cur.mode,
       scheduledAt !== undefined ? scheduledAt : cur.scheduled_at,
       attemptsDelta || 0,
       nextError,
       JSON.stringify(transcript.slice(-200)),
       nextParkReason,
       JSON.stringify(nextPending),
       (applyRoute !== undefined && applyRoute !== null) ? String(applyRoute) : null,
       (routeState !== undefined && routeState !== null) ? String(routeState) : null,
       nextEvidence ? JSON.stringify(nextEvidence) : null,
       handoffToken !== undefined ? handoffToken : cur.handoff_token,
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

// Tasks that need the USER to act — surfaced in the Applications page so they can be
// finished there: parked / awaiting_input (a missing answer) and awaiting_review
// (a review-mode stop). Each carries its job + the still-outstanding questions (filtered
// through the same profile-memory check as queueParkedQuestions, so we never re-ask what
// the profile already knows).
function queueNeedsYou() {
  const rows = all(
    `SELECT t.*, j.title AS _title, j.company AS _company, j.source AS _src, j.job_url AS _url, j.status AS _status
       FROM auto_apply_tasks t JOIN jobs j ON j.id = t.job_id
      WHERE t.state IN ('parked', 'awaiting_input', 'awaiting_review')
      ORDER BY t.updated_at DESC LIMIT 100`);
  return rows.map((r) => {
    const tk = rowToTask(r);
    const pid = resolveProfileId(r._src);
    const questions = (tk.pendingQuestions || []).filter((q) => q && q.question
      && !profileFieldLookup(pid, q.question) && !qaLookup(pid, q.question));
    return {
      taskId: tk.id, jobId: tk.jobId, state: tk.state, route: tk.applyRoute || null,
      reason: tk.lastError || tk.parkReason || '',
      title: r._title || '', company: r._company || '', source: r._src || '',
      jobUrl: r._url || '', jobStatus: r._status || '',
      questions, updatedAt: tk.updatedAt,
    };
  });
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
  // SOFT DAILY CAP (anti-ban): EVERY apply DISPATCH in the rolling 24h — submits
  // (done/awaiting_review) PLUS attempts that reached a terminal outcome (failed/skipped/
  // parked/awaiting_input). Whole-session shaping: a marathon of failed attempts is just as
  // much a throttle/ban signal as successes, so both count toward the cap.
  const dispatchedDay = get(
    `SELECT COUNT(*) AS n FROM auto_apply_tasks
     WHERE state IN ('done','awaiting_review','failed','skipped','parked','awaiting_input')
       AND updated_at >= ?`,
    [dayAgo]).n;
  const lastRun = get(
    `SELECT MAX(updated_at) AS t FROM auto_apply_tasks WHERE state IN ('done','awaiting_review','failed')`).t;
  // Last START (scheduled_at) — the gap between applications is paced from when
  // the previous one *began*, not finished, so a self-driving serial loop and a
  // parallel pool both space their launches correctly without stalling.
  const lastStart = get(
    `SELECT MAX(scheduled_at) AS t FROM auto_apply_tasks WHERE scheduled_at IS NOT NULL`).t;
  return { doneDay, doneHour, dispatchedDay, lastRun, lastStart };
}

// ============================================================
// LinkedIn Easy Apply daily cap (~50/24h) — detect, cool down, pivot.
// The executor reports `easyapply-limit` when LinkedIn shows its limit modal; the
// server then sets a cooldown so queueNext skips Easy-Apply jobs (but keeps dispatching
// external/company-site ones) until it expires. We also LEARN the per-account threshold
// by recording how many Easy-Apply submissions landed in the rolling 24h when we hit it,
// keeping the MAX ever observed as the best estimate of the real cap.
// ============================================================

// Rolling-24h count of Easy-Apply submissions that reached a terminal "submitted" state.
// Easy-Apply = apply_route 'easy-apply' OR (route unknown AND the job is a LinkedIn source).
function easyApplySubmitted24h() {
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const r = get(
    `SELECT COUNT(*) AS n FROM auto_apply_tasks t LEFT JOIN jobs j ON j.id = t.job_id
     WHERE t.state IN ('done','awaiting_review') AND t.updated_at >= ?
       AND (t.apply_route = 'easy-apply'
            OR (t.apply_route IS NULL AND LOWER(COALESCE(j.source,'')) = 'linkedin'))`,
    [dayAgo]);
  return r ? r.n : 0;
}

function setEasyApplyCooldown({ hours = 24 } = {}) {
  const until = new Date(Date.now() + Math.max(0, hours) * 3600 * 1000).toISOString();
  kvSet('easyApplyLimitUntil', until);
  // Learn the threshold: record the count we'd reached when the cap hit, keeping the MAX
  // ever observed (it may not be exactly 50, and it's per-account).
  const submitted = easyApplySubmitted24h();
  const prev = Number(kvGet('easyApplyObservedLimit')) || 0;
  const observed = Math.max(prev, submitted);
  if (observed > 0) kvSet('easyApplyObservedLimit', observed);
  return { until, observedLimit: observed, submitted24h: submitted };
}

function easyApplyCooledDown() {
  const until = kvGet('easyApplyLimitUntil');
  if (!until) return false;
  return Date.now() < new Date(until).getTime();
}

function easyApplyStatus() {
  const until = kvGet('easyApplyLimitUntil') || null;
  return {
    cooledDown: easyApplyCooledDown(),
    until,
    observedLimit: Number(kvGet('easyApplyObservedLimit')) || null,
    submitted24h: easyApplySubmitted24h(),
  };
}

// Is this candidate job dispatchable RIGHT NOW given the Easy-Apply cooldown? During a
// cooldown LinkedIn Easy-Apply jobs are NOT eligible (we'd just waste the cap), but
// external/company-site jobs (workday/greenhouse/lever/glassdoor/indeed/direct/…) still
// flow. When not cooled down, everything is eligible (purely additive).
function easyApplyEligible(job) {
  if (!easyApplyCooledDown()) return true;
  if (!job) return true;
  if (String(job.source || '').toLowerCase() === 'linkedin') return false;
  try {
    if (classifyAts(job.jobUrl).ats === 'linkedin') return false;
  } catch {}
  return true;
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
    // The v6 per-profile learned memory — the most expensive-to-rebuild data in the
    // app. Was missing from export entirely, so "export everything" silently dropped it.
    profileFields: all('SELECT * FROM profile_fields').map((r) => ({
      profileId: r.profile_id, question: r.label || r.key_norm, value: r.value, confidence: r.confidence,
    })),
    profiles: listProfiles(),
    documents: listDocuments(),
    queue: queueList(),
    discoveryBatches: discoveryBatchList({ limit: 500 }),
  };
}

function importAll(payload) {
  if (!payload || typeof payload !== 'object'
    || (!Array.isArray(payload.jobs) && !Array.isArray(payload.qa) && !Array.isArray(payload.profileFields))) {
    throw new Error('not a JAT export file');
  }
  // Import MUTATES existing rows (upsertJob elevates status / merges answers), so
  // snapshot first — importing the wrong file is then recoverable.
  const backup = db ? backupNow('pre-import-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')) : null;
  let jobs = 0, events = 0, qa = 0, profileFields = 0;
  const importPid = ensureDefaultProfileId();   // imported answers land in the default profile unless their profile still exists
  const existing = new Set(listProfiles().map((p) => p.id));
  const pidFor = (id) => (id && existing.has(id)) ? id : importPid;   // FK-safe: never reference a profile that isn't there
  transaction(() => {
    for (const j of payload.jobs || []) { upsertJob(j); jobs++; }
    for (const e of payload.events || []) {
      if (e.jobId && getJob(e.jobId)) { recordEvent(e); events++; }
    }
    for (const q of payload.qa || []) {
      if (q.question && q.answer) { qaRecord({ profileId: pidFor(q.profileId), question: q.question, answer: q.answer }); qa++; }
    }
    for (const f of payload.profileFields || []) {
      if (f && f.question && f.value != null && !isSensitiveKey(f.question)) {
        try { profileFieldUpsert({ profileId: pidFor(f.profileId), question: f.question, value: f.value, confidence: f.confidence || 0.6 }); profileFields++; } catch {}
      }
    }
  });
  return { jobs, events, qa, profileFields, backup };
}

// Irreversible "delete all my data": clears every user-data table and disconnects linked
// accounts (Gmail/IMAP) + clears API keys. Keeps the pairing token + non-secret app prefs
// so the app stays usable + paired. Returns per-table deleted counts.
function wipeAllData() {
  if (!db) return { ok: false, deleted: {} };
  // Last-ditch recovery snapshot before the one irreversible op — the typed-DELETE
  // confirm prevents misclicks, this makes even a regretted/wrong-account wipe undoable.
  const backup = backupNow('pre-wipe-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'));
  const tables = ['discovery_fallbacks', 'job_discovery_provenance', 'discovery_batches', 'emails', 'auto_apply_tasks', 'events', 'ai_log', 'qa', 'profile_fields', 'profiles', 'documents', 'document_folders', 'jobs'];
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
  return { ok: true, deleted, backup };
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
// Re-run classification + matching over ALREADY-STORED emails — used once after a classifier or
// matcher upgrade so the existing inbox is corrected, not just future syncs. NEVER touches
// user-pinned rows (match_source manual/dismissed). matchFn(email) → { category, matchedJobId,
// matchConfidence, matchSource }. Returns { processed, changed }.
function reprocessEmails(matchFn) {
  let processed = 0, changed = 0;
  for (const row of all("SELECT * FROM emails WHERE match_source IS NULL OR match_source IN ('auto','suggested')")) {
    processed++;
    let a; try { a = matchFn(rowToEmail(row)); } catch { continue; }
    if (!a) continue;
    const cat = a.category || row.category, mj = a.matchedJobId || null, ms = a.matchSource || null, mc = a.matchConfidence || 0;
    if (cat === row.category && mj === row.matched_job_id && ms === row.match_source) continue;
    run('UPDATE emails SET category=?, matched_job_id=?, match_confidence=?, match_source=? WHERE id=?', [cat, mj, mc, ms, row.id]);
    changed++;
    // Reflect the match in the pipeline: elevate the job's stage from the email category
    // (forward-only). Without this, reprocess/sync links emails but the board never moves.
    if (mj && (ms === 'auto' || ms === 'manual')) { try { elevateJobFromEmailRow({ matched_job_id: mj, category: cat, match_source: ms }); } catch {} }
  }
  return { processed, changed };
}

// ============================================================
// Reward Engine — credit assignment + confirm-and-train  [P6]
// ============================================================
// The north-star loop: an interview/offer reply matched to an application is the only signal
// that turns "we applied" into "this WORKED". recordOutcome writes the ledger row and fans
// FRACTIONAL, CONFIDENCE-WEIGHTED, CLIPPED credit to the answers + recipe that produced the
// application. The guardrail (design "poisoned-reward"): effectiveReward = reward * confidence
// clamped to [-1, 1], so one lenient mislabel can never dominate. 'suggested' (unconfirmed)
// rewards are HELD — they are only credited once the user confirms the link.

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, Number(x) || 0)); }

// Read the reward ledger for a job (newest first). Used by tests now; by P7 rankJob next, to
// blend an application's reward history into discovery/queue ranking.
function outcomesForJob(jobId) {
  return all('SELECT * FROM application_outcomes WHERE job_id = ? ORDER BY ts DESC', [jobId])
    .map((r) => ({
      id: r.id, jobId: r.job_id, profileId: r.profile_id, recipeId: r.recipe_id || null,
      ats: r.ats || null, companyKey: r.company_key || null, reward: r.reward,
      rewardKind: r.reward_kind, emailId: r.email_id || null,
      credited: safeParse(r.credited, { qa_ids: [], recipe_ids: [] }), ts: r.ts,
    }));
}

// Locate the (ats, companyKey) for a job from its URL (so credit can find the recipe used).
function jobAtsCompany(job) {
  const c = classifyAts(job && job.jobUrl);
  return { ats: c.ats, companyKey: c.companyKey || normCompanyKey(job && job.company) };
}

// Bump a qa answer's reward_score by `delta` (in place). Returns true if a row was updated.
function bumpQaReward(qaId, delta) {
  if (!qaId || !delta) return false;
  return (run('UPDATE qa SET reward_score = COALESCE(reward_score, 0) + ?, updated_at = ? WHERE id = ?',
    [delta, now(), qaId])?.changes ?? 0) > 0;
}
// Bump a recipe's reward_score by `delta` (in place). Returns true if a row was updated.
function bumpRecipeReward(recipeId, delta) {
  if (!recipeId || !delta) return false;
  return (run('UPDATE ats_recipes SET reward_score = COALESCE(reward_score, 0) + ?, updated_at = ? WHERE id = ?',
    [delta, now(), recipeId])?.changes ?? 0) > 0;
}

// recordOutcome — write one application_outcomes ledger row and, for POSITIVE rewards, fan
// the clipped/confidence-weighted credit to the answers + recipe that produced it. For a
// MILD-NEGATIVE (rejection) we write the ledger row but DO NOT dock the recipe/answer
// mechanical credit (the application *worked* — rejection only feeds fit/relevance ranking in
// P7). Returns the inserted row id + the credited {qa_ids, recipe_ids}.
function recordOutcome({ jobId, profileId, recipeId, ats, companyKey, reward, rewardKind, emailId, credited } = {}) {
  if (!jobId) return null;
  const job = getJob(jobId);
  if (!job) return null;
  const pid = profileId || resolveProfileId(job.source);
  const ac = jobAtsCompany(job);
  const finalAts = ats || ac.ats || null;
  const finalCompanyKey = companyKey || ac.companyKey || null;
  const effective = clamp(reward, -1, 1);     // already-weighted reward, clipped to [-1,1]

  const creditOut = (credited && typeof credited === 'object')
    ? { qa_ids: [...(credited.qa_ids || [])], recipe_ids: [...(credited.recipe_ids || [])] }
    : { qa_ids: [], recipe_ids: [] };

  // POSITIVE → fan credit. (Negative/zero outcomes are ledger-only: rejection is fit-rank
  // only, so the recipe/answers keep their mechanical-success credit.)
  if (effective > 0) {
    // (a) the qa answers used in this application — located by the job's answer labels.
    for (const label of Object.keys(job.answers || {})) {
      if (!label || isSensitiveKey(label)) continue;
      const hit = qaLookup(pid, label);
      if (hit && hit.id && !creditOut.qa_ids.includes(hit.id)) {
        if (bumpQaReward(hit.id, effective)) creditOut.qa_ids.push(hit.id);
      }
    }
    // (b) the recipe used — the task's recorded recipe_id for this job if present, else the
    // (ats, company) the apply resolves to.
    let credRecipeId = recipeId || null;
    if (!credRecipeId) {
      const task = get("SELECT recipe_id FROM auto_apply_tasks WHERE job_id = ? AND recipe_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1", [jobId]);
      credRecipeId = (task && task.recipe_id) || null;
    }
    if (!credRecipeId && finalAts) {
      const resolved = resolveRecipe(finalAts, finalCompanyKey, pid);
      credRecipeId = resolved.atsRecipeId || resolved.companyRecipeId || null;
    }
    if (credRecipeId && bumpRecipeReward(credRecipeId, effective) && !creditOut.recipe_ids.includes(credRecipeId)) {
      creditOut.recipe_ids.push(credRecipeId);
    }
    if (credRecipeId && !recipeId) recipeId = credRecipeId;   // stamp the ledger row with it
  }

  const id = uid('outcome');
  run(`INSERT INTO application_outcomes (id, job_id, profile_id, recipe_id, ats, company_key, reward, reward_kind, email_id, credited, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, jobId, pid, recipeId || null, finalAts, finalCompanyKey, effective, rewardKind || 'submitted',
     emailId || null, JSON.stringify(creditOut), now()]);
  return { id, jobId, profileId: pid, recipeId: recipeId || null, ats: finalAts, companyKey: finalCompanyKey,
    reward: effective, rewardKind: rewardKind || 'submitted', emailId: emailId || null, credited: creditOut };
}

// creditOutcomeForEmail(emailId) — the email→reward entry point. An email earns/credits an
// outcome only when it is LINKED ('auto' or 'manual') and classifies to a NON-ZERO reward.
// 'suggested' rows are held (their reward is released by confirmEmailLink). Credit is
// confidence-weighted: effectiveReward = baseReward * matchConfidence, clipped to [-1,1].
function creditOutcomeForEmail(emailId) {
  const row = get('SELECT * FROM emails WHERE id = ?', [emailId]);
  if (!row) return { ok: false, reason: 'no-email' };
  if (!row.matched_job_id) return { ok: false, reason: 'unlinked' };
  if (row.match_source !== 'auto' && row.match_source !== 'manual') return { ok: false, reason: 'held' };
  // Don't double-credit the same email.
  if (get('SELECT id FROM application_outcomes WHERE email_id = ? LIMIT 1', [emailId])) return { ok: false, reason: 'already-credited' };

  const { classifyEmailReward } = require('./email');
  const { kind, reward } = classifyEmailReward(row.category || classifyFromEmailRow(row));
  if (!reward) return { ok: false, reason: 'neutral' };

  const conf = clamp(row.match_confidence, 0, 1) || 0;
  const effective = clamp(reward * conf, -1, 1);   // CONFIDENCE-WEIGHTED + CLIPPED
  if (!effective) return { ok: false, reason: 'zero-after-weight' };

  const job = getJob(row.matched_job_id);
  const pid = job ? resolveProfileId(job.source) : ensureDefaultProfileId();
  const out = recordOutcome({
    jobId: row.matched_job_id, profileId: pid, reward: effective,
    rewardKind: kind === 'rejection' ? 'rejection' : 'email_reply', emailId,
  });
  return { ok: !!out, reward: effective, rewardKind: kind, outcome: out };
}
// Re-derive a category from a stored email row if `category` was never persisted.
function classifyFromEmailRow(row) {
  try { return require('./email').classify(row.subject || '', row.body || ''); } catch { return 'other'; }
}

// emailsNeedingConfirm(profileId) — the confirm-this-link inbox: 'suggested' emails that have
// a candidate job, newest first. (profileId is accepted for symmetry/future per-profile
// scoping; emails are not yet profile-scoped, so it filters only when jobs carry a profile.)
function emailsNeedingConfirm(profileId, limit = 100) {
  const rows = all(
    `SELECT * FROM emails WHERE match_source = 'suggested' AND matched_job_id IS NOT NULL
       ORDER BY sent_at DESC LIMIT ?`, [Math.min(500, limit)]);
  return rows.map((r) => {
    const e = rowToEmail(r);
    const job = e.matchedJobId ? getJob(e.matchedJobId) : null;
    return { ...e, candidate: job ? { id: job.id, title: job.title, company: job.company, status: job.status } : null };
  }).filter((e) => !profileId || e.candidate);
}

// A compact, labeled training example the matcher can later use to tune thresholds. Stored as
// a capped kv list (no new table needed): email-features + the human decision. Keep it simple.
function recordMatchTrainingExample({ email, jobId, decision }) {
  const key = 'matchTraining';
  const list = kvGet(key) || [];
  list.push({
    decision,                                  // 'confirm' | 'dismiss'
    fromDomain: (String(email.from || '').split('@')[1] || '').toLowerCase(),
    subjectKey: normKey(email.subject || '').slice(0, 120),
    category: email.category || null,
    matchConfidence: email.matchConfidence ?? null,
    jobId: jobId || email.matchedJobId || null,
    ts: now(),
  });
  // Rolling cap so the kv blob can't grow unbounded.
  kvSet(key, list.slice(-500));
  return list.length;
}

// confirmEmailLink(emailId, { jobId, confirm }) — the confirm-and-train action. On confirm:
//   • set match_source='manual', link to jobId (or keep the suggested candidate),
//   • apply the forward-only STATUS_ORDER elevation to the job (the email's classified status),
//   • persist a POSITIVE training example,
//   • RELEASE the held reward via creditOutcomeForEmail.
// On dismiss: set match_source='dismissed' + a NEGATIVE training example (no reward).
function confirmEmailLink(emailId, { jobId, confirm } = {}) {
  const row = get('SELECT * FROM emails WHERE id = ?', [emailId]);
  if (!row) return { ok: false, error: 'no such email' };
  const e = rowToEmail(row);

  if (!confirm) {
    run("UPDATE emails SET match_source = 'dismissed' WHERE id = ?", [emailId]);
    recordMatchTrainingExample({ email: e, jobId: null, decision: 'dismiss' });
    return { ok: true, email: rowToEmail(get('SELECT * FROM emails WHERE id = ?', [emailId])), credited: null };
  }

  const linkJobId = jobId || row.matched_job_id;
  if (!linkJobId) return { ok: false, error: 'no candidate job to confirm' };
  // Promote to a manual (user-confirmed) link at full confidence.
  run("UPDATE emails SET matched_job_id = ?, match_source = 'manual', match_confidence = CASE WHEN match_confidence < 0.85 THEN 0.85 ELSE match_confidence END WHERE id = ?",
    [linkJobId, emailId]);

  // Forward-only status elevation from the email's classified status (reuse the existing
  // ladder via patchJob, which enforces elevation + never demotes a terminal job).
  const job = getJob(linkJobId);
  if (job) {
    const emailStatus = gmailStatusFromCategory(e.category) || null;
    if (emailStatus) {
      const cur = STATUS_ORDER[job.status] || 0;
      const inc = STATUS_ORDER[emailStatus] || 0;
      if (!TERMINAL.has(job.status) && (inc > cur || (emailStatus === 'rejected'))) {
        const r = patchJob(linkJobId, { status: emailStatus });
        if (r?.statusChanged) {
          recordEvent({
            jobId: linkJobId, type: 'status_changed', source: 'email-confirm',
            summary: `${r.previousStatus} → ${emailStatus} (confirmed email: "${(e.subject || '').slice(0, 80)}")`,
            data: { from: r.previousStatus, to: emailStatus, emailId },
          });
        }
      }
    }
  }

  recordMatchTrainingExample({ email: { ...e, matchedJobId: linkJobId }, jobId: linkJobId, decision: 'confirm' });
  // RELEASE the held reward now that the link is confirmed.
  const credited = creditOutcomeForEmail(emailId);
  return { ok: true, email: rowToEmail(get('SELECT * FROM emails WHERE id = ?', [emailId])), credited };
}

// Map an email-integration category (email.js classify) → a job status for forward elevation.
// Mirrors gmail.js's status ladder so the IMAP/Gmail confirm path elevates consistently.
function gmailStatusFromCategory(category) {
  switch (category) {
    case 'offer':                    return 'offer';
    case 'interview':                return 'interview_1';
    case 'assessment':               return 'assessment';
    case 'rejection':                return 'rejected';
    case 'recruiter':                return 'contacted';
    case 'application_confirmation': return 'submitted';
    default:                         return null;
  }
}

// Elevate a job's pipeline STAGE from a matched email's category (confirmation→submitted,
// assessment→assessment, interview→interview_1, offer→offer, rejection→rejected,
// recruiter→contacted). Forward-only — never demotes, never touches a terminal job. This is what
// makes the pipeline reflect the inbox automatically on every auto/manual match (sync + reprocess),
// instead of only on a manual one-click confirm. Returns the new status or null (no change).
function elevateJobFromEmailRow(row) {
  if (!row || !row.matched_job_id) return null;
  if (row.match_source !== 'auto' && row.match_source !== 'manual') return null;
  const st = gmailStatusFromCategory(row.category);
  if (!st) return null;
  const job = getJob(row.matched_job_id);
  if (!job || TERMINAL.has(job.status)) return null;
  if ((STATUS_ORDER[st] || 0) <= (STATUS_ORDER[job.status] || 0)) return null;   // forward-only
  patchJob(row.matched_job_id, { status: st });
  return st;
}
function elevateJobFromEmail(emailId) {
  return elevateJobFromEmailRow(get('SELECT matched_job_id, category, match_source FROM emails WHERE id = ?', [emailId]));
}

// THREAD-BASED MATCHING ("trace the reply back to the original submission"): an inbound email
// that is part of a conversation we already linked — same Gmail thread_id, OR whose
// In-Reply-To / References headers name the Message-ID of an email we already matched — inherits
// that email's job, even when the sender/subject no longer name the company or role (a recruiter
// replying from a personal address, a bare "Re: your application"). We inherit ONLY from
// confidently-matched emails (auto/manual), never from an unconfirmed 'suggested' guess, so a bad
// guess can't propagate down a thread. Returns { jobId, via } or null.
function findJobByThread({ threadId, inReplyTo, references, excludeEmailId } = {}) {
  const msgIds = [];
  const push = (v) => { if (v == null) return; for (const m of String(v).split(/\s+/)) { const t = m.trim().replace(/^<|>$/g, ''); if (t) msgIds.push(t); } };
  push(inReplyTo); push(references);
  // 1) Reply-chain: an email whose Message-ID we stored AND already matched (strongest — RFC 5322).
  if (msgIds.length) {
    const ph = msgIds.map(() => '?').join(',');
    const row = get(
      `SELECT matched_job_id FROM emails
         WHERE matched_job_id IS NOT NULL AND match_source IN ('auto','manual')
           AND REPLACE(REPLACE(message_id,'<',''),'>','') IN (${ph})
           ${excludeEmailId ? 'AND id != ?' : ''}
         ORDER BY sent_at DESC LIMIT 1`,
      excludeEmailId ? [...msgIds, excludeEmailId] : msgIds);
    if (row?.matched_job_id) return { jobId: row.matched_job_id, via: 'reply-chain' };
  }
  // 2) Same provider thread (Gmail thread_id) already matched.
  if (threadId) {
    const row = get(
      `SELECT matched_job_id FROM emails
         WHERE thread_id = ? AND matched_job_id IS NOT NULL AND match_source IN ('auto','manual')
           ${excludeEmailId ? 'AND id != ?' : ''}
         ORDER BY sent_at DESC LIMIT 1`,
      excludeEmailId ? [threadId, excludeEmailId] : [threadId]);
    if (row?.matched_job_id) return { jobId: row.matched_job_id, via: 'thread' };
  }
  return null;
}

// ============================================================
// Strict Relevance + Punishment Gate + unified rankJob  [P7]
// ============================================================
// The user's explicit negative signal (punish a single job, a job-type title pattern, or an
// ENTIRE company) plus the geo/work-authorization down-rank, blended with deterministic fit +
// reward history into ONE rankJob(job, profileId) score that discovery + queueNext consume.
// Every id is TEXT (uid). Punishments DECAY by default (decay_at = now + decayDays*86400s);
// a 0/null decayDays stores NULL = permanent. A matching ACTIVE punishment hard-excludes a
// job (isPunished) and zeroes-out its rank; an EXPIRED one no longer counts (eligibility
// restored). The geo gate is a BOUNDED ranking lever, never a punishment, gated by a TRUTHFUL
// authorization read — it never fabricates work authorization.

const PUNISH_DEFAULT_DECAY_DAYS = 90;   // the agreed decaying default (design Open-Q #8)

// punish — insert one punishments row. decayDays:
//   • undefined            → default 90-day decay
//   • 0 | null             → PERMANENT (decay_at = NULL)
//   • a positive number    → decay_at = now + decayDays*86400s
function punish({ profileId, kind, pattern, weight, decayDays } = {}) {
  const pid = profileId || ensureDefaultProfileId();
  const k = String(kind || '').toLowerCase();
  if (!['job', 'job_type', 'company'].includes(k)) return null;
  const pat = String(pattern == null ? '' : pattern).trim();
  if (!pat) return null;
  // company punishments are keyed by company_key so they join the recipe/job attribution.
  const storedPattern = k === 'company' ? (normCompanyKey(pat) || pat.toLowerCase()) : pat;
  let decayAt = null;   // permanent
  const days = decayDays === undefined ? PUNISH_DEFAULT_DECAY_DAYS : Number(decayDays);
  if (days && Number.isFinite(days) && days > 0) decayAt = new Date(Date.now() + days * 86400 * 1000).toISOString();
  const id = uid('punish');
  run(`INSERT INTO punishments (id, profile_id, kind, pattern, weight, decay_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, pid, k, storedPattern, weight != null ? Number(weight) : 1.0, decayAt, now()]);
  return { id, profileId: pid, kind: k, pattern: storedPattern, weight: weight != null ? Number(weight) : 1.0, decayAt, createdAt: now() };
}

function unpunish(id) { return (run('DELETE FROM punishments WHERE id = ?', [id])?.changes ?? 0) > 0; }

// listPunishments(profileId) — ACTIVE punishments (decay_at NULL = permanent, or still in the
// future), newest first. Expired rows are filtered out (they no longer apply).
function listPunishments(profileId) {
  const pid = profileId || ensureDefaultProfileId();
  const nowIso = now();
  return all('SELECT * FROM punishments WHERE profile_id = ? AND (decay_at IS NULL OR decay_at > ?) ORDER BY created_at DESC', [pid, nowIso])
    .map((r) => ({ id: r.id, profileId: r.profile_id, kind: r.kind, pattern: r.pattern, weight: r.weight, decayAt: r.decay_at || null, createdAt: r.created_at }));
}

// punishmentPenalty(job, profileId) → number in [0,1]. 1.0 when an ACTIVE punishment matches
// this job (company_key match, OR a job_type pattern matched against the title — tried first as
// a regex, falling back to a case-insensitive substring, OR a job-id match), else 0. Expired
// punishments (decay_at passed) are excluded by the query, so they never count.
function punishmentPenalty(job, profileId) {
  if (!job) return 0;
  const pid = profileId || resolveProfileId(job.source);
  const active = all('SELECT * FROM punishments WHERE profile_id = ? AND (decay_at IS NULL OR decay_at > ?)', [pid, now()]);
  if (!active.length) return 0;
  const companyKey = normCompanyKey(job.company) || jobAtsCompany(job).companyKey || null;
  const title = String(job.title || '');
  for (const p of active) {
    if (p.kind === 'company') {
      if (companyKey && String(p.pattern || '').toLowerCase() === String(companyKey).toLowerCase()) return 1;
    } else if (p.kind === 'job') {
      if (job.id && String(p.pattern) === String(job.id)) return 1;
    } else if (p.kind === 'job_type') {
      const pat = String(p.pattern || '');
      if (!pat) continue;
      let matched = false;
      try { matched = new RegExp(pat, 'i').test(title); }
      catch { matched = title.toLowerCase().includes(pat.toLowerCase()); }
      if (!matched && title.toLowerCase().includes(pat.toLowerCase())) matched = true;   // substring fallback even when the regex is valid but didn't fire
      if (matched) return 1;
    }
  }
  return 0;
}

// isPunished(job, profileId) — boolean hard-exclusion gate for discovery + queueNext.
function isPunished(job, profileId) { return punishmentPenalty(job, profileId) > 0; }

// punishCompanyCascade(profileId, companyKey) — apply a fresh company punishment to the LIVE
// queue: every QUEUED/scheduled auto_apply_task for that company's jobs is set to 'skipped'
// with last_error 'punished company', so the block takes effect immediately (not just on the
// next discovery pass). Returns the count of tasks skipped.
function punishCompanyCascade(profileId, companyKey) {
  const ck = normCompanyKey(companyKey);
  if (!ck) return 0;
  const ts = now();
  // Match jobs by normalized company name OR by the company encoded in the job URL.
  const rows = all(
    `SELECT t.id, j.company AS company, j.job_url AS jobUrl
       FROM auto_apply_tasks t JOIN jobs j ON j.id = t.job_id
      WHERE t.state IN ('queued','scheduled')`);
  let n = 0;
  for (const r of rows) {
    const jobCk = normCompanyKey(r.company) || classifyAts(r.jobUrl).companyKey || null;
    if (jobCk && String(jobCk).toLowerCase() === ck.toLowerCase()) {
      run("UPDATE auto_apply_tasks SET state = 'skipped', last_error = 'punished company', updated_at = ? WHERE id = ?", [ts, r.id]);
      n++;
    }
  }
  return n;
}

// ---- geo / work-authorization gate (truthful, bounded ranking lever) ----
// Read the user's work authorization ONLY from truthful sources: the structured
// profile.data.workAuthRegions (array | comma/semicolon string) or profile.data.workAuthorization
// /citizenship free text, OR a LOCKED profile_fields row whose label matches the work-auth regex.
// Never fabricated; absent → unknown → no penalty (don't over-filter).
const WORK_AUTH_LABEL_RX = /work.?authoriz|authorized to work|authori[sz]ed.?work|citizen|visa|eligible to work|right to work|work.?permit/i;

function workAuthText(profileId, profile) {
  const parts = [];
  const d = (profile && profile.data) || profile || null;
  if (d && typeof d === 'object') {
    if (Array.isArray(d.workAuthRegions)) parts.push(d.workAuthRegions.join(', '));
    else if (typeof d.workAuthRegions === 'string') parts.push(d.workAuthRegions);
    if (d.workAuthorization) parts.push(String(d.workAuthorization));
    if (d.citizenship) parts.push(String(d.citizenship));
  }
  // A locked profile_fields row the user set themselves (truthful, user-edited).
  if (profileId) {
    try {
      for (const f of all('SELECT label, value FROM profile_fields WHERE profile_id = ? AND locked = 1', [profileId])) {
        if (f.value && WORK_AUTH_LABEL_RX.test(String(f.label || ''))) parts.push(String(f.value));
      }
    } catch {}
  }
  return parts.filter(Boolean).join(' | ').trim();
}

// Does this job look remote? (work_mode field or title/location/description text.)
const REMOTE_RX = /\b(remote|work from home|wfh|télétravail|teletravail|distanciel)\b/i;
const ONSITE_RX = /\b(on-?site|in-?office|in-?person|on-?premise)\b/i;
function jobIsRemote(job) {
  const hay = `${job?.workMode || ''} ${job?.title || ''} ${job?.location || ''}`;
  if (REMOTE_RX.test(hay)) return true;
  if (REMOTE_RX.test(String(job?.description || '').slice(0, 600))) return true;
  return false;
}

// geoPenalty(job, profileId) → number in [0, GEO_PENALTY_MAX].
//   • remote job (+ user has SOME authorization on file)  → 0  (remote expands scope)
//   • on-site job in a region the user is NOT authorized for → GEO_PENALTY_MAX (down-rank)
//   • unknown authorization OR unknown region              → 0  (never over-filter / fabricate)
// This is a RANKING lever only: it never excludes a job and never asserts authorization the
// user hasn't stated. Authorization is matched truthfully — a region token from the job's
// location must appear in the user's stated authorization for an on-site job to be in-scope.
const GEO_PENALTY_MAX = 0.5;
function geoPenalty(job, profileId, profile) {
  if (!job) return 0;
  const pid = profileId || resolveProfileId(job.source);
  // Resolve the profile (for its structured data.workAuthRegions/workAuthorization) when the
  // caller didn't pass one — match by id first, else the source-matched profile.
  let prof = profile;
  if (!prof) {
    try { prof = listProfiles().find((p) => p.id === pid) || profileForSource(job.source) || null; } catch { prof = null; }
  }
  const auth = workAuthText(pid, prof);
  if (!auth) return 0;                       // TRUTH GATE: no authorization on file → never penalize (no guessing)
  if (jobIsRemote(job)) return 0;            // remote + authorized somewhere → in-scope
  const loc = String(job.location || '').trim();
  if (!loc) return 0;                        // unknown region → don't over-filter
  // On-site with a known region: in-scope only if a meaningful location token appears in the
  // user's stated authorization. Otherwise it's an unauthorized-region on-site role → down-rank.
  const authLc = auth.toLowerCase();
  const tokens = loc.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const inScope = tokens.some((t) => authLc.includes(t));
  return inScope ? 0 : GEO_PENALTY_MAX;
}

// rewardBonus(job, profileId) → number in [0, REWARD_BONUS_MAX]. A bounded bonus from this
// (ats, company)'s track record: the average application_outcomes.reward for the company plus
// the resolved recipe's reward_score, squashed so interviews/offers float a company up without
// letting one outcome dominate.
const REWARD_BONUS_MAX = 0.3;
function rewardBonus(job, profileId) {
  if (!job) return 0;
  const pid = profileId || resolveProfileId(job.source);
  const ac = jobAtsCompany(job);
  const companyKey = ac.companyKey;
  let signal = 0;
  if (companyKey) {
    const agg = get(
      'SELECT AVG(reward) AS avgR, COUNT(*) AS n FROM application_outcomes WHERE profile_id = ? AND company_key = ?',
      [pid, companyKey]);
    if (agg && agg.n) signal += Number(agg.avgR) || 0;
  }
  // The resolved recipe's reward_score (credit assignment bumps it on interview replies).
  try {
    const resolved = resolveRecipe(ac.ats, companyKey, pid);
    const rid = resolved.companyRecipeId || resolved.atsRecipeId;
    if (rid) {
      const r = get('SELECT reward_score FROM ats_recipes WHERE id = ?', [rid]);
      if (r && r.reward_score) signal += Number(r.reward_score) * 0.5;   // recipe signal weighted half the company-outcome signal
    }
  } catch {}
  if (signal <= 0) return 0;
  // Saturating squash so the bonus is bounded by REWARD_BONUS_MAX.
  return REWARD_BONUS_MAX * (signal / (signal + 1));
}

// stalenessPenalty(job) → small [0, STALE_PENALTY_MAX] decay by job age (updatedAt|createdAt),
// so an older posting ranks slightly lower than an otherwise-equal fresh one.
const STALE_PENALTY_MAX = 0.1;
function stalenessPenalty(job) {
  const ref = job && (job.updatedAt || job.createdAt);
  const t = ref ? Date.parse(ref) : NaN;
  if (!Number.isFinite(t)) return 0;
  const ageDays = (Date.now() - t) / 86400000;
  if (ageDays <= 7) return 0;
  // Linear ramp from 0 (7 days) to STALE_PENALTY_MAX (90+ days old).
  return STALE_PENALTY_MAX * clamp((ageDays - 7) / (90 - 7), 0, 1);
}

// rankJob(job, profileId, opts?) → composite score (higher = better). Blends:
//   base fit (fit.js, 0..1)  + rewardBonus (≤0.3)  − geoPenalty (≤0.5)  − stalenessPenalty (≤0.1)
//   − punishment: an ACTIVE matching punishment returns a strongly negative rank (effectively
//     excluded while active). opts may carry { profile, resumeText } so callers that already have
//     them avoid a re-load; otherwise the source-matched profile is used.
function rankJob(job, profileId, opts = {}) {
  if (!job) return 0;
  const pid = profileId || resolveProfileId(job.source);
  // Punishment is a hard floor: while active, the job is excluded from ranking selection.
  if (punishmentPenalty(job, pid) > 0) return -1;
  let profile = opts.profile || null;
  if (!profile) { try { profile = listProfiles().find((p) => p.id === pid) || profileForSource(job.source) || null; } catch { profile = null; } }
  const resumeText = opts.resumeText || '';
  let base = 0;
  try { base = (fitScore(job, profile, resumeText).score || 0) / 100; } catch { base = 0; }
  const rank = base + rewardBonus(job, pid) - geoPenalty(job, pid, profile) - stalenessPenalty(job);
  return rank;
}

// ============================================================
// Teach & Correct — demonstrations + screenshots [v2 T1]
// ============================================================
const DEMOS_KEEP_PER_KEY = 3;   // keep the newest N demonstrations per (profile, ats, label)

// Record one full-fidelity demonstration step (a real click/fill the user did). The
// credential rail is enforced HERE too: for a sensitive field we keep the locator
// (so we know WHERE it is) but NEVER the value / HTML / screenshot.
function recordDemonstration(d = {}) {
  const pid = d.profileId || ensureDefaultProfileId();
  const label = String(d.label || '');
  const sensitive = isSensitiveKey(label);
  const labelNorm = normalizeQuestion(label);
  const id = uid('demo');
  run(`INSERT INTO demonstrations
       (id, profile_id, session_id, job_id, ats, company_key, step_index, action, label, label_norm,
        field_type, selector, xpath, attrs, html, value, screenshot_id, delay_ms, source, ts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, pid, d.sessionId || null, d.jobId || null, d.ats || null, d.companyKey || null,
       d.stepIndex != null ? d.stepIndex : null, d.action || null, label.slice(0, 300), labelNorm,
       d.fieldType || null, d.selector || null, d.xpath || null,
       d.attrs ? JSON.stringify(d.attrs).slice(0, 4000) : null,
       sensitive ? null : (d.html != null ? String(d.html).slice(0, 8000) : null),
       sensitive ? null : (d.value != null ? String(d.value).slice(0, 2000) : null),
       sensitive ? null : (d.screenshotId || null),
       d.delayMs != null ? d.delayMs : null, d.source || 'manual', now()]);
  pruneDemonstrations(pid, d.ats || null, labelNorm);
  return get('SELECT * FROM demonstrations WHERE id = ?', [id]);
}

// Keep the newest N demonstrations per (profile, ats, label); prune older rows + their
// now-orphaned screenshots. Bounded storage, freshest truth always retained.
function pruneDemonstrations(profileId, ats, labelNorm, keepN = DEMOS_KEEP_PER_KEY) {
  if (!labelNorm) return 0;
  const stale = all(
    `SELECT id, screenshot_id FROM demonstrations
     WHERE profile_id = ? AND IFNULL(ats,'') = IFNULL(?, '') AND label_norm = ?
     ORDER BY ts DESC LIMIT -1 OFFSET ?`, [profileId, ats, labelNorm, keepN]);
  for (const r of stale) {
    run('DELETE FROM demonstrations WHERE id = ?', [r.id]);
    if (r.screenshot_id) maybeDeleteScreenshot(r.screenshot_id);
  }
  return stale.length;
}

function demonstrationsFor(profileId, { ats, companyKey, labelNorm } = {}) {
  const pid = profileId || ensureDefaultProfileId();
  const where = ['profile_id = ?']; const args = [pid];
  if (ats) { where.push('ats = ?'); args.push(ats); }
  if (companyKey) { where.push('company_key = ?'); args.push(companyKey); }
  if (labelNorm) { where.push('label_norm = ?'); args.push(labelNorm); }
  return all(`SELECT * FROM demonstrations WHERE ${where.join(' AND ')} ORDER BY session_id, step_index, ts`, args);
}

// demonstrationsForSession — T3 enrichment source. All demos for one teach/apply session
// (and/or one job), ordered by step_index then ts so the distiller can walk them in
// capture order and reason about freshness. Either filter may be omitted.
function demonstrationsForSession(profileId, { sessionId, jobId } = {}) {
  const pid = profileId || ensureDefaultProfileId();
  const where = ['profile_id = ?']; const args = [pid];
  if (sessionId != null) { where.push('session_id = ?'); args.push(sessionId); }
  if (jobId != null) { where.push('job_id = ?'); args.push(jobId); }
  return all(`SELECT * FROM demonstrations WHERE ${where.join(' AND ')} ORDER BY step_index, ts`, args);
}

function recordTeachScreenshot({ profileId, path: p, w, h, bytes } = {}) {
  const id = uid('shot');
  run('INSERT INTO teach_screenshots (id, profile_id, path, w, h, bytes, ts) VALUES (?,?,?,?,?,?,?)',
      [id, profileId || null, p || null, w || null, h || null, bytes || null, now()]);
  return id;
}

// Delete a screenshot file + row only when nothing references it anymore.
function maybeDeleteScreenshot(screenshotId) {
  if (!screenshotId) return;
  if (get('SELECT 1 FROM demonstrations WHERE screenshot_id = ? LIMIT 1', [screenshotId])) return;
  if (get('SELECT 1 FROM recipe_steps WHERE screenshot_id = ? LIMIT 1', [screenshotId])) return;
  const row = get('SELECT path FROM teach_screenshots WHERE id = ?', [screenshotId]);
  if (row && row.path) { try { fs.unlinkSync(row.path); } catch {} }
  run('DELETE FROM teach_screenshots WHERE id = ?', [screenshotId]);
}

// ============================================================
// Review / Audit dashboard — "Taught Procedures" [v2 T5]
// ============================================================
// A step "needs attention" when it's low-confidence (the replayer is unsure it picks the
// right element), was recently CORRECTED (the user just fixed it — surface it so they can
// verify the fix stuck), or is fail-prone (a recipe with more fails than successes drags
// every one of its steps onto the list). Pure read-side flag; nothing is mutated.
const NEEDS_ATTN_CONF = 0.5;                         // confidence below this → attention
const RECENT_CORRECTION_MS = 7 * 24 * 60 * 60 * 1000; // a correction within a week is "recent"
function stepNeedsAttention(step, recipe) {
  const conf = Number(step.confidence);
  if (Number.isFinite(conf) && conf < NEEDS_ATTN_CONF) return true;
  if (step.source === 'correction' && step.updatedAt) {
    const age = Date.now() - new Date(step.updatedAt).getTime();
    if (Number.isFinite(age) && age >= 0 && age < RECENT_CORRECTION_MS) return true;
  }
  // Fail-prone: the parent recipe has diverged more than it has succeeded.
  if (recipe && (Number(recipe.failCount) || 0) > (Number(recipe.successCount) || 0) &&
      (Number(recipe.failCount) || 0) > 0) return true;
  return false;
}

// listRecipesWithSteps(profileId) — the full Taught-Procedures bundle for a profile: every
// recipe (scope ats|company) with its ordered steps, each carrying a `needsAttention` flag.
// Steps are returned in step_index order (= replay order). `company` is the company_key for
// scope='company' recipes, null for the cross-company ATS recipe. Read-only.
function listRecipesWithSteps(profileId) {
  const pid = profileId || ensureDefaultProfileId();
  const recipes = all(
    `SELECT * FROM ats_recipes WHERE profile_id = ?
     ORDER BY ats ASC, (company_key IS NULL) DESC, company_key ASC`, [pid]).map(rowToRecipe);
  return recipes.map((r) => {
    const steps = recipeSteps(r.id).map((s) => ({ ...s, needsAttention: stepNeedsAttention(s, r) }));
    return {
      ...r,
      company: r.companyKey || null,
      steps,
      attentionCount: steps.filter((s) => s.needsAttention).length,
    };
  });
}

// updateRecipeStepFields(stepId, patch) — edit ONE recipe step from the review dashboard.
// Supported edits: defaultValue (the learned answer), labelPattern (rename the field),
// scope (move the step to this recipe's ats↔company sibling recipe), stepIndex (reorder),
// action. The credential rail is authoritative: a step whose (current OR new) label is
// sensitive can NEVER be given a value — the edit is applied but defaultValue stays null.
// Returns the updated step row, or null if the step is gone.
function updateRecipeStepFields(stepId, { defaultValue, labelPattern, scope, stepIndex, action } = {}) {
  if (!stepId) return null;
  const row = get('SELECT * FROM recipe_steps WHERE id = ?', [stepId]);
  if (!row) return null;
  const ts = now();
  const sets = []; const args = [];

  // Resolve the effective label (after a rename) to decide the credential rail.
  const newLabel = labelPattern !== undefined && labelPattern !== null ? String(labelPattern) : null;
  const effectiveLabel = newLabel != null ? newLabel : (row.label_pattern || '');
  const sensitive = isSensitiveKey(effectiveLabel);

  if (newLabel != null) { sets.push('label_pattern = ?'); args.push(newLabel); }
  if (action !== undefined && action !== null) { sets.push('action = ?'); args.push(String(action)); }
  if (Number.isFinite(Number(stepIndex))) { sets.push('step_index = ?'); args.push(Number(stepIndex)); }
  if (defaultValue !== undefined) {
    // RAIL: refuse to persist a value on a sensitive field — keep it null no matter what.
    sets.push('default_value = ?');
    args.push(sensitive ? null : (defaultValue == null ? null : String(defaultValue)));
  }

  // scope flip: move the step into this recipe's sibling recipe of the other scope
  // (ats↔company), creating it if needed. A scope='company' target needs a company_key —
  // reuse the source recipe's company_key, else fall back to its ats name.
  if (scope === 'ats' || scope === 'company') {
    const src = get('SELECT * FROM ats_recipes WHERE id = ?', [row.recipe_id]);
    if (src && src.scope !== scope) {
      const companyKey = scope === 'company'
        ? (normCompanyKey(src.company_key) || normCompanyKey(src.ats) || src.ats)
        : null;
      const dest = upsertRecipe({ profileId: src.profile_id, scope, ats: src.ats, companyKey });
      if (dest && dest.id !== row.recipe_id) {
        const nextIdx = (get('SELECT MAX(step_index) AS m FROM recipe_steps WHERE recipe_id = ?', [dest.id])?.m ?? -1) + 1;
        sets.push('recipe_id = ?'); args.push(dest.id);
        if (!Number.isFinite(Number(stepIndex))) { sets.push('step_index = ?'); args.push(nextIdx); }
      }
    }
  }

  if (!sets.length) return rowToStep(get('SELECT * FROM recipe_steps WHERE id = ?', [stepId]));
  sets.push('updated_at = ?'); args.push(ts);
  args.push(stepId);
  run(`UPDATE recipe_steps SET ${sets.join(', ')} WHERE id = ?`, args);
  return rowToStep(get('SELECT * FROM recipe_steps WHERE id = ?', [stepId]));
}

// deleteRecipeStep(stepId) — remove a step from the review dashboard and clean up its
// now-orphaned screenshot (maybeDeleteScreenshot is a no-op if anything still points at it).
// Returns true if a row was removed.
function deleteRecipeStep(stepId) {
  if (!stepId) return false;
  const row = get('SELECT screenshot_id FROM recipe_steps WHERE id = ?', [stepId]);
  if (!row) return false;
  run('DELETE FROM recipe_steps WHERE id = ?', [stepId]);
  if (row.screenshot_id) maybeDeleteScreenshot(row.screenshot_id);
  return true;
}

// getTeachScreenshotPath(id) — the on-disk PNG path for a teach screenshot, for serving it
// to the dashboard. Null if unknown.
function getTeachScreenshotPath(id) {
  if (!id) return null;
  const row = get('SELECT path FROM teach_screenshots WHERE id = ?', [id]);
  return (row && row.path) || null;
}

module.exports = {
  open, close, backupNow, dailyBackup, maintenance, transaction,
  getSettings, patchSettings, normalizeAutoApply, kvGet, kvSet,
  listJobs, getJob, upsertJob, patchJob, deleteJob, stats, activityTrend,
  listEvents, listRecentEvents, recordEvent,
  qaRecord, qaLookup, qaList, qaDelete, normalizeQuestion, guessLocale,
  profileFieldUpsert, profileFieldList, profileFieldSet, profileFieldDelete,
  profileFieldLookup, profileAutofillBundle, harvestAnswersToProfile, backfillProfileFromJobs, deriveProfileFromLearned,
  memoryToProfileData, pushProfileDataToMemory, ensureDefaultProfileId, resolveProfileId,
  classifyAts, normCompanyKey, recordNavEvent, navEventsForProfile, isSensitiveKey,
  upsertRecipe, getRecipe, upsertRecipeStep, recipeSteps, markRecipeOutcome, recordRecipeCorrection, resolveRecipe,
  recordDemonstration, pruneDemonstrations, demonstrationsFor, demonstrationsForSession, recordTeachScreenshot, maybeDeleteScreenshot,
  listRecipesWithSteps, updateRecipeStepFields, deleteRecipeStep, getTeachScreenshotPath,
  listProfiles, saveProfile, deleteProfile, profileForSource,
  listDocuments, getDocument, addDocument, patchDocument, deleteDocument, defaultDocument,
  extractKeywords, folderList, folderGet, folderAdd, folderTouch, folderDelete, upsertFolderDocument,
  documentByPath, pruneMissingFolderDocs, listFolderEnabled: () => folderList().filter((f) => f.enabled),
  discoveryBatchStart, discoveryBatchGet, discoveryBatchComplete, discoveryBatchList, discoveryRecordJob,
  discoveryFallbackQueue, discoveryFallbackNext, discoveryFallbackComplete, discoveryHealth, reconcileDiscovery, pipelineHealth,
  queueList, queueHistory, queueBreakdown, summarizeRun, queueRunSummary, queueLive, queueAdd, queuePatch, queueDelete, queueRunStats, queueParkedQuestions, queueNeedsYou, queueRetryParked, retryStaleQueue, reconcileStaleRunning, reclaimDeadParks, reconcileFalseSubmits, quarantineUntrustworthyDone, recoverRaceLostSubmissions, recoverVerifiedEvidenceFromTranscript, isTrustworthyEvidence, saveIntakeAnswer,
  classifyQueueFailure, taskSiteKey, queueActiveSiteKeys,
  setEasyApplyCooldown, easyApplyCooledDown, easyApplyStatus, easyApplyEligible, easyApplySubmitted24h,
  aiLog, aiLogList, aiUsage,
  exportAll, importAll, bulkImportApplications, wipeAllData,
  emailUpsert, emailsForJob, emailSuggestionsForJob, setEmailMatch, listEmails, emailStats, emailCursor, setEmailCursor, jobsForMatching, findJobByThread, gmailStatusFromCategory, reprocessEmails, elevateJobFromEmail,
  recordOutcome, creditOutcomeForEmail, emailsNeedingConfirm, confirmEmailLink, outcomesForJob,
  punish, unpunish, listPunishments, punishmentPenalty, isPunished, punishCompanyCascade,
  geoPenalty, rankJob,
  STATUS_ORDER, TERMINAL, normJobUrl, normKey,
};
