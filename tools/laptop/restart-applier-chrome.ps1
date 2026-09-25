# Restart the applier lane's Chrome so its extension service worker reconnects.
#
# WHY: the app was restarted several times tonight while deploying fixes. The extension is an MV3
# service worker; after those restarts it stopped talking - /ext/link reported connected=false with
# an EMPTY seenAt, meaning this app instance had never heard from it at all, and 45 runnable jobs
# sat undispatched because nothing was asking for work.
#
# SAFE: the profile lives on disk, so the Indeed login and the Cloudflare clearance cookie Pierre
# solved by hand both survive a restart. Only the browser process is replaced.
$ErrorActionPreference = 'SilentlyContinue'
$before = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*chrome-default*' })
Write-Output ("  stopping " + $before.Count + " chrome procs on chrome-default")
$before | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 6

# The keeper knows the right flags and refuses to start Chrome into a dead app, so use it rather
# than hand-rolling the launch.
& powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\laptop\chrome-keeper.ps1'
Start-Sleep -Seconds 35

$after = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -like '*chrome-default*' -and $_.CommandLine -notmatch '--type=' })
Write-Output ("  chrome-default browser procs: " + $after.Count)
Write-Output ("  chrome -> 7744 sockets      : " + @(Get-NetTCPConnection -RemotePort 7744 -State Established -ErrorAction SilentlyContinue |
  Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -eq 'chrome' }).Count)
