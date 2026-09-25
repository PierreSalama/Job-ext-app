# Re-run ONE test file in isolation, at normal priority, to tell a real regression apart from a
# timeout caused by four cores already being busy applying for jobs.
param([string]$File = 'tests\session-bridge-e2e.test.mjs')
$V11 = 'C:\JAT\job-application-tracker\v11'
$OUT = 'C:\ProgramData\JAT-Remote\one-test.txt'
Set-Location $V11

$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = 'C:\Program Files\nodejs\node.exe'
$psi.Arguments = "--test $File"
$psi.WorkingDirectory = $V11
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$p = [Diagnostics.Process]::Start($psi)
$so = $p.StandardOutput.ReadToEndAsync(); $se = $p.StandardError.ReadToEndAsync()
$p.WaitForExit(600000) | Out-Null
($so.Result + "`n---STDERR---`n" + $se.Result) | Set-Content -Path $OUT -Encoding UTF8

$lines = Get-Content $OUT
Write-Output ('  exit: ' + $p.ExitCode)
$lines | Select-String -Pattern '^. (tests|pass|fail) \d+' | ForEach-Object { '  ' + $_.Line.Trim() }
$lines | Where-Object { $_ -match [char]0x2716 } | Select-Object -First 4 | ForEach-Object { '  ' + $_ }
$lines | Select-String -Pattern 'timeout|ETIMEDOUT|ECONNREFUSED|not found' | Select-Object -First 4 | ForEach-Object { '  ' + $_.Line.Trim() }
