# Build a portable Windows folder and ZIP. No installer or system changes.
param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $SkipBuild) {
  & (Join-Path $projectRoot 'dev.ps1') release
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$buildDir = Join-Path $projectRoot 'src-tauri\target\release'
$outputDir = Join-Path $projectRoot 'release\HeartWrite'
foreach ($name in @('novel-manager.exe', 'WebView2Loader.dll')) {
  if (-not (Test-Path -LiteralPath (Join-Path $buildDir $name))) {
    throw "Missing release file: $name"
  }
}
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $buildDir 'novel-manager.exe') -Destination (Join-Path $outputDir 'HeartWrite.exe') -Force
Copy-Item -LiteralPath (Join-Path $buildDir 'WebView2Loader.dll') -Destination $outputDir -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE') -Destination $outputDir -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '使用说明.txt') -Destination $outputDir -Force
$archive = Join-Path $projectRoot 'release\HeartWrite-Windows.zip'
Compress-Archive -LiteralPath $outputDir -DestinationPath $archive -Force
Write-Output "Portable app: $outputDir"
Write-Output "ZIP: $archive"
