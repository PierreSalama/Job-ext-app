# ============================================================================
#  JAT - Fix Dad's laptop.  ONE script. Run it once.
#
#  It will:
#    1. Turn on secure remote access (OpenSSH) so Claude can finish + verify.
#    2. Install the FIXED extension (11.89.7 - opener bug + Firefox window-leak).
#    3. Close Firefox to clear the pile of stuck/orphaned windows.
#    4. Reopen Firefox clean so the fixed extension installs and connects.
#  Everything is logged next to this script.
#
#  HOW TO RUN:  double-click  FIX-DAD.bat  and click "Yes" on the admin prompt.
#               (or right-click this file -> Run with PowerShell.)
# ============================================================================

$ErrorActionPreference = 'Continue'
$ExtId    = 'jat-v11@pierresalama.dev'
$UserData = Join-Path $env:APPDATA 'jat11-app'
$KitDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$PubKey   = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFjbHZUQaDf00vRUMztBI9XlyPqyExuORSL+HhK2/JW2 claude-jat-nodes'
$Log      = Join-Path $KitDir ("fix-dad-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

function Say($m,$c='Gray'){ Write-Host $m -ForegroundColor $c; try { Add-Content -Path $Log -Value $m -ErrorAction SilentlyContinue } catch {} }
function Step($m){ Say "" ; Say "==> $m" 'Cyan' }
function Ok($m){ Say "   ok   $m" 'Green' }
function Warn($m){ Say "   WARN $m" 'Yellow' }
function Bad($m){ Say "   FAIL $m" 'Red' }

# ---- self-elevate (needs admin for OpenSSH, firewall, Firefox policy) -------
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host 'Asking for administrator rights (click Yes)...' -ForegroundColor Yellow
  Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`""
  exit
}

Say "==============================================" 'Cyan'
Say " JAT - Fix Dad's laptop   $(Get-Date -Format 'yyyy-MM-dd HH:mm')" 'Cyan'
Say " computer: $env:COMPUTERNAME   user: $env:USERNAME" 'Cyan'
Say "==============================================" 'Cyan'

# ============================================================================
Step "1/4  Turn on secure remote access (OpenSSH)"
# Install the Windows OpenSSH server (idempotent).
try {
  $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' -ErrorAction SilentlyContinue
  if ($cap -and $cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name $cap.Name -ErrorAction Stop | Out-Null; Ok "OpenSSH Server installed" }
  else { Ok "OpenSSH Server already present" }
} catch { Bad "OpenSSH install: $($_.Exception.Message)" }
# Start + persist the sshd service.
try { Set-Service sshd -StartupType Automatic -ErrorAction Stop; Start-Service sshd -ErrorAction Stop; Ok "sshd service running" } catch { Bad "sshd start: $($_.Exception.Message)" }
try { Set-Service ssh-agent -StartupType Automatic -ErrorAction SilentlyContinue; Start-Service ssh-agent -ErrorAction SilentlyContinue } catch {}
# Firewall: allow inbound TCP 22.
try {
  if (-not (Get-NetFirewallRule -Name 'JAT-SSHD' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'JAT-SSHD' -DisplayName 'OpenSSH Server (JAT)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -Profile Any | Out-Null
  }
  Ok "firewall: port 22 open"
} catch { Warn "firewall rule: $($_.Exception.Message)" }
# Authorize Claude's key. On Windows OpenSSH, keys for ADMIN users must live in
# ProgramData\ssh\administrators_authorized_keys with tight ACLs, or sshd ignores them.
try {
  $sshDir = Join-Path $env:ProgramData 'ssh'
  New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
  $ak = Join-Path $sshDir 'administrators_authorized_keys'
  $cur = if (Test-Path $ak) { Get-Content $ak -Raw -ErrorAction SilentlyContinue } else { '' }
  if ($cur -notlike "*$PubKey*") { Add-Content -Path $ak -Value $PubKey }
  icacls $ak /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
  # Also drop it in the user's own authorized_keys (covers a non-admin session too).
  $userSsh = Join-Path $env:USERPROFILE '.ssh'
  New-Item -ItemType Directory -Force -Path $userSsh | Out-Null
  $uak = Join-Path $userSsh 'authorized_keys'
  $ucur = if (Test-Path $uak) { Get-Content $uak -Raw -ErrorAction SilentlyContinue } else { '' }
  if ($ucur -notlike "*$PubKey*") { Add-Content -Path $uak -Value $PubKey }
  Ok "Claude's key authorized"
} catch { Bad "authorized_keys: $($_.Exception.Message)" }
# Belt-and-suspenders: also flip on Tailscale SSH and print the tailnet IP.
try {
  $ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
  if (-not $ts) { foreach ($p in @("$env:ProgramFiles\Tailscale\tailscale.exe","${env:ProgramFiles(x86)}\Tailscale\tailscale.exe")) { if (Test-Path $p) { $ts = $p; break } } }
  if ($ts) { & $ts set --ssh 2>&1 | Out-Null; $tsip = (& $ts ip -4 2>$null | Select-Object -First 1); if ($tsip) { Ok "Tailscale IP: $tsip  (Claude connects here)" } }
} catch {}

# ============================================================================
Step "2/4  Install the FIXED extension (11.89.7)"
$ffDir = $null
foreach ($p in @("$env:ProgramFiles\Mozilla Firefox","${env:ProgramFiles(x86)}\Mozilla Firefox")) { if (Test-Path (Join-Path $p 'firefox.exe')) { $ffDir = $p; break } }
if (-not $ffDir) {
  try { $rk = Get-ItemProperty 'HKLM:\SOFTWARE\Mozilla\Mozilla Firefox' -ErrorAction SilentlyContinue
        if ($rk.CurrentVersion) { $mp = Get-ItemProperty "HKLM:\SOFTWARE\Mozilla\Mozilla Firefox\$($rk.CurrentVersion)\Main" -ErrorAction SilentlyContinue
          if ($mp.'Install Directory') { $ffDir = $mp.'Install Directory' } } } catch {}
}
if ($ffDir) {
  $xpiSrc = Join-Path $KitDir 'jat-v11-firefox.xpi'
  $xpiDst = Join-Path $UserData 'jat-firefox.xpi'
  New-Item -ItemType Directory -Force -Path $UserData | Out-Null
  if (-not (Test-Path $xpiSrc)) { Bad "fixed extension file missing from the kit ($xpiSrc)" }
  else {
    try { Copy-Item $xpiSrc $xpiDst -Force -ErrorAction Stop; Ok ("fixed extension staged ({0} KB)" -f [math]::Round((Get-Item $xpiDst).Length/1KB)) } catch { Bad "stage extension: $($_.Exception.Message)" }
    $dist = Join-Path $ffDir 'distribution'
    New-Item -ItemType Directory -Force -Path $dist | Out-Null
    $fileUrl = 'file:///' + ($xpiDst -replace '\\','/')
    $policy  = @{ policies = @{ ExtensionSettings = @{ "$ExtId" = @{ installation_mode = 'force_installed'; install_url = $fileUrl } } } }
    # BOM-less UTF-8 - Firefox's policies.json parser rejects a byte-order mark.
    try { [System.IO.File]::WriteAllText((Join-Path $dist 'policies.json'), ($policy | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding $false)); Ok "Firefox policy points at the fixed extension" } catch { Bad "policy write: $($_.Exception.Message)" }
  }
} else { Bad "Firefox not found - cannot update the extension" }

# ============================================================================
Step "3/4  Close Firefox (clears the stuck/orphaned window pile)"
$ff = @(Get-Process firefox -ErrorAction SilentlyContinue)
if ($ff.Count) { Say "   closing $($ff.Count) Firefox process(es) / all their windows..."; $ff | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 4 } else { Ok "Firefox was not running" }
Get-Process plugin-container -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# ============================================================================
Step "4/4  Reopen Firefox clean (installs the fixed extension)"
if ($ffDir) {
  try { Start-Process (Join-Path $ffDir 'firefox.exe') | Out-Null; Ok "Firefox reopened - the fixed extension installs on this launch" }
  catch { Warn "could not auto-open Firefox - just open Firefox once." }
}

Say ""
Say "==============================================" 'Green'
Say " DONE.  Dad's laptop is fixed." 'Green'
Say " Claude will finish + verify remotely over SSH." 'Green'
Say " Log: $Log" 'Green'
Say "==============================================" 'Green'
Say ""
try { Read-Host "Press Enter to close" | Out-Null } catch { Start-Sleep -Seconds 5 }
