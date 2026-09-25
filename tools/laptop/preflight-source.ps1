# Can the laptop run the app FROM SOURCE instead of the installed build?
#
# Why this matters: every improvement built today - the widened voice gate, model tiering, the
# per-application AI log, the AI provenance badge - lives in the repo and is running NOWHERE. The
# laptop executes the installed 11.154.0 Electron build. The normal way to close that gap is
# tools/release.ps1, but that is a PRODUCTION deploy: it auto-updates Pierre's app and his dad's.
#
# Running from source on this one machine gets the changes live with a blast radius of exactly one
# node, and is reversible by re-enabling the keeper. This script only LOOKS - it changes nothing.
$V11 = 'C:\JAT\job-application-tracker\v11'
$APP = "$V11\app"

$el = Join-Path $APP 'node_modules\electron\dist\electron.exe'
Write-Output ("  electron binary : " + (Test-Path $el))
if (Test-Path $el) { Write-Output ("  electron version: " + (Get-Item $el).VersionInfo.ProductVersion) }

Write-Output ("  main entry      : " + (Test-Path (Join-Path $APP 'src\main.js')))
Write-Output ("  app version     : " + (Get-Content (Join-Path $APP 'package.json') -Raw | ConvertFrom-Json).version)

# Does the source carry today's work?
foreach ($probe in @(
  @{ f = 'src\db.js';            p = 'ALTER TABLE ai_log ADD COLUMN job_id';  n = 'per-job AI log' },
  @{ f = 'src\db.js';            p = 'ALTER TABLE ai_runs ADD COLUMN job_id'; n = 'AI provenance' },
  @{ f = 'src\ai\voice-check.js';p = 'proven track record';                   n = 'widened voice gate' },
  @{ f = 'src\ai\model-policy.js'; p = 'HAIKU_ALIAS';                         n = 'model tiering' },
  @{ f = 'src\server.js';        p = '/ai-apply/performance';                 n = 'performance endpoint' }
)) {
  $hit = Select-String -Path (Join-Path $APP $probe.f) -Pattern $probe.p -Quiet -ErrorAction SilentlyContinue
  Write-Output ("  {0,-22}: {1}" -f $probe.n, $hit)
}

Write-Output ''
Write-Output '  --- what is running now ---'
Get-CimInstance Win32_Process -Filter "Name='Job Application Tracker.exe'" |
  Where-Object { $_.CommandLine -notmatch '--type=' } |
  ForEach-Object { '    installed build pid ' + $_.ProcessId }
Write-Output ("    keeper task     : " + (Get-ScheduledTask -TaskName 'JAT App Keeper (7744)' -ErrorAction SilentlyContinue).State)
$db = 'C:\Users\laptop\AppData\Roaming\jat11-app-pierre\jat.db'
Write-Output ("    live DB         : {0:N0} MB, written {1}" -f ((Get-Item $db).Length / 1MB), (Get-Item $db).LastWriteTime)
Write-Output ("    free disk       : {0:N0} GB" -f ((Get-PSDrive C).Free / 1GB))
