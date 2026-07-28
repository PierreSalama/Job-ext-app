# ============================================================================
#  JAT LAPTOP — fix hidden-tab throttling (server laptop applies were timing out).
#
#  On a lid-closed / display-off server, Chrome throttles the auto-apply tab
#  because it's hidden/occluded, so LinkedIn's Easy-Apply flow can't advance and
#  the run times out after 5.5 min (39 failures / 14 submits when this was found).
#  The app already tries bring-to-front + keep-display-awake; those don't beat
#  Chrome's throttling on a headless box. The real fix is launching Chrome with
#  anti-throttling flags so it runs hidden tabs at full speed.
#
#  Run once on the laptop (over Remote Desktop, ADMIN PowerShell). Safe to re-run.
# ============================================================================
$ErrorActionPreference = 'Continue'
$Home_ = 'C:\ProgramData\JAT-Remote'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host 'Run in an ADMIN PowerShell.' -ForegroundColor Red; return }

# 1. never let the display/machine sleep on power (an off display = occluded = throttled)
powercfg /change monitor-timeout-ac 0 2>&1 | Out-Null
powercfg /change standby-timeout-ac 0 2>&1 | Out-Null
Write-Host 'display + standby set to never sleep (on power)' -ForegroundColor Green

# 2. the anti-throttling launch flags (also disables Windows "occluded window" detection,
#    which is what marks a background/RDP window as occluded and throttles it)
$flags = @(
  '--disable-backgrounding-occluded-windows',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
  '--no-first-run','--no-default-browser-check','--start-maximized',
  'https://www.linkedin.com/feed/'
)

# 3. tell the watchdog to relaunch Chrome WITH these flags from now on
try { New-Item -ItemType Directory -Force -Path $Home_ | Out-Null } catch {}
Set-Content -Path (Join-Path $Home_ 'chrome-cmd.txt') -Value ($flags -join "`n") -Encoding UTF8
Write-Host 'watchdog will now relaunch Chrome with anti-throttling flags' -ForegroundColor Green

# 4. relaunch Chrome now with the flags (default profile keeps the extension + your logins)
$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe","${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { Write-Host 'Chrome not found.' -ForegroundColor Red; return }
Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Start-Process $chrome -ArgumentList $flags
Write-Host ''
Write-Host 'DONE — Chrome relaunched un-throttled. Give it a minute, then tell Claude to re-check.' -ForegroundColor Cyan
Write-Host '(If the JAT extension icon is missing after relaunch, click it and Connect once.)' -ForegroundColor Yellow
