// 无头 Chrome 的极简 CDP 客户端。
//
// 只依赖 Node 内置的 fetch / WebSocket（Node ≥ 22）与已安装的 Chrome / Edge，
// 不引入 puppeteer：这个仓库的界面是零依赖的原生 HTML/CSS/JS，测试也没必要拖一套 npm 依赖进来。
//
// 用途：tests/mobile-ui.test.mjs（窄屏/平板/桌面的界面回归）
//       与 .tooling/mobile-shot.mjs（同一条链路出验收截图）共用。

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** UI 会读 UA 判断"是不是手机"，所以两档设备要给出对应的 UA。 */
export const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
export const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** 能不能跑这一套（有没有浏览器、Node 有没有内置 WebSocket）。 */
export function browserSupport() {
  if (typeof WebSocket === 'undefined') return { ok: false, reason: '当前 Node 没有内置 WebSocket，需要 Node ≥ 22' };
  const exe = process.env.CHROME || CANDIDATES.find((p) => existsSync(p));
  if (!exe) return { ok: false, reason: '没找到 Chrome/Edge，可用 CHROME 环境变量指定路径' };
  return { ok: true, exe };
}

async function debuggerUrl(port, child) {
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode !== null) throw new Error(`浏览器已退出（code ${child.exitCode}）`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const info = await res.json();
      if (info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('浏览器调试端口未就绪');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const waiters = new Map();
    let id = 0;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: done, reject: fail } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) fail(new Error(`CDP ${msg.error.message || JSON.stringify(msg.error)}`));
        else done(msg.result);
      } else if (msg.method && waiters.has(msg.method)) {
        const list = waiters.get(msg.method);
        waiters.delete(msg.method);
        list.forEach((fn) => fn(msg.params));
      }
    });
    ws.addEventListener('error', () => reject(new Error('无法连接浏览器调试端口')));
    ws.addEventListener('open', () => resolve({
      send(method, params = {}, sessionId) {
        id += 1;
        return new Promise((done, fail) => {
          pending.set(id, { resolve: done, reject: fail });
          ws.send(JSON.stringify({ id, method, params, sessionId }));
        });
      },
      once(method) {
        return new Promise((done) => {
          const list = waiters.get(method) || [];
          list.push(done);
          waiters.set(method, list);
        });
      },
      close: () => ws.close(),
    }));
  });
}

/**
 * 起一个无头浏览器、执行 fn、无论如何都关掉。
 * fn 收到 { send, once, close }。
 */
export async function withBrowser(fn, { exe, port } = {}) {
  const support = browserSupport();
  const browserExe = exe || support.exe;
  if (!browserExe) throw new Error(support.reason || '没有可用的浏览器');
  const dbgPort = port || 9000 + Math.floor(Math.random() * 900);
  const profile = mkdtempSync(join(tmpdir(), 'xiexin-cdp-'));
  const child = spawn(browserExe, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--disable-background-networking',
    // 容器/CI 里以 root 跑必须关沙箱，Windows 上无副作用
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    const browser = await connect(await debuggerUrl(dbgPort, child));
    return await fn(browser);
  } finally {
    child.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结果 */ }
  }
}

/**
 * 打开一个页面并设好设备参数。
 * touch=true 会同时模拟触屏与 (hover: none) / (pointer: coarse)，也就是手机/平板的真实媒体特性。
 */
export async function openPage(browser, {
  url, width = 390, height = 844, dsf = 2, touch = true, settle = 2500, userAgent = '',
} = {}) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => browser.send(method, params, sessionId);

  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: dsf, mobile: touch, screenWidth: width, screenHeight: height,
  });
  // UA 覆盖用来模拟"这台设备是 Android"，UI 侧靠它决定要不要接返回键
  await call('Emulation.setUserAgentOverride', { userAgent: userAgent || (touch ? ANDROID_UA : DESKTOP_UA) });
  if (touch) {
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await call('Emulation.setEmulatedMedia', {
      features: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }],
    });
  } else {
    await call('Emulation.setEmulatedMedia', {
      features: [{ name: 'hover', value: 'hover' }, { name: 'pointer', value: 'fine' }],
    });
  }

  const loaded = browser.once('Page.loadEventFired');
  await call('Page.navigate', { url });
  await Promise.race([loaded, sleep(9000)]);
  await sleep(settle);

  return {
    sessionId,
    call,
    /** 执行一段 JS；表达式抛错就抛回来（断言失败即视为测试失败）。 */
    async evaluate(expression) {
      const res = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) {
        const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
        throw new Error(desc);
      }
      return res.result?.value;
    },
    /** 当前文档尺寸（用于核对 dvh / 安全区这类布局） */
    async metrics() {
      return this.evaluate('({ w: window.innerWidth, h: window.innerHeight })');
    },
    async screenshot(path) {
      const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(path, Buffer.from(shot.data, 'base64'));
      return path;
    },
    async close() {
      await browser.send('Target.closeTarget', { targetId });
    },
  };
}

export { sleep };
