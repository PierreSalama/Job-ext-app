# Overnight run recorder. One JSON line every 5 minutes, on the laptop, independent of any
# Claude session or SSH connection. If nobody is watching at 4am, this is the only record that
# the run happened at all.
#
# Deliberately writes to disk rather than holding state in memory: the whole point is to survive
# the app restarting, Chrome restarting, the supervisor dying, or the box rebooting.
$ErrorActionPreference = 'SilentlyContinue'
$TOKEN = '92226860c5f0b57faeb5514203c3e10dfcf6d02176db66ef55392d70cbd282af'
$BASE  = 'http://127.0.0.1:7744'
$OUT   = "C:\ProgramData\JAT-Remote\overnight-$(Get-Date -Format 'yyyyMMdd').jsonl"
$H     = @{ 'X-JAT-Token' = $TOKEN }

function Get-Json($path) {
  try { return Invoke-RestMethod "$BASE$path" -Headers $H -TimeoutSec 20 } catch { return $null }
}

$live  = Get-Json '/auto-apply/live'
$usage = Get-Json '/ai/usage'
$ext   = Get-Json '/ext/link'
$so    = Get-Json '/auto-apply/signed-out'

# Per-provider AI totals, so a provider silently dying overnight is visible in the morning.
$prov = @{}
if ($usage -and $usage.usage) {
  foreach ($u in $usage.usage) {
    $prov[$u.provider] = @{ calls = $u.calls; ok = $u.ok_calls; ms = $u.total_ms }
  }
}

$rec = [ordered]@{
  ts          = (Get-Date).ToString('o')
  enabled     = $live.enabled
  status      = $live.status
  active      = $live.active
  scheduled   = $live.scheduled
  queuedRunnable = $live.queuedRunnable
  dispatchedDay  = $live.pacing.dispatchedDay
  dailyCap    = $live.pacing.dailyCap
  session     = $live.session
  runCounts   = $live.runSummary.counts
  extVersion  = $ext.extLink.version
  extConnected= $ext.extLink.connected
  signedOut   = $so.signedOut
  ai          = $prov
  # A source still being searched that has produced nothing for days. LinkedIn was exactly this for
  # six days and nothing said so, because a dead scraper and a quiet week both report found:0.
  deadSources = @($live.health.deadSources | ForEach-Object { $_.platform })
  chromeProcs = @(Get-Process chrome -EA SilentlyContinue).Count
  appUp       = @(Get-NetTCPConnection -LocalPort 7744 -State Listen -EA SilentlyContinue).Count
}

($rec | ConvertTo-Json -Depth 8 -Compress) | Add-Content -Path $OUT -Encoding UTF8

# Self-heal: if the app died, bring it back. An overnight test that silently stops after 20 minutes
# is worse than no test, because it looks like a result.
if ($rec.appUp -eq 0) {
  '  app down - restarting via keeper' | Add-Content "C:\ProgramData\JAT-Remote\overnight-heal.log"
  & powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\laptop\laptop-app-keeper.ps1'
}

# Self-heal 2: the pipeline can be entirely UP and still apply to nothing — the app listening, the
# extension answering /health, Chrome running, and the dispatch counter frozen. That is what
# happened between 03:02 and 11:54 UTC on 2026-09-08, and every check above reported healthy for
# all nine hours of it. The stall watcher owns that one question: is the counter actually moving?
& powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\laptop\applier-stall-watch.ps1'

# A dead source is not something to heal, it is something to SAY. Disabling a job source is a
# judgement about Pierre's search, so this shouts and stops there.
if ($rec.deadSources.Count) {
  ("  DEAD SOURCE: {0} still being searched and has produced no job in days" -f ($rec.deadSources -join ', ')) |
    Add-Content "C:\ProgramData\JAT-Remote\overnight-heal.log"
}

# Self-heal 3: ASHRAF'S APP ON 7745.
#
# His launcher ("JAT Dad Instance") checks port 7745 and starts the app, then runs the Chrome for
# Testing supervisor in the FOREGROUND so the task hosts it. The task is set to IgnoreNew, which is
# right for the supervisor and fatal for the app check: once the supervisor is up, the task never
# starts again, so the lines above it never run again either. Found 2026-09-08 with his app down and
# the supervisor 40 minutes into a healthy run - nothing on the machine could have brought it back.
#
# This monitor already runs every five minutes and never blocks, so the check belongs here. It only
# ever STARTS a missing app; it never touches a running one, and it never touches the supervisor.
if (-not (Get-NetTCPConnection -LocalPort 7745 -State Listen -ErrorAction SilentlyContinue)) {
  '  Ashraf app (7745) down - restarting' | Add-Content "C:\ProgramData\JAT-Remote\overnight-heal.log"
  $env:JAT_USERDATA = 'C:\Users\laptop\AppData\Roaming\jat11-app-dad'
  $env:JAT_PORT     = '7745'
  Start-Process 'C:\Users\laptop\AppData\Local\Programs\jat11-app\Job Application Tracker.exe' `
    -ArgumentList '--user-data-dir=C:\Users\laptop\AppData\Roaming\jat11-app-dad'
}
