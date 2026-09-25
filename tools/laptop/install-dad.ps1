# Install the viewer: restart the bridge on the scoped-token build, and write dad.html with its
# config injected so no secret lives in the repo copy.
#
# Ashraf's page gets the VIEWER token. It can see the screen, click and type — nothing else. /exec
# is an Administrator shell and is refused for that token by the bridge itself, not by the page
# choosing not to call it, because a page can be edited and a server check cannot.
$ErrorActionPreference = 'Stop'
$DIR = 'C:\ProgramData\JAT-Remote'
$PORT = 7749

# --- restart the bridge onto the new build --------------------------------------------------
Write-Output '  restarting the bridge'
try { Invoke-RestMethod "http://127.0.0.1:$PORT/shutdown" -Headers @{ 'X-JAT-Token' = (Get-Content "$DIR\bridge.token" -Raw).Trim() } -TimeoutSec 8 | Out-Null } catch {}
Start-Sleep -Seconds 3
Stop-ScheduledTask -TaskName 'JAT-Remote-Bridge' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName 'JAT-Remote-Bridge'
Start-Sleep -Seconds 8

$viewer = (Get-Content "$DIR\viewer.token" -Raw -ErrorAction SilentlyContinue)
if (-not $viewer) { Start-Sleep -Seconds 5; $viewer = Get-Content "$DIR\viewer.token" -Raw -ErrorAction SilentlyContinue }
if (-not $viewer) { throw 'the bridge did not create viewer.token — is it running the new build?' }
$viewer = $viewer.Trim()
Write-Output ('  viewer token created: ' + $viewer.Substring(0, 8) + '…')

# --- write dad.html with config injected -----------------------------------------------------
$src = Get-Content "$DIR\dad.html" -Raw
if ($src -notmatch '__DAD_CFG') { throw 'dad.html has no config hook' }
$cfg = @{
  bridge      = "http://100.104.86.34:$PORT"
  app         = 'http://100.104.86.34:7745'   # Ashraf's own instance; his data, never Pierre's
  viewerToken = $viewer
  appToken    = ''                            # filled in when his instance is set up
  name        = 'Ashraf'
} | ConvertTo-Json -Compress
$inject = "<script>window.__DAD_CFG = $cfg;</script>`n"
if ($src -notmatch 'window\.__DAD_CFG = \{') {
  $src = $src -replace '(<script>\r?\n// Config is injected)', ($inject + '$1')
}
Set-Content -Path "$DIR\dad.html" -Value $src -Encoding UTF8
Write-Output '  dad.html written with config'

# --- prove the scoping actually holds ---------------------------------------------------------
Write-Output ''
Write-Output '  --- SECURITY CHECK ---'
$vh = @{ 'X-JAT-Token' = $viewer }
foreach ($route in '/health', '/screen?scale=0.2', '/dad') {
  try { $r = Invoke-WebRequest "http://127.0.0.1:$PORT$route" -Headers $vh -TimeoutSec 20 -UseBasicParsing; Write-Output ("  viewer {0,-18} -> {1}  ALLOWED (correct)" -f $route, $r.StatusCode) }
  catch { Write-Output ("  viewer {0,-18} -> {1}  (unexpected)" -f $route, $_.Exception.Response.StatusCode.value__) }
}
try {
  Invoke-RestMethod "http://127.0.0.1:$PORT/exec" -Method Post -Headers $vh -Body '{"cmd":"whoami"}' -ContentType 'application/json' -TimeoutSec 20 | Out-Null
  Write-Output '  viewer /exec             -> ALLOWED  *** SECURITY HOLE ***'
} catch {
  Write-Output ('  viewer /exec             -> ' + $_.Exception.Response.StatusCode.value__ + '  REFUSED (correct)')
}
