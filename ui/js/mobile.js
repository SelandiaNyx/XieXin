// 手机端交互：抽屉遮罩、触屏行内操作面板、移动端「更多」菜单。
//
// 布局本身全部交给 mobile.css（只靠 data-sidebar / data-inspector 这两个属性驱动），
// 这里只补三件 CSS 做不到的事：
//   1. 点遮罩、点章节、开弹层时把抽屉收起来；
//   2. 触屏没有悬停，用行内「⋮」把上移 / 重命名 / 移动到其他卷 / 删除这些动作弹成底部面板；
//   3. 顶栏「更多」菜单（窄屏放不下的搜索、快照、历史、导出、设置等）。

import { state, setState, subscribe } from './store.js';
import { isNarrow, isTouch, onViewportChange } from './viewport.js';
import { moveChapterDialog } from './sidebar.js';
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
  bindDelegates();
  bindEscape();
  bindModalGuard();
  // 手机上先看正文：左右两栏默认收起（桌面端默认仍然是展开的）
  if (isNarrow()) setState({ sidebarOpen: false, inspectorOpen: false });
  prevSidebar = state.sidebarOpen;
  prevInspector = state.inspectorOpen;
  subscribe(onStateChange);
  syncScrim();
  // 视口在桌面/手机之间来回切换时（旋转、分屏、折叠屏），遮罩跟着重算
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
}

// ------------------------------------------------------------------ 遮罩

function buildScrim() {
  scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.addEventListener('click', closePanels);
  document.getElementById('app').appendChild(scrim);
}

/** 抽屉开着的时候显示遮罩；弹层自己带背景，不叠加。 */
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

/** 打开弹层时先把抽屉收起来，避免"弹层下面还压着一个抽屉"。
 *  只在窄屏这么做：桌面端的左右两栏是常驻列，开个弹层就被收掉会很突兀。 */
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

/** 目录/卷行上的「⋮」：把该行隐藏的动作按钮弹成面板（点面板 = 点原按钮）。
 *  触屏拖不了章节，所以额外给章节加一条「移动到其他卷…」。 */
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
    // 放在删除之前：破坏性操作永远排最后
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
    openSheet('更多', [
      { label: '全文搜索', run: () => clickId('quickSearch') },
      { label: '创建快照', run: () => clickId('snapshotBtn') },
      { label: '历史版本', run: () => clickId('historyBtn') },
      { label: '导出…', run: () => clickId('exportBtn') },
      { label: '素材卡片', run: () => clickId('toggleInspector') },
      { label: '章节大纲', run: () => clickChip('outline') },
      { label: '番茄钟', run: () => clickChip('pomodoro') },
      { label: '专注模式', run: () => clickId('focusBtn') },
      { label: '外观与偏好', run: () => clickId('openSettings') },
      { label: '快捷键说明', run: () => clickChip('help') },
    ]);
  });
}

// ------------------------------------------------------------------ 事件

function bindDelegates() {
  // 捕获阶段：先于 sidebar.js 的目录点击处理，保证抽屉在切章动画前就开始收起
  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const more = target.closest('[data-action="mobile-more"]');
    if (more) {
      e.preventDefault();
      openRowActions(more.closest('.chapter-row, .volume-row'));
      return;
    }
    // 抽屉模式下点章节 = 选好就收起抽屉，把屏幕让给正文；
    // 平板那种"侧栏本来就是常驻列"的布局不动它，否则一点章节目录就没了
    if (isNarrow() && target.closest('.chapter-row') && !target.closest('.tiny-btn')) closePanels();
  }, true);

  // 触屏没有悬停，桌面端那套 HTML5 拖拽在手机上只会添乱（sidebar.js 会按 isTouch 关掉 draggable）
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

/**
 * 返回键的分层消费顺序（从最上层开始）：
 * 底部面板 → 弹层 → 抽屉 → 专注模式 → 查找条 → 都没有时关窗口。
 * 最后一档用 close()，走的是应用原有的保存守卫（等保存成功再关），不会丢稿。
 *
 * @returns {boolean} 是否消费掉了这次返回
 */
function consumeBack() {
  if (sheetOpen()) { closeSheet(); return true; }
  if (isModalOpen()) { closeModal(); return true; }
  if (isNarrow() && (state.sidebarOpen || state.inspectorOpen)) { closePanels(); return true; }
  if (state.focus) { setState({ focus: false }); return true; }
  const findBar = document.getElementById('findBar');
  if (findBar && !findBar.hidden) { clickId('closeFind'); return true; }
  const win = window.__TAURI__?.window?.getCurrentWindow?.();
  if (win && typeof win.close === 'function') { win.close(); return true; }
  return false;
}

/**
 * 接 Android/iOS 的硬件返回键。
 *
 * 插件把返回键一律转成事件（系统默认的"退出应用"被它吞掉了），所以最后一档
 * 必须自己关窗口，否则用户按返回键会"没反应"。
 * 桌面端、或装了旧包（没有这个插件）时静默跳过，行为保持系统默认。
 */
async function initBackButton() {
  const tauri = window.__TAURI__;
  if (!/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return;
  if (!tauri?.core?.invoke || typeof tauri.core.addPluginListener !== 'function') return;
  try {
    await tauri.core.invoke('plugin:mobile-onbackpressed-listener|register_back_event');
    await tauri.core.addPluginListener('mobile-onbackpressed-listener', 'mobile-onbackpressed-goback', consumeBack);
    log('[back] 返回键监听已就绪');
  } catch (e) {
    log(`[back] 返回键监听未启用：${(e && e.message) || e}`);
  }
}
