# Deploy the staged extension into the lane that is ACTUALLY running.
#
# The existing sync-extension.ps1 targets the Chrome-for-Testing lane: it disables the
# "JAT Pierre Applier" task and kills chrome procs carrying --user-data-dir=cft-profile-pierre.
# That lane has been dead since 2026-08-22 (task Disabled, rc=267014). Since 2026-08-20 the applier
# is Pierre's REAL default-profile Chrome, with the extension registered in-profile at
# location=4 pointing to chrome-extension-pierre. So the old script would copy the files and never
# reload the browser that holds them — and robocopy would fight a directory Chrome still has open.
#
# MUST BE RUN FROM SESSION 1 (through the bridge). Launching Chrome from an SSH session lands it in
# session 0, where it has no desktop and exits within seconds. That was measured tonight.
#
# -Force deploys even when the versions match. THE VERSION IS NOT THE CONTENT. This script skipped
# on equal versions, which meant every fix made without a version bump was staged, reported as
# "current", and never actually installed - the exact silent-gap failure the header above says this
# tool exists to prevent, just one level further in. Measured 2026-09-08: two verified extension
# fixes deployed cleanly and ran nothing, because the manifest still said 11.154.0.
param([switch]$Force)
$ErrorActionPreference = 'Stop'
$EXT   = 'C:\ProgramData\JAT-Remote\chrome-extension-pierre'
$STAGE = 'C:\ProgramData\JAT-Remote\ext-stage'
$EXE   = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$TASK  = 'JAT Chrome Keeper (real profile)'
function Say($m) { Write-Output ('  ' + $m) }

if ((Get-Process -Id $PID).SessionId -eq 0) { throw 'running in session 0 - launch me through the bridge, not SSH' }
if (-not (Test-Path (Join-Path $STAGE 'manifest.json'))) { throw 'no staged manifest' }

$newVer = (Get-Content (Join-Path $STAGE 'manifest.json') -Raw | ConvertFrom-Json).version
$oldVer = 'none'
if (Test-Path (Join-Path $EXT 'manifest.json')) {
  $oldVer = (Get-Content (Join-Path $EXT 'manifest.json') -Raw | ConvertFrom-Json).version
}
Say "installed=$oldVer  staged=$newVer"
if (($oldVer -eq $newVer) -and (-not $Force)) { Write-Output 'ALREADY_CURRENT'; exit 0 }
if ($Force) { Say 'forced: installing over the same version' }

# --- keeper must not relaunch Chrome mid-copy ---------------------------------------------------
Say 'disabling Chrome Keeper'
Disable-ScheduledTask -TaskName $TASK -EA SilentlyContinue | Out-Null

# --- Chrome holds the extension directory open; it has to go down --------------------------------
Say 'closing the real-profile Chrome'
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.ExecutablePath -eq $EXE } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
Start-Sleep -Seconds 6
$live = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.ExecutablePath -eq $EXE }).Count
if ($live -gt 0) { Enable-ScheduledTask -TaskName $TASK -EA SilentlyContinue | Out-Null; throw "Chrome still up ($live) - aborting before touching files" }

# --- backup, following the naming this folder already uses (.bak-11.105.0 etc) --------------------
# On a forced same-version deploy the backup name would collide with an existing backup of the very
# thing being replaced. Keep the FIRST one: it is the last known-good copy, and overwriting it with
# a half-broken build would destroy the only rollback.
$bak = "$EXT.bak-$oldVer"
if ((Test-Path $bak) -and $Force) { Say "keeping the existing $(Split-Path $bak -Leaf) as the rollback point" }
elseif (Test-Path $bak) { Remove-Item $bak -Recurse -Force }
Say "backing up $oldVer -> $(Split-Path $bak -Leaf)"
if (-not ((Test-Path $bak) -and $Force)) { $null = robocopy $EXT $bak /MIR /NFL /NDL /NJH /NJS /R:1 /W:1 }
if (-not (Test-Path (Join-Path $bak 'manifest.json'))) { Enable-ScheduledTask -TaskName $TASK -EA SilentlyContinue | Out-Null; throw 'backup failed - nothing changed' }

# --- install ------------------------------------------------------------------------------------
Say 'installing'
$null = robocopy $STAGE $EXT /MIR /NFL /NDL /NJH /NJS /R:2 /W:2
$after = (Get-Content (Join-Path $EXT 'manifest.json') -Raw | ConvertFrom-Json).version
Say "installed version now: $after"
if ($after -ne $newVer) { throw "install did not take ($after)" }
Say ("files: " + @(Get-ChildItem $EXT -Recurse -File).Count)

# --- bring the lane back up, from THIS session ---------------------------------------------------
Enable-ScheduledTask -TaskName $TASK -EA SilentlyContinue | Out-Null
Say 'starting Chrome (session 1)'
Start-Process -FilePath $EXE -ArgumentList '--no-first-run', '--no-default-browser-check'

Write-Output ''
Write-Output '--- VERIFY ---'
$sp = Join-Path 'C:\Users\laptop\AppData\Local\Google\Chrome\User Data\Default' 'Secure Preferences'
for ($i = 0; $i -lt 8; $i++) {
  Start-Sleep -Seconds 15
  $sock = @(Get-NetTCPConnection -RemotePort 7744 -State Established -EA SilentlyContinue |
    Where-Object { (Get-Process -Id $_.OwningProcess -EA SilentlyContinue).ProcessName -eq 'chrome' }).Count
  Say ("t+" + (15 * ($i + 1)) + "s  chrome->7744 = $sock")
  if ($sock -gt 0) { break }
}
$j = Get-Content $sp -Raw | ConvertFrom-Json
$e = $j.extensions.settings.ehpabielnbljajggjmggngeaemfjpfhn
Say ("extension: location=" + $e.location + "  disable_reasons=" + $e.disable_reasons + "  dev_mode=" + $j.extensions.ui.developer_mode)
Say "rollback if needed: robocopy `"$bak`" `"$EXT`" /MIR"
