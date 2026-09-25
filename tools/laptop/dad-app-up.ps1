# Bring Ashraf's JAT instance up — the APP only, never the applier.
#
# The isolation model here is not row-level permissions, it is SEPARATE DATABASES. Pierre's data
# lives in jat11-app-pierre on :7744; Ashraf's lives in jat11-app-dad on :7745. He cannot see
# Pierre's applications because they are not in the database his app reads, which is a far stronger
# guarantee than a WHERE clause somebody can forget.
#
# APP ONLY, deliberately. The applier drives Chrome through job pages and needs a real LinkedIn
# login that only Ashraf can perform. Starting the app now means the data plumbing, the token and
# the dashboard all exist and can be proved, while nothing applies on his behalf until he has
# signed in and Pierre has said go.
#
# Port 7745 was briefly squatted on by the remote bridge earlier today; the bridge now uses 7749.
$ErrorActionPreference = 'SilentlyContinue'
$EXE = 'C:\Users\laptop\AppData\Local\Programs\jat11-app\Job Application Tracker.exe'
$UD  = 'C:\Users\laptop\AppData\Roaming\jat11-app-dad'

$already = @(Get-NetTCPConnection -LocalPort 7745 -State Listen -ErrorAction SilentlyContinue).Count
if ($already -gt 0) {
  Write-Output '  7745 already listening'
} else {
  if (-not (Test-Path $UD)) { Write-Output "  NOTE: $UD does not exist yet - the app will create it" }
  $env:JAT_USERDATA = $UD
  $env:JAT_PORT     = '7745'
  Start-Process -FilePath $EXE -ArgumentList @("--user-data-dir=$UD")
  Write-Output '  launched, waiting for it to bind'
  Start-Sleep -Seconds 35
}

$listening = @(Get-NetTCPConnection -LocalPort 7745 -State Listen -ErrorAction SilentlyContinue).Count
Write-Output "  7745 listening: $listening"

# The token is per-instance and lives in that data dir. Ashraf's viewer needs it, and it must NOT
# be Pierre's — that is the whole point of the separation.
$cfg = Join-Path $UD 'config.json'
if (Test-Path $cfg) {
  $j = Get-Content $cfg -Raw | ConvertFrom-Json
  $tok = $j.token
  if (-not $tok) { $tok = $j.auth.token }
  if ($tok) {
    Write-Output ("  dad token: " + $tok.Substring(0, 10) + "...  (length " + $tok.Length + ")")
    Write-Output ("  same as Pierre's? " + ($tok -eq '92226860c5f0b57faeb5514203c3e10dfcf6d02176db66ef55392d70cbd282af'))
    Set-Content -Path 'C:\ProgramData\JAT-Remote\dad.token' -Value $tok -Encoding ASCII -NoNewline
    Write-Output '  written to C:\ProgramData\JAT-Remote\dad.token'
  } else {
    Write-Output '  could not find a token in config.json — keys: ' + (($j.PSObject.Properties.Name) -join ', ')
  }
} else {
  Write-Output "  no config.json at $cfg yet"
  Get-ChildItem $UD -ErrorAction SilentlyContinue | Select-Object -First 8 -ExpandProperty Name | ForEach-Object { '    ' + $_ }
}
