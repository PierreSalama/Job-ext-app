# JAT-Remote Bridge — runs INSIDE the interactive desktop session so it can see the screen.
#
# Why this exists: SSH on Windows lands in session 0. A screenshot taken from there returns a blank
# 1024x768 buffer and a Win32Exception, because session 0 has no desktop. Everything that needs eyes
# or hands on the real screen has to run in session 1, which is what the logon scheduled task gives us.
#
# Bound to every interface but firewalled to Tailscale's 100.64.0.0/10 only. Token in a header.
param(
  [int]$Port = 7749,
  [string]$TokenPath = "$env:ProgramData\JAT-Remote\bridge.token"
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$LogDir = "$env:ProgramData\JAT-Remote"
$LogFile = Join-Path $LogDir 'bridge.log'
$MAX_LOG_LINE = 400
$MAX_LOG_BYTES = 4194304
function Log($msg) {
  # A single exec line can carry a whole source file inline (an Add-Content of db.js), so trimming
  # the log to N lines never bounded its size: 1127 lines were 8 MB. Cap the line, rotate on bytes.
  $m = [string]$msg
  if ($m.Length -gt $MAX_LOG_LINE) { $m = $m.Substring(0, $MAX_LOG_LINE) + ' ...[' + ($m.Length - $MAX_LOG_LINE) + ' more chars]' }
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  try {
    if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt $MAX_LOG_BYTES)) {
      Move-Item -Path $LogFile -Destination ($LogFile + '.1') -Force -ErrorAction SilentlyContinue
    }
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
  } catch { }
}

if (-not (Test-Path $TokenPath)) { throw "no token at $TokenPath" }
$Token = (Get-Content $TokenPath -Raw).Trim()
if ($Token.Length -lt 16) { throw 'token too short' }

# TWO TOKENS, TWO SCOPES.
#
# Dad needs to see the laptop's screen and type a LinkedIn password into it. He does NOT need
# /exec, which is an unrestricted remote shell running as an Administrator. Handing him the admin
# token to solve a login problem would give away the machine, so the viewer token exists and is
# refused on every route that can change anything.
#
# The viewer token is generated on first run and lives beside the admin one.
$ViewerPath = Join-Path (Split-Path $TokenPath -Parent) 'viewer.token'
if (-not (Test-Path $ViewerPath)) {
  $bytes = New-Object 'System.Byte[]' 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  ($bytes | ForEach-Object { $_.ToString('x2') }) -join '' | Set-Content -Path $ViewerPath -Encoding ASCII -NoNewline
}
$ViewerToken = (Get-Content $ViewerPath -Raw).Trim()

# Everything not listed here is admin-only. Deny by default: a route added later is locked until
# somebody deliberately opens it, rather than silently inheriting viewer access.
$VIEWER_ROUTES = @('/health', '/screen', '/click', '/type', '/dad', '/dadapi')

# --- win32 for mouse + foreground window -----------------------------------------------------
$sig = @'
using System;
using System.Runtime.InteropServices;
public class JatNative {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
  public static string ForegroundTitle() {
    IntPtr h = GetForegroundWindow();
    int len = GetWindowTextLength(h);
    if (len <= 0) return "";
    var sb = new System.Text.StringBuilder(len + 1);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue

# --- helpers ---------------------------------------------------------------------------------
function Send-Json($ctx, $obj, [int]$code = 200) {
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $ctx.Response.StatusCode = $code
  $ctx.Response.ContentType = 'application/json'
  $ctx.Response.ContentLength64 = $bytes.Length
  $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Send-Bytes($ctx, [byte[]]$bytes, $type) {
  $ctx.Response.StatusCode = 200
  $ctx.Response.ContentType = $type
  $ctx.Response.ContentLength64 = $bytes.Length
  $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Read-Body($ctx) {
  if (-not $ctx.Request.HasEntityBody) { return @{} }
  $sr = New-Object IO.StreamReader($ctx.Request.InputStream, $ctx.Request.ContentEncoding)
  $raw = $sr.ReadToEnd(); $sr.Close()
  if ([string]::IsNullOrWhiteSpace($raw)) { return @{} }
  return ($raw | ConvertFrom-Json)
}

# Capture the whole virtual desktop. scale shrinks the PNG before it goes over the wire — a full
# 1080p screenshot is ~2MB and most of the time a half-size one answers the question.
function Get-ScreenPng([double]$scale = 1.0) {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object Drawing.Bitmap $vs.Width, $vs.Height
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($vs.Location, [Drawing.Point]::Empty, $vs.Size)
  $g.Dispose()
  $out = $bmp
  if ($scale -gt 0 -and $scale -lt 1.0) {
    $w = [int]($vs.Width * $scale); $h = [int]($vs.Height * $scale)
    $small = New-Object Drawing.Bitmap $w, $h
    $sg = [Drawing.Graphics]::FromImage($small)
    $sg.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.DrawImage($bmp, 0, 0, $w, $h)
    $sg.Dispose(); $bmp.Dispose()
    $out = $small
  }
  $ms = New-Object IO.MemoryStream
  $out.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  return $ms.ToArray()
}

# Run a command in THIS session, so anything it launches gets a real desktop.
function Invoke-Local($cmd, [int]$timeoutSec = 120) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = 'powershell.exe'
  $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ' + '"' + ($cmd -replace '"', '\"') + '"'
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $p = [Diagnostics.Process]::Start($psi)
  $so = $p.StandardOutput.ReadToEndAsync()
  $se = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($timeoutSec * 1000)) {
    try { $p.Kill() } catch { }
    return @{ ok = $false; code = -1; stdout = ''; stderr = "timed out after ${timeoutSec}s" }
  }
  return @{ ok = ($p.ExitCode -eq 0); code = $p.ExitCode; stdout = $so.Result; stderr = $se.Result }
}

# --- listener --------------------------------------------------------------------------------
$listener = New-Object Net.HttpListener
$listener.Prefixes.Add("http://+:$Port/")
$listener.Start()
Log "bridge up on :$Port as $env:USERNAME session $((Get-Process -Id $PID).SessionId)"

while ($listener.IsListening) {
  $ctx = $null
  try {
    $ctx = $listener.GetContext()
    $path = $ctx.Request.Url.AbsolutePath.TrimEnd('/')
    if ($path -eq '') { $path = '/' }

    # A browser opening the viewer page cannot set a header, so /dad ALSO accepts ?token=.
    # Same compromise the JAT dashboard already makes, and it is the low-privilege token on a
    # Tailscale-only port — but it is confined to /dad so no state-changing route can be driven
    # from a URL someone pastes or a link someone clicks.
    $supplied = $ctx.Request.Headers['x-jat-token']
    if (-not $supplied -and $path -eq '/dad') { $supplied = $ctx.Request.QueryString['token'] }
    $isAdmin  = ($supplied -eq $Token)
    $isViewer = ($supplied -eq $ViewerToken)
    if (-not ($isAdmin -or $isViewer)) {
      Log "401 $path from $($ctx.Request.RemoteEndPoint)"
      Send-Json $ctx @{ ok = $false; error = 'bad token' } 401
      $ctx.Response.Close(); continue
    }
    # /dadapi is the one route with a path BELOW it (/dadapi/queue, /dadapi/health), so it needs a
    # prefix test. Everything else stays exact-match, because a prefix rule applied generally would
    # quietly widen viewer access every time a route was added.
    $viewerAllowed = ($VIEWER_ROUTES -contains $path) -or ($path -like '/dadapi*')
    if ($isViewer -and -not $viewerAllowed) {
      Log "403 viewer tried $path from $($ctx.Request.RemoteEndPoint)"
      Send-Json $ctx @{ ok = $false; error = "the viewer token cannot use $path" } 403
      $ctx.Response.Close(); continue
    }

    switch -Regex ($path) {

      '^/health$' {
        Send-Json $ctx @{
          ok        = $true
          host      = $env:COMPUTERNAME
          user      = $env:USERNAME
          session   = (Get-Process -Id $PID).SessionId
          screen    = ("{0}x{1}" -f [System.Windows.Forms.SystemInformation]::VirtualScreen.Width, [System.Windows.Forms.SystemInformation]::VirtualScreen.Height)
          foreground = [JatNative]::ForegroundTitle()
          version   = '1.1.0'
          scope     = $(if ($isAdmin) { 'admin' } else { 'viewer' })
        }
      }

      '^/screen$' {
        $scale = 1.0
        $q = $ctx.Request.QueryString['scale']
        if ($q) { $scale = [double]$q }
        Send-Bytes $ctx (Get-ScreenPng $scale) 'image/png'
      }

      '^/exec$' {
        $b = Read-Body $ctx
        $t = 120; if ($b.timeout) { $t = [int]$b.timeout }
        $r = Invoke-Local $b.cmd $t
        Log "exec rc=$($r.code): $($b.cmd)"
        Send-Json $ctx $r
      }

      '^/click$' {
        $b = Read-Body $ctx
        [void][JatNative]::SetCursorPos([int]$b.x, [int]$b.y)
        Start-Sleep -Milliseconds 60
        $dn = [JatNative]::LEFTDOWN; $up = [JatNative]::LEFTUP
        if ($b.button -eq 'right') { $dn = [JatNative]::RIGHTDOWN; $up = [JatNative]::RIGHTUP }
        [JatNative]::mouse_event($dn, 0, 0, 0, [IntPtr]::Zero)
        [JatNative]::mouse_event($up, 0, 0, 0, [IntPtr]::Zero)
        Send-Json $ctx @{ ok = $true; x = $b.x; y = $b.y }
      }

      '^/type$' {
        $b = Read-Body $ctx
        [System.Windows.Forms.SendKeys]::SendWait($b.text)
        Send-Json $ctx @{ ok = $true; sent = $b.text.Length }
      }

      '^/dad$' {
        # A plain file on disk, so the page can be edited without restarting the listener.
        $f = Join-Path (Split-Path $TokenPath -Parent) 'dad.html'
        if (-not (Test-Path $f)) { Send-Json $ctx @{ ok = $false; error = 'dad.html not installed' } 404; break }
        $bytes = [IO.File]::ReadAllBytes($f)
        Send-Bytes $ctx $bytes 'text/html; charset=utf-8'
      }

      # PROXY TO ASHRAF'S INSTANCE.
      #
      # The page is served from :7749 and his data lives on :7745, so a direct fetch is
      # cross-origin and the browser blocks it. Proxying is the better answer anyway: the app
      # token stays HERE, on the machine, instead of being shipped into his browser where anyone
      # with the page source could lift it. His browser only ever holds the viewer token.
      #
      # Hard-wired to 7745. It must never be able to address 7744.
      '^/dadapi' {
        $sub = $ctx.Request.Url.PathAndQuery -replace '^/dadapi', ''
        if (-not $sub) { $sub = '/health' }
        $dadTokenPath = Join-Path (Split-Path $TokenPath -Parent) 'dad.token'
        if (-not (Test-Path $dadTokenPath)) { Send-Json $ctx @{ ok = $false; error = 'dad.token not installed' } 503; break }
        $dadToken = (Get-Content $dadTokenPath -Raw).Trim()
        try {
          $r = Invoke-WebRequest ('http://127.0.0.1:7745' + $sub) -Headers @{ 'X-JAT-Token' = $dadToken } -TimeoutSec 30 -UseBasicParsing
          # -UseBasicParsing hands back a STRING here, and Send-Bytes is typed [byte[]]. Passing it
          # straight through fails with "cannot process argument transformation" and reads like the
          # dad instance is down when it is fine.
          $body = $r.Content
          if ($body -isnot [byte[]]) { $body = [Text.Encoding]::UTF8.GetBytes([string]$body) }
          Send-Bytes $ctx $body 'application/json'
        } catch {
          Send-Json $ctx @{ ok = $false; error = ('dad instance: ' + $_.Exception.Message) } 502
        }
      }

      '^/shutdown$' {
        Send-Json $ctx @{ ok = $true; msg = 'stopping' }
        $ctx.Response.Close()
        Log 'shutdown requested'
        $listener.Stop(); break
      }

      default { Send-Json $ctx @{ ok = $false; error = "no route $path" } 404 }
    }
    if ($ctx) { $ctx.Response.Close() }
  }
  catch {
    Log "ERROR $($_.Exception.Message)"
    try { if ($ctx) { Send-Json $ctx @{ ok = $false; error = $_.Exception.Message } 500; $ctx.Response.Close() } } catch { }
  }
}
Log 'bridge stopped'
