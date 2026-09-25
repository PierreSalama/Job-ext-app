# Register the Canadian ATS feed so the queue refills itself.
#
# Why this exists: the AI lane drained its twelve workable jobs in three days and then logged 704
# consecutive idle ticks over 11 September, every one of them reading
# "queued=37, walled-host=37". Discovery only refills from Indeed, and the AI browser cannot get
# past Indeed's Cloudflare, so the lane starved while the queue looked full. A supply line that has
# to be run by hand is a supply line that stops the moment nobody is watching.
#
# Run this ON the laptop.
$ErrorActionPreference = 'Stop'
$T = 'JAT ATS Feed'
$Root = 'C:\ProgramData\JAT-Remote'

Unregister-ScheduledTask -TaskName $T -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $Root\feed-ca-boards.ps1"

# Identify by the running token rather than by environment variables, which are not populated the
# way an interactive logon populates them when this is run over SSH.
$Me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

# Every six hours, forever. Boards change slowly, so this is about never going hungry rather than
# about freshness.
$daily = New-ScheduledTaskTrigger -Daily -At '06:30'
$daily.Repetition = (New-ScheduledTaskTrigger -Once -At '06:30' `
  -RepetitionInterval (New-TimeSpan -Hours 6) -RepetitionDuration (New-TimeSpan -Days 3650)).Repetition
$logon = New-ScheduledTaskTrigger -AtLogOn -User $Me

$p = New-ScheduledTaskPrincipal -UserId $Me -LogonType Interactive -RunLevel Highest
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

Register-ScheduledTask -TaskName $T -Action $action -Trigger @($daily, $logon) -Principal $p -Settings $s `
  -Description 'Refills the apply queue from verified Canadian Greenhouse, Ashby and Lever boards every six hours' | Out-Null

Start-ScheduledTask -TaskName $T
Start-Sleep -Seconds 50

$task = Get-ScheduledTask -TaskName $T
$info = Get-ScheduledTaskInfo -TaskName $T
Write-Output ('task   : ' + $task.State)
Write-Output ('last   : ' + $info.LastTaskResult)
Write-Output ('next   : ' + $info.NextRunTime)
$log = Join-Path $Root ('ai-lane-feed-' + (Get-Date -Format 'yyyyMM') + '.log')
if (Test-Path $log) {
  Write-Output '--- log ---'
  Get-Content $log -Tail 10 | ForEach-Object { Write-Output ('  ' + $_) }
} else {
  Write-Output '(no feed log yet)'
}
