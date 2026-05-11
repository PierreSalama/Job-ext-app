# JAT v6 — Desktop App

Electron + better-sqlite3 + zero other native deps. Mirrors the extension's UI verbatim.

## You can stop here

The app works on its own. SQLite-backed storage, native menus, AI calls, all 25+ workspaces. You don't need the Chrome extension.

## To unlock more

Install the [Chrome extension](../extension/README.md) for: real-time capture as you apply on LinkedIn / Indeed / Glassdoor / etc., universal autofill, profile sync from source pages. The app and extension auto-discover each other on `localhost:7733` over WebSocket — install one, install the other, they sync instantly.

```
1. Open chrome://extensions/
2. Toggle Developer mode
3. Load unpacked → select ../extension/
```

## Run

```sh
npm install   # one-time. Pulls Electron + better-sqlite3 (native module).
npm start     # launches the app
```

`npm install` will compile `better-sqlite3` against your Node/Electron ABI on first run. If it picks the wrong ABI, run `npx electron-rebuild -f -w better-sqlite3` once.

The app opens at 1400x900 with a dark titlebar, loads the same SPA as the extension, and starts a sync server on `http://localhost:7733`.

## Architecture

| Layer | Files |
|---|---|
| **Electron entry** | `src/main.js` (BrowserWindow, lifecycle, server boot) |
| **Preload bridge** | `src/preload.js` (`window.jat5.api`, `onEvent`, `openExternal`, `pickFolder`) |
| **Sync server** | `src/server.js` (HTTP + WebSocket on :7733, REST endpoints, `/sync/event`) |
| **Storage** | `src/db.js` (better-sqlite3, mirrors extension's IDB API) |
| **UI** | `src/index.html` + `src/app/{app.html, app.css, app.js}` (copied from extension with chrome.* swapped for `window.jat5.*`) |
| **Library** | `src/lib/*` (themes, icon-presets, schema, markdown, templates — copied verbatim from extension) |

## Sync protocol

Both REST (manual / curl) and WebSocket (real-time):

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Liveness probe (extension polls every 5s) |
| `/api/snapshot` | GET | Full state dump for initial sync |
| `/sync/event` | POST | Apply an inbound mutation (last-write-wins by `updatedAt`) |
| `/ws` | WS | Subscribe to broadcast `{type:'event', name, data}` frames |
| `/jobs`, `/profile`, `/profiles`, `/qa`, `/documents`, `/settings` | GET / POST / PATCH / DELETE | CRUD |
| `/rpc` | POST | Generic dispatcher mirroring `chrome.runtime.sendMessage` shape |

The WebSocket implementation is dependency-free (Node `crypto` for the handshake + manual frame encoding). Loop suppression: each side keeps a 30s hash map of `(name|id|updatedAt)` so echoes don't ping-pong.

## Database

SQLite file lives at:
- Windows: `%APPDATA%\jat6-app\jat6.db`
- macOS: `~/Library/Application Support/jat6-app/jat6.db`
- Linux: `~/.config/jat6-app/jat6.db`

Schema mirrors the extension's IDB stores exactly.

## Build / package

```sh
npm install -D electron-builder
npx electron-builder --win --mac --linux
```

This is not yet wired in `package.json` scripts — add `"build": "electron-builder"` when you're ready to ship.
