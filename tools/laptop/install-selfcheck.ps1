# Arm the AI lane self check on a three-hourly timer.
#
# Same shape as the other JAT tasks, with the lessons already learned baked in: an explicit
# repetition duration (a -Once trigger with an interval and no duration expires after three fires
# and Windows deletes the task silently), identity taken from the running token rather than from
# environment variables that SSH does not populate, and IgnoreNew so a slow run is never doubled up.
$ErrorActionPreference = 'Stop'
$T = 'JAT AI Lane Self Check'
$Root = 'C:\ProgramData\JAT-Remote'

Unregister-ScheduledTask -TaskName $T -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $Root\selfcheck.ps1"

$Me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$daily = New-ScheduledTaskTrigger -Daily -At '00:15'
$daily.Repetition = (New-ScheduledTaskTrigger -Once -At '00:15' `
  -RepetitionInterval (New-TimeSpan -Hours 3) -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition
$logon = New-ScheduledTaskTrigger -AtLogOn -User $Me

$p = New-ScheduledTaskPrincipal -UserId $Me -LogonType Interactive -RunLevel Highest
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

Register-ScheduledTask -TaskName $T -Action $action -Trigger @($daily, $logon) -Principal $p -Settings $s `
  -Description 'Every three hours: repairs known AI-lane failure modes and records anything needing a human in findings.log' | Out-Null

Start-ScheduledTask -TaskName $T
Start-Sleep -Seconds 40

$task = Get-ScheduledTask -TaskName $T
$info = Get-ScheduledTaskInfo -TaskName $T
Write-Output ('task     : ' + $task.State)
Write-Output ('last     : ' + $info.LastTaskResult)
Write-Output ('next     : ' + $info.NextRunTime)
foreach ($tr in $task.Triggers) {
  if ($tr.Repetition.Interval) { Write-Output ('repeats  : every ' + $tr.Repetition.Interval + ' for ' + $tr.Repetition.Duration) }
}
$log = Join-Path $Root ('selfcheck-' + (Get-Date -Format 'yyyyMM') + '.log')
if (Test-Path $log) { Write-Output '--- log ---'; Get-Content $log -Tail 14 | ForEach-Object { Write-Output ('  ' + $_) } }
