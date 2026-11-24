// 全局状态：单一 store + 订阅渲染（保持无外部 import，供 Node VM 单元测试直接加载）。

const listeners = new Set();

export const state = {
  ready: false,
  settings: {
    theme: 'sakura',
    fontFamily: '"霞鹜文楷", "LXGW WenKai", "Source Han Serif SC", "思源宋体", "Songti SC", "宋体", serif',
    fontSize: 18,
    lineHeight: 1.95,
    letterSpacing: 0.02,
    autosaveSecs: 20,
    historyDepth: 30,
    snapshotCharDelta: 120,
    editorWidth: 860,
    dailyGoal: 3000,
    lastBookId: '',
    lastChapterId: '',
    lastExportDir: '',
    oneClickFormatRule: 'cjk-indent',
    animeDecor: true,
    typewriterMode: false,
    quickPunctBar: true,
    showSynopsis: true,
    deviceId: '',
    deviceName: '',
    ai: {
      activeProfileId: 'deepseek',
      profiles: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          provider: 'openai',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: '',
          model: 'deepseek-chat',
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
      pin: '',
      lastPeerUrl: '',
      lastPeerPin: '',
      lastSyncAt: 0,
    },
  },
  registry: { books: [] },
  storageDir: '',
  storageBytes: 0,
  /** 稿件目录的位置信息（首次启动要不要让用户选位置、是否被启动参数锁定） */
  location: null,
  /** 该平台有没有原生文件选择器（Android 没有） */
  hasNativePickers: true,
  platform: 'windows',
  lanStatus: {
    running: false,
    port: 19820,
    pin: '',
    deviceId: '',
    deviceName: '',
    addresses: [],
    connectUri: '',
  },
  syncing: false,

  book: null,
  /** 当前作品的封面（data URL），空串表示没设过、界面用颜色 + 图标 */
  bookCover: '',
  cards: [],
  versions: [],
  sessionChars: 0,
  sessionStartAt: Date.now(),

  activeVolumeId: '',
  activeChapterId: '',
  content: '',
  dirty: false,
  saving: false,
  transitioning: false,
  lastSavedAt: 0,
  saveState: '就绪',

  cardKind: 'character',
  cardSearch: '',
  activeCardId: '',

  sidebarOpen: true,
  inspectorOpen: true,
  inspectorPane: 'cards', // 'cards' | 'ai'
  previewMode: false,
  focus: false,
  pomodoro: { running: false, remaining: 25 * 60, mode: 'focus' },

  aiStreaming: false,
  aiRequestId: '',
  aiMessages: [],

  fonts: [],
  recentExports: [],
  chapterStatuses: [],
  statusById: {},
};

export function setState(patch) {
  Object.assign(state, patch);
  listeners.forEach((fn) => fn(state));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  listeners.forEach((fn) => fn(state));
}

export function chapters() {
  if (!state.book) return [];
  return state.book.volumes.flatMap((v) =>
    v.chapters.map((c) => ({ ...c, volumeId: v.id, volumeTitle: v.title })),
  );
}

export function findChapter(chapterId) {
  return state.book?.volumes.flatMap((v) => v.chapters).find((c) => c.id === chapterId) || null;
}

export function findVolumeOf(chapterId) {
  if (!state.book) return null;
  return state.book.volumes.find((v) => v.chapters.some((c) => c.id === chapterId)) || null;
}

export function bookCharCount() {
  if (!state.book) return 0;
  return state.book.volumes.reduce(
    (sum, v) => sum + v.chapters.reduce((s, c) => s + (c.charCount || 0), 0),
    0,
  );
}

export function bookChapterCount() {
  if (!state.book) return 0;
  return state.book.volumes.reduce((sum, v) => sum + v.chapters.length, 0);
}

export function currentBookMeta() {
  return state.registry.books.find((b) => b.id === (state.book && state.book.id)) || null;
}

/** 章节状态：颜色 / 文案 / 分组，来自后端 chapter_statuses。 */
export function statusInfo(id) {
  return state.statusById[id] || { id, label: id || '草稿', group: '创作', color: '#9aa0b4', hint: '' };
}

export function statusLabel(id) {
  return statusInfo(id).label;
}

/** 获取当前选中的 AI 配置方案（带健壮兜底）。 */
export function activeAiProfile() {
  const ai = state.settings?.ai;
  const list = Array.isArray(ai?.profiles) ? ai.profiles : [];
  return (
    list.find((p) => p.id === ai?.activeProfileId) ||
    list[0] || {
      id: 'deepseek',
      name: 'DeepSeek',
      provider: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      temperature: 0.75,
      maxTokens: 2048,
    }
  );
}
