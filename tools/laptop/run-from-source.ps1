# Run PIERRE's applier from source instead of the installed build.
#
# WHY NOT tools/release.ps1: that is a production deploy. It auto-updates every installation,
# including his dad's trial. Everything built today only needs to reach ONE machine, and running
# from source here has a blast radius of exactly this node and is reversible in one command.
#
# WHAT THIS MAKES LIVE: the widened voice gate (26 rules), Haiku/Sonnet tiering, ai_log.job_id and
# GET /jobs/:id/ai, ai_runs.job_id and the AI provenance badge, /ai-apply/performance.
#
# ONLY PIERRE'S INSTANCE. Ashraf's runs the installed build on :7745 with its own data dir and is
# deliberately left alone - one node changes at a time, so if something breaks it is unambiguous
# which change did it.
param([switch]$Rollback)
$ErrorActionPreference = 'Stop'
$V11   = 'C:\JAT\job-application-tracker\v11'
$APP   = "$V11\app"
$UD    = 'C:\Users\laptop\AppData\Roaming\jat11-app-pierre'
$EXE   = 'C:\Users\laptop\AppData\Local\Programs\jat11-app\Job Application Tracker.exe'
$EL    = "$APP\node_modules\electron\dist\electron.exe"
$TOKEN = '92226860c5f0b57faeb5514203c3e10dfcf6d02176db66ef55392d70cbd282af'
$KEEPER = 'JAT App Keeper (7744)'
function Say($m) { Write-Output ('  ' + $m) }

if ((Get-Process -Id $PID).SessionId -eq 0) { throw 'session 0 - run me through the bridge, Electron needs a desktop' }

# Only ever touch the process holding PIERRE's data dir. Dad's is on jat11-app-dad.
function Stop-Pierre {
  Get-CimInstance Win32_Process -Filter "Name='Job Application Tracker.exe' OR Name='electron.exe'" |
    Where-Object { $_.CommandLine -match 'jat11-app-pierre' -or ($_.CommandLine -match 'electron' -and $_.CommandLine -match 'JAT') } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 6
}

if ($Rollback) {
  Say 'ROLLBACK: back to the installed build'
  Stop-Pierre
  Enable-ScheduledTask -TaskName $KEEPER -ErrorAction SilentlyContinue | Out-Null
  $env:JAT_USERDATA = $UD; $env:JAT_PORT = '7744'
  Start-Process -FilePath $EXE -ArgumentList @("--user-data-dir=$UD")
  Start-Sleep -Seconds 30
  Say ('7744 listening: ' + @(Get-NetTCPConnection -LocalPort 7744 -State Listen -EA SilentlyContinue).Count)
  exit 0
}

# --- 1. back up the live database before any migration touches it -----------------------------
$bak = "C:\ProgramData\JAT-Remote\jat-pre-source-$(Get-Date -Format 'yyyyMMdd-HHmmss').db"
Copy-Item "$UD\jat.db" $bak -Force
foreach ($e in '-wal', '-shm') { if (Test-Path "$UD\jat.db$e") { Copy-Item "$UD\jat.db$e" "$bak$e" -Force } }
Say ("backup: $bak  ({0:N0} MB)" -f ((Get-Item $bak).Length / 1MB))

# --- 2. the keeper must not resurrect the installed build --------------------------------------
Disable-ScheduledTask -TaskName $KEEPER -ErrorAction SilentlyContinue | Out-Null
Say 'App Keeper disabled'

# --- 3. down, then up from source --------------------------------------------------------------
Stop-Pierre
Say ('installed build stopped; 7744 free: ' + (@(Get-NetTCPConnection -LocalPort 7744 -State Listen -EA SilentlyContinue).Count -eq 0))

$env:JAT_USERDATA = $UD
$env:JAT_PORT     = '7744'
Say 'starting from source'
Start-Process -FilePath $EL -ArgumentList @('.', "--user-data-dir=$UD") -WorkingDirectory $APP
Start-Sleep -Seconds 45

# --- 4. verify, and roll back automatically if the app did not come up --------------------------
$listening = @(Get-NetTCPConnection -LocalPort 7744 -State Listen -EA SilentlyContinue).Count
Say "7744 listening: $listening"
if ($listening -eq 0) {
  Say 'DID NOT BIND - rolling back to the installed build'
  Enable-ScheduledTask -TaskName $KEEPER -ErrorAction SilentlyContinue | Out-Null
  Start-Process -FilePath $EXE -ArgumentList @("--user-data-dir=$UD")
  exit 1
}

# NOT $H. PowerShell variables are CASE-INSENSITIVE, so `$h = Invoke-RestMethod ...` a few lines
# down silently overwrote the headers hashtable with the health response, and every check
# after it failed with 'cannot convert PSCustomObject to IDictionary' - reading exactly like
# the new endpoints were missing when they had been live from the first second.
$HDR = @{ 'X-JAT-Token' = $TOKEN }
try {
  $h = Invoke-RestMethod 'http://127.0.0.1:7744/health' -Headers $HDR -TimeoutSec 20
  Say ("health   : ok=" + $h.ok + " version=" + $h.version)
} catch { Say ('health FAILED: ' + $_.Exception.Message) }

# The point of the whole exercise: are the new endpoints actually there?
try {
  $p = Invoke-RestMethod 'http://127.0.0.1:7744/ai-apply/performance?days=7' -Headers $HDR -TimeoutSec 25
  Say ("performance endpoint: LIVE  (agent " + $p.submittedBy.agent + ", extension " + $p.submittedBy.extension + ")")
} catch { Say ('performance endpoint MISSING: ' + $_.Exception.Message) }

try {
  $q = Invoke-RestMethod 'http://127.0.0.1:7744/queue?limit=5' -Headers $HDR -TimeoutSec 25
  $jid = ($q.items | Select-Object -First 1).jobId
  $a = Invoke-RestMethod ("http://127.0.0.1:7744/jobs/$jid/ai") -Headers $HDR -TimeoutSec 25
  Say ("per-job AI log      : LIVE  (job $jid -> " + $a.calls + ' calls)')
} catch { Say ('per-job AI log MISSING: ' + $_.Exception.Message) }

$q2 = Invoke-RestMethod 'http://127.0.0.1:7744/queue?limit=5000' -Headers $HDR -TimeoutSec 40
Say ('queue intact        : ' + @($q2.items).Count + ' tasks')
Say ("rollback with: run-from-source.ps1 -Rollback   (backup at $bak)")
