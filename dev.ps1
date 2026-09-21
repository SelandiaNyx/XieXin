# 写心开发脚本：把工具链与构建命令固定到工作区内，避免依赖系统环境。
#   用法： pwsh -File dev.ps1 check | build | run | test | smoke | release | clean
#
# 背景：MinGW 的 windres 无法处理带空格的路径（tauri-build 需要编译 Windows 资源），
# 因此这里通过一个无空格的目录联接（junction，默认 C:\novel-manager-build）进入工程。
param(
  [Parameter(Position = 0)]
  [ValidateSet('check', 'build', 'run', 'test', 'smoke', 'release', 'clean')]
  [string]$Task = 'check'
)

$ws = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:RUSTUP_HOME = Join-Path $ws '.rustup'
$env:CARGO_HOME = Join-Path $ws '.cargo'

# windows-gnu 目标使用工作区内自带的 MinGW-w64（w64devkit）作为链接器与 binutils
$mingw = Join-Path $ws '.tooling\mingw\w64devkit\bin'
if (-not (Test-Path (Join-Path $mingw 'gcc.exe'))) {
  Write-Error "缺少 MinGW 工具链：$mingw"
  exit 1
}
$env:PATH = "$(Join-Path $ws '.cargo\bin');$mingw;$env:PATH"
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu'

# 选择无空格的构建根目录：优先 junction，其次 8.3 短路径，最后退回原路径
$buildRoot = 'C:\novel-manager-build'
if (-not (Test-Path (Join-Path $buildRoot 'src-tauri\tauri.conf.json'))) {
  try {
    if (Test-Path $buildRoot) { Remove-Item $buildRoot -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Junction -Path $buildRoot -Target $ws -ErrorAction Stop | Out-Null
  } catch {
    $short = (& cmd /c "for %I in (`"$ws`") do @echo %~sI" | Select-Object -First 1).Trim()
    $buildRoot = if (Test-Path (Join-Path $short 'src-tauri\tauri.conf.json')) { $short } else { $ws }
  }
}
Set-Location $buildRoot

$manifest = 'src-tauri\Cargo.toml'
$exe = Join-Path $buildRoot 'src-tauri\target\debug\novel-manager.exe'

switch ($Task) {
  'check'   { cargo check --manifest-path $manifest }
  'build'   { cargo build --manifest-path $manifest }
  'test'    {
    cargo build --manifest-path $manifest
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    # 纯函数断言在应用内执行（--self-check），无需再启动测试可执行文件
    & $exe --self-check --data-dir (Join-Path $ws '.self-check-data')
    exit $LASTEXITCODE
  }
  'run'     { cargo run --manifest-path $manifest }
  'smoke'   {
    cargo build --manifest-path $manifest
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $exe --smoke-test --data-dir (Join-Path $ws '.smoke-data')
    exit $LASTEXITCODE
  }
  'release' { cargo build --release --manifest-path $manifest }
  'clean'   { cargo clean --manifest-path $manifest }
}
