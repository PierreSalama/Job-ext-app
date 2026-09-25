# Pull the latest bundle into the laptop's checkout, install deps if needed, and run the suite.
#
# This is the whole point of the build box: Pierre games on the 12-core PC, and a 2,100-test run
# there cost him frames. The laptop is 4 cores and slower, which is fine — he said explicitly that
# slower is acceptable if his machine stays smooth.
#
# git writes progress to stderr, and under $ErrorActionPreference='Stop' PowerShell turns that into
# a fatal NativeCommandError even on success. That killed the first attempt at this script, so git
# is called with stderr folded into stdout and the exit code checked explicitly instead.
$ErrorActionPreference = 'Continue'
$ROOT   = 'C:\JAT\job-application-tracker'
$BUNDLE = 'C:\ProgramData\JAT-Remote\jat.bundle'
$V11    = "$ROOT\v11"

Set-Location $ROOT
& git fetch $BUNDLE '+refs/heads/main:refs/remotes/bundle/main' 2>&1 | Out-Null
& git reset --hard bundle/main 2>&1 | Out-Null
Write-Output ('  HEAD: ' + (& git log --oneline -1))

Set-Location $V11
$hasFix = Select-String -Path 'app\src\db.js' -Pattern 'ALTER TABLE ai_runs ADD COLUMN job_id' -Quiet
Write-Output "  job_id migration present: $hasFix"

if (-not (Test-Path 'app\node_modules')) {
  Write-Output '  installing dependencies (first run, downloads from the npm registry)'
  Set-Location "$V11\app"
  & npm install --no-audit --no-fund 2>&1 | Select-Object -Last 4
  Set-Location $V11
}

Write-Output ''
Write-Output '  --- suite ---'
Set-Location "$V11\app"
& npm test 2>&1 | Select-Object -Last 14
