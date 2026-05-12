#!/usr/bin/env bash
# Clean-uninstall Job Application Tracker - Linux (AppImage variant)
# Run: bash clean-uninstall-jat-linux.sh
set -u
red='\033[31m'; green='\033[32m'; yellow='\033[33m'; cyan='\033[36m'; reset='\033[0m'
say() { echo -e "${cyan}[STEP] $1${reset}"; }
ok()  { echo -e "  ${green}OK${reset}   $1"; }
warn(){ echo -e "  ${yellow}WARN${reset} $1"; }

echo
echo '======================================================'
echo '  Job Application Tracker - Clean Uninstall (Linux)'
echo '======================================================'
echo
read -p 'Wipe app + all settings/database? (y/N) ' confirm
[[ ! $confirm =~ ^[yY]$ ]] && { echo Aborted.; exit 0; }

say 'Stopping running processes...'
pkill -f 'JAT-v8\|jat8-app\|Job Application Tracker' 2>/dev/null && ok 'killed' || warn 'none running'

say 'Removing AppImage(s)...'
for p in "$HOME/Applications/JAT-v8.AppImage" "$HOME/Downloads/JAT-v8.AppImage" "/opt/JAT-v8.AppImage"; do
  [ -f "$p" ] && rm -f "$p" && ok "deleted $p"
done

say 'Wiping userData...'
for d in "$HOME/.config/Job Application Tracker" "$HOME/.config/jat8-app" "$HOME/.cache/Job Application Tracker"; do
  [ -e "$d" ] && rm -rf "$d" && ok "deleted $d"
done

say 'Removing desktop shortcut...'
for f in "$HOME/.local/share/applications/jat8-app.desktop" "$HOME/.local/share/applications/job-application-tracker.desktop"; do
  [ -f "$f" ] && rm -f "$f" && ok "deleted $f"
done

say 'Freeing port 7733...'
pid=$(lsof -ti:7733 2>/dev/null || true)
if [ -n "$pid" ]; then kill -9 $pid 2>/dev/null && ok "killed PID $pid"; else ok 'port already free'; fi

echo
echo -e "${green}Clean uninstall complete.${reset}"
echo 'Re-install via the Chrome extension -> Install desktop app.'
