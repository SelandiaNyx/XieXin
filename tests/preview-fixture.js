// Synthetic, ephemeral manuscripts; no disk access or real user data.
(() => {
  const now = Date.now();
  const settings = {
    theme: 'sakura',
    fontFamily: '"Microsoft YaHei", sans-serif',
    fontSize: 17,
    lineHeight: 2.1,
    letterSpacing: 0.02,
    editorWidth: 860,
    autosaveSecs: 20,
    dailyGoal: 3000,
    historyDepth: 30,
    snapshotCharDelta: 120,
    lastBookId: 'sample',
    lastChapterId: 'c1',
    oneClickFormatRule: 'cjk-indent',
    animeDecor: true,
    typewriterMode: false,
    quickPunctBar: true,
    showSynopsis: true,
    deviceId: 'preview-dev-01',
    deviceName: '预览工作台 PC',
    ai: {
      activeProfileId: 'deepseek',
      profiles: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          provider: 'openai',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'demo-preview-key',
          model: 'deepseek-chat',
          temperature: 0.75,
          maxTokens: 2048,
        },
        {
          id: 'gemini',
          name: 'Google Gemini',
          provider: 'gemini',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          apiKey: '',
          model: 'gemini-2.5-flash',
          temperature: 0.75,
          maxTokens: 2048,
        },
      ],
      systemPrompt: '',
      includeChapter: true,
      includeCards: true,
      includeOutline: true,
      contextChars: 2500,
    },
    webdav: {
      enabled: false,
      preset: 'jianguoyun',
      url: 'https://dav.jianguoyun.com/dav/',
      username: '',
      password: '',
      remotePath: '/HeartWrite',
      autoSync: false,
      autoSyncMins: 10,
      lastSyncAt: 0,
    },
    lan: {
      serverEnabled: false,
      port: 19820,
      pin: '482910',
      lastPeerUrl: '',
      lastPeerPin: '',
      lastSyncAt: 0,
    },
  };
  let lanStatus = {
    running: false,
    port: 19820,
    pin: '482910',
    deviceId: 'preview-dev-01',
    deviceName: '预览工作台 PC',
    addresses: ['192.168.1.88'],
    connectUri: 'heartwrite://192.168.1.88:19820?pin=482910',
  };
  const aiHistoryByBook = {};
  const eventListeners = new Map();
  const emitEvent = (name, payload) => {
    const list = eventListeners.get(name) || [];
    list.forEach((fn) => fn({ event: name, payload }));
  };

  const book = {
    id: 'sample',
    title: '剑气长河',
    author: '示例作者',
    genre: '武侠',
    summary: '北境雪夜，旧刀重燃。',
    coverColor: '#147d6c',
    coverImage: 'cover.png',
    createdAt: now,
    updatedAt: now,
    volumes: [
      {
        id: 'v1',
        title: '第一卷 · 风起北境',
        expanded: true,
        chapters: [
          { id: 'c1', title: '第一章 雪夜', summary: '沈孤鸿在城墙守候十年旧约。', status: 'revising', charCount: 159, versions: 3 },
          { id: 'c2', title: '第二章 旧约', summary: '', status: 'draft', charCount: 76, versions: 1 },
          { id: 'c3', title: '第三章 落子', summary: '', status: 'draft', charCount: 32, versions: 1 },
        ],
      },
      {
        id: 'v2',
        title: '第二卷 · 山河故人',
        expanded: true,
        chapters: [{ id: 'c4', title: '第四章 长夜', summary: '', status: 'draft', charCount: 0, versions: 0 }],
      },
    ],
  };
  const content = {
    c1: '雪落下来了。\n\n沈孤鸿站在城墙上，看着远处连绵的灯火。风从北面吹来，卷起他衣角的一片霜色。\n\n他已经在这里站了三个时辰。\n\n“你还是来了。”身后传来一个声音。\n\n他没有回头，只是把手按在刀柄上：“我等这一天，等了十年。”\n\n雪花落在刀鞘上，很快融成了水。城门外，一匹瘦马正踏着积雪缓缓走来，马背上的人披着一件青色的旧斗篷。',
    c2: '城南的酒肆里，说书人正讲着十年前的那场大火。',
    c3: '棋盘上只剩三枚子。',
    c4: '',
  };
  const cards = [
    { id: 'n1', kind: 'character', title: '沈孤鸿', content: '灭门案的唯一幸存者。沉默寡言，带着一把旧刀重回北境。', tags: ['主角', '剑客'], fields: { 身份: '游侠', 目标: '查明十年前的真相' }, color: '#62a98e', pinned: true },
    { id: 'n2', kind: 'character', title: '柳青梧', content: '药铺掌柜之女，善用毒，暗中接济流民。她知道的，远比她说出的多。', tags: ['女主', '医毒'], fields: { 立场: '中立偏善' }, color: '#ceac78' },
    { id: 'n3', kind: 'plot', title: '雪夜伏击', content: '黑衣人袖口的火纹，与十年前灭门案一致。', tags: ['伏笔'], fields: {}, color: '#ac9dca' },
  ];
  const statuses = [
    { id: 'draft', label: '草稿', color: '#81918b', group: '创作' },
    { id: 'revising', label: '修订中', color: '#ae7b38', group: '创作' },
    { id: 'final', label: '已定稿', color: '#147d6c', group: '创作' },
  ];
  const versions = [{ id: 'version1', label: '开篇初稿', kind: 'manual', createdAt: now - 86400000, chars: 50 }];
  const empty = new URLSearchParams(location.search).has('empty');
  const hasNativePickers = !new URLSearchParams(location.search).has('nopickers');
  if (new URLSearchParams(location.search).has('novolume')) book.volumes = [];
  const locationParam = new URLSearchParams(location.search).get('location') || '';
  let locationState = locationParam
    ? { dir: 'C:/Users/示例/AppData/Roaming/com.heartwrite.novelmanager', suggested: 'C:/Users/示例/Documents/写心稿件', needsChoice: true, isForced: false, missing: locationParam === 'missing' }
    : { dir: '界面预览 · 临时示例数据', suggested: 'C:/Users/示例/Documents/写心稿件', needsChoice: false, isForced: !hasNativePickers, missing: false };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const COVER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAACACAIAAAB7vvvtAAABl0lEQVR42u3dO07DQBQF0DeIJbAG6FgBWQAKDaInHR0FFbvg01DRxBugIRI9O6CDzQwNSiSCLQ8YyfKcVyUSWOHqnTsmKZL2jh4ickROERE5RY6vB5unKXJsHnx7uv7JKLzO+ld6XqftBZS+nrLr7ITpnN1IQhDQHwYxGzR4QB+r82rjOJ5fIjYQsYOTZVX3QS/P9xGxnUZ7B9XZTQIqDUgH/fqYt0ECQgwxxBBDDDEB6SCjgxBDDDHEEEMMMQEJSAfpIMQQQwwxAQlIB+kgxBBDDDHEEENMQALSQToIMcQQQwwxgxhiAtJBOggxxBCzQQISkA7SQYghhhhiiBnEEBOQDtJBiCGGmA1CDDHEEBOQDtJBiAkIMcQQQwwxxASkg3RQ7w16u5rUN7bMb68RK9PUElDvObxrJvbNLI55p5iAHPP+1aiH2OvidMx/2tnyBrFxE5s1T6O+D0pOMaeYU8yNooB0kLFBiCGGGGKIIVY5sfeLhYA6NyhsUMvnYvuPTef7ONP5XOyn69igwUraOOZtkID+fz4BIVgDKxIeCMUAAAAASUVORK5CYII=';
  const stats = () => ({ charCount: 267, chapters: 4, volumes: 2, cards: cards.length, words: 0, cjk: 267, versions: 5, todayChars: 159 });

  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args = {}) => {
        switch (cmd) {
          case 'ui_ready': return 'preview';
          case 'ui_log': console.log(args.message); return;
          case 'workspace_state':
            return clone({
              settings,
              registry: { books: empty ? [] : [book] },
              storageDir: locationState.dir,
              storageBytes: 24576,
              hasNativePickers,
              platform: hasNativePickers ? 'windows' : 'android',
              location: locationState,
              lanStatus,
            });
          case 'set_storage_dir': {
            locationState = { dir: args.path, suggested: locationState.suggested, needsChoice: false, isForced: false, missing: false };
            return clone(locationState);
          }
          case 'pick_directory': return 'D:/示例/我的稿件';
          case 'chapter_statuses': return clone(statuses);
          case 'list_fonts': return [];
          case 'open_book': return clone({ book, cards, cover: book.coverImage ? COVER : null });
          case 'pick_open_file': return args.kind === 'image' ? 'D:/示例/新封面.png' : null;
          case 'preview_cover': return COVER;
          case 'book_cover': return book.coverImage ? COVER : '';
          case 'set_book_cover':
          case 'set_book_cover_bytes':
            book.coverImage = 'cover.png';
            return clone(book);
          case 'clear_book_cover': book.coverImage = ''; return clone(book);
          case 'update_book_meta': {
            if (args.title) book.title = args.title;
            if (args.author !== undefined) book.author = args.author;
            if (args.genre !== undefined) book.genre = args.genre;
            if (args.summary !== undefined) book.summary = args.summary;
            if (args.coverColor) book.coverColor = args.coverColor;
            return clone(book);
          }
          case 'read_chapter': return { content: content[args.chapterId] || '', updatedAt: now };
          case 'add_volume': {
            const vol = { id: `v${book.volumes.length + 1}`, title: `第${book.volumes.length + 1}卷`, expanded: true, chapters: [] };
            book.volumes.push(vol);
            return clone(book);
          }
          case 'add_chapter': {
            const vol = book.volumes.find((v) => v.id === args.volumeId);
            if (!vol) throw new Error('找不到目标卷');
            const ch = { id: `c${Object.keys(content).length + 1}`, title: `第${vol.chapters.length + 1}章`, summary: '', status: 'draft', charCount: 0, versions: 0 };
            vol.chapters.push(ch);
            content[ch.id] = '';
            return clone(book);
          }
          case 'list_versions': return clone(versions);
          case 'save_chapter': {
            content[args.chapterId] = args.content;
            for (const vol of book.volumes) {
              const c = vol.chapters.find((x) => x.id === args.chapterId);
              if (c) {
                if (args.title) c.title = args.title;
                if (args.summary !== undefined) c.summary = args.summary;
                if (args.status) c.status = args.status;
                c.charCount = args.content.length;
              }
            }
            return { updatedAt: Date.now(), charCount: args.content.length, versions: 3 };
          }
          case 'save_settings':
            Object.assign(settings, args.settings);
            return clone(settings);
          case 'set_last_position':
            settings.lastBookId = args.bookId || '';
            settings.lastChapterId = args.chapterId || '';
            return;
          case 'storage_info': return { bytes: 24576 };
          case 'book_stats': return stats();
          case 'list_cards': return clone(cards);
          case 'upsert_card': {
            const c = { ...args.card, id: args.card.id || `n${cards.length + 1}`, updatedAt: Date.now() };
            const i = cards.findIndex((x) => x.id === c.id);
            if (i >= 0) cards[i] = c;
            else cards.push(c);
            return clone(c);
          }
          case 'delete_card': {
            const i = cards.findIndex((x) => x.id === args.cardId);
            if (i >= 0) cards.splice(i, 1);
            return clone(cards);
          }
          case 'move_chapter_to': {
            let taken = null;
            for (const vol of book.volumes) {
              const i = vol.chapters.findIndex((c) => c.id === args.chapterId);
              if (i > -1) { taken = vol.chapters.splice(i, 1)[0]; break; }
            }
            if (!taken) throw new Error('找不到该章节');
            const target = book.volumes.find((v) => v.id === args.targetVolumeId);
            if (!target) throw new Error('找不到目标卷');
            target.chapters.splice(Math.min(args.position, target.chapters.length), 0, taken);
            return clone(book);
          }
          case 'version_detail': return { meta: versions[0], content: '雪落下来了。', current: content.c1 };
          case 'list_recent_exports':
          case 'list_trash':
            return [];
          case 'verify_book': return [];

          // 局域网同步（预览模拟）
          case 'lan_status': return clone(lanStatus);
          case 'lan_start': {
            lanStatus = {
              ...lanStatus,
              running: true,
              port: args.port || lanStatus.port || 19820,
              deviceName: args.deviceName || lanStatus.deviceName,
              connectUri: `heartwrite://192.168.1.88:${args.port || 19820}?pin=${lanStatus.pin}`,
            };
            return clone(lanStatus);
          }
          case 'lan_stop':
            lanStatus.running = false;
            return clone(lanStatus);
          case 'lan_regenerate_pin':
            lanStatus.pin = String(100000 + Math.floor(Math.random() * 899999));
            lanStatus.connectUri = `heartwrite://192.168.1.88:${lanStatus.port}?pin=${lanStatus.pin}`;
            return clone(lanStatus);
          case 'lan_scan_peers':
            return [
              { deviceId: 'phone-demo', deviceName: '随身 Android 手机', platform: 'android', url: 'http://192.168.1.92:19820', books: 1, lastSeenMs: Date.now() },
            ];
          case 'lan_ping_peer':
            return { ok: true, app: 'heartwrite', protocol: 1, deviceId: 'phone-demo', deviceName: '随身 Android 手机', platform: 'android', books: 1, requiresPin: true };
          case 'lan_sync_peer':
            return { ok: true, mode: '局域网双向同步', peerName: '随身 Android 手机', uploaded: 1, downloaded: 1, merged: 0, conflicts: 0, deletedLocal: 0, deletedRemote: 0, skipped: 3, durationMs: 42, finishedAt: Date.now(), details: ['上传：第一章 雪夜', '下载：第二章 旧约'] };

          // WebDAV（预览模拟）
          case 'webdav_test':
            return { ok: true, status: 207, message: 'WebDAV 连接成功（预览模拟 · 207 Multi-Status）', resolvedUrl: args.config?.url || '' };
          case 'webdav_sync':
            return { ok: true, mode: 'WebDAV 云同步', peerName: args.config?.url || 'WebDAV', uploaded: 2, downloaded: 0, merged: 0, conflicts: 0, deletedLocal: 0, deletedRemote: 0, skipped: 2, durationMs: 88, finishedAt: Date.now(), details: ['上传：books/sample/book.json', '上传：content/sample/c1.json'] };

          // AI 写心酱（预览流式模拟）
          case 'ai_load_history':
            return clone({ bookId: args.bookId, messages: aiHistoryByBook[args.bookId] || [] });
          case 'ai_save_history':
            aiHistoryByBook[args.bookId] = clone(args.messages || []);
            return;
          case 'ai_list_models':
            return ['deepseek-chat', 'deepseek-reasoner', 'gpt-4o-mini'];
          case 'ai_test_connection':
            return { ok: true, model: args.profile?.model || 'deepseek-chat', reply: 'OK（写心酱连接就绪）', latencyMs: 65 };
          case 'ai_cancel':
            return true;
          case 'ai_chat_stream': {
            const rid = args.requestId;
            const reply = '雪势渐急，青色斗篷在城门灯影下停住，来人抬头望向城头，声音清冽如碎冰：“十年未见，沈兄的刀可还稳？”';
            emitEvent('ai:stream', { requestId: rid, kind: 'delta', text: '', reasoning: '结合前文雪夜重逢氛围，续写来人亮相与对白。' });
            emitEvent('ai:stream', { requestId: rid, kind: 'delta', text: reply, reasoning: '' });
            emitEvent('ai:stream', { requestId: rid, kind: 'done', text: reply, reasoning: '' });
            return reply;
          }
          default:
            throw new Error('此操作需要桌面应用：' + cmd);
        }
      },
      addPluginListener: async (plugin, event, handler) => {
        window.__previewPluginListeners.push({ plugin, event, handler });
        return { unregister: async () => {} };
      },
    },
    event: {
      listen: async (name, handler) => {
        if (!eventListeners.has(name)) eventListeners.set(name, []);
        eventListeners.get(name).push(handler);
        return () => {
          const arr = eventListeners.get(name) || [];
          const i = arr.indexOf(handler);
          if (i >= 0) arr.splice(i, 1);
        };
      },
    },
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
