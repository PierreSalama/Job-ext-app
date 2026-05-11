# Job Application Tracker v5 — Ollama setup helper (Windows)
# Configures Ollama so the Chrome extension can talk to it locally.

$ErrorActionPreference = 'Stop'

Write-Host ""
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host " Job Application Tracker v5 — Ollama Setup (Windows)" -ForegroundColor Cyan
Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check if Ollama is installed
$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollama) {
    Write-Host "[ ! ] Ollama is not installed." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Please download and install it from:" -ForegroundColor Yellow
    Write-Host "    https://ollama.com/download" -ForegroundColor White
    Write-Host ""
    Write-Host "After installing, re-run this script." -ForegroundColor Yellow
    exit 1
}

Write-Host "[ OK ] Ollama is installed: $($ollama.Source)" -ForegroundColor Green

# 2. Set OLLAMA_ORIGINS so the chrome extension can talk to it
try {
    [Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "chrome-extension://*", [EnvironmentVariableTarget]::User)
    Write-Host "[ OK ] OLLAMA_ORIGINS set to chrome-extension://*  (User scope)" -ForegroundColor Green
} catch {
    Write-Host "[FAIL] Could not set OLLAMA_ORIGINS: $_" -ForegroundColor Red
    exit 1
}

# 3. Pull the recommended model
Write-Host ""
Write-Host "[ .. ] Pulling gemma4:e4b (this can take a few minutes)..." -ForegroundColor Cyan
try {
    & ollama pull gemma4:e4b
    if ($LASTEXITCODE -ne 0) { throw "ollama pull exited with code $LASTEXITCODE" }
    Write-Host "[ OK ] gemma4:e4b downloaded." -ForegroundColor Green
} catch {
    Write-Host "[FAIL] Failed to pull gemma4:e4b: $_" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "==============================================================" -ForegroundColor Green
Write-Host " Success!" -ForegroundColor Green
Write-Host "==============================================================" -ForegroundColor Green
Write-Host ""
Write-Host " IMPORTANT: Quit and restart the Ollama app from the system" -ForegroundColor Yellow
Write-Host " tray so it picks up the new OLLAMA_ORIGINS variable." -ForegroundColor Yellow
Write-Host ""
Write-Host " Then open the extension's AI Setup Wizard and click Test." -ForegroundColor White
Write-Host ""
