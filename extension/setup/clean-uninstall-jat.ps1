# Clean-uninstall Job Application Tracker - Windows
# Wipes every trace of the desktop app so you can re-install fresh.
# ASCII-only, single-file, no admin needed (but escalates if found in Program Files).
#
# Run from anywhere:
#   powershell -ExecutionPolicy Bypass -File clean-uninstall-jat.ps1
# Or double-click in Explorer and click "Run with PowerShell".

$ErrorActionPreference = 'Continue'

function Write-Step($msg) { Write-Host "[STEP] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  OK   $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  WARN $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "  FAIL $msg" -ForegroundColor Red }
function Write-Info($msg) { Write-Host "  ..   $msg" -ForegroundColor DarkGray }

Write-Host ''
Write-Host '===================================================='
Write-Host '  Job Application Tracker - Clean Uninstall'
Write-Host '===================================================='
Write-Host ''
Write-Host 'This will:' -ForegroundColor White
Write-Host '  1. Stop any running JAT processes' -ForegroundColor White
Write-Host '  2. Run the NSIS uninstaller if present' -ForegroundColor White
Write-Host '  3. Delete leftover install directories' -ForegroundColor White
Write-Host '  4. Wipe the userData folder (database, settings, custom icon)' -ForegroundColor White
Write-Host '  5. Free port 7733' -ForegroundColor White
Write-Host ''
$confirm = Read-Host 'Continue? (y/N)'
if ($confirm -notmatch '^[yY]') { Write-Host 'Aborted.'; exit 0 }

# ---- Step 1: Stop running processes ----
Write-Step 'Stopping running JAT processes...'
$names = @('Job Application Tracker', 'jat8-app', 'JAT-v8', 'electron')
$killed = 0
foreach ($n in $names) {
  Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object {
    # Only kill electron if its main module path contains our app
    $isOurs = $true
    if ($n -eq 'electron') {
      try {
        $path = $_.MainModule.FileName
        $isOurs = ($path -match 'Job Application Tracker' -or $path -match 'jat')
      } catch { $isOurs = $false }
    }
    if ($isOurs) {
      try { Stop-Process -Id $_.Id -Force -ErrorAction Stop; $killed++; Write-Info "killed PID $($_.Id) ($n)" }
      catch { Write-Warn2 "could not kill PID $($_.Id)" }
    }
  }
}
if ($killed -eq 0) { Write-Info 'no running processes found' } else { Write-Ok "stopped $killed process(es)" }
Start-Sleep -Seconds 1

# ---- Step 2: Run NSIS uninstaller if present ----
Write-Step 'Looking for installed app...'
$installCandidates = @(
  "$env:LOCALAPPDATA\Programs\Job Application Tracker",
  "$env:LOCALAPPDATA\Programs\jat8-app",
  "${env:ProgramFiles}\Job Application Tracker",
  "${env:ProgramFiles(x86)}\Job Application Tracker"
)
$installedAt = $null
foreach ($c in $installCandidates) {
  if (Test-Path $c) { $installedAt = $c; break }
}
if ($installedAt) {
  Write-Info "found install at: $installedAt"
  $uninst = Get-ChildItem -Path $installedAt -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($uninst) {
    Write-Info "running uninstaller (silent): $($uninst.FullName)"
    try {
      Start-Process -FilePath $uninst.FullName -ArgumentList '/S' -Wait -ErrorAction Stop
      Write-Ok 'uninstaller completed'
    } catch {
      Write-Warn2 "uninstaller failed: $_  -- falling back to manual delete"
    }
  } else {
    Write-Warn2 'no Uninstall*.exe found - skipping silent uninstall'
  }
} else {
  Write-Info 'no install directory detected'
}

# ---- Step 3: Manual cleanup of install dirs (in case uninstaller left files) ----
Write-Step 'Cleaning install directories...'
foreach ($c in $installCandidates) {
  if (Test-Path $c) {
    try {
      Remove-Item -Path $c -Recurse -Force -ErrorAction Stop
      Write-Ok "deleted $c"
    } catch {
      Write-Warn2 "could not delete $c (may require admin) -- $($_.Exception.Message)"
    }
  }
}

# ---- Step 4: Wipe userData ----
Write-Step 'Cleaning user data...'
$userDataDirs = @(
  "$env:APPDATA\Job Application Tracker",
  "$env:APPDATA\jat8-app",
  "$env:LOCALAPPDATA\Job Application Tracker",
  "$env:LOCALAPPDATA\jat8-app"
)
foreach ($d in $userDataDirs) {
  if (Test-Path $d) {
    try {
      Remove-Item -Path $d -Recurse -Force -ErrorAction Stop
      Write-Ok "deleted $d"
    } catch {
      Write-Warn2 "could not delete $d -- $($_.Exception.Message)"
    }
  }
}

# ---- Step 5: Remove desktop + start-menu shortcuts ----
Write-Step 'Cleaning shortcuts...'
$shortcutPaths = @(
  "$env:USERPROFILE\Desktop\Job Application Tracker.lnk",
  "$env:PUBLIC\Desktop\Job Application Tracker.lnk",
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Job Application Tracker.lnk",
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Job Application Tracker"
)
foreach ($p in $shortcutPaths) {
  if (Test-Path $p) {
    try { Remove-Item -Path $p -Recurse -Force -ErrorAction Stop; Write-Ok "removed $p" }
    catch { Write-Warn2 "could not remove $p" }
  }
}

# ---- Step 6: Free port 7733 if something's still bound ----
Write-Step 'Checking port 7733...'
try {
  $bound = Get-NetTCPConnection -LocalPort 7733 -ErrorAction SilentlyContinue
  if ($bound) {
    foreach ($conn in $bound) {
      try {
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction Stop
        Write-Ok "freed port 7733 (killed PID $($conn.OwningProcess))"
      } catch { Write-Warn2 "PID $($conn.OwningProcess) still on :7733" }
    }
  } else { Write-Info 'port 7733 already free' }
} catch { Write-Info '(Get-NetTCPConnection unavailable; skipping)' }

# ---- Step 7: Clear the protocol handler registration (jat8://) ----
Write-Step 'Cleaning protocol handler...'
$protoKeys = @('HKCU:\Software\Classes\jat8', 'HKLM:\Software\Classes\jat8')
foreach ($k in $protoKeys) {
  if (Test-Path $k) {
    try { Remove-Item -Path $k -Recurse -Force -ErrorAction Stop; Write-Ok "removed $k" }
    catch { Write-Info "could not remove $k (may need admin; usually harmless to leave)" }
  }
}

Write-Host ''
Write-Host '===================================================='
Write-Host '  Clean uninstall complete.' -ForegroundColor Green
Write-Host '===================================================='
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor White
Write-Host '  1. Open the Chrome extension'
Write-Host '  2. Go to "Install desktop app"'
Write-Host '  3. Click "Install with one click"'
Write-Host '  4. The latest installer (v8.0.5+) will download'
Write-Host '  5. Double-click it; the wizard will install fresh'
Write-Host ''
Read-Host 'Press Enter to exit'
