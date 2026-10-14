// 稿件目录（保存位置）首次选择与迁移弹层。

import { api } from '../api.js';
import { state, setState } from '../store.js';
import { toast, openModal, closeModal, escapeHtml } from '../ui.js';
import { renderToc } from '../sidebar.js';
import { openBookPicker, switchBook, reloadWorkspace } from './bookshelf.js';

/** 换位置之后：内存里的书 / 章节 / 卡片都指着旧目录，清掉再按新目录的书架恢复。 */
async function refreshCurrentBook() {
  setState({ book: null, cards: [], bookCover: '', activeChapterId: '', activeVolumeId: '', content: '', versions: [] });
  const { clearEditor } = await import('../editor.js');
  clearEditor();
  const { renderCards } = await import('../cards.js');
  renderCards();
  const books = state.registry.books;
  if (books.length) await switchBook(books[0].id);
  else openBookPicker();
}

/**
 * 首次启动问一次"稿件存在哪里"，之后一直用选定的位置。
 *
 * 关掉弹层不会卡住启动：没选就继续用默认位置，下次启动再问。
 * 移动端（无原生目录选择器）固定使用应用私有目录，不弹此窗口。
 * @returns {Promise<boolean>} 是否真的确定了位置
 */
export function openLocationSetup() {
  if (!state.hasNativePickers) return Promise.resolve(false);
  const loc = state.location || {};
  const suggested = loc.suggested || loc.dir || '';
  return new Promise((resolve) => {
    let chosen = '';
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    openModal({
      title: '稿件存在哪里？',
      width: 'narrow',
      body: `
        <p style="margin:0 0 12px;font-size:13px;line-height:1.8">
          写心把所有稿件存在一个本地文件夹里，完全离线、不上传。先定一个位置，以后一直用它，
          也可以随时在「设置 → 存储」里更换。
        </p>
        ${loc.missing ? '<p class="hint" style="color:var(--warn);margin:0 0 10px">上次用的位置现在打不开（移动硬盘拔了？文件夹被删了？），先重新选一个。</p>' : ''}
        <div class="field"><label>稿件目录</label>
          <div class="path-row">
            <code data-loc-path>${escapeHtml(suggested)}</code>
            ${state.hasNativePickers ? '<button class="mini" type="button" data-loc-pick>选择文件夹…</button>' : ''}
          </div>
        </div>
        <div class="field"><span class="hint">默认位置在「文档」里，选别的盘或文件夹都可以。稿件、封面、历史版本都在这个目录下，拷走整个目录就是完整备份。</span></div>`,
      footer: `<button class="mini" data-role="default">用默认位置</button>
               <button class="primary" data-role="ok">就用这个文件夹</button>`,
      onMount(bodyEl, footEl) {
        const pathEl = bodyEl.querySelector('[data-loc-path]');
        const pick = bodyEl.querySelector('[data-loc-pick]');
        if (pick) {
          pick.onclick = async () => {
            try {
              const dir = await api.pickDirectory('选择稿件保存位置');
              if (!dir) return;
              chosen = dir;
              pathEl.textContent = dir;
            } catch (e) { toast(e.message, 'err'); }
          };
        }
        const apply = async (path) => {
          if (!path) { toast('还没有选择文件夹', 'warn'); return; }
          try {
            // 首次启动时旧目录是刚建出来的空壳，没有东西要搬
            await api.setStorageDir(path, false);
            finish(true);
            closeModal();
          } catch (e) { toast(e.message, 'err'); }
        };
        footEl.querySelector('[data-role="default"]').onclick = () => apply(suggested);
        footEl.querySelector('[data-role="ok"]').onclick = () => apply(chosen || suggested);
      },
      onClose: () => finish(false),
    });
  });
}

/**
 * 设置里更换位置：先让用户选文件夹，再问"旧稿件要不要一起搬过去"。
 * 三选一（搬过去 / 只切换 / 取消），所以不用 confirmDialog 那套两按钮的写法。
 */
export async function changeStorageDir() {
  if (!state.hasNativePickers) { toast('这个平台没有系统文件选择器，暂时改不了位置', 'warn'); return; }
  const dir = await api.pickDirectory('选择稿件保存位置');
  if (!dir) return;
  const from = state.location?.dir || state.storageDir || '';
  if (dir === from) { toast('这就是当前位置', 'warn'); return; }
  return new Promise((resolve) => {
    openModal({
      title: '更换稿件保存位置',
      width: 'narrow',
      body: `
        <p style="margin:0 0 10px;font-size:13px;line-height:1.8">新位置：<code style="word-break:break-all">${escapeHtml(dir)}</code></p>
        <div class="kv-list">
          <div class="kv"><span class="k">当前稿件目录</span><span style="word-break:break-all">${escapeHtml(from)}</span></div>
        </div>
        <p style="margin:12px 0 0;font-size:12.5px;line-height:1.8;color:var(--ink-soft)">
          · <b>搬过去</b>：把稿件、封面、历史版本整体移动到新位置，原位置不再保留（同盘很快，跨盘会复制后再删）；<br/>
          · <b>只切换位置</b>：新位置从空白开始，旧稿件留在原处不动。
        </p>`,
      footer: `<button class="mini" data-role="cancel">取消</button>
               <button class="mini" data-role="switch">只切换位置</button>
               <button class="primary" data-role="move">搬过去</button>`,
      onMount(bodyEl, footEl) {
        const run = async (moveData) => {
          closeModal();
          try {
            await api.setStorageDir(dir, moveData);
            await reloadWorkspace();
            renderToc();
            await refreshCurrentBook();
            toast(moveData ? '稿件已搬到新位置' : '已切换到新位置（旧稿件留在原处）', 'ok');
          } catch (e) { toast(e.message, 'err'); }
          resolve(true);
        };
        footEl.querySelector('[data-role="cancel"]').onclick = () => { closeModal(); resolve(false); };
        footEl.querySelector('[data-role="move"]').onclick = () => run(true);
        footEl.querySelector('[data-role="switch"]').onclick = () => run(false);
      },
      onClose: () => resolve(false),
    });
  });
}
