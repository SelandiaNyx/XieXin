// 移动端界面回归：用无头 Chrome 以真实手机/平板视口跑真实界面（内存示例数据）。
//
// 覆盖三档，重点是确认「窄屏规则」和「触屏规则」各自生效、且都不会污染桌面布局：
//   · 窄屏触屏 390×844  —— 单列 + 抽屉 + ⋮ 操作面板 + 整屏弹层；
//   · 宽屏触屏 1024×768 —— 触屏平板：仍是三栏，动作收进 ⋮，点章节不该收起侧栏；
//   · 宽屏鼠标 1440×900 —— 桌面端：移动端那套一律不生效。
//
// 依赖 Node ≥ 22（内置 WebSocket）与 Chrome/Edge；缺任意一个就 skip，不会让 dev.ps1 test 挂掉。
// 手工看效果用 .tooling/mobile-shot.mjs（同一条链路，只是把断言换成截图）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { withBrowser, openPage, browserSupport, sleep } from './lib/chrome-cdp.mjs';
import preview from './preview-server.cjs';

const support = browserSupport();

test('移动端界面回归', { skip: support.ok ? false : support.reason, timeout: 300000 }, async (t) => {
  const server = await preview.startPreviewServer(0);
  const base = `http://127.0.0.1:${server.address().port}/`;

  try {
    await withBrowser(async (browser) => {
      // ------------------------------------------------ 窄屏手机
      await t.test('窄屏 390×844：单列 + 抽屉 + 触屏操作 + 整屏弹层', async () => {
        const page = await openPage(browser, { url: base, width: 390, height: 844, touch: true });
        try {
          const boot = await page.evaluate(`(() => {
            const app = document.getElementById('app');
            const shown = (id) => { const el = document.getElementById(id); return !!el && el.offsetParent !== null; };
            const display = (sel) => getComputedStyle(document.querySelector(sel)).display;
            return {
              cols: getComputedStyle(app).gridTemplateColumns.split(' ').length,
              sidebar: app.dataset.sidebar,
              inspector: app.dataset.inspector,
              moreShown: shown('mobileMore'),
              saveShown: shown('saveBtn'),
              stillShown: ['quickSearch', 'snapshotBtn', 'historyBtn', 'exportBtn', 'toggleInspector', 'openSettings'].filter(shown),
              actions: display('.chapter-row .chapter-actions'),
              rowMore: display('.chapter-row .row-more'),
              scrim: !!document.querySelector('.scrim.show'),
            };
          })()`);
          assert.equal(boot.cols, 1, '窄屏应该是单列布局');
          assert.equal(boot.sidebar, 'closed', '窄屏启动时目录抽屉应默认收起');
          assert.equal(boot.inspector, 'closed', '窄屏启动时素材抽屉应默认收起');
          assert.ok(boot.moreShown, '顶栏「更多」按钮应可见');
          assert.ok(boot.saveShown, '顶栏保存按钮应保留');
          assert.deepEqual(boot.stillShown, [], '次要动作应全部收进「更多」菜单');
          assert.equal(boot.actions, 'none', '触屏下行内动作按钮应隐藏（改用 ⋮）');
          assert.notEqual(boot.rowMore, 'none', '触屏下 ⋮ 应显示');
          assert.equal(boot.scrim, false, '没开抽屉时不该有遮罩');

          // 抽屉开关 + 遮罩
          await page.evaluate(`document.getElementById('toggleSidebar').click()`);
          await sleep(450);
          assert.deepEqual(
            await page.evaluate(`({ s: document.getElementById('app').dataset.sidebar, scrim: !!document.querySelector('.scrim.show') })`),
            { s: 'open', scrim: true },
            '点目录后抽屉应打开并显示遮罩',
          );

          // 点章节 → 切章并把屏幕让给正文
          await page.evaluate(`document.querySelector('.chapter-row').click()`);
          await sleep(700);
          assert.deepEqual(
            await page.evaluate(`({ s: document.getElementById('app').dataset.sidebar, scrim: !!document.querySelector('.scrim.show') })`),
            { s: 'closed', scrim: false },
            '点章节后抽屉应自动收起',
          );

          // ⋮ 操作面板
          const sheet = await page.evaluate(`(async () => {
            document.getElementById('toggleSidebar').click();
            await new Promise((r) => setTimeout(r, 450));
            document.querySelector('.chapter-row .row-more').click();
            await new Promise((r) => setTimeout(r, 350));
            return {
              hidden: document.getElementById('sheet').hidden,
              title: document.getElementById('sheetTitle').textContent,
              items: [...document.querySelectorAll('#sheetList .sheet-item')].map((b) => b.textContent),
            };
          })()`);
          assert.equal(sheet.hidden, false, '点 ⋮ 应弹出操作面板');
          assert.equal(sheet.title, '第一章 雪夜', '面板标题应是章节名');
          assert.deepEqual(sheet.items, ['上移', '下移', '重命名', '移动到其他卷…', '删除章节'], '面板项应与桌面端动作一一对应');

          // 面板 → 重命名弹层（面板项就是原来那些隐藏按钮）
          const renamed = await page.evaluate(`(async () => {
            document.querySelector('#sheetList .sheet-item:nth-child(3)').click();
            await new Promise((r) => setTimeout(r, 450));
            const out = {
              title: document.getElementById('modalTitle').textContent,
              sidebar: document.getElementById('app').dataset.sidebar,
            };
            document.getElementById('modalClose').click();
            await new Promise((r) => setTimeout(r, 400));
            return out;
          })()`);
          assert.equal(renamed.title, '重命名章节', '点「重命名」应弹出重命名弹层');
          assert.equal(renamed.sidebar, 'closed', '弹层打开时抽屉应收起');

          // 跨卷移动（触屏没有拖拽，这条是唯一入口）
          const moved = await page.evaluate(`(async () => {
            document.getElementById('toggleSidebar').click();
            await new Promise((r) => setTimeout(r, 450));
            document.querySelector('.chapter-row .row-more').click();
            await new Promise((r) => setTimeout(r, 350));
            [...document.querySelectorAll('#sheetList .sheet-item')]
              .find((b) => b.textContent === '移动到其他卷…').click();
            await new Promise((r) => setTimeout(r, 450));
            const title = document.getElementById('modalTitle').textContent;
            const volSel = document.getElementById('mvVolume');
            volSel.value = 'v2';
            volSel.dispatchEvent(new Event('change'));
            await new Promise((r) => setTimeout(r, 150));
            const positions = [...document.getElementById('mvPosition').options].map((o) => o.textContent);
            document.querySelector('.modal-foot [data-role="ok"]').click();
            await new Promise((r) => setTimeout(r, 800));
            const titles = (id) => [...document.querySelectorAll('.volume-chapters[data-volume-id="' + id + '"] .chapter-title')].map((e) => e.textContent);
            return { title, positions, v1: titles('v1'), v2: titles('v2') };
          })()`);
          assert.equal(moved.title, '移动《第一章 雪夜》', '移动弹层标题应带上章节名');
          assert.deepEqual(moved.positions, ['放到最前', '放到《第四章 长夜》之后'], '插入位置按"摘掉自己之后"的目标卷列表算');
          assert.deepEqual(moved.v1, ['第二章 旧约', '第三章 落子'], '原卷里应不再有这一章');
          assert.ok(moved.v2.includes('第一章 雪夜'), '目标卷里应出现这一章');

          // 整屏弹层：宽度铺满、底部按钮贴下沿、正文可滚
          const modal = await page.evaluate(`(async () => {
            document.getElementById('openSettings').click();
            await new Promise((r) => setTimeout(r, 650));
            const box = document.getElementById('modal').getBoundingClientRect();
            const foot = document.querySelector('.modal-foot').getBoundingClientRect();
            const body = document.querySelector('.modal-body');
            const out = {
              w: Math.round(box.width), h: Math.round(box.height),
              vw: window.innerWidth, vh: window.innerHeight,
              footBottom: Math.round(foot.bottom), scrollable: body.scrollHeight > body.clientHeight,
            };
            document.querySelector('.modal-head .icon-btn').click();
            await new Promise((r) => setTimeout(r, 450));
            out.closed = document.getElementById('overlay').hidden;
            return out;
          })()`);
          assert.equal(modal.w, modal.vw, '弹层应铺满宽度');
          assert.equal(modal.h, modal.vh, '弹层应铺满高度');
          assert.equal(modal.footBottom, modal.vh, '底部按钮应贴在屏幕下沿');
          assert.ok(modal.scrollable, '设置项应能在弹层内滚动');
          assert.equal(modal.closed, true, '关闭按钮应能关掉弹层');
        } finally {
          await page.close();
        }
      });

      // ------------------------------------------------ Android 返回键
      await t.test('Android 返回键：分层消费，最后一档关窗口', async () => {
        const page = await openPage(browser, { url: base, width: 390, height: 844, touch: true });
        try {
          const press = () => page.evaluate(`window.__previewPluginListeners[0].handler()`);
          const snap = () => page.evaluate(`({
            events: window.__previewPluginListeners.map((l) => l.event),
            closed: window.__previewWindowClosed,
            sidebar: document.getElementById('app').dataset.sidebar,
            focus: document.getElementById('app').dataset.focus,
            modal: !document.getElementById('overlay').hidden,
            sheet: !document.getElementById('sheet').hidden,
          })`);

          const boot = await snap();
          assert.deepEqual(boot.events, ['back-button'], '启动时应监听 Tauri 核心的 back-button 事件');
          assert.equal(boot.closed, false, '刚启动不该关窗口');

          // 1) 抽屉：返回键先收抽屉，不退出应用
          await page.evaluate(`document.getElementById('toggleSidebar').click()`);
          await sleep(450);
          await press();
          await sleep(300);
          let s = await snap();
          assert.equal(s.sidebar, 'closed', '返回键应先关抽屉');
          assert.equal(s.closed, false, '关抽屉时不该退出应用');

          // 2) 专注模式
          await page.evaluate(`document.getElementById('focusBtn').click()`);
          await sleep(350);
          assert.equal((await snap()).focus, 'on', '先要真的进了专注模式');
          await press();
          await sleep(300);
          s = await snap();
          assert.equal(s.focus, 'off', '返回键应退出专注模式');
          assert.equal(s.closed, false);

          // 3) 弹层
          await page.evaluate(`document.getElementById('openSettings').click()`);
          await sleep(600);
          await press();
          await sleep(450);
          s = await snap();
          assert.equal(s.modal, false, '返回键应关掉弹层');
          assert.equal(s.closed, false);

          // 4) 行内操作面板在最上层：先关面板，再关它下面的抽屉
          await page.evaluate(`(async () => {
            document.getElementById('toggleSidebar').click();
            await new Promise((r) => setTimeout(r, 450));
            document.querySelector('.chapter-row .row-more').click();
          })()`);
          await sleep(450);
          assert.equal((await snap()).sheet, true, '先要能弹出面板');
          await press();
          await sleep(300);
          s = await snap();
          assert.equal(s.sheet, false, '返回键应先关面板');
          assert.equal(s.sidebar, 'open', '面板下面那层抽屉不该被连带关掉');
          await press();
          await sleep(300);
          assert.equal((await snap()).sidebar, 'closed', '再按一次才关抽屉');

          // 5) 没有可关的层了 → 关窗口（真机上会走应用原有的保存守卫）
          await press();
          await sleep(300);
          assert.equal((await snap()).closed, true, '没有可关的层时应关窗口');
        } finally {
          await page.close();
        }
      });

      // ------------------------------------------------ 触屏平板
      await t.test('触屏平板 1024×768：仍是三栏，动作走 ⋮，侧栏不被收起', async () => {
        const page = await openPage(browser, { url: base, width: 1024, height: 768, dsf: 1, touch: true });
        try {
          const boot = await page.evaluate(`(() => {
            const app = document.getElementById('app');
            const display = (sel) => getComputedStyle(document.querySelector(sel)).display;
            return {
              cols: getComputedStyle(app).gridTemplateColumns.split(' ').length,
              sidebar: app.dataset.sidebar,
              inspector: app.dataset.inspector,
              more: display('#mobileMore'),
              rowMore: display('.chapter-row .row-more'),
              actions: display('.chapter-row .chapter-actions'),
              scrim: !!document.querySelector('.scrim.show'),
            };
          })()`);
          assert.equal(boot.cols, 3, '≥901px 应保持三栏');
          assert.equal(boot.sidebar, 'open', '宽屏侧栏是常驻列，默认展开');
          assert.equal(boot.inspector, 'open');
          assert.equal(boot.more, 'none', '宽屏不该出现顶栏「更多」');
          assert.notEqual(boot.rowMore, 'none', '触屏下 ⋮ 应显示');
          assert.equal(boot.actions, 'none', '触屏下行内动作按钮应隐藏');
          assert.equal(boot.scrim, false, '宽屏不该有遮罩');

          await page.evaluate(`document.querySelector('.chapter-row').click()`);
          await sleep(800);
          assert.equal(
            await page.evaluate(`document.getElementById('app').dataset.sidebar`), 'open',
            '平板点章节不该把常驻侧栏收掉',
          );

          const sheet = await page.evaluate(`(async () => {
            document.querySelector('.chapter-row .row-more').click();
            await new Promise((r) => setTimeout(r, 350));
            const out = {
              hidden: document.getElementById('sheet').hidden,
              items: [...document.querySelectorAll('#sheetList .sheet-item')].map((b) => b.textContent),
            };
            document.querySelector('.sheet-backdrop').click();
            await new Promise((r) => setTimeout(r, 300));
            out.closedByBackdrop = document.getElementById('sheet').hidden;
            return out;
          })()`);
          assert.equal(sheet.hidden, false, '平板点 ⋮ 也应弹出操作面板');
          assert.equal(sheet.items.at(-1), '删除章节', '破坏性操作排最后');
          assert.equal(sheet.closedByBackdrop, true, '点面板外的遮罩应关掉面板');
        } finally {
          await page.close();
        }
      });

      // ------------------------------------------------ 桌面鼠标
      await t.test('桌面 1440×900（鼠标）：移动端规则一律不生效', async () => {
        const page = await openPage(browser, { url: base, width: 1440, height: 900, dsf: 1, touch: false });
        try {
          const boot = await page.evaluate(`(() => {
            const app = document.getElementById('app');
            const display = (sel) => getComputedStyle(document.querySelector(sel)).display;
            return {
              cols: getComputedStyle(app).gridTemplateColumns.split(' ').length,
              sidebar: app.dataset.sidebar,
              inspector: app.dataset.inspector,
              more: display('#mobileMore'),
              rowMore: display('.chapter-row .row-more'),
              search: display('#quickSearch'),
              scrim: !!document.querySelector('.scrim.show'),
              saveWidth: Math.round(document.querySelector('.save-action').getBoundingClientRect().width),
            };
          })()`);
          assert.equal(boot.cols, 3, '桌面应保持三栏');
          assert.equal(boot.sidebar, 'open');
          assert.equal(boot.inspector, 'open');
          assert.equal(boot.more, 'none', '桌面不该出现顶栏「更多」');
          assert.equal(boot.rowMore, 'none', '桌面不该出现行内 ⋮（悬停按钮照旧）');
          assert.notEqual(boot.search, 'none', '桌面顶栏应保留搜索按钮');
          assert.equal(boot.scrim, false, '桌面没有遮罩');
          assert.ok(boot.saveWidth > 100, '桌面保存按钮应保留文字，不该变成圆形图标按钮');
        } finally {
          await page.close();
        }
      });
    }, { exe: support.exe });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
