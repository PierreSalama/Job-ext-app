# JAT v6 — Chrome Extension

Manifest V3, vanilla JS, no build step. Load unpacked from `chrome://extensions/`.

## You can stop here

The extension works on its own. Capture, AI, autofill, all 25+ workspaces, themes, audit log, backups — everything works without the desktop app.

## To unlock more

Install the [companion desktop app](../app/README.md) for: durable SQLite storage (survives Chrome cache wipes), uninterruptible AI calls (no MV3 service-worker idle timeout), background folder watching for resumes, and headless source profile sync. The extension auto-detects it on `localhost:7733` — when it's running you'll see a green **Connected** pill in the sidebar.

```sh
cd ../app && npm install && npm start
```

## Architecture

| Layer | Files |
|---|---|
| **Manifest** | `manifest.json` |
| **Background SW** | `background.js` (message router, AI dispatch, audit, sync client, alarms) |
| **Content scripts** | `content/loader.js` → `content/universal.js` (orchestrator) → `content/adapters/*.js` (per-site) |
| **Autofill** | `content/autofill.js` (multilingual label matcher + harvester) |
| **Profile scraper** | `content/profile-scraper.js` (LinkedIn / Indeed / Glassdoor /in/me) |
| **App SPA** | `app/app.html`, `app/app.css`, `app/app.js` + `app/pages/*.js` (one module per page) |
| **Popup** | `popup/popup.html`, `popup/popup.js` (mini-app version of dashboard) |
| **Library** | `lib/db.js` (IDB), `lib/ai.js` (AI providers), `lib/themes.js`, `lib/icon-presets.js`, `lib/pages.js` (page registry), `lib/tour.js` (interactive walkthrough engine), `lib/sync-client.js` (WS bridge to desktop) |
| **Setup helpers** | `setup/install-ollama-{windows,mac,linux}.{ps1,sh}` |
| **CORS rules** | `rules/ollama-cors.json` (declarativeNetRequest static rules) |
| **Tests** | `test/runner.mjs` (132 tests, pure Node) |

## Adding a new ATS adapter

1. Create `content/adapters/<name>.js` exporting `{ id, name, matches, getContext, isApplyDialogOpen, isSubmissionConfirmed, isSubmitClick, isApplyClick, getExternalId }`. See `content/adapters/linkedin.js` for the reference implementation.
2. Import + add to the `ADAPTERS` array in `content/universal.js`.
3. Add the host pattern to `host_permissions` and `content_scripts.matches` in `manifest.json`.
4. Add a test in `test/runner.mjs` exercising the URL match.

## Adding a new sidebar page

1. Add an entry to `lib/pages.js` `PAGES` array.
2. Create `app/pages/<id>.js` exporting `{ render(state), attach($main, ctx) }` where `ctx = { send, toast, render, state, aiCall, reload }`.
3. Register it in the `PAGE_RENDERERS` map at the top of `app/app.js`.
4. (Optional) Add tour steps in `lib/tour-steps.js`.

## Run tests

```sh
node test/runner.mjs
```

132 tests cover: schema validators, salary extraction, JSON-LD parsing, applied-date parsing, markdown rendering, email templates, AI response parsing, multi-site adapter routing, externalId extraction, multilingual question normalization, multilingual autofill mapping, manifest sanity, Ollama CORS rules, themes, icon presets, sidebar customization, profile-hint coverage, step-advance click detection.
