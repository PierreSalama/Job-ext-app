# Run the AI apply lane forever, on the laptop, independent of any Claude session or SSH connection.
#
# The keeper itself (ai-lane-keeper.mjs) is the supervisor that gives the AI lane the heartbeat it
# never had. This wrapper is what makes it a SERVICE: it survives the session that started it, the
# app restarting, and the box rebooting.
#
# CONFIG IS A FILE, NOT A CONSTANT. Every other script in this folder hardcodes Pierre's token, and
# for a personal tool that was fine. The stated end goal for JAT is a harness anyone can run with
# their own model and their own credentials, so nothing here knows who Pierre is — it reads
# ai-lane.json and would run identically on a stranger's machine.
$ErrorActionPreference = 'Stop'

$Root = 'C:\ProgramData\JAT-Remote'
$Cfg  = Join-Path $Root 'ai-lane.json'
$Log  = Join-Path $Root ("ai-lane-" + (Get-Date -Format 'yyyyMMdd') + ".log")

function Say($msg) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $Log -Value $line
  Write-Output $line
}

if (-not (Test-Path $Cfg)) { Say "no config at $Cfg - run install-ai-lane.ps1 first"; exit 2 }
$c = Get-Content $Cfg -Raw | ConvertFrom-Json

# ONE INSTANCE. The scheduled task repeats every 10 minutes as a self-heal, so the common case is
# this script starting while a healthy keeper is already running. Scheduled Tasks' own
# MultipleInstances:IgnoreNew covers the task, but not a keeper started by hand from a terminal, so
# check the actual processes too.
$mine = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*ai-lane-keeper.mjs*' }
if ($mine) { Say ("already running (pid " + ($mine.ProcessId -join ',') + ") - nothing to do"); exit 0 }

$script = Join-Path $Root 'ai-lane-keeper.mjs'
if (-not (Test-Path $script)) { Say "keeper script missing at $script"; exit 3 }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Say 'node is not on PATH for this task principal'; exit 4 }

$args = @(
  $script,
  '--base', $c.base,
  '--token', $c.token,
  '--profile', $c.profileId,
  '--cap', $c.cap,
  '--gap', $c.gap
)
if ($c.skipHosts) { $args += @('--skip-hosts', $c.skipHosts) }

Say ("starting keeper: base=" + $c.base + " cap=" + $c.cap + " gap=" + $c.gap + "s skip=" + $c.skipHosts)

# Run it in the foreground of THIS task so the task stays alive alongside the keeper. If node dies,
# this exits, and the next 10-minute repetition starts a fresh one. The token is passed as an
# argument rather than written into the log line above, so it never lands in the log file.
& $node @args 2>&1 | ForEach-Object { Add-Content -Path $Log -Value $_ }
Say ("keeper exited with code " + $LASTEXITCODE)
