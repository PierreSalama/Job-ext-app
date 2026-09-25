# A dedicated CDP-controllable Chrome, on its own profile, that never touches Pierre's applier lane.
#
# WHY A FRESH PROFILE: the failed attempt moved his real profile, which invalidated Chrome's
# MAC-protected Secure Preferences; Chrome stripped developer_mode and disabled the already-
# registered unpacked extension (disable_reasons=16777216), and --load-extension could not override
# an existing disabled entry. A profile with NO prior entry has nothing to invalidate, so
# --load-extension installs cleanly. That is exactly how the CfT supervisor on this same box runs
# Dad's instance today, so the pattern is already proven here.
#
# ISOLATION: different --user-data-dir and a different debug port from anything else, so the real
# Chrome (default profile, extension registered in-profile, talking to 7744) is untouched.
param([switch]$Restart)
$ErrorActionPreference = 'Stop'
# Branded Chrome 152 IGNORES --load-extension outright (measured: only its 3 built-in
# component extensions installed, the JAT one absent). Chrome for Testing still honours the
# automation switches, and Dad's instance on this same box runs the JAT extension in it today.
$EXE  = 'C:\ProgramData\JAT-Remote\cft-supervisor\.cft-cache\chrome\win64-151.0.7922.71\chrome-win64\chrome.exe'
$REAL = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$PROF = 'C:\ProgramData\JAT-Remote\chrome-cdp-profile'
$EXT  = 'C:\ProgramData\JAT-Remote\chrome-extension-pierre'
$PORT = 9223
function Say($m) { Write-Output ('  ' + $m) }

$launchArgs = @(
  '--no-first-run'
  '--no-default-browser-check'
  '--no-service-autorun'
  '--disable-background-timer-throttling'
  '--disable-backgrounding-occluded-windows'
  '--disable-renderer-backgrounding'
  "--user-data-dir=$PROF"
  "--remote-debugging-port=$PORT"
  '--disable-features=DisableLoadExtensionCommandLineSwitch'
  "--load-extension=$EXT"
  "--disable-extensions-except=$EXT"
)

# Only ever touch chrome processes carrying OUR user-data-dir. Never the real-profile one.
$mine = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like "*chrome-cdp-profile*" })
if ($mine.Count -gt 0) {
  if (-not $Restart) { Say "already running ($($mine.Count) procs)"; }
  else {
    Say "restarting: stopping $($mine.Count) procs"
    $mine | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
    Start-Sleep -Seconds 4
    $mine = @()
  }
}
if ($mine.Count -eq 0) {
  New-Item -ItemType Directory -Path $PROF -Force | Out-Null
  Say 'launching CDP Chrome'
  Start-Process -FilePath $EXE -ArgumentList $launchArgs
  Start-Sleep -Seconds 20
}

Write-Output ''
Write-Output '--- VERIFY ---'
try { $v = Invoke-RestMethod "http://127.0.0.1:$PORT/json/version" -TimeoutSec 10; Say ('CDP     : UP  ' + $v.Browser) }
catch { Say 'CDP     : DOWN'; exit 1 }

$t = @(Invoke-RestMethod "http://127.0.0.1:$PORT/json/list" -TimeoutSec 10)
Say ('targets : ' + $t.Count)
$sw = @($t | Where-Object { $_.url -like 'chrome-extension://*' })
if ($sw.Count -gt 0) { $sw | ForEach-Object { Say ('  ' + $_.type + '  ' + $_.url.Substring(0, [Math]::Min(70, $_.url.Length))) } }
else { Say '  (no extension target yet - MV3 workers start lazily)' }

# Prove the extension is installed regardless of whether its worker is awake right now.
$sp = Join-Path $PROF 'Default\Secure Preferences'
if (Test-Path $sp) {
  $j = Get-Content $sp -Raw | ConvertFrom-Json
  $j.extensions.settings.PSObject.Properties | ForEach-Object {
    $p = $_.Value.path
    if ($p -and $p -like '*chrome-extension-pierre*') {
      Say ('installed: ' + $_.Name + '  disable_reasons=' + $_.Value.disable_reasons + '  location=' + $_.Value.location)
    }
  }
}
# Confirm the real lane is still healthy and was not disturbed.
$real = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.ExecutablePath -eq $REAL -and $_.CommandLine -notmatch 'chrome-cdp-profile' -and $_.CommandLine -notmatch '--type=' }).Count
$sock = @(Get-NetTCPConnection -RemotePort 7744 -State Established -EA SilentlyContinue |
  Where-Object { (Get-Process -Id $_.OwningProcess -EA SilentlyContinue).ProcessName -eq 'chrome' }).Count
Say "real lane untouched: browser procs=$real  ext->7744 sockets=$sock"
