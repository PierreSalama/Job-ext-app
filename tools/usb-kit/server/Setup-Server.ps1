# ============================================================================
#  JAT SERVER - turn Pierre's spare laptop into an always-on auto-apply node.
#
#  Run ONCE from the USB (double-click INSTALL-SERVER.bat). It sets the laptop up
#  to run Pierre's OWN auto-apply 24/7 so his main PC is free, and gives Pierre
#  full remote control of it from anywhere. Chunk 1 of the build: it gets the
#  machine reachable + running; Pierre's profile import and tuning happen
#  afterwards, remotely.
#
#  What it does, all logged to the USB and pushed back to Pierre:
#    1. installs the JAT app (silent)
#    2. KEEP-AWAKE: never sleep/hibernate on AC, lid-close keeps running
#    3. installs Firefox if missing, then force-installs the JAT extension
#    4. firewall-allows the app on the private + Tailscale network
#    5. installs Tailscale (FULL access - Pierre's own device) + SSH, robust join
#    6. turns the app's remote access on + grabs its token
#    7. installs a watchdog (relaunches the app + keeps Firefox open)
#    8. opens Firefox so the extension connects
#    9. writes a full diagnostic to the USB and sends it to Pierre
#
#  Leaves auto-apply OFF on purpose - Pierre imports his profile + turns it on
#  remotely in chunk 2, so this box never applies with an empty/half config.
# ============================================================================

# ---- the one value Pierre bakes in before putting this on the USB ----------
$TailscaleAuthKey = '__TAILSCALE_AUTH_KEY__'

# ---- config ----------------------------------------------------------------
$Hostname      = 'pierre-laptop'                # how it shows in Pierre's tailnet
$Port          = 7744
$Base          = "http://127.0.0.1:$Port"
$PierreTargets = @('BOBLAMA_PC','192.168.2.33','192.168.2.17','100.93.122.106')
$Home_         = 'C:\ProgramData\JAT-Remote'
$ExtId         = 'jat-v11@pierresalama.dev'
$MsiUrl        = 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi'
$FfUrl         = 'https://download.mozilla.org/?product=firefox-latest-ssl&os=win64&lang=en-US'

$KitDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# Big shared files (the app installer, the Tailscale MSI) already live elsewhere on
# the USB - reuse them instead of duplicating 200+ MB into this folder.
function Find-KitFile([string]$name) {
  foreach ($d in @($KitDir, (Split-Path $KitDir), (Join-Path (Split-Path $KitDir) 'Remote'))) {
    $p = Join-Path $d $name; if (Test-Path $p) { return $p }
  }
  return (Join-Path $KitDir $name)   # default target for a download
}
$ErrorActionPreference = 'Continue'
$report = New-Object System.Collections.ArrayList
function Say([string]$m,[string]$c='Gray'){ Write-Host $m -ForegroundColor $c; [void]$report.Add($m) }
function Step([string]$m){ Say '' ; Say "==> $m" 'Cyan' }
function Ok([string]$m){ Say "   ok   $m" 'Green' }
function Warn([string]$m){ Say "   WARN $m" 'Yellow' }
function Bad([string]$m){ Say "   FAIL $m" 'Red' }

# ---- self-elevate ----------------------------------------------------------
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host 'Asking for administrator rights (needed once)...' -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`""
  exit
}

Say '======================================================' 'Cyan'
Say " JAT SERVER setup - $(Get-Date -Format 'yyyy-MM-dd HH:mm')" 'Cyan'
Say " computer: $env:COMPUTERNAME   user: $env:USERNAME" 'Cyan'
Say '======================================================' 'Cyan'

if ($TailscaleAuthKey -eq ('__TAILSCALE_' + 'AUTH_KEY__') -or [string]::IsNullOrWhiteSpace($TailscaleAuthKey)) {
  Bad 'No Tailscale auth key baked in. Pierre must paste a key before using this USB.'
  Read-Host 'Press Enter to close'; exit 1
}

New-Item -ItemType Directory -Force -Path $Home_ | Out-Null
$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$UsbLogs = Join-Path $KitDir 'logs'
try { New-Item -ItemType Directory -Force -Path $UsbLogs | Out-Null } catch {}
$Transcript = Join-Path $Home_ "setup-server-$stamp.log"
try { Start-Transcript -Path $Transcript -Force | Out-Null } catch {}

# ============================================================================
Step '1/9  Install the JAT app'
function Find-JatExe {
  foreach ($c in @((Join-Path $env:LOCALAPPDATA 'Programs\Job Application Tracker\Job Application Tracker.exe'),(Join-Path $env:LOCALAPPDATA 'Programs\jat11-app\Job Application Tracker.exe'))) { if (Test-Path $c) { return $c } }
  try { foreach ($k in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*')) { $m = Get-ItemProperty $k -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Job Application Tracker*' } | Select-Object -First 1; if ($m -and $m.InstallLocation) { $cand = Join-Path $m.InstallLocation 'Job Application Tracker.exe'; if (Test-Path $cand) { return $cand } } } } catch {}
  return $null
}
$InstalledExe = Find-JatExe
if (-not $InstalledExe) {
  $exe = Find-KitFile 'JAT-v11-setup.exe'
  if (Test-Path $exe) { Say '   installing the app silently (~1 min)...'; Start-Process -FilePath $exe -ArgumentList '/S' -Wait; Start-Sleep 3; $InstalledExe = Find-JatExe }
  else { Bad "installer not found on the USB ($exe)" }
}
if ($InstalledExe) { Ok "app installed: $InstalledExe" } else { Bad 'app did not install' }
function Wait-App([int]$sec=90){ $d=(Get-Date).AddSeconds($sec); while((Get-Date) -lt $d){ try{ Invoke-WebRequest -UseBasicParsing "$Base/health" -TimeoutSec 3 | Out-Null; return $true }catch{}; Start-Sleep 2 }; return $false }
if (-not (Get-Process 'Job Application Tracker' -ErrorAction SilentlyContinue) -and $InstalledExe) { Start-Process $InstalledExe | Out-Null }
if (Wait-App 90) { Ok "app is running on port $Port" } else { Warn 'app not answering yet - watchdog will keep trying' }

# ============================================================================
Step '2/9  KEEP-AWAKE - never sleep on power (the whole point of a server)'
try {
  powercfg /change standby-timeout-ac 0    2>&1 | Out-Null   # never sleep on AC
  powercfg /change hibernate-timeout-ac 0  2>&1 | Out-Null
  powercfg /change disk-timeout-ac 0       2>&1 | Out-Null
  powercfg /hibernate off                  2>&1 | Out-Null   # reclaim disk + avoid surprise hibernate
  powercfg /change monitor-timeout-ac 10   2>&1 | Out-Null   # screen may sleep; machine stays up
  # lid close on AC = do nothing (0). GUID: SUB_BUTTONS / LIDACTION
  powercfg -setacvalueindex SCHEME_CURRENT 4f971e89-eebd-4455-a8de-9e59040e7347 5ca83367-6e45-459f-a27b-476b1d01c936 0 2>&1 | Out-Null
  powercfg -setactive SCHEME_CURRENT 2>&1 | Out-Null
  Ok 'laptop will stay awake on power, even with the lid closed'
} catch { Warn "could not fully set power config: $($_.Exception.Message)" }

# ============================================================================
Step '3/9  Firefox + the JAT extension'
$ffDir = $null
foreach ($p in @("$env:ProgramFiles\Mozilla Firefox","${env:ProgramFiles(x86)}\Mozilla Firefox")) { if (Test-Path (Join-Path $p 'firefox.exe')) { $ffDir = $p; break } }
if (-not $ffDir) {
  # A bundled installer is only usable if it is COMPLETE - a partial download (e.g. a
  # bundling attempt that timed out) leaves a small, valid-looking .exe that fails on run.
  # So require >40 MB; otherwise download a fresh full installer to a local temp path.
  $ffSetup = Find-KitFile 'firefox-setup.exe'
  $ffOk = (Test-Path $ffSetup) -and ((Get-Item $ffSetup).Length -gt 40MB)
  if (-not $ffOk) {
    $ffSetup = Join-Path $env:TEMP 'firefox-setup.exe'
    Say '   downloading Firefox (full installer)...'
    try { Invoke-WebRequest -Uri $FfUrl -OutFile $ffSetup -UseBasicParsing -TimeoutSec 600; $ffOk = (Get-Item $ffSetup).Length -gt 40MB } catch { Bad "could not download Firefox: $($_.Exception.Message)" }
  }
  if ($ffOk) { Say '   installing Firefox silently...'; Start-Process -FilePath $ffSetup -ArgumentList '/S' -Wait; Start-Sleep 3 }
  else { Bad 'no complete Firefox installer available' }
  foreach ($p in @("$env:ProgramFiles\Mozilla Firefox","${env:ProgramFiles(x86)}\Mozilla Firefox")) { if (Test-Path (Join-Path $p 'firefox.exe')) { $ffDir = $p; break } }
}
if ($ffDir) {
  Ok "Firefox present: $ffDir"
  $xpiSrc = Find-KitFile 'jat-v11-firefox.xpi'
  $xpiDst = Join-Path $env:APPDATA 'jat11-app\jat-firefox.xpi'
  try { New-Item -ItemType Directory -Force -Path (Split-Path $xpiDst) | Out-Null; Copy-Item $xpiSrc $xpiDst -Force; Ok 'extension staged' } catch { Bad "could not stage extension: $($_.Exception.Message)" }
  $dist = Join-Path $ffDir 'distribution'; New-Item -ItemType Directory -Force -Path $dist | Out-Null
  $fileUrl = 'file:///' + ($xpiDst -replace '\\','/')
  $policy = @{ policies = @{ ExtensionSettings = @{ "$ExtId" = @{ installation_mode='force_installed'; install_url=$fileUrl } }; DisableAppUpdate=$false } }
  try { [System.IO.File]::WriteAllText((Join-Path $dist 'policies.json'), ($policy | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding $false)); Ok 'Firefox policy written (extension force-installs on launch)' } catch { Bad "policy write failed: $($_.Exception.Message)" }
} else { Bad 'Firefox not available - cannot provision the extension' }

# ============================================================================
Step '4/9  Firewall'
try { netsh advfirewall firewall delete rule name='JAT v11 LAN' 2>&1 | Out-Null; netsh advfirewall firewall add rule name='JAT v11 LAN' dir=in action=allow protocol=TCP localport=$Port profile=private,domain 2>&1 | Out-Null; Ok "firewall allows JAT on $Port" } catch { Warn "firewall: $($_.Exception.Message)" }

# ============================================================================
Step '5/9  Tailscale - FULL remote access (Pierre''s own device)'
$tsExe = Join-Path ${env:ProgramFiles} 'Tailscale\tailscale.exe'
if (-not (Test-Path $tsExe)) {
  $msi = Find-KitFile 'tailscale-setup.msi'
  if (-not (Test-Path $msi)) { Say '   downloading Tailscale...'; try { Invoke-WebRequest -Uri $MsiUrl -OutFile $msi -UseBasicParsing -TimeoutSec 180 } catch { Bad "download failed: $($_.Exception.Message)" } }
  if (Test-Path $msi) { Say '   installing Tailscale silently...'; Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /quiet /norestart" -Wait }
}
$tsExe = Join-Path ${env:ProgramFiles} 'Tailscale\tailscale.exe'
if (Test-Path $tsExe) { Ok 'Tailscale installed' } else { Bad 'Tailscale did not install' }
try { Set-Service Tailscale -StartupType Automatic -ErrorAction SilentlyContinue; Start-Service Tailscale -ErrorAction SilentlyContinue } catch {}
$tsLog = Join-Path $Home_ 'tailscale-join.log'; "[$(Get-Date -Format o)] waiting for tailscaled" | Set-Content $tsLog
for ($i=0;$i -lt 20;$i++){ try { & $tsExe status 2>&1 | Out-Null; break } catch {}; Start-Sleep 2 }
$joined = $false
for ($try=1;$try -le 3;$try++){
  "[$(Get-Date -Format o)] up attempt $try" | Add-Content $tsLog
  $out = & $tsExe up --auth-key="$TailscaleAuthKey" --unattended --hostname="$Hostname" --reset 2>&1
  $out | Add-Content $tsLog; $out | ForEach-Object { Say "   $_" }
  Start-Sleep 4
  $bo = & $tsExe status --json 2>$null | ConvertFrom-Json
  if ($bo -and $bo.BackendState -eq 'Running') { $joined = $true; break }
  Start-Sleep 4
}
if ($joined) { Ok 'joined the tailnet'; (& $tsExe set --ssh 2>&1) | Add-Content $tsLog; Ok 'Tailscale SSH enabled (full remote control)' }
else { Bad 'could NOT join the tailnet - see tailscale-join.log (usually an expired/used auth key)' }
$tsIp=''; for ($i=0;$i -lt 15;$i++){ try { $ip=(& $tsExe ip -4 2>$null | Select-Object -First 1); if ($ip -and $ip -notmatch '^169\.254'){ $tsIp=$ip.Trim(); break } } catch {}; Start-Sleep 2 }
if ($tsIp) { Ok "this laptop is $Hostname at $tsIp" } else { Warn 'no tailnet IP yet' }
try { Copy-Item $tsLog (Join-Path $KitDir 'tailscale-join.log') -Force } catch {}

# ============================================================================
Step '6/9  App remote access ON + token'
function Pair-App { for ($i=0;$i -lt 5;$i++){ try { $r=Invoke-RestMethod -Method Post -Uri "$Base/pair" -ContentType 'application/json' -Headers @{ origin=$Base } -Body (@{ client='server-setup' } | ConvertTo-Json) -TimeoutSec 20; if ($r.ok){ return $r.token } } catch { Start-Sleep 2 } } return $null }
$token = Pair-App
if ($token) {
  try { Invoke-RestMethod -Method Patch -Uri "$Base/settings" -Headers @{ 'X-JAT-Token'=$token } -ContentType 'application/json' -Body (@{ server=@{ remoteAccess=$true } } | ConvertTo-Json) -TimeoutSec 20 | Out-Null; Ok 'app remote access is ON' } catch { Warn "remoteAccess: $($_.Exception.Message)" }
  try { Set-Content -Path (Join-Path $Home_ 'app-token.txt') -Value $token -Encoding Ascii } catch {}
} else { Warn 'app not reachable to pair - watchdog will keep it alive; grab token later over Tailscale' }

# ============================================================================
Step '7/9  Watchdog'
try {
  Copy-Item (Join-Path $KitDir 'jat-watchdog.ps1') (Join-Path $Home_ 'jat-watchdog.ps1') -Force
  $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Home_\jat-watchdog.ps1`""
  $tLogon=New-ScheduledTaskTrigger -AtLogOn
  $tRepeat=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 3) -RepetitionDuration (New-TimeSpan -Days 3650)
  $set=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
  $principal=New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName 'JAT Watchdog' -Action $action -Trigger @($tLogon,$tRepeat) -Settings $set -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName 'JAT Watchdog' -ErrorAction SilentlyContinue
  Ok 'watchdog installed'
} catch { Bad "watchdog: $($_.Exception.Message)" }
foreach ($f in @('Uninstall-Remote.ps1','README-SERVER.txt')) { try { Copy-Item (Join-Path $KitDir $f) (Join-Path $Home_ $f) -Force } catch {} }

# ============================================================================
Step '8/9  Open Firefox so the extension connects'
if ($ffDir) {
  $ffRunning = Get-Process firefox -ErrorAction SilentlyContinue
  if ($ffRunning) { $ffRunning | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep 3 }
  try { Start-Process (Join-Path $ffDir 'firefox.exe') | Out-Null; Ok 'opened Firefox' } catch { Warn "firefox open: $($_.Exception.Message)" }
  if ($token) { for ($i=0;$i -lt 20;$i++){ Start-Sleep 3; try { $ni=Invoke-RestMethod "$Base/netinfo" -Headers @{ 'X-JAT-Token'=$token } -TimeoutSec 5; if ($ni.extensionConnected){ break } } catch {} } }
}

# ============================================================================
Step '9/9  Diagnostics -> USB + Pierre'
$diag=[ordered]@{ when=(Get-Date -Format o); computer=$env:COMPUTERNAME; role='pierre-laptop-server' }
try { $diag.appVersion=(Invoke-RestMethod "$Base/health" -TimeoutSec 5).version } catch { $diag.appVersion='unreachable' }
if ($token){ try { $ni=Invoke-RestMethod "$Base/netinfo" -Headers @{ 'X-JAT-Token'=$token } -TimeoutSec 6; $diag.extensionConnected=$ni.extensionConnected; $diag.interfaces=($ni.ips | ForEach-Object { "$($_.iface)=$($_.ip)" }) -join ', ' } catch {} }
try { $diag.tailscaleBackend=((& $tsExe status --json 2>$null | ConvertFrom-Json).BackendState) } catch {}
$diag.tailscaleIp=$tsIp; $diag.appToken=$token
try { $diag.watchdogTask=[bool](Get-ScheduledTask -TaskName 'JAT Watchdog' -ErrorAction SilentlyContinue) } catch {}
$diagJson=($diag | ConvertTo-Json)
Say ''; Say '---- LAPTOP ACCESS ----' 'Cyan'; Say ("Tailscale: {0} at {1}" -f $Hostname,$tsIp) 'White'; if ($token -and $tsIp){ Say "Dashboard: http://$tsIp`:$Port/app/?token=$token" 'White' }
try { Stop-Transcript | Out-Null } catch {}
try { Set-Content -Path (Join-Path $KitDir 'LAPTOP-ACCESS.json') -Value $diagJson -Encoding UTF8 } catch {}
foreach ($src in @($Transcript,(Join-Path $Home_ 'tailscale-join.log'))) { try { if (Test-Path $src){ Copy-Item $src (Join-Path $UsbLogs (Split-Path $src -Leaf)) -Force } } catch {} }
$full="=== DIAG ===`r`n$diagJson`r`n`r`n=== SUMMARY ===`r`n"+($report -join "`r`n")+"`r`n`r`n=== TAILSCALE ===`r`n"
try { $full += (Get-Content (Join-Path $Home_ 'tailscale-join.log') -Raw -ErrorAction SilentlyContinue) } catch {}
foreach ($t in $PierreTargets){ try { Invoke-RestMethod -Method Post -Uri ("http://{0}:{1}/remote/report?from={2}-SERVER" -f $t,$Port,$env:COMPUTERNAME) -Body $full -ContentType 'text/plain' -TimeoutSec 8 | Out-Null; Say "sent to Pierre ($t)" 'Green'; break } catch {} }
Say ''
if ($joined) { Say 'DONE. Laptop is on the tailnet + running. Pierre finishes config remotely (chunk 2).' 'Cyan' } else { Say 'DONE-ish. Tailscale did NOT join - see logs\tailscale-join.log on the USB.' 'Yellow' }
Read-Host 'Press Enter to close'
