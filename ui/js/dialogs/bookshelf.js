// 书架与作品资料弹层、封面图片选择、工作区重载。

import { api } from '../api.js';
import { state, setState } from '../store.js';
import {
  toast, openModal, closeModal, confirmDialog, escapeHtml,
  formatBytes, formatTime, relativeTime,
} from '../ui.js';
import {
  openBookInEditor, withEditorTransition, clearEditor, applyFonts,
} from '../editor.js';
import { renderToc } from '../sidebar.js';

// ------------------------------------------------------------------ 封面（可选功能）

/**
 * 封面字段的 HTML。挑不了图（Android 没有原生文件选择器）时只留一句说明，
 * 不让用户点了没反应。
 * @param {string} preview 当前封面的 data URL（没有就空串）
 */
function coverFieldHtml(preview = '') {
  const thumb = `<span class="cover-thumb" data-cover-thumb>${preview ? `<img src="${escapeHtml(preview)}" alt="封面" />` : ''}</span>`;
  if (!state.hasNativePickers) {
    return `
      <div class="field full"><label>封面图片 <span class="hint">可选</span></label>
        <div class="cover-field">${thumb}<span class="hint">手机端暂不支持选择封面图片，先用封面颜色区分作品吧</span></div>
      </div>`;
  }
  return `
    <div class="field full"><label>封面图片 <span class="hint">可选：不设就只用上面的颜色</span></label>
      <div class="cover-field">${thumb}
        <span class="cover-buttons">
          <button class="mini" type="button" data-cover-pick>选择图片…</button>
          <button class="mini" type="button" data-cover-clear>清除</button>
        </span>
        <span class="hint" data-cover-hint></span>
      </div>
    </div>`;
}

/**
 * 绑定封面字段。这里只收集"用户想干什么"，落地时机交给调用方：
 * 新建作品时书还没建出来，编辑资料时要等"保存"一起生效。
 * @returns {{pickedPath: () => string, cleared: () => boolean}}
 */
function bindCoverField(bodyEl) {
  const thumb = bodyEl.querySelector('[data-cover-thumb]');
  const hint = bodyEl.querySelector('[data-cover-hint]');
  const pick = bodyEl.querySelector('[data-cover-pick]');
  const clear = bodyEl.querySelector('[data-cover-clear]');
  let pickedPath = '';
  let cleared = false;
  const show = (url, name = '') => {
    if (thumb) thumb.innerHTML = url ? `<img src="${escapeHtml(url)}" alt="封面预览" />` : '';
    if (hint) hint.textContent = name ? `已选择：${name}` : '';
  };
  if (pick) {
    pick.onclick = async () => {
      try {
        const path = await api.pickOpenFile('image');
        if (!path) return;
        const url = await api.previewCover(path);
        pickedPath = path;
        cleared = false;
        show(url, path.split(/[\\/]/).pop() || path);
      } catch (e) { toast(e.message, 'err'); }
    };
  }
  if (clear) {
    clear.onclick = () => {
      pickedPath = '';
      cleared = true;
      show('');
      if (hint) hint.textContent = '保存后清除封面';
    };
  }
  return { pickedPath: () => pickedPath, cleared: () => cleared };
}

/** 把封面字段的意图落地；返回更新后的 BookMeta（什么都没做时返回 undefined）。 */
async function applyCoverField(bookId, field, { silent = false } = {}) {
  const picked = field.pickedPath();
  if (picked) {
    const book = await api.setBookCover(bookId, picked);
    if (!silent) toast('封面已更新', 'ok');
    return book;
  }
  if (field.cleared()) {
    const book = await api.clearBookCover(bookId);
    if (!silent) toast('封面已清除', 'ok');
    return book;
  }
  return undefined;
}

/** 封面变了之后同步状态：当前作品要连带更新侧栏的徽标。 */
async function refreshCoverState(bookId) {
  const active = state.book && state.book.id === bookId;
  await reloadWorkspace();
  if (!active) return;
  const url = await api.bookCover(bookId).catch(() => '');
  setState({ bookCover: url || '' });
  renderToc();
}

// ------------------------------------------------------------------ 书籍

export function openBookPicker() {
  const books = state.registry.books;
  const rows = books.length
    ? books
        .map((b) => {
          const isActive = state.book && b.id === state.book.id;
          const chars = b.volumes.reduce((s, v) => s + v.chapters.reduce((x, c) => x + (c.charCount || 0), 0), 0);
          const ccount = b.volumes.reduce((s, v) => s + v.chapters.length, 0);
          return `
            <div class="book-card ${isActive ? 'active' : ''}" data-book-id="${b.id}">
              <div class="book-cover" style="background:${escapeHtml(b.coverColor || '#6c5ce7')}">${
                b.coverImage ? `<img alt="" data-cover-for="${b.id}" />` : escapeHtml((b.title || '书')[0])
              }</div>
              <div class="book-info">
                <h4>${escapeHtml(b.title)}${isActive ? ' · 当前' : ''}</h4>
                <p>${escapeHtml(b.author || '佚名')} · ${b.volumes.length} 卷 ${ccount} 章 · ${chars.toLocaleString()} 字</p>
                <p>最后更新 ${relativeTime(b.updatedAt)}</p>
              </div>
              <div class="book-actions">
                <button class="mini" data-role="edit" data-book-id="${b.id}">资料</button>
                <button class="mini" data-role="delete" data-book-id="${b.id}" style="color:var(--danger)">删除</button>
              </div>
            </div>`;
        })
        .join('')
    : '<div class="empty-note">书架还是空的，先新建一本书吧。</div>';

  openModal({
    title: '书架',
    width: 'narrow',
    body: `<div class="book-list">${rows}</div>
      <div class="section-title">新建作品</div>
      <div class="form-grid">
        <div class="field"><label>书名</label><input id="nbTitle" type="text" placeholder="例如：我的第一本书" /></div>
        <div class="field"><label>作者</label><input id="nbAuthor" type="text" placeholder="笔名" /></div>
        <div class="field"><label>类型</label><input id="nbGenre" type="text" placeholder="玄幻 / 都市 / 悬疑" /></div>
        <div class="field"><label>封面颜色</label><input id="nbColor" type="color" value="#6c5ce7" style="height:34px;padding:2px" /></div>
        ${coverFieldHtml()}
      </div>`,
    footer: `<span class="spacer">数据保存在本地：${escapeHtml(state.storageDir || '-')}</span>
             ${state.hasNativePickers ? '<button class="mini" data-role="import">导入备份</button>' : ''}
             <button class="mini" data-role="close">关闭</button>
             <button class="primary" data-role="create">创建并打开</button>`,
    onMount(bodyEl, footEl) {
      // 有封面的书才去取图，没设过的连一次 IPC 都不花
      bodyEl.querySelectorAll('[data-cover-for]').forEach(async (img) => {
        const url = await api.bookCover(img.dataset.coverFor).catch(() => '');
        if (url) img.src = url;
      });
      const coverField = bindCoverField(bodyEl);
      bodyEl.querySelectorAll('.book-card').forEach((card) => {
        card.addEventListener('click', async (e) => {
          const btn = e.target.closest('[data-role]');
          const id = card.dataset.bookId;
          if (btn && btn.dataset.role === 'delete') {
            e.stopPropagation();
            const book = state.registry.books.find((b) => b.id === id);
            const ok = await confirmDialog('删除书籍', `确定删除《${book.title}》吗？相关文件会移入回收站。`, { okText: '删除', danger: true });
            if (!ok) return;
            try {
              if (!await withEditorTransition(async () => {
                await api.deleteBook(id);
                if (state.book?.id === id) {
                  setState({ book: null, cards: [] });
                  clearEditor();
                  const { renderCards } = await import('../cards.js');
                  renderCards();
                }
                return true;
              })) return;
              await reloadWorkspace();
              closeModal();
              openBookPicker();
              toast('书籍已删除', 'ok');
            } catch (err) { toast(err.message, 'err'); }
            return;
          }
          if (btn && btn.dataset.role === 'edit') {
            e.stopPropagation();
            openBookMeta(id);
            return;
          }
          closeModal();
          await switchBook(id);
        });
      });
      footEl.querySelector('[data-role="close"]').onclick = closeModal;
      footEl.querySelector('[data-role="create"]').onclick = async () => {
        const title = bodyEl.querySelector('#nbTitle').value.trim();
        if (!title) { toast('请填写书名', 'warn'); return; }
        try {
          const book = await api.createBook(
            title,
            bodyEl.querySelector('#nbAuthor').value.trim(),
            bodyEl.querySelector('#nbGenre').value.trim(),
          );
          const color = bodyEl.querySelector('#nbColor').value;
          await api.updateBookMeta({ bookId: book.id, coverColor: color });
          // 封面要等书建出来才有地方放；这一步失败不该拦住"书已经建好了"
          try {
            await applyCoverField(book.id, coverField, { silent: true });
          } catch (e) { toast(`封面没设上：${e.message}`, 'err'); }
          await reloadWorkspace();
          closeModal();
          await switchBook(book.id);
          toast(`《${title}》已创建`, 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
      const importBtn = footEl.querySelector('[data-role="import"]');
      if (importBtn) {
        importBtn.onclick = async () => {
          try {
            const path = await api.pickOpenFile('json');
            if (!path) return;
            const book = await api.importBackup(path, true);
            await reloadWorkspace();
            closeModal();
            await switchBook(book.id);
            toast(`已从备份导入《${book.title}》`, 'ok');
          } catch (e) { toast(e.message, 'err'); }
        };
      }
    },
  });
}

function openBookMeta(bookId) {
  const book = state.registry.books.find((b) => b.id === bookId);
  if (!book) return;
  openModal({
    title: `《${book.title}》资料`,
    width: 'narrow',
    body: `
      <div class="form-grid">
        <div class="field"><label>书名</label><input id="bmTitle" type="text" value="${escapeHtml(book.title)}" /></div>
        <div class="field"><label>作者</label><input id="bmAuthor" type="text" value="${escapeHtml(book.author || '')}" /></div>
        <div class="field"><label>类型</label><input id="bmGenre" type="text" value="${escapeHtml(book.genre || '')}" /></div>
        <div class="field"><label>封面颜色</label><input id="bmColor" type="color" value="${escapeHtml(book.coverColor || '#6c5ce7')}" style="height:34px;padding:2px" /></div>
        ${coverFieldHtml(bookId === state.book?.id ? state.bookCover : '')}
        <div class="field full"><label>简介</label><textarea id="bmSummary" rows="4">${escapeHtml(book.summary || '')}</textarea></div>
      </div>
      <div class="section-title">统计</div>
      <div class="kv-list">
        <div class="kv"><span class="k">创建时间</span><span>${formatTime(book.createdAt)}</span></div>
        <div class="kv"><span class="k">最后更新</span><span>${formatTime(book.updatedAt)}</span></div>
        <div class="kv"><span class="k">总字数</span><span>${book.volumes.reduce((s, v) => s + v.chapters.reduce((x, c) => x + (c.charCount || 0), 0), 0).toLocaleString()}</span></div>
      </div>`,
    footer: `<button class="mini" data-role="cancel">取消</button><button class="primary" data-role="save">保存</button>`,
    onMount(bodyEl, footEl) {
      const coverField = bindCoverField(bodyEl);
      // 不是当前作品就先取一次封面来预览（当前作品直接用内存里那份，不再多跑一次 IPC）
      if (book.coverImage && bookId !== state.book?.id) {
        api.bookCover(bookId).then((url) => {
          if (!url) return;
          const thumb = bodyEl.querySelector('[data-cover-thumb]');
          if (thumb) thumb.innerHTML = `<img src="${url}" alt="封面" />`;
        }).catch(() => {});
      }
      footEl.querySelector('[data-role="cancel"]').onclick = closeModal;
      footEl.querySelector('[data-role="save"]').onclick = async () => {
        try {
          await api.updateBookMeta({
            bookId,
            title: bodyEl.querySelector('#bmTitle').value.trim(),
            author: bodyEl.querySelector('#bmAuthor').value.trim(),
            genre: bodyEl.querySelector('#bmGenre').value.trim(),
            summary: bodyEl.querySelector('#bmSummary').value,
            coverColor: bodyEl.querySelector('#bmColor').value,
          });
          await applyCoverField(bookId, coverField, { silent: true });
          await refreshCoverState(bookId);
          closeModal();
          toast('资料已保存', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

export async function switchBook(bookId) {
  if (!await openBookInEditor(bookId)) return false;
  renderToc();
  const { renderCards } = await import('../cards.js');
  renderCards();
  return true;
}

export async function reloadWorkspace() {
  const ws = await api.workspace();
  const hasNativePickers = ws.hasNativePickers !== false;
  setState({
    settings: { ...state.settings, ...ws.settings },
    registry: ws.registry,
    storageDir: ws.storageDir,
    storageBytes: ws.storageBytes,
    location: ws.location || null,
    // 老后端没有这个字段时按"有选择器"处理，不影响桌面端
    hasNativePickers,
  });
  applyFonts();
  renderToc();
  const el = document.getElementById('storageLabel');
  if (el) el.textContent = `存储：${formatBytes(ws.storageBytes)}`;
  const openDirBtn = document.getElementById('openStorageDir');
  if (openDirBtn) openDirBtn.hidden = !hasNativePickers;
}
