// 导出与最近导出记录弹层。

import { api } from '../api.js';
import { state, setState, findChapter } from '../store.js';
import {
  toast, openModal, closeModal, confirmDialog, escapeHtml, formatBytes, formatTime,
} from '../ui.js';
import { flushPendingSave } from '../editor.js';

export function openExport() {
  if (!state.book) { toast('请先选择一本书', 'warn'); return; }
  const s = state.settings;
  const chapter = findChapter(state.activeChapterId);
  openModal({
    title: '导出',
    width: 'narrow',
    body: `
      <div class="form-grid">
        <div class="field">
          <label>格式</label>
          <select id="exFormat">
            <option value="epub">EPUB 电子书（.epub，手机 / 阅读器可读）</option>
            <option value="txt">TXT 纯文本</option>
            <option value="md">Markdown</option>
            <option value="html">HTML 网页</option>
            <option value="json">JSON 完整备份（含历史版本与卡片）</option>
          </select>
          <span class="hint" id="exFormatHint">EPUB 自带目录与样式，可直接导入微信读书、Kindle（转格式）、多看等</span>
        </div>
        <div class="field">
          <label>范围</label>
          <select id="exScope">
            <option value="book">整本书</option>
            ${state.book.volumes.map((v) => `<option value="vol:${v.id}">仅《${escapeHtml(v.title)}》</option>`).join('')}
            ${chapter ? `<option value="ch:${chapter.id}">仅《${escapeHtml(chapter.title)}》</option>` : ''}
          </select>
        </div>
        <div class="field full">
          <label>保存位置</label>
          <div class="range-row">
            <input id="exPath" type="text" placeholder="留空则保存到数据目录/exports，并自动编号" value="" />
            ${state.hasNativePickers ? '<button class="mini" id="exBrowse">选择…</button>' : ''}
          </div>
          <span class="hint">最近导出目录：${escapeHtml(s.lastExportDir || '（未设置）')}</span>
        </div>
        <div class="field full" id="epubMeta" hidden>
          <label>电子书信息</label>
          <div class="form-grid">
            <div class="field"><label>书名</label><input id="epubTitle" type="text" value="${escapeHtml(state.book.title)}" /></div>
            <div class="field"><label>作者</label><input id="epubAuthor" type="text" value="${escapeHtml(state.book.author || '')}" /></div>
            <div class="field"><label>语言</label><input id="epubLang" type="text" value="zh-CN" /></div>
          </div>
        </div>
        <div class="field full">
          <div class="switch-row"><span>包含书名/作者/字数页眉</span>
            <label class="switch"><input type="checkbox" id="exMeta" checked /><i></i></label></div>
          <div class="switch-row"><span>包含卷标题</span>
            <label class="switch"><input type="checkbox" id="exVol" checked /><i></i></label></div>
          <div class="switch-row"><span>包含章节标题</span>
            <label class="switch"><input type="checkbox" id="exCh" checked /><i></i></label></div>
          <div class="switch-row"><span>中文段落缩进</span>
            <label class="switch"><input type="checkbox" id="exIndent" checked /><i></i></label></div>
        </div>
      </div>`,
    footer: `<button class="mini" data-role="recent">最近导出</button>
             <span class="spacer" id="exSummary"></span>
             <button class="mini" data-role="cancel">取消</button>
             <button class="primary" data-role="export">开始导出</button>`,
    onMount(bodyEl, footEl) {
      const buildOptions = () => {
        const scope = bodyEl.querySelector('#exScope').value;
        const opt = {
          format: bodyEl.querySelector('#exFormat').value,
          includeVolumeTitle: bodyEl.querySelector('#exVol').checked,
          includeChapterTitle: bodyEl.querySelector('#exCh').checked,
          includeMetaHeader: bodyEl.querySelector('#exMeta').checked,
          indentParagraphs: bodyEl.querySelector('#exIndent').checked,
          epubTitle: bodyEl.querySelector('#epubTitle').value.trim(),
          epubAuthor: bodyEl.querySelector('#epubAuthor').value.trim(),
          epubLanguage: bodyEl.querySelector('#epubLang').value.trim(),
          chapterId: scope.startsWith('ch:') ? scope.slice(3) : '',
          volumeId: scope.startsWith('vol:') ? scope.slice(4) : '',
          filePath: bodyEl.querySelector('#exPath').value.trim(),
          useDialog: false,
        };
        return opt;
      };
      const syncFormat = () => {
        const fmt = bodyEl.querySelector('#exFormat').value;
        bodyEl.querySelector('#epubMeta').hidden = fmt !== 'epub';
        const hints = {
          epub: 'EPUB 自带目录与样式，可直接导入微信读书、多看、Kindle（需转格式）等',
          txt: 'TXT 会写入 UTF-8 BOM，Windows 记事本打开不乱码',
          md: 'Markdown 适合再加工或发布到支持 md 的平台',
          html: 'HTML 是单文件网页，双击即可用浏览器阅读',
          json: 'JSON 是写心完整备份，含历史版本与卡片，可在书架里还原',
        };
        bodyEl.querySelector('#exFormatHint').textContent = hints[fmt] || '';
      };
      const refreshSummary = async () => {
        syncFormat();
        try {
          const name = await api.suggestFilename(state.book.id, buildOptions());
          footEl.querySelector('#exSummary').textContent = `默认文件名：${name}`;
        } catch { /* ignore */ }
      };
      const extOf = (fmt) =>
        fmt === 'md' ? 'md' : fmt === 'html' ? 'html' : fmt === 'json' ? 'json' : fmt === 'epub' ? 'epub' : 'txt';
      bodyEl.querySelector('#exScope').addEventListener('change', refreshSummary);
      bodyEl.querySelector('#exFormat').addEventListener('change', refreshSummary);
      const browseBtn = bodyEl.querySelector('#exBrowse');
      if (browseBtn) {
        browseBtn.addEventListener('click', async () => {
          const ext = extOf(bodyEl.querySelector('#exFormat').value);
          try {
            const name = await api.suggestFilename(state.book.id, buildOptions());
            const path = await api.pickSavePath(name, ext);
            if (path) bodyEl.querySelector('#exPath').value = path;
          } catch (e) { toast(e.message, 'err'); }
        });
      }
      syncFormat();
      footEl.querySelector('[data-role="cancel"]').onclick = closeModal;
      footEl.querySelector('[data-role="recent"]').onclick = () => openRecentExports();
      footEl.querySelector('[data-role="export"]').onclick = async () => {
        const opt = buildOptions();
        if ((opt.format === 'json') && (opt.chapterId || opt.volumeId)) {
          toast('JSON 备份只支持整本书导出', 'warn');
          return;
        }
        try {
          if (!await flushPendingSave()) return;
          const res = await api.exportBook(state.book.id, opt);
          const dir = res.path.replace(/[\\/][^\\/]*$/, '');
          const next = { ...state.settings, lastExportDir: dir };
          await api.saveSettings(next);
          setState({ settings: next });
          closeModal();
          toast(`导出成功：${res.chapters} 章 / ${res.chars.toLocaleString()} 字 / ${formatBytes(res.bytes)}`, 'ok', res.path);
          if (state.hasNativePickers) {
            const opened = await confirmDialog('导出完成', `文件已保存到：\n${res.path}\n\n要打开所在文件夹吗？`, { okText: '打开文件夹' });
            if (opened) api.openInExplorer(dir).catch(() => {});
          }
        } catch (e) { toast(`导出失败：${e.message}`, 'err'); }
      };
      refreshSummary();
    },
  });
}

export async function openRecentExports() {
  try {
    const list = await api.recentExports();
    state.recentExports = list;
    openModal({
      title: '最近导出',
      width: 'narrow',
      body: list.length
        ? `<div class="version-list">${list
            .map(
              (r) => `<div class="version-row" data-path="${escapeHtml(r.path)}">
                <div style="flex:1;min-width:0">
                  <div class="v-time" style="word-break:break-all">${escapeHtml(r.path)}</div>
                  <div class="v-meta">${escapeHtml(r.format.toUpperCase())} · ${formatBytes(r.bytes)} · ${formatTime(r.at)}</div>
                </div>
              </div>`,
            )
            .join('')}</div>`
        : '<div class="empty-note">还没有导出记录</div>',
      footer: '<button class="primary" data-role="ok">好</button>',
      onMount(bodyEl, footEl) {
        footEl.querySelector('[data-role="ok"]').onclick = closeModal;
        if (state.hasNativePickers) {
          bodyEl.querySelectorAll('.version-row').forEach((row) => {
            row.addEventListener('click', () => {
              api.openInExplorer(row.dataset.path.replace(/[\\/][^\\/]*$/, '')).catch(() => {});
            });
          });
        }
      },
    });
  } catch (e) { toast(e.message, 'err'); }
}
