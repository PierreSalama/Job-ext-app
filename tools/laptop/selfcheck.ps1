# Run the AI lane self check. Registered to fire every three hours.
$ErrorActionPreference = 'Stop'
$Root = 'C:\ProgramData\JAT-Remote'
$Log  = Join-Path $Root ("selfcheck-" + (Get-Date -Format 'yyyyMM') + ".log")
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Add-Content $Log ("{0}  node not on PATH" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')); exit 3 }
& $node (Join-Path $Root 'ai-lane-selfcheck.mjs') 2>&1 | ForEach-Object { Add-Content -Path $Log -Value $_ }
Add-Content -Path $Log -Value ''
