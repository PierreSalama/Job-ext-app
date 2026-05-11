#!/usr/bin/env bash
# Job Application Tracker v8 — Desktop app installer (Linux)
set -e
cyan='\033[0;36m'; green='\033[0;32m'; yellow='\033[0;33m'; red='\033[0;31m'; reset='\033[0m'

echo ""
echo "  ┌─────────────────────────────────────────────────────┐"
echo "  │   Job Application Tracker v8 — Desktop installer    │"
echo "  └─────────────────────────────────────────────────────┘"
echo ""

# Node.js
echo -e "${cyan}→ Checking Node.js…${reset}"
if ! command -v node >/dev/null 2>&1; then
  echo -e "${yellow}  ✗ Node.js not found.${reset}"
  echo "    Debian/Ubuntu:  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
  echo "    Fedora:         sudo dnf install nodejs"
  echo "    Arch:           sudo pacman -S nodejs npm"
  exit 1
fi
node_ver=$(node -v | sed 's/^v//')
major=${node_ver%%.*}
if [ "$major" -lt 18 ]; then echo -e "${yellow}  ✗ Node.js $node_ver too old. Need 18+.${reset}"; exit 1; fi
echo -e "${green}  ✓ Node.js v$node_ver${reset}"

# Build essentials
echo ""
echo -e "${cyan}→ Checking C++ build toolchain…${reset}"
if ! command -v g++ >/dev/null 2>&1 && ! command -v c++ >/dev/null 2>&1; then
  echo -e "${yellow}  ✗ C++ compiler missing — needed for better-sqlite3.${reset}"
  echo "    Debian/Ubuntu:  sudo apt install build-essential python3"
  echo "    Fedora:         sudo dnf groupinstall \"Development Tools\""
  echo "    Arch:           sudo pacman -S base-devel"
  exit 1
fi
echo -e "${green}  ✓ Build tools present${reset}"

# Locate app
echo ""
echo -e "${cyan}→ Locating v8/app…${reset}"
script_dir="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
candidates=(
  "$script_dir/jat-app-bundle"
  "$(pwd)/jat-app-bundle"
  "$HOME/Downloads/jat-app-bundle"
  "$script_dir/../../app"
  "$script_dir/../../../app"
  "$(pwd)/v8/app"
  "$(pwd)/../app"
  "$(pwd)/app"
  "$HOME/jat8/app"
  "$HOME/Downloads/jat8/app"
)
app_path=""
for c in "${candidates[@]}"; do
  if [ -f "$c/package.json" ]; then app_path="$(cd "$c" && pwd)"; break; fi
done
if [ -z "$app_path" ]; then
  read -p "  Enter the full path to v8/app: " app_path
  if [ ! -f "$app_path/package.json" ]; then echo -e "${red}  ✗ Aborting.${reset}"; exit 1; fi
fi
echo -e "${green}  ✓ $app_path${reset}"

cd "$app_path"
echo ""
echo -e "${cyan}→ npm install…${reset}"
npm install
echo -e "${green}  ✓ Done${reset}"

echo ""
echo -e "${cyan}→ Starting the app…${reset}"
npm start
