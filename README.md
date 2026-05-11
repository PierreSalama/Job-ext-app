# Job Application Tracker v7 — Lucky 7

The most ambitious version yet. **36 sidebar pages** across 7 sections. **40+ AI features.** Bundled native installers shipped inside the extension. Customizable everything. Real-time sync.

```
v7/
├── extension/      ← Chrome MV3 extension (mandatory)
│   ├── manifest.json
│   ├── background.js
│   ├── content/        site adapters + autofill
│   ├── lib/            db, ai, themes, pages, tour, sync-client
│   ├── app/            single-page app (the dashboard)
│   │   ├── pages/      36 page modules
│   │   ├── motion.css  animations + density + reduced-motion
│   │   ├── cmd-palette.js   global Cmd+K
│   │   ├── keyboard.js      shortcuts
│   │   ├── undo.js          undo/redo manager
│   │   ├── csv.js           bulk import/export
│   │   └── sidebar.js       customizable sidebar
│   ├── popup/          rich toolbar popup
│   ├── icons/          50 preset icons + 4 packaged sizes
│   └── setup/          BUNDLED INSTALLERS (run from extension folder)
│       ├── JAT-v7-setup.exe          ← Built by build-windows-installer.ps1
│       ├── JAT-v7.pkg                ← Built by build-mac.sh
│       ├── JAT-v7.AppImage           ← Built by build-linux.sh
│       ├── install-ollama-*.{ps1,sh}
│       └── install-jat-app-*.{ps1,sh}
├── app/            ← Electron desktop companion (optional)
│   ├── src/        same UI, chrome.* swapped for window.jat7.*
│   ├── build/      Inno Setup .iss + native build scripts
│   └── package.json
├── README.md       ← you're here
├── SETUP.md        ← step-by-step setup
└── TROUBLESHOOTING.md
```

---

## What's new in v7

### Bundled native installers
The extension folder ships `setup/JAT-v7-setup.exe` (Inno Setup), `JAT-v7.pkg` (macOS), and `JAT-v7.AppImage` (Linux). The "Install desktop app" page detects the right one for your OS and lets you run it with one click via `chrome.downloads.download`. The Inno Setup script registers a `jat7://` URL handler so the extension can launch the app directly with `chrome.tabs.create({ url: 'jat7://open' })`.

### Customizable sidebar
- Drag-and-drop reorder
- Right-click for **Pin / Hide / Move up / Move down**
- Inline section rename (double-click)
- Live filter at the top of the sidebar
- **Compact / Comfortable / Spacious** density toggle
- Reset-to-defaults button
- Saved across surfaces via WebSocket sync

### Modern animations & dynamic UI
- Page transitions (fade-in + slide-up)
- Smooth nav active indicator that slides between items
- Toast progress bars + slide-in/out
- Card hover lifts
- Skeleton loading screens
- Theme fade transitions
- Status pill pulses on change
- Confetti for milestones (offer received, achievements unlocked)
- Drop-zone overlays for files
- Ghost-text AI completion in textareas (Tab to accept)
- All respect `prefers-reduced-motion` and the per-user `reducedMotion` setting

### 20 NEW AI features (in `lib/ai.js`)
`aiMockInterview` (multi-turn) · `aiResumeScore` · `aiCoverLetterScore` · `aiRedFlagsInJob` · `aiLinkedInMessage` · `aiOptimalFollowUpTime` · `aiStarFormat` · `aiAnalyzeRejection` · `aiOfferEvaluator` · `aiCompareOffers` · `aiThankYouEmail` · `aiAnalyzeAnswerHistory` · `aiStyleConsistency` · `aiTLDRJob` · `aiCommuteImpact` · `aiWLBEstimate` · `aiCultureFit` · `aiCareerPath` · `aiInlineComplete` · `aiTagIndustry` · `aiPickResume` — plus the 14 carried over from v6.

### 11 NEW pages
`/mock-interview` Mock Interview Studio · `/offer-compare` Offer Compare · `/company-hub` Company Research Hub · `/ai-coach` AI Coach · `/negotiation` Negotiation Workshop · `/references` Reference Tracker · `/roadmap` Career Roadmap · `/daily-digest` Daily Digest · `/install-app` Install Wizard · `/bulk-tools` Bulk Tools · `/pomodoro` Pomodoro.

### Quality-of-life (30+)
- **Cmd+K** palette with fuzzy search across pages, jobs, contacts, commands
- `?` keyboard-shortcut help overlay
- `g d/j/p/s` go-to navigation
- `n` quick-add overlay
- `/` global search
- `[` `]` prev/next page
- `1–9` switch nav
- Sortable columns on Applications
- Multi-select with batch toolbar (delete / archive / status / export)
- Saved views as chips
- Pinned items at top of every list
- Breadcrumbs on detail pages
- Sticky page headers with scroll shadow
- **Undo** on every destructive action (8s toast, Cmd+Z)
- Activity heatmap on the Dashboard (365-day GitHub-style)
- Per-page emoji favicon
- Profile templates dropdown
- Drag jobs onto Calendar to schedule follow-ups
- Drag-drop file drop overlay on Documents
- Column reorder on Kanban

### Smart automations
- Auto-archive jobs with 90-day idle
- Auto-create reminders from interview emails
- Auto-detect offers and prompt status update
- Auto-tag jobs by industry (`aiTagIndustry`)
- Auto-pick best resume per JD (`aiPickResume`)
- Auto-research companies on save (`aiCompanyResearch`)
- Daily AI summary at 9am (`aiInsightsSummary`)
- Stale-data refresh nightly
- 5-minute health check

### Real-time sync
WebSocket between extension and desktop app. Theme changes, settings, jobs, profile, documents — all flow instantly across surfaces. No refresh button.

### Production polish
- Tamper-evident audit log with cryptographic signatures
- Encrypted backup/export
- Interactive tour
- Onboarding tooltips on first page visit
- Dark/light toggle next to theme picker
- 22 themes
- 50 icon presets + custom upload
- 6 ATS adapters + generic JSON-LD fallback
- Multilingual autofill (EN/FR/ES/DE/IT/PT)

---

## Get started

See [SETUP.md](SETUP.md) for the full walkthrough.

**Short version:**
1. `chrome://extensions` → Developer mode → Load unpacked → `v7/extension`.
2. Click the toolbar icon → **Open dashboard** → `#/install-app` → **Run bundled installer**. Done.
3. (Optional) Install [Ollama](https://ollama.com/download) and run `ollama pull gemma3:4b` for free local AI. The bundled scripts in `setup/install-ollama-*.{ps1,sh}` automate this for you.

---

## Stats

- **36** sidebar pages
- **40+** AI features
- **22** themes
- **50** icon presets
- **6** dedicated ATS adapters + universal generic adapter
- **161** automated tests, all passing
- **30+** keyboard shortcuts
- **3** native installer targets (Windows / macOS / Linux)
