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

  ai: {
    // Provider order: 'cloud-first' | 'local-first' | 'cloud-only' | 'local-only'
    order: 'cloud-first',
    cloud: {
      provider: 'codex',          // Codex CLI, authenticated via ChatGPT subscription
      model: 'gpt-5.4',
      timeoutMs: 120000,
    },
    local: {
      provider: 'ollama',
      url: 'http://localhost:11434',
      structuredModel: 'qwen2.5-coder:7b',   // JSON extraction / classification
      proseModel: 'llama3.1:8b',             // cover letters, free-text answers
      timeoutMs: 90000,
      numCtx: 8192,
      keepAlive: '15m',
      // If the server is down, try `ollama serve` once before giving up.
      trySpawn: true,
      exePath: '',                           // '' = resolve from PATH
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
    enabled: false,          // master switch — OFF until Pierre flips it
    mode: 'review',          // 'review' (stop before final submit) | 'auto'
    maxPerDay: 5,
    maxPerHour: 2,
    minGapMinutes: 8,
    maxGapMinutes: 25,
    windowStart: '10:00',
    windowEnd: '18:00',
    aiAnswerConfidenceMin: 0.7,
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

  followUp: {
    days: 7,                 // auto follow-up date after submit; 0 = off
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
