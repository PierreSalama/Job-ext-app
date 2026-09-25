# Run the full suite on the laptop, properly.
#
# TWO package.json files matter, and missing the second is what produced four "failures" that were
# not failures at all: app/package.json holds the runtime deps, and v11/package.json holds the TEST
# deps — jsdom among them. Installing only app/ leaves every jsdom-importing test dead with
# ERR_MODULE_NOT_FOUND, which reads exactly like a broken build.
#
# BelowNormal throughout: this laptop is also the applier, and a suite that pins all four cores
# makes the browser automation time out and produces failures that look like product bugs.
param([switch]$Install)
$V11 = 'C:\JAT\job-application-tracker\v11'
$OUT = 'C:\ProgramData\JAT-Remote\suite.txt'

function Invoke-Nice($file, $arguments, $wd, $timeoutSec = 3600) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $file; $psi.Arguments = $arguments; $psi.WorkingDirectory = $wd
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false
  $p = [Diagnostics.Process]::Start($psi)
  try { $p.PriorityClass = 'BelowNormal' } catch {}
  $so = $p.StandardOutput.ReadToEndAsync(); $se = $p.StandardError.ReadToEndAsync()
  $p.WaitForExit($timeoutSec * 1000) | Out-Null
  return @{ code = $p.ExitCode; out = $so.Result; err = $se.Result }
}

$npm = 'C:\Program Files\nodejs\npm.cmd'
if ($Install -or -not (Test-Path "$V11\node_modules")) {
  Write-Output '  installing TEST deps at the v11 root (jsdom lives here, not in app/)'
  $r = Invoke-Nice $npm 'install --no-audit --no-fund' $V11 1800
  Write-Output ('  npm exit: ' + $r.code)
}
Write-Output ('  v11/node_modules  : ' + (Test-Path "$V11\node_modules"))
Write-Output ('  jsdom present     : ' + (Test-Path "$V11\node_modules\jsdom"))
Write-Output ('  app/node_modules  : ' + (Test-Path "$V11\app\node_modules"))

Write-Output ''
Write-Output '  running the suite (BelowNormal, so applying keeps its CPU)'
$r = Invoke-Nice 'C:\Program Files\nodejs\node.exe' '..\tools\run-tests.mjs' "$V11\app" 3600
($r.out + "`n---STDERR---`n" + $r.err) | Set-Content -Path $OUT -Encoding UTF8

$lines = Get-Content $OUT
$sum = $lines | Select-String -Pattern '^\s*(tests|pass|fail|skipped|cancelled)\s+\d+' | ForEach-Object { $_.Line.Trim() }
if (-not $sum) { $sum = $lines | Select-String -Pattern 'tests \d+|pass \d+|fail \d+' | ForEach-Object { $_.Line.Trim() } }
Write-Output ''
Write-Output '  --- summary ---'
$sum | ForEach-Object { '  ' + $_ }
Write-Output ('  failing files: ' + (@($lines | Select-String -Pattern '^..tests.\S+\.test\.mjs' -AllMatches).Count))
$lines | Select-String -Pattern '\u2716' | Select-Object -First 10 | ForEach-Object { '  ' + $_.Line }
Write-Output ("  full log: $OUT")
