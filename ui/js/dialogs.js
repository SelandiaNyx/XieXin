// 各类弹层聚合入口：按职责拆分在 ./dialogs/ 子目录下，对外保持原有导出签名不变。

export {
  openBookPicker,
  switchBook,
  reloadWorkspace,
} from './dialogs/bookshelf.js';

export {
  openLocationSetup,
  changeStorageDir,
} from './dialogs/location.js';

export {
  openSettings,
  THEMES,
  loadFonts,
  openStylePreview,
} from './dialogs/settings.js';

export {
  openExport,
  openRecentExports,
} from './dialogs/export.js';

export {
  openHistory,
  diffHtml,
} from './dialogs/history.js';

export {
  openStats,
  openOutline,
  openSearch,
  toggleFindBar,
  initFindBar,
  openTrash,
  importTextDialog,
  runVerify,
  openHelp,
} from './dialogs/tools.js';
