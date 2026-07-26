# ============================================================================
#  JAT - Dad's laptop: ONE script that does everything.
#  Run this ONE file. It will:
#    1. install/update the JAT app (silent)
#    2. configure it for Dad (AI off, updates pinned, telecom auto-apply tuning)
#    3. turn on local-network remote monitoring (+ firewall rule)
#    4. install the Firefox extension automatically and connect it
#    5. check that everything worked
#    6. send a full setup report back to Pierre's PC over the local network
#  No Python, no extra downloads - the app carries everything it needs.
#
#  HOW TO RUN:  copy this whole folder to the Desktop, then right-click
#               Setup-JAT.ps1 -> Run with PowerShell, and approve the admin prompt.
# ============================================================================

# ---- baked config (Pierre's side) ------------------------------------------
$PierreTargets = @('BOBLAMA_PC', '192.168.2.33', '192.168.2.17')   # where the report is pushed
$Port          = if ($env:JAT_SETUP_PORT) { [int]$env:JAT_SETUP_PORT } else { 7744 }   # test hook; prod = 7744
$Base          = "http://127.0.0.1:$Port"
$ExtId         = 'jat-v11@pierresalama.dev'

# ---- test hooks (unset in production) --------------------------------------
$UserData    = if ($env:JAT_SETUP_USERDATA) { $env:JAT_SETUP_USERDATA } else { Join-Path $env:APPDATA 'jat11-app' }
$SkipInstall = [bool]$env:JAT_SETUP_SKIP_INSTALL
$LaunchCmd   = $env:JAT_SETUP_LAUNCH_CMD          # test: a cmd to (re)launch the app; prod: uses installed exe
$FfDirOverride = $env:JAT_SETUP_FFDIR
$SkipFfLaunch  = [bool]$env:JAT_SETUP_SKIP_FFLAUNCH
$NoElevate     = [bool]$env:JAT_SETUP_NO_ELEVATE
if ($env:JAT_SETUP_PIERRE) { $PierreTargets = $env:JAT_SETUP_PIERRE -split ',' }

$KitDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ErrorActionPreference = 'Continue'
$report = New-Object System.Collections.ArrayList
function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c; [void]$report.Add($m) }
function Step([string]$m) { Say "" ; Say "==> $m" 'Cyan' }
function Ok([string]$m)   { Say "   ok   $m" 'Green' }
function Warn([string]$m) { Say "   WARN $m" 'Yellow' }
function Bad([string]$m)  { Say "   FAIL $m" 'Red' }

# ---- self-elevate (needed for the firewall rule + Firefox policy) ----------
if (-not $NoElevate) {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) {
    Write-Host 'Asking for administrator rights (needed once)...' -ForegroundColor Yellow
    Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`""
    exit
  }
}

Say "======================================================" 'Cyan'
Say " JAT setup for Dad - $(Get-Date -Format 'yyyy-MM-dd HH:mm')" 'Cyan'
Say " computer: $env:COMPUTERNAME   user: $env:USERNAME" 'Cyan'
Say "======================================================" 'Cyan'

function Wait-App([int]$timeoutSec = 90) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try { Invoke-WebRequest -UseBasicParsing -Uri "$Base/pair" -Method Options -TimeoutSec 3 | Out-Null; return $true } catch {}
    Start-Sleep -Seconds 2
  }
  return $false
}
function New-Sentinel { try { New-Item -ItemType Directory -Force -Path $UserData | Out-Null; Set-Content -Path (Join-Path $UserData '.setup-autopair') -Value 'setup' -Encoding Ascii } catch {} }
function Pair-App {
  for ($i = 0; $i -lt 3; $i++) {
    try {
      $r = Invoke-RestMethod -Method Post -Uri "$Base/pair" -ContentType 'application/json' -Headers @{ origin = $Base } -Body (@{ client = 'usb-setup' } | ConvertTo-Json) -TimeoutSec 30
      if ($r.ok) { return $r.token }
    } catch { Start-Sleep -Seconds 2 }
  }
  return $null
}
$InstalledExe = $null
function Launch-App {
  New-Sentinel
  if ($LaunchCmd) { Start-Process powershell -ArgumentList "-NoProfile -Command `"$LaunchCmd`"" -WindowStyle Hidden; return }
  if ($InstalledExe -and (Test-Path $InstalledExe)) { Start-Process $InstalledExe | Out-Null }
}
function Stop-App {
  if ($LaunchCmd) { Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*v11*src*main.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
  else { Get-Process 'Job Application Tracker' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

# ============================================================================
Step "1/7  Firewall rule (local network, port $Port)"
try {
  netsh advfirewall firewall delete rule name="JAT v11 LAN" 2>&1 | Out-Null
  netsh advfirewall firewall add rule name="JAT v11 LAN" dir=in action=allow protocol=TCP localport=$Port profile=private 2>&1 | Out-Null
  Ok "firewall allows JAT on the private network"
} catch { Warn "could not add firewall rule: $($_.Exception.Message)" }

# ============================================================================
Step "2/7  Install / update the JAT app"
New-Sentinel   # drop BEFORE launch so first-run pairing is silent
# Close any old/hung instance FIRST. Installing over a running app can leave the DB lock
# (jat.db.lock) held by the dying process, which then bricks every later launch with "database is
# locked" -- the exact failure on Dad's 2026-07-22 re-run. (The app now self-clears a stale lock on
# startup too, but not installing over a live instance avoids creating one in the first place.)
Stop-App
if ($SkipInstall) {
  Ok "install skipped (test mode)"
  if (-not (Wait-App 5)) { Launch-App }
} else {
  $exe = Join-Path $KitDir 'JAT-v11-setup.exe'
  if (Test-Path $exe) {
    Say "   running the installer silently - this can take a minute..."
    Start-Process -FilePath $exe -ArgumentList '/S' -Wait
    Ok "installer finished"
    # find the installed exe (registry InstallLocation, then the default Programs path)
    try {
      $keys = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*')
      foreach ($k in $keys) {
        $m = Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Job Application Tracker*' } | Select-Object -First 1
        if ($m -and $m.InstallLocation) { $cand = Join-Path $m.InstallLocation 'Job Application Tracker.exe'; if (Test-Path $cand) { $InstalledExe = $cand; break } }
      }
    } catch {}
    if (-not $InstalledExe) { $cand = Join-Path $env:LOCALAPPDATA 'Programs\Job Application Tracker\Job Application Tracker.exe'; if (Test-Path $cand) { $InstalledExe = $cand } }
  } else { Bad "installer not found next to this script ($exe)" }
}
# The silent installer (/S) does NOT auto-launch the app -- NSIS suppresses the finish-page "run"
# action in silent mode. This was the root cause of the 2026-07-22 Dad-setup failure: step 2 timed
# out with "app did not start" because nothing ever launched it, and every later step cascaded off
# that. So launch it explicitly if a quick probe shows it isn't already up.
if (-not (Wait-App 8)) { Say "   starting the app..."; Launch-App }
if (Wait-App 90) { Ok "app is running on port $Port" } else { Bad "app did not start - cannot continue"; }

# ============================================================================
Step "3/7  Configure for Dad + turn on remote monitoring"
$token = Pair-App
if (-not $token) { Bad "could not pair with the app"; } else { Ok "paired" }
$config = @{
  ai         = @{ disabled = $true }
  autoUpdate = @{ mode = 'pinned' }
  server     = @{ remoteAccess = $true }
  autoApply  = @{
    enabled = $false
    keywords = @('structured cabling','structure cabling','telecommunications','telecom','fibre','fiber optic','fibre splicer','wireline','wire line','cable technician','network technician','network infrastructure','infrastructure technician','low voltage','field technician')
    excludeKeywords = @('recruiter','account executive','sales representative','insurance agent','real estate')
    locations = @('toronto','north york','scarborough','mississauga','markham','ontario','canada')
    country = 'Canada'; workModes = @('remote','hybrid','onsite'); seniorityMax = 'any'
    easyApplyOnly = $true; boards = @('linkedin','indeed'); maxPerDay = 60; maxPerHour = 20
  }
}
# Apply config via a function so it can be RETRIED in step 4. The old code applied it only here;
# when step-3 pairing lost a race (as it did on 2026-07-22, cascading off the step-2 launch bug),
# the config was never applied AND never retried -- so Dad's AI-off / pinned-updates / remote-access
# / telecom tuning were all silently missing even though the app came up fine at step 4.
$configApplied = $false
function Save-Config($tok) {
  if (-not $tok) { return $false }
  try {
    Invoke-RestMethod -Method Patch -Uri "$Base/settings" -Headers @{ 'X-JAT-Token' = $tok } -ContentType 'application/json' -Body ($config | ConvertTo-Json -Depth 6) -TimeoutSec 30 | Out-Null
    return $true
  } catch { Bad "could not save configuration: $($_.Exception.Message)"; return $false }
}
$configApplied = Save-Config $token
if ($configApplied) { Ok "configuration saved (AI off, updates pinned, telecom tuning, remote on)" }

# ============================================================================
Step "4/7  Restart the app so remote monitoring goes live"
Stop-App
Launch-App
if (Wait-App 90) { Ok "app restarted (now reachable on the local network)" } else { Bad "app did not come back after restart" }
$token = Pair-App
# Retry the config here if it never landed in step 3 -- the app is definitely up and re-paired now.
if (-not $configApplied) { $configApplied = Save-Config $token; if ($configApplied) { Ok "configuration saved on retry (AI off, updates pinned, telecom tuning, remote on)" } }

# ============================================================================
Step "5/7  Install the Firefox extension automatically"
$ffDir = $FfDirOverride
if (-not $ffDir) {
  foreach ($p in @("$env:ProgramFiles\Mozilla Firefox","${env:ProgramFiles(x86)}\Mozilla Firefox")) { if (Test-Path (Join-Path $p 'firefox.exe')) { $ffDir = $p; break } }
  if (-not $ffDir) { try { $rk = Get-ItemProperty 'HKLM:\SOFTWARE\Mozilla\Mozilla Firefox' -ErrorAction SilentlyContinue; if ($rk.CurrentVersion) { $mp = Get-ItemProperty "HKLM:\SOFTWARE\Mozilla\Mozilla Firefox\$($rk.CurrentVersion)\Main" -ErrorAction SilentlyContinue; if ($mp.'Install Directory') { $ffDir = $mp.'Install Directory' } } } catch {} }
}
if ($ffDir) {
  $xpiSrc = Join-Path $KitDir 'jat-v11-firefox.xpi'
  $xpiDst = Join-Path $UserData 'jat-firefox.xpi'
  try { Copy-Item $xpiSrc $xpiDst -Force -ErrorAction Stop; Ok "extension file staged" } catch { Bad "could not stage the extension: $($_.Exception.Message)" }
  $dist = Join-Path $ffDir 'distribution'
  New-Item -ItemType Directory -Force -Path $dist | Out-Null
  $fileUrl = 'file:///' + ($xpiDst -replace '\\','/')
  $policy = @{ policies = @{ ExtensionSettings = @{ "$ExtId" = @{ installation_mode = 'force_installed'; install_url = $fileUrl } } } }
  # BOM-less UTF-8 — Firefox's policies.json parser rejects a byte-order mark.
  try { [System.IO.File]::WriteAllText((Join-Path $dist 'policies.json'), ($policy | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding $false)); Ok "Firefox policy written (extension auto-installs on launch)" } catch { Bad "could not write Firefox policy: $($_.Exception.Message)" }
  New-Sentinel
  if (-not $SkipFfLaunch) {
    # Firefox reads distribution/policies.json ONLY at startup. If it is already running, launching
    # it again just focuses the existing window and the extension never force-installs -- a 2026-07-22
    # failure mode ("extension not connected"). Fully close Firefox first so the next launch reads the
    # new policy cold and installs the extension.
    $ffRunning = Get-Process firefox -ErrorAction SilentlyContinue
    if ($ffRunning) { Say "   closing Firefox so it re-reads the new policy..."; $ffRunning | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3 }
    Say "   opening Firefox once so the extension installs and connects..."
    try { Start-Process (Join-Path $ffDir 'firefox.exe') | Out-Null } catch { Warn "could not launch Firefox automatically - just open Firefox once." }
  }
} else { Warn "Firefox not found - install Firefox, then re-run this script (the rest is done)." }

# ============================================================================
Step "6/7  Verify the extension connected"
$net = $null
$verifySec = if ($env:JAT_SETUP_VERIFY_SEC) { [int]$env:JAT_SETUP_VERIFY_SEC } else { 120 }
if ($token) {
  $deadline = (Get-Date).AddSeconds($verifySec)
  while ((Get-Date) -lt $deadline) {
    try { $net = Invoke-RestMethod -Uri "$Base/netinfo" -Headers @{ 'X-JAT-Token' = $token } -TimeoutSec 5; if ($net.extensionConnected) { break } } catch {}
    Start-Sleep -Seconds 3
  }
  if ($net -and $net.extensionConnected) { Ok "the Firefox extension is connected" }
  else { Warn "extension not connected yet - open Firefox and give it ~30s; it will connect on its own." }
}

# ============================================================================
Step "7/7  Report + send back to Pierre"
$settings = $null; if ($token) { try { $settings = (Invoke-RestMethod -Uri "$Base/settings" -Headers @{ 'X-JAT-Token' = $token } -TimeoutSec 10).settings } catch {} }
Say ""
Say "---- summary ----" 'Cyan'
if ($settings) {
  Say ("AI disabled:      {0}" -f $settings.ai.disabled)
  Say ("updates pinned:   {0}" -f ($settings.autoUpdate.mode -eq 'pinned'))
  Say ("remote access:    {0}" -f $settings.server.remoteAccess)
  Say ("telecom keywords: {0}" -f $settings.autoApply.keywords.Count)
  $aaState = if ($settings.autoApply.enabled) { 'ON' } else { 'OFF (start it from the app when ready)' }
  Say ("auto-apply is:    {0}" -f $aaState)
}
if ($net) {
  $extState = if ($net.extensionConnected) { 'connected' } else { 'not yet' }
  Say ("extension:        {0}" -f $extState)
  Say ("hostname:         {0}" -f $net.hostname)
  Say "watch live from Pierre's PC (same network):" 'Cyan'
  foreach ($ip in $net.ips) { if ($ip.ip -notlike '127.*') { Say ("   http://{0}:{1}/app/?token={2}#/auto-apply   ({3})" -f $ip.ip, $Port, $token, $ip.iface) 'White' } }
}

# save the report where the app serves it (Pierre can pull it live) + on the Desktop
$reportText = ($report -join "`r`n")
try { $logs = Join-Path $UserData 'logs'; New-Item -ItemType Directory -Force -Path $logs | Out-Null; Set-Content -Path (Join-Path $logs 'setup-report.log') -Value $reportText -Encoding UTF8 } catch {}
try { Set-Content -Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'JAT-setup-report.txt') -Value $reportText -Encoding UTF8 } catch {}

# push to Pierre's PC (best-effort; first reachable target wins)
$pushed = $false
foreach ($t in $PierreTargets) {
  try { Invoke-RestMethod -Method Post -Uri ("http://{0}:{1}/remote/report?from={2}" -f $t, $Port, $env:COMPUTERNAME) -Body $reportText -ContentType 'text/plain' -TimeoutSec 6 | Out-Null; Say "report sent to Pierre's PC ($t)" 'Green'; $pushed = $true; break } catch {}
}
if (-not $pushed) { Warn "couldn't reach Pierre's PC to send the report (is his JAT open + on the same network?). It's saved on the Desktop + readable via the live link above." }

Say ""
Say "DONE. Open the JAT app -> Auto-Apply -> Start when you want it running." 'Cyan'
if (-not $NoElevate) { Read-Host 'Press Enter to close' }
