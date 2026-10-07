// 通用对话框回归：书架与作品资料里的封面图片（可选功能）。
//
// 这条链路横跨 Rust（写盘 / base64 / data URL）与前端（挑图 → 预览 → 保存 → 侧栏徽标），
// 用无头 Chrome 跑真实界面 + 内存 fixture 走一遍，缺 Chrome 就自动 skip。
//
// 封面是可选功能，所以这里同时验证"没有封面时一切照旧"：清除后必须回到颜色 + 图标。

import test from 'node:test';
import assert from 'node:assert/strict';

import { withBrowser, openPage, browserSupport, sleep } from './lib/chrome-cdp.mjs';
import preview from './preview-server.cjs';

const support = browserSupport();

test('书架与资料的封面图片', { skip: support.ok ? false : support.reason, timeout: 180000 }, async (t) => {
  const server = await preview.startPreviewServer(0);
  const base = `http://127.0.0.1:${server.address().port}/`;

  try {
    await withBrowser(async (browser) => {
      const page = await openPage(browser, { url: base, width: 1280, height: 800, dsf: 1, touch: false });
      try {
        // ---------------------------------------------- 侧栏徽标 + 书架缩略图
        await t.test('有封面时：侧栏徽标与书架缩略图都用封面图', async () => {
          const emblem = await page.evaluate(`(() => {
            const img = document.querySelector('#bookDot img');
            return img ? { src: img.src.slice(0, 22), w: img.naturalWidth, h: img.naturalHeight } : null;
          })()`);
          assert.ok(emblem, '侧栏徽标里应该有封面图');
          assert.equal(emblem.src, 'data:image/png;base64,');
          assert.equal(emblem.w, 96, '封面图应该真的解码出来了（不是坏图）');
          assert.equal(emblem.h, 128);

          const shelf = await page.evaluate(`(async () => {
            document.getElementById('bookSwitch').click();
            await new Promise((r) => setTimeout(r, 700));
            const img = document.querySelector('.book-cover img');
            return {
              hasImg: !!img,
              decoded: img ? img.naturalWidth > 0 : false,
              letterGone: document.querySelector('.book-cover').textContent.trim() === '',
              hasPicker: !!document.querySelector('[data-cover-pick]'),
            };
          })()`);
          assert.equal(shelf.hasImg, true, '书架卡片应该显示封面缩略图');
          assert.equal(shelf.decoded, true, '缩略图应该真的解码出来');
          assert.equal(shelf.letterGone, true, '有封面时不该再显示书名首字');
          assert.equal(shelf.hasPicker, true, '新建作品表单里应该有"选择图片…"');
        });

        // ---------------------------------------------- 新建作品：挑图即预览
        await t.test('新建作品：选完图片立刻能看到预览', async () => {
          const picked = await page.evaluate(`(async () => {
            document.querySelector('[data-cover-pick]').click();
            await new Promise((r) => setTimeout(r, 800));
            const thumb = document.querySelector('[data-cover-thumb] img');
            return {
              hasThumb: !!thumb,
              hint: (document.querySelector('[data-cover-hint]') || {}).textContent || '',
            };
          })()`);
          assert.equal(picked.hasThumb, true, '选完图片后缩略图应该出现');
          assert.match(picked.hint, /新封面\.png/, `提示里应该带文件名：${picked.hint}`);
        });

        // ---------------------------------------------- 资料：清除 → 回到默认外观
        await t.test('清除封面：保存后退回颜色 + 图标', async () => {
          const cleared = await page.evaluate(`(async () => {
            document.querySelector('.book-card [data-role="edit"]').click();
            await new Promise((r) => setTimeout(r, 600));
            const before = !!document.querySelector('[data-cover-thumb] img');
            document.querySelector('[data-cover-clear]').click();
            await new Promise((r) => setTimeout(r, 200));
            const afterClick = !!document.querySelector('[data-cover-thumb] img');
            document.querySelector('.modal-foot [data-role="save"]').click();
            await new Promise((r) => setTimeout(r, 900));
            return {
              before,
              afterClick,
              modalClosed: document.getElementById('overlay').hidden,
              emblemImg: !!document.querySelector('#bookDot img'),
              emblemIcon: !!document.querySelector('#bookDot svg'),
            };
          })()`);
          assert.equal(cleared.before, true, '资料弹层里应该先显示已有封面');
          assert.equal(cleared.afterClick, false, '点清除后预览应该立刻消失');
          assert.equal(cleared.modalClosed, true, '保存后弹层应该关掉');
          assert.equal(cleared.emblemImg, false, '清除后侧栏不该再有封面图');
          assert.equal(cleared.emblemIcon, true, '清除后侧栏应该回到原来的书籍图标');
        });

        // ---------------------------------------------- 资料：重新设回来
        await t.test('重新设置封面：保存后徽标与书架都跟着变', async () => {
          const again = await page.evaluate(`(async () => {
            document.getElementById('bookSwitch').click();
            await new Promise((r) => setTimeout(r, 700));
            const shelfImg = !!document.querySelector('.book-cover img');
            document.querySelector('.book-card [data-role="edit"]').click();
            await new Promise((r) => setTimeout(r, 600));
            const emptyThumb = !!document.querySelector('[data-cover-thumb] img');
            document.querySelector('[data-cover-pick]').click();
            await new Promise((r) => setTimeout(r, 800));
            const previewThumb = !!document.querySelector('[data-cover-thumb] img');
            document.querySelector('.modal-foot [data-role="save"]').click();
            await new Promise((r) => setTimeout(r, 900));
            return { shelfImg, emptyThumb, previewThumb, emblemImg: !!document.querySelector('#bookDot img') };
          })()`);
          assert.equal(again.shelfImg, false, '清除后书架卡片应该回到"颜色 + 首字"');
          assert.equal(again.emptyThumb, false, '资料弹层里此时应该没有封面');
          assert.equal(again.previewThumb, true, '选完图片应该能看到预览');
          assert.equal(again.emblemImg, true, '保存后侧栏徽标应该换成封面图');
        });
      } finally {
        await page.close();
      }
    }, { exe: support.exe });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
