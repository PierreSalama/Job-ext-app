# Which profile actually carries the JAT extension? Read-only.
$ErrorActionPreference = 'SilentlyContinue'
$EXT_ID = 'ehpabielnbljajggjmggngeaemfjpfhn'
function Check($label, $sp) {
  if (-not (Test-Path $sp)) { Write-Output ("  {0,-34} no Secure Preferences" -f $label); return }
  $j = Get-Content $sp -Raw | ConvertFrom-Json
  $e = $j.extensions.settings.$EXT_ID
  Write-Output ("  {0,-34} ext={1,-6} location={2,-4} disable={3,-9} dev_mode={4}" -f `
    $label, [bool]$e, $e.location, $e.disable_reasons, $j.extensions.ui.developer_mode)
}
Check 'REAL default profile' 'C:\Users\laptop\AppData\Local\Google\Chrome\User Data\Default\Secure Preferences'
Check 'app-managed chrome-default'  'C:\Users\laptop\AppData\Roaming\jat11-app-pierre\chrome-profiles\chrome-default\Default\Secure Preferences'
Check 'agent chrome-prof_9033046e'  'C:\Users\laptop\AppData\Roaming\jat11-app-pierre\chrome-profiles\chrome-prof_9033046e-e722-49d7-b43c-98b549b5878c\Default\Secure Preferences'

Write-Output ''
Write-Output '  running branded chrome (browser processes only):'
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object {
    $ud = ([regex]::Match($_.CommandLine, '--user-data-dir=(?:"([^"]+)"|(\S+))'))
    $dir = if ($ud.Groups[1].Value) { $ud.Groups[1].Value } else { $ud.Groups[2].Value }
    '    pid {0,-7} {1}' -f $_.ProcessId, $(if ($dir) { $dir } else { '(REAL default profile)' })
  }
