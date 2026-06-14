# JAT v11 — release helper.
# Bumps all three versions in lockstep, mirrors the dashboard, syncs the working
# copy into ..\.v11-publish (the git repo for PierreSalama/Job-ext-app),
# commits, tags, and pushes — which triggers the CI release build.
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
$manifest | ConvertTo-Json -Depth 20 | Set-Content $manifestPath -Encoding utf8
$pkg | ConvertTo-Json -Depth 20 | Set-Content $pkgPath -Encoding utf8
$rootPkgPath = Join-Path $Root 'package.json'
$rootPkg = Get-Content $rootPkgPath -Raw | ConvertFrom-Json
$rootPkg.version = $Version
$rootPkg | ConvertTo-Json -Depth 20 | Set-Content $rootPkgPath -Encoding utf8
Write-Host "versions → $Version (extension + app + root)" -ForegroundColor Green

# 2. mirror dashboard
node (Join-Path $Root 'tools\mirror.mjs')
if ($LASTEXITCODE -ne 0) { throw 'mirror failed' }

# 2b. version-sync gate (extension + app + root must match before we tag)
node (Join-Path $Root 'tools\validate-versions.mjs')
if ($LASTEXITCODE -ne 0) { throw 'version sync check failed' }

# 3. sync working copy → publish repo (extension/, app/ sources, workflows, tools, docs)
$pairs = @(
  @{ src = 'extension'; dst = 'extension' },
  @{ src = 'app\src'; dst = 'app\src' },
  @{ src = 'app\build'; dst = 'app\build' },
  @{ src = 'app\package.json'; dst = 'app\package.json' },
  @{ src = 'package.json'; dst = 'package.json' },
  @{ src = 'tools'; dst = 'tools' },
  @{ src = '.github'; dst = '.github' },
  @{ src = 'README.md'; dst = 'README.md' }
)
foreach ($p in $pairs) {
  $src = Join-Path $Root $p.src
  $dst = Join-Path $Publish $p.dst
  if (Test-Path $src -PathType Container) {
    robocopy $src $dst /MIR /NFL /NDL /NJH /NJS /XD node_modules dist | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $($p.src)" }
  } elseif (Test-Path $src) {
    New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
    Copy-Item $src $dst -Force
  }
}
Write-Host "synced → $Publish" -ForegroundColor Green

# 4. commit + tag + push
Push-Location $Publish
try {
  git add -A
  git commit -m "v$Version — $Message"
  git tag "v$Version"
  if (-not $NoPush) {
    git push origin HEAD
    git push origin "v$Version"
    Write-Host "pushed — CI is building the v$Version release" -ForegroundColor Green
  } else {
    Write-Host "staged locally (NoPush). Push with: git push origin HEAD; git push origin v$Version" -ForegroundColor Yellow
  }
} finally {
  Pop-Location
}
