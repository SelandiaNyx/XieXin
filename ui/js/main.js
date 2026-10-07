// 应用入口：初始化、快捷键、番茄钟、自动保存联动。

import { api, log } from './api.js';
import { state, setState, subscribe, findChapter, bookCharCount, chapters } from './store.js';
import { toast, confirmDialog, closeModal, modalOpen, hhmmss, formatBytes, escapeHtml, promptDialog } from './ui.js';
import { initSidebar, renderToc, refreshBook, createChapter, createVolume } from './sidebar.js';
import {
  initEditor, openChapter, saveChapter, saveNow, withEditorTransition, flushPendingSave, applyFonts, updateCounts, restartAutosave,
  updateTodayChars, countLocal, insertText, editorEl, focusEditor, editorValue, renderSessionChip,
} from './editor.js';
import { initCards, renderCards } from './cards.js';
import { initMobile } from './mobile.js';
import { isMobile } from './viewport.js';
import * as dialogs from './dialogs.js';
import * as pomodoro from './pomodoro.js';

let lastSessionChapter = '';
let tocBook = null;
let tocChapter = '';
let tocSaving = false;

/** 前端资源构建标记：改动 ui 后改这里，便于确认应用加载的是最新界面。 */
const UI_BUILD = 'ui-2026-09-28-studio';

window.__moge = {
  openChapter,
  saveNow,
  refreshBook,
  renderToc,
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
  initEditor();
  initCards();
  initMobile();
  dialogs.initFindBar();
  bindGlobalUi();
  await bindCloseGuard();
  // 必须在编辑器初始化之后：字号/行距等样式需要作用于已存在的 DOM
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
    // 兼容旧版本存过的状态值（done / locked 等），迁移到新状态集
    const aliases = { done: 'final', locked: 'final', published: 'published', drafting: 'draft' };
    Object.entries(aliases).forEach(([old, now]) => {
      if (byId[now]) byId[old] = { ...byId[now], id: old, label: byId[now].label };
    });
    setState({ chapterStatuses: list, statusById: byId });
    const sel = document.getElementById('statusSelect');
    const current = chapters().map((c) => c.status || 'draft');
    // 额外补上未知状态，避免历史章节显示空白
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

  // 全新安装：先让用户定下稿件存在哪里，再往下走（关掉不选也能继续，下次还会问）
  if (state.location?.needsChoice) {
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

  setState({ ready: true });
  startSessionTimer();
  pomodoro.initPomodoro();
  renderSessionChip();
  void dialogs.loadFonts().then(() => { /* 字体列表后台加载 */ });
  // 手机/平板上不要自动聚焦正文：一开屏就弹输入法会挡住界面
  if (!isMobile()) focusEditor();
  // 首屏稳定后再开启动效，避免启动瞬间抖一下
  requestAnimationFrame(() => {
    document.getElementById('app').classList.remove('no-anim');
  });
  log(
    `boot ok · 书架 ${state.registry.books.length} 本 · 当前《${state.book ? state.book.title : '无'}》·` +
      ` 卷 ${state.book ? state.book.volumes.length : 0} · 卡片 ${state.cards.length} · 字体 ${state.fonts.length}`,
  );
  // 便于核对"是否恢复到上次写的章节"（也是回归验收的观测点）
  log(
    `boot chapter · 已打开「${
      (findChapter(state.activeChapterId) || {}).title || '（无章节）'
    }」id=${state.activeChapterId || '-'}`,
  );
}

function bindGlobalUi() {
  const app = document.getElementById('app');
  const syncLayout = () => {
    app.dataset.busy = state.transitioning ? 'yes' : 'no';
    app.dataset.haschapter = state.activeChapterId ? 'yes' : 'no';
    document.getElementById('emptyTitle').textContent = state.book ? '为故事写下第一章' : '每一个故事，都从这里开始';
    document.getElementById('emptyStart').textContent = state.book ? '新建章节' : '创建作品';
    for (const id of ['saveBtn','oneClickFormat','snapshotBtn','historyBtn']) {
      document.getElementById(id).disabled = !state.activeChapterId || state.transitioning;
    }
    document.getElementById('focusBtn').setAttribute('aria-pressed', String(state.focus));
    document.getElementById('toggleSidebar').setAttribute('aria-expanded', String(state.sidebarOpen));
    document.getElementById('toggleInspector').setAttribute('aria-expanded', String(state.inspectorOpen));
    app.dataset.sidebar = state.sidebarOpen ? 'open' : 'closed';
    app.dataset.inspector = state.inspectorOpen ? 'open' : 'closed';
    app.dataset.focus = state.focus ? 'on' : 'off';
    app.dataset.hasbook = state.book ? 'yes' : 'no';
  };
  subscribe(syncLayout);
  syncLayout();

  document.getElementById('toggleSidebar').onclick = () => setState({ sidebarOpen: !state.sidebarOpen });
  document.getElementById('toggleInspector').onclick = () => setState({ inspectorOpen: !state.inspectorOpen });
  // 左下功能面板可折叠，状态记在本地
  const bottom = document.getElementById('sidebarBottom');
  const bottomBody = document.getElementById('bottomBody');
  const setBottomCollapsed = (collapsed) => {
    bottom.dataset.collapsed = collapsed ? 'true' : 'false';
    bottomBody.hidden = collapsed;
    try {
      localStorage.setItem('heartwrite-bottom-collapsed', collapsed ? '1' : '0');
    } catch { /* ignore */ }
  };
  let bottomCollapsed = false;
  try {
    bottomCollapsed = localStorage.getItem('heartwrite-bottom-collapsed') === '1';
  } catch { /* ignore */ }
  setBottomCollapsed(bottomCollapsed);
  document.getElementById('toggleBottom').onclick = () => {
    bottomCollapsed = !bottomCollapsed;
    setBottomCollapsed(bottomCollapsed);
  };
  document.getElementById('saveBtn').onclick = () => saveNow(false);
  document.getElementById('focusBtn').onclick = () => setState({ focus: !state.focus });
  document.getElementById('emptyStart').onclick = () => state.book ? createChapter() : dialogs.openBookPicker();
  document.getElementById('emptyImport').onclick = () => state.book ? dialogs.importTextDialog() : dialogs.openBookPicker();
  document.getElementById('quickSearch').onclick = () => dialogs.openSearch();
  document.getElementById('openSettings').onclick = () => dialogs.openSettings();
  document.getElementById('exportBtn').onclick = () => dialogs.openExport();
  document.getElementById('historyBtn').onclick = () => dialogs.openHistory();
  document.getElementById('snapshotBtn').onclick = () => saveNow(true);
  document.getElementById('oneClickFormat').onclick = () => runOneClickFormat();
  document.getElementById('wordCountBox').onclick = () => dialogs.openStats();

  document.querySelector('.sidebar-bottom').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    handleBottomAction(chip.dataset.action, chip);
  });
  // 状态栏里的按钮（撤销排版 / 大纲 / 搜索 / 番茄钟 / 本次字数）各自独立绑定，避免互相顶掉
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
  window.addEventListener('online', () => toast('网络已连接（写心完全离线运行）', 'ok'));
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
    case 'new-volume': createVolume(); break;
    case 'new-chapter': createChapter(); break;
    case 'search': dialogs.openSearch(); break;
    case 'replace': dialogs.toggleFindBar(true); break;
    case 'import': dialogs.importTextDialog(); break;
    case 'outline': dialogs.openOutline(); break;
    case 'trash': dialogs.openTrash(); break;
    case 'verify': dialogs.runVerify(); break;
    case 'focus': setState({ focus: !state.focus }); toast(state.focus ? '已进入专注模式（F11 或 Esc 退出）' : '已退出专注模式', 'ok'); break;
    case 'pomodoro': pomodoro.openPomodoroDialog(); break;
    case 'session': dialogs.openStats(); break;
    case 'help': dialogs.openHelp(); break;
    default: break;
  }
  if (chip) chip.blur();
}

/**
 * 一键排版：直接生效，不再弹确认框。
 * 排版前的内容会先存成一个历史版本，并放进撤销栈（Ctrl+Z / 状态栏「撤销排版」）。
 */
async function runOneClickFormat() {
  if (!state.activeChapterId) return;
  await withEditorTransition(async () => {
    const view = editorEl();
    const before = view.value;
    if (!before.trim()) { toast('本章还没有内容', 'warn'); return false; }
    const report = await api.format(before, state.settings.oneClickFormatRule,
      document.getElementById('chapterTitleBig').value.trim(), true);
    if (!report.changed) { toast('正文已经是规范格式', 'ok'); return true; }
    if (!await saveChapter({ manualSnapshot: true, silent: true, label: '一键排版前存档' })) return false;
    undoStack.push({ bookId: state.book.id, chapterId: state.activeChapterId, content: before, after: report.content });
    view.value = report.content;
    view.dispatchEvent(new Event('input', { bubbles: true }));
    if (!await saveChapter({ silent: true })) return false;
    await refreshBook(); renderUndoButton();
    toast('排版完成', 'ok', '排版前已创建快照，可撤销本次排版。');
    return true;
  });
}

// A normal close waits for the same save barrier as chapter navigation.
// Three outcomes, all reported: saved → close; a transition is running → wait for it
// and close; save failed → tell the user how to get out instead of refusing forever.
async function bindCloseGuard() {
  const win = window.__TAURI__?.window?.getCurrentWindow?.();
  if (!win) return;
  await win.onCloseRequested(async event => {
    if (window.__WRITER_CLOSING__) return; // 已经在关，放行
    event.preventDefault();

    const finish = async (why) => {
      window.__WRITER_CLOSING__ = true;
      log(`[close] ${why}`);
      try {
        await api.uiLog(`[close] ${why}`);
      } catch { /* 记不上也要能关 */ }
      await win.destroy();
    };

    // 正在切章/回滚/导入：等它结束再走同一套保存流程，而不是把这次关闭吞掉
    const busyDeadline = Date.now() + 15000;
    while (state.transitioning && Date.now() < busyDeadline) {
      await new Promise(r => setTimeout(r, 120));
    }

    if (!state.dirty) return finish('没有未保存改动，直接关闭');

    const ok = await flushPendingSave();
    if (ok) return finish('保存完成，关闭窗口');

    // 保存失败：给出选择，不能把用户困在窗口里
    const force = await confirmDialog(
      '无法保存，暂时不能关闭',
      '当前章节写不进磁盘（可能磁盘已满、文件被占用或数据文件损坏）。\n\n' +
        '· 选择「仍然关闭」会保留磁盘上已有的内容，但这次未保存的改动会丢失；\n' +
        '· 选择「取消」可以回到窗口，把正文复制到别处再处理。',
      { okText: '仍然关闭', danger: true },
    );
    if (force) {
      await finish('用户选择放弃未保存改动并关闭');
    } else {
      toast('已取消关闭，正文仍在编辑器中', 'warn');
    }
  });
}

// ------------------------------------------------------------------ 排版撤销

const undoStack = [];

export function renderUndoButton() {
  const btn = document.getElementById('undoFormatBtn');
  if (!btn) return;
  const top = undoStack[undoStack.length - 1];
  const available = top && top.bookId === state.book?.id && top.chapterId === state.activeChapterId && editorValue() === top.after;
  btn.hidden = !available;
  btn.textContent = available ? '↺ 撤销排版' : '';
}

async function undoFormat() {
  const top = undoStack[undoStack.length - 1];
  if (!top || top.bookId !== state.book?.id || top.chapterId !== state.activeChapterId || editorValue() !== top.after) return;
  await withEditorTransition(async () => {
    undoStack.pop();
    const view = editorEl(); view.value = top.content;
    view.dispatchEvent(new Event('input', { bubbles: true }));
    const saved = await saveChapter({ silent: true });
    renderUndoButton();
    if (!saved) return false;
    await refreshBook(); toast('已撤销排版', 'ok'); return true;
  });
}

function ruleLabel(rule) {
  return { 'cjk-indent': '中文缩进', 'blank-line': '网文风格', 'tidy-only': '仅整理空格' }[rule] || rule;
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
    if (!modalOpen() && e.target === editorEl() && top?.bookId === state.book?.id && top?.chapterId === state.activeChapterId && editorValue() === top.after) { e.preventDefault(); await undoFormat(); }
    return;
  }
  if (key === 's' && e.shiftKey) { e.preventDefault(); await saveNow(true); return; }
  if (key === 's') { e.preventDefault(); await saveNow(false); return; }
  if (key === 'f' && e.shiftKey) { e.preventDefault(); await runOneClickFormat(); return; }
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

// ------------------------------------------------------------------ 会话与今日字数

function startSessionTimer() {
  setInterval(async () => {
    updateCounts();
    if (!state.book || !state.activeChapterId) return;
    // 顺便刷新存储占用（低频）
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

// ------------------------------------------------------------------ 番茄钟面板（实现见 pomodoro.js）

subscribe((s) => {
  const renderDirectory = s.book !== tocBook || s.activeChapterId !== tocChapter || (tocSaving && !s.saving);
  tocBook = s.book; tocChapter = s.activeChapterId; tocSaving = s.saving;
  if (renderDirectory) renderToc();
  const app = document.getElementById('app');
  app.dataset.hasbook = s.book ? 'yes' : 'no';
  renderUndoButton();
  // 切换章节时重置"本次"统计基线，并刷新撤销按钮可用状态
  if (s.activeChapterId && s.activeChapterId !== lastSessionChapter) {
    lastSessionChapter = s.activeChapterId;
    setState({ sessionChars: 0 });
    renderSessionChip();
    renderUndoButton();
  }
});

boot().catch((e) => {
  toast(`启动失败：${e.message}`, 'err');
  log(`boot FAILED: ${e && e.stack ? e.stack : e}`);
  // eslint-disable-next-line no-console
  console.error(e);
});
