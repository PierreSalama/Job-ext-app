$f = 'C:\ProgramData\JAT-Remote\jat-bridge.ps1'
Write-Output '  --- syntax check ---'
$errs = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$errs)
if ($errs -and $errs.Count) {
  $errs | Select-Object -First 5 | ForEach-Object { '  line ' + $_.Extent.StartLineNumber + ': ' + $_.Message }
} else {
  Write-Output '  syntax OK'
}

Write-Output ''
Write-Output '  --- starting it ---'
Start-ScheduledTask -TaskName 'JAT-Remote-Bridge'
Start-Sleep -Seconds 10
$t = Get-ScheduledTask -TaskName 'JAT-Remote-Bridge'
$i = Get-ScheduledTaskInfo -TaskName 'JAT-Remote-Bridge'
Write-Output ('  task: ' + $t.State + '  lastResult=' + $i.LastTaskResult)
Write-Output ('  listening on 7749: ' + @(Get-NetTCPConnection -LocalPort 7749 -State Listen -ErrorAction SilentlyContinue).Count)
Write-Output '  --- bridge.log tail ---'
Get-Content 'C:\ProgramData\JAT-Remote\bridge.log' -Tail 4 | ForEach-Object { '  ' + $_ }
