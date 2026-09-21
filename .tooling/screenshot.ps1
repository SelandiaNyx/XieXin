param(
  [string]$Out = "C:\novel-manager-build\.shots\app.png",
  [string]$Url = "",
  [int]$WaitSeconds = 18
)

# 截图工具（开发验收用）：用 PrintWindow 抓取窗口自身的渲染内容，
# 不受窗口是否在最前、是否被遮挡影响。
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

$exe = 'C:\novel-manager-build\src-tauri\target\debug\novel-manager.exe'
Get-Process novel-manager -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800

if ($Url) { $env:NOVEL_MANAGER_START_URL = $Url } else { Remove-Item Env:\NOVEL_MANAGER_START_URL -ErrorAction SilentlyContinue }
$proc = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds $WaitSeconds
$proc.Refresh()
if ($proc.HasExited) { Write-Error "应用已退出，退出码 $($proc.ExitCode)"; exit 1 }

$h = $proc.MainWindowHandle
[void][WinShot]::ShowWindow($h, 3)
Start-Sleep -Milliseconds 900
[void][WinShot]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 1200

$r = New-Object WinShot+RECT
[void][WinShot]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
$hgt = $r.Bottom - $r.Top

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null
$bmp = New-Object System.Drawing.Bitmap($w, $hgt)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[void][WinShot]::PrintWindow($h, $hdc, 2)   # PW_RENDERFULLCONTENT
$g.ReleaseHdc($hdc)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved $Out ($w x $hgt) pid=$($proc.Id)"
Stop-Process -Id $proc.Id -Force
