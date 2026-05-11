#!/usr/bin/env bash
# Job Application Tracker v5 — Ollama setup helper (Linux)
set -e

echo ""
echo "=============================================================="
echo " Job Application Tracker v5 — Ollama Setup (Linux)"
echo "=============================================================="
echo ""

# 1. Check if Ollama is installed
if ! command -v ollama >/dev/null 2>&1; then
    echo "[ ! ] Ollama is not installed."
    echo ""
    echo "Please install it from:"
    echo "    https://ollama.com/download"
    echo ""
    echo "Quick install (one-liner from ollama.com):"
    echo "    curl -fsSL https://ollama.com/install.sh | sh"
    echo ""
    echo "After installing, re-run this script."
    exit 1
fi

echo "[ OK ] Ollama is installed: $(command -v ollama)"

# 2. Persist OLLAMA_ORIGINS in ~/.bashrc (and ~/.zshrc if present)
add_export() {
    local rc="$1"
    [ -f "$rc" ] || return 0
    if ! grep -q 'OLLAMA_ORIGINS=.*chrome-extension' "$rc"; then
        echo 'export OLLAMA_ORIGINS="chrome-extension://*"' >> "$rc"
        echo "[ OK ] Added export to $rc"
    else
        echo "[ OK ] $rc already contains OLLAMA_ORIGINS export."
    fi
}
add_export "$HOME/.bashrc"
add_export "$HOME/.zshrc"
export OLLAMA_ORIGINS="chrome-extension://*"

# If Ollama is run via systemd, hint at the override
if systemctl --user list-unit-files 2>/dev/null | grep -q '^ollama' \
   || systemctl list-unit-files 2>/dev/null | grep -q '^ollama'; then
    echo ""
    echo "[NOTE] Ollama appears to run as a systemd service. Add this drop-in:"
    echo "    sudo systemctl edit ollama.service"
    echo "    [Service]"
    echo "    Environment=\"OLLAMA_ORIGINS=chrome-extension://*\""
    echo "    sudo systemctl daemon-reload && sudo systemctl restart ollama"
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
echo " IMPORTANT: Restart the Ollama service / app so it picks up"
echo " the new OLLAMA_ORIGINS variable, then open a fresh terminal."
echo ""
echo " Then open the extension's AI Setup Wizard and click Test."
echo ""
