# build-windows-installer.ps1
# Builds the Electron app for Windows (electron-builder), then compiles the
# Inno Setup installer and drops it INSIDE the extension folder so the
# extension page can serve it directly to the user.
#
# Run from anywhere — paths are resolved relative to the script's own location.
# Requires:
#   * Node.js + npm in PATH
#   * Inno Setup 6 (iscc.exe) in PATH for the installer compile step

[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$SkipInstaller
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppDir    = Resolve-Path (Join-Path $ScriptDir '..')
$RepoDir   = Resolve-Path (Join-Path $AppDir '..')
$ExtSetup  = Join-Path $RepoDir 'extension\setup'
$IssFile   = Join-Path $ScriptDir 'installer.iss'
$Unpacked  = Join-Path $AppDir 'dist\win-unpacked'

function Section($msg) {
    Write-Host ''
    Write-Host ('=' * 60) -ForegroundColor Cyan
    Write-Host "  $msg" -ForegroundColor Cyan
    Write-Host ('=' * 60) -ForegroundColor Cyan
}

Section 'Job Application Tracker v9 — Windows installer build'
Write-Host "App dir       : $AppDir"
Write-Host "Extension out : $ExtSetup"
Write-Host "Inno script   : $IssFile"

if (-not (Test-Path $ExtSetup)) {
    New-Item -ItemType Directory -Path $ExtSetup | Out-Null
    Write-Host "Created $ExtSetup"
}

# --- Step 1: electron-builder ---
if ($SkipBuild) {
    Write-Host '[skip] electron-builder (--SkipBuild)' -ForegroundColor Yellow
} else {
    Section 'Step 1/2 — electron-builder --win'
    Push-Location $AppDir
    try {
        if (-not (Test-Path (Join-Path $AppDir 'node_modules'))) {
            Write-Host 'node_modules missing; running npm install first...' -ForegroundColor Yellow
            npm install
            if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
        }
        npm run build:win
        if ($LASTEXITCODE -ne 0) { throw "electron-builder failed (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }

    if (-not (Test-Path $Unpacked)) {
        throw "Expected unpacked output at $Unpacked but it doesn't exist. Did electron-builder change its output layout?"
    }
    Write-Host "OK — unpacked app at $Unpacked" -ForegroundColor Green
}

# --- Step 2: Inno Setup compile ---
if ($SkipInstaller) {
    Write-Host '[skip] Inno Setup compile (--SkipInstaller)' -ForegroundColor Yellow
    return
}

Section 'Step 2/2 — Inno Setup compile'
$iscc = Get-Command 'iscc.exe' -ErrorAction SilentlyContinue
if (-not $iscc) {
    # Fallback to default install path
    $defaults = @(
        'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
        'C:\Program Files\Inno Setup 6\ISCC.exe'
    )
    foreach ($p in $defaults) { if (Test-Path $p) { $iscc = @{ Source = $p }; break } }
}

if (-not $iscc) {
    Write-Host ''
    Write-Host 'Inno Setup (iscc.exe) was not found in PATH or default install locations.' -ForegroundColor Yellow
    Write-Host 'Download it free from: https://jrsoftware.org/isdl.php' -ForegroundColor Yellow
    Write-Host 'After installing, re-run this script.' -ForegroundColor Yellow
    exit 2
}

& $iscc.Source $IssFile
if ($LASTEXITCODE -ne 0) { throw "iscc failed (exit $LASTEXITCODE)" }

$Output = Join-Path $ExtSetup 'JAT-v9-setup.exe'
if (Test-Path $Output) {
    $size = (Get-Item $Output).Length / 1MB
    Write-Host ''
    Write-Host ("Done. Installer written to {0} ({1:N1} MB)" -f $Output, $size) -ForegroundColor Green
    Write-Host 'It now ships INSIDE the extension folder. Reload the extension and visit'
    Write-Host 'the "Install desktop app" page — the bundled installer button will appear.'
} else {
    throw "Inno Setup reported success but $Output is missing."
}
