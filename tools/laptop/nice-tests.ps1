# The laptop is BOTH the applier and, since today, the build box. A full suite pins all 4 cores and
# the apply flow is browser automation — it competes for the same CPU and starts timing out.
#
# So test processes run below the applier, permanently. A slower suite is free; a starved apply run
# produces failures that look like product bugs and are not.
$names = @('node')
$n = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'run-tests|--test|npm' } |
  ForEach-Object {
    $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    if ($p) { try { $p.PriorityClass = 'BelowNormal'; $n++ } catch {} }
  }
Write-Output "  test processes lowered to BelowNormal: $n"

# And make sure the things that matter keep their share.
foreach ($proc in 'Job Application Tracker', 'chrome') {
  Get-Process $proc -ErrorAction SilentlyContinue | ForEach-Object {
    try { if ($_.PriorityClass -eq 'BelowNormal') { $_.PriorityClass = 'Normal' } } catch {}
  }
}
Write-Output ('  cpu load now: ' + [int](Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average + '%')
