# Register the AI apply lane as a service that survives everything.
#
# Shape borrowed from install-monitor.ps1, with one deliberate difference. The monitor is a sampler:
# it runs for a second every five minutes and exits. This is a LONG-RUNNING supervisor, so:
#
#   * ExecutionTimeLimit is 0 (unlimited). The default is 72 hours and Windows kills the task
#     without a word when it expires — the exact silent-death failure install-monitor.ps1 was
#     written up for.
#   * MultipleInstances is IgnoreNew, so the repeating trigger is a SELF-HEAL rather than a
#     duplicate: if the keeper is alive the new start is dropped, and if it died the next repetition
#     within ten minutes brings it back.
#   * Triggers at logon AND daily, so a reboot does not wait for midnight.
#
# Run this ON the laptop.
param(
  [Parameter(Mandatory = $true)][string]$Token,
  [Parameter(Mandatory = $true)][string]$ProfileId,
  [string]$Base = 'http://127.0.0.1:7744',
  [string]$SkipHosts = 'indeed.com,ca.indeed.com',
  [int]$Cap = 40,
  [int]$Gap = 60
)
$ErrorActionPreference = 'Stop'

$Root = 'C:\ProgramData\JAT-Remote'
$T = 'JAT AI Apply Lane'
New-Item -ItemType Directory -Force -Path $Root | Out-Null

# Config first, so a task that fires immediately finds it.
@{
  base = $Base; token = $Token; profileId = $ProfileId
  skipHosts = $SkipHosts; cap = $Cap; gap = $Gap
} | ConvertTo-Json | Set-Content -Path (Join-Path $Root 'ai-lane.json') -Encoding UTF8

# The config carries a token. Make it readable only by this account and Administrators — it is the
# key to an API that can apply for jobs under someone's real name.
#
# Identify the user by SID, not by "$env:USERDOMAIN\$env:USERNAME". Over SSH those variables are not
# populated the way they are in an interactive logon, and SetAccessRule then throws
# IdentityNotMappedException — which is how this first failed on 2026-09-08. The SID is always
# resolvable because it comes from the running token rather than from the environment.
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$admins = New-Object System.Security.Principal.SecurityIdentifier(
  [System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
$acl = Get-Acl (Join-Path $Root 'ai-lane.json')
$acl.SetAccessRuleProtection($true, $false)
$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))
$acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($admins, 'FullControl', 'Allow')))
Set-Acl -Path (Join-Path $Root 'ai-lane.json') -AclObject $acl

Unregister-ScheduledTask -TaskName $T -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $Root\ai-lane-keeper.ps1"

# Same reason as the ACL above: the environment variables are unreliable over SSH, but the running
# identity is not. WindowsIdentity.Name yields a resolvable account both the trigger and the
# principal will accept.
$Me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$logon = New-ScheduledTaskTrigger -AtLogOn -User $Me
$logon.Repetition = (New-ScheduledTaskTrigger -Once -At '00:00' `
  -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition

$daily = New-ScheduledTaskTrigger -Daily -At '00:05'
$daily.Repetition = $logon.Repetition

$p = New-ScheduledTaskPrincipal -UserId $Me -LogonType Interactive -RunLevel Highest
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName $T -Action $action -Trigger @($logon, $daily) -Principal $p -Settings $s `
  -Description 'Runs the AI apply lane continuously: claims a queued job, runs the agent, records the outcome' | Out-Null

Start-ScheduledTask -TaskName $T
Start-Sleep -Seconds 20

$task = Get-ScheduledTask -TaskName $T
$info = Get-ScheduledTaskInfo -TaskName $T
Write-Output ("  task        : " + $task.State + "   lastResult=" + $info.LastTaskResult)
Write-Output ("  next run    : " + $info.NextRunTime)
Write-Output ("  time limit  : " + $task.Settings.ExecutionTimeLimit + "  (PT0S means unlimited)")
Write-Output ("  instances   : " + $task.Settings.MultipleInstances)
$node = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -like '*ai-lane-keeper.mjs*' }
Write-Output ("  keeper pid  : " + (($node.ProcessId -join ',') -replace '^$', 'NOT RUNNING'))
$log = Join-Path $Root ("ai-lane-" + (Get-Date -Format 'yyyyMMdd') + ".log")
if (Test-Path $log) { Write-Output '  --- log ---'; Get-Content $log -Tail 12 | ForEach-Object { Write-Output ("  " + $_) } }
