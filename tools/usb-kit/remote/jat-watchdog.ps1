# ============================================================================
#  JAT watchdog - keeps things alive on Dad's machine so Pierre rarely has to.
#
#  Installed by Setup-Remote.ps1 to  C:\ProgramData\JAT-Remote\jat-watchdog.ps1
#  and run by a Scheduled Task as the logged-in user, at logon and every few
#  minutes. It is deliberately small, idempotent, and safe to run repeatedly.
#
#  It does three things, each only if needed:
#    1. Tailscale service up   -> the always-on way back in (network access).
#    2. JAT app running        -> relaunch if it died.
#    3. Firefox running        -> relaunch ONLY when auto-apply is enabled,
#                                 because that is the only time the browser
#                                 must stay open for applications to go out.
#
#  Everything it does is logged to  C:\ProgramData\JAT-Remote\watchdog.log
#  so Pierre can read it over Tailscale SSH.
# ============================================================================

$ErrorActionPreference = 'Continue'
$Home_    = 'C:\ProgramData\JAT-Remote'
$LogFile  = Join-Path $Home_ 'watchdog.log'
$Port     = 7744
$Base     = "http://127.0.0.1:$Port"

function Log([string]$m) {
  try {
    $line = ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    # keep the log bounded (~2000 lines)
    $c = Get-Content $LogFile -ErrorAction SilentlyContinue
    if ($c.Count -gt 2000) { Set-Content -Path $LogFile -Value ($c | Select-Object -Last 1500) -Encoding UTF8 }
  } catch {}
}

# ---- 1. Tailscale service (our lifeline) -----------------------------------
try {
  $svc = Get-Service Tailscale -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -ne 'Running') { Start-Service Tailscale -ErrorAction SilentlyContinue; Log 'tailscale service was down -> started' }
} catch { Log "tailscale check failed: $($_.Exception.Message)" }

# ---- find the installed JAT app exe ----------------------------------------
function Find-JatExe {
  $cands = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Job Application Tracker\Job Application Tracker.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\jat11-app\Job Application Tracker.exe')
  )
  foreach ($c in $cands) { if (Test-Path $c) { return $c } }
  try {
    foreach ($k in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
      $m = Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Job Application Tracker*' } | Select-Object -First 1
      if ($m -and $m.InstallLocation) { $cand = Join-Path $m.InstallLocation 'Job Application Tracker.exe'; if (Test-Path $cand) { return $cand } }
    }
  } catch {}
  return $null
}

# ---- 2. JAT app running ----------------------------------------------------
$appUp = $false
try {
  $appUp = [bool](Get-Process 'Job Application Tracker' -ErrorAction SilentlyContinue)
  if (-not $appUp) {
    $exe = Find-JatExe
    if ($exe) { Start-Process $exe | Out-Null; Log 'JAT app was not running -> relaunched'; Start-Sleep -Seconds 8; $appUp = $true }
    else { Log 'JAT app not running and installer exe not found' }
  }
} catch { Log "app check failed: $($_.Exception.Message)" }

# ---- 3. Firefox running, but only when auto-apply is ON ---------------------
# We do not fight Dad by reopening a browser he closed on purpose. We only keep
# Firefox alive while auto-apply is enabled, because that is the only time the
# extension has to be live for applications to be submitted.
try {
  $tokFile = Join-Path $Home_ 'app-token.txt'
  if ($appUp -and (Test-Path $tokFile)) {
    $tok = (Get-Content $tokFile -Raw).Trim()
    $enabled = $false
    try {
      $live = Invoke-RestMethod -Uri "$Base/auto-apply/live" -Headers @{ 'X-JAT-Token' = $tok } -TimeoutSec 6
      $enabled = [bool]$live.enabled
    } catch {}
    if ($enabled) {
      $ffUp = [bool](Get-Process firefox -ErrorAction SilentlyContinue)
      if (-not $ffUp) {
        $ffDir = $null
        foreach ($p in @("$env:ProgramFiles\Mozilla Firefox","${env:ProgramFiles(x86)}\Mozilla Firefox")) { if (Test-Path (Join-Path $p 'firefox.exe')) { $ffDir = $p; break } }
        if ($ffDir) { Start-Process (Join-Path $ffDir 'firefox.exe') | Out-Null; Log 'auto-apply ON but Firefox was closed -> relaunched (extension needs it open)' }
      }
    }
  }
} catch { Log "firefox check failed: $($_.Exception.Message)" }
