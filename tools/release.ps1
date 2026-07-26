# JAT v11 - release helper.
# Bumps all three versions in lockstep, mirrors the dashboard, syncs the working
# copy into ..\.v11-publish (the git repo for PierreSalama/Job-ext-app),
# commits, tags, and pushes - which triggers the CI release build.
#
#   .\tools\release.ps1 -Version 11.0.1 -Message "capture fixes"
#   .\tools\release.ps1 -Version 11.0.1 -Message "..." -NoPush   # stage only

param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Message,
  [switch]$NoPush
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot          # ...\v11
$Publish = Join-Path (Split-Path -Parent $Root) '.v11-publish'

if ($Version -notmatch '^11\.\d+\.\d+$') { throw "Version must be 11.x.y (got $Version)" }
if (-not (Test-Path $Publish)) { throw "publish repo not found at $Publish" }

# 1. lockstep version bump
$manifestPath = Join-Path $Root 'extension\manifest.json'
$pkgPath = Join-Path $Root 'app\package.json'
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$manifest.version = $Version
$pkg.version = $Version
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 20), $utf8NoBom)
[System.IO.File]::WriteAllText($pkgPath, ($pkg | ConvertTo-Json -Depth 20), $utf8NoBom)
$rootPkgPath = Join-Path $Root 'package.json'
$rootPkg = Get-Content $rootPkgPath -Raw | ConvertFrom-Json
$rootPkg.version = $Version
[System.IO.File]::WriteAllText($rootPkgPath, ($rootPkg | ConvertTo-Json -Depth 20), $utf8NoBom)
Write-Host "versions -> $Version (extension + app + root)" -ForegroundColor Green

# 2. mirror dashboard
node (Join-Path $Root 'tools\mirror.mjs')
if ($LASTEXITCODE -ne 0) { throw 'mirror failed' }

# 2b. version-sync gate (extension + app + root must match before we tag)
node (Join-Path $Root 'tools\validate-versions.mjs')
if ($LASTEXITCODE -ne 0) { throw 'version sync check failed' }

# 3. sync working copy -> publish repo (extension/, app/ sources, workflows, tools, docs)
$pairs = @(
  @{ src = 'extension'; dst = 'extension' },
  @{ src = 'app\src'; dst = 'app\src' },
  @{ src = 'app\build'; dst = 'app\build' },
  @{ src = 'app\package.json'; dst = 'app\package.json' },
  @{ src = 'package.json'; dst = 'package.json' },
  @{ src = 'tests'; dst = 'tests' },
  @{ src = 'tools'; dst = 'tools' },
  @{ src = 'docs'; dst = 'docs' },
  @{ src = '.github'; dst = '.github' },
  @{ src = 'README.md'; dst = 'README.md' }
)
# The bundled JobSpy worker is a 130 MB PyInstaller BUILD ARTIFACT that CI regenerates from
# source (see the "Build bundled JobSpy discovery worker" step in .github/workflows/release.yml,
# which rm -rf's these very directories first). Syncing it made the push fail outright:
#   remote: error: File app/build/discovery/jat-discovery.exe is 130.95 MB; exceeds GitHub's 100 MB limit
#   ! [remote rejected] v11.88.18 -> v11.88.18 (pre-receive hook declined)
# origin/v11 has never carried a single file under app/build. Excluded by FULL path so the
# similarly-named SOURCE tree app\src\discovery is untouched (a bare /XD discovery would kill it).
$excludeDirs = @(
  (Join-Path $Root 'app\build\discovery'),
  (Join-Path $Root 'app\build\discovery-work'),
  (Join-Path $Root 'app\build\discovery-spec')
)
foreach ($p in $pairs) {
  $src = Join-Path $Root $p.src
  $dst = Join-Path $Publish $p.dst
  if (Test-Path $src -PathType Container) {
    # /XF: never sync local secrets into the public publish repo (GitHub push
    # protection blocks them, and they must never leave this machine).
    robocopy $src $dst /MIR /NFL /NDL /NJH /NJS /XD node_modules dist @excludeDirs /XF .cws-credentials.json *.local.json | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $($p.src)" }
  } elseif (Test-Path $src) {
    New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
    Copy-Item $src $dst -Force
  }
}
Write-Host "synced -> $Publish" -ForegroundColor Green

# 4. commit + tag + push
Push-Location $Publish
try {
  git add -A
  git commit -m "v$Version - $Message"
  git tag "v$Version"
  if (-not $NoPush) {
    # CHECK THE PUSH. This used to print "pushed - CI is building" unconditionally, so a REJECTED
    # push still reported success (2026-07-25: GitHub blocked the 130 MB discovery binary and the
    # script cheerfully claimed the release was building — nothing was published, and the only clue
    # was buried in the log). A failed release must fail loudly, or someone waits on a build that
    # will never exist.
    git push origin HEAD
    if ($LASTEXITCODE -ne 0) { throw "git push of the branch FAILED (exit $LASTEXITCODE) - nothing was released. See the errors above." }
    git push origin "v$Version"
    if ($LASTEXITCODE -ne 0) { throw "git push of tag v$Version FAILED (exit $LASTEXITCODE) - no release build was triggered." }
    Write-Host "pushed - CI is building the v$Version release" -ForegroundColor Green
  } else {
    Write-Host "staged locally (NoPush). Push with: git push origin HEAD; git push origin v$Version" -ForegroundColor Yellow
  }
} finally {
  Pop-Location
}
