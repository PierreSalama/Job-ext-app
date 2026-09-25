# Keep ONLY the app alive on 7744, against PIERRE'S data dir.
#
# Port 7744 is mandatory: the extension hardcodes BASE=localhost:7744 and its manifest grants
# host_permissions for 7744 only, so a hand-loaded extension cannot reach any other port.
#
# The data dir is equally mandatory and was the first bug here: an earlier version set
# $env:JAT_USERDATA and the app STILL came up on the default 'jat11-app' directory - a blank profile
# with its own token, queue and settings. Pierre paired his extension to that empty instance, so
# everything looked connected and did nothing. Pass Electron's own --user-data-dir as well, and
# VERIFY afterwards by token rather than trusting the launch.
#
# ---------------------------------------------------------------------------------------------
# 2026-09-08: RESTART WHAT IS ACTUALLY RUNNING, NOT WHAT SHIPPED.
#
# This task was found DISABLED, so nothing would have restarted the app for the eight hours Pierre
# is away. It was disabled for a good reason: the node runs the app FROM SOURCE out of
# C:\JAT\job-application-tracker\v11 (electron.exe with '.'), and this keeper only knew how to start
# the PACKAGED build. Re-enabling it as written would have meant that the first crash silently
# replaced the build carrying today's fixes with an older installed one - against the same data dir,
# so nothing would have looked wrong.
#
# So the keeper now prefers the source tree when it is present and launchable, and falls back to the
# packaged exe only when it is not. Enabling it is then strictly better than leaving it off.
$ErrorActionPreference = 'SilentlyContinue'
$EXE   = 'C:\Users\laptop\AppData\Local\Programs\jat11-app\Job Application Tracker.exe'
$SRC   = 'C:\JAT\job-application-tracker\v11\app'
$EL    = "$SRC\node_modules\electron\dist\electron.exe"
$UD    = 'C:\Users\laptop\AppData\Roaming\jat11-app-pierre'
$TOKEN = '92226860c5f0b57faeb5514203c3e10dfcf6d02176db66ef55392d70cbd282af'
$LOG   = 'C:\Users\laptop\app-keeper.log'
function W($m) { ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) | Out-File -FilePath $LOG -Append -Encoding utf8 }

# Healthy = listening AND answering with PIERRE's token. A wrong-profile instance is NOT healthy.
if (Get-NetTCPConnection -LocalPort 7744 -State Listen -ErrorAction SilentlyContinue) {
  try {
    Invoke-RestMethod 'http://127.0.0.1:7744/settings' -Headers @{ 'X-JAT-Token' = $TOKEN } -TimeoutSec 10 | Out-Null
    exit 0    # right instance, nothing to do - stay silent so the log only ever holds real events
  } catch {
    # Listening but rejecting Pierre's token => wrong profile. Replace it.
    W 'port 7744 answered but rejected Pierre token - wrong profile, replacing'
    # KILL PIERRE'S INSTANCE, NOT EVERY INSTANCE.
    #
    # This used to be `taskkill /IM 'Job Application Tracker.exe' /T /F`, which kills by IMAGE NAME:
    # every process called that, on the whole machine. Ashraf's app runs the same binary against
    # jat11-app-dad on port 7745, so Pierre's keeper was killing Ashraf's applier as collateral
    # every time this branch fired, and this keeper runs every three minutes.
    #
    # Caught live 2026-09-08: the keeper logged "wrong profile, replacing" at 12:29:12 and Ashraf's
    # four processes all restarted at 12:30:2x. The overnight monitor put him back, so from the
    # outside it looked like his app was mysteriously flaky rather than being shot by a keeper that
    # has no business touching it. He is on a trial; his node going down is not a cosmetic problem.
    #
    # Match on the DATA DIRECTORY instead, which is the only thing that actually distinguishes the
    # two instances, and take the child processes with it by PID rather than by name.
    $mine = @(Get-CimInstance Win32_Process -Filter "Name='Job Application Tracker.exe' OR Name='electron.exe'" |
      Where-Object { $_.CommandLine -match [regex]::Escape($UD) })
    W ("stopping {0} process(es) on {1}" -f $mine.Count, $UD)
    foreach ($p in $mine) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep 6
  }
}

# STALE LOCK. jat.db.lock is a plain FILE, not an advisory OS lock, so a reader that dies without
# closing leaves it behind forever and the app cannot tell it from a live one. Every endpoint that
# reads settings then returns 500, and because hostAllowed() swallows that throw, remote callers see
# "403 bad host" instead - a symptom that points at networking and has nothing to do with it.
#
# Live 2026-09-08: a diagnostic script opened the live profile from a second process and threw before
# closing. Restarting the app alone would NOT have fixed it - the fresh app meets the same lock and
# fails the same way, so this keeper would have restarted it every three minutes all night.
#
# Only ever remove it when NO app process is running, so a healthy instance's lock is never touched.
$stillRunning = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='Job Application Tracker.exe'" |
  Where-Object { $_.CommandLine -match 'jat11-app-pierre' -or $_.CommandLine -match 'JAT' })
$lock = Join-Path $UD 'jat.db.lock'
if ((Test-Path $lock) -and $stillRunning.Count -eq 0) {
  W "removing stale $lock (no app process is running to own it)"
  Remove-Item $lock -Force -ErrorAction SilentlyContinue
}

$env:JAT_PORT     = '7744'
$env:JAT_USERDATA = $UD

# Prefer source. Test-Path on BOTH the electron binary and the app entry, because a half-synced or
# half-deleted source tree that starts and immediately exits would leave the node dead while this
# script reported success.
if ((Test-Path $EL) -and (Test-Path (Join-Path $SRC 'package.json'))) {
  W "app down - starting FROM SOURCE ($SRC)"
  Start-Process -FilePath $EL -ArgumentList @('.', "--user-data-dir=$UD") -WorkingDirectory $SRC
} else {
  W "app down - source tree not usable, starting the PACKAGED build"
  Start-Process -FilePath $EXE -ArgumentList @("--user-data-dir=$UD")
}

# VERIFY, rather than trusting the launch. If the source start did not come up, fall back once to
# the packaged build: a node running slightly older code still applies, a dead node does not.
Start-Sleep -Seconds 40
try {
  Invoke-RestMethod 'http://127.0.0.1:7744/settings' -Headers @{ 'X-JAT-Token' = $TOKEN } -TimeoutSec 10 | Out-Null
  W 'up and answering on 7744'
} catch {
  W 'did NOT come up - falling back to the packaged build'
  Start-Process -FilePath $EXE -ArgumentList @("--user-data-dir=$UD")
}
