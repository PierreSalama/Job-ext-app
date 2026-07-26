# End-to-end test of Setup-JAT.ps1 against a MOCK app (no real install / Firefox / live app).
# Uses the JAT_SETUP_* test hooks. Simulates step-3 pairing failing (FAIL_FIRST_PAIRS=3) so the
# step-4 config RETRY is exercised -- the exact 2026-07-22 failure the fix targets.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tmp  = Join-Path $env:TEMP ("jat-setup-test-" + [guid]::NewGuid().ToString('N').Substring(0,8))
$ud   = Join-Path $tmp 'userdata'
$ff   = Join-Path $tmp 'firefox'
$res  = Join-Path $tmp 'result.json'
New-Item -ItemType Directory -Force -Path $ud, $ff | Out-Null
# a fake firefox.exe so the FFDIR branch runs (policy gets written); launch is skipped anyway
Set-Content -Path (Join-Path $ff 'firefox.exe') -Value '' -Encoding Ascii
$mock = (Join-Path $here 'mock-app.mjs') -replace '\\','/'
$port = 7799

$env:JAT_SETUP_PORT        = "$port"
$env:JAT_SETUP_SKIP_INSTALL= '1'
$env:JAT_SETUP_NO_ELEVATE  = '1'
$env:JAT_SETUP_SKIP_FFLAUNCH= '1'
$env:JAT_SETUP_FFDIR       = $ff
$env:JAT_SETUP_USERDATA    = $ud
$env:JAT_SETUP_PIERRE      = '127.0.0.1'
$env:JAT_SETUP_VERIFY_SEC  = '6'
# Launch-App starts the mock (harmless if the port is already bound -- it self-exits). Simulate the
# race: first 3 pair attempts fail, so step 3 can't apply config and the step-4 RETRY must.
$env:JAT_SETUP_LAUNCH_CMD  = "node `"$mock`" $port `"$($res -replace '\\','/')`" 3"

function Kill-Port($p) {
  Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
}
Kill-Port $port   # clear any stale mock from a previous run

Write-Host "running Setup-JAT.ps1 against mock on :$port ..." -ForegroundColor Cyan
& (Join-Path $here 'Setup-JAT.ps1') | Out-Null

Start-Sleep -Seconds 1
Kill-Port $port   # stop the mock this run started

# ---- assertions ----
$fail = @()
if (-not (Test-Path $res)) { $fail += 'mock never wrote a result (script never reached it)' }
else {
  $r = Get-Content $res -Raw | ConvertFrom-Json
  if (-not $r.configApplied) { $fail += 'CONFIG NEVER APPLIED (the core bug is not fixed)' }
  else {
    if ($r.configApplied.ai.disabled -ne $true)          { $fail += 'ai.disabled not set' }
    if ($r.configApplied.autoUpdate.mode -ne 'pinned')   { $fail += 'updates not pinned' }
    if ($r.configApplied.server.remoteAccess -ne $true)  { $fail += 'remoteAccess not set' }
    if (($r.configApplied.autoApply.keywords).Count -lt 10) { $fail += 'telecom keywords missing' }
  }
  if ($r.pairAttempts -lt 4) { $fail += "expected pairing to be retried past the simulated failures (got $($r.pairAttempts) attempts)" }
  if (-not $r.reportReceived) { $fail += 'report was never pushed back to Pierre' }
  Write-Host ("pairAttempts=$($r.pairAttempts)  configCount=$($r.configCount)  reportBytes=$(($r.reportReceived | Measure-Object -Character).Characters)") -ForegroundColor Gray
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
if ($fail.Count -eq 0) { Write-Host "`nTEST PASS - launch/config-retry/report all work" -ForegroundColor Green; exit 0 }
else { Write-Host "`nTEST FAIL:" -ForegroundColor Red; $fail | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }; exit 1 }
