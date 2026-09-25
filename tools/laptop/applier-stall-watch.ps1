# Detect the failure that costs whole nights: THE PIPELINE LOOKS PERFECTLY HEALTHY AND APPLIES TO
# NOTHING.
#
# Measured 2026-09-08: no application was dispatched between 03:02 and 11:54 UTC — almost nine
# hours — with 45 jobs runnable the entire time. Every existing guard reported success throughout:
#
#   * the app was up and listening on 7744 (the overnight monitor checks exactly this, and healed
#     nothing because nothing was down)
#   * /ext/link said connected=true, because the extension's one-minute flush alarm kept touching
#     /health — a heartbeat that proves the service worker is alive, not that it is applying
#   * chrome-keeper logged "ok" every five minutes, because a Chrome process existed
#
# Nobody was watching the one number that mattered: whether the dispatch counter was moving.
#
# So watch that. Every run compares the cumulative dispatch count against the last one recorded on
# disk. While the counter moves, this does nothing at all. When the counter sits still WHILE work is
# queued and nothing is in flight, the extension's pump has stopped asking for work, and the cure is
# the same one that fixed it by hand this morning: restart the applier lane's Chrome so its MV3
# service worker starts over.
#
# WHY 25 MINUTES: the pace is 12 applies an hour, so a healthy node dispatches about every five.
# Twenty-five minutes is five missed slots — far outside normal jitter, and far inside nine hours.
#
# WHAT IT WILL NOT DO:
#   * restart while something is genuinely in flight (active > 0) — a slow apply is not a stall
#   * restart when the queue is empty — that is idleness, and correct
#   * restart when auto-apply is switched off
#   * touch any Chrome carrying --user-data-dir; those are the AI agent's and the app-managed
#     lanes, and the applier is the real default profile with no profile directory (verified
#     against Secure Preferences in all three profiles on 2026-09-08)
$ErrorActionPreference = 'SilentlyContinue'
$TOKEN   = '92226860c5f0b57faeb5514203c3e10dfcf6d02176db66ef55392d70cbd282af'
$BASE    = 'http://127.0.0.1:7744'
$STATE   = 'C:\ProgramData\JAT-Remote\stall-state.json'
$LOG     = 'C:\ProgramData\JAT-Remote\stall-watch.log'
$EXE     = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$STALL_MINUTES = 25

function W($m) { ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) | Out-File -FilePath $LOG -Append -Encoding utf8 }

$live = $null
try { $live = Invoke-RestMethod "$BASE/auto-apply/live" -Headers @{ 'X-JAT-Token' = $TOKEN } -TimeoutSec 20 } catch {}
if (-not $live) { W 'app did not answer /auto-apply/live - leaving it to the app keeper'; exit 0 }

$dispatched = [int]$live.runSummary.counts.dispatched
$runnable   = [int]$live.queuedRunnable
$active     = [int]$live.active
$enabled    = [bool]$live.enabled

$prev = $null
if (Test-Path $STATE) { try { $prev = Get-Content $STATE -Raw | ConvertFrom-Json } catch {} }

# The counter moved, or this is the first ever run: record and stop. Nothing is wrong.
if (-not $prev -or [int]$prev.dispatched -ne $dispatched) {
  @{ dispatched = $dispatched; since = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content $STATE -Encoding UTF8
  exit 0
}

# The counter has not moved. Decide whether that is a stall or simply nothing to do.
if (-not $enabled) { exit 0 }
if ($runnable -le 0) { exit 0 }
if ($active -gt 0) { exit 0 }

$since = Get-Date
try { $since = [DateTime]::Parse($prev.since) } catch {}
$stalledFor = [int]((Get-Date) - $since).TotalMinutes
if ($stalledFor -lt $STALL_MINUTES) { exit 0 }

W ("STALLED: dispatched has sat at {0} for {1} min with {2} runnable and nothing in flight - restarting the applier lane" -f $dispatched, $stalledFor, $runnable)

# Only the real-default-profile tree. Anything carrying --user-data-dir belongs to another lane.
$killed = 0
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.ExecutablePath -eq $EXE -and $_.CommandLine -notmatch '--user-data-dir' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed++ }
W ("stopped {0} applier chrome process(es)" -f $killed)
Start-Sleep -Seconds 8

# Hand the relaunch to chrome-keeper rather than duplicating its flags here. It also refuses to
# start Chrome into a dead app, which is the right behaviour if the app went down in the meantime.
& powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\laptop\chrome-keeper.ps1'

# Reset the clock so a node that stays stalled is retried every STALL_MINUTES rather than on every
# five-minute tick. Keep the OLD dispatch count: if the restart worked, the next run sees the
# counter move and clears this by itself.
@{ dispatched = $dispatched; since = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content $STATE -Encoding UTF8

$after = @(Get-NetTCPConnection -RemotePort 7744 -State Established -ErrorAction SilentlyContinue |
  Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -eq 'chrome' }).Count
W ("after restart: chrome->7744 sockets={0}" -f $after)
