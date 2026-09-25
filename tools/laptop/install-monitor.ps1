# Register the overnight recorder so it actually keeps running.
#
# FIRST ATTEMPT FAILED SILENTLY, which is the worst way for a monitor to fail: a -Once trigger with
# a RepetitionInterval and NO RepetitionDuration expired after three samples and Windows deleted the
# task outright. The log stopped at 02:53 and nothing said so. If that had gone unnoticed the whole
# overnight test would have produced 15 minutes of data.
#
# Fixed by giving the repetition an explicit duration and re-arming it DAILY, so an expiry can only
# ever cost one day rather than the run. Belt and braces: a second trigger at logon.
$ErrorActionPreference = 'Stop'
$T = 'JAT Overnight Monitor'
Unregister-ScheduledTask -TaskName $T -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\ProgramData\JAT-Remote\overnight-monitor.ps1'

# Daily at 00:00, repeating every 5 minutes for a full 24h — re-armed each midnight.
$daily = New-ScheduledTaskTrigger -Daily -At '00:00'
$daily.Repetition = (New-ScheduledTaskTrigger -Once -At '00:00' `
  -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Hours 24)).Repetition

# And again at logon, so a reboot does not wait for midnight.
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:COMPUTERNAME\$env:USERNAME"
$logon.Repetition = $daily.Repetition

$p = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" -LogonType Interactive -RunLevel Highest
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable

Register-ScheduledTask -TaskName $T -Action $action -Trigger @($daily, $logon) -Principal $p -Settings $s `
  -Description 'Records the auto-apply run every 5 minutes; restarts the app if it is down' | Out-Null

Start-ScheduledTask -TaskName $T
Start-Sleep -Seconds 15

$task = Get-ScheduledTask -TaskName $T
$info = Get-ScheduledTaskInfo -TaskName $T
Write-Output ("  registered : " + $task.State + "  lastResult=" + $info.LastTaskResult)
Write-Output ("  next run   : " + $info.NextRunTime)
foreach ($tr in $task.Triggers) {
  Write-Output ("  trigger    : " + $tr.CimClass.CimClassName + "  every " + $tr.Repetition.Interval + " for " + $tr.Repetition.Duration)
}
$f = "C:\ProgramData\JAT-Remote\overnight-$(Get-Date -Format 'yyyyMMdd').jsonl"
Write-Output ("  log lines  : " + (Get-Content $f -ErrorAction SilentlyContinue | Measure-Object -Line).Lines)
