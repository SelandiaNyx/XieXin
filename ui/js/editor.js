// 中间编辑区：正文编辑、自动保存、字数统计、状态栏时钟、查找替换。

import { api } from './api.js';
import { state, setState, emit, findChapter, bookCharCount, bookChapterCount, statusInfo } from './store.js';
import { toast, formatTime, animateNumber } from './ui.js';

const els = {};
let autosaveTimer = null;
let clockTimer = null;
let editRevision = 0;
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

  document.getElementById('saveState').addEventListener('click', () => window.__moge.saveNow(false));

  syncEditorAvailability();
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

// Navigation and destructive editor operations hold a short input lock while
// pending saves finish. Failed reads leave the current document untouched.
export async function withEditorTransition(action) {
  if (state.transitioning) return false;
  setState({ transitioning: true });
  syncEditorAvailability();
  try {
    if (!await flushPendingSave()) return false;
    return await action();
  } catch (e) {
    toast(e.message, 'err');
    return false;
  } finally {
    setState({ transitioning: false });
    syncEditorAvailability();
  }
}

export async function flushPendingSave() {
  if (savePromise && !await savePromise) return false;
  while (state.dirty && state.activeChapterId) {
    if (!await saveChapter({ silent: true })) return false;
  }
  return true;
}

export function syncEditorAvailability() {
  const blocked = Boolean(state.transitioning || !state.activeChapterId);
  for (const el of [els.view, els.titleBig, els.titleTop]) el.readOnly = blocked;
  els.statusSelect.disabled = blocked;
}

export function clearEditor() {
  els.view.value = '';
  els.titleBig.value = '';
  els.titleTop.value = '';
  els.crumbVolume.textContent = '未选择章节';
  editRevision += 1;
  setState({ activeChapterId: '', activeVolumeId: '', content: '', versions: [], dirty: false });
  syncEditorAvailability();
  updateCounts();
  updateVersionInfo(0);
  markSaveState('ok', '就绪');
}

async function loadChapter(book, chapterId, cards = state.cards, cover = null) {
  const vol = book.volumes.find(v => v.chapters.some(c => c.id === chapterId));
  const ch = vol?.chapters.find(c => c.id === chapterId);
  if (!ch) throw new Error('找不到该章节');
  const [res, versions] = await Promise.all([
    api.readChapter(book.id, chapterId), api.listVersions(book.id, chapterId),
  ]);
  applyingRemote = true;
  els.view.value = res.content;
  els.titleBig.value = ch.title;
  els.titleTop.value = ch.title;
  els.statusSelect.value = ch.status || 'draft';
  if (els.statusSelect.value !== (ch.status || 'draft')) {
    const opt = document.createElement('option');
    opt.value = ch.status || 'draft'; opt.textContent = opt.value + '（旧）';
    els.statusSelect.appendChild(opt); els.statusSelect.value = opt.value;
  }
  els.crumbVolume.textContent = vol.title;
  editRevision += 1;
  setState({ book, cards, activeChapterId: chapterId, activeVolumeId: vol.id,
    content: res.content, versions, dirty: false, lastSavedAt: res.createdAt || Date.now() });
  // 换书时带上当前作品的封面（data URL）；同一本书内切章传 null，保持不动
  if (cover !== null) setState({ bookCover: cover || '' });
  applyingRemote = false;
  autoGrow();
  markSaveState('ok', '已保存');
  updateCounts(); updateCursorInfo(); updateVersionInfo(versions.length); applyStatusStyle();
  // Keep the textarea and chapter identity in the same synchronous update.
  // View-transition callbacks may run after another save has begun.
  els.page.classList.remove('paper-enter');
  void els.page.offsetWidth;
  els.page.classList.add('paper-enter');
  return true;
}

export async function openChapter(chapterId, { force = false } = {}) {
  if (!chapterId || !state.book) return false;
  if (!force && chapterId === state.activeChapterId) return true;
  const ok = await withEditorTransition(() => loadChapter(state.book, chapterId));
  // 记住位置，下次启动直接回到这一章（写失败不影响当前编辑）
  if (ok && state.book) {
    state.settings.lastBookId = state.book.id;
    state.settings.lastChapterId = chapterId;
    if (typeof api.setLastPosition === 'function') {
      Promise.resolve(api.setLastPosition(state.book.id, chapterId)).catch(() => {});
    }
  }
  return ok;
}

export async function openBookInEditor(bookId) {
  return withEditorTransition(async () => {
    const payload = await api.openBook(bookId);
    const all = payload.book.volumes.flatMap(v => v.chapters);
    const target = all.find(c => c.id === state.settings.lastChapterId) || all[0];
    if (target) return loadChapter(payload.book, target.id, payload.cards, payload.cover);
    setState({ book: payload.book, cards: payload.cards, bookCover: payload.cover || '' });
    clearEditor();
    return true;
  });
}

export async function restoreChapterVersion(bookId, chapterId, versionId) {
  return withEditorTransition(async () => {
    await api.restoreVersion(bookId, chapterId, versionId);
    const payload = await api.openBook(bookId);
    return loadChapter(payload.book, chapterId, payload.cards);
  });
}

export async function deleteFromBook(action) {
  return withEditorTransition(async () => {
    const book = await action();
    setState({ book });
    if (!book.volumes.some(v => v.chapters.some(c => c.id === state.activeChapterId))) {
      clearEditor();
      const first = book.volumes.flatMap(v => v.chapters)[0];
      if (first) await loadChapter(book, first.id);
    }
    return true;
  });
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
    if (delta > 0) { addSessionChars(delta); updateTodayChars(delta); }
  }
  setState({ content: text });
  markDirty();
  updateCounts();
  updateCursorInfo();
}

function onKeyDown(e) {
  if (e.isComposing || e.keyCode === 229 || state.transitioning || !state.activeChapterId) return;
  // Tab 缩进
  if (e.key === 'Tab') {
    e.preventDefault();
    insertText('\u3000\u3000');
    return;
  }
  const pairs = { '"': '“”', "'": '‘’', '（': '（）', '(': '（）', '「': '「」', '《': '《》', '【': '【】' };
  if (pairs[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    const [open, close] = pairs[e.key];
    const selection = els.view.value.slice(els.view.selectionStart, els.view.selectionEnd);
    insertText(open + selection + close, selection ? null : 1);
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
  if (state.transitioning || !state.activeChapterId) return;
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
  editRevision += 1;
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

export function saveChapter({ manualSnapshot = false, silent = false, label = '' } = {}) {
  if (!state.book || !state.activeChapterId) return Promise.resolve(null);
  const payload = {
    bookId: state.book.id, chapterId: state.activeChapterId, content: els.view.value,
    title: els.titleBig.value.trim() || findChapter(state.activeChapterId)?.title || '',
    summary: findChapter(state.activeChapterId)?.summary || '', status: els.statusSelect.value,
    manualSnapshot, snapshotLabel: label,
  };
  const revision = editRevision;
  const previous = savePromise || Promise.resolve();
  // Capture a document at the call site; serialize the complete operation,
  // including metadata updates, so queued saves cannot target another chapter.
  const task = previous.catch(() => {}).then(async () => {
    setState({ saving: true });
    markSaveState('dirty', '保存中…');
    try {
      const res = await api.saveChapter(payload);
      if (state.book?.id === payload.bookId && state.activeChapterId === payload.chapterId) {
        const unchanged = revision === editRevision && els.view.value === payload.content
          && (els.titleBig.value.trim() || payload.title) === payload.title
          && els.statusSelect.value === payload.status;
        setState({ dirty: !unchanged, lastSavedAt: res.updatedAt });
        markSaveState(unchanged ? 'ok' : 'dirty', unchanged ? '已保存 ' + formatTime(res.updatedAt).slice(11) : '有新修改待保存');
        const ch = findChapter(payload.chapterId);
        if (ch) Object.assign(ch, { charCount: res.charCount, versions: res.versions,
          title: payload.title, status: payload.status, updatedAt: res.updatedAt });
        updateVersionInfo(res.versions); updateCounts();
        if (manualSnapshot) setState({ versions: await api.listVersions(payload.bookId, payload.chapterId) });
        if (!silent) toast(manualSnapshot ? '已保存并创建快照' : '已保存', 'ok');
        emit();
      }
      return res;
    } catch (e) {
      if (state.book?.id === payload.bookId && state.activeChapterId === payload.chapterId) {
        setState({ dirty: true });
        markSaveState('err', '保存失败 · 点击重试');
      }
      toast('保存失败：' + e.message, 'err', '正文仍保留在编辑区，请重试保存。');
      return null;
    }
  }).finally(() => {
    if (savePromise === task) { savePromise = null; setState({ saving: false }); }
  });
  savePromise = task;
  return task;
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
  const goal = Math.max(1, Number(state.settings.dailyGoal) || 3000);
  const progress = document.getElementById('dailyProgress');
  if (progress) {
    const percent = Math.min(100, Math.round(100 * (todayData.chars || 0) / goal));
    progress.setAttribute('aria-valuenow', String(percent));
    progress.querySelector('i').style.width = `${percent}%`;
    document.getElementById('dailyGoalValue').textContent = `${(todayData.chars || 0).toLocaleString()} 字`;
    document.getElementById('dailyGoalCaption').textContent = `目标 ${goal.toLocaleString()} 字 · 已完成 ${percent}%`;
  }
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
  try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* Editing must remain available. */ }
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
  // Exactly the same grouping as Rust: each CJK character is one unit;
  // each contiguous non-CJK letter/number run is one unit.
  let total = 0;
  let inRun = false;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    const cjk = (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x3040 && c <= 0x30ff)
      || (c >= 0xac00 && c <= 0xd7af) || (c >= 0x20000 && c <= 0x2fa1f);
    if (cjk) { total++; inRun = false; }
    else if (/[\p{L}\p{N}]/u.test(ch)) { if (!inRun) total++; inRun = true; }
    else inRun = false;
  }
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
