// 左侧边栏：书籍切换、卷/章目录树、拖拽排序与增删改。

import { api } from './api.js';
import { state, setState, emit, findChapter, statusInfo } from './store.js';
import { toast, confirmDialog, promptDialog, escapeHtml, openModal, closeModal } from './ui.js';
import { bookCharCount, bookChapterCount } from './store.js';
import { deleteFromBook } from './editor.js';
import { isTouch } from './viewport.js';

const els = {};
let dragChapterId = null;

export function initSidebar({ onSelectChapter, onOpenBookPicker, onNewBook }) {
  els.toc = document.getElementById('toc');
  els.tocStats = document.getElementById('tocStats');
  els.filter = document.getElementById('tocFilter');
  els.bookSwitch = document.getElementById('bookSwitch');
  els.bookTitle = document.getElementById('bookTitleLabel');
  els.bookMeta = document.getElementById('bookMetaLabel');
  els.bookDot = document.getElementById('bookDot');
  // 记下原始的书籍图标：设过封面的作品换成封面图，没设的（或清除后）回到它
  els.bookIcon = els.bookDot.innerHTML;

  els.bookSwitch.addEventListener('click', () => onOpenBookPicker());
  document.getElementById('addVolume').addEventListener('click', () => createVolume());
  document.getElementById('addChapter').addEventListener('click', () => createChapter());
  els.filter.addEventListener('input', () => renderToc());

  document.getElementById('openStorageDir').addEventListener('click', async () => {
    if (!state.storageDir) return;
    try { await api.openInExplorer(state.storageDir); } catch (e) { toast(e.message, 'err'); }
  });

  els.toc.addEventListener('click', onTocClick);
  els.toc.addEventListener('dblclick', onTocDblClick);
  els.toc.addEventListener('dragstart', onDragStart);
  els.toc.addEventListener('dragover', onDragOver);
  els.toc.addEventListener('dragleave', onDragLeave);
  els.toc.addEventListener('drop', onDrop);
  els.toc.addEventListener('dragend', () => {
    dragChapterId = null;
    els.toc.querySelectorAll('.dragover, .armed').forEach((n) => n.classList.remove('dragover', 'armed'));
  });

  // 让外部（如 Ctrl+N）也走同一套逻辑
  els.createVolume = createVolume;
  els.createChapter = createChapter;
  void onNewBook;
}

function filterText() {
  return (els.filter.value || '').trim().toLowerCase();
}

export function renderToc() {
  const book = state.book;
  if (!book) {
    els.toc.innerHTML = `<div class="empty-note">还没有作品<br/>点击"新建书"开始</div>`;
    els.bookTitle.textContent = '未选择书籍';
    els.bookMeta.textContent = '点击选择或新建作品';
    els.tocStats.textContent = '卷 0 · 章 0';
    return;
  }
  const kw = filterText();
  els.bookTitle.textContent = book.title;
  els.bookMeta.textContent = `${book.volumes.length} 卷 · ${bookChapterCount()} 章 · ${bookCharCount().toLocaleString()} 字`;
  els.bookDot.style.background = book.coverColor || 'var(--accent)';
  // 设过封面就显示封面图，没设就回到原来的图标（清除封面后同样是这个分支）
  els.bookDot.innerHTML = state.bookCover
    ? `<img src="${escapeHtml(state.bookCover)}" alt="" />`
    : els.bookIcon;
  els.tocStats.textContent = `卷 ${book.volumes.length} · 章 ${bookChapterCount()}`;

  const parts = [];
  book.volumes.forEach((vol, vi) => {
    const chapters = vol.chapters.filter(
      (c) => !kw || c.title.toLowerCase().includes(kw) || (c.summary || '').toLowerCase().includes(kw),
    );
    if (kw && chapters.length === 0) return;
    const open = kw ? true : vol.expanded !== false;
    const volChars = vol.chapters.reduce((s, c) => s + (c.charCount || 0), 0);
    parts.push(`
      <div class="volume" data-volume-id="${vol.id}">
        <div class="volume-row" data-action="toggle-volume" data-id="${vol.id}" title="双击重命名">
          <span class="volume-caret">${open ? '▾' : '▸'}</span>
          <span class="volume-title">${escapeHtml(vol.title)}</span>
          <span class="volume-count">${vol.chapters.length}章 · ${volChars.toLocaleString()}字</span>
          <span class="volume-actions">
            <button class="tiny-btn" data-action="add-chapter-here" data-id="${vol.id}" title="在此卷新增章节">＋</button>
            <button class="tiny-btn" data-action="rename-volume" data-id="${vol.id}" title="重命名">✎</button>
            <button class="tiny-btn" data-action="move-volume-up" data-id="${vol.id}" title="上移" ${vi === 0 ? 'disabled' : ''}>↑</button>
            <button class="tiny-btn" data-action="move-volume-down" data-id="${vol.id}" title="下移" ${vi === book.volumes.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="tiny-btn" data-action="delete-volume" data-id="${vol.id}" title="删除本卷">✕</button>
          </span>
          <button class="row-more" data-action="mobile-more" title="更多操作" aria-label="《${escapeHtml(vol.title)}》的更多操作">⋮</button>
        </div>
        <div class="volume-chapters" data-volume-id="${vol.id}">
          ${open ? chapters.map((c) => chapterRow(c, vol)).join('') : ''}
          ${open && !kw ? `<div class="toc-dropzone" data-zone="volume" data-volume-id="${vol.id}" data-position="${vol.chapters.length}"></div>` : ''}
        </div>
      </div>`);
  });

  els.toc.innerHTML = parts.join('') || `<div class="empty-note">没有匹配的章节</div>`;
}

function chapterRow(c, vol) {
  const active = c.id === state.activeChapterId ? ' active' : '';
  const info = [];
  info.push(`${(c.charCount || 0).toLocaleString()}字`);
  if (c.versions) info.push(`${c.versions}版`);
  const st = statusInfo(c.status);
  return `
    <div class="chapter-row${active}" draggable="${isTouch() ? 'false' : 'true'}" data-action="open-chapter" data-id="${c.id}" data-volume-id="${vol.id}" title="${escapeHtml(c.title)}">
      <span class="status-pill ${escapeHtml(c.status || 'draft')}" title="状态：${escapeHtml(st.label)}${st.hint ? '（' + escapeHtml(st.hint) + '）' : ''}" style="background:${escapeHtml(st.color)}"></span>
      <span class="chapter-title">${escapeHtml(c.title)}</span>
      <span class="chapter-count">${info.join(' · ')}</span>
      <span class="chapter-actions">
        <button class="tiny-btn" data-action="move-chapter-up" data-id="${c.id}" title="上移">↑</button>
        <button class="tiny-btn" data-action="move-chapter-down" data-id="${c.id}" title="下移">↓</button>
        <button class="tiny-btn" data-action="rename-chapter" data-id="${c.id}" title="重命名">✎</button>
        <button class="tiny-btn" data-action="delete-chapter" data-id="${c.id}" title="删除章节">✕</button>
      </span>
      <button class="row-more" data-action="mobile-more" title="更多操作" aria-label="《${escapeHtml(c.title)}》的更多操作">⋮</button>
    </div>
    <div class="toc-dropzone" data-zone="before" data-chapter-id="${c.id}"></div>`;
}

async function onTocClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;
  if (e.target.closest('.tiny-btn')) e.stopPropagation();
  try {
    switch (action) {
      case 'toggle-volume': {
        const vol = state.book.volumes.find((v) => v.id === id);
        if (!vol) return;
        vol.expanded = vol.expanded === false;
        renderToc();
        await api.setVolumeExpanded(state.book.id, id, vol.expanded);
        break;
      }
      case 'open-chapter':
        await window.__moge.openChapter(id);
        break;
      case 'add-chapter-here':
        await createChapter(id);
        break;
      case 'rename-volume':
        await renameVolume(id);
        break;
      case 'rename-chapter':
        await renameChapter(id);
        break;
      case 'delete-volume':
        await removeVolume(id);
        break;
      case 'delete-chapter':
        await removeChapter(id);
        break;
      case 'move-volume-up':
        await api.moveNode(state.book.id, 'volume', id, 'up');
        await refreshBook();
        break;
      case 'move-volume-down':
        await api.moveNode(state.book.id, 'volume', id, 'down');
        await refreshBook();
        break;
      case 'move-chapter-up':
        await api.moveNode(state.book.id, 'chapter', id, 'up');
        await refreshBook();
        break;
      case 'move-chapter-down':
        await api.moveNode(state.book.id, 'chapter', id, 'down');
        await refreshBook();
        break;
      default:
        break;
    }
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function onTocDblClick(e) {
  const row = e.target.closest('.volume-row, .chapter-row');
  if (!row) return;
  const isVolume = row.classList.contains('volume-row');
  const id = row.dataset.id;
  if (isVolume) await renameVolume(id);
  else await renameChapter(id);
}

export async function refreshBook() {
  if (!state.book) return;
  const payload = await api.openBook(state.book.id);
  setState({ book: payload.book });
  renderToc();
}

export async function createVolume(title = '') {
  if (!state.book) { toast('请先创建或选择一本书', 'warn'); return; }
  let name = title;
  if (!name) {
    const suggested = `第${state.book.volumes.length + 1}卷`;
    name = await promptDialog('新增卷', '卷名', suggested);
    if (name === null) return;
  }
  try {
    const book = await api.addVolume(state.book.id, name);
    setState({ book });
    renderToc();
    toast(`已新增《${name || '新卷'}》`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

export async function createChapter(volumeId = '') {
  if (!state.book) { toast('请先创建或选择一本书', 'warn'); return; }
  let target = volumeId || state.activeVolumeId || (state.book.volumes[0] && state.book.volumes[0].id);
  // activeVolumeId 可能停在已经删掉的卷上；目标卷必须真的还在
  if (target && !state.book.volumes.some((v) => v.id === target)) target = state.book.volumes[0]?.id || '';
  // 一卷都没有（比如刚把唯一的卷删了）：先补一卷再建章，别把"新建章节"变成一句抱怨
  if (!target) {
    try {
      const withVolume = await api.addVolume(state.book.id, '');
      setState({ book: withVolume });
      renderToc();
      const added = withVolume.volumes[withVolume.volumes.length - 1];
      if (!added) { toast('新建卷失败', 'err'); return; }
      target = added.id;
      toast(`已自动新建《${added.title}》`, 'ok');
    } catch (e) { toast(e.message, 'err'); return; }
  }
  try {
    const book = await api.addChapter(state.book.id, target, '');
    setState({ book });
    renderToc();
    const vol = book.volumes.find((v) => v.id === target);
    const created = vol && vol.chapters[vol.chapters.length - 1];
    if (created) await window.__moge.openChapter(created.id);
  } catch (e) { toast(e.message, 'err'); }
}

async function renameVolume(id) {
  const vol = state.book.volumes.find((v) => v.id === id);
  if (!vol) return;
  const name = await promptDialog('重命名卷', '卷名', vol.title);
  if (name === null || !name.trim()) return;
  try {
    const book = await api.renameNode({ bookId: state.book.id, kind: 'volume', id, title: name.trim() });
    setState({ book });
    renderToc();
  } catch (e) { toast(e.message, 'err'); }
}

async function renameChapter(id) {
  const ch = findChapter(id);
  if (!ch) return;
  const name = await promptDialog('重命名章节', '章节标题', ch.title);
  if (name === null || !name.trim()) return;
  try {
    const book = await api.renameNode({
      bookId: state.book.id,
      kind: 'chapter',
      id,
      title: name.trim(),
      summary: ch.summary || '',
      status: ch.status || 'draft',
    });
    setState({ book });
    renderToc();
    if (state.activeChapterId === id) {
      document.getElementById('chapterTitleInput').value = name.trim();
      document.getElementById('chapterTitleBig').value = name.trim();
    }
  } catch (e) { toast(e.message, 'err'); }
}

async function removeChapter(id) {
  const ch = findChapter(id);
  if (!ch) return;
  const ok = await confirmDialog('删除章节', `确定删除《${ch.title}》吗？正文与历史版本会移入回收站。`, { okText: '删除', danger: true });
  if (!ok) return;
  try {
    if (!await deleteFromBook(() => api.deleteChapter(state.book.id, id))) return;
    renderToc();
    toast('章节已删除', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function removeVolume(id) {
  const vol = state.book.volumes.find((v) => v.id === id);
  if (!vol) return;
  const ok = await confirmDialog(
    '删除卷',
    `确定删除《${vol.title}》及其 ${vol.chapters.length} 个章节吗？内容会移入回收站。`,
    { okText: '删除', danger: true },
  );
  if (!ok) return;
  try {
    if (!await deleteFromBook(() => api.deleteVolume(state.book.id, id, true))) return;
    renderToc();
    toast('卷已删除', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

/**
 * 「移动到其他卷…」：触屏上没有拖拽，靠这个弹层把章节挪到别的卷。
 * 位置按"先把本章摘掉之后的列表"计算，因为后端 move_chapter_to 也是先摘再插。
 */
export async function moveChapterDialog(chapterId) {
  const book = state.book;
  const ch = findChapter(chapterId);
  if (!book || !ch) return;
  const from = book.volumes.find((v) => v.chapters.some((c) => c.id === chapterId));
  if (!from) return;
  if (book.volumes.length < 2 && from.chapters.length < 2) {
    toast('只有一卷一章，没有可移动的位置', 'warn');
    return;
  }
  const volumes = book.volumes;
  openModal({
    title: `移动《${ch.title}》`,
    width: 'narrow',
    body: `
      <div class="field"><label>目标卷</label>
        <select id="mvVolume">${volumes
          .map((v) => `<option value="${v.id}"${v.id === from.id ? ' selected' : ''}>${escapeHtml(v.title)}（${v.chapters.length} 章）</option>`)
          .join('')}</select>
      </div>
      <div class="field"><label>插入位置</label><select id="mvPosition"></select></div>
      <div class="field"><span class="hint">跨卷移动会保留正文与全部历史版本。</span></div>`,
    footer: '<button class="mini" data-role="cancel">取消</button><button class="primary" data-role="ok">移动</button>',
    onMount(bodyEl, footEl) {
      const volSel = bodyEl.querySelector('#mvVolume');
      const posSel = bodyEl.querySelector('#mvPosition');
      const fillPositions = () => {
        const vol = volumes.find((v) => v.id === volSel.value) || volumes[0];
        const rest = vol.chapters.filter((c) => c.id !== chapterId);
        posSel.innerHTML = ['<option value="0">放到最前</option>']
          .concat(rest.map((c, i) => `<option value="${i + 1}">放到《${escapeHtml(c.title)}》之后</option>`))
          .join('');
      };
      fillPositions();
      volSel.onchange = fillPositions;
      footEl.querySelector('[data-role="cancel"]').onclick = () => closeModal();
      footEl.querySelector('[data-role="ok"]').onclick = async () => {
        const targetVolumeId = volSel.value;
        const position = Number(posSel.value || 0);
        closeModal();
        try {
          const next = await api.moveChapterTo(book.id, chapterId, targetVolumeId, position);
          setState({ book: next });
          renderToc();
          const to = next.volumes.find((v) => v.id === targetVolumeId);
          toast(`已移动到《${to ? to.title : '目标卷'}》`, 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

// ------------------------------------------------------------------ 拖拽

function onDragStart(e) {
  const row = e.target.closest('.chapter-row');
  if (!row) return;
  dragChapterId = row.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', dragChapterId); } catch { /* ignore */ }
}

function onDragOver(e) {
  if (!dragChapterId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const zone = e.target.closest('.toc-dropzone');
  els.toc.querySelectorAll('.toc-dropzone.armed').forEach((n) => { if (n !== zone) n.classList.remove('armed'); });
  if (zone) zone.classList.add('armed');
  const row = e.target.closest('.chapter-row');
  if (row && row.dataset.id !== dragChapterId) row.classList.add('dragover');
}

function onDragLeave(e) {
  const row = e.target.closest('.chapter-row');
  if (row) row.classList.remove('dragover');
}

async function onDrop(e) {
  if (!dragChapterId) return;
  e.preventDefault();
  const zone = e.target.closest('.toc-dropzone');
  const row = e.target.closest('.chapter-row');
  els.toc.querySelectorAll('.dragover, .armed').forEach((n) => n.classList.remove('dragover', 'armed'));
  let targetVolumeId = '';
  let position = 0;
  if (zone) {
    targetVolumeId = zone.dataset.volumeId;
    position = Number(zone.dataset.position || 0);
  } else if (row) {
    targetVolumeId = row.dataset.volumeId;
    const vol = state.book.volumes.find((v) => v.id === targetVolumeId);
    position = vol ? vol.chapters.findIndex((c) => c.id === row.dataset.id) : 0;
    const movingVol = state.book.volumes.find((v) => v.chapters.some((c) => c.id === dragChapterId));
    if (movingVol && movingVol.id === targetVolumeId) {
      const from = movingVol.chapters.findIndex((c) => c.id === dragChapterId);
      if (from > -1 && from < position) position -= 1;
    }
  } else {
    return;
  }
  const chapterId = dragChapterId;
  dragChapterId = null;
  try {
    const book = await api.moveChapterTo(state.book.id, chapterId, targetVolumeId, Math.max(0, position));
    setState({ book });
    renderToc();
  } catch (err) { toast(err.message, 'err'); }
}
