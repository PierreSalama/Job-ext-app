# JAT v11 — Job Application Tracker

Ground-up rebuild (2026-06-11) on the v10 architecture with the full production
feature set: reliable capture, token-secured local API, AI layer (Codex CLI
cloud + Ollama local), paced auto-apply engine, Gmail status sync, themed
dashboard, and lockstep auto-updates.

```
v11/
  extension/    Chrome MV3 extension (load this folder unpacked)
  app/          Electron desktop companion (SQLite + REST/SSE on :7744)
  tools/        mirror.mjs (dashboard mirror + CI gate), release.ps1
  tests/        node --test unit tests (pure modules)
  docs/         ARCHITECTURE.md, VALIDATION.md, audit + master plan
  .github/      release workflow (tag v11.x.y → installers on GitHub Releases)
```

## Quick start

1. **Desktop app** (dev): `cd app && npm install && npm start`
2. **Extension**: `chrome://extensions` → Developer mode → Load unpacked →
   select `v11\extension\`. **Disable all older JAT versions.**
3. Click the JAT toolbar icon → **Connect to app** → click **Allow** in the
   app's dialog. Done — captures flow into the app's SQLite ledger.

## The rules of this codebase

- **Dashboard mirror**: the SPA is authored in `extension/app/**` ONLY.
  `npm run mirror` (root) copies it to `app/src/app/**`; CI fails if they
  diverge. Never hand-edit `app/src/app`.
- **Lockstep versions**: `extension/manifest.json` and `app/package.json`
  always carry the same `11.x.y`. `tools/release.ps1` enforces this.
- **Silent mode**: no in-page UI appears before an Apply click (or an explicit
  user action). New surfaces ship behind a `settings.*` flag defaulting off.
- **Status FSM** lives in `extension/lib/status.js` and is mirrored in
  `app/src/db.js` — change both or change neither.
- **AI lives in the app** (`app/src/ai/*`), never in the extension. The
  extension talks to `/ai/*` REST routes through the service worker.

## Releasing

```powershell
.\tools\release.ps1 -Version 11.0.1 -Message "what changed"
```

Bumps both versions, mirrors the dashboard, syncs into `..\.v10-publish`,
commits, tags `v11.0.1`, pushes → CI builds `JAT-v11-setup.exe` (+ mac/linux
best-effort) and publishes the GitHub Release. The installed app self-updates
via electron-updater; the extension popup offers the installer download and
flags its own updates with a badge.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — ports, message types, REST
  contract, AI chain, auto-apply queue states.
- [docs/VALIDATION.md](docs/VALIDATION.md) — Pierre's per-site manual test
  script for capture + auto-apply.
- [docs/AUDIT-2026-06-11.md](docs/AUDIT-2026-06-11.md) +
  [docs/MASTER-PLAN.md](docs/MASTER-PLAN.md) — why v11 exists and what it fixes.

## Previous versions

`v1/`–`v10/` sit beside this folder, inactive. v11 is the active line. If a bug
is reported, verify the loaded extension's version in `chrome://extensions`
before editing anything.
