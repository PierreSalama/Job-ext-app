# JAT v10 — skeleton

A clean rebuild of the Job Application Tracker, started 2026-05-14.

```
v10/
  extension/   Chrome MV3 extension (this is what loads into the browser)
  app/         Electron companion (this is the desktop app you install)
```

The goal: every feature is added, tested, and approved by Pierre **one at a time** before the next one is started. No more 100-feature dumps that bury bugs. No more auto-popping cards or surprise dashboards.

## What this skeleton does

Almost nothing — and that's the point.

### Extension (`extension/`)
- **Service worker** (`background.js`): records install time, answers `ping`, and probes the desktop app's `/health` endpoint on demand. No alarms, no tab manipulation.
- **Popup** (`popup/`): 300px panel showing SW status, desktop-app connection status, install timestamp, active tab URL, and a `⬇ Download desktop app` button (opens GitHub Releases).
- **LinkedIn content script** (`content/linkedin.js`): logs `[JAT v10] content script loaded on <url>` to the page console. No DOM injection.
- **Permissions:** `storage` + `downloads` + LinkedIn host + `localhost:7744` (app health probe) + GitHub hosts (release lookup + installer download). No `tabs`, no `scripting`, no `alarms`.
- **Download button** asks GitHub for the latest release matching the extension's major version (`v10.x.y`), picks the asset for the user's OS (`JAT-v10-setup.exe` / `JAT-v10.dmg` / `JAT-v10.AppImage`), and triggers `chrome.downloads.download` immediately — no `saveAs` prompt, straight to the Downloads folder.

### Desktop app (`app/`)
- **Electron main** (`src/main.js`): opens one window, starts the HTTP server.
- **HTTP server** (`src/server.js`): listens on `http://localhost:7744`, exposes only `GET /health`.
- **Window UI** (`src/app/`): shows the server is up and that it can hit its own `/health`.

### Connection
Extension SW → `fetch http://localhost:7744/health` (proxied through the SW so the popup never hits CORS issues). The popup shows green **connected · v10.0.0** when the desktop app is running, red **offline** otherwise.

## How to load the extension

1. Open `chrome://extensions`.
2. Enable "Developer mode" (top right).
3. Click "Load unpacked".
4. Select `F:\GITHUB\Perosnal\extensions\job-application-tracker\v10\extension\` (the folder containing `manifest.json`).
5. **Remove or disable any older JAT versions** so they don't interfere.

## How to run the desktop app

```
cd F:\GITHUB\Perosnal\extensions\job-application-tracker\v10\app
npm install
npm start
```

See `app/README.md` for details.

## How to verify it works

1. Click the JAT v10 toolbar icon — popup shows "SW status: ok · v10.0.1" in green.
2. With the desktop app running, the popup also shows "Desktop app: connected · v10.0.0" in green. Quit the app and reopen the popup — it should flip to red "offline".
3. Visit any LinkedIn page, open DevTools → Console — see `[JAT v10] content script loaded on …`.
4. Open `chrome://extensions` → JAT v10 → "Service worker" → DevTools. The SW console shows `[JAT v10] installed { reason: 'install', ts: ... }` once.
5. Click `⬇ Download desktop app` in the popup. The status line reads "finding latest installer…" then "downloading JAT-v10-setup.exe (v10.x.y)" in green. Check your Downloads folder. **If no v10 release has been tagged yet, you'll see a red error** — that's correct behavior; tag a v10 release before testing this end-to-end.

## What's NOT here yet (intentionally)

- Job detection / scraping
- Capture pipeline / database
- Dashboard SPA inside the extension
- AI / Ollama / OpenAI
- Autofill engine
- Resume tailoring
- Real sync (the desktop app's `/health` is connectivity-only; no jobs, no settings, no broadcast)
- WebSocket / push events
- GitHub Releases auto-update wiring (the download button just opens the releases page)
- System tray, global hotkey, native notifications
- Database in the desktop app (no `better-sqlite3`, no IndexedDB)

Each will be added as a discrete feature branch, tested in isolation, and approved before the next.

## Adding a feature

1. Decide on the smallest possible version of the feature.
2. Write a one-line spec ("when X happens, Y should happen").
3. Implement.
4. Pierre tests in the loaded extension.
5. If it works → confirm, commit, move on. If it doesn't → fix until it does. No moving on with bugs.

## Project versions (for reference)

`v1/` through `v9/` are previous iterations sitting beside this folder. They're **inactive**. The active loaded extension should be v10. If a bug is reported, verify the version number in the loaded extension before editing.
