# Refill the queue from the Canadian ATS boards, on a schedule.
#
# The AI lane drained its 12 workable jobs in three days and then logged 704 consecutive idle ticks,
# because discovery only refills from Indeed and the AI browser cannot get past Indeed's Cloudflare.
# A supply line that has to be run by hand is a supply line that stops the moment nobody is watching.
$ErrorActionPreference = 'Stop'
$Root = 'C:\ProgramData\JAT-Remote'
$Cfg  = Join-Path $Root 'ai-lane.json'
$Log  = Join-Path $Root ("ai-lane-feed-" + (Get-Date -Format 'yyyyMM') + ".log")

function Say($m) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -Path $Log -Value $line
  Write-Output $line
}

if (-not (Test-Path $Cfg)) { Say "no config at $Cfg"; exit 2 }
$c = Get-Content $Cfg -Raw | ConvertFrom-Json
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Say 'node not on PATH'; exit 3 }

Say 'feeding from the Canadian ATS boards'
& $node (Join-Path $Root 'feed-ca-boards.mjs') '--base' $c.base '--token' $c.token 2>&1 |
  ForEach-Object { Add-Content -Path $Log -Value ("    " + $_) }
Say ("feed exited " + $LASTEXITCODE)
