// 应用入口：初始化、MD3 工作室布局联动、AI 写心酱、跨端同步、快捷键、番茄钟与自动保存。

import { api, listen, log } from './api.js';
import { state, setState, subscribe, findChapter, bookCharCount, chapters } from './store.js';
import { toast, confirmDialog, closeModal, modalOpen, formatBytes, escapeHtml, promptDialog } from './ui.js';
import { initSidebar, renderToc, refreshBook, createChapter, createVolume } from './sidebar.js';
import {
  initEditor, openChapter, saveChapter, saveNow, withEditorTransition, flushPendingSave, applyFonts,
  updateCounts, togglePreviewMode, editorEl, focusEditor, editorValue, renderSessionChip,
} from './editor.js';
import { initCards, renderCards } from './cards.js';
import { initAiAssistant, loadAiHistoryForBook, openAiPane, renderAiHeader, runAiSkill } from './ai.js';
import { initMobile } from './mobile.js';
import { isMobile } from './viewport.js';
import * as dialogs from './dialogs.js';
import * as pomodoro from './pomodoro.js';

let lastSessionChapter = '';
let lastAiBookId = '';
let tocBook = null;
let tocChapter = '';
let tocSaving = false;

/** 前端资源构建标记：改动 ui 后改这里，便于确认应用加载的是最新界面。 */
const UI_BUILD = 'ui-2026-11-24-md3-anime-studio-v1.0.0';

window.__moge = {
  openChapter,
  saveNow,
  refreshBook,
  renderToc,
  openSyncCenter: (tab) => dialogs.openSyncCenter(tab),
  openAiPane,
  get ready() {
    return state.ready;
  },
  state,
};

async function boot() {
  window.addEventListener('error', (e) => log(`[error] ${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    log(`[reject] ${(r && r.message) || r}`);
  });
  log(`boot start · ${UI_BUILD} · 视口 ${window.innerWidth}x${window.innerHeight}`);

  initSidebar({
    onSelectChapter: (id) => openChapter(id),
    onOpenBookPicker: () => dialogs.openBookPicker(),
    onNewBook: () => dialogs.openBookPicker(),
  });
  initEditor({
    onSelectionAi: (skill, selectedText) => runAiSkill(skill, selectedText),
  });
  initCards();
  initAiAssistant({
    onOpenSettings: (section) => dialogs.openSettings(section),
  });
  initMobile();
  dialogs.initFindBar();
  bindGlobalUi();
  await bindCloseGuard();
  applyFonts();

  try {
    await api.uiReady();
  } catch (e) {
    toast(`无法连接后端：${e.message}`, 'err');
  }

  try {
    const list = await api.chapterStatuses();
    const byId = {};
    list.forEach((s) => { byId[s.id] = s; });
    const aliases = { done: 'final', locked: 'final', published: 'published', drafting: 'draft' };
    Object.entries(aliases).forEach(([old, now]) => {
      if (byId[now]) byId[old] = { ...byId[now], id: old, label: byId[now].label };
    });
    setState({ chapterStatuses: list, statusById: byId });
    const sel = document.getElementById('statusSelect');
    const current = chapters().map((c) => c.status || 'draft');
    const extra = [...new Set(current)].filter((id) => !list.some((s) => s.id === id));
    sel.innerHTML =
      list.map((s) => `<option value="${s.id}" title="${escapeHtml(s.hint)}">${s.label}</option>`).join('') +
      extra
        .map((id) => `<option value="${id}" title="旧版本状态">${escapeHtml(byId[id] ? byId[id].label : id)}</option>`)
        .join('');
  } catch (e) {
    log(`[status] 读取章节状态失败: ${e.message}`);
  }

  try {
    await dialogs.reloadWorkspace();
    dialogs.loadFonts();
  } catch (e) {
    toast(`读取工作区失败：${e.message}`, 'err');
  }

  if (state.location?.needsChoice && state.hasNativePickers) {
    await dialogs.openLocationSetup();
    await dialogs.reloadWorkspace();
  }

  const lastBook = state.settings.lastBookId;
  const exists = state.registry.books.some((b) => b.id === lastBook);
  if (exists) {
    await dialogs.switchBook(lastBook);
  } else if (state.registry.books.length > 0) {
    await dialogs.switchBook(state.registry.books[0].id);
  } else {
    setState({ book: null });
    renderToc();
    renderCards();
    setTimeout(() => dialogs.openBookPicker(), 260);
  }

  // 监听另一台局域网设备推送完数据后的刷新通知
  void listen('sync:remote-updated', async () => {
    toast('收到来自局域网同伴设备的同步更新，正在刷新工作区…', 'ok');
    if (state.dirty) await flushPendingSave();
    await dialogs.reloadAfterSync();
  });

  dialogs.updateSyncIndicator();
  dialogs.restartWebDavAutoSync();
  renderAiHeader();

  setState({ ready: true });
  startSessionTimer();
  pomodoro.initPomodoro();
  renderSessionChip();
  void dialogs.loadFonts().then(() => {});
  if (!isMobile()) focusEditor();

  requestAnimationFrame(() => {
    document.getElementById('app').classList.remove('no-anim');
  });
  log(
    `boot ok · 书架 ${state.registry.books.length} 本 · 当前《${state.book ? state.book.title : '无'}》·` +
      ` 卷 ${state.book ? state.book.volumes.length : 0} · 卡片 ${state.cards.length} · 字体 ${state.fonts.length}`,
  );
  log(
    `boot chapter · 已打开「${
      (findChapter(state.activeChapterId) || {}).title || '（无章节）'
    }」id=${state.activeChapterId || '-'}`,
  );
}

function bindGlobalUi() {
  const app = document.getElementById('app');
  const cardsPane = document.getElementById('cardsPane');
  const aiPane = document.getElementById('aiPane');

  const syncLayout = () => {
    app.dataset.busy = state.transitioning ? 'yes' : 'no';
    app.dataset.haschapter = state.activeChapterId ? 'yes' : 'no';
    document.getElementById('emptyTitle').textContent = state.book ? '为故事写下第一章' : '每一个故事，都从这里开始';
    document.getElementById('emptyStart').textContent = state.book ? '新建章节' : '创建作品';
    for (const id of ['saveBtn', 'oneClickFormat', 'snapshotBtn', 'historyBtn']) {
      const el = document.getElementById(id);
      if (el) el.disabled = !state.activeChapterId || state.transitioning;
    }
    document.getElementById('focusBtn').setAttribute('aria-pressed', String(state.focus));
    document.getElementById('toggleSidebar').setAttribute('aria-expanded', String(state.sidebarOpen));
    document.getElementById('toggleInspector').setAttribute('aria-expanded', String(state.inspectorOpen));
    app.dataset.sidebar = state.sidebarOpen ? 'open' : 'closed';
    app.dataset.inspector = state.inspectorOpen ? 'open' : 'closed';
    app.dataset.focus = state.focus ? 'on' : 'off';
    app.dataset.hasbook = state.book ? 'yes' : 'no';

    // 右侧工作室切换（素材卡片 ↔ ✨ AI 写心酱）
    const pane = state.inspectorPane === 'ai' ? 'ai' : 'cards';
    if (cardsPane) cardsPane.hidden = pane !== 'cards';
    if (aiPane) aiPane.hidden = pane !== 'ai';
    document.querySelectorAll('#inspectorModeTabs .seg-tab').forEach((tab) => {
      const on = tab.dataset.pane === pane;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', String(on));
    });
  };
  subscribe(syncLayout);
  syncLayout();

  document.getElementById('toggleSidebar').onclick = () => setState({ sidebarOpen: !state.sidebarOpen });
  document.getElementById('toggleInspector').onclick = () => setState({ inspectorOpen: !state.inspectorOpen });

  const modeTabs = document.getElementById('inspectorModeTabs');
  if (modeTabs) {
    modeTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-tab');
      if (!btn) return;
      setState({ inspectorPane: btn.dataset.pane, inspectorOpen: true });
      if (btn.dataset.pane === 'ai') renderAiHeader();
    });
  }

  // 左下功能面板可折叠
  const bottom = document.getElementById('sidebarBottom');
  const bottomBody = document.getElementById('bottomBody');
  const setBottomCollapsed = (collapsed) => {
    bottom.dataset.collapsed = collapsed ? 'true' : 'false';
    bottomBody.hidden = collapsed;
    try { localStorage.setItem('heartwrite-bottom-collapsed', collapsed ? '1' : '0'); } catch { /* ignore */ }
  };
  let bottomCollapsed = false;
  try { bottomCollapsed = localStorage.getItem('heartwrite-bottom-collapsed') === '1'; } catch { /* ignore */ }
  setBottomCollapsed(bottomCollapsed);
  document.getElementById('toggleBottom').onclick = () => {
    bottomCollapsed = !bottomCollapsed;
    setBottomCollapsed(bottomCollapsed);
  };

  document.getElementById('saveBtn').onclick = () => saveNow(false);
  document.getElementById('focusBtn').onclick = () => setState({ focus: !state.focus });
  document.getElementById('emptyStart').onclick = () => (state.book ? createChapter() : dialogs.openBookPicker());
  document.getElementById('emptyImport').onclick = () => (state.book ? dialogs.importTextDialog() : dialogs.openBookPicker());
  document.getElementById('quickSearch').onclick = () => dialogs.openSearch();
  document.getElementById('syncBtn').onclick = () => dialogs.openSyncCenter('lan');
  document.getElementById('openSettings').onclick = () => dialogs.openSettings();
  document.getElementById('exportBtn').onclick = () => dialogs.openExport();
  document.getElementById('historyBtn').onclick = () => dialogs.openHistory();
  document.getElementById('snapshotBtn').onclick = () => saveNow(true);
  document.getElementById('oneClickFormat').onclick = () => runOneClickFormat();
  document.getElementById('wordCountBox').onclick = () => dialogs.openStats();

  // 现代小说编辑器文档工具条快捷开关
  const persistToggle = async (field, label) => {
    const next = { ...state.settings, [field]: !state.settings[field] };
    setState({ settings: next });
    applyFonts();
    try {
      await api.saveSettings(next);
    } catch { /* ignore */ }
    if (label) toast(`${label}${next[field] ? '已开启' : '已关闭'}`, 'ok');
  };
  const synBtn = document.getElementById('toggleSynopsisBtn');
  if (synBtn) synBtn.onclick = () => persistToggle('showSynopsis', '章纲便签');
  const punctBtn = document.getElementById('togglePunctBtn');
  if (punctBtn) punctBtn.onclick = () => persistToggle('quickPunctBar', '快捷标点栏');
  const typeBtn = document.getElementById('toggleTypewriterBtn');
  if (typeBtn) typeBtn.onclick = () => persistToggle('typewriterMode', '打字机居中模式');
  const prevBtn = document.getElementById('togglePreviewBtn');
  if (prevBtn) prevBtn.onclick = () => togglePreviewMode();
  const aiQuick = document.getElementById('aiQuickBtn');
  if (aiQuick) aiQuick.onclick = () => openAiPane();
  const synAi = document.getElementById('synopsisAiBtn');
  if (synAi) synAi.onclick = () => runAiSkill('summarize');

  document.querySelector('.sidebar-bottom').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    handleBottomAction(chip.dataset.action, chip);
  });

  document.querySelectorAll('.status-right .status-chip').forEach((chip) => {
    if (chip.id === 'undoFormatBtn') {
      chip.onclick = () => undoFormat();
      return;
    }
    chip.onclick = () => handleBottomAction(chip.dataset.action, chip);
  });

  window.addEventListener('keydown', onGlobalKey);
  window.addEventListener('beforeunload', (event) => {
    if (!state.dirty && !state.saving) return;
    event.preventDefault();
    event.returnValue = '';
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.dirty) {
      void flushPendingSave();
    }
  });
  window.addEventListener('online', () => toast('网络已恢复（可使用 WebDAV 云同步与 AI 写心酱）', 'ok'));
  void confirmDialog;
  void closeModal;
  void promptDialog;
  void escapeHtml;
  void formatBytes;
  void chapters;
  void bookCharCount;
}

function handleBottomAction(action, chip) {
  switch (action) {
    case 'new-book': dialogs.openBookPicker(); break;
    case 'sync': dialogs.openSyncCenter('lan'); break;
    case 'ai': openAiPane(); break;
    case 'new-volume': createVolume(); break;
    case 'new-chapter': createChapter(); break;
    case 'search': dialogs.openSearch(); break;
    case 'replace': dialogs.toggleFindBar(true); break;
    case 'import': dialogs.importTextDialog(); break;
    case 'outline': dialogs.openOutline(); break;
    case 'trash': dialogs.openTrash(); break;
    case 'verify': dialogs.runVerify(); break;
    case 'focus': {
      setState({ focus: !state.focus });
      const how = isMobile() ? '点「更多 → 退出专注模式」，或按返回键' : 'F11 或 Esc';
      toast(state.focus ? `已进入专注模式（${how}退出）` : '已退出专注模式', 'ok');
      break;
    }
    case 'pomodoro': pomodoro.openPomodoroDialog(); break;
    case 'session': dialogs.openStats(); break;
    case 'help': dialogs.openHelp(); break;
    default: break;
  }
  if (chip) chip.blur();
}

async function runOneClickFormat() {
  if (!state.activeChapterId) return;
  await withEditorTransition(async () => {
    const view = editorEl();
    const before = view.value;
    if (!before.trim()) { toast('本章还没有内容', 'warn'); return false; }
    const report = await api.format(
      before,
      state.settings.oneClickFormatRule,
      document.getElementById('chapterTitleBig').value.trim(),
      false,
    );
    if (!report.changed) { toast('正文已经是规范格式', 'ok'); return true; }
    if (!await saveChapter({ manualSnapshot: true, silent: true, label: '一键排版前存档' })) return false;
    undoStack.push({ bookId: state.book.id, chapterId: state.activeChapterId, content: before, after: report.content });
    view.value = report.content;
    view.dispatchEvent(new Event('input', { bubbles: true }));
    if (!await saveChapter({ silent: true })) return false;
    await refreshBook();
    renderUndoButton();
    toast('排版完成', 'ok', '排版前已创建快照，可撤销本次排版。');
    return true;
  });
}

async function bindCloseGuard() {
  const win = window.__TAURI__?.window?.getCurrentWindow?.();
  if (!win || typeof win.onCloseRequested !== 'function') return;
  try {
    await win.onCloseRequested(async (event) => {
      if (window.__WRITER_CLOSING__) return;
      event.preventDefault();

      const finish = async (why) => {
        window.__WRITER_CLOSING__ = true;
        log(`[close] ${why}`);
        try { await api.uiLog(`[close] ${why}`); } catch { /* ignore */ }
        await win.destroy();
      };

      const busyDeadline = Date.now() + 15000;
      while (state.transitioning && Date.now() < busyDeadline) {
        await new Promise((r) => setTimeout(r, 120));
      }

      if (!state.dirty) return finish('没有未保存改动，直接关闭');

      const ok = await flushPendingSave();
      if (ok) return finish('保存完成，关闭窗口');

      const force = await confirmDialog(
        '无法保存，暂时不能关闭',
        '当前章节写不进磁盘（可能磁盘已满、文件被占用或数据文件损坏）。\n\n' +
          '· 选择「仍然关闭」会保留磁盘上已有的内容，但这次未保存的改动会丢失；\n' +
          '· 选择「取消」可以回到窗口，把正文复制到别处再处理。',
        { okText: '仍然关闭', danger: true },
      );
      if (force) await finish('用户选择放弃未保存改动并关闭');
      else toast('已取消关闭，正文仍在编辑器中', 'warn');
    });
  } catch (e) {
    log(`[close] 关闭守卫未启用：${(e && e.message) || e}`);
  }
}

// ------------------------------------------------------------------ 排版撤销

const undoStack = [];

export function renderUndoButton() {
  const btn = document.getElementById('undoFormatBtn');
  if (!btn) return;
  const top = undoStack[undoStack.length - 1];
  const available =
    top &&
    top.bookId === state.book?.id &&
    top.chapterId === state.activeChapterId &&
    editorValue() === top.after;
  btn.hidden = !available;
  btn.textContent = available ? '↺ 撤销排版' : '';
}

async function undoFormat() {
  const top = undoStack[undoStack.length - 1];
  if (!top || top.bookId !== state.book?.id || top.chapterId !== state.activeChapterId || editorValue() !== top.after) return;
  await withEditorTransition(async () => {
    undoStack.pop();
    const view = editorEl();
    view.value = top.content;
    view.dispatchEvent(new Event('input', { bubbles: true }));
    const saved = await saveChapter({ silent: true });
    renderUndoButton();
    if (!saved) return false;
    await refreshBook();
    toast('已撤销排版', 'ok');
    return true;
  });
}

async function onGlobalKey(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') {
    if (modalOpen()) { closeModal(); return; }
    if (state.focus) { setState({ focus: false }); return; }
    if (!document.getElementById('findBar').hidden) dialogs.toggleFindBar(false);
    return;
  }
  if (e.key === 'F9') { e.preventDefault(); setState({ sidebarOpen: !state.sidebarOpen }); return; }
  if (e.key === 'F10') { e.preventDefault(); setState({ inspectorOpen: !state.inspectorOpen }); return; }
  if (e.key === 'F11') { e.preventDefault(); setState({ focus: !state.focus }); return; }
  if (!ctrl) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) {
    const top = undoStack[undoStack.length - 1];
    if (
      !modalOpen() &&
      e.target === editorEl() &&
      top?.bookId === state.book?.id &&
      top?.chapterId === state.activeChapterId &&
      editorValue() === top.after
    ) {
      e.preventDefault();
      await undoFormat();
    }
    return;
  }
  if (key === 's' && e.shiftKey) { e.preventDefault(); await saveNow(true); return; }
  if (key === 's') { e.preventDefault(); await saveNow(false); return; }
  if (key === 'f' && e.shiftKey) { e.preventDefault(); await runOneClickFormat(); return; }
  if (key === 'a' && e.shiftKey) { e.preventDefault(); openAiPane(); return; }
  if (key === 'y' && e.shiftKey) { e.preventDefault(); dialogs.openSyncCenter('lan'); return; }
  if (key === 'p' && e.shiftKey) { e.preventDefault(); togglePreviewMode(); return; }
  if (key === 'e') { e.preventDefault(); dialogs.openExport(); return; }
  if (key === 'y') { e.preventDefault(); dialogs.openHistory(); return; }
  if (key === 'f') { e.preventDefault(); dialogs.openSearch(); return; }
  if (key === 'h') { e.preventDefault(); dialogs.toggleFindBar(true); document.getElementById('replaceInput').focus(); return; }
  if (key === 'p') { e.preventDefault(); pomodoro.toggle(); return; }
  if (key === 'n' && e.altKey) { e.preventDefault(); await createChapter(); return; }
  if (key === 'n') { e.preventDefault(); dialogs.openBookPicker(); return; }
  if (key === 'k') {
    e.preventDefault();
    const card = state.cards.find((c) => c.id === state.activeCardId);
    if (!card) { toast('请先在右侧选中一张卡片', 'warn'); return; }
    insertText(card.content || card.title);
    return;
  }
  if (key === 'd' && e.shiftKey) {
    e.preventDefault();
    await saveChapter({ manualSnapshot: true, silent: true, label: '手动标记' });
  }
}

function startSessionTimer() {
  setInterval(async () => {
    updateCounts();
    if (!state.book || !state.activeChapterId) return;
    if (Math.random() < 0.25) {
      try {
        const info = await api.storageInfo();
        setState({ storageBytes: info.bytes });
        const el = document.getElementById('storageLabel');
        if (el) el.textContent = `存储：${formatBytes(info.bytes)}`;
      } catch { /* ignore */ }
    }
  }, 5000);
}

subscribe((s) => {
  const renderDirectory = s.book !== tocBook || s.activeChapterId !== tocChapter || (tocSaving && !s.saving);
  tocBook = s.book;
  tocChapter = s.activeChapterId;
  tocSaving = s.saving;
  if (renderDirectory) renderToc();
  const app = document.getElementById('app');
  app.dataset.hasbook = s.book ? 'yes' : 'no';
  renderUndoButton();
  if (s.activeChapterId && s.activeChapterId !== lastSessionChapter) {
    lastSessionChapter = s.activeChapterId;
    setState({ sessionChars: 0, sessionStartAt: Date.now() });
    renderSessionChip();
    renderUndoButton();
  }
  const bookId = s.book?.id || '';
  if (bookId !== lastAiBookId) {
    lastAiBookId = bookId;
    void loadAiHistoryForBook(bookId);
  }
});

boot().catch((e) => {
  toast(`启动失败：${e.message}`, 'err');
  log(`boot FAILED: ${e && e.stack ? e.stack : e}`);
  console.error(e);
});
