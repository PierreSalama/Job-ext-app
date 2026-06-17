// JAT v11 — hardcoded defaults.
// Every value here can be overridden at runtime through the `settings` table
// (PATCH /settings), which the dashboard's Settings page edits. This module is
// the single source of truth for "what the app does out of the box".
//
// Rule: code reads merged settings via db.getSettings() — never this object
// directly (except db.js itself, which merges it under the stored values).

const DEFAULTS = {
  server: {
    port: 7744,
  },

  app: {
    closeToTray: true,       // closing the window keeps capture alive in the tray
    autoLaunch: false,       // start with Windows
    globalHotkey: true,      // Ctrl+Shift+J toggles the dashboard window
  },

  autoUpdate: {
    mode: 'auto',            // 'auto' = silently install when the machine is idle + safe; 'prompt' = only via the in-app banner; 'manual' = only the tray check + Restart button
    idleMinutes: 5,          // OS idle (no keyboard/mouse) required before an unattended install
    graceMinutes: 10,        // after download, wait this long for the user to choose before auto-install is eligible
    checkEveryMinutes: 30,   // background poll cadence (floored to 15min)
    checkOnFocus: true,      // also check for updates when the app window regains focus
  },

  ai: {
    // Priority order — tried top to bottom, first one that's configured wins.
    // Reorder freely in Settings. Default: Claude → ChatGPT → local.
    order: ['claude', 'chatgpt', 'local'],

    // Claude (Anthropic). API key ONLY — Anthropic blocks subscription tokens
    // outside Claude Code (server-side, since Jan 2026).
    claude: {
      apiKey: '',
      model: 'claude-sonnet-4-6',
      timeoutMs: 120000,
    },

    // ChatGPT (OpenAI). Two ways: your ChatGPT subscription via the Codex CLI
    // (personal use), or an OpenAI API key. Subscription is tried first when on.
    chatgpt: {
      useSubscription: true,        // use the logged-in Codex CLI (ChatGPT sub)
      apiKey: '',                   // OpenAI API key (alternative / fallback)
      model: 'gpt-5.4',
      timeoutMs: 120000,
    },

    local: {
      provider: 'ollama',
      url: 'http://localhost:11434',
      autoPick: true,               // pick the model that fits this machine
      autoSetup: true,              // auto-download Ollama + models in the background on first run when no cloud key is set (zero-config local AI fallback)
      structuredModel: '',          // '' = use the hardware recommendation
      proseModel: '',               // '' = use the hardware recommendation
      timeoutMs: 90000,
      numCtx: 8192,
      keepAlive: '15m',
      trySpawn: true,               // try `ollama serve` if it's down
      exePath: '',                  // '' = resolve from PATH
    },
  },

  capture: {
    panelOnDetect: false,    // silent-mode ADR: panel appears at Apply click, not on detection
    askWhenUnsure: true,     // mid-confidence pages may ask once ("Track this application?")
    successRescanMs: 2000,   // success re-scan cadence while a flow is active
  },

  // Auto-learn answers from applications you fill so your profile self-populates.
  harvest: {
    enabled: true,           // promote captured form answers into the profile store
    minLen: 1,               // ignore answers shorter than this many chars
  },

  // Reverse direction: pre-fill new applications from the harvested profile.
  // ON by default (user requested); still NEVER auto-submits — empty fields only.
  autofill: {
    enabled: true,           // master switch — fills new applications automatically
    autoSubmit: false,       // hard invariant: filling never clicks submit
    fillProfile: true,       // use structured profile fields
    fillLearned: true,       // use harvested learned answers
    minConfidence: 0.6,      // fuzzy-match floor for a learned answer to be used
    skipSensitive: true,     // never touch EEO/demographic/legal/identity fields
    highlight: true,         // briefly outline fields we filled
  },

  documents: {
    keywordCount: 12,        // top-N keywords extracted per indexed document
    maxFolderFiles: 2000,    // safety cap when indexing a linked local folder
    maxFolderDepth: 6,       // how deep to walk a linked folder tree
  },

  autoApply: {
    enabled: false,          // master switch — just ON/OFF
    startedAt: '',           // ISO time the master switch was last turned ON (live "running for" timer)
    mode: 'auto',            // default: submit for me. 'review' stops before submit
    // SUSTAINABLE defaults — LinkedIn/Indeed throttle aggressive automation (they start
    // serving job pages WITHOUT the Easy-Apply button to rapid background tabs, which
    // silently zeroes out submissions). A moderate, human-like pace keeps applications
    // actually going through. The Advanced area lets you push it (at higher flag risk).
    maxPerDay: 150,
    maxPerHour: 30,
    minGapMinutes: 1,             // ~1–3 min between starts (human-like; avoids the throttle)
    maxGapMinutes: 3,
    concurrency: 2,               // applications in PARALLEL, but never two workers on the same site/ATS at once. Lower to 1 for the safest footprint.
    bringToFrontToHydrate: false, // OFF by default. ON = the apply window is brought to the FRONT while applying, guaranteeing the page isn't throttled (Chrome throttles a fully-occluded window — e.g. behind a fullscreen game — so the Easy-Apply button never loads). Trade-off: it takes focus while each application runs. Turn ON when reliability matters more than not being interrupted (e.g. running while away).
    frontToHydrate: true,         // ON by default. When the apply tab detects it is OCCLUDED (Chrome throttled it → LinkedIn never hydrates), it asks the SW to front the apply window ONLY for the few seconds it takes the form to load, then hands your focus straight back. Unlike bringToFrontToHydrate this is reactive (no steal unless actually occluded) and self-releasing. Set false to keep the old single-nudge behavior.
    runAnytime: true,        // ON by default — run 24/7. Turn OFF to use the window below.
    windowStart: '',         // only used when runAnytime is false
    windowEnd: '',
    aiAnswerConfidenceMin: 0.7,   // AI answers a screening question when reasonably confident (lower = fewer parks, more autonomy)
    easyApplyOnly: false,         // OFF = include normal/external postings and let the runner hand off to company/ATS forms when possible
    keywords: [],                 // e.g. ['software engineer', 'data analyst']
    locations: [],                // e.g. ['Toronto', 'Remote']
    boards: ['linkedin', 'indeed'],
    // ---- relevance / fit filters (skip jobs that don't match your level) ----
    experienceYears: 0,           // your years of experience; >0 = skip jobs that demand many more
    seniorityMax: 'any',          // 'any' | 'entry' | 'mid' | 'senior' — skip roles above this level
    excludeKeywords: [],          // title terms to always skip, e.g. ['game','manager','sales']
    excludeCompanies: [],         // company terms to always skip
    excludeLocations: [],         // location terms to always skip
    profileId: '',                // which profile to apply with ('' = default)
    resumeDocId: '',              // which résumé to attach ('' = default)
    discovery: {
      enabled: true,
      perRunLimit: 8,             // max jobs grabbed per search pass (kept small)
      refillBelow: 3,             // top up the queue when it drops below this
    },
    sites: {},               // per-host overrides: { 'linkedin.com': { mode: 'auto' } }
  },

  gmail: {
    enabled: false,
    query: 'from:jobs-noreply@linkedin.com',
    includeRecruiterMail: false,   // second-stage AI classification of generic recruiter mail
    intervalMinutes: 30,
    clientId: '',                  // Google OAuth desktop-app credentials (user-supplied)
    clientSecret: '',
  },

  // Multi-provider email integration (IMAP + App Password). Connected mailboxes
  // (with their app passwords) live in the kv store, NOT here — kv is never exported.
  email: {
    syncIntervalMinutes: 15,       // background resumable sync cadence
    autoLinkThreshold: 0.7,        // ≥ this confidence → auto-associate an email to a job
    suggestThreshold: 0.4,         // ≥ this (but < auto) → show as a "suggested" match
  },

  followUp: {
    days: 7,                 // auto follow-up date after submit; 0 = off
  },

  // Self-care: bound the data the app keeps + don't overstress the machine. Industry
  // norms — retention pruning, periodic VACUUM, pause background work on sleep, and an
  // opt-in battery saver. Generous defaults so nothing the user cares about is lost.
  maintenance: {
    eventRetentionDays: 400,        // prune timeline events older than this
    taskRetentionDays: 60,          // prune terminal (skipped/failed) auto-apply tasks older than this
    emailRetentionDays: 365,        // prune UNMATCHED emails older than this (matched/manual are always kept)
    vacuumEveryDays: 7,             // reclaim disk by compacting the DB at most this often
    pauseBackgroundOnBattery: false,// when true, defer background email/gmail sync while on battery
    memoryGuardMB: 1400,            // skip a background sync tick if the app's own RSS exceeds this
  },

  appearance: {
    theme: 'atelier',
  },

  notifications: {
    statusChanges: false,
    autoApply: true,
    updates: true,
    followUps: false,
  },

  backups: {
    keep: 14,                // daily backups retained
  },
};

module.exports = { DEFAULTS };
