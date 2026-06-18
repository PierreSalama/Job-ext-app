# JAT v11 - Chrome Web Store publish helper (update the unlisted/private item).
#
# This pushes a new extension version to the Chrome Web Store via the official
# CWS API, so updating the store item becomes ONE command instead of clicking
# through the Developer Dashboard. Chrome then auto-updates every install within
# hours. The companion desktop app keeps its OWN GitHub auto-update (release.ps1).
#
#   .\tools\cws-publish.ps1                       # packages current extension + uploads + publishes
#   .\tools\cws-publish.ps1 -Zip path\to.zip      # use a specific zip
#   .\tools\cws-publish.ps1 -UploadOnly           # upload a draft, don't publish yet
#
# ONE-TIME SETUP (you do this once - it needs your Google account, which a tool can't):
#   1. https://console.cloud.google.com -> create a project -> enable "Chrome Web Store API".
#   2. APIs & Services -> Credentials -> Create OAuth client ID -> type "Desktop app".
#      Save the Client ID + Client secret.
#   3. Get a refresh token (one-time consent). Easiest: https://developer.chrome.com/docs/webstore/using-api
#      walks the oauth2 flow; or use any "get refresh token" helper with scope
#      https://www.googleapis.com/auth/chromewebstore and your client id/secret.
#   4. Find your item ID: the long id in the item's Dashboard URL / store URL.
#   5. Create tools\.cws-credentials.json (this file is gitignored - secrets stay local):
#        {
#          "clientId":     "....apps.googleusercontent.com",
#          "clientSecret": "....",
#          "refreshToken": "1//....",
#          "itemId":       "the-32-char-item-id"
#        }
# After that, this script (or "tell Claude to run tools\cws-publish.ps1") publishes updates.

param(
  [string]$Zip,
  [string]$CredFile = "$PSScriptRoot\.cws-credentials.json",
  [switch]$UploadOnly,
  [ValidateSet('trustedTesters','default')]
  [string]$Target = 'trustedTesters'   # private/unlisted item -> trustedTesters; public -> default
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot   # ...\v11

if (-not (Test-Path $CredFile)) {
  throw "Missing $CredFile. See the ONE-TIME SETUP comment at the top of this script."
}
$cred = Get-Content $CredFile -Raw | ConvertFrom-Json
foreach ($k in 'clientId','clientSecret','refreshToken','itemId') {
  if (-not $cred.$k) { throw "Credential file is missing '$k'." }
}

# 1. Package the current extension if no zip was given.
if (-not $Zip) {
  $manifest = Get-Content (Join-Path $Root 'extension\manifest.json') -Raw | ConvertFrom-Json
  $ver = $manifest.version
  $Zip = Join-Path $Root "dist\jat-extension-v$ver.zip"
  Compress-Archive -Path (Join-Path $Root 'extension\*') -DestinationPath $Zip -Force
  Write-Host "packaged extension v$ver -> $Zip" -ForegroundColor Green
}
if (-not (Test-Path $Zip)) { throw "zip not found: $Zip" }

# 2. Exchange the refresh token for a short-lived access token.
Write-Host "authenticating with the Chrome Web Store API..." -ForegroundColor Cyan
$tok = Invoke-RestMethod -Method Post -Uri 'https://oauth2.googleapis.com/token' -Body @{
  client_id     = $cred.clientId
  client_secret = $cred.clientSecret
  refresh_token = $cred.refreshToken
  grant_type    = 'refresh_token'
}
$access = $tok.access_token
if (-not $access) { throw "no access_token returned - re-check the OAuth credentials / refresh token." }

$headers = @{ Authorization = "Bearer $access"; 'x-goog-api-version' = '2' }

# 3. Upload the new package (updates the existing item; version must be > the published one).
Write-Host "uploading $([System.IO.Path]::GetFileName($Zip)) to item $($cred.itemId)..." -ForegroundColor Cyan
$bytes = [System.IO.File]::ReadAllBytes($Zip)
$up = Invoke-RestMethod -Method Put -Uri "https://www.googleapis.com/upload/chromewebstore/v1.1/items/$($cred.itemId)" `
  -Headers $headers -Body $bytes
Write-Host "upload state: $($up.uploadState)" -ForegroundColor Green
if ($up.uploadState -eq 'FAILURE') {
  $up.itemError | ForEach-Object { Write-Host "  ERROR: $($_.error_detail)" -ForegroundColor Red }
  throw "upload failed (often: the manifest version is not higher than the published version)."
}

# 4. Publish (skip with -UploadOnly to leave it as a draft you submit manually).
if ($UploadOnly) {
  Write-Host "uploaded as a draft (-UploadOnly). Publish from the Dashboard or re-run without the switch." -ForegroundColor Yellow
  return
}
Write-Host "publishing to '$Target'..." -ForegroundColor Cyan
$pub = Invoke-RestMethod -Method Post -Uri "https://www.googleapis.com/chromewebstore/v1.1/items/$($cred.itemId)/publish?publishTarget=$Target" `
  -Headers $headers
Write-Host "publish status: $($pub.status -join ', ')" -ForegroundColor Green
if ($pub.statusDetail) { $pub.statusDetail | ForEach-Object { Write-Host "  $_" } }
Write-Host "Done. Chrome will auto-update installs within a few hours (after review, if any)." -ForegroundColor Green
