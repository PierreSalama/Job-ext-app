#!/usr/bin/env bash
# build-mac.sh
# Builds the macOS .pkg installer via electron-builder and copies it into the
# extension's setup/ folder so the install page can hand it to the user.
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
APP_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
REPO_DIR="$( cd "$APP_DIR/.." && pwd )"
EXT_SETUP="$REPO_DIR/extension/setup"

section() { printf '\n%s\n  %s\n%s\n' "============================================================" "$1" "============================================================"; }

section "Job Application Tracker v9 — macOS installer build"
echo "App dir       : $APP_DIR"
echo "Extension out : $EXT_SETUP"

mkdir -p "$EXT_SETUP"

cd "$APP_DIR"
if [ ! -d node_modules ]; then
  echo "node_modules missing; running npm install first..."
  npm install
fi

section "Step 1/2 — electron-builder --mac pkg"
npx electron-builder --mac pkg

section "Step 2/2 — Copy artifact into extension/setup/"
PKG="$(ls -1t "$APP_DIR"/dist/*.pkg 2>/dev/null | head -n 1 || true)"
if [ -z "$PKG" ]; then
  echo "ERROR: no .pkg found in $APP_DIR/dist after build." >&2
  exit 1
fi

DEST="$EXT_SETUP/JAT-v9.pkg"
cp -f "$PKG" "$DEST"
echo "Copied $PKG"
echo "    -> $DEST"

SIZE=$(du -h "$DEST" | awk '{print $1}')
echo ""
echo "Done. Installer ready at $DEST ($SIZE)."
echo "Reload the extension; the install-app page will offer it as a one-click install."
