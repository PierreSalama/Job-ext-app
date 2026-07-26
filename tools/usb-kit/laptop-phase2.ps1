# ============================================================================
#  JAT LAPTOP PHASE 2 - start the app + install the watchdog so it STAYS up.
#  Run once in an elevated PowerShell on the laptop (Claude provides the one-liner).
#  After this, closing the app window no longer loses remote access - the watchdog
#  relaunches it within a couple of minutes. Chrome + the extension come next.
# ============================================================================
$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$Port = 7744; $Base = "http://127.0.0.1:$Port"; $Home_ = 'C:\ProgramData\JAT-Remote'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Write-Host 'Run in an ADMIN PowerShell.' -ForegroundColor Red; return }
New-Item -ItemType Directory -Force -Path $Home_ | Out-Null
function Find-JatExe { foreach ($c in @((Join-Path $env:LOCALAPPDATA 'Programs\Job Application Tracker\Job Application Tracker.exe'),(Join-Path $env:LOCALAPPDATA 'Programs\jat11-app\Job Application Tracker.exe'))){ if (Test-Path $c){ return $c } }; return $null }

# ---- start the app now -----------------------------------------------------
$exe = Find-JatExe
if ($exe -and -not (Get-Process 'Job Application Tracker' -ErrorAction SilentlyContinue)) { Start-Process $exe | Out-Null }
$up = $false; $d=(Get-Date).AddSeconds(60); while((Get-Date)-lt $d){ try{ Invoke-WebRequest -UseBasicParsing "$Base/health" -TimeoutSec 3 | Out-Null; $up=$true; break }catch{}; Start-Sleep 2 }
Write-Host ("app running: {0}" -f $up) -ForegroundColor $(if($up){'Green'}else{'Yellow'})

# ---- write the watchdog (keeps the app alive, and Chrome once phase 3 sets it) ----
$wd = @'
$ErrorActionPreference='Continue'
$Home_='C:\ProgramData\JAT-Remote'; $Base='http://127.0.0.1:7744'; $log=Join-Path $Home_ 'watchdog.log'
function Log($m){ try{ Add-Content $log ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'),$m); $c=Get-Content $log -EA SilentlyContinue; if($c.Count -gt 2000){ Set-Content $log ($c|Select-Object -Last 1500) } }catch{} }
# 1. Tailscale service up
try{ $s=Get-Service Tailscale -EA SilentlyContinue; if($s -and $s.Status -ne 'Running'){ Start-Service Tailscale -EA SilentlyContinue; Log 'tailscale started' } }catch{}
# 2. JAT app alive
function Find-Exe{ foreach($c in @("$env:LOCALAPPDATA\Programs\Job Application Tracker\Job Application Tracker.exe","$env:LOCALAPPDATA\Programs\jat11-app\Job Application Tracker.exe")){ if(Test-Path $c){ return $c } } }
$appUp=[bool](Get-Process 'Job Application Tracker' -EA SilentlyContinue)
if(-not $appUp){ $e=Find-Exe; if($e){ Start-Process $e | Out-Null; Log 'app relaunched'; Start-Sleep 8; $appUp=$true } }
# 3. Chrome alive (only once phase 3 drops chrome-cmd.txt, and only while auto-apply is ON)
try{
  $cmdFile=Join-Path $Home_ 'chrome-cmd.txt'; $tokFile=Join-Path $Home_ 'app-token.txt'
  if($appUp -and (Test-Path $cmdFile) -and (Test-Path $tokFile)){
    $tok=(Get-Content $tokFile -Raw).Trim(); $on=$false
    try{ $l=Invoke-RestMethod -Uri "$Base/auto-apply/live" -Headers @{'X-JAT-Token'=$tok} -TimeoutSec 6; $on=[bool]$l.enabled }catch{}
    if($on -and -not (Get-Process chrome -EA SilentlyContinue)){
      $args=(Get-Content $cmdFile -Raw).Trim() -split "`n" | Where-Object { $_ }
      $chrome=@("$env:ProgramFiles\Google\Chrome\Application\chrome.exe","${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe")|?{Test-Path $_}|select -First 1
      if($chrome){ Start-Process $chrome -ArgumentList $args; Log 'chrome relaunched (auto-apply on)' }
    }
  }
}catch{ Log ("chrome check: "+$_.Exception.Message) }
'@
Set-Content -Path (Join-Path $Home_ 'jat-watchdog.ps1') -Value $wd -Encoding UTF8

# ---- register the scheduled task ------------------------------------------
try {
  $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Home_\jat-watchdog.ps1`""
  $tLogon=New-ScheduledTaskTrigger -AtLogOn
  $tRepeat=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 3) -RepetitionDuration (New-TimeSpan -Days 3650)
  $set=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
  $principal=New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName 'JAT Watchdog' -Action $action -Trigger @($tLogon,$tRepeat) -Settings $set -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName 'JAT Watchdog' -EA SilentlyContinue
  Write-Host 'watchdog installed - the app will now stay up on its own' -ForegroundColor Green
} catch { Write-Host "watchdog install failed: $($_.Exception.Message)" -ForegroundColor Red }

# ---- confirm remote access + store token ----------------------------------
try {
  $r=Invoke-RestMethod -Method Post -Uri "$Base/pair" -ContentType 'application/json' -Headers @{origin=$Base} -Body (@{client='phase2'}|ConvertTo-Json) -TimeoutSec 20
  if($r.ok){ Set-Content (Join-Path $Home_ 'app-token.txt') $r.token -Encoding Ascii; Invoke-RestMethod -Method Patch -Uri "$Base/settings" -Headers @{'X-JAT-Token'=$r.token} -ContentType 'application/json' -Body (@{server=@{remoteAccess=$true}}|ConvertTo-Json) -TimeoutSec 20 | Out-Null }
} catch {}
Write-Host '' ; Write-Host 'DONE (phase 2). Tell Claude - the app is up and will stay up.' -ForegroundColor Cyan
