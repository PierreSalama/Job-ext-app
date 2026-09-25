# laptop-ctl - one place to see and clean up what is running on the applier laptop.
#
# WHY THIS EXISTS: several Claude sessions drive this machine, none of them can see what the others
# started, and nothing ever cleaned up. Pierre found leftover Chrome windows and duplicate app
# instances piling up. An orphaned Chrome is not merely untidy: it HOLDS a browser profile, and the
# AI agent then refuses to run with "detected a Chrome session it does not own" - measured
# 2026-09-08, an agent run failed for exactly that reason.
#
#   .\laptop-ctl.ps1                 inventory (default, read-only)
#   .\laptop-ctl.ps1 -Reap           stop what is safe to stop, explain each decision
#   .\laptop-ctl.ps1 -Reap -Force    also stop things a session has an active lease on
#   .\laptop-ctl.ps1 -Claim <name> -For <minutes>    take a lease so other sessions leave it alone
#   .\laptop-ctl.ps1 -Release <name>
#
# WHAT IS NEVER TOUCHED, at any force level:
#   * the JAT app on 7744 (Pierre's applier) and 7745 (Ashraf's)
#   * the real-profile Chrome - it holds Pierre's live LinkedIn session, which cost a manual login
#     and does not survive being copied
#   * the JAT-Remote bridge, which is how anything here is reachable at all
param(
  [switch]$Reap,
  [switch]$Force,
  [string]$Claim,
  [string]$Release,
  [int]$For = 30
)
$ErrorActionPreference = 'SilentlyContinue'
$LEASES = 'C:\ProgramData\JAT-Remote\leases.json'
$REAL_CHROME = 'C:\Program Files\Google\Chrome\Application\chrome.exe'

function Load-Leases {
  if (-not (Test-Path $LEASES)) { return @{} }
  try {
    $h = @{}
    (Get-Content $LEASES -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $h[$_.Name] = $_.Value }
    return $h
  } catch { return @{} }
}
function Save-Leases($h) { ($h | ConvertTo-Json -Depth 5) | Set-Content -Path $LEASES -Encoding UTF8 }
function Live-Leases {
  $h = Load-Leases; $out = @{}
  foreach ($k in $h.Keys) {
    try { if ([DateTime]::Parse($h[$k].until) -gt (Get-Date)) { $out[$k] = $h[$k] } } catch {}
  }
  if ($out.Count -ne $h.Count) { Save-Leases $out }   # expired leases clean themselves up
  return $out
}

if ($Claim) {
  $h = Live-Leases
  $h[$Claim] = @{ by = $env:COMPUTERNAME + '/' + $env:USERNAME; since = (Get-Date).ToString('o'); until = (Get-Date).AddMinutes($For).ToString('o') }
  Save-Leases $h
  Write-Output "  claimed '$Claim' for $For min"
  exit 0
}
if ($Release) {
  $h = Live-Leases; $h.Remove($Release); Save-Leases $h
  Write-Output "  released '$Release'"
  exit 0
}

$leases = Live-Leases

# ---------------------------------------------------------------------------------------------
# inventory
# ---------------------------------------------------------------------------------------------
Write-Output ''
Write-Output '  == JAT app instances =='
Get-CimInstance Win32_Process -Filter "Name='Job Application Tracker.exe' OR Name='electron.exe'" |
  Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object {
    $ud = ([regex]::Match($_.CommandLine, '--user-data-dir=("?)([^"]+)\1')).Groups[2].Value
    $who = if ($ud -match 'dad') { 'Ashraf' } elseif ($ud -match 'pierre') { 'Pierre' } else { 'unknown' }
    '    pid {0,-7} {1,-7} {2}' -f $_.ProcessId, $who, (Split-Path $ud -Leaf)
  }
'    ports listening: ' + ((Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 7744, 7745, 7746, 7749 } |
  Select-Object -Expand LocalPort -Unique | Sort-Object) -join ', ')

Write-Output ''
Write-Output '  == Chrome instances =='
$chromes = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' }
$rows = @()
foreach ($c in $chromes) {
  $ud   = ([regex]::Match($c.CommandLine, '--user-data-dir=("?)([^"]+)\1')).Groups[2].Value
  $port = ([regex]::Match($c.CommandLine, '--remote-debugging-port=(\d+)')).Groups[1].Value
  # IDENTIFY THE APPLIER LANE BY WHAT IT IS DOING, NOT BY ITS PATH.
  #
  # Verified 2026-09-08 by reading Secure Preferences in all three profiles: the extension is
  # registered ONLY in the real default profile, so the applier is the branded binary with NO
  # --user-data-dir. That is the path test below, and it is correct. But do not lean on it alone:
  # a browser can be the applier for a while and then have its extension worker evicted, and a
  # future lane could be added that does carry a profile dir. The reliable signal is the socket -
  # whatever is talking to the JAT app on 7744 is applying right now and must never be stopped -
  # so both tests run and either one is enough to protect the process.
  $talking = @(Get-NetTCPConnection -RemotePort 7744 -State Established -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -eq $c.ProcessId -or (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)").ParentProcessId -eq $c.ProcessId }).Count
  $isReal = ($talking -gt 0) -or (($c.ExecutablePath -eq $REAL_CHROME) -and (-not $ud))
  $kids = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match '--type=' -and $_.ParentProcessId -eq $c.ProcessId }).Count
  $age  = [int]((Get-Date) - (Get-Process -Id $c.ProcessId).StartTime).TotalMinutes
  # HEADLESS RENDER LEFTOVERS - and why this test comes LAST.
  #
  # The resume renderer prints a PDF by launching Chrome headless, and those browsers do not always
  # exit. Found 2026-09-08 after a debugging session: 18 alive at once, 82 chrome processes on a
  # machine with 8GB, and laptop-ctl could only call them "other" and refuse to touch them.
  #
  # I first put this test ABOVE the named lanes and it immediately mislabelled Ashraf's applier,
  # which runs Chrome for Testing with HEADLESS=1. -Reap would have killed his browser. "Headless"
  # describes HOW a browser was started, not WHOSE it is, so it can only ever be the last word,
  # after every lane that has a name has claimed its own. $isReal still runs first, so anything
  # talking to 7744 keeps its protection whatever its flags say.
  $kind = if ($isReal) { 'APPLIER LANE (talks to 7744)' }
          elseif ($ud -match 'cdp-profile') { 'cdp replica' }
          elseif ($ud -match 'chrome-prof_') { 'agent profile' }
          elseif ($ud -match 'cft-profile-dad') { 'Ashraf CfT' }
          elseif ($ud -match 'cft-profile') { 'CfT' }
          elseif ($c.CommandLine -match '--headless') { 'headless render leftover' }
          else { 'other' }
  $rows += [pscustomobject]@{ Pid = $c.ProcessId; Kind = $kind; Port = $port; AgeMin = $age; Procs = $kids + 1; Dir = $(if ($ud) { Split-Path $ud -Leaf } else { '(default)' }) }
}
if ($rows) { $rows | Sort-Object Kind | Format-Table -AutoSize | Out-String -Width 200 | ForEach-Object { $_.TrimEnd() } }
else { '    none' }

Write-Output ''
Write-Output '  == node / test runs =='
$nodes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -notmatch 'electron' }
if ($nodes) {
  $nodes | ForEach-Object {
    $age = [int]((Get-Date) - (Get-Process -Id $_.ProcessId).StartTime).TotalMinutes
    $what = if ($_.CommandLine -match 'run-tests|--test') { 'test suite' } elseif ($_.CommandLine -match 'supervisor') { 'supervisor' } else { 'node' }
    '    pid {0,-7} {1,-12} {2} min old' -f $_.ProcessId, $what, $age
  }
} else { '    none' }

Write-Output ''
Write-Output '  == machine =='
$os = Get-CimInstance Win32_OperatingSystem
'    cpu load  : {0}%' -f [int](Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
'    memory    : {0:N1} GB free of {1:N1} GB' -f ($os.FreePhysicalMemory / 1MB), ($os.TotalVisibleMemorySize / 1MB)
'    disk C:   : {0:N0} GB free' -f ((Get-PSDrive C).Free / 1GB)
'    chrome    : {0} processes total' -f @(Get-Process chrome).Count

Write-Output ''
Write-Output '  == leases held by other sessions =='
if ($leases.Count) { $leases.Keys | ForEach-Object { '    {0,-22} until {1}' -f $_, $leases[$_].until } } else { '    none' }

# ---------------------------------------------------------------------------------------------
# reap
# ---------------------------------------------------------------------------------------------
if (-not $Reap) { Write-Output ''; Write-Output '  (read-only. use -Reap to clean up)'; exit 0 }

Write-Output ''
Write-Output '  == REAP =='
$stopped = 0
foreach ($r in $rows) {
  $why = $null
  if ($r.Kind -like 'APPLIER LANE*') { $why = 'never - this is the applier, holds the live LinkedIn session' }
  elseif ($r.Kind -eq 'Ashraf CfT')  { $why = 'never - Ashraf lane' }
  # NEVER REAP WHAT CANNOT BE NAMED. The socket test attributes the applier lane one parent
  # level up, and Chrome nests renderers deeper than that, so a genuine applier can still land
  # in 'other'. Killing it would destroy the live LinkedIn session. An unidentified browser
  # left running costs some RAM; an unidentified browser killed costs a manual re-login and
  # every application queued behind it.
  elseif ($r.Kind -eq 'other')       { $why = 'unidentified - refusing to kill what I cannot name' }
  # A headless render is reapable at ANY age: it should have exited in seconds, so one still alive
  # has already failed. The 10-minute grace below exists for browsers a session may still be using.
  elseif ($r.Kind -eq 'headless render leftover') { $why = $null }
  elseif ($leases.ContainsKey($r.Dir) -and -not $Force) { $why = 'leased by another session' }
  elseif ($r.AgeMin -lt 10 -and -not $Force) { $why = 'younger than 10 min, may be in use' }
  if ($why) { '    keep  pid {0,-7} {1,-32} {2}' -f $r.Pid, $r.Kind, $why; continue }
  '    STOP  pid {0,-7} {1,-32} idle {2} min' -f $r.Pid, $r.Kind, $r.AgeMin
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.ProcessId -eq $r.Pid -or $_.ParentProcessId -eq $r.Pid } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $stopped++
}
foreach ($n in $nodes) {
  $age = [int]((Get-Date) - (Get-Process -Id $n.ProcessId).StartTime).TotalMinutes
  if ($n.CommandLine -match 'run-tests|--test' -and $age -gt 60) {
    '    STOP  pid {0,-7} test suite stuck {1} min' -f $n.ProcessId, $age
    Stop-Process -Id $n.ProcessId -Force -ErrorAction SilentlyContinue
    $stopped++
  }
}
Write-Output "    stopped $stopped"
'    chrome processes now: ' + @(Get-Process chrome).Count
