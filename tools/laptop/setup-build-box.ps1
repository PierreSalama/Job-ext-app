# Stand the repo up on the laptop so builds and tests never run on Pierre's gaming PC again.
#
# The repo arrives as a git bundle (14 MB) rather than a file copy: the working tree is 1.2 GB of
# build output and node_modules, none of which needs to cross the wire, and a bundle carries the
# full history including the 181 commits that are not on GitHub.
#
# npm install pulls from the registry, which uses DOWNLOAD bandwidth. That direction is idle;
# it is the upload that was saturated and making his game stutter.
$ErrorActionPreference = 'Stop'
$ROOT   = 'C:\JAT'
$BUNDLE = 'C:\ProgramData\JAT-Remote\jat.bundle'

if (-not (Test-Path $BUNDLE)) { throw 'bundle missing' }
New-Item -ItemType Directory -Path $ROOT -Force | Out-Null

if (Test-Path "$ROOT\job-application-tracker\.git") {
  Write-Output '  repo exists - fetching the new commits'
  Set-Location "$ROOT\job-application-tracker"
  & git fetch "$BUNDLE" '+refs/heads/*:refs/remotes/bundle/*' 2>&1 | Select-Object -Last 3
  & git checkout -B main bundle/main 2>&1 | Select-Object -Last 2
} else {
  Write-Output '  cloning from the bundle'
  Set-Location $ROOT
  & git clone -b main "$BUNDLE" job-application-tracker 2>&1 | Select-Object -Last 3
}

Set-Location "$ROOT\job-application-tracker\v11"
Write-Output ('  HEAD: ' + (& git log --oneline -1))
Write-Output ('  tracked files: ' + (& git ls-files | Measure-Object).Count)
Write-Output ('  extension version: ' + (Get-Content 'extension\manifest.json' -Raw | ConvertFrom-Json).version)
