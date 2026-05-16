# JAT v10 — Desktop companion (skeleton)

The smallest possible Electron app: one window + one HTTP route. Pairs with the v10 Chrome extension so you can verify end-to-end connectivity before any real feature is layered on.

## What it does

- Opens a 520×360 Electron window showing connection status
- Starts a Node `http` server on **`http://localhost:7744`**
- Serves a single endpoint: `GET /health` → `{ ok, version, ts }` (with permissive CORS so the extension SW can fetch it)

That's it. No tray. No database. No global hotkey. No sync. No native notifications. No auto-update.

## How to run

```bash
cd F:\GITHUB\Perosnal\extensions\job-application-tracker\v10\app
npm install
npm start
```

You should see:

- An Electron window titled "JAT v10 — Desktop" with two green status rows
- Console log: `[JAT v10 app] HTTP server listening on http://localhost:7744`

Hit `http://localhost:7744/health` from any browser to confirm: `{"ok":true,"version":"10.0.0","ts":...}`.

## How to verify the extension sees it

1. Load the v10 extension (see `../README.md`).
2. With the desktop app running, click the extension toolbar icon.
3. The "Desktop app" row should show **connected · v10.0.0** in green.
4. Quit the app — the row should flip to **offline**.

## Port

Hardcoded to **7744**. v9 used 7733 — picking a different port lets v9 and v10 coexist during the transition.

## Packaging

`npm run build:win` / `build:mac` / `build:linux` produce installers via `electron-builder`. Configured to publish to the existing `PierreSalama/Job-ext-app` GitHub Releases repo, same as v9. **No actual release artifacts exist yet** — the `⬇ Download desktop app` button in the extension popup just opens the releases page; users will see v9 builds there until v10 is tagged and shipped.
