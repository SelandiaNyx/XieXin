// 中间编辑区：正文编辑、自动保存、字数统计、状态栏时钟、查找替换。

import { api } from './api.js';
import { state, setState, emit, findChapter, bookCharCount, bookChapterCount, statusInfo } from './store.js';
import { toast, formatTime, animateNumber, withViewTransition } from './ui.js';

const els = {};
let autosaveTimer = null;
let clockTimer = null;
let lastSavedContent = '';
let savePromise = null;
let applyingRemote = false;

export function initEditor(hooks = {}) {
  els.view = document.getElementById('editor');
  els.titleTop = document.getElementById('chapterTitleInput');
  els.titleBig = document.getElementById('chapterTitleBig');
  els.statusSelect = document.getElementById('statusSelect');
  els.crumbVolume = document.getElementById('crumbVolume');
  els.saveState = document.getElementById('saveState');
  els.versionInfo = document.getElementById('versionInfo');
  els.cursorInfo = document.getElementById('cursorInfo');
  els.selectionInfo = document.getElementById('selectionInfo');
  els.wcTotal = document.getElementById('wcTotal');
  els.wcChapter = document.getElementById('wcChapter');
  els.wcToday = document.getElementById('wcToday');
  els.clock = document.getElementById('clock');
  els.app = document.getElementById('app');
  els.page = document.getElementById('editorPage');

  els.view.addEventListener('input', onInput);
  els.view.addEventListener('keydown', onKeyDown);
  els.view.addEventListener('click', updateCursorInfo);
  els.view.addEventListener('keyup', updateCursorInfo);
  els.view.addEventListener('select', updateCursorInfo);
  els.view.addEventListener('scroll', () => autoGrow());

  const syncTitles = () => {
    const v = els.titleBig.value;
    els.titleTop.value = v;
    markDirty();
  };
  els.titleBig.addEventListener('input', syncTitles);
  els.titleTop.addEventListener('input', () => {
    els.titleBig.value = els.titleTop.value;
    markDirty();
  });
  els.titleBig.addEventListener('blur', () => persistChapterTitle());
  els.titleTop.addEventListener('blur', () => persistChapterTitle());

  els.statusSelect.addEventListener('change', async () => {
    const status = els.statusSelect.value;
    const ch = findChapter(state.activeChapterId);
    if (ch) ch.status = status;
    markDirty();
    await persistChapterTitle(true);
    const info = statusInfo(status);
    els.statusSelect.classList.remove('pulse');
    void els.statusSelect.offsetWidth; // 重启动画
    els.statusSelect.classList.add('pulse');
    applyStatusStyle();
    toast(`章节状态：${info.label}`, 'ok', info.hint || '');
    emit();
    const { renderToc } = await import('./sidebar.js');
    renderToc();
  });

  document.getElementById('saveState').addEventListener('click', () => window.__moge.saveNow(true));

  startClock();
  startAutosave();
  void hooks;
}

async function persistChapterTitle(immediate = false) {
  if (!state.book || !state.activeChapterId) return;
  const ch = findChapter(state.activeChapterId);
  if (!ch) return;
  const title = els.titleBig.value.trim();
  if (title === ch.title && !state.dirty) return;
  if (immediate) await saveChapter({ manualSnapshot: false });
  else markDirty();
}

// ------------------------------------------------------------------ 打开

export async function openChapter(chapterId) {
  if (!chapterId) return;
  if (state.book && chapterId === state.activeChapterId && !state.dirty) return;
  if (state.dirty && state.activeChapterId) await saveChapter({ silent: true });
  try {
    const res = await api.readChapter(state.book.id, chapterId);
    const ch = findChapter(chapterId);
    const vol = state.book.volumes.find((v) => v.chapters.some((c) => c.id === chapterId));
    const versions = await api.listVersions(state.book.id, chapterId);
    const isSwitch = Boolean(state.activeChapterId) && state.activeChapterId !== chapterId;

    // 正文与标题的替换放进 View Transition，切章时有系统级淡入淡出
    const applyChapter = () => {
      applyingRemote = true;
      els.view.value = res.content;
      autoGrow();
      applyingRemote = false;
      els.titleBig.value = ch ? ch.title : '';
      els.titleTop.value = ch ? ch.title : '';
      els.statusSelect.value = (ch && ch.status) || 'draft';
      // 历史数据里的未知状态：临时补一个选项，保证下拉框有显示
      if (els.statusSelect.value !== ((ch && ch.status) || 'draft')) {
        const opt = document.createElement('option');
        opt.value = (ch && ch.status) || 'draft';
        opt.textContent = `${opt.value}（旧）`;
        els.statusSelect.appendChild(opt);
        els.statusSelect.value = opt.value;
      }
      els.crumbVolume.textContent = vol ? vol.title : '-';
      if (isSwitch) {
        els.page.classList.remove('paper-enter');
        void els.page.offsetWidth;
        els.page.classList.add('paper-enter');
      }
    };
    if (isSwitch) withViewTransition(applyChapter);
    else applyChapter();

    lastSavedContent = res.content;
    setState({
      activeChapterId: chapterId,
      activeVolumeId: vol ? vol.id : state.activeVolumeId,
      content: res.content,
      versions,
      dirty: false,
      saveState: '已保存',
      lastSavedAt: res.createdAt || Date.now(),
    });
    markSaveState('ok', '已保存');
    updateCounts();
    updateCursorInfo();
    updateVersionInfo(versions.length);
    applyStatusStyle();
    return true;
  } catch (e) {
    toast(`打开章节失败：${e.message}`, 'err');
    return false;
  }
}

// ------------------------------------------------------------------ 编辑

/** 用当前状态的颜色给状态下拉框着色，切换后有明显反馈。 */
export function applyStatusStyle() {
  if (!els.statusSelect) return;
  const info = statusInfo(els.statusSelect.value);
  els.statusSelect.style.color = info.color;
  els.statusSelect.style.fontWeight = '600';
  els.statusSelect.title = `章节状态：${info.label}${info.hint ? '（' + info.hint + '）' : ''}`;
}

function onInput(e) {
  if (applyingRemote) return;
  autoGrow();
  const before = state.content || '';
  const text = els.view.value;
  if (text !== before) {
    const delta = countLocal(text) - countLocal(before);
    if (delta > 0) addSessionChars(delta);
  }
  setState({ content: text });
  markDirty();
  updateCounts();
  updateCursorInfo();
}

function onKeyDown(e) {
  // Tab 缩进
  if (e.key === 'Tab') {
    e.preventDefault();
    insertText('\u3000\u3000');
    return;
  }
  // 引号/括号配对
  const pairs = { '"': '“”', "'": '‘’', '（': '）', '(': '）', '「': '」', '《': '》', '【': '】' };
  if (e.key === '"' || e.key === "'") {
    e.preventDefault();
    const sel = els.view.value.slice(els.view.selectionStart, els.view.selectionEnd);
    if (sel) insertText(`“${sel}”`);
    else insertText('“”', 1);
    return;
  }
  if (pairs[e.key] && e.key !== '"' && e.key !== "'") {
    e.preventDefault();
    insertText(pairs[e.key][0] + pairs[e.key][1], 1);
    return;
  }
  if (e.key === 'Enter') {
    // 自动延续缩进
    const pos = els.view.selectionStart;
    const lineStart = els.view.value.lastIndexOf('\n', pos - 1) + 1;
    const line = els.view.value.slice(lineStart, pos);
    const m = line.match(/^[\u3000\s]*/);
    if (m && m[0].length > 0) {
      e.preventDefault();
      insertText(`\n${m[0]}`);
    }
  }
}

export function insertText(text, caretOffset = null) {
  const view = els.view;
  view.focus();
  const start = view.selectionStart;
  const end = view.selectionEnd;
  const ok = document.execCommand && document.execCommand('insertText', false, text);
  if (!ok) {
    view.setRangeText(text, start, end, 'end');
    view.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (caretOffset != null) {
    const pos = view.selectionStart - text.length + caretOffset;
    view.setSelectionRange(pos, pos);
  }
  autoGrow();
  updateCursorInfo();
}

function autoGrow() {
  const view = els.view;
  view.style.height = 'auto';
  const h = Math.max(view.scrollHeight, window.innerHeight * 0.5);
  view.style.height = `${h}px`;
}

export function markDirty() {
  setState({ dirty: true, saveState: '有未保存修改' });
  markSaveState('dirty', '未保存');
}

function markSaveState(kind, text) {
  els.saveState.className = `save-state ${kind}`;
  els.saveState.textContent = text;
}

function startAutosave() {
  clearInterval(autosaveTimer);
  const secs = Math.max(5, Number(state.settings.autosaveSecs) || 20);
  autosaveTimer = setInterval(() => {
    if (state.dirty && state.activeChapterId && !state.saving) saveChapter({ silent: true });
  }, secs * 1000);
}

export function restartAutosave() {
  startAutosave();
}

function startClock() {
  const tick = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    els.clock.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  tick();
  clearInterval(clockTimer);
  clockTimer = setInterval(tick, 1000);
}

// ------------------------------------------------------------------ 保存

export async function saveChapter({ manualSnapshot = false, silent = false, label = '' } = {}) {
  if (!state.book || !state.activeChapterId) return null;
  if (savePromise) await savePromise.catch(() => {});
  const payload = {
    bookId: state.book.id,
    chapterId: state.activeChapterId,
    content: els.view.value,
    title: els.titleBig.value.trim() || findChapter(state.activeChapterId)?.title || '',
    summary: findChapter(state.activeChapterId)?.summary || '',
    status: els.statusSelect.value,
    manualSnapshot,
    snapshotLabel: label,
  };
  state.saving = true;
  markSaveState('dirty', '保存中…');
  savePromise = api.saveChapter(payload);
  try {
    const res = await savePromise;
    lastSavedContent = payload.content;
    setState({ dirty: false, saving: false, content: payload.content, lastSavedAt: res.updatedAt });
    markSaveState('ok', `已保存 ${formatTime(res.updatedAt).slice(11)}`);
    updateVersionInfo(res.versions);
    const ch = findChapter(state.activeChapterId);
    if (ch) {
      ch.charCount = res.charCount;
      ch.versions = res.versions;
      ch.title = payload.title;
      ch.updatedAt = res.updatedAt;
    }
    updateCounts();
    if (manualSnapshot) {
      toast(`已保存并创建快照（${res.versions} 个版本）`, 'ok', `本章 ${res.charCount} 字`);
      setState({ versions: await api.listVersions(state.book.id, state.activeChapterId) });
    } else if (!silent) {
      toast(`已保存 ${res.charCount} 字`, 'ok');
    }
    emit();
    return res;
  } catch (e) {
    setState({ saving: false });
    markSaveState('err', '保存失败');
    toast(`保存失败：${e.message}`, 'err');
    return null;
  } finally {
    savePromise = null;
  }
}

export async function saveNow(manual = false) {
  const res = await saveChapter({ manualSnapshot: manual });
  if (res) {
    const { refreshBook } = await import('./sidebar.js');
    await refreshBook();
  }
  return res;
}

// ------------------------------------------------------------------ 显示

export function updateCounts() {
  const content = els.view.value;
  const chapterChars = countLocal(content);
  const bookChars = bookCharCount();
  const todayKey = 'heartwrite-today';
  const today = new Date().toDateString();
  let todayData = { date: today, chars: 0 };
  try {
    const raw = localStorage.getItem(todayKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.date === today) todayData = parsed;
    }
  } catch { /* ignore */ }
  // 数字滚动，让字数变化有"在跳"的观感
  animateNumber(els.wcChapter, chapterChars);
  animateNumber(
    els.wcTotal,
    bookChars + (chapterChars - (findChapter(state.activeChapterId)?.charCount || 0)),
  );
  animateNumber(els.wcToday, todayData.chars || 0);
  renderSessionChip();
}

/** 状态栏「本次 X 字」：记录本次打开应用后新增的字数。 */
export function renderSessionChip() {
  const chip = document.querySelector('.status-chip[data-action="session"]');
  if (chip) chip.textContent = `本次 ${state.sessionChars.toLocaleString()} 字`;
}

export function addSessionChars(delta) {
  if (!delta) return;
  setState({ sessionChars: Math.max(0, state.sessionChars + delta) });
  renderSessionChip();
}

export function updateTodayChars(chars) {
  const today = new Date().toDateString();
  const key = 'heartwrite-today';
  let data = { date: today, chars: 0 };
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.date === today) data = parsed;
    }
  } catch { /* ignore */ }
  data.date = today;
  data.chars = (data.chars || 0) + chars;
  localStorage.setItem(key, JSON.stringify(data));
  els.wcToday.textContent = data.chars.toLocaleString();
}

export function todayChars() {
  try {
    const raw = localStorage.getItem('heartwrite-today');
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    return parsed.date === new Date().toDateString() ? parsed.chars || 0 : 0;
  } catch {
    return 0;
  }
}

/** 与 Rust 端一致的字数算法（本地即时反馈用）。 */
export function countLocal(text) {
  let total = 0;
  let inWord = false;
  let inDigit = false;
  const isCjk = (ch) => {
    const c = ch.codePointAt(0);
    return (
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0x3040 && c <= 0x30ff) ||
      (c >= 0xac00 && c <= 0xd7af) ||
      (c >= 0x20000 && c <= 0x2fa1f)
    );
  };
  for (const ch of text) {
    if (isCjk(ch)) {
      if (inWord) { total += 1; inWord = false; }
      if (inDigit) { total += 1; inDigit = false; }
      total += 1;
    } else if (/[A-Za-z]/.test(ch)) {
      if (inDigit) { total += 1; inDigit = false; }
      if (!inWord) { total += 1; inWord = true; }
    } else if (/[0-9]/.test(ch)) {
      if (inWord) { total += 1; inWord = false; }
      if (!inDigit) { total += 1; inDigit = true; }
    } else if (/[\p{L}\p{N}]/u.test(ch)) {
      if (!inWord) { total += 1; inWord = true; }
    } else if (inWord) {
      total += 1; inWord = false;
      if (inDigit) inDigit = false;
    } else if (inDigit) {
      total += 1; inDigit = false;
    }
  }
  if (inWord) total += 1;
  if (inDigit) total += 1;
  return total;
}

export function updateCursorInfo() {
  const pos = els.view.selectionStart;
  const before = els.view.value.slice(0, pos);
  const line = before.split('\n').length;
  const col = pos - before.lastIndexOf('\n');
  els.cursorInfo.textContent = `行 ${line} · 列 ${col}`;
  const sel = els.view.selectionEnd - els.view.selectionStart;
  els.selectionInfo.textContent = `选中 ${sel}`;
}

export function updateVersionInfo(n) {
  els.versionInfo.textContent = `版本 ${n}`;
}

export function applyFonts() {
  const s = state.settings;
  const root = document.documentElement;
  root.style.setProperty('--font-body', s.fontFamily);
  root.style.setProperty('--font-size', `${s.fontSize}px`);
  root.style.setProperty('--line-height', String(s.lineHeight));
  root.style.setProperty('--letter-spacing', `${s.letterSpacing}em`);
  root.style.setProperty('--editor-width', `${s.editorWidth}px`);
  document.documentElement.setAttribute('data-theme', s.theme || 'light');
  autoGrow();
}

export function editorValue() {
  return els.view.value;
}
export function setEditorValue(text) {
  els.view.value = text;
  autoGrow();
  markDirty();
  updateCounts();
}
export function getSelection() {
  const v = els.view;
  return { start: v.selectionStart, end: v.selectionEnd, text: v.value.slice(v.selectionStart, v.selectionEnd) };
}
export function focusEditor() {
  els.view.focus();
}
export function editorEl() {
  return els.view;
}
export function titleEls() {
  return { top: els.titleTop, big: els.titleBig, status: els.statusSelect, crumb: els.crumbVolume };
}
export { markSaveState };
