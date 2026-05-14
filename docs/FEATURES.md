# JAT v9 — Feature catalog

Every feature, where it lives, how it works end-to-end. Reference this when adding or changing functionality.

## Core: capture-as-you-apply

**What it does**: Browse jobs on supported sites; every Apply click captures the job to JAT automatically.

**Supported sites** (in `manifest.json content_scripts.matches`):
- linkedin.com, indeed.com, glassdoor.com (.com/.ca/.co.uk)
- greenhouse.io, jobs.lever.co, *.myworkdayjobs.com
- *.ashbyhq.com, apply.workable.com, *.bamboohr.com, jobs.smartrecruiters.com

**Pipeline**:
1. `content/loader.js` injects → loads `universal.js` → picks adapter by hostname
2. Adapter watches DOM mutations + click events
3. Click on a submit-like button → `fire('submit_click', ctx, {applied:true})`
4. Background `capture` handler → `upsertJob()` → IndexedDB → broadcasts

**Status**: Stable since v6. The detection has been tuned over many releases.

## Resume Tailor on Apply (v9.0.1+)

**What it does**: When viewing a job posting, a glass-morphism card pops up in the bottom-right asking if you want JAT to AI-tailor your resume to match the job description.

**Files**:
- `content/resume-tailor-prompt.js` — the popup logic + UI
- `background.js` cases: `tailor-resume-for-job`, `get-default-resume`, `set-default-resume`, `download-tailored-resume`, `synthesizeResumeFromProfile`

**State** (per-tab, in-memory):
- `STATE.finalized: Set<jobKey>` — jobs the user has answered for this session
- `STATE.pendingResumeUploadJob: jobKey | null` — set when user clicked "Yes" but had no resume
- `STATE.busy: boolean` — single-flight lock
- `STATE.lastOpenApp: number` — timestamp; rate-limits open-app to once per 30s
- `STATE.lastPromptedJobKey` — for "don't re-prompt same job"

**Detection** (when does the card appear?):
1. `confident(ctx)` must return true:
   - Both `title` and `company` exist, title ≥ 3 chars
   - Title isn't generic ("Jobs", "Home", "Feed", "Profile")
   - Company isn't a job-board name ("LinkedIn", "Indeed", etc.)
   - Either the URL matches `/jobs/view`, `/job/`, `/viewjob`, `/listing/`, OR the page has Apply / Easy Apply / Submit text on a button
2. `STATE.finalized.has(key)` must be false (user hasn't already answered)
3. `STATE.busy` must be false
4. `autoTailorEnabled !== 'never'` (settings)

**Triggers** (when does detection run?):
- Boot of `universal.js`: at 2.2s and again at 5.5s after page load
- `history.pushState` / `replaceState` / `popstate` / `hashchange`: debounced 1.5s
- `document.visibilitychange` (tab refocus): only if `pendingResumeUploadJob` is set
- `chrome.runtime.onMessage` for `documents.updated` / `settings.updated`: only if pending

**No URL polling**: removed in v9.0.3 — it caused cascading re-detection.

**v9.0.4 important change**: When user clicks "Tailor it now" with no resume, we **no longer auto-open the dashboard**. We show an explicit `[📁 Open Documents page]` button instead. User clicks → opens (rate-limited to once per 30s) → uploads → returns → flow continues via visibilitychange.

**AI flow**:
1. Background `tailor-resume-for-job`:
   - Loads default resume from documents (or first resume if no default)
   - Tries to decode as text; falls back to `synthesizeResumeFromProfile()` if binary (PDF/DOCX)
   - Calls `ai.aiPrompt(prompt, settings)` with the rewrite prompt
   - Stores result in `tailoredResumes` IDB store
2. `download-tailored-resume` → creates Blob URL → `chrome.downloads.download` → user saves as `.txt`

**Settings**:
- `autoTailorEnabled: 'ask' | 'always' | 'never'` (default: `'ask'`)
- `defaultResumeId: string` — document id

**Auto-default behavior**: Background's `add-document` handler auto-sets the first uploaded resume as `defaultResumeId` if none is set. The user doesn't need to manually mark anything.

## Auto-Apply RPA (v9.0.1+)

**What it does**: Click the green "🤖 Auto-apply this job" button in the popup → an overlay appears on the job page showing the bot filling fields + clicking Next/Submit through the entire application.

**Files**:
- `content/auto-apply.js` — the RPA engine + overlay UI
- `background.js` cases: `start-auto-apply-current-tab`, `stop-auto-apply-current-tab`
- `popup/popup.html` + `popup/popup.js` — toolbar trigger

**Engine state** (per-tab, in-memory):
```js
STATE = { running, cancelled, paused, step, log, stopReason, overlayEl }
```

**Per-step pipeline** (max 20 steps):
1. Call `autofill.autofillAll(profile, {source: 'auto-apply'})` — or `minimalFill(profile)` fallback if module not loaded
2. `findAdvanceButton()` — scans every `button`, `input[type=submit]`, `a[role=button]`, `[role=button]` for text matching one of 12 regex patterns (Submit, Submit Application, Next, Continue, Continue to, Save and Continue, Apply Now, Apply, Send Application, Finish, Review, Review Your Application)
3. Dispatch synthetic `mouseover` → `mousedown` → `mouseup` → `click` (in order — max compatibility with React/Vue form libs)
4. Wait up to 8s for `domHash()` to change (page contents + URL + control count signature)
5. Scan DOM for confirmation text (`application submitted`, `thank you for applying`, etc.) → stop with success

**User controls**:
- Pause/Resume button on the overlay
- Stop button → graceful exit (broadcasts `stop-auto-apply`)
- Esc key → same as Stop
- Hard cap at 20 steps

**Settings**:
- `autoApplyEnabled: false` (default; future use as a feature flag)
- `autoApplyMaxSteps: 20`

**Honest limitations**:
- Can't move the real OS mouse — synthetic events only.
- A small handful of sites check for `isTrusted` event tokens; Auto-Apply will detect inability to advance and ask user to take over.
- Captcha pages: cannot solve. Detection will stall until user solves it manually.

## Updates: extension + desktop app

**v9 design philosophy**: Updates download directly from GitHub Releases via `chrome.downloads.download` and the user launches the installer. We DO NOT rely on electron-updater's network stack inside a possibly-broken app — the chrome.downloads path always works.

**Flow** (`background.js` case `download-and-install-app-update`):
1. Read `settings.releasesBaseUrl` (default: `https://github.com/PierreSalama/Job-ext-app/releases/latest/download`)
2. Detect OS via `chrome.runtime.getPlatformInfo()` → pick `JAT-v9-setup.exe` / `JAT-v9.dmg` / `JAT-v9.AppImage`
3. Optionally POST to `localhost:7733/app-update/install` to quit the running app first (if `data.quitFirst`)
4. `chrome.downloads.download(installerUrl)` returns a download ID
5. Listen for `chrome.downloads.onChanged` → on `state.current === 'complete'`:
   - Try `chrome.downloads.open(id)` to auto-launch (works on most Chrome versions)
   - Broadcast `app.installer.ready` so the page can show a "Launch installer" button
6. User clicks "🚀 Launch installer" within fresh user gesture → `chrome.downloads.open(id)` again, guaranteed
7. NSIS handles the upgrade in-place

**Settings page UI** (`extension/app/app.js` pageSettings):
- Two rows: 🧩 Extension, 🖥️ Desktop app
- Each shows: version, "Update available v9.0.X → v9.0.Y", last-checked timestamp, Check now button
- When update available: "⬇ Download update" → "⏬ Downloading…" → "🚀 Launch installer"
- "📋 What's new in v9.0.X" collapsible details with markdown from GitHub release body

**Patch notes**: fetched live from `api.github.com/repos/.../releases/latest` via background's `get-release-notes` handler.

## Sidebar (strict-minimal default)

**6 pages visible by default**: Dashboard, Applications, Profile, Documents, Install desktop app, Settings.

**~40 other pages**: hidden by default, one click to re-add via the sidebar's "+ Add a page" button.

**Migration** (`background.js migrateSidebarDefaults`):
- Stored marker `sidebarDefaultsVersion` (default: 5 in v9)
- On every SW boot + onInstalled, if stored < 5, force-overwrite `sidebarHidden`, clear `sidebarOrder` and `sidebarPinned`
- Broadcasts `sidebar.reset` so open pages re-render immediately

**Manual reset**: Settings → 🧭 Sidebar → "Reset sidebar to defaults" button.

## v9 design system

`extension/app/v9.css` (~430 lines) overrides every visual aspect of the v8 stylesheet. Loaded AFTER `app.css` so it wins.

**Tokens**:
- Radii: 6/8/12/16/pill
- Shadows: sm/md/lg/glow
- Easings: `--v9-ease-out`, `--v9-ease-in-out`, `--v9-spring` (Apple HIG + Material Expressive curves)
- Spacing: 4/8/12/16/24/32/48/64
- Inter font with `cv02`/`cv03`/`cv04`/`cv11` OpenType features

**Animations**:
- Page entry: 340ms `ease-out` slide+fade (only fires on real route change, not data updates)
- Sidebar nav link hover: slides 2px right
- Buttons: hover-lift, press-scale, radial ripple
- Toasts: spring entry from right, fade exit
- Banners: spring slide-in from top
- Tip bubble: scale-spring pop-in
- All respects `prefers-reduced-motion`
