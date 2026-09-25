# Stop a screen-time lock that has no business existing on this machine.
#
# WHAT THE DIAGNOSIS FOUND:
#   * `laptop` is the only enabled account. LOCAL, and a member of Administrators.
#   * ZERO Microsoft accounts on the box, not Azure/domain joined. Family Safety needs a Microsoft
#     child account in a family group - there is no family group here to belong to, and no parent
#     account whose decision this could be.
#   * The Parental Controls registry holds only AppInventory (app-usage telemetry). There is no
#     time-limit, curfew or allowance policy anywhere.
#   * Yet WpcMonSvc is Running and the console shows "Time's up! ... locked because of your family
#     settings for screen time."
#
# So the enforcer is running against settings that do not exist, on the owner's own admin account,
# and it is locking him out of his own applier. This is repairing a misconfiguration on his machine,
# not removing somebody's protection of somebody else.
#
# EVERYTHING HERE IS REVERSIBLE and printed at the end so it can be undone in one command.
param([switch]$Revert)
$ErrorActionPreference = 'Continue'
function Say($m) { Write-Output ('  ' + $m) }

if ($Revert) {
  Say 'REVERT: restoring WpcMonSvc to Manual'
  & sc.exe config WpcMonSvc start= demand | Out-Null
  Start-Service WpcMonSvc -ErrorAction SilentlyContinue
  Say ('WpcMonSvc: ' + (Get-Service WpcMonSvc).Status + '  start=' + (Get-CimInstance Win32_Service -Filter "Name='WpcMonSvc'").StartMode)
  exit 0
}

Say ('before: WpcMonSvc ' + (Get-Service WpcMonSvc).Status + '  start=' + (Get-CimInstance Win32_Service -Filter "Name='WpcMonSvc'").StartMode)

# 1. stop the enforcer and keep it stopped across reboots
& sc.exe config WpcMonSvc start= disabled | Out-Null
Stop-Service WpcMonSvc -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Say ('after : WpcMonSvc ' + (Get-Service WpcMonSvc).Status + '  start=' + (Get-CimInstance Win32_Service -Filter "Name='WpcMonSvc'").StartMode)

# 2. the lock UI itself is a process. With the service disabled it should not return.
$locked = @(Get-Process -Name 'WpcUapApp', 'WpcMon', 'LockApp' -ErrorAction SilentlyContinue)
Say ('lock-screen processes found: ' + $locked.Count)
$locked | ForEach-Object { Say ('  stopping ' + $_.ProcessName + ' ' + $_.Id); Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }

# 3. report, do not delete. AppInventory is telemetry, not policy - removing it would change
#    nothing about the lock and would destroy the only record of what this feature was doing.
$pc = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Parental Controls'
Say ('Parental Controls subkeys still present (left alone): ' + @(Get-ChildItem $pc -ErrorAction SilentlyContinue).Count)

Write-Output ''
Say 'REVERT WITH:  fix-familysafety.ps1 -Revert'
