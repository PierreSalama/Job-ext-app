# JAT v9 — Releasing

> The full pipeline for shipping a new version. End-user installers come from GitHub Releases via the workflow below.

## TL;DR

```bash
# In v9/
# 1. Bump versions in TWO files:
#    extension/manifest.json → "version": "9.0.X"
#    app/package.json       → "version": "9.0.X"

# 2. Commit + tag
git add -A
git commit -m "v9.0.X — <what changed>"
git tag v9.0.X
git push origin main v9.0.X
```

GitHub Actions takes over from there. ~9 minutes later, a Release exists at:
`https://github.com/PierreSalama/Job-ext-app/releases/tag/v9.0.X`

Containing:
- `JAT-v9-setup.exe` (Windows NSIS installer)
- `JAT-v9.dmg` (macOS disk image)
- `JAT-v9.AppImage` (Linux)
- `latest.yml`, `latest-mac.yml`, `latest-linux.yml` (electron-updater metadata)
- `*.blockmap` files (delta-update support)

## What the workflow does (`.github/workflows/release.yml`)

1. Matrix: `windows-latest` × `macos-latest` × `ubuntu-latest`, parallel
2. On each runner:
   - `actions/checkout@v4`
   - `actions/setup-node@v4` (Node 20)
   - `npm install --no-audit --no-fund` (in `app/`)
   - `npm install sharp --no-save --no-audit --no-fund` + `node build/make-icons.mjs` (rasterizes SVG → multi-res .ico/.icns at sizes 16/32/48/64/128/256/512/1024)
   - `npx electron-builder --publish never` — produces installer + `latest*.yml` + `*.blockmap`
3. `actions/upload-artifact@v4` — packages the per-OS outputs
4. `release` job (only on tag push):
   - `actions/download-artifact@v4` — pulls all three platforms' artifacts
   - Renames per-platform files to predictable names (`JAT-v9-setup.exe`, `JAT-v9.dmg`, `JAT-v9.AppImage`) + copies `latest*.yml` and `*.blockmap`
   - `softprops/action-gh-release@v2` — creates the GitHub Release + attaches files

## Stable URLs

The extension always points at:
```
https://github.com/PierreSalama/Job-ext-app/releases/latest/download/JAT-v9-setup.exe
                                                          /JAT-v9.dmg
                                                          /JAT-v9.AppImage
                                                          /latest.yml
                                                          /latest-mac.yml
                                                          /latest-linux.yml
```

These redirect to whichever release is currently tagged "latest". Pushing a new tag = new release becomes "latest" = every existing extension picks up the new installer automatically. **No extension re-deploy required.**

## How the end-user update happens

1. User has v9.0.X installed
2. You push v9.0.Y
3. ~6h later (or instantly if user clicks "Check now"), background's `silentUpdateCheck()` hits `api.github.com/repos/.../releases/latest`, compares tags, sets `chrome.storage.local.jat9.appUpdateInfo`
4. App page broadcasts → green banner appears at top: "🖥️ Desktop app update available — v9.0.X → v9.0.Y · click to update"
5. User clicks → Settings → Updates card → "⬇ Download update" button
6. Background's `download-and-install-app-update` handler:
   - Detects OS via `chrome.runtime.getPlatformInfo()` → picks `JAT-v9-setup.exe` (Windows) / `.dmg` (Mac) / `.AppImage` (Linux)
   - `chrome.downloads.download(downloadUrl)` returns a download ID
   - Listens for `chrome.downloads.onChanged` → on completion: try `chrome.downloads.open(id)` to auto-launch
7. Page shows "🚀 Launch installer (v9.0.Y)" — clicking it calls `launch-downloaded-installer` which retries `chrome.downloads.open(id)` within a fresh user gesture
8. NSIS (Windows) / drag-to-Applications (Mac) / direct-run (Linux) handles the upgrade in-place

## Code-signing notes

**Windows**: NSIS works unsigned. Users get the standard SmartScreen warning on first run; clicking "More info" → "Run anyway" gets past it. To sign: provide `CSC_LINK` (base64 cert) + `CSC_KEY_PASSWORD` as repo secrets, electron-builder picks them up.

**macOS**: DMG can be opened unsigned (with right-click → Open the first time). But for `quitAndInstall` to silently apply via electron-updater, you NEED notarization. Set up via Apple Developer ID + `APPLE_ID` / `APPLE_ID_PASSWORD` secrets.

**Linux**: AppImage runs unsigned. No signing infrastructure needed.

## What if the build fails?

Common causes:
- **Missing `repository` in package.json**: electron-builder requires it for the publish provider. Don't remove it.
- **Icon path resolution**: `package.json build.win.icon` must point at a real `.ico`. The make-icons.mjs script generates it from `src/icons/icon.svg` via sharp.
- **Native module ABI mismatch**: better-sqlite3 must rebuild for Electron's Node version. The `electron-rebuild` postinstall step handles this. If it fails on a runner, check that `@electron/rebuild` is in devDependencies.

Logs:
- View at https://github.com/PierreSalama/Job-ext-app/actions/runs/{RUN_ID}
- The `failure-logs-<OS>` artifact (auto-uploaded on failure) contains npm debug logs

## Hotfix release (e.g. v9.0.X → v9.0.X.1)

We use single-digit patch versions only (9.0.0, 9.0.1, ...). For an emergency fix:
1. Make the fix on `main`
2. Bump patch: 9.0.X → 9.0.(X+1)
3. Push tag

The user will see the new version within ~6h or instantly via "Check now".

## Deleting / replacing a bad release

If you tag a release and the build is broken or you need to retract:

```bash
# Delete the bad GitHub Release (replace v9.0.X with the bad tag)
TOKEN=$(echo -e 'protocol=https\nhost=github.com\n\n' | git credential fill | grep password | cut -d= -f2)
RELEASE_ID=$(curl -sL -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/PierreSalama/Job-ext-app/releases" \
  | python3 -c "import json,sys; [print(r['id']) for r in json.load(sys.stdin) if r['tag_name']=='v9.0.X']")
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://api.github.com/repos/PierreSalama/Job-ext-app/releases/$RELEASE_ID"

# Delete the bad tag
git tag -d v9.0.X
git push origin :refs/tags/v9.0.X

# Re-tag with the fix
git tag v9.0.X
git push origin v9.0.X
```
