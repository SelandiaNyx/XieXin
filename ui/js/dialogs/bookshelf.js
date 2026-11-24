// 书架与作品资料弹层、跨平台封面图片选择（桌面原生 + 手机 HTML File Input）、工作区重载。

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

// ------------------------------------------------------------------ 封面（桌面 + 手机双支持）

function coverFieldHtml(preview = '') {
  const thumb = `<span class="cover-thumb" data-cover-thumb>${preview ? `<img src="${escapeHtml(preview)}" alt="封面" />` : ''}</span>`;
  return `
    <div class="field full"><label>封面图片 <span class="hint">可选：不设就只用上面的颜色</span></label>
      <div class="cover-field">${thumb}
        <span class="cover-buttons">
          <button class="mini" type="button" data-cover-pick>选择图片…</button>
          <button class="mini" type="button" data-cover-clear>清除</button>
        </span>
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" data-cover-file hidden />
        <span class="hint" data-cover-hint></span>
      </div>
    </div>`;
}

function bindCoverField(bodyEl) {
  const thumb = bodyEl.querySelector('[data-cover-thumb]');
  const hint = bodyEl.querySelector('[data-cover-hint]');
  const pick = bodyEl.querySelector('[data-cover-pick]');
  const clear = bodyEl.querySelector('[data-cover-clear]');
  const fileInput = bodyEl.querySelector('[data-cover-file]');
  let pickedPath = '';
  let pickedBytes = null; // { ext, base64 }
  let cleared = false;

  const show = (url, name = '') => {
    if (thumb) thumb.innerHTML = url ? `<img src="${escapeHtml(url)}" alt="封面预览" />` : '';
    if (hint) hint.textContent = name ? `已选择：${name}` : '';
  };

  if (pick) {
    pick.onclick = async () => {
      if (state.hasNativePickers) {
        try {
          const path = await api.pickOpenFile('image');
          if (!path) return;
          const url = await api.previewCover(path);
          pickedPath = path;
          pickedBytes = null;
          cleared = false;
          show(url, path.split(/[\\/]/).pop() || path);
        } catch (e) { toast(e.message, 'err'); }
      } else if (fileInput) {
        fileInput.click();
      }
    };
  }

  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const ext = (file.name.split('.').pop() || 'png').toLowerCase();
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        const comma = dataUrl.indexOf(',');
        if (comma < 0) return;
        pickedPath = '';
        pickedBytes = { ext, base64: dataUrl.slice(comma + 1) };
        cleared = false;
        show(dataUrl, file.name);
      };
      reader.readAsDataURL(file);
    });
  }

  if (clear) {
    clear.onclick = () => {
      pickedPath = '';
      pickedBytes = null;
      cleared = true;
      show('');
      if (hint) hint.textContent = '保存后清除封面';
    };
  }

  return {
    pickedPath: () => pickedPath,
    pickedBytes: () => pickedBytes,
    cleared: () => cleared,
  };
}

async function applyCoverField(bookId, field, { silent = false } = {}) {
  const picked = field.pickedPath();
  if (picked) {
    const book = await api.setBookCover(bookId, picked);
    if (!silent) toast('封面已更新', 'ok');
    return book;
  }
  const bytes = field.pickedBytes();
  if (bytes) {
    const book = await api.setBookCoverBytes(bookId, bytes.ext, bytes.base64);
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

async function refreshCoverState(bookId) {
  const active = state.book && state.book.id === bookId;
  await reloadWorkspace();
  if (!active) return;
  const url = await api.bookCover(bookId).catch(() => '');
  setState({ bookCover: url || '' });
  renderToc();
}

// ------------------------------------------------------------------ 书架

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
              <div class="book-cover" style="background:${escapeHtml(b.coverColor || '#c0396f')}">${
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
    : `<div class="empty-note">书架还是空的，新建一本作品或先来本示例书体验一下吧～<br/><button type="button" class="mini" id="createSampleBtn" style="margin-top:8px">✨ 创建二次元示例作品</button></div>`;

  openModal({
    title: '书架',
    width: 'narrow',
    body: `<div class="book-list">${rows}</div>
      <div class="section-title">新建作品</div>
      <div class="form-grid">
        <div class="field"><label>书名</label><input id="nbTitle" type="text" placeholder="例如：星海下的约定时分" /></div>
        <div class="field"><label>作者</label><input id="nbAuthor" type="text" placeholder="笔名" /></div>
        <div class="field"><label>类型</label><input id="nbGenre" type="text" placeholder="轻小说 / 奇幻 / 都市 / 悬疑" /></div>
        <div class="field"><label>封面颜色</label><input id="nbColor" type="color" value="#c0396f" style="height:34px;padding:2px" /></div>
        ${coverFieldHtml()}
      </div>
      <input type="file" id="mobileBackupFile" accept=".json,application/json" hidden />`,
    footer: `<span class="spacer">本地目录：${escapeHtml(state.storageDir || '-')}</span>
             <button class="mini" data-role="import">导入备份</button>
             <button class="mini" data-role="close">关闭</button>
             <button class="primary" data-role="create">创建并打开</button>`,
    onMount(bodyEl, footEl) {
      bodyEl.querySelectorAll('[data-cover-for]').forEach(async (img) => {
        const url = await api.bookCover(img.dataset.coverFor).catch(() => '');
        if (url) img.src = url;
      });
      const coverField = bindCoverField(bodyEl);

      const sampleBtn = bodyEl.querySelector('#createSampleBtn');
      if (sampleBtn) {
        sampleBtn.onclick = async () => {
          try {
            const book = await api.createSampleBook();
            await reloadWorkspace();
            closeModal();
            await switchBook(book.id);
            toast(`已创建示例作品《${book.title}》`, 'ok');
          } catch (e) { toast(e.message, 'err'); }
        };
      }

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
      const mobileBackupInput = bodyEl.querySelector('#mobileBackupFile');
      if (importBtn) {
        importBtn.onclick = async () => {
          if (state.hasNativePickers) {
            try {
              const path = await api.pickOpenFile('json');
              if (!path) return;
              const book = await api.importBackup(path, true, null);
              await reloadWorkspace();
              closeModal();
              await switchBook(book.id);
              toast(`已从备份导入《${book.title}》`, 'ok');
            } catch (e) { toast(e.message, 'err'); }
          } else if (mobileBackupInput) {
            mobileBackupInput.click();
          }
        };
      }
      if (mobileBackupInput) {
        mobileBackupInput.addEventListener('change', async () => {
          const file = mobileBackupInput.files && mobileBackupInput.files[0];
          if (!file) return;
          try {
            const rawJson = await file.text();
            const book = await api.importBackup(null, true, rawJson);
            await reloadWorkspace();
            closeModal();
            await switchBook(book.id);
            toast(`已从备份导入《${book.title}》`, 'ok');
          } catch (e) { toast(e.message, 'err'); }
        });
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
        <div class="field"><label>封面颜色</label><input id="bmColor" type="color" value="${escapeHtml(book.coverColor || '#c0396f')}" style="height:34px;padding:2px" /></div>
        ${coverFieldHtml(bookId === state.book?.id ? state.bookCover : '')}
        <div class="field full"><label>简介（会同步提供给 AI 写心酱作为世界观参考）</label><textarea id="bmSummary" rows="4">${escapeHtml(book.summary || '')}</textarea></div>
      </div>
      <div class="section-title">统计</div>
      <div class="kv-list">
        <div class="kv"><span class="k">创建时间</span><span>${formatTime(book.createdAt)}</span></div>
        <div class="kv"><span class="k">最后更新</span><span>${formatTime(book.updatedAt)}</span></div>
        <div class="kv"><span class="k">总字数</span><span>${book.volumes.reduce((s, v) => s + v.chapters.reduce((x, c) => x + (c.charCount || 0), 0), 0).toLocaleString()}</span></div>
      </div>`,
    footer: `<button class="mini" data-role="dup">创建副本</button>
             <span class="spacer"></span>
             <button class="mini" data-role="cancel">取消</button>
             <button class="primary" data-role="save">保存</button>`,
    onMount(bodyEl, footEl) {
      const coverField = bindCoverField(bodyEl);
      if (book.coverImage && bookId !== state.book?.id) {
        api.bookCover(bookId).then((url) => {
          if (!url) return;
          const thumb = bodyEl.querySelector('[data-cover-thumb]');
          if (thumb) thumb.innerHTML = `<img src="${url}" alt="封面" />`;
        }).catch(() => {});
      }
      footEl.querySelector('[data-role="dup"]').onclick = async () => {
        try {
          const copy = await api.duplicateBook(bookId);
          await reloadWorkspace();
          closeModal();
          await switchBook(copy.id);
          toast(`已创建副本《${copy.title}》`, 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
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
  const mergedSettings = {
    ...state.settings,
    ...(ws.settings || {}),
    ai: { ...state.settings.ai, ...(ws.settings?.ai || {}) },
    webdav: { ...state.settings.webdav, ...(ws.settings?.webdav || {}) },
    lan: { ...state.settings.lan, ...(ws.settings?.lan || {}) },
  };
  setState({
    settings: mergedSettings,
    registry: ws.registry,
    storageDir: ws.storageDir,
    storageBytes: ws.storageBytes,
    location: ws.location || null,
    hasNativePickers,
    platform: ws.platform || state.platform,
    lanStatus: ws.lanStatus || state.lanStatus,
  });
  applyFonts();
  renderToc();
  const el = document.getElementById('storageLabel');
  if (el) el.textContent = `存储：${formatBytes(ws.storageBytes)}`;
  const openDirBtn = document.getElementById('openStorageDir');
  if (openDirBtn) openDirBtn.hidden = !hasNativePickers;
}
