// 全局状态：单一 store + 订阅渲染。

const listeners = new Set();

export const state = {
  ready: false,
  settings: {
    theme: 'light',
    fontFamily: '"霞鹜文楷", "Source Han Serif SC", "宋体", serif',
    fontSize: 18,
    lineHeight: 1.9,
    letterSpacing: 0.02,
    autosaveSecs: 20,
    historyDepth: 30,
    snapshotCharDelta: 120,
    editorWidth: 860,
    dailyGoal: 3000,
    oneClickFormatRule: 'cjk-indent',
  },
  registry: { books: [] },
  storageDir: '',
  storageBytes: 0,
  book: null,
  cards: [],
  versions: [],
  sessionChars: 0,

  activeVolumeId: '',
  activeChapterId: '',
  content: '',
  dirty: false,
  saving: false,
  lastSavedAt: 0,
  saveState: '就绪',

  cardKind: 'character',
  cardSearch: '',
  activeCardId: '',

  sidebarOpen: true,
  inspectorOpen: true,
  focus: false,
  pomodoro: { running: false, remaining: 25 * 60, mode: 'focus' },

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
  return state.book.volumes.flatMap((v) => v.chapters.map((c) => ({ ...c, volumeId: v.id, volumeTitle: v.title })));
}

export function findChapter(chapterId) {
  return chapters().find((c) => c.id === chapterId) || null;
}

export function findVolumeOf(chapterId) {
  if (!state.book) return null;
  return state.book.volumes.find((v) => v.chapters.some((c) => c.id === chapterId)) || null;
}

export function bookCharCount() {
  if (!state.book) return 0;
  return state.book.volumes.reduce((sum, v) => sum + v.chapters.reduce((s, c) => s + (c.charCount || 0), 0), 0);
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
