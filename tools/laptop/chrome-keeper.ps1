# JAT Chrome Keeper - keeps the APPLIER lane's Chrome alive and actually TALKING.
#
# The applier is Pierre's Chrome running the hand-loaded JAT extension
# (id ehpabielnbljajggjmggngeaemfjpfhn) against the app on 7744.
#
# ---------------------------------------------------------------------------------------------
# WHICH BROWSER IS THE APPLIER: the REAL DEFAULT PROFILE, launched with no --user-data-dir at all.
#
# Verified directly on 2026-09-08, after I got this wrong once and shipped a keeper that started the
# wrong browser. The extension is registered in exactly one place:
#
#   C:\Users\laptop\AppData\Local\Google\Chrome\User Data\Default   ext=True  location=4  dev_mode=True
#   ...\jat11-app-pierre\chrome-profiles\chrome-default             ext=False
#   ...\jat11-app-pierre\chrome-profiles\chrome-prof_<agent id>     ext=False
#
# The last two are the app-managed browser and the AI agent's browser. Neither can apply, and
# launching one produces a browser that will never connect while the log cheerfully reports a
# running process.
#
# ---------------------------------------------------------------------------------------------
# TWO BUGS THIS REPLACES, both found live while Pierre was away and could not intervene.
#
# 1. IT COULD NOT TELL THE APPLIER FROM THE AI AGENT'S BROWSER.
#    Detection was "branded chrome.exe, no --type=, command line does not contain JAT-Remote". The
#    agent's browser runs from jat11-app-pierre\chrome-profiles\... which contains no such string,
#    so it passed the test. The keeper found the agent's browser, declared the applier healthy, and
#    did nothing. Its own log said so for 25 minutes:
#
#        ok: real-profile Chrome running (pid 39560), ext->7744 sockets=0
#
#    Meanwhile 45 runnable jobs sat undispatched because nothing was asking for work.
#
# 2. IT COMPUTED THE SOCKET COUNT AND THEN IGNORED IT.
#    A Chrome process is not an applier. The extension is an MV3 service worker: it gets evicted,
#    and after the app restarts it can stay evicted. A browser with no socket to 7744 applies to
#    nothing, and the old keeper logged that state as "ok".
#
# Now the applier is identified by the ABSENCE of --user-data-dir, and a running browser with no
# socket is treated as broken - but only after two consecutive misses, because one miss is normal
# while an MV3 worker sleeps between its one-minute alarms.
#
# RULES KEPT FROM THE ORIGINAL:
#   * never launch Chrome into a dead app - wait for 7744 first
#   * never touch the AI agent's or the app-managed browser; they are other lanes with own profiles
$ErrorActionPreference = 'SilentlyContinue'
$LOG   = 'C:\Users\laptop\chrome-keeper.log'
$STATE = 'C:\Users\laptop\chrome-keeper-misses.txt'
$EXE   = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
function W($m) { ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) | Out-File -FilePath $LOG -Append -Encoding utf8 }

function Get-Applier {
  @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
    $_.ExecutablePath -eq $EXE -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '--user-data-dir'
  })
}
function Get-Talking {
  @(Get-NetTCPConnection -RemotePort 7744 -State Established -ErrorAction SilentlyContinue |
    Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -eq 'chrome' }).Count
}

$applier = Get-Applier
$talking = Get-Talking
$misses = 0
if (Test-Path $STATE) { $misses = [int](Get-Content $STATE -Raw).Trim() }

if ($applier.Count -gt 0 -and $talking -gt 0) {
  '0' | Set-Content $STATE
  W ("ok: applier running (pid {0}), ext->7744 sockets={1}" -f $applier[0].ProcessId, $talking)
  exit 0
}

if (-not (Get-NetTCPConnection -LocalPort 7744 -State Listen -ErrorAction SilentlyContinue)) {
  W 'app is NOT listening on 7744 - leaving Chrome alone until the app keeper brings it up'
  exit 0
}

if ($applier.Count -gt 0 -and $talking -eq 0) {
  $misses++
  $misses | Set-Content $STATE
  if ($misses -lt 2) {
    W ("applier running (pid {0}) but no socket - miss {1}/2, giving the service worker another cycle" -f $applier[0].ProcessId, $misses)
    exit 0
  }
  W ("applier running (pid {0}) but SILENT for {1} checks - restarting it" -f $applier[0].ProcessId, $misses)
  # Only the default-profile tree. Anything carrying --user-data-dir belongs to another lane.
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.ExecutablePath -eq $EXE -and $_.CommandLine -notmatch '--user-data-dir' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 6
  $applier = @()
}

if ($applier.Count -eq 0) {
  # NO --user-data-dir. The extension is already registered in the default profile, so a plain
  # launch loads it; adding one starts a stranger that never connects.
  W 'no applier Chrome - starting one on the default profile'
  Start-Process -FilePath $EXE -ArgumentList @('--no-first-run', '--no-default-browser-check')
  Start-Sleep -Seconds 35
}

'0' | Set-Content $STATE
W ("after restart: applier procs={0} ext->7744 sockets={1}" -f (Get-Applier).Count, (Get-Talking))
