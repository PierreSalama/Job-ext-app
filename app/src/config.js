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
      autoSetup: false,             // auto-download Ollama + models in the background
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
    mode: 'auto',            // default: submit for me. 'review' stops before submit
    // Generous defaults (user asked) — the Advanced area lets you tighten these.
    // Empty window = run any time of day. Gaps are auto-managed but adjustable.
    maxPerDay: 50,
    maxPerHour: 10,
    minGapMinutes: 2,
    maxGapMinutes: 6,
    windowStart: '',         // '' = no daytime window (runs any time)
    windowEnd: '',
    aiAnswerConfidenceMin: 0.8,   // AI answers a screening question ONLY when highly confident
    easyApplyOnly: true,          // ON + locked in the UI (non-Easy-Apply isn't supported yet)
    keywords: [],                 // e.g. ['software engineer', 'data analyst']
    locations: [],                // e.g. ['Toronto', 'Remote']
    boards: ['linkedin', 'indeed'],
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
