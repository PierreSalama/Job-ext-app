# Debugging JAT v9

How to find out what went wrong when something misbehaves.

## Extension side (Chrome)

### Background service worker logs
1. `chrome://extensions` → find Job Application Tracker → "service worker" link
2. DevTools opens for the SW. Console shows every `console.log` from `background.js`
3. Look for messages prefixed `[v9]`, `[jat:capture]`, `[jat:autofill]`, `[jat:sync]`

### App page logs (the chrome-extension://.../app/app.html SPA)
1. Open the extension UI (click toolbar icon → "Open dashboard")
2. F12 / Right-click → Inspect
3. Console + Network + Application tabs

### Content script logs (on a job page)
1. Open DevTools on the job page itself (F12)
2. Filter Console by `[jat`
3. Look for `[jat-tailor]`, `[JAT:loader]`, adapter-specific logs

### IndexedDB inspection
DevTools → Application → IndexedDB → `jat9` (NOT jat5/jat6 — those are legacy from migrations)
Stores include: `jobs`, `documents`, `messages`, `contacts`, `tags`, `fitScores`, `tailoredResumes`, etc.

### chrome.storage.local inspection
Settings + profile + audit keys live here.
```js
// In SW console:
chrome.storage.local.get(null).then(console.log)
// To clear (DANGEROUS — wipes settings + profile):
chrome.storage.local.clear()
```

## Desktop app side (Electron)

### Main-process logs
1. Quit the app
2. Launch from terminal: `cd app/dist/win-unpacked && Job\ Application\ Tracker.exe` (Windows)
3. Console output prints to stdout. Look for `[v9]` and `[jat9]` prefixes

### Renderer logs
1. Open the app
2. View → Toggle Developer Tools (if menu enabled) OR use the keyboard shortcut Ctrl+Shift+I
3. Same console as Chrome DevTools

### SQLite inspection
- Path: `%APPDATA%\Job Application Tracker\jat5.sqlite3` (Windows) — yes still named jat5, kept stable across versions
- Open with any SQLite browser (DB Browser for SQLite is good)
- Tables: `jobs`, `documents`, etc. — schema mirrors IndexedDB

### Sync server endpoints (for poking at runtime)

```
curl http://localhost:7733/health          # version + ws indicator
curl http://localhost:7733/version          # just the version
curl http://localhost:7733/api/snapshot     # full DB snapshot JSON
curl -X POST http://localhost:7733/app-update/check
curl http://localhost:7733/app-update/status
```

## Specific bug recipes

### "The tailor card doesn't appear"
1. Open job page DevTools console
2. Look for `[jat-tailor] busy, skip` / `not confident, skip` / `finalized, skip`
3. If `not confident, skip`: the page doesn't pass `confident(ctx)`. Check:
   - Does the page have "Apply" / "Easy Apply" text visible?
   - Does the URL match `/jobs/view`, `/job/`, `/viewjob`, `/listing/`?
   - Run `await window.__jat_get_context()` in console — what does it return?
4. If `finalized, skip`: you've already dismissed this job in this session. Reload the page.

### "Double dashboard tab opens"
Should be impossible in v9.0.3+ due to the 30s `safeOpenApp` cooldown. If it still happens:
1. Check SW console for `[jat-tailor] open-app suppressed (cooldown)` lines
2. If the cooldown isn't firing, the content script may be loaded twice (e.g. two tabs of the same job). Each tab has its own cooldown timestamp.

### "Auto-apply doesn't do anything when I click the button"
1. Make sure the page is one of the supported hosts (manifest.json content_scripts.matches). If not, the content script isn't injected → no listener for `start-auto-apply`.
2. SW console should log nothing unusual. Page console should show the overlay being injected.
3. If overlay appears but doesn't advance: the page's form fields may not match any profile keys → `Filled 0 fields`. Update the profile in the app's Profile page.
4. If overlay shows "No advance button found": the page's submit button text doesn't match any of the 12 regex patterns. Find the button text and add a pattern to `SUBMIT_KEYWORDS` in `content/auto-apply.js`.

### "Extension is on v9.0.X but the desktop app still says v9.0.(X-1)"
The app didn't auto-update. Either:
- Network blocked the GitHub release fetch
- Old v8.x app — no electron-updater bundled

Workaround: in extension → Settings → Updates → "Download update" button on the Desktop app row. Or use the Reinstall button on the Install desktop app page.

### "Sidebar still shows all pages despite the 6-page minimum"
Settings → 🧭 Sidebar → "Reset sidebar to defaults" button.
Or in SW console:
```js
chrome.storage.local.set({ 'jat9.settings': { sidebarDefaultsVersion: 0 }})
// Then reload the extension — migration fires on boot
```

### "I uploaded a resume but the tailor still says I don't have one"
1. Open Documents page → confirm the resume row is type "resume" (not "other")
2. In SW console: `chrome.runtime.sendMessage({type:'get-default-resume'}).then(console.log)`
3. If that returns `{ok:true, document:null}`: no default. Fix in SW console: `chrome.runtime.sendMessage({type:'set-default-resume', data:{id:'<id-from-documents>'}})`. Or delete + re-upload (background auto-defaults the first resume).

### "Toast / banner / page is flickering"
v9.0.3 fixed the most common cause (animation firing on every render). If it still happens:
1. Open DevTools Performance tab
2. Record while the flicker happens
3. Look for many short JS tasks back-to-back — likely a broadcast handler trip-firing
4. Filter SW console for `[v9]` and look for repeated broadcasts of the same name

## Reproducing the v9.0.0 → v9.0.X update flow locally

```bash
# 1. Bump versions
# extension/manifest.json: "version": "9.0.X"
# app/package.json: "version": "9.0.X"

# 2. Commit + push tag
git add -A
git commit -m "v9.0.X — <what changed>"
git tag v9.0.X
git push origin main v9.0.X

# 3. Wait ~9 min for GitHub Actions to build installers + attach to a Release.

# 4. To test the update flow:
#    - Have v9.0.(X-1) installed
#    - Open extension dashboard
#    - Settings → Updates card → Desktop app row should say "Update available v9.0.(X-1) → v9.0.X"
#    - Click "⬇ Download update" → wait for "🚀 Launch installer" button → click → NSIS wizard
```
