# ============================================================================
#  Enable SSH on Dad's laptop  (v2, hardened - SSH ONLY, does not touch Firefox)
#  Fixes the common Windows-OpenSSH pubkey gotchas: writes the key to the REAL
#  logged-in user's profile (not the elevated admin's), sets correct ACLs + owner
#  on BOTH the per-user and administrators key files, ensures pubkey auth is on,
#  and restarts sshd. Writes a diagnostic file next to itself.
#
#  RUN:  double-click ENABLE-SSH.bat  ->  click "Yes".
# ============================================================================
$ErrorActionPreference = 'Continue'
$PubKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFjbHZUQaDf00vRUMztBI9XlyPqyExuORSL+HhK2/JW2 claude-jat-nodes'
$KitDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Log = Join-Path $KitDir ("enable-ssh-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
function Say($m,$c='Gray'){ Write-Host $m -ForegroundColor $c; try { Add-Content -Path $Log -Value $m -ErrorAction SilentlyContinue } catch {} }
function Ok($m){ Say "   ok   $m" 'Green' }; function Warn($m){ Say "   WARN $m" 'Yellow' }; function Bad($m){ Say "   FAIL $m" 'Red' }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host 'Asking for administrator rights (click Yes)...' -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`""
  exit
}

Say "==============================================" 'Cyan'
Say " Enable SSH (v2)   $(Get-Date -Format 'yyyy-MM-dd HH:mm')" 'Cyan'

# --- Resolve the REAL logged-in console user (NOT the elevated admin) ---
$consoleUser = $null; $consoleProfile = $null
try {
  $cs = (Get-CimInstance Win32_ComputerSystem).UserName    # e.g. DESKTOP-671TKUN\Ashraf
  if ($cs) { $consoleUser = $cs.Split('\')[-1] }
} catch {}
if (-not $consoleUser) { $consoleUser = $env:USERNAME }
try {
  $prof = Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -like "*\$consoleUser" -and -not $_.Special } | Select-Object -First 1
  if ($prof) { $consoleProfile = $prof.LocalPath }
} catch {}
if (-not $consoleProfile) { $consoleProfile = Join-Path 'C:\Users' $consoleUser }
$isAdminUser = $false
try { $isAdminUser = (Get-LocalGroupMember -Group 'Administrators' -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*\$consoleUser" }).Count -gt 0 } catch {}
Say " login user : $consoleUser   (admin: $isAdminUser)" 'Cyan'
Say " profile    : $consoleProfile" 'Cyan'
Say " computer   : $env:COMPUTERNAME" 'Cyan'
Say "==============================================" 'Cyan'

# --- OpenSSH server + service + firewall ---
try {
  $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' -ErrorAction SilentlyContinue
  if ($cap -and $cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name $cap.Name -ErrorAction Stop | Out-Null; Ok 'OpenSSH Server installed' } else { Ok 'OpenSSH Server present' }
} catch { Bad "OpenSSH install: $($_.Exception.Message)" }
try { Set-Service sshd -StartupType Automatic; Start-Service sshd; Ok 'sshd running' } catch { Bad "sshd: $($_.Exception.Message)" }
try { if (-not (Get-NetFirewallRule -Name 'JAT-SSHD' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -Name 'JAT-SSHD' -DisplayName 'OpenSSH Server (JAT)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -Profile Any | Out-Null }; Ok 'firewall 22 open' } catch { Warn "firewall: $($_.Exception.Message)" }

# --- Ensure pubkey auth is enabled in sshd_config ---
try {
  $cfg = Join-Path $env:ProgramData 'ssh\sshd_config'
  if (Test-Path $cfg) {
    $c = Get-Content $cfg -Raw
    if ($c -notmatch '(?m)^\s*PubkeyAuthentication\s+yes') { Add-Content $cfg "`nPubkeyAuthentication yes"; Ok 'PubkeyAuthentication yes ensured' }
  }
} catch { Warn "sshd_config: $($_.Exception.Message)" }

# --- Authorize the key in the REAL user's ~/.ssh/authorized_keys (covers standard users) ---
try {
  $userSsh = Join-Path $consoleProfile '.ssh'
  New-Item -ItemType Directory -Force -Path $userSsh | Out-Null
  $uak = Join-Path $userSsh 'authorized_keys'
  $ucur = if (Test-Path $uak) { Get-Content $uak -Raw -ErrorAction SilentlyContinue } else { '' }
  if ($ucur -notlike "*$PubKey*") { Add-Content -Path $uak -Value $PubKey }
  # per-user key file: owner = the user, access = user + SYSTEM only
  icacls $uak /inheritance:r /grant "${consoleUser}:F" /grant 'SYSTEM:F' | Out-Null
  icacls $uak /setowner "$consoleUser" | Out-Null
  Ok "authorized_keys written for $consoleUser"
} catch { Bad "user authorized_keys: $($_.Exception.Message)" }

# --- Also administrators_authorized_keys (covers admin users) with correct owner+ACL ---
try {
  $sshDir = Join-Path $env:ProgramData 'ssh'; New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
  $ak = Join-Path $sshDir 'administrators_authorized_keys'
  $cur = if (Test-Path $ak) { Get-Content $ak -Raw -ErrorAction SilentlyContinue } else { '' }
  if ($cur -notlike "*$PubKey*") { Add-Content -Path $ak -Value $PubKey }
  icacls $ak /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
  icacls $ak /setowner 'Administrators' | Out-Null
  Ok 'administrators_authorized_keys written'
} catch { Bad "admin authorized_keys: $($_.Exception.Message)" }

# --- restart sshd so any config change takes effect ---
try { Restart-Service sshd -Force; Ok 'sshd restarted' } catch { Warn "restart: $($_.Exception.Message)" }

# --- diagnostic dump (so Claude can see exactly what happened if it's still refused) ---
try {
  Say ""; Say "----- diagnostic -----" 'Yellow'
  Say ("whoami            : " + (whoami))
  Say ("console UserName  : " + ((Get-CimInstance Win32_ComputerSystem).UserName))
  Say ("sshd status       : " + (Get-Service sshd).Status)
  Say ("admin key ACL     :"); (icacls (Join-Path $env:ProgramData 'ssh\administrators_authorized_keys') 2>&1) | ForEach-Object { Say "   $_" }
  Say ("user  key ACL     :"); (icacls (Join-Path $consoleProfile '.ssh\authorized_keys') 2>&1) | ForEach-Object { Say "   $_" }
  $ips = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '169.*' -and $_.IPAddress -ne '127.0.0.1' } | Select-Object -ExpandProperty IPAddress) -join ', '
  Say ("addresses         : $ips")
  Say ("=> Claude connects with:  ssh $consoleUser@<one of the IPs above>") 'Green'
} catch { Warn "diag: $($_.Exception.Message)" }

Say ""
Say "==============================================" 'Green'
Say " DONE. Tell Claude the 'login user' shown above" 'Green'
Say " if it still can't connect. Log: $Log" 'Green'
Say "==============================================" 'Green'
try { Read-Host "Press Enter to close" | Out-Null } catch { Start-Sleep -Seconds 5 }
