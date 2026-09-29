param(
  [string]$Name = "app",
  [string]$Url = "",
  [int]$WaitSeconds = 18,
  [switch]$NoMaximize
)

# 截图工具（开发验收用）：默认自动编号存到工程内的 .shots/，
# 形如 .shots/01-app.png；配合 `git add .shots` 就能把本次已核对的界面状态留在仓库里。
# 需要指定绝对路径时用 -Name 'D:\tmp\x.png'（含目录分隔符即视为完整路径）。
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinShot {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

$projectRoot = Split-Path -Parent $PSScriptRoot
$shotsDir = Join-Path $projectRoot '.shots'
$exe = Join-Path $env:USERPROFILE 'Desktop\novel manager\src-tauri\target\debug\novel-manager.exe'
if (-not (Test-Path $exe)) { $exe = 'C:\novel-manager-build\src-tauri\target\debug\novel-manager.exe' }

# 解析输出路径
if ($Name -match '[\\/]') {
  $out = $Name
} else {
  New-Item -ItemType Directory -Force -Path $shotsDir | Out-Null
  $existing = Get-ChildItem $shotsDir -Filter '*.png' -ErrorAction SilentlyContinue |
    Where-Object { $_.BaseName -match '^\d+' } |
    ForEach-Object { [int]($_.BaseName -replace '^(\d+).*', '$1') }
  $next = if ($existing) { ([int]($existing | Measure-Object -Maximum).Maximum) + 1 } else { 1 }
  $out = Join-Path $shotsDir ('{0:d2}-{1}.png' -f $next, $Name)
}

Get-Process novel-manager -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800

if ($Url) { $env:NOVEL_MANAGER_START_URL = $Url } else { Remove-Item Env:\NOVEL_MANAGER_START_URL -ErrorAction SilentlyContinue }
$proc = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds $WaitSeconds
$proc.Refresh()
if ($proc.HasExited) { Write-Error "应用已退出，退出码 $($proc.ExitCode)"; exit 1 }

$h = $proc.MainWindowHandle
if (-not $NoMaximize) { [void][WinShot]::ShowWindow($h, 3) }
Start-Sleep -Milliseconds 900
[void][WinShot]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 1200

$r = New-Object WinShot+RECT
[void][WinShot]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
$hgt = $r.Bottom - $r.Top

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $out) | Out-Null
$bmp = New-Object System.Drawing.Bitmap($w, $hgt)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][WinShot]::PrintWindow($h, $hdc, 2)   # PW_RENDERFULLCONTENT
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved $out ($w x $hgt)"
Stop-Process -Id $proc.Id -Force
