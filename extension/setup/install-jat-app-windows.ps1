# Job Application Tracker v8 - Desktop app installer (Windows)
# ASCII-only, no Unicode chars, no box-drawing - works in every PowerShell console.
# Run from anywhere via:
#   powershell -ExecutionPolicy Bypass -File install-jat-app-windows.ps1
# Or right-click in Explorer -> Run with PowerShell.

# Don't use 'Stop' globally - it conflicts with native command exit codes.
$ErrorActionPreference = 'Continue'

function Write-Step($msg) { Write-Host "[STEP] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  OK   $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  WARN $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "  FAIL $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "===================================================="
Write-Host "  Job Application Tracker v8 - Desktop installer"
Write-Host "===================================================="
Write-Host ""

# ---- Step 1: Node.js ----
Write-Step "Checking Node.js..."
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Warn2 "Node.js not found."
  Write-Host "  Install Node 18+ from https://nodejs.org/ (LTS) and rerun this script." -ForegroundColor Yellow
  try { Start-Process "https://nodejs.org/" } catch {}
  Read-Host "Press Enter to exit"
  exit 1
}
$nodeVerRaw = (& node -v) 2>$null
$nodeVer = $nodeVerRaw -replace '^v',''
$major = 0
try { $major = [int]($nodeVer.Split('.')[0]) } catch {}
if ($major -lt 18) {
  Write-Fail "Node.js $nodeVer is too old. Need Node 18 or newer."
  Read-Host "Press Enter to exit"
  exit 1
}
Write-Ok "Node.js v$nodeVer"

# ---- Step 2: Locate the v8/app folder ----
Write-Host ""
Write-Step "Locating the v8/app folder..."
# When this script lives in v8/extension/setup/, the app is at ../../app
$candidates = @(
  # Bundled with the extension (one-click install path)
  (Join-Path $PSScriptRoot "jat-app-bundle"),
  (Join-Path (Get-Location) "jat-app-bundle"),
  # Source-checkout paths
  (Join-Path $PSScriptRoot "..\..\app"),
  (Join-Path $PSScriptRoot "..\..\..\app"),
  (Join-Path (Get-Location) "v8\app"),
  (Join-Path (Get-Location) "..\app"),
  (Join-Path (Get-Location) "app"),
  "$env:USERPROFILE\Documents\jat8\app",
  "$env:USERPROFILE\Desktop\jat8\app",
  "$env:USERPROFILE\Downloads\jat8\app",
  "$env:USERPROFILE\Downloads\jat-app-bundle"
)
$appPath = $null
foreach ($c in $candidates) {
  if ([string]::IsNullOrEmpty($c)) { continue }
  $pkg = Join-Path $c "package.json"
  if (Test-Path $pkg) {
    try { $appPath = (Resolve-Path $c).Path } catch { $appPath = $c }
    break
  }
}
if (-not $appPath) {
  Write-Warn2 "Could not find the v8/app folder automatically."
  Write-Host "  Tried these locations:" -ForegroundColor DarkGray
  foreach ($c in $candidates) { Write-Host "    $c" -ForegroundColor DarkGray }
  Write-Host ""
  Write-Host "  This script lives in:  $PSScriptRoot" -ForegroundColor DarkGray
  Write-Host "  Working directory:     $(Get-Location)" -ForegroundColor DarkGray
  Write-Host ""
  $appPath = Read-Host "Enter the full path to v8/app (the folder containing package.json)"
  if (-not (Test-Path (Join-Path $appPath "package.json"))) {
    Write-Fail "No package.json found at that path. Aborting."
    Read-Host "Press Enter to exit"
    exit 1
  }
}
Write-Ok "Found app at: $appPath"

# ---- Step 3: npm install ----
Write-Host ""
Write-Step "Installing dependencies (1-3 minutes the first time)..."
Push-Location $appPath
try {
  & npm install
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "npm install failed with exit code $LASTEXITCODE."
    Write-Host ""
    Write-Host "  Most common cause: missing C++ build tools (better-sqlite3 is native)." -ForegroundColor Yellow
    Write-Host "  Install Visual Studio Build Tools with the 'Desktop development with C++' workload:" -ForegroundColor Yellow
    Write-Host "    https://visualstudio.microsoft.com/visual-cpp-build-tools/" -ForegroundColor Yellow
    Pop-Location
    Read-Host "Press Enter to exit"
    exit 1
  }
  Write-Ok "Dependencies installed (better-sqlite3 rebuilt for Electron via postinstall)"
} catch {
  Write-Fail "Install failed: $_"
  Pop-Location
  Read-Host "Press Enter to exit"
  exit 1
}

# ---- Step 4: Optional - persist OLLAMA_ORIGINS so AI works without manual setup ----
Write-Host ""
Write-Step "Setting OLLAMA_ORIGINS environment variable (so Ollama accepts requests from the extension)..."
try {
  [Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "chrome-extension://*", [EnvironmentVariableTarget]::User)
  Write-Ok "OLLAMA_ORIGINS=chrome-extension://* (User scope)"
} catch {
  Write-Warn2 "Could not set OLLAMA_ORIGINS automatically: $_"
  Write-Host "  Set it manually if you plan to use Ollama:" -ForegroundColor Yellow
  Write-Host "    setx OLLAMA_ORIGINS `"chrome-extension://*`"" -ForegroundColor Yellow
}

# ---- Step 5: Start ----
Write-Host ""
Write-Step "Starting the app..."
Write-Host "  When the app window opens, return to your browser." -ForegroundColor DarkGray
Write-Host "  The extension will auto-detect it on localhost:7733 and offer to pair." -ForegroundColor DarkGray
Write-Host "  Close this terminal window to stop the app." -ForegroundColor DarkGray
Write-Host ""
& npm start
$startCode = $LASTEXITCODE
Pop-Location
if ($startCode -ne 0) {
  Write-Fail "App exited with code $startCode."
  Read-Host "Press Enter to exit"
  exit $startCode
}
