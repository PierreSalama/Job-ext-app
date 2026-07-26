param(
  [Parameter(Mandatory=$true)][string]$AuthKey,   # Tailscale auth key (passed in, never hard-coded)
  [string]$Hostname = 'pierre-laptop'
)
# ============================================================================
#  JAT LAPTOP BOOTSTRAP - run once on Pierre's spare laptop over Remote Desktop.
#
#  No USB. Self-downloads everything from public sources, so all Pierre does is
#  paste one line into an ADMIN PowerShell. This is Chunk 1: it installs the app,
#  Chrome, Tailscale (full remote access), keep-awake, firewall, and turns the
#  app's remote access on - so Pierre (and Claude) can finish everything else
#  remotely over Tailscale. The Chrome extension + watchdog + profile import are
#  done in the next step, remotely.
#
#  Run (in an elevated PowerShell on the laptop):
#     $k='tskey-...'; irm https://raw.githubusercontent.com/PierreSalama/Job-ext-app/v11/laptop-bootstrap.ps1 -OutFile $env:TEMP\lb.ps1; & $env:TEMP\lb.ps1 -AuthKey $k
# ============================================================================

$ErrorActionPreference = 'Continue'
$Port = 7744; $Base = "http://127.0.0.1:$Port"; $Home_ = 'C:\ProgramData\JAT-Remote'
$PierreTargets = @('100.93.122.106','BOBLAMA_PC','192.168.2.33','192.168.2.17')
$AppUrl = 'https://github.com/PierreSalama/Job-ext-app/releases/download/v11.88.22/JAT-v11-setup.exe'
$MsiUrl = 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi'
$ChromeUrl = 'https://dl.google.com/tag/s/dl/chrome/install/googlechromestandaloneenterprise64.msi'
$report = New-Object System.Collections.ArrayList
function Say([string]$m,[string]$c='Gray'){ Write-Host $m -ForegroundColor $c; [void]$report.Add($m) }
function Step([string]$m){ Say '' ; Say "==> $m" 'Cyan' }
function Ok([string]$m){ Say "   ok   $m" 'Green' }
function Warn([string]$m){ Say "   WARN $m" 'Yellow' }
function Bad([string]$m){ Say "   FAIL $m" 'Red' }

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Please run this in an ADMIN PowerShell (right-click PowerShell -> Run as administrator), then paste the command again.' -ForegroundColor Red
  return
}
New-Item -ItemType Directory -Force -Path $Home_ | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
try { Start-Transcript -Path (Join-Path $Home_ "bootstrap-$stamp.log") -Force | Out-Null } catch {}
Say '======================================================' 'Cyan'
Say " JAT laptop bootstrap - $(Get-Date -Format 'yyyy-MM-dd HH:mm')" 'Cyan'
Say " computer: $env:COMPUTERNAME   user: $env:USERNAME" 'Cyan'
Say '======================================================' 'Cyan'

function Get-File($url,$out,$label){ Say "   downloading $label..."; try { $wc = New-Object System.Net.WebClient; $wc.DownloadFile($url,$out); return (Test-Path $out) } catch { Bad "$label download failed: $($_.Exception.Message)"; return $false } }

# ---- 1. JAT app -----------------------------------------------------------
Step '1/6  Install the JAT app'
function Find-JatExe { foreach ($c in @((Join-Path $env:LOCALAPPDATA 'Programs\Job Application Tracker\Job Application Tracker.exe'),(Join-Path $env:LOCALAPPDATA 'Programs\jat11-app\Job Application Tracker.exe'))){ if (Test-Path $c){ return $c } }; return $null }
$exe = Find-JatExe
if (-not $exe) {
  $dl = Join-Path $env:TEMP 'JAT-v11-setup.exe'
  if (Get-File $AppUrl $dl 'JAT app (160 MB)') { Say '   installing silently (~1 min)...'; Start-Process -FilePath $dl -ArgumentList '/S' -Wait; Start-Sleep 3; $exe = Find-JatExe }
}
if ($exe) { Ok "app installed" } else { Bad 'app did not install' }
function Wait-App([int]$s=90){ $d=(Get-Date).AddSeconds($s); while((Get-Date)-lt $d){ try{ Invoke-WebRequest -UseBasicParsing "$Base/health" -TimeoutSec 3 | Out-Null; return $true }catch{}; Start-Sleep 2 }; return $false }
if ($exe -and -not (Get-Process 'Job Application Tracker' -ErrorAction SilentlyContinue)) { Start-Process $exe | Out-Null }
if (Wait-App 90) { Ok "app running on $Port" } else { Warn 'app not answering yet' }

# ---- 2. keep-awake --------------------------------------------------------
Step '2/6  Keep-awake (never sleep on power, lid-close keeps running)'
try {
  powercfg /change standby-timeout-ac 0 2>&1 | Out-Null
  powercfg /change hibernate-timeout-ac 0 2>&1 | Out-Null
  powercfg /change disk-timeout-ac 0 2>&1 | Out-Null
  powercfg /hibernate off 2>&1 | Out-Null
  powercfg /change monitor-timeout-ac 10 2>&1 | Out-Null
  powercfg -setacvalueindex SCHEME_CURRENT 4f971e89-eebd-4455-a8de-9e59040e7347 5ca83367-6e45-459f-a27b-476b1d01c936 0 2>&1 | Out-Null
  powercfg -setactive SCHEME_CURRENT 2>&1 | Out-Null
  Ok 'stays awake on power, even lid-closed'
} catch { Warn "power config: $($_.Exception.Message)" }

# ---- 3. Chrome ------------------------------------------------------------
Step '3/6  Google Chrome'
$chromeExe = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe","${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chromeExe) {
  $cmsi = Join-Path $env:TEMP 'chrome.msi'
  if (Get-File $ChromeUrl $cmsi 'Chrome') { Say '   installing Chrome silently...'; Start-Process msiexec.exe -ArgumentList "/i `"$cmsi`" /quiet /norestart" -Wait; Start-Sleep 3 }
  $chromeExe = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe","${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if ($chromeExe) { Ok "Chrome present" } else { Warn 'Chrome not installed - will retry from the remote step' }

# ---- 4. Firewall ----------------------------------------------------------
Step '4/6  Firewall'
try { netsh advfirewall firewall delete rule name='JAT v11 LAN' 2>&1 | Out-Null; netsh advfirewall firewall add rule name='JAT v11 LAN' dir=in action=allow protocol=TCP localport=$Port profile=private,domain 2>&1 | Out-Null; Ok "firewall allows JAT on $Port" } catch { Warn "firewall: $($_.Exception.Message)" }

# ---- 5. Tailscale (FULL access) -------------------------------------------
Step '5/6  Tailscale - full remote access'
$tsExe = Join-Path ${env:ProgramFiles} 'Tailscale\tailscale.exe'
if (-not (Test-Path $tsExe)) { $msi = Join-Path $env:TEMP 'tailscale.msi'; if (Get-File $MsiUrl $msi 'Tailscale'){ Say '   installing Tailscale silently...'; Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /quiet /norestart" -Wait } }
$tsExe = Join-Path ${env:ProgramFiles} 'Tailscale\tailscale.exe'
if (Test-Path $tsExe) { Ok 'Tailscale installed' } else { Bad 'Tailscale did not install' }
try { Set-Service Tailscale -StartupType Automatic -ErrorAction SilentlyContinue; Start-Service Tailscale -ErrorAction SilentlyContinue } catch {}
$tsLog = Join-Path $Home_ 'tailscale-join.log'; "[$(Get-Date -Format o)] waiting for daemon" | Set-Content $tsLog
for ($i=0;$i -lt 20;$i++){ try { & $tsExe status 2>&1 | Out-Null; break } catch {}; Start-Sleep 2 }
$joined=$false
for ($t=1;$t -le 3;$t++){ "[$(Get-Date -Format o)] up $t" | Add-Content $tsLog; $o = & $tsExe up --auth-key="$AuthKey" --unattended --hostname="$Hostname" --reset 2>&1; $o | Add-Content $tsLog; $o | ForEach-Object { Say "   $_" }; Start-Sleep 4; $b=& $tsExe status --json 2>$null | ConvertFrom-Json; if ($b -and $b.BackendState -eq 'Running'){ $joined=$true; break }; Start-Sleep 4 }
if ($joined){ Ok 'joined the tailnet'; (& $tsExe set --ssh 2>&1) | Add-Content $tsLog; Ok 'Tailscale SSH enabled' } else { Bad 'could NOT join - most likely the auth key (expired/used)' }
$tsIp=''; for ($i=0;$i -lt 15;$i++){ try { $ip=(& $tsExe ip -4 2>$null | Select-Object -First 1); if ($ip -and $ip -notmatch '^169\.254'){ $tsIp=$ip.Trim(); break } } catch {}; Start-Sleep 2 }
if ($tsIp){ Ok "this laptop is $Hostname at $tsIp" } else { Warn 'no tailnet IP yet' }

# ---- 6. App remote access + report ----------------------------------------
Step '6/6  App remote access + report to Pierre'
function Pair-App { for ($i=0;$i -lt 5;$i++){ try { $r=Invoke-RestMethod -Method Post -Uri "$Base/pair" -ContentType 'application/json' -Headers @{ origin=$Base } -Body (@{ client='laptop-bootstrap' } | ConvertTo-Json) -TimeoutSec 20; if ($r.ok){ return $r.token } } catch { Start-Sleep 2 } } return $null }
$token = Pair-App
if ($token){ try { Invoke-RestMethod -Method Patch -Uri "$Base/settings" -Headers @{ 'X-JAT-Token'=$token } -ContentType 'application/json' -Body (@{ server=@{ remoteAccess=$true } } | ConvertTo-Json) -TimeoutSec 20 | Out-Null; Ok 'app remote access ON' } catch {}; try { Set-Content (Join-Path $Home_ 'app-token.txt') $token -Encoding Ascii } catch {} }
$diag=[ordered]@{ when=(Get-Date -Format o); computer=$env:COMPUTERNAME; role='pierre-laptop'; tailscaleIp=$tsIp; appToken=$token; chrome=[bool]$chromeExe }
try { $diag.appVersion=(Invoke-RestMethod "$Base/health" -TimeoutSec 5).version } catch {}
try { $diag.tailscaleBackend=((& $tsExe status --json 2>$null | ConvertFrom-Json).BackendState) } catch {}
$diagJson=$diag | ConvertTo-Json
try { Stop-Transcript | Out-Null } catch {}
$full="=== DIAG ===`r`n$diagJson`r`n`r`n=== SUMMARY ===`r`n"+($report -join "`r`n")+"`r`n`r`n=== TAILSCALE ===`r`n"+((Get-Content $tsLog -Raw -ErrorAction SilentlyContinue))
foreach ($tg in $PierreTargets){ try { Invoke-RestMethod -Method Post -Uri ("http://{0}:{1}/remote/report?from={2}-LAPTOP" -f $tg,$Port,$env:COMPUTERNAME) -Body $full -ContentType 'text/plain' -TimeoutSec 8 | Out-Null; Say "sent to Pierre ($tg)" 'Green'; break } catch {} }
Say ''; Say '---- LAPTOP ----' 'Cyan'; Say "Tailscale IP: $tsIp" 'White'; Say "App version:  $($diag.appVersion)" 'White'
Say ''
if ($joined){ Say 'DONE. Laptop is on the tailnet + app running. Claude finishes the rest remotely.' 'Cyan' } else { Say 'Tailscale did not join - paste this output to Claude.' 'Yellow' }
Say 'Paste everything above to Claude.'
