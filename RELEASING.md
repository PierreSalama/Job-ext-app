# Releasing JAT v9 — one-click installers for end users

The Chrome extension is small (~1 MB), but the desktop installer is ~100 MB. We **don't** bundle the installer inside the extension. Instead, the extension downloads it from a GitHub Release on demand. End users click one button → installer downloads → they double-click. No Node.js, no source code, no terminal.

## One-time setup

1. **Push this repo to GitHub** (private or public — doesn't matter).
2. **Tag a release**:
   ```bash
   git tag v9.0.0
   git push origin v9.0.0
   ```
3. GitHub Actions (`.github/workflows/release.yml`) automatically:
   - Spins up Windows + macOS + Linux runners
   - `npm install`s the desktop app dependencies on each OS
   - Runs `electron-builder` to produce native installers
   - Renames artifacts to predictable filenames (`JAT-v9-setup.exe`, `JAT-v9.dmg`, `JAT-v9.AppImage`)
   - Attaches them to a Release named after your tag
4. **Set the releases URL** in the extension. Either:
   - Edit `extension/lib/db.js` and change `releasesBaseUrl` in `DEFAULT_SETTINGS`, or
   - Open the extension app, go to Settings → Advanced, paste the URL.

   The URL pattern is:
   ```
   https://github.com/PierreSalama/Job-ext-app/releases/latest/download
   ```
   (no trailing slash, no specific filename — the extension appends it per OS)

## What the end user does

1. Installs the Chrome extension.
2. Opens the extension and clicks "Install desktop app".
3. Clicks "⚡ Install with one click".
4. The page detects their OS, fetches the matching artifact from your latest GitHub Release, downloads it to `Downloads/`.
5. User double-clicks the installer. Wizard runs. App launches.

**No Node.js required. No source code required. No terminal required.**

## Cutting a new release later

```bash
# Bump version in app/package.json and extension/manifest.json
git tag v9.0.0
git push origin v9.0.0
```

Actions rebuilds installers for all 3 OSes and attaches them to `Releases/latest`. The extension always points at `/releases/latest/download/<file>` so existing installs of the extension auto-pick up the new installer with no extension update needed.

## Building locally (optional / debug)

```bash
cd app
npm install
npm run build:win    # or build:mac / build:linux
# Output ends up in app/dist/
```

This requires Node 18+ and platform-specific build tools (VS Build Tools on Windows, Xcode on macOS). The GitHub Actions workflow handles this for you on clean runners — running locally is only useful when iterating on the installer.

## Why GitHub Releases and not bundle inside the extension?

- **Size.** A signed Windows installer is 80–150 MB. Chrome Web Store imposes a 200 MB hard cap, plus practical limits for upload + first-use download. Multiply by 3 OSes and you're at half a gigabyte of extension.
- **Cross-platform.** You can't produce a `.dmg` from Windows or a `.exe` from macOS. GitHub Actions runs all three OSes in parallel for free.
- **Updates.** Pushing a new installer = push a git tag. Pushing a new bundled extension = re-uploading to Chrome Web Store and waiting for review.
