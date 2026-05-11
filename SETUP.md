# Job Application Tracker v6 — Setup

You can use **just the Chrome extension** and have a fully working tracker. The **desktop app** is optional but unlocks deeper features (background scrapes, file watching, headless interview mode, instant cross-device sync, full-text search, PDF rendering). They sync over a tiny local server on `localhost:7733` when both are running.

```
v6/
├── extension/   ← Chrome MV3 extension (mandatory)
└── app/         ← Electron desktop app (optional companion)
```

---

## 1. Install the extension (required)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** → select `v6/extension`.
4. Pin "Job Application Tracker v6" to your toolbar.

That's it. You can now visit LinkedIn, Indeed, Glassdoor, Greenhouse, Lever, Workday — every application is captured automatically. Click the toolbar icon → **Open dashboard** for the full UI.

### Optional: enable AI features (Ollama, local + free)

1. Install [Ollama](https://ollama.com/download) for your OS.
2. Pull the model: `ollama pull gemma3:4b`
3. The extension already strips the browser `Origin` header so Ollama accepts requests — no further setup needed.

If you see a 403 from Ollama anyway, set the env var: `OLLAMA_ORIGINS=chrome-extension://*` and restart Ollama. The AI Setup Wizard inside the extension (`#/ai`) walks you through it and provides bundled scripts (`setup/install-ollama-{windows,mac,linux}.{ps1,sh}`).

---

## 2. Install the desktop app (optional)

The extension shows an **"Install desktop app"** banner whenever the local sync server isn't reachable. Click it for an in-app installer wizard, OR follow these steps:

### Prerequisites

- [Node.js](https://nodejs.org/) 18+ (for installing dependencies).
- A C++ build toolchain (only needed during install — `better-sqlite3` is a native module):
  - **Windows:** install [Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the *Desktop development with C++* workload.
  - **macOS:** `xcode-select --install`
  - **Linux:** `sudo apt install build-essential`

### Install + run

```bash
cd v6/app
npm install        # installs Electron, better-sqlite3, electron-rebuild
                   # postinstall step rebuilds better-sqlite3 against Electron's Node
npm start          # launches the desktop app
```

### Already installed but seeing `NODE_MODULE_VERSION` mismatch?

Run once:

```bash
cd v6/app
npm run rebuild
```

This forces `better-sqlite3` to recompile against the version of Node that ships inside Electron. Do this any time you upgrade Electron.

---

## 3. Pairing extension ↔ desktop app

When both are running, they auto-discover each other:

1. The desktop app starts an HTTP + WebSocket server on `localhost:7733`.
2. The extension's background worker probes that endpoint every few seconds.
3. On first contact, the extension shows a **"Pair with desktop app"** prompt. Click it to exchange a sync token (stored in `chrome.storage.local`).
4. From then on every job, profile change, document upload, audit entry, and learned answer flows instantly between both surfaces over WebSocket.

To unpair: extension → Settings → Integrations → "Disconnect desktop app".

---

## 4. Common scenarios

### "I only installed the extension"

Everything works. The dashboard shows a small purple banner suggesting you install the app for more power. No required action.

### "I only installed the app"

The app's first launch opens an onboarding screen with a "Load unpacked extension" guide. Folder path is shown for one-click copy.

### "I installed both"

The first time both are running you'll see a green ✓ "Synced with desktop app" pill in the extension sidebar. Both surfaces stay in lockstep.

### "Ollama is not running"

AI features show an inline error with a Retry button + a link to the AI Setup Wizard, which detects what's wrong (Ollama not installed / not running / no model pulled / wrong CORS origin) and tells you exactly what to do.

---

## 5. File layout cheat-sheet

| Path | What's there |
|------|--------------|
| `v6/extension/manifest.json` | Chrome MV3 manifest |
| `v6/extension/background.js` | Service worker — capture, AI, CRUD |
| `v6/extension/content/` | Per-source adapters + autofill engine |
| `v6/extension/app/` | The dashboard SPA (loaded by the extension's app page) |
| `v6/extension/app/pages/` | One file per sidebar page (28+ pages) |
| `v6/extension/lib/` | `db.js`, `ai.js`, `themes.js`, `pages.js`, `icon-presets.js`, `schema.js` |
| `v6/extension/setup/install-ollama-*.{ps1,sh}` | Helper scripts for Ollama |
| `v6/app/src/main.js` | Electron entry |
| `v6/app/src/server.js` | localhost:7733 HTTP + WS sync server |
| `v6/app/src/db.js` | better-sqlite3 wrapper mirroring the extension's IDB API |
| `v6/app/src/app/` | Same UI as the extension, with `chrome.*` swapped for `window.jat6.*` |

---

## 6. Troubleshooting

| Symptom | Fix |
|---------|-----|
| `NODE_MODULE_VERSION` mismatch on `npm start` | `cd v6/app && npm run rebuild` |
| `electron-rebuild` not found | `npm install` first; postinstall runs it automatically |
| Native build fails on Windows | Install VS Build Tools with the *Desktop development with C++* workload |
| Extension capture stops working | `chrome://extensions` → reload; check the Service Worker console for errors |
| AI buttons hang | Open AI Setup Wizard (`#/ai`); it diagnoses Ollama state |
| App can't open documents | Ensure your firewall allows the local server on port 7733 |

---

## 7. What's where in the UI

- **Extension popup** (toolbar click): quick stats, recent activity, status pill, install-app banner if app missing, dashboard launch button.
- **Extension dashboard** (`chrome-extension://...../app/app.html`): the full SPA — 28+ pages including Pipeline, Calendar, Inbox, Contacts, Companies, Network graph, Skills, Goals, Achievements, Resume Builder, Cover Letter Studio, Interview Prep, Salary research, Analytics, AI Lab, Audit log, Backup & export, etc.
- **Desktop app** (when installed): same UI, plus the menu bar offers global hotkeys, clipboard watching, and folder watching for resumes/cover letters.

---

When in doubt, the in-app **Take the tour** page (`#/tour`) walks you through every feature interactively.
