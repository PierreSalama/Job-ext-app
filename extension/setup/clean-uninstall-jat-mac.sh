#!/usr/bin/env bash
# Clean-uninstall Job Application Tracker - macOS
# Run: bash clean-uninstall-jat-mac.sh
set -u
red='\033[31m'; green='\033[32m'; yellow='\033[33m'; cyan='\033[36m'; reset='\033[0m'
say() { echo -e "${cyan}[STEP] $1${reset}"; }
ok()  { echo -e "  ${green}OK${reset}   $1"; }
warn(){ echo -e "  ${yellow}WARN${reset} $1"; }

echo
echo '======================================================'
echo '  Job Application Tracker - Clean Uninstall (macOS)'
echo '======================================================'
echo
read -p 'Wipe app + all settings/database? (y/N) ' confirm
[[ ! $confirm =~ ^[yY]$ ]] && { echo Aborted.; exit 0; }

say 'Stopping running processes...'
pkill -f 'Job Application Tracker' 2>/dev/null && ok 'killed running app' || warn 'none running'

say 'Removing app bundle...'
for p in '/Applications/Job Application Tracker.app' "$HOME/Applications/Job Application Tracker.app"; do
  if [ -d "$p" ]; then rm -rf "$p" && ok "deleted $p" || warn "could not delete $p"; fi
done

say 'Wiping userData...'
for d in "$HOME/Library/Application Support/Job Application Tracker" "$HOME/Library/Application Support/jat9-app" "$HOME/Library/Preferences/com.pierre.jat9.plist" "$HOME/Library/Caches/com.pierre.jat9"; do
  [ -e "$d" ] && rm -rf "$d" && ok "deleted $d"
done

say 'Freeing port 7733...'
pid=$(lsof -ti:7733 2>/dev/null || true)
if [ -n "$pid" ]; then kill -9 $pid 2>/dev/null && ok "killed PID $pid"; else ok 'port already free'; fi

echo
echo -e "${green}Clean uninstall complete.${reset}"
echo 'Re-install via the Chrome extension -> Install desktop app.'
