# Installs the JAT-Remote Bridge as a logon task in the interactive session, and firewalls its port
# to Tailscale only. Idempotent: safe to run again.
$ErrorActionPreference = 'Stop'
$Port = 7749
$Task = 'JAT-Remote-Bridge'
$Script = 'C:\ProgramData\JAT-Remote\jat-bridge.ps1'

# --- firewall: Tailscale CGNAT range only, never the LAN and never the internet ---------------
Get-NetFirewallRule -DisplayName $Task -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $Task -Direction Inbound -Action Allow -Protocol TCP `
  -LocalPort $Port -RemoteAddress '100.64.0.0/10' -Profile Any | Out-Null
Write-Output "FIREWALL ok  port $Port  from 100.64.0.0/10 only"

# --- scheduled task, running as the logged-on user so it lands in the interactive session -----
# "Run only when user is logged on" is the whole point: a task set to run whether-or-not-logged-on
# executes in session 0 and its screenshots come back blank, which is the bug this replaces.
Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:COMPUTERNAME\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" `
  -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Description 'JAT remote bridge: screen + input + exec in the interactive session' | Out-Null
Write-Output "TASK ok  $Task  logon trigger, interactive, highest"

# --- start it now, do not wait for the next logon --------------------------------------------
Start-ScheduledTask -TaskName $Task
Start-Sleep -Seconds 4
$t = Get-ScheduledTask -TaskName $Task
$i = Get-ScheduledTaskInfo -TaskName $Task
Write-Output "STATE  $($t.State)  lastResult=$($i.LastTaskResult)"

$listening = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Output "LISTENING on ${Port}: $listening"
