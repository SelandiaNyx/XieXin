// 手机端界面截图（开发验收用）：无头 Chrome + 真实手机视口 + 触屏/粗指针模拟，
// 编号命名写入 .shots/，与 screenshot.ps1 同一套习惯。
// CDP 细节与回归测试共用 tests/lib/chrome-cdp.mjs，这里只负责参数与命名。
//
//   node tests/preview-server.cjs                                          # 先起预览服务
//   node .tooling/mobile-shot.mjs --name mobile-editor                     # 390×844 触屏
//   node .tooling/mobile-shot.mjs --name mobile-toc `
//     --eval "document.getElementById('toggleSidebar').click()"            # 目录抽屉
//   node .tooling/mobile-shot.mjs --name tablet --w 1024 --h 768           # 触屏平板（三栏 + ⋮）
//   node .tooling/mobile-shot.mjs --name desk --w 1440 --h 900 --hover     # 桌面（鼠标）对照
//
// --eval 会在截图前执行一段 JS；它同时也是断言手段——脚本抛错就说明界面行为不对。
// 只依赖 Node ≥ 22 与已安装的 Chrome/Edge（用 CHROME 环境变量可指定其它路径）。

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withBrowser, openPage, browserSupport, sleep } from '../tests/lib/chrome-cdp.mjs';

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const name = flag('name', 'mobile');
const width = Number(flag('w', 390));
const height = Number(flag('h', 844));
const dsf = Number(flag('dsf', 2));
const settle = Number(flag('wait', 3000));
const url = flag('url', 'http://127.0.0.1:4173/');
const snippet = flag('eval', '');
// --hover：真·鼠标设备（桌面端对照）；默认按触屏模拟
const touch = !has('hover');

/** --name 带目录分隔符时当作完整路径，否则自动编号写入 .shots/。 */
function outputPath() {
  if (/[\\/]/.test(name)) {
    const full = resolve(name);
    mkdirSync(dirname(full), { recursive: true });
    return full;
  }
  const dir = join(root, '.shots');
  mkdirSync(dir, { recursive: true });
  const used = readdirSync(dir).map((f) => /^(\d+)/.exec(f)).filter(Boolean).map((m) => Number(m[1]));
  const next = used.length ? Math.max(...used) + 1 : 1;
  return join(dir, `${String(next).padStart(2, '0')}-${name}.png`);
}

const support = browserSupport();
if (!support.ok) {
  console.error(support.reason);
  process.exit(1);
}
if (!existsSync(join(root, 'ui', 'index.html'))) {
  console.error('找不到 ui/index.html，请在仓库根目录运行');
  process.exit(1);
}

const out = outputPath();

await withBrowser(async (browser) => {
  const page = await openPage(browser, { url, width, height, dsf, touch, settle });
  try {
    if (snippet) {
      const value = await page.evaluate(snippet);
      if (value !== undefined && value !== null) console.log(`--eval → ${JSON.stringify(value)}`);
      // 给 --eval 里的点击留出动画时间（抽屉 280ms + 面板 280ms 这类过渡）
      await sleep(1400);
    }
    await page.screenshot(out);
    console.log(`saved ${out} (${width}x${height} @${dsf}x${touch ? ' · 触屏' : ' · 鼠标'})`);
  } finally {
    await page.close();
  }
}, { exe: support.exe });
