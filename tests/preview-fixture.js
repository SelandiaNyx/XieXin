// Synthetic, ephemeral manuscripts; no disk access or real user data.
(() => {
  const now = Date.now();
  const settings = { theme: 'light', fontFamily: '"Microsoft YaHei", sans-serif', fontSize: 17, lineHeight: 2.1, letterSpacing: .02, editorWidth: 860, autosaveSecs: 20, dailyGoal: 3000, historyDepth: 30, lastBookId: 'sample', oneClickFormatRule: 'cjk-indent' };
  const book = { id: 'sample', title: '剑气长河', author: '示例作者', genre: '武侠', coverColor: '#147d6c', coverImage: 'cover.png', createdAt: now, updatedAt: now, volumes: [
    { id: 'v1', title: '第一卷 · 风起北境', expanded: true, chapters: [{ id: 'c1', title: '第一章 雪夜', status: 'revising', charCount: 159, versions: 3 }, { id: 'c2', title: '第二章 旧约', status: 'draft', charCount: 76, versions: 1 }, { id: 'c3', title: '第三章 落子', status: 'draft', charCount: 32, versions: 1 }] },
    { id: 'v2', title: '第二卷 · 山河故人', expanded: true, chapters: [{ id: 'c4', title: '第四章 长夜', status: 'draft', charCount: 0, versions: 0 }] },
  ] };
  const content = { c1: '雪落下来了。\n\n沈孤鸿站在城墙上，看着远处连绵的灯火。风从北面吹来，卷起他衣角的一片霜色。\n\n他已经在这里站了三个时辰。\n\n“你还是来了。”身后传来一个声音。\n\n他没有回头，只是把手按在刀柄上：“我等这一天，等了十年。”\n\n雪花落在刀鞘上，很快融成了水。城门外，一匹瘦马正踏着积雪缓缓走来，马背上的人披着一件青色的旧斗篷。', c2: '城南的酒肆里，说书人正讲着十年前的那场大火。', c3: '棋盘上只剩三枚子。', c4: '' };
  const cards = [{ id: 'n1', kind: 'character', title: '沈孤鸿', content: '灭门案的唯一幸存者。沉默寡言，带着一把旧刀重回北境。', tags: ['主角', '剑客'], fields: { 身份: '游侠', 目标: '查明十年前的真相' }, color: '#62a98e', pinned: true }, { id: 'n2', kind: 'character', title: '柳青梧', content: '药铺掌柜之女，善用毒，暗中接济流民。她知道的，远比她说出的多。', tags: ['女主', '医毒'], fields: { 立场: '中立偏善' }, color: '#ceac78' }, { id: 'n3', kind: 'plot', title: '雪夜伏击', content: '黑衣人袖口的火纹，与十年前灭门案一致。', tags: ['伏笔'], fields: {}, color: '#ac9dca' }];
  const statuses = [{ id: 'draft', label: '草稿', color: '#81918b', group: '创作' }, { id: 'revising', label: '修订中', color: '#ae7b38', group: '创作' }, { id: 'final', label: '已定稿', color: '#147d6c', group: '创作' }];
  const versions = [{ id: 'version1', label: '开篇初稿', kind: 'manual', createdAt: now - 86400000, chars: 50 }];
  const empty = new URLSearchParams(location.search).has('empty');
  // ?novolume 模拟"唯一一卷被删掉之后"的书：一卷都没有，用来验证新建章节会自己补一卷
  if (new URLSearchParams(location.search).has('novolume')) book.volumes = [];
  // ?location=choose 模拟"全新安装还没选过位置"，?location=missing 模拟"记住的位置不见了"
  const locationParam = new URLSearchParams(location.search).get('location') || '';
  let locationState = locationParam
    ? { dir: 'C:/Users/示例/AppData/Roaming/com.heartwrite.novelmanager', suggested: 'C:/Users/示例/Documents/写心稿件', needsChoice: true, isForced: false, missing: locationParam === 'missing' }
    : { dir: '界面预览 · 临时示例数据', suggested: 'C:/Users/示例/Documents/写心稿件', needsChoice: false, isForced: false, missing: false };
  const clone = value => JSON.parse(JSON.stringify(value));
  // 96×128 的示例封面（真的 PNG，不是占位符）：截图与回归里能看出"封面图确实渲染了"
  const COVER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAACACAIAAAB7vvvtAAABl0lEQVR42u3dO07DQBQF0DeIJbAG6FgBWQAKDaInHR0FFbvg01DRxBugIRI9O6CDzQwNSiSCLQ8YyfKcVyUSWOHqnTsmKZL2jh4ickROERE5RY6vB5unKXJsHnx7uv7JKLzO+ld6XqftBZS+nrLr7ITpnN1IQhDQHwYxGzR4QB+r82rjOJ5fIjYQsYOTZVX3QS/P9xGxnUZ7B9XZTQIqDUgH/fqYt0ECQgwxxBBDDDEB6SCjgxBDDDHEEEMMMQEJSAfpIMQQQwwxAQlIB+kgxBBDDDHEEENMQALSQToIMcQQQwwxgxhiAtJBOggxxBCzQQISkA7SQYghhhhiiBnEEBOQDtJBiCGGmA1CDDHEEBOQDtJBiAkIMcQQQwwxxASkg3RQ7w16u5rUN7bMb68RK9PUElDvObxrJvbNLI55p5iAHPP+1aiH2OvidMx/2tnyBrFxE5s1T6O+D0pOMaeYU8yNooB0kLFBiCGGGGKIIVY5sfeLhYA6NyhsUMvnYvuPTef7ONP5XOyn69igwUraOOZtkID+fz4BIVgDKxIeCMUAAAAASUVORK5CYII=';
  const stats = () => ({ charCount: 267, chapters: 4, volumes: 2, cards: cards.length, words: 0, cjk: 267, versions: 5, todayChars: 159 });
  window.__TAURI__ = { core: { invoke: async (cmd, args = {}) => {
    switch (cmd) {
      case 'ui_ready': return 'preview';
      case 'ui_log': console.log(args.message); return;
      case 'workspace_state': return clone({ settings, registry: { books: empty ? [] : [book] }, storageDir: locationState.dir, storageBytes: 24576, hasNativePickers: true, location: locationState });
      // 换稿件目录：预览里只记下来（真机上这一步会搬文件 + 写指针 + 换根）
      case 'set_storage_dir': {
        locationState = { dir: args.path, suggested: locationState.suggested, needsChoice: false, isForced: false, missing: false };
        return clone(locationState);
      }
      case 'pick_directory': return 'D:/示例/我的稿件';
      case 'chapter_statuses': return clone(statuses);
      case 'list_fonts': return [];
      case 'open_book': return clone({ book, cards, cover: book.coverImage ? COVER : null });
      // 封面：预览、读取、设置、清除都在内存里走一遍真实的界面流程
      case 'pick_open_file': return args.kind === 'image' ? 'D:/示例/新封面.png' : null;
      case 'preview_cover': return COVER;
      case 'book_cover': return book.coverImage ? COVER : '';
      case 'set_book_cover': book.coverImage = 'cover.png'; return clone(book);
      case 'clear_book_cover': book.coverImage = ''; return clone(book);
      // 资料弹层保存时会先改元信息，再单独落封面；这里照着后端的字段语义改内存里的书
      case 'update_book_meta': {
        if (args.title) book.title = args.title;
        if (args.author !== undefined) book.author = args.author;
        if (args.genre !== undefined) book.genre = args.genre;
        if (args.summary !== undefined) book.summary = args.summary;
        if (args.coverColor) book.coverColor = args.coverColor;
        return clone(book);
      }
      case 'read_chapter': return { content: content[args.chapterId] || '', createdAt: now };
      case 'add_volume': {
        const vol = { id: `v${book.volumes.length + 1}`, title: `第${book.volumes.length + 1}卷`, expanded: true, chapters: [] };
        book.volumes.push(vol);
        return clone(book);
      }
      case 'add_chapter': {
        const vol = book.volumes.find((v) => v.id === args.volumeId);
        if (!vol) throw new Error('找不到目标卷');
        const ch = { id: `c${Object.keys(content).length + 1}`, title: `第${vol.chapters.length + 1}章`, status: 'draft', charCount: 0, versions: 0 };
        vol.chapters.push(ch);
        content[ch.id] = '';
        return clone(book);
      }
      case 'list_versions': return clone(versions);
      case 'save_chapter': content[args.chapterId] = args.content; return { updatedAt: Date.now(), charCount: args.content.length, versions: 3 };
      case 'save_settings': Object.assign(settings, args.settings); return clone(settings);
      case 'storage_info': return { bytes: 24576 };
      case 'book_stats': return stats();
      case 'list_cards': return clone(cards);
      case 'move_chapter_to': {
        // 与 storage.rs 的语义保持一致：先从原卷摘掉，再按 position 插进目标卷
        let taken = null;
        for (const vol of book.volumes) {
          const i = vol.chapters.findIndex(c => c.id === args.chapterId);
          if (i > -1) { taken = vol.chapters.splice(i, 1)[0]; break; }
        }
        if (!taken) throw new Error('找不到该章节');
        const target = book.volumes.find(v => v.id === args.targetVolumeId);
        if (!target) throw new Error('找不到目标卷');
        target.chapters.splice(Math.min(args.position, target.chapters.length), 0, taken);
        return clone(book);
      }
      case 'version_detail': return { meta: versions[0], content: '雪落下来了。', current: content.c1 };
      case 'list_recent_exports': case 'list_trash': return [];
      case 'verify_book': return [];
      default: throw new Error('此操作需要桌面应用：' + cmd);
    }
  },
  // 供界面回归用：把注册进来的监听器留在一个数组里，测试可以手动"按下返回键"。
  // 真实实现见 @tauri-apps/api 的 addPluginListener（浏览器预览里没有它）。
  addPluginListener: async (plugin, event, handler) => {
    window.__previewPluginListeners.push({ plugin, event, handler });
    return { unregister: async () => {} };
  },
  },
  // 关窗口在真机上由 Rust 侧处理；预览里只记录一次调用，方便断言"最后一档确实关了窗口"。
  window: {
    getCurrentWindow: () => ({
      close: async () => { window.__previewWindowClosed = true; },
      destroy: async () => { window.__previewWindowClosed = true; },
      onCloseRequested: async () => {},
    }),
  },
};
window.__previewPluginListeners = [];
window.__previewWindowClosed = false;
})();
