# JAT v9 — Handoff Document

> This is for the next person (or AI) picking up this project. Read in order.

## Where we are right now

**Latest released version**: v9.0.4 (or whatever the latest tag on GitHub is — check https://github.com/PierreSalama/Job-ext-app/releases/latest)

**Production-ready**: Yes. The core capture flow + update mechanism are stable. The v9 frontend remaster is in place.

**Active development areas**:
1. **Resume Tailor on Apply** (v9.0.1 introduced, repeatedly debugged through v9.0.4) — see "Known issues" below
2. **Auto-Apply RPA** (v9.0.1 introduced, lightly tested) — see "Untested risks" below

## Setup for development

```bash
# Clone
git clone https://github.com/PierreSalama/Job-ext-app.git
cd Job-ext-app

# Extension dev: load `extension/` as unpacked in chrome://extensions

# Desktop app dev:
cd app
npm install
npm start
```

**Test suite**:
```bash
cd extension
node test/runner.mjs
# Should print "161 passed · 0 failed" (or higher if new tests added).
```

**No build step for the extension** — it's plain ES modules + HTML/CSS, loaded directly by Chrome.

**Build the desktop app installer**:
- Locally (Windows only currently has the right tooling): `cd app && npm run build:win` — produces `.exe` in `app/dist/`
- For ALL platforms: push a `v9.X.Y` tag → GitHub Actions runs the matrix (`.github/workflows/release.yml`) → builds on win/mac/linux runners → attaches to a Release. ~9 min.

## What's in this folder

Read these in this order:

1. **`docs/ARCHITECTURE.md`** — high-level system overview (binaries, message types, data flows, storage)
2. **`docs/FEATURES.md`** — every feature catalogued + where the code lives + how it works
3. **`docs/RELEASING.md`** — the GitHub Releases + electron-updater pipeline (also at top-level `RELEASING.md`)
4. **`docs/DEBUGGING.md`** — how to find logs, common bug recipes, sync-server endpoints for poking
5. **`docs/HANDOFF.md`** — this file
6. **`README.md`** — user-facing intro

After those, browse the code:
- **`extension/background.js`** is the message router. Search `case '` to find every handler.
- **`extension/app/app.js`** is the SPA shell. It dispatches to per-page modules in `extension/app/pages/`.
- **`extension/content/universal.js`** is where job-page detection lives. Adapters under `extension/content/adapters/`.

## Known issues / things that have been finicky

### Resume Tailor detection (the worst offender so far)

**Symptoms reported by user over the past few hours**:
- Sometimes doesn't fire on LinkedIn until refresh
- Sometimes fires twice and opens two dashboard tabs
- Welcome tutorial blocks the documents page on a fresh install
- After uploading a resume, the prompt doesn't recognize it

**Root causes we found**:
- SPA navigations (`history.pushState`) don't fire `popstate` — needed monkey-patching the History API
- Concurrent fires from boot-timer + pushState + URL polling + visibilitychange + broadcast listener — needed a global `STATE.busy` lock
- Setting `lastShownJobKey=null` to "allow re-show" created an open door for duplicate `open-app` calls — needed a 30s cooldown on `safeOpenApp()`
- `confident(ctx)` was missing in v9.0.2 → prompted on garbage like "Jobs · LinkedIn" page titles
- Auto-opening the dashboard from inside `maybeShow()` was racy → v9.0.4 made it explicit user-button-click only

**Current state (v9.0.4)**:
- Single `STATE.busy` lock around `maybeShow()`
- 30s cooldown on `safeOpenApp()`
- Confidence gate (`confident()` function) before any UI
- NO auto-open of dashboard; explicit `[📁 Open Documents page]` button only
- `pendingResumeUploadJob` state tracks the "waiting for user to upload" phase
- visibilitychange + broadcast listeners re-trigger detection on tab refocus

**If the user reports more issues**: the entire flow lives in `extension/content/resume-tailor-prompt.js` (~330 lines). Read it top-to-bottom; it's well-commented.

### Auto-Apply RPA — untested in real-world

**What's implemented**: full content script that fills fields + clicks Next/Submit through a multi-step form.

**What's NOT tested**:
- Real LinkedIn Easy Apply with file upload step (resume attachment)
- Workday's multi-screen flow
- Greenhouse's custom questions
- Captcha pages (will stall)

**What we know works** (because the engine logic is sound):
- Synthetic `mouseover → mousedown → mouseup → click` triggers React/Vue form handlers
- The autofill module already worked on these sites for capture
- The button-text regex covers the common patterns

**Likely first issues a user will hit**:
- File upload fields can't be filled programmatically (browser security)
- Custom questions ("Why do you want this job?") won't get reasonable answers from minimal autofill
- LinkedIn's "Easy Apply" multi-modal flow may exit when it hits an unexpected step

**Plan if it breaks**: instrument the action log in the overlay to surface WHICH step failed and WHY. Each step's `appendLog` already prints to the log panel. User can screenshot it and you can iterate on the field-detection / button-detection logic.

## Hard limitations

- **Cannot move real OS mouse**: Chrome extensions can't issue real cursor events. Auto-Apply uses synthetic DOM events. Sites that check `event.isTrusted` will refuse them (rare).
- **Cannot programmatically attach files to file inputs**: browser security. Auto-Apply will pause when it hits a file input and ask the user to manually pick.
- **Captcha**: cannot solve. Detection will stall.
- **electron-updater on macOS**: requires code signing for `quitAndInstall` to apply silently. Currently unsigned → user gets "open manually" prompt.
- **Some background SW fetches** are blocked by the user's network / firewall. Update checks fall back gracefully (broadcast `extension.update.checked` with `hasUpdate:false`).

## Release process (also in RELEASING.md)

1. Bump versions in `extension/manifest.json` AND `app/package.json` to `9.0.X`
2. Commit: `git add -A && git commit -m "v9.0.X — <description>"`
3. Tag: `git tag v9.0.X && git push origin main v9.0.X`
4. GitHub Actions builds installers on win/mac/linux + attaches to a Release named `v9.0.X`
5. Extension auto-detects within 6h (or instantly if user clicks "Check now")
6. End user clicks "⬇ Download update" → installer downloads → `chrome.downloads.open()` launches it → NSIS upgrades in-place

## Coding conventions

- **ES modules everywhere** in the extension. No bundler. Static `import` between files; chrome SW context supports it.
- **Async message handlers** in `background.js`: return `true` from the listener if you respond async. Otherwise `sendResponse` immediately.
- **Broadcasts** for state changes: `await broadcast('name.updated', {payload})`. The app page listens via `chrome.runtime.onMessage`.
- **Settings** live in `chrome.storage.local` under `jat9.settings` key. Use `getSettings()` / `patchSettings()` from `lib/db.js`.
- **Profile** lives in `chrome.storage.local` under `jat9.profile`. Use `getProfile()` / `patchProfile()`.
- **IndexedDB**: one store per data type. `db.put/get/getAll/delete(storeName, value)`. Most stores have generic CRUD wired in `background.js tryGenericCrud`.

## Naming legacy

- `jat5.*` keys in chrome.storage: from v5, kept stable across migrations.
- `jat5.sqlite3`: filename of the SQLite database in `%APPDATA%\Job Application Tracker\`. Kept stable.
- `jat6Uuid` / `V6_STORES`: internal names from v6. Don't appear to users.
- `JatDb` class: the SQLite wrapper. Name from v5.
- `__jat5_loaded`, `window.jat5.api`: window globals + bridge object. Kept stable for backward compat with content scripts in the wild.

## What I would prioritize next (recommendations)

1. **Real-world test the Auto-Apply** on at least 3 sites. Document which ones work, which don't, and why.
2. **Resume tailor: keep simplifying**. The user's pain has consistently been around UX over-engineering. Every "smart" automation we add has caused at least one bug. Bias toward "user clicks an explicit button" over "we'll figure it out for them".
3. **Code-sign the macOS app** so `electron-updater` works seamlessly there.
4. **Lock the file-upload field problem**: when Auto-Apply encounters `<input type=file>`, pause + open a file picker via `chrome.runtime.sendMessage({type:'pick-file'})`.
5. **Add an "Action history" page** that shows every Auto-Apply run with the log captured. Helps debug when a run goes wrong.
6. **Document the LinkedIn job-context selectors** in `extension/content/adapters/linkedin.js` — LinkedIn changes selectors quarterly and we'll need to update them.

## Communication tips for the user

The user is direct and notices inconsistency immediately. They:
- Hate UI that flashes / redraws unnecessarily
- Hate features that "almost work"
- Want every interaction to feel intentional and explicit
- Get frustrated by surprise tab-opens / dialogs
- Prefer one extra click over one surprise

When in doubt: **never surprise the user**. Add a button. Let them click it.
