#!/usr/bin/env bash
# Job Application Tracker v9 — Desktop app installer (macOS)
# Checks Node, finds the app folder, runs npm install + start.

set -e
cyan='\033[0;36m'; green='\033[0;32m'; yellow='\033[0;33m'; red='\033[0;31m'; reset='\033[0m'

echo ""
echo "  ┌─────────────────────────────────────────────────────┐"
echo "  │   Job Application Tracker v9 — Desktop installer    │"
echo "  └─────────────────────────────────────────────────────┘"
echo ""

# ---- Step 1: Node.js ----
echo -e "${cyan}→ Checking Node.js…${reset}"
if ! command -v node >/dev/null 2>&1; then
  echo -e "${yellow}  ✗ Node.js not found.${reset}"
  echo "    Install via: brew install node    (or https://nodejs.org/)"
  exit 1
fi
node_ver=$(node -v | sed 's/^v//')
major=${node_ver%%.*}
if [ "$major" -lt 18 ]; then
  echo -e "${yellow}  ✗ Node.js $node_ver is too old. Need 18+.${reset}"
  exit 1
fi
echo -e "${green}  ✓ Node.js v$node_ver${reset}"

# ---- Step 2: Xcode CLT (needed to compile better-sqlite3) ----
echo ""
echo -e "${cyan}→ Checking Xcode Command Line Tools…${reset}"
if ! xcode-select -p >/dev/null 2>&1; then
  echo -e "${yellow}  Installing Command Line Tools — please confirm the system prompt.${reset}"
  xcode-select --install || true
  echo "  After CLT finishes installing, rerun this script."
  exit 1
fi
echo -e "${green}  ✓ Xcode CLT present${reset}"

# ---- Step 3: Find app folder ----
echo ""
echo -e "${cyan}→ Locating v9/app…${reset}"
script_dir="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
candidates=(
  "$script_dir/jat-app-bundle"
  "$(pwd)/jat-app-bundle"
  "$HOME/Downloads/jat-app-bundle"
  "$script_dir/../../app"
  "$script_dir/../../../app"
  "$(pwd)/v9/app"
  "$(pwd)/../app"
  "$(pwd)/app"
  "$HOME/jat9/app"
  "$HOME/Documents/jat9/app"
  "$HOME/Desktop/jat9/app"
  "$HOME/Downloads/jat9/app"
)
app_path=""
for c in "${candidates[@]}"; do
  if [ -f "$c/package.json" ]; then app_path="$(cd "$c" && pwd)"; break; fi
done
if [ -z "$app_path" ]; then
  read -p "  Enter the full path to v9/app: " app_path
  if [ ! -f "$app_path/package.json" ]; then
    echo -e "${red}  ✗ No package.json there. Aborting.${reset}"
    exit 1
  fi
fi
echo -e "${green}  ✓ Found app at $app_path${reset}"

# ---- Step 4: npm install ----
echo ""
echo -e "${cyan}→ Installing dependencies (couple of minutes the first time)…${reset}"
cd "$app_path"
npm install || { echo -e "${red}✗ npm install failed.${reset}"; exit 1; }
echo -e "${green}  ✓ Done${reset}"

# ---- Step 5: Start ----
echo ""
echo -e "${cyan}→ Starting the app…${reset}"
echo -e "  When the window opens, the extension will auto-detect it on localhost:7733."
echo ""
npm start
