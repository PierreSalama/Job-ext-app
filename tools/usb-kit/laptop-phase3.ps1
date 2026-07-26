# ============================================================================
#  JAT LAPTOP PHASE 3 - Chrome extension + open it for LinkedIn/Indeed login.
#  Run once in an elevated PowerShell on the laptop (Claude provides the one-liner).
#  Downloads the Chrome extension, tells the watchdog how to keep Chrome running,
#  and opens a dedicated Chrome (with the extension loaded) at LinkedIn + Indeed so
#  Pierre can log in. After Pierre logs in, Claude enables auto-apply remotely.
# ============================================================================
$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$Home_  = 'C:\ProgramData\JAT-Remote'
$extDir = Join-Path $Home_ 'chrome-extension'
$profDir= Join-Path $Home_ 'chrome-profile'
$zipUrl = 'https://raw.githubusercontent.com/PierreSalama/Job-ext-app/05d8c64bf55377d1f37ca63807bbb1d76b423867/extension-chrome.zip'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host 'Run in an ADMIN PowerShell.' -ForegroundColor Red; return }
New-Item -ItemType Directory -Force -Path $Home_,$extDir,$profDir | Out-Null

# ---- download + unpack the Chrome extension --------------------------------
$zip = Join-Path $env:TEMP 'ext-chrome.zip'
Write-Host 'Downloading the Chrome extension...' -ForegroundColor Cyan
try { (New-Object System.Net.WebClient).DownloadFile($zipUrl,$zip) } catch { Write-Host "download failed: $($_.Exception.Message)" -ForegroundColor Red; return }
try { Expand-Archive -Path $zip -DestinationPath $extDir -Force } catch { Write-Host "unzip failed: $($_.Exception.Message)" -ForegroundColor Red; return }
if (Test-Path (Join-Path $extDir 'manifest.json')) { Write-Host "extension unpacked to $extDir" -ForegroundColor Green } else { Write-Host 'manifest.json missing after unzip' -ForegroundColor Red; return }

# ---- find Chrome -----------------------------------------------------------
$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe","${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Write-Host 'Chrome not found - tell Claude.' -ForegroundColor Red; return }

# ---- tell the watchdog how to keep Chrome running (one arg per line) --------
# The watchdog reads this and relaunches Chrome with these args whenever auto-apply
# is ON and Chrome is not running - so the applier browser self-heals.
$args = @(
  "--load-extension=$extDir",
  "--user-data-dir=$profDir",
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-session-crashed-bubble',
  '--restore-last-session',
  'https://www.linkedin.com/feed/'
)
Set-Content -Path (Join-Path $Home_ 'chrome-cmd.txt') -Value ($args -join "`n") -Encoding UTF8

# ---- open Chrome now so Pierre can log in ----------------------------------
# Kill only the dedicated-profile Chrome if any, then open fresh with login tabs.
$firstArgs = @("--load-extension=$extDir","--user-data-dir=$profDir",'--no-first-run','--no-default-browser-check','https://www.linkedin.com/login','https://secure.indeed.com/auth')
Start-Process $chrome -ArgumentList $firstArgs
Write-Host ''
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ' Chrome just opened with the JAT extension loaded.' -ForegroundColor Cyan
Write-Host ' 1. LOG IN to LinkedIn (and Indeed) in that Chrome window.' -ForegroundColor White
Write-Host ' 2. If Chrome shows a "developer mode extensions" bubble, just' -ForegroundColor White
Write-Host '    close it - the extension keeps working.' -ForegroundColor White
Write-Host ' 3. Then tell Claude - he will confirm the extension connected' -ForegroundColor White
Write-Host '    and turn on auto-apply.' -ForegroundColor White
Write-Host '============================================================' -ForegroundColor Cyan
