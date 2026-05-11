#!/usr/bin/env bash
# build-linux.sh
# Builds AppImage + .deb via electron-builder and stages both inside the
# extension's setup/ folder so the install page can serve them directly.
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
APP_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
REPO_DIR="$( cd "$APP_DIR/.." && pwd )"
EXT_SETUP="$REPO_DIR/extension/setup"

section() { printf '\n%s\n  %s\n%s\n' "============================================================" "$1" "============================================================"; }

section "Job Application Tracker v8 — Linux installer build"
echo "App dir       : $APP_DIR"
echo "Extension out : $EXT_SETUP"

mkdir -p "$EXT_SETUP"

cd "$APP_DIR"
if [ ! -d node_modules ]; then
  echo "node_modules missing; running npm install first..."
  npm install
fi

section "Step 1/2 — electron-builder --linux AppImage deb"
npx electron-builder --linux AppImage deb

section "Step 2/2 — Copy artifacts into extension/setup/"
APPIMAGE="$(ls -1t "$APP_DIR"/dist/*.AppImage 2>/dev/null | head -n 1 || true)"
DEB="$(ls -1t "$APP_DIR"/dist/*.deb 2>/dev/null | head -n 1 || true)"

if [ -z "$APPIMAGE" ] && [ -z "$DEB" ]; then
  echo "ERROR: no AppImage or .deb found in $APP_DIR/dist after build." >&2
  exit 1
fi

if [ -n "$APPIMAGE" ]; then
  cp -f "$APPIMAGE" "$EXT_SETUP/JAT-v8.AppImage"
  chmod +x "$EXT_SETUP/JAT-v8.AppImage" || true
  echo "Copied $APPIMAGE -> $EXT_SETUP/JAT-v8.AppImage"
fi
if [ -n "$DEB" ]; then
  cp -f "$DEB" "$EXT_SETUP/JAT-v8.deb"
  echo "Copied $DEB -> $EXT_SETUP/JAT-v8.deb"
fi

echo ""
echo "Done. Reload the extension; the install-app page will surface whichever artifact is present."
