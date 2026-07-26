# ============================================================================
#  Removes everything Setup-Remote.ps1 installed. Run as administrator.
#    - the "JAT Watchdog" scheduled task
#    - the C:\ProgramData\JAT-Remote folder (token, logs, scripts)
#    - the firewall rule
#    - disconnects this machine from Pierre's tailnet, and (optionally)
#      uninstalls Tailscale entirely.
#  Leaves the JAT app itself alone.
# ============================================================================
param([switch]$KeepTailscale)

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" $(if($KeepTailscale){'-KeepTailscale'})"; exit }

Write-Host 'Removing JAT remote access...' -ForegroundColor Cyan

try { Unregister-ScheduledTask -TaskName 'JAT Watchdog' -Confirm:$false -ErrorAction Stop; Write-Host '  removed watchdog task' -ForegroundColor Green } catch { Write-Host '  no watchdog task' -ForegroundColor Gray }
try { netsh advfirewall firewall delete rule name='JAT v11 LAN' 2>&1 | Out-Null; Write-Host '  removed firewall rule' -ForegroundColor Green } catch {}

$tsExe = Join-Path ${env:ProgramFiles} 'Tailscale\tailscale.exe'
if (Test-Path $tsExe) {
  try { & $tsExe logout 2>&1 | Out-Null; & $tsExe down 2>&1 | Out-Null; Write-Host '  disconnected from tailnet' -ForegroundColor Green } catch {}
  if (-not $KeepTailscale) {
    try {
      $u = Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Tailscale*' } | Select-Object -First 1
      if ($u -and $u.UninstallString) { Start-Process cmd.exe -ArgumentList "/c $($u.UninstallString) /quiet" -Wait; Write-Host '  uninstalled Tailscale' -ForegroundColor Green }
    } catch { Write-Host "  could not auto-uninstall Tailscale: $($_.Exception.Message)" -ForegroundColor Yellow }
  }
}

try { Remove-Item 'C:\ProgramData\JAT-Remote' -Recurse -Force -ErrorAction Stop; Write-Host '  removed C:\ProgramData\JAT-Remote' -ForegroundColor Green } catch {}
Write-Host 'Done. The JAT app itself was left untouched.' -ForegroundColor Cyan
Read-Host 'Press Enter to close'
