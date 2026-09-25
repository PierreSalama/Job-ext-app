# Point Ashraf's viewer at HIS instance, with HIS token.
#
# The two tokens are the separation, so this is the file where getting it wrong would leak Pierre's
# data. Asserted below rather than assumed: the app token written here must be Ashraf's and must be
# refused by Pierre's instance on :7744.
$ErrorActionPreference = 'Stop'
$DIR = 'C:\ProgramData\JAT-Remote'
$DAD_TOKEN = '08668daf1b5b860c4624d7df6d67365bdcd98601542118e3c5bdfd5abe7efc37'
$PIERRE_TOKEN = '92226860c5f0b57faeb5514203c3e10dfcf6d02176db66ef55392d70cbd282af'

if ($DAD_TOKEN -eq $PIERRE_TOKEN) { throw 'the two tokens are identical — refusing to write a viewer that can read Pierre' }

$viewer = (Get-Content "$DIR\viewer.token" -Raw).Trim()
$cfg = @{
  bridge      = 'http://100.104.86.34:7749'
  app         = 'http://100.104.86.34:7745'
  viewerToken = $viewer
  appToken    = $DAD_TOKEN
  name        = 'Ashraf'
} | ConvertTo-Json -Compress

$src = Get-Content "$DIR\dad.html" -Raw
# Replace an existing injected block, or insert one above the page script.
if ($src -match '<script>window\.__DAD_CFG = .*?</script>\r?\n') {
  $src = $src -replace '<script>window\.__DAD_CFG = .*?</script>\r?\n', "<script>window.__DAD_CFG = $cfg;</script>`n"
} else {
  $src = $src -replace '(<script>\r?\n// Config is injected)', "<script>window.__DAD_CFG = $cfg;</script>`n`$1"
}
Set-Content -Path "$DIR\dad.html" -Value $src -Encoding UTF8

$check = Get-Content "$DIR\dad.html" -Raw
Write-Output ('  config written        : ' + [bool]($check -match '__DAD_CFG'))
Write-Output ('  points at dad :7745   : ' + [bool]($check -match '7745'))
Write-Output ('  carries PIERRE token  : ' + [bool]($check -match $PIERRE_TOKEN) + '   (must be False)')
Write-Output ('  carries dad token     : ' + [bool]($check -match $DAD_TOKEN))

# Prove the token in the page cannot read Pierre.
try {
  Invoke-RestMethod 'http://127.0.0.1:7744/settings' -Headers @{ 'X-JAT-Token' = $DAD_TOKEN } -TimeoutSec 15 | Out-Null
  Write-Output '  dad token on :7744    : ACCEPTED  *** LEAK ***'
} catch {
  Write-Output ('  dad token on :7744    : REFUSED ' + $_.Exception.Response.StatusCode.value__ + '  (correct)')
}
$q = Invoke-RestMethod 'http://127.0.0.1:7745/queue?limit=5' -Headers @{ 'X-JAT-Token' = $DAD_TOKEN } -TimeoutSec 20
Write-Output ('  dad instance reachable: ' + $q.ok + '  tasks visible: ' + @($q.items).Count)
