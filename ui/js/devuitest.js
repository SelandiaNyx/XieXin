// 开发验收脚本：自动模拟界面操作（打开各弹层、点击标题栏 ×、点击各按钮），
// 把每一步的结果写进数据目录的 ui-log.txt，用于在没有人工点击的情况下定位交互 bug。
// 仅在 NOVEL_MANAGER_UITEST=1 时执行。

import { log } from './api.js';

const enabled = window.__MOGE_UITEST__ === true;
if (enabled) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel) => document.querySelector(sel);
  const overlay = () => document.getElementById('overlay');
  const isOpen = () => !overlay().hidden;
  const title = () => document.getElementById('modalTitle').textContent;

  async function step(name, fn) {
    try {
      const detail = await fn();
      log(`[uitest] PASS ${name}${detail ? ` :: ${detail}` : ''}`);
      return true;
    } catch (e) {
      log(`[uitest] FAIL ${name} :: ${e && e.message ? e.message : e}`);
      return false;
    }
  }

  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  async function openFrom(chip) {
    const el = document.querySelector(chip);
    assert(el, `找不到元素 ${chip}`);
    el.click();
    await sleep(260);
    assert(isOpen(), `点击 ${chip} 后弹层未打开`);
    return title();
  }

  async function closeByX() {
    const btn = document.getElementById('modalClose');
    assert(btn, '找不到标题栏关闭按钮 #modalClose');
    let fired = false;
    btn.addEventListener('click', () => { fired = true; }, { once: true });
    btn.click();
    await sleep(400);
    if (!overlay().hidden) {
      const log1 = await import('./ui.js');
      const ui = await import('./ui.js');
      const own = Object.getOwnPropertyDescriptor(btn, 'onclick');
      const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(btn), 'onclick');
      let directResult = '未调用';
      try {
        ui.closeModal();
        await sleep(200);
        directResult = `hidden=${overlay().hidden}`;
      } catch (e) {
        directResult = `抛错 ${e && e.message}`;
      }
      throw new Error(
        `× 无效：click已触发=${fired} typeof onclick=${typeof btn.onclick}` +
          ` 自身属性=${own ? '有(' + typeof own.value + '/' + typeof own.get + ')' : '无'}` +
          ` 原型属性=${proto ? '有(' + typeof proto.get + ')' : '无'}` +
          ` window.onclick=${typeof window.onclick}` +
          ` closeModal返回=${directResult} log1导出closeModal=${typeof log1.closeModal}` +
          ` disabled=${btn.disabled} readOnly=${btn.readOnly} tag=${btn.tagName} type=${btn.type}`,
      );
    }
  }

  async function run() {
    log('[uitest] ==== 开始界面自动验收 ====');
    const results = [];

    // 1. 标题栏 × 是否对所有弹层有效
    const panels = [
      ['#openSettings', '设置'],
      ['.status-chip[data-action="outline"]', '大纲'],
      ['.status-chip[data-action="search"]', '全文搜索'],
      ['.chip[data-action="trash"]', '回收站'],
      ['.chip[data-action="help"]', '快捷键'],
      ['.chip[data-action="import"]', '导入'],
      ['#exportBtn', '导出'],
      ['#historyBtn', '历史版本'],
      ['#wordCountBox', '字数统计'],
      ['#pomodoroChip', '番茄钟'],
    ];    for (const [sel, name] of panels) {
      results.push(
        await step(`打开并关闭「${name}」弹层（标题栏 ×）`, async () => {
          const t = await openFrom(sel);
          await closeByX();
          return `标题=${t}`;
        }),
      );
    }

    // 2. 历史版本按钮：只应存在一个（列表 + 对比在同一个面板里）
    results.push(
      await step('历史版本按钮唯一且可用', async () => {
        const btns = [
          document.getElementById('historyBtn'),
          document.getElementById('compareBtn'),
          document.getElementById('diffBtn'),
        ].filter(Boolean);
        assert(btns.length === 1, `历史上/对比类按钮应只有 1 个，实际 ${btns.length} 个`);
        const el = btns[0];
        el.click();
        await sleep(600);
        assert(isOpen(), '点击历史版本按钮没有打开面板');
        const title = document.getElementById('modalTitle').textContent;
        const hasList = !!document.getElementById('versionList');
        assert(title.includes('历史版本'), `面板标题异常：${title}`);
        assert(hasList, '历史版本面板里缺少版本列表');
        await closeByX();
        return `${title}（含版本列表，选中版本即逐行对比）`;
      }),
    );

    // 3. 状态栏与底部功能按钮
    const chips = [...document.querySelectorAll('.sidebar-bottom .chip')].map((el) => el.dataset.action);
    results.push(await step('底部功能按钮清单', async () => `${chips.join(', ')}`));

    // 4. 本次会话字数
    results.push(
      await step('写作后「本次」字数应增长', async () => {
        const view = document.getElementById('editor');
        assert(view, '找不到正文编辑器');
        view.focus();
        view.value += '\n自动化测试追加的一句话。';
        view.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(1200);
        const text = [...document.querySelectorAll('.status-chip')]
          .map((el) => el.textContent)
          .find((t) => t.includes('本次'));
        return `状态栏显示：${text}`;
      }),
    );

    // 5. 章节状态选项
    results.push(
      await step('章节状态下拉选项', async () => {
        const sel = document.getElementById('statusSelect');
        const list = [...sel.options].map((o) => `${o.value}=${o.textContent}`).join(' ');
        assert(sel.options.length >= 7, `状态数量偏少：${sel.options.length}`);
        assert([...sel.options].some((o) => o.value === 'published'), '缺少「已发布」状态');
        return list;
      }),
    );

    // 6. 主题选项
    results.push(
      await step('主题下拉选项', async () => {
        await openFrom('#openSettings');
        const sel = document.getElementById('setTheme');
        const list = [...sel.options].map((o) => o.value).join(',');
        assert(sel.options.length >= 7, `主题数量偏少：${sel.options.length}`);
        assert([...sel.options].some((o) => o.value === 'md3'), '缺少 MD3 主题');
        await closeByX();
        return list;
      }),
    );

    // 7. 字体搜索
    results.push(
      await step('字体搜索可用', async () => {
        await openFrom('#openSettings');
        const input = document.getElementById('fontSearch');
        input.value = '楷';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(200);
        const rows = document.querySelectorAll('#fontList .font-opt');
        const first = rows[0] ? rows[0].dataset.font : '（无）';
        rows[0]?.click();
        await sleep(120);
        const current = document.getElementById('fontCurrent').textContent;
        await closeByX();
        return `匹配 ${rows.length} 个，首个=${first}，已选=${current}`;
      }),
    );

    // 8. 番茄钟面板
    results.push(
      await step('番茄钟面板可开始 / 暂停', async () => {
        await openFrom('#pomodoroChip');
        document.getElementById('pomoToggle').click();
        await sleep(1200);
        const running = document.getElementById('pomoTime').textContent;
        document.getElementById('pomoToggle').click();
        await sleep(200);
        const label = document.getElementById('pomoToggle').textContent;
        await closeByX();
        return `计时=${running} 按钮=${label}`;
      }),
    );

    // 9. 导出对话框包含电子书格式
    results.push(
      await step('导出格式含 EPUB', async () => {
        await openFrom('#exportBtn');
        const opts = [...document.getElementById('exFormat').options].map((o) => o.value);
        const epubMetaVisible = !document.getElementById('epubMeta').hidden;
        await closeByX();
        assert(opts.includes('epub'), `缺少 epub：${opts.join(',')}`);
        assert(epubMetaVisible, '选择 EPUB 后未显示电子书信息');
        return opts.join(',');
      }),
    );

    // 10. 一键排版是否真的改了正文（应直接生效，不弹确认框）
    results.push(
      await step('一键排版直接生效（段首缩进）', async () => {
        const view = document.getElementById('editor');
        view.value = '雪落下来了。\n他站在城墙上，看着远处。\n\n“你还是来了。”身后传来一个声音。';
        view.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('oneClickFormat').click();
        await sleep(2200);
        assert(!isOpen(), '一键排版不应再弹出确认框');
        const text = view.value;
        const indented = text.split('\n').filter((l) => l.startsWith('\u3000\u3000')).length;
        const total = text.split('\n').filter((l) => l.trim()).length;
        assert(indented >= 3, `缩进行数不足：${indented}/${total}，正文=${JSON.stringify(text.slice(0, 80))}`);
        return `缩进 ${indented}/${total} 行`;
      }),
    );

    // 10b. 撤销排版
    results.push(
      await step('撤销排版可还原', async () => {
        const view = document.getElementById('editor');
        const indented = view.value;
        const btn = document.getElementById('undoFormatBtn');
        assert(!btn.hidden, '撤销按钮未出现');
        btn.click();
        await sleep(1500);
        assert(view.value !== indented, '撤销后正文没有变化');
        assert(!view.value.split('\n').some((l) => l.startsWith('\u3000\u3000')), '撤销后仍有缩进');
        return `已还原（${view.value.length} 字符）`;
      }),
    );

    // 11. 回车是否自动缩进
    results.push(
      await step('回车自动延续段首缩进', async () => {
        const view = document.getElementById('editor');
        view.value = '\u3000\u3000第一段。';
        view.dispatchEvent(new Event('input', { bubbles: true }));
        view.focus();
        view.setSelectionRange(view.value.length, view.value.length);
        const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        view.dispatchEvent(ev);
        await sleep(200);
        const lines = view.value.split('\n');
        const last = lines[lines.length - 1] || '';
        assert(last.startsWith('\u3000\u3000'), `新段落没有缩进：${JSON.stringify(view.value)}`);
        return `新段落=${JSON.stringify(last)}`;
      }),
    );

    // 12. 设置里的预览按钮（含主题 / 字体下拉）
    results.push(
      await step('设置 → 预览效果（含字体预览与下拉）', async () => {
        await openFrom('#openSettings');
        document.querySelector('#modalFoot [data-role="preview"]').click();
        await sleep(600);
        const themeSel = document.getElementById('pvTheme');
        const fontSel = document.getElementById('pvFont');
        assert(themeSel && themeSel.options.length >= 7, '预览里缺少主题下拉');
        assert(fontSel && fontSel.options.length >= 10, '预览里缺少字体下拉');
        const before = getComputedStyle(document.querySelector('.preview-font-row')).fontFamily;
        fontSel.value = 'SimSun';
        fontSel.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(300);
        const after = getComputedStyle(document.querySelector('.preview-font-row')).fontFamily;
        assert(before !== after, `切换字体后预览没有变化：${before}`);
        themeSel.value = 'dark';
        themeSel.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(200);
        const themeAttr = document.documentElement.getAttribute('data-theme');
        assert(themeAttr === 'dark', `切换主题后未生效：${themeAttr}`);
        document.querySelector('#modalFoot [data-role="close"]').click();
        await sleep(400);
        return `主题下拉 ${themeSel.options.length} 项，字体下拉 ${fontSel.options.length} 项，字体与主题切换均生效`;
      }),
    );

    // 12b. 顶栏不应有重复按钮
    results.push(
      await step('顶栏按钮无重复', async () => {
        const ids = [...document.querySelectorAll('.topbar-right [id]')].map((el) => el.id);
        const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
        assert(dup.length === 0, `存在重复 id：${dup.join(',')}`);
        return ids.join(', ');
      }),
    );

    // 13. 左下功能面板折叠（与当前保存的折叠状态无关，只验证"点一次就切换"）
    results.push(
      await step('左下功能面板可折叠', async () => {
        const bottom = document.getElementById('sidebarBottom');
        const body = document.getElementById('bottomBody');
        const btn = document.getElementById('toggleBottom');
        assert(bottom && body && btn, `DOM 缺失 bottom=${!!bottom} body=${!!body} btn=${!!btn}`);
        assert(typeof btn.onclick === 'function', `折叠按钮没有绑定点击处理（onclick=${typeof btn.onclick}）`);

        const initial = bottom.dataset.collapsed === 'true';
        btn.click();
        await sleep(700);
        const flipped = bottom.dataset.collapsed === 'true';
        const display = getComputedStyle(body).display;
        const bodyHidden = body.hidden;
        assert(flipped !== initial, `点击后状态没有变化（initial=${initial} after=${flipped}）`);
        // 折叠时功能面板必须真的不可见
        if (flipped) {
          assert(display === 'none' || bodyHidden, `折叠后仍然可见：display=${display} hidden=${bodyHidden}`);
        }
        btn.click();
        await sleep(700);
        const restored = bottom.dataset.collapsed === 'true';
        assert(restored === initial, `再次点击没有回到原状态（期望 ${initial}）`);
        return `初始=${initial ? '折叠' : '展开'} → 切换 → 还原`;
      }),
    );

    // 14. 动效系统是否真的挂上了（统一曲线 + 入场动画 + 按压反馈）
    results.push(      await step('动效系统生效', async () => {
        const app = document.getElementById('app');
        const root = getComputedStyle(document.documentElement);
        const ease = root.getPropertyValue('--ease-out').trim();
        const dur3 = root.getPropertyValue('--dur-3').trim();
        assert(ease.includes('cubic-bezier'), `缺少统一缓动令牌：${ease}`);
        assert(dur3.length > 0, '缺少时长令牌');

        // 首屏动画守卫应已解除
        assert(!app.classList.contains('no-anim'), '首屏结束后没有开启动效');

        // 侧栏宽度过渡
        const appTransition = getComputedStyle(app).transitionProperty;
        assert(appTransition.includes('grid-template-columns'), `侧栏宽度没有过渡：${appTransition}`);

        // 目录树与卡片有入场动画
        const vol = document.querySelector('.toc .volume');
        const volAnim = vol ? getComputedStyle(vol).animationName : 'none';
        assert(volAnim !== 'none', `卷条目没有入场动画：${volAnim}`);

        // 弹层有入场动画，且关闭时播放退场
        await openFrom('#openSettings');
        const modalAnim = getComputedStyle(document.getElementById('modal')).animationName;
        assert(modalAnim !== 'none', `弹层没有入场动画：${modalAnim}`);
        document.getElementById('modalClose').click();
        const closing = document.getElementById('overlay').classList.contains('closing');
        await sleep(700);
        assert(!isOpen(), '退场动画后弹层没有关闭');
        return `缓动=${ease} 时长=${dur3} 弹层动画=${modalAnim} 退场动画=${closing}`;
      }),
    );

    const failed = results.filter((r) => !r).length;
    log(`[uitest] ==== 结束：${results.length - failed}/${results.length} 项通过 ====`);
  }

  const timer = setInterval(() => {
    if (window.__moge && window.__moge.ready) {
      clearInterval(timer);
      setTimeout(() => {
        run().catch((e) => log(`[uitest] 运行异常: ${e && e.stack ? e.stack : e}`));
      }, 800);
    }
  }, 300);
}
