# Why is the `laptop` account under a screen-time limit nobody set?
#
# READ-ONLY. This only reports what is enforcing the lock, so the fix can be the right one rather
# than a guess. Microsoft Family Safety enforcement has several moving parts and they fail in
# different ways: an account genuinely enrolled as a child in a family group, a leftover local
# policy, or the WpcMon/Parental Controls service running against stale settings.
$ErrorActionPreference = 'SilentlyContinue'
function H($t) { Write-Output ''; Write-Output ("  == $t ==") }

H 'account'
Write-Output ("  user            : " + $env:USERNAME)
$lu = Get-LocalUser -Name $env:USERNAME
Write-Output ("  local user      : enabled=" + $lu.Enabled + "  source=" + $lu.PrincipalSource + "  SID=" + $lu.SID.Value)
Write-Output ("  admin group     : " + (@(Get-LocalGroupMember -Group 'Administrators' | Where-Object { $_.Name -like "*$env:USERNAME" }).Count -gt 0))

H 'family safety / parental controls services'
foreach ($s in 'WpcMonSvc', 'wlidsvc', 'TimeBrokerSvc') {
  $svc = Get-Service -Name $s
  if ($svc) { Write-Output ("  {0,-16} {1,-9} startup={2}" -f $svc.Name, $svc.Status, (Get-CimInstance Win32_Service -Filter "Name='$s'").StartMode) }
  else { Write-Output ("  {0,-16} not present" -f $s) }
}

H 'parental controls policy keys'
foreach ($k in @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\WindowsParentalControls',
  'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Parental Controls',
  'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\ParentalControls'
)) {
  if (Test-Path $k) {
    Write-Output ("  FOUND $k")
    (Get-ItemProperty $k).PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } |
      ForEach-Object { '      ' + $_.Name + ' = ' + $_.Value }
  } else { Write-Output ("  absent $k") }
}

H 'per-user parental controls (the SID-scoped store)'
$sid = $lu.SID.Value
foreach ($base in 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Parental Controls\Users',
                  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Parental Controls\Users') {
  $p = Join-Path $base $sid
  if (Test-Path $p) {
    Write-Output ("  FOUND $p")
    Get-ChildItem $p -Recurse -ErrorAction SilentlyContinue | Select-Object -First 12 |
      ForEach-Object { '      ' + $_.Name.Replace('HKEY_LOCAL_MACHINE','HKLM') }
  } else { Write-Output ("  absent $p") }
}

H 'is this a Microsoft account tied to a family?'
$aad = & dsregcmd /status 2>$null | Select-String 'AzureAdJoined|WorkplaceJoined|DomainJoined' | ForEach-Object { $_.Line.Trim() }
$aad | ForEach-Object { '  ' + $_ }
Write-Output ("  MicrosoftAccount SIDs present: " + @(Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\IdentityStore\LogonCache' -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'MicrosoftAccount' }).Count)

H 'recent lock events'
Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-ParentalControls/Operational'; StartTime = (Get-Date).AddDays(-3) } -MaxEvents 6 -ErrorAction SilentlyContinue |
  ForEach-Object { '  ' + $_.TimeCreated + '  id=' + $_.Id + '  ' + ($_.Message -replace '\r?\n', ' ').Substring(0, [Math]::Min(90, $_.Message.Length)) }
if (-not $?) { Write-Output '  (no ParentalControls event log entries)' }
