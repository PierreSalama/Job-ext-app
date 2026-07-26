# ============================================================================
#  JAT REMOTE ACCESS - one-time setup for Dad's laptop.
#
#  Run this ONCE (double-click INSTALL-REMOTE.bat). It gives Pierre a permanent,
#  reboot-proof way to reach this machine to REVIVE the JAT app or extension if
#  they ever stop - and nothing more. It installs, transparently:
#
#    * Tailscale  - a private, encrypted network link to Pierre's devices only.
#                   Runs as a Windows service, starts at boot, works even before
#                   anyone logs in and even if the JAT app is dead. Tailscale SSH
#                   is enabled so Pierre (and only devices on his private tailnet)
#                   can shell in to restart things.
#    * A watchdog - a Scheduled Task that relaunches the JAT app if it dies and
#                   keeps Firefox open while auto-apply is running.
#    * It also makes sure the app's local-network access is on, grabs the app
#                   token + this machine's Tailscale address, writes them to the
#                   USB, and sends them to Pierre's PC.
#
#  This is ordinary remote-support tooling (like TeamViewer/Tailscale for family),
#  installed with consent. It is NOT hidden: everything lands in
#  C:\ProgramData\JAT-Remote, the Scheduled Task is named "JAT Watchdog", and
#  Uninstall-Remote.ps1 removes all of it.
# ============================================================================

# ---- the one value Pierre bakes in before putting this on the USB ----------
# A Tailscale AUTH KEY generated at https://login.tailscale.com/admin/settings/keys
# (single-use is best - it burns the moment Dad's machine joins).
$TailscaleAuthKey = '__TAILSCALE_AUTH_KEY__'

# ---- baked config ----------------------------------------------------------
$Hostname      = 'dad-jat'                                  # how this machine shows in Pierre's tailnet
$Port          = 7744
$Base          = "http://127.0.0.1:$Port"
$PierreTargets = @('BOBLAMA_PC', '192.168.2.33', '192.168.2.17', '100.93.122.106')
$Home_         = 'C:\ProgramData\JAT-Remote'
$MsiUrl        = 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi'

$KitDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ErrorActionPreference = 'Continue'
$report = New-Object System.Collections.ArrayList
function Say([string]$m,[string]$c='Gray'){ Write-Host $m -ForegroundColor $c; [void]$report.Add($m) }
function Step([string]$m){ Say '' ; Say "==> $m" 'Cyan' }
function Ok([string]$m){ Say "   ok   $m" 'Green' }
function Warn([string]$m){ Say "   WARN $m" 'Yellow' }
function Bad([string]$m){ Say "   FAIL $m" 'Red' }

# ---- self-elevate (service install + scheduled task + firewall need admin) --
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host 'Asking for administrator rights (needed once)...' -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`""
  exit
}

Say '======================================================' 'Cyan'
Say " JAT remote-access setup - $(Get-Date -Format 'yyyy-MM-dd HH:mm')" 'Cyan'
Say " computer: $env:COMPUTERNAME   user: $env:USERNAME" 'Cyan'
Say '======================================================' 'Cyan'

if ($TailscaleAuthKey -eq ('__TAILSCALE_' + 'AUTH_KEY__') -or [string]::IsNullOrWhiteSpace($TailscaleAuthKey)) {
  Bad 'No Tailscale auth key baked in. Pierre must paste a key into $TailscaleAuthKey before using this USB.'
  Read-Host 'Press Enter to close'; exit 1
}

New-Item -ItemType Directory -Force -Path $Home_ | Out-Null

# ---- FULL LOGGING: capture everything to ProgramData AND the USB -----------
# So Pierre can see exactly what happened two ways: (a) over Tailscale/SSH later
# by reading C:\ProgramData\JAT-Remote, and (b) the moment he brings the USB back,
# from the logs written next to this script. Plus the summary + full transcript
# are pushed to Pierre's PC at the end, so he sees it even with no remote access.
$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$UsbLogs = Join-Path $KitDir 'logs'
try { New-Item -ItemType Directory -Force -Path $UsbLogs | Out-Null } catch {}
$Transcript = Join-Path $Home_ "setup-remote-$stamp.log"
try { Start-Transcript -Path $Transcript -Force | Out-Null } catch {}

# ---- make sure the JAT app is running (later steps pair with it) -----------
function Find-JatExe {
  foreach ($c in @((Join-Path $env:LOCALAPPDATA 'Programs\Job Application Tracker\Job Application Tracker.exe'),(Join-Path $env:LOCALAPPDATA 'Programs\jat11-app\Job Application Tracker.exe'))) { if (Test-Path $c) { return $c } }
  try { foreach ($k in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*')) { $m = Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Job Application Tracker*' } | Select-Object -First 1; if ($m -and $m.InstallLocation) { $cand = Join-Path $m.InstallLocation 'Job Application Tracker.exe'; if (Test-Path $cand) { return $cand } } } } catch {}
  return $null
}
if (-not (Get-Process 'Job Application Tracker' -ErrorAction SilentlyContinue)) {
  $jatExe = Find-JatExe
  if ($jatExe) { Say "   starting the JAT app..."; Start-Process $jatExe | Out-Null; Start-Sleep -Seconds 8 }
}

# ============================================================================
Step '1/6  Install Tailscale (private link to Pierre)'
$tsExe = Join-Path ${env:ProgramFiles} 'Tailscale\tailscale.exe'
if (-not (Test-Path $tsExe)) {
  $msi = Join-Path $KitDir 'tailscale-setup.msi'      # prefer the copy bundled on the USB (offline-safe)
  if (-not (Test-Path $msi)) {
    Say '   downloading Tailscale...'
    try { Invoke-WebRequest -Uri $MsiUrl -OutFile $msi -UseBasicParsing -TimeoutSec 180 } catch { Bad "could not download Tailscale: $($_.Exception.Message)" }
  }
  if (Test-Path $msi) {
    Say '   installing Tailscale silently...'
    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /quiet /norestart" -Wait
  }
}
$tsExe = Join-Path ${env:ProgramFiles} 'Tailscale\tailscale.exe'
if (Test-Path $tsExe) { Ok 'Tailscale installed' } else { Bad 'Tailscale did not install - cannot set up remote access'; Read-Host 'Press Enter to close'; exit 1 }

# make sure the service is running, then WAIT for the daemon to actually accept
# commands. The first version slept 3s and ran `up` immediately; against a
# not-yet-ready tailscaled that fails silently and the node never registers -
# which is exactly what happened the first time (dad-jat never appeared on the
# tailnet). Poll `tailscale status` until it answers, up to ~40s.
try { Set-Service Tailscale -StartupType Automatic -ErrorAction SilentlyContinue } catch {}
try { Start-Service Tailscale -ErrorAction SilentlyContinue } catch {}
$tsLog = Join-Path $Home_ 'tailscale-join.log'
"[$(Get-Date -Format o)] waiting for tailscaled" | Set-Content $tsLog
$ready = $false
for ($i=0; $i -lt 20; $i++) {
  try { & $tsExe status 2>&1 | Out-Null; if ($LASTEXITCODE -ne 1) { $ready = $true; break } } catch {}
  # exit code 1 from `status` = daemon up but logged out (fine to proceed); errors = not ready
  try { $st = & $tsExe status 2>&1; if ($st -match 'Logged out|stopped|NeedsLogin|no state') { $ready = $true; break } } catch {}
  Start-Sleep -Seconds 2
}
if ($ready) { Ok 'Tailscale service is ready' } else { Warn 'Tailscale daemon slow to respond; trying anyway' }

# ============================================================================
Step '2/6  Join Pierre''s private network (reboot-proof, no login needed)'
# Two steps on purpose:
#   1. JOIN with the auth key (no --ssh here, so enabling SSH can never block the
#      join itself). --unattended keeps it connected across reboots with nobody
#      logged in.
#   2. Enable Tailscale SSH separately, so Pierre's devices can shell in to revive
#      things. If this second step ever fails, the machine is still ON the tailnet.
# Everything is logged to tailscale-join.log so a failure is diagnosable next time.
$joined = $false
for ($try=1; $try -le 3; $try++) {
  "[$(Get-Date -Format o)] up attempt $try" | Add-Content $tsLog
  $out = & $tsExe up --auth-key="$TailscaleAuthKey" --unattended --hostname="$Hostname" --reset 2>&1
  $out | Add-Content $tsLog
  $out | ForEach-Object { Say "   $_" }
  Start-Sleep -Seconds 4
  $bo = & $tsExe status --json 2>$null | ConvertFrom-Json
  if ($bo -and $bo.BackendState -eq 'Running') { $joined = $true; break }
  Start-Sleep -Seconds 4
}
if ($joined) {
  Ok 'joined the tailnet'
  # enable SSH as a separate, non-fatal step
  $sshOut = & $tsExe set --ssh 2>&1; $sshOut | Add-Content $tsLog
  Ok 'Tailscale SSH enabled (Pierre can shell in to revive things)'
} else {
  Bad 'could NOT join the tailnet - see tailscale-join.log. The most common cause is an expired/used auth key; generate a fresh one.'
}
# capture the tailnet IP (loop - it can take 20-30s to be assigned)
$tsIp = ''
for ($i=0; $i -lt 15; $i++) { try { $ip = (& $tsExe ip -4 2>$null | Select-Object -First 1); if ($ip -and $ip -notmatch '^169\.254') { $tsIp = $ip.Trim(); break } } catch {}; Start-Sleep -Seconds 2 }
if ($tsIp) { Ok "this machine is $Hostname at $tsIp on Pierre's tailnet" } else { Warn 'no tailnet IP yet (check the admin console for dad-jat)' }
# copy the join log to the USB so Pierre can read it without touching this machine
try { Copy-Item $tsLog (Join-Path $KitDir 'tailscale-join.log') -Force } catch {}

# ============================================================================
Step '3/6  Firewall - allow the JAT app on the private + Tailscale network'
try {
  netsh advfirewall firewall delete rule name='JAT v11 LAN' 2>&1 | Out-Null
  netsh advfirewall firewall add rule name='JAT v11 LAN' dir=in action=allow protocol=TCP localport=$Port profile=private,domain 2>&1 | Out-Null
  Ok "firewall allows JAT on port $Port"
} catch { Warn "could not add firewall rule: $($_.Exception.Message)" }

# ============================================================================
Step '4/6  Make sure the app''s remote access is ON + grab its token'
function Pair-App { for ($i=0;$i -lt 4;$i++){ try { $r = Invoke-RestMethod -Method Post -Uri "$Base/pair" -ContentType 'application/json' -Headers @{ origin=$Base } -Body (@{ client='remote-setup' } | ConvertTo-Json) -TimeoutSec 20; if ($r.ok){ return $r.token } } catch { Start-Sleep 2 } } return $null }
# app may not be up (this can be run standalone); give it a moment / launch it via the watchdog logic later
$token = Pair-App
if ($token) {
  try {
    Invoke-RestMethod -Method Patch -Uri "$Base/settings" -Headers @{ 'X-JAT-Token'=$token } -ContentType 'application/json' -Body (@{ server=@{ remoteAccess=$true } } | ConvertTo-Json) -TimeoutSec 20 | Out-Null
    Ok 'app remote access is ON'
  } catch { Warn "could not confirm remote access: $($_.Exception.Message)" }
  # store the token locally for the watchdog (same machine that already holds it in its DB - no new exposure)
  try { Set-Content -Path (Join-Path $Home_ 'app-token.txt') -Value $token -Encoding Ascii } catch {}
} else { Warn 'app not reachable to pair right now - the watchdog will keep it alive; token can be grabbed later over Tailscale' }

# ============================================================================
Step '5/6  Install the watchdog (keeps the app + extension alive)'
try {
  Copy-Item (Join-Path $KitDir 'jat-watchdog.ps1') (Join-Path $Home_ 'jat-watchdog.ps1') -Force
  $action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Home_\jat-watchdog.ps1`""
  $tLogon  = New-ScheduledTaskTrigger -AtLogOn
  $tRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 3) -RepetitionDuration (New-TimeSpan -Days 3650)
  $set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
  # Run as the interactive user so it can (re)launch the GUI app + Firefox in Dad's session.
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName 'JAT Watchdog' -Action $action -Trigger @($tLogon,$tRepeat) -Settings $set -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName 'JAT Watchdog' -ErrorAction SilentlyContinue
  Ok 'watchdog installed (relaunches the app if it dies; keeps Firefox open while auto-apply runs)'
} catch { Bad "could not install the watchdog: $($_.Exception.Message)" }

# copy the uninstaller + readme locally so removal never needs the USB
foreach ($f in @('Uninstall-Remote.ps1','README-REMOTE.txt')) { try { Copy-Item (Join-Path $KitDir $f) (Join-Path $Home_ $f) -Force } catch {} }

# ============================================================================
Step '6/7  Open Firefox so the extension connects and applies can start'
# This is what actually gets applications flowing: the extension only runs while
# Firefox is open. Close it first (so it re-reads the JAT policy cold and the
# extension force-installs/reconnects), then open it.
$ffDir = $null
foreach ($p in @("$env:ProgramFiles\Mozilla Firefox","${env:ProgramFiles(x86)}\Mozilla Firefox")) { if (Test-Path (Join-Path $p 'firefox.exe')) { $ffDir = $p; break } }
if ($ffDir) {
  $ffRunning = Get-Process firefox -ErrorAction SilentlyContinue
  if ($ffRunning) { $ffRunning | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3 }
  try { Start-Process (Join-Path $ffDir 'firefox.exe') | Out-Null; Ok 'opened Firefox - the extension will connect within ~30s' } catch { Warn "could not open Firefox: $($_.Exception.Message)" }
  # give the extension a moment, then check it connected
  if ($token) {
    $connected = $false
    for ($i=0; $i -lt 20; $i++) { Start-Sleep -Seconds 3; try { $ni = Invoke-RestMethod -Uri "$Base/netinfo" -Headers @{ 'X-JAT-Token'=$token } -TimeoutSec 5; if ($ni.extensionConnected) { $connected = $true; break } } catch {} }
    if ($connected) { Ok 'the Firefox extension is CONNECTED - auto-apply can now submit' } else { Warn 'extension not connected yet - leave Firefox open; it will connect on its own shortly' }
  }
} else { Warn 'Firefox not found - install Firefox, then re-run this. Auto-apply needs it open to submit.' }

# ============================================================================
Step '7/7  Report back to Pierre'
$access = [ordered]@{
  computer   = $env:COMPUTERNAME
  user       = $env:USERNAME
  tailscaleHost = $Hostname
  tailscaleIp   = $tsIp
  appToken   = $token
  appLink    = if ($tsIp -and $token) { "http://$tsIp`:$Port/app/?token=$token#/auto-apply" } else { '' }
  installedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
}
$json = ($access | ConvertTo-Json)
Say ''
Say '---- ACCESS DETAILS (also sent to Pierre) ----' 'Cyan'
Say ("Tailscale host: {0}" -f $Hostname) 'White'
Say ("Tailscale IP:   {0}" -f $tsIp) 'White'
if ($access.appLink) { Say ("Live link:      {0}" -f $access.appLink) 'White' }

# write to the USB (this folder) + ProgramData, and push to Pierre
try { Set-Content -Path (Join-Path $KitDir 'DAD-ACCESS.json') -Value $json -Encoding UTF8 } catch {}
try { Set-Content -Path (Join-Path $Home_ 'access.json') -Value $json -Encoding UTF8 } catch {}
$pushed = $false
foreach ($t in $PierreTargets) {
  try { Invoke-RestMethod -Method Post -Uri ("http://{0}:{1}/remote/report?from={2}-REMOTE" -f $t,$Port,$env:COMPUTERNAME) -Body $json -ContentType 'application/json' -TimeoutSec 6 | Out-Null; Say "access details sent to Pierre ($t)" 'Green'; $pushed=$true; break } catch {}
}
if (-not $pushed) { Warn 'could not reach Pierre''s PC now - details are saved on the USB (DAD-ACCESS.json).' }

# ---- gather a FULL diagnostic so Pierre can resolve anything from the logs --
Step 'Diagnostics (written to the USB + sent to Pierre)'
$diag = [ordered]@{ when = (Get-Date -Format o); computer = $env:COMPUTERNAME }
try { $diag.appVersion = (Invoke-RestMethod "$Base/health" -TimeoutSec 5).version } catch { $diag.appVersion = "unreachable: $($_.Exception.Message)" }
if ($token) {
  try { $ni = Invoke-RestMethod "$Base/netinfo" -Headers @{ 'X-JAT-Token'=$token } -TimeoutSec 6; $diag.extensionConnected = $ni.extensionConnected; $diag.remoteAccess = $ni.remoteAccess; $diag.interfaces = ($ni.ips | ForEach-Object { "$($_.iface)=$($_.ip)" }) -join ', ' } catch { $diag.netinfo = "err: $($_.Exception.Message)" }
  try { $lv = Invoke-RestMethod "$Base/auto-apply/live" -Headers @{ 'X-JAT-Token'=$token } -TimeoutSec 6; $diag.autoApplyEnabled = $lv.enabled; $diag.autoApplyStatus = $lv.status; $diag.queued = $lv.queuedDepth } catch {}
}
try { $diag.tailscaleBackend = ((& (Join-Path ${env:ProgramFiles} 'Tailscale\tailscale.exe') status --json 2>$null | ConvertFrom-Json).BackendState) } catch { $diag.tailscaleBackend = 'unknown' }
$diag.tailscaleIp = $tsIp
try { $diag.watchdogTask = [bool](Get-ScheduledTask -TaskName 'JAT Watchdog' -ErrorAction SilentlyContinue) } catch { $diag.watchdogTask = $false }
try { $diag.firefoxRunning = [bool](Get-Process firefox -ErrorAction SilentlyContinue) } catch {}
$diagJson = ($diag | ConvertTo-Json)
Say $diagJson 'White'

# stop the transcript so the file is complete, then FAN OUT every log to the USB + Pierre
try { Stop-Transcript | Out-Null } catch {}
$summary = ($report -join "`r`n")
try { Set-Content -Path (Join-Path $Home_ 'setup-remote.log') -Value $summary -Encoding UTF8 } catch {}
# copy every log we produced onto the USB, next to this script, in a logs\ folder
foreach ($src in @($Transcript, (Join-Path $Home_ 'tailscale-join.log'), (Join-Path $Home_ 'watchdog.log'), (Join-Path $Home_ 'setup-remote.log'))) {
  try { if (Test-Path $src) { Copy-Item $src (Join-Path $UsbLogs (Split-Path $src -Leaf)) -Force } } catch {}
}
try { Set-Content -Path (Join-Path $UsbLogs "diagnostics-$stamp.json") -Value $diagJson -Encoding UTF8 } catch {}
try { Set-Content -Path (Join-Path $KitDir 'DAD-DIAGNOSTICS.json') -Value $diagJson -Encoding UTF8 } catch {}

# push the diagnostics + full transcript to Pierre's PC (so he sees it with NO remote access)
$fullText = "=== DIAGNOSTICS ===`r`n$diagJson`r`n`r`n=== SUMMARY ===`r`n$summary`r`n`r`n=== TAILSCALE JOIN LOG ===`r`n"
try { $fullText += (Get-Content (Join-Path $Home_ 'tailscale-join.log') -Raw -ErrorAction SilentlyContinue) } catch {}
try { $fullText += "`r`n`r`n=== FULL TRANSCRIPT ===`r`n" + (Get-Content $Transcript -Raw -ErrorAction SilentlyContinue) } catch {}
foreach ($t in $PierreTargets) {
  try { Invoke-RestMethod -Method Post -Uri ("http://{0}:{1}/remote/report?from={2}-DIAG" -f $t,$Port,$env:COMPUTERNAME) -Body $fullText -ContentType 'text/plain' -TimeoutSec 8 | Out-Null; Say "full diagnostics + logs sent to Pierre ($t)" 'Green'; break } catch {}
}

Say ''
if ($joined) { Say 'DONE. Remote access is live AND applies can run. Logs are on the USB (logs\) and sent to Pierre.' 'Cyan' }
else { Say 'DONE. Applies can run (Firefox opened). Tailscale did NOT join - the reason is in logs\tailscale-join.log on the USB and was sent to Pierre.' 'Yellow' }
Read-Host 'Press Enter to close'
