// 手机端交互：抽屉遮罩、MD3 底部导航、触屏行内操作面板、移动端「更多」菜单与 Android 返回键。

import { state, setState, subscribe } from './store.js';
import { isNarrow, isTouch, onViewportChange } from './viewport.js';
import { moveChapterDialog } from './sidebar.js';
import { flushPendingSave } from './editor.js';
import { closeModal } from './ui.js';
import { log } from './api.js';

let scrim = null;
let sheet = null;

const ACTION_LABEL = {
  'add-chapter-here': '在此卷新增章节',
  'rename-volume': '重命名本卷',
  'move-volume-up': '上移本卷',
  'move-volume-down': '下移本卷',
  'delete-volume': '删除本卷',
  'move-chapter-up': '上移',
  'move-chapter-down': '下移',
  'rename-chapter': '重命名',
  'delete-chapter': '删除章节',
};

export function initMobile() {
  buildScrim();
  buildSheet();
  bindMoreButton();
  bindBottomNav();
  bindDelegates();
  bindEscape();
  bindModalGuard();
  // 手机上先看正文：左右两栏默认收起（桌面端默认仍然是展开的）
  if (isNarrow()) setState({ sidebarOpen: false, inspectorOpen: false });
  prevSidebar = state.sidebarOpen;
  prevInspector = state.inspectorOpen;
  subscribe(onStateChange);
  syncScrim();
  syncBottomNav();
  onViewportChange(() => setState({}));
  void initBackButton();
}

let prevSidebar = state.sidebarOpen;
let prevInspector = state.inspectorOpen;

/** 窄屏上两个抽屉不能同时开着：保留刚打开的那个，收起另一个。 */
function onStateChange(s) {
  if (isNarrow() && s.sidebarOpen && s.inspectorOpen) {
    const sidebarJustOpened = s.sidebarOpen !== prevSidebar;
    prevSidebar = s.sidebarOpen;
    prevInspector = s.inspectorOpen;
    setState(sidebarJustOpened ? { inspectorOpen: false } : { sidebarOpen: false });
    return;
  }
  prevSidebar = s.sidebarOpen;
  prevInspector = s.inspectorOpen;
  syncScrim();
  syncBottomNav();
}

// ------------------------------------------------------------------ 底部导航（MD3）

function bindBottomNav() {
  const nav = document.getElementById('mobileNav');
  if (!nav) return;
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mnav]');
    if (!btn) return;
    const dest = btn.dataset.mnav;
    switch (dest) {
      case 'toc':
        setState({ sidebarOpen: !state.sidebarOpen, inspectorOpen: false });
        break;
      case 'write':
        setState({ sidebarOpen: false, inspectorOpen: false });
        break;
      case 'ai':
        setState({ sidebarOpen: false, inspectorOpen: true, inspectorPane: 'ai' });
        break;
      case 'cards':
        setState({ sidebarOpen: false, inspectorOpen: true, inspectorPane: 'cards' });
        break;
      case 'sync':
        closePanels();
        clickId('syncBtn');
        break;
      default:
        break;
    }
  });
}

function syncBottomNav() {
  const nav = document.getElementById('mobileNav');
  if (!nav) return;
  let active = 'write';
  if (state.sidebarOpen) active = 'toc';
  else if (state.inspectorOpen) active = state.inspectorPane === 'ai' ? 'ai' : 'cards';
  nav.querySelectorAll('[data-mnav]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mnav === active);
  });
}

// ------------------------------------------------------------------ 遮罩

function buildScrim() {
  scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.addEventListener('click', closePanels);
  document.getElementById('app').appendChild(scrim);
}

function syncScrim() {
  if (!scrim) return;
  const open = isNarrow() && (state.sidebarOpen || state.inspectorOpen) && !state.focus && !isModalOpen();
  scrim.classList.toggle('show', Boolean(open));
}

export function closePanels() {
  if (!state.sidebarOpen && !state.inspectorOpen) return;
  setState({ sidebarOpen: false, inspectorOpen: false });
}

function isModalOpen() {
  const overlay = document.getElementById('overlay');
  return Boolean(overlay && !overlay.hidden);
}

function bindModalGuard() {
  const overlay = document.getElementById('overlay');
  if (!overlay || typeof MutationObserver === 'undefined') return;
  new MutationObserver(() => {
    if (isNarrow() && isModalOpen()) closePanels();
    syncScrim();
  }).observe(overlay, { attributes: true, attributeFilter: ['hidden', 'style', 'class'] });
}

// ------------------------------------------------------------------ 底部面板

function buildSheet() {
  sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.id = 'sheet';
  sheet.hidden = true;
  sheet.innerHTML =
    '<div class="sheet-backdrop"></div>' +
    '<div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">' +
    '<div class="sheet-grip"></div><div class="sheet-title" id="sheetTitle"></div>' +
    '<div class="sheet-list" id="sheetList"></div></div>';
  document.body.appendChild(sheet);
  sheet.querySelector('.sheet-backdrop').addEventListener('click', closeSheet);
}

export function sheetOpen() {
  return Boolean(sheet && !sheet.hidden);
}

export function openSheet(title, items) {
  if (!sheet) return;
  document.getElementById('sheetTitle').textContent = title;
  const list = document.getElementById('sheetList');
  list.innerHTML = '';
  items.forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `sheet-item${item.danger ? ' danger' : ''}`;
    btn.textContent = item.label;
    btn.disabled = Boolean(item.disabled);
    if (!item.disabled) {
      btn.onclick = () => {
        closeSheet();
        item.run();
      };
    }
    list.appendChild(btn);
  });
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add('open'));
}

export function closeSheet() {
  if (!sheet || sheet.hidden) return;
  sheet.classList.remove('open');
  const box = sheet;
  setTimeout(() => {
    box.hidden = true;
    document.getElementById('sheetList').innerHTML = '';
  }, 200);
}

function openRowActions(row) {
  if (!row) return;
  const isVolume = row.classList.contains('volume-row');
  const title = row.querySelector('.volume-title, .chapter-title');
  const name = (title && title.textContent.trim()) || (isVolume ? '本卷' : '本章');
  const buttons = Array.from(row.querySelectorAll('.volume-actions .tiny-btn, .chapter-actions .tiny-btn'));
  if (!buttons.length) return;
  const items = buttons.map((btn) => ({
    label: ACTION_LABEL[btn.dataset.action] || btn.title || btn.textContent.trim(),
    danger: String(btn.dataset.action || '').startsWith('delete'),
    disabled: btn.disabled,
    run: () => btn.click(),
  }));
  if (!isVolume) {
    const at = items.findIndex((item) => item.danger);
    items.splice(at < 0 ? items.length : at, 0, {
      label: '移动到其他卷…',
      run: () => moveChapterDialog(row.dataset.id),
    });
  }
  openSheet(name, items);
}

// ------------------------------------------------------------------ 顶栏「更多」

function clickId(id) {
  const el = document.getElementById(id);
  if (el) el.click();
}

function clickChip(action) {
  const chip = document.querySelector(`.sidebar-bottom .chip[data-action="${action}"]`);
  if (chip) chip.click();
}

function bindMoreButton() {
  const btn = document.getElementById('mobileMore');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (sheetOpen()) { closeSheet(); return; }
    closePanels();
    openSheet('更多操作', [
      { label: '跨端同步（局域网 / WebDAV）', run: () => clickId('syncBtn') },
      { label: '✨ 写心酱 AI 助手', run: () => setState({ inspectorOpen: true, sidebarOpen: false, inspectorPane: 'ai' }) },
      { label: '全文搜索', run: () => clickId('quickSearch') },
      { label: '创建快照', run: () => clickId('snapshotBtn') },
      { label: '历史版本', run: () => clickId('historyBtn') },
      { label: '导出电子书 / 备份…', run: () => clickId('exportBtn') },
      { label: '素材卡片', run: () => setState({ inspectorOpen: true, sidebarOpen: false, inspectorPane: 'cards' }) },
      { label: '章节大纲', run: () => clickChip('outline') },
      { label: '番茄钟', run: () => clickChip('pomodoro') },
      { label: state.previewMode ? '退出阅读预览' : '阅读预览', run: () => clickId('togglePreviewBtn') },
      { label: state.focus ? '退出专注模式' : '专注模式', run: () => clickId('focusBtn') },
      { label: '外观、AI 与偏好设置', run: () => clickId('openSettings') },
      { label: '快捷键与说明', run: () => clickChip('help') },
    ]);
  });
}

// ------------------------------------------------------------------ 事件

function bindDelegates() {
  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const more = target.closest('[data-action="mobile-more"]');
    if (more) {
      e.preventDefault();
      openRowActions(more.closest('.chapter-row, .volume-row'));
      return;
    }
    if (isNarrow() && target.closest('.chapter-row') && !target.closest('.tiny-btn')) closePanels();
  }, true);

  document.addEventListener('dragstart', (e) => {
    if (isTouch()) e.preventDefault();
  }, true);
}

function bindEscape() {
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (sheetOpen()) {
      e.stopPropagation();
      closeSheet();
      return;
    }
    if (isNarrow() && !isModalOpen() && (state.sidebarOpen || state.inspectorOpen)) {
      e.stopPropagation();
      closePanels();
    }
  }, true);
}

// ------------------------------------------------------------------ Android 返回键

function consumeBack() {
  if (sheetOpen()) { closeSheet(); return true; }
  if (isModalOpen()) { closeModal(); return true; }
  if (isNarrow() && (state.sidebarOpen || state.inspectorOpen)) { closePanels(); return true; }
  if (state.focus) { setState({ focus: false }); return true; }
  const findBar = document.getElementById('findBar');
  if (findBar && !findBar.hidden) { clickId('closeFind'); return true; }
  const win = window.__TAURI__?.window?.getCurrentWindow?.();
  if (win && typeof win.close === 'function') {
    if (state.dirty || state.saving) {
      flushPendingSave().finally(() => win.close());
    } else {
      win.close();
    }
    return true;
  }
  return false;
}

async function initBackButton() {
  const tauri = window.__TAURI__;
  if (!/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return;
  if (!tauri?.core || typeof tauri.core.addPluginListener !== 'function') return;
  try {
    await tauri.core.addPluginListener('app', 'back-button', consumeBack);
    log('[back] 返回键监听已就绪');
  } catch (e) {
    log(`[back] 返回键监听未启用：${(e && e.message) || e}`);
  }
}
