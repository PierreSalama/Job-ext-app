#!/usr/bin/env bash
# Job Application Tracker v5 — Ollama setup helper (macOS)
set -e

echo ""
echo "=============================================================="
echo " Job Application Tracker v5 — Ollama Setup (macOS)"
echo "=============================================================="
echo ""

# 1. Check if Ollama is installed
if ! command -v ollama >/dev/null 2>&1; then
    echo "[ ! ] Ollama is not installed."
    echo ""
    echo "Please download and install it from:"
    echo "    https://ollama.com/download"
    echo ""
    echo "After installing, re-run this script."
    exit 1
fi

echo "[ OK ] Ollama is installed: $(command -v ollama)"

# 2. Set OLLAMA_ORIGINS for the launchd-managed Ollama app
if launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"; then
    echo "[ OK ] OLLAMA_ORIGINS set to chrome-extension://* via launchctl."
else
    echo "[FAIL] launchctl setenv failed."
    exit 1
fi

# Persist in shell rc so terminal-launched Ollama also sees it
SHELL_RC="$HOME/.zshrc"
[ -f "$HOME/.bash_profile" ] && SHELL_RC="$HOME/.bash_profile"
if ! grep -q 'OLLAMA_ORIGINS=.*chrome-extension' "$SHELL_RC" 2>/dev/null; then
    echo 'export OLLAMA_ORIGINS="chrome-extension://*"' >> "$SHELL_RC"
    echo "[ OK ] Added export to $SHELL_RC"
fi

# 3. Pull the recommended model
echo ""
echo "[ .. ] Pulling gemma3:4b (this can take a few minutes)..."
if ollama pull gemma3:4b; then
    echo "[ OK ] gemma3:4b downloaded."
else
    echo "[FAIL] Failed to pull gemma3:4b."
    exit 1
fi

echo ""
echo "=============================================================="
echo " Success!"
echo "=============================================================="
echo ""
echo " IMPORTANT: Quit and restart the Ollama app from the menu bar"
echo " so it picks up the new OLLAMA_ORIGINS variable."
echo ""
echo " Then open the extension's AI Setup Wizard and click Test."
echo ""
