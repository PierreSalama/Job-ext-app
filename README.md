# Job Application Tracker v8

Chrome extension + Electron desktop app that captures every job application across LinkedIn, Indeed, Glassdoor, Greenhouse, Lever, Workday, Ashby, Workable, BambooHR, and SmartRecruiters — with AI-augmented analysis, a unified pipeline, and real-time desktop sync.

## For end users

1. Install the extension from `extension/` (Load unpacked in `chrome://extensions`).
2. Open the extension, click **Install desktop app**.
3. Click **⚡ Install with one click**. The native installer for your OS downloads automatically.
4. Double-click to install. The app launches and the extension auto-pairs.

No Node.js. No source code. No terminal.

## For developers

This repo is set up to release cross-platform installers via GitHub Actions.

### Cutting a release

```bash
git tag v8.0.X
git push origin v8.0.X
```

GitHub Actions (`.github/workflows/release.yml`) automatically:

- Spins up Windows, macOS, and Linux runners in parallel
- Builds the Electron desktop app on each platform (`npm run build`)
- Renames artifacts to `JAT-v8-setup.exe`, `JAT-v8.dmg`, `JAT-v8.AppImage`
- Attaches them to a GitHub Release named after the tag

The extension always fetches from `releases/latest/download/<file>`, so new tags instantly update the installer for every existing extension install — no extension re-deploy needed.

See `RELEASING.md` for the full pipeline + rationale.

### Local development

```bash
# Extension — load extension/ as unpacked in chrome://extensions
# Desktop app
cd app
npm install
npm start
```

### Tests

```bash
cd extension
node test/runner.mjs
```

161 tests cover schema, sanitization, themes, sidebar logic, page registry, and audit chain integrity.

## Architecture

- `extension/` — Chrome MV3 extension. 48 page modules under `app/pages/`, IndexedDB v4, AI provider abstraction (`lib/ai.js`) supporting Ollama, OpenAI, and Chrome built-in AI.
- `app/` — Electron desktop companion. SQLite via `better-sqlite3`, WebSocket sync server on `localhost:7733`, system tray, global hotkey `Ctrl+Shift+J`.
- `.github/workflows/release.yml` — automated cross-platform installer builds.

## License

MIT — see `LICENSE.txt`.
