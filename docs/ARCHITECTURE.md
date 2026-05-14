# JAT v9 — Architecture

> The whole system at a glance: what runs where, how the pieces talk to each other, and where state lives.

## 30-second mental model

Two binaries that talk to each other over `localhost:7733`:

```
┌──────────────────┐       chrome.runtime         ┌──────────────────┐
│ Chrome extension │ ◄─────────────────────────► │  Background SW   │
│  (extension/)    │   message passing (JSON)     │  (background.js) │
└────────┬─────────┘                              └────────┬─────────┘
         │                                                 │
         │ injected content scripts                        │ HTTP POST /sync/event
         ▼                                                 │ WebSocket on /ws
┌──────────────────┐                                       ▼
│  Job board pages │                              ┌──────────────────┐
│  (LinkedIn etc.) │                              │  Desktop app     │
│                  │                              │  (Electron)      │
│  content/*.js    │                              │  app/src/        │
└──────────────────┘                              └──────────────────┘
                                                            │
                                                  ┌─────────┴─────────┐
                                                  │ SQLite database   │
                                                  │ better-sqlite3    │
                                                  └───────────────────┘
```

- **Chrome extension** (`extension/`): MV3, 48+ page modules in `extension/app/pages/`, IndexedDB v4 for local storage, content scripts injected into job boards
- **Desktop app** (`app/`): Electron 32, SQLite via `better-sqlite3` 11, HTTP+WS server on `:7733`, system tray, global hotkey, electron-updater
- **GitHub Releases**: hosts installers + auto-update metadata. The extension's `releasesBaseUrl` setting points at `https://github.com/PierreSalama/Job-ext-app/releases/latest/download`

## Repo layout

```
v9/
├── extension/                 Chrome MV3 extension
│   ├── manifest.json          MV3 manifest, version, permissions
│   ├── background.js          Service worker, message router, IndexedDB writes
│   ├── content/
│   │   ├── loader.js          Entry; dynamic-imports the other modules
│   │   ├── universal.js       Adapter dispatcher; injects per-site UI panel
│   │   ├── autofill.js        Form-field autofill engine
│   │   ├── adapters/          Per-site capture adapters (linkedin/indeed/etc.)
│   │   ├── resume-tailor-prompt.js   v9.0.1+ tailor pop-up
│   │   └── auto-apply.js      v9.0.1+ RPA "AI auto-apply" engine
│   ├── app/                   Extension's full-page UI (chrome-extension://.../app/app.html)
│   │   ├── app.html / app.js  SPA shell
│   │   ├── v9.css             v9 design system (overrides app.css)
│   │   ├── pages/*.js         One file per sidebar page
│   │   ├── sidebar.js         Sidebar render + grouping
│   │   └── ...
│   ├── lib/
│   │   ├── db.js              IndexedDB wrapper + DEFAULT_SETTINGS + DEFAULT_PROFILE
│   │   ├── ai.js              AI provider abstraction (Ollama/OpenAI/Chrome)
│   │   ├── pages.js           Registry of every sidebar page (id, route, label, ...)
│   │   ├── sync-client.js     WebSocket client to the desktop app
│   │   └── ...
│   ├── popup/                 Toolbar popup HTML+JS
│   ├── setup/                 Install/uninstall scripts (.ps1, .sh)
│   ├── icons/                 Extension icons
│   └── test/runner.mjs        160+ tests (pure-Node, no browser)
│
├── app/                       Electron desktop app
│   ├── package.json           Version, electron-builder config
│   ├── src/
│   │   ├── main.js            Electron main process, tray, hotkey, autoUpdater
│   │   ├── server.js          HTTP+WS server on :7733
│   │   ├── db.js              SQLite wrapper
│   │   ├── preload.js         contextBridge exposing window.jat5.api
│   │   ├── index.html         Renderer entry
│   │   └── app/               Renderer (mirrors extension/app/ for parity)
│   └── build/
│       ├── make-icons.mjs     Pure-Node ICO+ICNS encoder from icon.svg
│       └── build-*.{ps1,sh}   Per-platform installer scripts (local builds)
│
├── .github/workflows/
│   └── release.yml            CI: builds installers on every v9.* tag push,
│                              attaches them + electron-updater metadata to a Release
│
├── docs/                      You are here
│   ├── ARCHITECTURE.md
│   ├── FEATURES.md
│   ├── RELEASING.md
│   ├── DEBUGGING.md
│   └── HANDOFF.md
│
├── README.md                  Project intro
└── RELEASING.md               Release flow (top-level summary, points to docs/RELEASING.md)
```

## Key data flows

### 1. User views a job posting → tailor prompt
1. `content/loader.js` runs on every supported host (manifest.json `matches`)
2. It dynamic-imports `universal.js` → loads the right adapter → `boot()`
3. `boot()` calls `tryFire()` at 2.2s and again at 5.5s
4. `tryFire` → `getContextWithRetry(12, 250)` returns `{title, company, description, ...}` from the adapter
5. Calls `window.__jat_tailor_show(ctx)` (defined by `resume-tailor-prompt.js`)
6. Tailor prompt's `maybeShow(ctx)` checks confidence + state + settings, then shows the card
7. Card has `chrome.runtime.sendMessage` calls back to background for `get-default-resume`, `tailor-resume-for-job`, `download-tailored-resume`, etc.

### 2. User captures a job application (Apply click)
1. Adapter detects submit click in `universal.js`'s click hook (line ~163)
2. Sends `{type:'capture', data:{title, company, ...}}` via `chrome.runtime.sendMessage`
3. Background's `capture` handler (background.js:454) → `upsertJob(...)` → IndexedDB → broadcasts `job.created` / `job.updated`
4. App page's broadcast listener (app.js:413) → updates `state.jobs` → re-renders sidebar/dashboard
5. If desktop app is running and paired: sync-client.js POSTs the event to `localhost:7733/sync/event`

### 3. User clicks "Auto-apply this job" in popup
1. Popup's `#auto-apply` button → sends `{type:'start-auto-apply-current-tab'}` to background
2. Background queries `chrome.tabs.query({active:true, currentWindow:true})` → gets tab ID
3. Sends `{type:'start-auto-apply'}` to that tab via `chrome.tabs.sendMessage`
4. `content/auto-apply.js`'s onMessage listener (line ~250) receives it → calls `run()`
5. `run()` shows overlay, loops up to 20 steps:
   - Fetch profile via `chrome.runtime.sendMessage({type:'get-profile'})`
   - Each step: `autofill.autofillAll(profile)` → `findAdvanceButton()` → synthetic click
   - Detects completion via DOM hash change + confirmation-text scan

### 4. Extension or app update available
1. Background's `silentUpdateCheck()` runs every 6h via alarm + once 3s after SW boot
2. Hits `https://api.github.com/repos/PierreSalama/Job-ext-app/releases/latest`
3. Compares `tag_name` to `chrome.runtime.getManifest().version` and to `localhost:7733/version`
4. Stores result in `chrome.storage.local.jat9.updateInfo` + `jat9.appUpdateInfo`
5. Broadcasts `extension.update.checked` / `app.update.checked`
6. App page listens → renders top-of-page gradient banner + Settings card with version + Download button
7. User clicks **⬇ Download update** → background's `download-and-install-app-update` handler → `chrome.downloads.download(installer.exe)` → `chrome.downloads.open()` on completion → NSIS handles in-place upgrade

## Critical message types (background.js handlers)

| Type | Direction | Payload | Returns |
|---|---|---|---|
| `capture` | content → background | `{title, company, jobUrl, description, applied, ...}` | `{ok, action, job}` |
| `get-profile` / `patch-profile` | any → background | profile fields | `{ok, profile}` |
| `get-settings` / `patch-settings` | any → background | settings fields | `{ok, settings}` |
| `list-jobs` / `get-job` / `patch-job` / `delete-job` | any → background | job id / patch | `{ok, items/job}` |
| `tailor-resume-for-job` | content → background | `{title, company, description}` | `{ok, id, name}` |
| `download-tailored-resume` | any → background | `{id}` | `{ok, downloadId}` |
| `get-default-resume` / `set-default-resume` | any → background | document id | `{ok, document}` |
| `start-auto-apply-current-tab` / `stop-auto-apply-current-tab` | popup → background | — | forwards to active tab |
| `check-extension-update` / `check-app-update` | any → background | — | update info |
| `download-and-install-app-update` | any → background | `{quitFirst?}` | `{ok, downloadId, version}` |
| `launch-downloaded-installer` | any → background | `{id, fileName}` | `{ok}` |
| `open-app` | any → background | `{route?, suppressWelcome?}` | `{ok}` |
| `ai-call` | any → background | `{feature, ...}` | `{ok, result}` |

(Full list: search `case '` in background.js)

## Critical broadcasts (background → all pages)

```js
broadcast('settings.updated',     { settings });
broadcast('job.created' / 'job.updated' / 'job.deleted', { job/id });
broadcast('documents.updated',    {});
broadcast('extension.update.checked', { hasUpdate, current, latest, url });
broadcast('app.update.checked',       { hasUpdate, current, latest, downloaded });
broadcast('app.installer.downloading' / 'ready' / 'failed', { ... });
broadcast('sync.status', syncStatus);
broadcast('tailoredResumes.updated' / 'fitScores.updated' / 'tags.updated' / ...);
broadcast('sidebar.reset', { sidebarHidden });
```

## Storage

| Where | What | Why |
|---|---|---|
| **IndexedDB** (`jat9` db) | Jobs, documents, messages, contacts, companies, events, tags, etc. | The big stuff — survives extension reloads, can be many MB |
| **chrome.storage.local** | Settings, profile, named profiles, audit signing keys, update info | Small key-value, fast access, synced across SW + pages |
| **sessionStorage** (content scripts) | Tailor-prompt "shown jobs" set | Per-tab only, dies on refresh |
| **SQLite** (desktop only) | Mirror of jobs/docs/etc. | Persistent across desktop app restarts, accessible without Chrome |

## Why some things look weird

- **Two database systems**: extension uses IndexedDB (Chrome-only); desktop uses SQLite (Electron). They sync via the server's `/sync/event` endpoint. Source of truth is whichever side initiated the change.
- **`jat5.*` chrome.storage keys**: legacy from v5; still in use. Migration kept names stable.
- **`v6Uuid` / `V6_STORES`**: internal names from v6 migration. Don't appear to users.
- **DB_VERSION = 4**: incremented when adding new IndexedDB stores. `upgradeneeded` adds them additively, never deletes.
- **`sidebarDefaultsVersion` setting**: marker for the sidebar-hidden migration. Bumped to 5 on v9 release so existing v8 users get the strict default.
