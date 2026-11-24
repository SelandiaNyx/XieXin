// 与 Rust 后端通信的统一接口封装（涵盖存储、排版、导出、局域网/WebDAV 同步与 AI 助手）。

function invokeRaw(cmd, args) {
  const t = window.__TAURI__;
  if (!t || !t.core || !t.core.invoke) {
    return Promise.reject(new Error('Tauri 运行时不可用（请通过 cargo run / 应用本体启动）'));
  }
  return t.core.invoke(cmd, args);
}

export async function call(cmd, args = {}) {
  try {
    return await invokeRaw(cmd, args);
  } catch (e) {
    const msg = typeof e === 'string' ? e : (e && e.message) || String(e);
    throw new Error(msg);
  }
}

/** 订阅 Rust 侧推送的 Tauri 事件（如 `ai:stream`、`sync:remote-updated`）。 */
export async function listen(eventName, handler) {
  const fn = window.__TAURI__?.event?.listen;
  if (typeof fn !== 'function') return () => {};
  try {
    return await fn(eventName, (ev) => handler(ev?.payload ?? ev));
  } catch {
    return () => {};
  }
}

export const api = {
  uiReady: () => call('ui_ready'),
  workspace: () => call('workspace_state'),
  storageInfo: () => call('storage_info'),

  // 书籍与封面
  createBook: (title, author, genre) => call('create_book', { title, author, genre }),
  createSampleBook: () => call('create_sample_book'),
  duplicateBook: (bookId) => call('duplicate_book', { bookId }),
  openBook: (bookId) => call('open_book', { bookId }),
  deleteBook: (bookId) => call('delete_book', { bookId }),
  updateBookMeta: (payload) => call('update_book_meta', payload),
  setBookCover: (bookId, sourcePath) => call('set_book_cover', { bookId, sourcePath }),
  setBookCoverBytes: (bookId, ext, base64Data) =>
    call('set_book_cover_bytes', { bookId, ext, base64Data }),
  clearBookCover: (bookId) => call('clear_book_cover', { bookId }),
  bookCover: (bookId) => call('book_cover', { bookId }),
  previewCover: (path) => call('preview_cover', { path }),
  bookStats: (bookId) => call('book_stats', { bookId }),
  saveSettings: (settings) => call('save_settings', { settings }),
  setLastPosition: (bookId, chapterId) => call('set_last_position', { bookId, chapterId }),

  // 卷与章节结构
  addVolume: (bookId, title) => call('add_volume', { bookId, title }),
  addChapter: (bookId, volumeId, title) => call('add_chapter', { bookId, volumeId, title }),
  deleteChapter: (bookId, chapterId) => call('delete_chapter', { bookId, chapterId }),
  deleteVolume: (bookId, volumeId, deleteChapters = true) =>
    call('delete_volume', { bookId, volumeId, deleteChapters }),
  renameNode: (payload) => call('rename_node', payload),
  moveNode: (bookId, kind, id, direction) => call('move_node', { bookId, kind, id, direction }),
  moveChapterTo: (bookId, chapterId, targetVolumeId, position) =>
    call('move_chapter_to', { bookId, chapterId, targetVolumeId, position }),
  setVolumeExpanded: (bookId, volumeId, expanded) =>
    call('set_volume_expanded', { bookId, volumeId, expanded }),

  // 章节正文与版本历史
  readChapter: (bookId, chapterId) => call('read_chapter', { bookId, chapterId }),
  searchBook: (bookId, needle, maxPerChapter = 5) =>
    call('search_book', { bookId, needle, maxPerChapter }),
  saveChapter: (payload) => call('save_chapter', payload),
  listVersions: (bookId, chapterId) => call('list_versions', { bookId, chapterId }),
  versionDetail: (bookId, chapterId, versionId) =>
    call('version_detail', { bookId, chapterId, versionId }),
  restoreVersion: (bookId, chapterId, versionId) =>
    call('restore_version', { bookId, chapterId, versionId }),
  deleteVersion: (bookId, chapterId, versionId) =>
    call('delete_version', { bookId, chapterId, versionId }),

  // 素材卡片
  listCards: (bookId) => call('list_cards', { bookId }),
  upsertCard: (bookId, card) => call('upsert_card', { bookId, card }),
  deleteCard: (bookId, cardId) => call('delete_card', { bookId, cardId }),

  // 排版与文本处理
  count: (text) => call('count', { text }),
  format: (text, rule, chapterTitle, ensureTitle) =>
    call('one_click_format', { text, rule, chapterTitle, ensureTitle }),
  replaceAll: (text, needle, replacement, caseSensitive) =>
    call('replace_all', { text, needle, replacement, caseSensitive }),

  // 文件与导入导出
  pickDirectory: (title) => call('pick_directory', { title }),
  setStorageDir: (path, moveData = true) => call('set_storage_dir', { path, moveData }),
  pickOpenFile: (kind) => call('pick_open_file', { kind }),
  pickSavePath: (defaultName, ext) => call('pick_save_path', { defaultName, ext }),
  suggestFilename: (bookId, options) => call('suggest_filename', { bookId, options }),
  exportBook: (bookId, options) => call('export_book', { bookId, options }),
  recentExports: () => call('list_recent_exports'),
  importText: (bookId, volumeId, sourcePath, text) =>
    call('import_text', { bookId, volumeId, sourcePath, text }),
  importBackup: (sourcePath, asNewBook = true, rawJson = null) =>
    call('import_backup', { sourcePath, rawJson, asNewBook }),

  // 局域网同步（LAN Sync）
  lanStatus: () => call('lan_status'),
  lanStart: (payload = {}) => call('lan_start', payload),
  lanStop: () => call('lan_stop'),
  lanRegeneratePin: () => call('lan_regenerate_pin'),
  lanScanPeers: () => call('lan_scan_peers'),
  lanPingPeer: (url) => call('lan_ping_peer', { url }),
  lanSyncPeer: (url, pin, direction = 'bidirectional') =>
    call('lan_sync_peer', { url, pin, direction }),

  // WebDAV 云同步
  webdavTest: (config) => call('webdav_test', { config }),
  webdavSync: (config = null, direction = 'bidirectional') =>
    call('webdav_sync', { config, direction }),

  // AI 创作助手
  aiChatStream: (requestId, messages, context, profile = null) =>
    call('ai_chat_stream', { requestId, messages, context, profile }),
  aiCancel: (requestId) => call('ai_cancel', { requestId }),
  aiListModels: (provider, baseUrl, apiKey) =>
    call('ai_list_models', { provider, baseUrl, apiKey }),
  aiTestConnection: (profile) => call('ai_test_connection', { profile }),
  aiLoadHistory: (bookId) => call('ai_load_history', { bookId }),
  aiSaveHistory: (bookId, messages) => call('ai_save_history', { bookId, messages }),

  // 维护与系统辅助
  verifyBook: (bookId) => call('verify_book', { bookId }),
  listTrash: () => call('list_trash'),
  emptyTrash: () => call('empty_trash'),
  openInExplorer: (path) => call('open_in_explorer', { path }),
  listFonts: () => call('list_fonts'),
  chapterStatuses: () => call('chapter_statuses'),
  uiLog: (message) => call('ui_log', { message }).catch(() => {}),
  smokeTest: () => call('dev_smoke_test'),
};

// 前端运行日志写到数据目录的 ui.log，方便排查 WebView 内部错误
export function log(message) {
  api.uiLog(String(message));
}
