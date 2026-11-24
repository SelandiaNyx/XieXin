#!/usr/bin/env node
// 真实桌面 GUI 启动冒烟验收：
//   直接拉起编译出来的真实可执行文件（debug 或 release/HeartWrite/HeartWrite.exe），
//   在无 MinGW PATH、独立临时数据目录下验证：
//     1. 同目录 WebView2Loader.dll 完备；
//     2. 进程不会提前崩溃退出；
//     3. 真正创建出可见的顶层窗口（MainWindowHandle != 0 且标题含「写心」）；
//     4. WebView2 成功加载前端并完成 IPC 握手（ui.log 含 BACKEND_SETUP / WINDOW_CREATED / UI_READY / boot ok）；
//     5. 启动过程中前端零未捕获异常（无 [error] / [reject] / boot FAILED）。
//
// 用法：
//   node tests/launch-smoke.mjs --exe "D:\MyCode\XieXin\release\HeartWrite\HeartWrite.exe"

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

function parseArgs(argv) {
  let exe = '';
  let timeoutMs = 25000;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--exe' && argv[i + 1]) {
      exe = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--timeout' && argv[i + 1]) {
      timeoutMs = Math.max(5000, Number(argv[i + 1]) || 25000);
      i += 1;
    }
  }
  if (!exe) {
    exe = path.resolve(import.meta.dirname, '../src-tauri/target/debug/novel-manager.exe');
  }
  return { exe: path.resolve(exe), timeoutMs };
}

function queryWindow(pid) {
  if (process.platform !== 'win32') return { handle: 1, title: '写心', width: 1440, height: 900, visible: true };
  const ps = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class WinEnum {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int maxCount);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  public static object Find(uint targetPid) {
    long bestHandle = 0; string bestTitle = ""; int bw = 0; int bh = 0; bool vis = false;
    EnumWindows((h, _) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != targetPid) return true;
      bool v = IsWindowVisible(h);
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, sb.Capacity);
      string t = sb.ToString();
      RECT r; GetWindowRect(h, out r);
      int w = r.Right - r.Left; int ht = r.Bottom - r.Top;
      if (v && t.Length > 0 && w > 0 && ht > 0) {
        bestHandle = h.ToInt64(); bestTitle = t; bw = w; bh = ht; vis = true;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return new { handle = bestHandle, title = bestTitle, width = bw, height = bh, visible = vis };
  }
}
"@
[WinEnum]::Find(${pid}) | ConvertTo-Json -Compress
`;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      timeout: 8000,
    }).trim();
    if (!out) return { handle: 0, title: '', width: 0, height: 0, visible: false };
    return JSON.parse(out);
  } catch {
    return { handle: 0, title: '', width: 0, height: 0, visible: false };
  }
}

function cleanPathEnv(rawPath) {
  return String(rawPath || '')
    .split(path.delimiter)
    .filter((seg) => !/mingw|w64devkit|\.cargo|\.rustup/i.test(seg))
    .join(path.delimiter);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { exe, timeoutMs } = parseArgs(process.argv.slice(2));
  const exeDir = path.dirname(exe);
  assert.ok(fs.existsSync(exe), `可执行文件不存在：${exe}`);
  if (process.platform === 'win32') {
    const loader = path.join(exeDir, 'WebView2Loader.dll');
    assert.ok(fs.existsSync(loader), `缺少同目录依赖：${loader}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartwrite-launch-'));
  const logPath = path.join(tmpDir, 'ui.log');
  const env = { ...process.env };
  // 移除开发工具链路径，严格模拟普通用户双击运行环境
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') env[key] = cleanPathEnv(env[key]);
  }
  delete env.NOVEL_MANAGER_SELFTEST;
  delete env.NOVEL_MANAGER_UITEST;
  delete env.NOVEL_MANAGER_START_URL;

  const startedAt = Date.now();
  let exited = false;
  let exitCode = null;
  let stdout = '';
  let stderr = '';

  const child = spawn(exe, ['--data-dir', tmpDir], {
    cwd: exeDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
  });

  let winInfo = { handle: 0, title: '' };
  let logText = '';
  let passed = false;

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exited) {
        throw new Error(
          `应用在启动完成前异常退出（exitCode=${exitCode}）\nSTDOUT: ${stdout}\nSTDERR: ${stderr}\nLOG:\n${logText}`,
        );
      }
      if (fs.existsSync(logPath)) {
        logText = fs.readFileSync(logPath, 'utf8');
      }
      if (/\[error\]|\[reject\]|boot FAILED/.test(logText)) {
        throw new Error(`前端启动期出现未捕获异常：\n${logText}`);
      }
      winInfo = queryWindow(child.pid);
      const hasWindow = Boolean(
        winInfo.visible &&
          winInfo.handle &&
          winInfo.width >= 800 &&
          winInfo.height >= 500 &&
          String(winInfo.title || '').includes('写心'),
      );
      const hasBackend = logText.includes('BACKEND_SETUP');
      const hasCreated = logText.includes('WINDOW_CREATED');
      const hasUiReady = logText.includes('UI_READY');
      const hasBootOk = logText.includes('boot ok');

      if (hasWindow && hasBackend && hasCreated && hasUiReady && hasBootOk) {
        passed = true;
        break;
      }
      await sleep(300);
    }

    if (!passed) {
      throw new Error(
        `启动验证超时（${timeoutMs}ms）：` +
          `visible=${winInfo.visible} handle=${winInfo.handle} size=${winInfo.width}x${winInfo.height} ` +
          `title=${JSON.stringify(winInfo.title)} ` +
          `hasBackend=${logText.includes('BACKEND_SETUP')} ` +
          `hasCreated=${logText.includes('WINDOW_CREATED')} ` +
          `hasUiReady=${logText.includes('UI_READY')} ` +
          `hasBootOk=${logText.includes('boot ok')}\n` +
          `ui.log:\n${logText || '（空）'}`,
      );
    }

    const elapsed = Date.now() - startedAt;
    console.log(
      `[launch-smoke] PASS (${elapsed}ms) exe=${path.basename(exe)} pid=${child.pid} ` +
        `handle=${winInfo.handle} size=${winInfo.width}x${winInfo.height} title=${JSON.stringify(winInfo.title)}`,
    );
  } finally {
    if (!exited) {
      try {
        if (process.platform === 'win32') {
          execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          child.kill('SIGTERM');
        }
      } catch { /* ignore */ }
    }
    await sleep(300);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error(`[launch-smoke] FAIL: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
