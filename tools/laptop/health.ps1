# One-shot health read of the server laptop. Prints, changes nothing.
$ErrorActionPreference = 'SilentlyContinue'

$os = Get-CimInstance Win32_OperatingSystem
$upH = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
$ramUsed = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB, 1)
$ramAll = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
$d = Get-PSDrive C
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average

Write-Output ("uptime   : {0} h" -f $upH)
Write-Output ("RAM      : {0} / {1} GB used ({2}%)" -f $ramUsed, $ramAll, [math]::Round($ramUsed / $ramAll * 100))
Write-Output ("disk C   : {0} free of {1} GB" -f [math]::Round($d.Free / 1GB, 1), [math]::Round(($d.Used + $d.Free) / 1GB, 1))
Write-Output ("cpu load : {0} %" -f $cpu)
Write-Output ("chrome   : {0} processes" -f @(Get-Process chrome).Count)
Write-Output ("node     : {0} processes" -f @(Get-Process node).Count)

Write-Output ''
Write-Output '--- scheduled tasks ---'
foreach ($t in (Get-ScheduledTask | Where-Object { $_.TaskName -like 'JAT*' })) {
  $i = Get-ScheduledTaskInfo -TaskName $t.TaskName
  Write-Output ("{0,-22} {1,-9} last={2,-12} next={3}" -f $t.TaskName, $t.State, $i.LastTaskResult, $i.NextRunTime)
}

Write-Output ''
Write-Output '--- keeper processes ---'
$k = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*ai-lane-keeper.mjs*' }
if ($k) { foreach ($p in $k) { Write-Output ("  pid {0}" -f $p.ProcessId) } } else { Write-Output '  NONE RUNNING' }

Write-Output ''
Write-Output '--- log sizes ---'
Get-ChildItem C:\ProgramData\JAT-Remote\*.log |
  Sort-Object LastWriteTime -Descending | Select-Object -First 6 |
  ForEach-Object { Write-Output ("  {0,-34} {1,8} KB  {2}" -f $_.Name, [math]::Round($_.Length / 1KB), $_.LastWriteTime) }
