// 开发用示例数据：仅当地址带 ?selftest 时执行，方便截图与手工验收。
// 正式使用（直接打开应用）不会触发任何写入。

import { api, log } from './api.js';

const params = new URLSearchParams(window.location.search);
// ?open=stats|export|history|outline|help|trash|books —— 开发时直接展开某个弹层验收
const openPanel = params.get('open');
/** ?theme=md3|dark|sepia|forest|mono：仅切换主题，便于肉眼验收配色。 */
const theme = params.get('theme');

const SAMPLE = {
  volume: '第一卷 风起',
  chapters: [
    {
      title: '第一章 雪夜',
      body: [
        '雪落下来了。',
        '沈孤鸿站在城墙上，看着远处连绵的灯火。风从北面吹来，卷起他衣角的一片霜色。',
        '他已经在这里站了三个时辰。',
        '“你还是来了。”身后传来一个声音。',
        '他没有回头，只是把手按在刀柄上：“我等这一天，等了十年。”',
      ].join('\n\n'),
    },
    {
      title: '第二章 旧约',
      body: [
        '城南的酒肆里，说书人正讲着十年前的那场大火。',
        '沈孤鸿坐在角落，把一枚铜钱立在桌面上，看它慢慢倒下。',
        '“客人，您的酒。”店小二把碗放下，压低声音，“西街的柳姑娘托我带句话——她说，东西还在。”',
      ].join('\n\n'),
    },
    {
      title: '第三章 落子',
      body: ['棋盘上只剩三枚子。', '老人执黑，轻轻落下最后一手：“该你了。”'].join('\n\n'),
    },
  ],
  cards: [
    {
      kind: 'character',
      title: '沈孤鸿',
      content: '主角，沉默寡言，剑术极高。十年前灭门案的唯一幸存者。',
      tags: ['主角', '剑客'],
      fields: { 身份: '游侠', 目标: '查明灭门真相', 弱点: '旧伤未愈' },
      color: '#8ab4f8',
      pinned: true,
    },
    {
      kind: 'character',
      title: '柳青梧',
      content: '药铺掌柜之女，善用毒，暗中接济流民。',
      tags: ['女主', '医毒'],
      fields: { 身份: '药铺掌柜', 立场: '中立偏善' },
      color: '#7ad1a6',
    },
    {
      kind: 'plot',
      title: '雪夜伏击',
      content: '第三章埋伏笔：黑衣人袖口的火纹，与十年前灭门案一致。',
      tags: ['伏笔', '主线'],
      color: '#f5a623',
    },
    {
      kind: 'inspiration',
      title: '一句台词',
      content: '“刀是冷的，握刀的人不该是。”',
      tags: ['台词'],
      color: '#c792ea',
    },
    {
      kind: 'world',
      title: '北境设定',
      content: '北境常年落雪，城墙上刻着历代守将的名字，雪一化就会显露出来。',
      tags: ['地理'],
      color: '#8ab4f8',
    },
  ],
};

async function seed() {
  try {
    const ws = await api.workspace();
    if (ws.registry.books.length > 0) {
      log('[selftest] 书架已有内容，跳过示例数据');
      await openRequestedPanel();
      return;
    }
    const book = await api.createBook('剑气长河', '示例作者', '武侠');
    await api.updateBookMeta({
      bookId: book.id,
      summary: '十年前一场大火烧尽了沈家。十年后，唯一的幸存者带着一把旧刀，回到了落雪的北境。',
    });
    const firstVolume = book.volumes[0];
    await api.renameNode({ bookId: book.id, kind: 'volume', id: firstVolume.id, title: SAMPLE.volume });
    const firstChapter = firstVolume.chapters[0];
    await api.saveChapter({
      bookId: book.id,
      chapterId: firstChapter.id,
      content: SAMPLE.chapters[0].body,
      title: SAMPLE.chapters[0].title,
      status: 'final',
      manualSnapshot: true,
      snapshotLabel: '示例开篇',
    });
    for (const ch of SAMPLE.chapters.slice(1)) {
      const created = await api.addChapter(book.id, firstVolume.id, ch.title);
      const vol = created.volumes.find((v) => v.id === firstVolume.id);
      const target = vol.chapters[vol.chapters.length - 1];
      await api.saveChapter({
        bookId: book.id,
        chapterId: target.id,
        content: ch.body,
        title: ch.title,
        status: 'draft',
        manualSnapshot: true,
        snapshotLabel: '示例章节',
      });
    }
    const second = await api.addVolume(book.id, '第二卷 落子');
    const ch2 = await api.addChapter(book.id, second.volumes[1].id, '第四章 长夜');
    await api.saveChapter({
      bookId: book.id,
      chapterId: ch2.volumes[1].chapters[0].id,
      content: '长夜未尽，城外的雪已经没过了脚踝。',
      title: '第四章 长夜',
      manualSnapshot: true,
    });
    for (const card of SAMPLE.cards) {
      await api.upsertCard(book.id, card);
    }
    log('[selftest] 示例数据已写入，即将重新加载界面');
    const next = new URL(window.location.href);
    next.searchParams.set('selftest', '1');
    if (openPanel) next.searchParams.set('open', openPanel);
    setTimeout(() => window.location.replace(next.toString()), 400);
  } catch (e) {
    log(`[selftest] 失败: ${e.message}`);
  }
}

async function openRequestedPanel() {
  if (!openPanel) return;
  try {
    const dialogs = await import('./dialogs.js');
    const map = {
      stats: () => dialogs.openStats(),
      export: () => dialogs.openExport(),
      history: () => dialogs.openHistory(),
      outline: () => dialogs.openOutline(),
      help: () => dialogs.openHelp(),
      trash: () => dialogs.openTrash(),
      books: () => dialogs.openBookPicker(),
      settings: () => dialogs.openSettings(),
      search: () => dialogs.openSearch(),
      import: () => dialogs.importTextDialog(),
      preview: () =>
        dialogs.openStylePreview({
          ...window.__moge.state.settings,
          theme: theme || window.__moge.state.settings.theme,
        }),
    };
    const fn = map[openPanel];
    if (fn) {
      await fn();
      log(`[selftest] 已打开面板: ${openPanel}`);
    }
  } catch (e) {
    log(`[selftest] 打开面板 ${openPanel} 失败: ${e.message}`);
  }
}

const enabled =
  window.__MOGE_SELFTEST__ === true || params.has('selftest') || Boolean(openPanel) || Boolean(theme);

if (enabled) {
  const timer = setInterval(() => {
    if (window.__moge && window.__moge.ready) {
      clearInterval(timer);
      log('[selftest] 已进入示例数据模式');
      seed();
    }
  }, 300);
}

// ?theme=md3 等：仅切换主题，方便肉眼验收配色
if (theme) {
  const applyTheme = async () => {
    const { api: tapi } = await import('./api.js');
    const next = { ...window.__moge.state.settings, theme };
    await tapi.saveSettings(next);
    document.documentElement.setAttribute('data-theme', theme);
    log(`[selftest] 已切换到主题 ${theme}`);
  };
  const t = setInterval(() => {
    if (window.__moge && window.__moge.ready) {
      clearInterval(t);
      applyTheme();
    }
  }, 300);
}
