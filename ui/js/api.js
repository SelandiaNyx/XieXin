// 与 Rust 后端通信的薄封装。

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

export const api = {
  uiReady: () => call('ui_ready'),
  workspace: () => call('workspace_state'),
  storageInfo: () => call('storage_info'),

  createBook: (title, author, genre) => call('create_book', { title, author, genre }),
  openBook: (bookId) => call('open_book', { bookId }),
  deleteBook: (bookId) => call('delete_book', { bookId }),
  updateBookMeta: (payload) => call('update_book_meta', payload),
  bookStats: (bookId) => call('book_stats', { bookId }),
  saveSettings: (settings) => call('save_settings', { settings }),

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

  readChapter: (bookId, chapterId) => call('read_chapter', { bookId, chapterId }),
  saveChapter: (payload) => call('save_chapter', payload),
  listVersions: (bookId, chapterId) => call('list_versions', { bookId, chapterId }),
  versionDetail: (bookId, chapterId, versionId) =>
    call('version_detail', { bookId, chapterId, versionId }),
  restoreVersion: (bookId, chapterId, versionId) =>
    call('restore_version', { bookId, chapterId, versionId }),
  deleteVersion: (bookId, chapterId, versionId) => call('delete_version', { bookId, chapterId, versionId }),

  listCards: (bookId) => call('list_cards', { bookId }),
  upsertCard: (bookId, card) => call('upsert_card', { bookId, card }),
  deleteCard: (bookId, cardId) => call('delete_card', { bookId, cardId }),

  count: (text) => call('count', { text }),
  format: (text, rule, chapterTitle, ensureTitle) =>
    call('one_click_format', { text, rule, chapterTitle, ensureTitle }),
  replaceAll: (text, needle, replacement, caseSensitive) =>
    call('replace_all', { text, needle, replacement, caseSensitive }),

  pickDirectory: (title) => call('pick_directory', { title }),
  pickOpenFile: (kind) => call('pick_open_file', { kind }),
  pickSavePath: (defaultName, ext) => call('pick_save_path', { defaultName, ext }),
  suggestFilename: (bookId, options) => call('suggest_filename', { bookId, options }),
  exportBook: (bookId, options) => call('export_book', { bookId, options }),
  recentExports: () => call('list_recent_exports'),
  importText: (bookId, volumeId, sourcePath, text) =>
    call('import_text', { bookId, volumeId, sourcePath, text }),
  importBackup: (sourcePath, asNewBook) => call('import_backup', { sourcePath, asNewBook }),
  verifyBook: (bookId) => call('verify_book', { bookId }),
  listTrash: () => call('list_trash'),
  emptyTrash: () => call('empty_trash'),
  openInExplorer: (path) => call('open_in_explorer', { path }),
  listFonts: () => call('list_fonts'),
  chapterStatuses: () => call('chapter_statuses'),
  uiLog: (message) => call('ui_log', { message }).catch(() => {}),
  smokeTest: () => call('dev_smoke_test'),
};

// 前端运行日志写到数据目录的 ui-log.txt，方便排查 WebView 内部错误
export function log(message) {
  api.uiLog(String(message));
}
