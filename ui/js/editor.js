// 中间编辑区：正文编辑、章纲便签、快捷标点、打字机居中、阅读预览、选区 AI 浮条、自动保存与统计。

import { api } from './api.js';
import { state, setState, emit, findChapter, bookCharCount, statusInfo } from './store.js';
import { toast, formatTime, animateNumber } from './ui.js';

const els = {};
let autosaveTimer = null;
let clockTimer = null;
let editRevision = 0;
let savePromise = null;
let applyingRemote = false;
let editorHooks = {};

export function initEditor(hooks = {}) {
  editorHooks = hooks || {};
  els.view = document.getElementById('editor');
  els.titleTop = document.getElementById('chapterTitleInput');
  els.titleBig = document.getElementById('chapterTitleBig');
  els.statusSelect = document.getElementById('statusSelect');
  els.crumbVolume = document.getElementById('crumbVolume');
  els.saveState = document.getElementById('saveState');
  els.versionInfo = document.getElementById('versionInfo');
  els.cursorInfo = document.getElementById('cursorInfo');
  els.selectionInfo = document.getElementById('selectionInfo');
  els.readingTimeInfo = document.getElementById('readingTimeInfo');
  els.speedInfo = document.getElementById('speedInfo');
  els.wcTotal = document.getElementById('wcTotal');
  els.wcChapter = document.getElementById('wcChapter');
  els.wcToday = document.getElementById('wcToday');
  els.clock = document.getElementById('clock');
  els.app = document.getElementById('app');
  els.page = document.getElementById('editorPage');
  els.wrap = document.getElementById('editorWrap');
  els.synopsisBar = document.getElementById('synopsisBar');
  els.synopsis = document.getElementById('chapterSynopsis');
  els.punctBar = document.getElementById('punctBar');
  els.preview = document.getElementById('readingPreview');
  els.selectionAiBar = document.getElementById('selectionAiBar');
  els.selectionAiCount = document.getElementById('selectionAiCount');

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

  if (els.synopsis) {
    els.synopsis.addEventListener('input', () => {
      if (applyingRemote) return;
      const ch = findChapter(state.activeChapterId);
      if (ch) ch.summary = els.synopsis.value;
      markDirty();
    });
    els.synopsis.addEventListener('blur', () => persistChapterTitle());
  }

  if (els.punctBar) {
    els.punctBar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-punct]');
      if (!btn || !state.activeChapterId) return;
      const str = btn.dataset.punct || '';
      const caret = btn.dataset.caret != null ? Number(btn.dataset.caret) : null;
      if (caret != null && els.view.selectionEnd > els.view.selectionStart) {
        const sel = els.view.value.slice(els.view.selectionStart, els.view.selectionEnd);
        insertText(str.slice(0, caret) + sel + str.slice(caret));
      } else {
        insertText(str, caret);
      }
    });
  }

  if (els.selectionAiBar) {
    els.selectionAiBar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ai-sel]');
      if (!btn) return;
      const sel = getSelection();
      if (!sel.text.trim()) return;
      if (typeof editorHooks.onSelectionAi === 'function') {
        editorHooks.onSelectionAi(btn.dataset.aiSel, sel.text);
      }
    });
  }

  els.statusSelect.addEventListener('change', async () => {
    const status = els.statusSelect.value;
    const ch = findChapter(state.activeChapterId);
    if (ch) ch.status = status;
    markDirty();
    await persistChapterTitle(true);
    const info = statusInfo(status);
    els.statusSelect.classList.remove('pulse');
    void els.statusSelect.offsetWidth;
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
}

async function persistChapterTitle(immediate = false) {
  if (!state.book || !state.activeChapterId) return;
  const ch = findChapter(state.activeChapterId);
  if (!ch) return;
  const title = els.titleBig.value.trim();
  const summary = els.synopsis ? els.synopsis.value : (ch.summary || '');
  if (title === ch.title && summary === (ch.summary || '') && !state.dirty) return;
  if (immediate) await saveChapter({ manualSnapshot: false });
  else markDirty();
}

// ------------------------------------------------------------------ 打开

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
  for (const el of [els.view, els.titleBig, els.titleTop]) {
    if (el) el.readOnly = blocked;
  }
  if (els.synopsis) els.synopsis.readOnly = blocked;
  if (els.statusSelect) els.statusSelect.disabled = blocked;
}

export function clearEditor() {
  els.view.value = '';
  els.titleBig.value = '';
  els.titleTop.value = '';
  if (els.synopsis) els.synopsis.value = '';
  if (els.selectionAiBar) els.selectionAiBar.hidden = true;
  els.crumbVolume.textContent = '未选择章节';
  editRevision += 1;
  setState({ activeChapterId: '', activeVolumeId: '', content: '', versions: [], dirty: false });
  syncEditorAvailability();
  updateCounts();
  updateVersionInfo(0);
  markSaveState('ok', '就绪');
}

async function loadChapter(book, chapterId, cards = state.cards, cover = null) {
  const vol = book.volumes.find((v) => v.chapters.some((c) => c.id === chapterId));
  const ch = vol?.chapters.find((c) => c.id === chapterId);
  if (!ch) throw new Error('找不到该章节');
  const [res, versions] = await Promise.all([
    api.readChapter(book.id, chapterId),
    api.listVersions(book.id, chapterId),
  ]);
  applyingRemote = true;
  els.view.value = res.content;
  els.titleBig.value = ch.title;
  els.titleTop.value = ch.title;
  if (els.synopsis) els.synopsis.value = ch.summary || '';
  els.statusSelect.value = ch.status || 'draft';
  if (els.statusSelect.value !== (ch.status || 'draft')) {
    const opt = document.createElement('option');
    opt.value = ch.status || 'draft';
    opt.textContent = opt.value + '（旧）';
    els.statusSelect.appendChild(opt);
    els.statusSelect.value = opt.value;
  }
  els.crumbVolume.textContent = vol.title;
  editRevision += 1;
  setState({
    book,
    cards,
    activeChapterId: chapterId,
    activeVolumeId: vol.id,
    content: res.content,
    versions,
    dirty: false,
    lastSavedAt: res.updatedAt || res.createdAt || Date.now(),
  });
  if (cover !== null) setState({ bookCover: cover || '' });
  applyingRemote = false;
  autoGrow();
  if (state.previewMode) renderReadingPreview();
  markSaveState('ok', '已保存');
  updateCounts();
  updateCursorInfo();
  updateVersionInfo(versions.length);
  applyStatusStyle();
  els.page.classList.remove('paper-enter');
  void els.page.offsetWidth;
  els.page.classList.add('paper-enter');
  return true;
}

export async function openChapter(chapterId, { force = false } = {}) {
  if (!chapterId || !state.book) return false;
  if (!force && chapterId === state.activeChapterId) return true;
  const ok = await withEditorTransition(() => loadChapter(state.book, chapterId));
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
    const all = payload.book.volumes.flatMap((v) => v.chapters);
    const target = all.find((c) => c.id === state.settings.lastChapterId) || all[0];
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
    if (!book.volumes.some((v) => v.chapters.some((c) => c.id === state.activeChapterId))) {
      clearEditor();
      const first = book.volumes.flatMap((v) => v.chapters)[0];
      if (first) await loadChapter(book, first.id);
    }
    return true;
  });
}

// ------------------------------------------------------------------ 编辑与预览

export function applyStatusStyle() {
  if (!els.statusSelect) return;
  const info = statusInfo(els.statusSelect.value);
  els.statusSelect.style.color = info.color;
  els.statusSelect.style.fontWeight = '600';
  els.statusSelect.title = `章节状态：${info.label}${info.hint ? '（' + info.hint + '）' : ''}`;
}

export function togglePreviewMode(next) {
  const on = next === undefined ? !state.previewMode : Boolean(next);
  setState({ previewMode: on });
  if (els.view && els.preview) {
    els.view.hidden = on;
    els.preview.hidden = !on;
    if (on) renderReadingPreview();
  }
  const btn = document.getElementById('togglePreviewBtn');
  if (btn) btn.setAttribute('aria-pressed', String(on));
}

export function renderReadingPreview() {
  if (!els.preview) return;
  const raw = els.view ? els.view.value : '';
  const lines = raw.split(/\r?\n/);
  const blocks = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[-—=*✦·\s]{3,}$/.test(trimmed)) {
      blocks.push('<p class="scene-break">✦ ✦ ✦</p>');
    } else {
      const safe = trimmed
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      blocks.push(`<p>${safe}</p>`);
    }
  }
  els.preview.innerHTML = blocks.length
    ? blocks.join('')
    : '<div class="empty-note">本章尚无正文内容，退出预览即可落笔。</div>';
}

function maybeTypewriterScroll() {
  if (!state.settings?.typewriterMode || !els.wrap || !els.view) return;
  const pos = els.view.selectionStart;
  const lines = els.view.value.slice(0, pos).split('\n').length;
  const lh = (Number(state.settings.fontSize) || 18) * (Number(state.settings.lineHeight) || 1.95);
  const targetTop = Math.max(0, els.view.offsetTop + lines * lh - els.wrap.clientHeight * 0.45);
  els.wrap.scrollTo({ top: targetTop, behavior: 'smooth' });
}

function onInput() {
  if (applyingRemote) return;
  autoGrow();
  const before = state.content || '';
  const text = els.view.value;
  if (text !== before) {
    const delta = countLocal(text) - countLocal(before);
    if (delta > 0) {
      addSessionChars(delta);
      updateTodayChars(delta);
    }
  }
  setState({ content: text });
  markDirty();
  updateCounts();
  updateCursorInfo();
  maybeTypewriterScroll();
}

function onKeyDown(e) {
  if (e.isComposing || e.keyCode === 229 || state.transitioning || !state.activeChapterId) return;
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
  if (state.previewMode) togglePreviewMode(false);
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

export function setChapterSynopsis(text) {
  if (!state.activeChapterId) return;
  const ch = findChapter(state.activeChapterId);
  if (ch) ch.summary = text;
  if (els.synopsis) els.synopsis.value = text;
  markDirty();
}

function autoGrow() {
  const view = els.view;
  if (!view) return;
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
    if (els.clock) els.clock.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  tick();
  clearInterval(clockTimer);
  clockTimer = setInterval(tick, 1000);
}

// ------------------------------------------------------------------ 保存

export function saveChapter({ manualSnapshot = false, silent = false, label = '' } = {}) {
  if (!state.book || !state.activeChapterId) return Promise.resolve(null);
  const chMeta = findChapter(state.activeChapterId);
  const summaryVal = els.synopsis ? els.synopsis.value : (chMeta?.summary || '');
  const payload = {
    bookId: state.book.id,
    chapterId: state.activeChapterId,
    content: els.view.value,
    title: els.titleBig.value.trim() || chMeta?.title || '',
    summary: summaryVal,
    status: els.statusSelect.value,
    manualSnapshot,
    snapshotLabel: label,
  };
  const revision = editRevision;
  const previous = savePromise || Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    setState({ saving: true });
    markSaveState('dirty', '保存中…');
    try {
      const res = await api.saveChapter(payload);
      if (state.book?.id === payload.bookId && state.activeChapterId === payload.chapterId) {
        const currentSummary = els.synopsis ? els.synopsis.value : payload.summary;
        const unchanged =
          revision === editRevision &&
          els.view.value === payload.content &&
          (els.titleBig.value.trim() || payload.title) === payload.title &&
          currentSummary === payload.summary &&
          els.statusSelect.value === payload.status;
        setState({ dirty: !unchanged, lastSavedAt: res.updatedAt });
        markSaveState(
          unchanged ? 'ok' : 'dirty',
          unchanged ? '已保存 ' + formatTime(res.updatedAt).slice(11) : '有新修改待保存',
        );
        const ch = findChapter(payload.chapterId);
        if (ch) {
          Object.assign(ch, {
            charCount: res.charCount,
            versions: res.versions,
            title: payload.title,
            summary: payload.summary,
            status: payload.status,
            updatedAt: res.updatedAt,
          });
        }
        updateVersionInfo(res.versions);
        updateCounts();
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
    if (savePromise === task) {
      savePromise = null;
      setState({ saving: false });
    }
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

// ------------------------------------------------------------------ 显示与统计

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
  animateNumber(els.wcChapter, chapterChars);
  animateNumber(
    els.wcTotal,
    bookChars + (chapterChars - (findChapter(state.activeChapterId)?.charCount || 0)),
  );
  animateNumber(els.wcToday, todayData.chars || 0);
  if (els.readingTimeInfo) {
    const mins = Math.max(1, Math.ceil(chapterChars / 420));
    els.readingTimeInfo.textContent = chapterChars ? `约 ${mins} 分钟读完` : '空白章节';
  }
  if (els.speedInfo) {
    const minsElapsed = Math.max(1, (Date.now() - (state.sessionStartAt || Date.now())) / 60000);
    const cpm = Math.round((state.sessionChars || 0) / minsElapsed);
    els.speedInfo.textContent = state.sessionChars >= 20 ? `· ${cpm} 字/分` : '';
  }
  const goal = Math.max(1, Number(state.settings.dailyGoal) || 3000);
  const progress = document.getElementById('dailyProgress');
  if (progress) {
    const percent = Math.min(100, Math.round((100 * (todayData.chars || 0)) / goal));
    progress.setAttribute('aria-valuenow', String(percent));
    progress.querySelector('i').style.width = `${percent}%`;
    document.getElementById('dailyGoalValue').textContent = `${(todayData.chars || 0).toLocaleString()} 字`;
    document.getElementById('dailyGoalCaption').textContent =
      percent >= 100
        ? `今日目标达成！已完成 ${percent}% ✨`
        : `目标 ${goal.toLocaleString()} 字 · 已完成 ${percent}%`;
  }
  renderSessionChip();
}

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
  try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* ignore */ }
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

export function countLocal(text) {
  let total = 0;
  let inRun = false;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    const cjk =
      (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0x3040 && c <= 0x30ff) ||
      (c >= 0xac00 && c <= 0xd7af) ||
      (c >= 0x20000 && c <= 0x2fa1f);
    if (cjk) {
      total++;
      inRun = false;
    } else if (/[\p{L}\p{N}]/u.test(ch)) {
      if (!inRun) total++;
      inRun = true;
    } else {
      inRun = false;
    }
  }
  return total;
}

export function updateCursorInfo() {
  const pos = els.view.selectionStart;
  const before = els.view.value.slice(0, pos);
  const line = before.split('\n').length;
  const col = pos - before.lastIndexOf('\n');
  els.cursorInfo.textContent = `行 ${line} · 列 ${col}`;
  const selLen = els.view.selectionEnd - els.view.selectionStart;
  els.selectionInfo.textContent = `选中 ${selLen}`;
  if (els.selectionAiBar) {
    const showAi = selLen >= 2 && !state.previewMode && Boolean(state.activeChapterId);
    els.selectionAiBar.hidden = !showAi;
    if (showAi && els.selectionAiCount) {
      els.selectionAiCount.textContent = `已选 ${selLen} 字`;
    }
  }
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
  root.setAttribute('data-theme', s.theme || 'sakura');
  root.setAttribute('data-anime', s.animeDecor === false ? 'off' : 'on');

  if (els.punctBar) els.punctBar.hidden = s.quickPunctBar === false;
  if (els.synopsisBar) els.synopsisBar.hidden = s.showSynopsis === false;

  const btnSyn = document.getElementById('toggleSynopsisBtn');
  if (btnSyn) btnSyn.setAttribute('aria-pressed', String(s.showSynopsis !== false));
  const btnPunct = document.getElementById('togglePunctBtn');
  if (btnPunct) btnPunct.setAttribute('aria-pressed', String(s.quickPunctBar !== false));
  const btnType = document.getElementById('toggleTypewriterBtn');
  if (btnType) btnType.setAttribute('aria-pressed', String(Boolean(s.typewriterMode)));
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
