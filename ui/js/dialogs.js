// 各类弹层：书籍选择、设置、导出、历史版本、统计、大纲、搜索、回收站、帮助。

import { api } from './api.js';
import {
  state, setState, chapters, findChapter, bookCharCount, bookChapterCount, statusInfo,
} from './store.js';
import {
  toast, openModal, closeModal, confirmDialog, promptDialog, escapeHtml,
  formatBytes, formatTime, relativeTime, hhmmss,
} from './ui.js';
import {
  saveChapter, applyFonts, restartAutosave, insertText, updateCounts, todayChars,
} from './editor.js';
import { refreshBook, renderToc } from './sidebar.js';

const KIND_LABEL = { character: '人物', plot: '剧情', inspiration: '灵光', world: '设定' };

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
              <div class="book-cover" style="background:${escapeHtml(b.coverColor || '#6c5ce7')}">${escapeHtml((b.title || '书')[0])}</div>
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
        <div class="field"><label>书名</label><input id="nbTitle" type="text" placeholder="例如：剑气长河" /></div>
        <div class="field"><label>作者</label><input id="nbAuthor" type="text" placeholder="笔名" /></div>
        <div class="field"><label>类型</label><input id="nbGenre" type="text" placeholder="玄幻 / 都市 / 悬疑" /></div>
        <div class="field"><label>封面颜色</label><input id="nbColor" type="color" value="#6c5ce7" style="height:34px;padding:2px" /></div>
      </div>`,
    footer: `<span class="spacer">数据保存在本地：${escapeHtml(state.storageDir || '-')}</span>
             <button class="mini" data-role="import">导入备份</button>
             <button class="mini" data-role="close">关闭</button>
             <button class="primary" data-role="create">新建并打开</button>`,
    onMount(bodyEl, footEl) {
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
              await api.deleteBook(id);
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
          await reloadWorkspace();
          closeModal();
          await switchBook(book.id);
          toast(`《${title}》已创建`, 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
      footEl.querySelector('[data-role="import"]').onclick = async () => {
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
          await reloadWorkspace();
          renderToc();
          closeModal();
          toast('资料已保存', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

export async function switchBook(bookId) {
  if (state.dirty) await saveChapter({ silent: true });
  try {
    const payload = await api.openBook(bookId);
    setState({ book: payload.book, cards: payload.cards, versions: [], activeChapterId: '', content: '' });
    const last = state.settings.lastChapterId;
    const all = payload.book.volumes.flatMap((v) => v.chapters);
    const target = all.find((c) => c.id === last) || all[0];
    if (target) await window.__moge.openChapter(target.id);
    renderToc();
    const { renderCards } = await import('./cards.js');
    renderCards();
  } catch (e) {
    toast(`打开书籍失败：${e.message}`, 'err');
  }
}

export async function reloadWorkspace() {
  const ws = await api.workspace();
  setState({
    settings: { ...state.settings, ...ws.settings },
    registry: ws.registry,
    storageDir: ws.storageDir,
    storageBytes: ws.storageBytes,
  });
  applyFonts();
  renderToc();
  const el = document.getElementById('storageLabel');
  if (el) el.textContent = `存储：${formatBytes(ws.storageBytes)}`;
}

// ------------------------------------------------------------------ 设置

export function openSettings() {
  const s = state.settings;
  openModal({
    title: '设置',
    body: `
      <div class="section-title">外观</div>
      <div class="form-grid">
        <div class="field">
          <label>主题</label>
          <select id="setTheme">
            ${THEMES.map(
              (t) =>
                `<option value="${t.id}" ${s.theme === t.id ? 'selected' : ''}>${t.label}</option>`,
            ).join('')}
          </select>
          <span class="hint">${THEMES.map((t) => t.label).length} 套配色，切换后立即生效</span>
        </div>
        <div class="field">
          <label>正文最大宽度</label>
          <div class="range-row">
            <input id="setWidth" type="range" min="520" max="1400" step="20" value="${s.editorWidth}" />
            <span class="val" id="setWidthVal">${s.editorWidth}px</span>
          </div>
        </div>
      </div>

      <div class="section-title">字体</div>
      <div class="form-grid">
        <div class="field full">
          <label>正文字体（可搜索系统字体）</label>
          <div class="font-picker">
            <div class="font-search-row">
              <input id="fontSearch" type="search" placeholder="搜索字体名，如 楷体 / Song / Noto…" />
              <button class="mini" id="rescanFonts">重新扫描</button>
            </div>
            <div class="font-current">当前：<b id="fontCurrent">${escapeHtml(s.fontFamily)}</b> · 系统已发现 <span id="fontCount">${state.fonts.length}</span> 个字体</div>
            <div class="font-list" id="fontList"></div>
            <div class="font-search-row">
              <input id="setFontCustom" type="text" placeholder="或直接填写 CSS 字体名 / 字体列表" />
              <button class="mini" id="applyCustomFont">使用</button>
            </div>
          </div>
        </div>
        <div class="field">
          <label>字号</label>
          <div class="range-row">
            <input id="setFontSize" type="range" min="12" max="34" step="0.5" value="${s.fontSize}" />
            <span class="val" id="setFontSizeVal">${s.fontSize}px</span>
          </div>
        </div>
        <div class="field">
          <label>行距</label>
          <div class="range-row">
            <input id="setLineHeight" type="range" min="1.2" max="3" step="0.05" value="${s.lineHeight}" />
            <span class="val" id="setLineHeightVal">${s.lineHeight}</span>
          </div>
        </div>
        <div class="field">
          <label>字间距</label>
          <div class="range-row">
            <input id="setLetterSpacing" type="range" min="-0.05" max="0.3" step="0.01" value="${s.letterSpacing}" />
            <span class="val" id="setLetterSpacingVal">${s.letterSpacing}em</span>
          </div>
        </div>
        <div class="field">
          <label>装新字体</label>
          <button class="mini" id="openFontsDir" style="margin-bottom:6px">打开系统字体文件夹</button>
          <span class="hint">把 .ttf/.otf 复制进去即安装（Windows 里双击也能装），然后点「重新扫描」就能选到它。</span>
        </div>
      </div>
      <div class="font-preview" id="fontPreview">远方有山，山上有雪，雪落无声。<br/>The quick brown fox jumps over the lazy dog. 1234567890</div>

      <div class="section-title">写作</div>
      <div class="form-grid">
        <div class="field">
          <label>自动保存间隔（秒）</label>
          <input id="setAutosave" type="number" min="5" max="600" value="${s.autosaveSecs}" />
        </div>
        <div class="field">
          <label>历史版本保留数量（每章）</label>
          <input id="setDepth" type="number" min="1" max="200" value="${s.historyDepth}" />
        </div>
        <div class="field">
          <label>生成新版本所需字数变化</label>
          <input id="setDelta" type="number" min="0" max="5000" value="${s.snapshotCharDelta}" />
          <span class="hint">改动累计超过该字数才会自动生成新版本，避免版本爆炸</span>
        </div>
        <div class="field">
          <label>每日目标字数</label>
          <input id="setGoal" type="number" min="100" max="50000" step="100" value="${s.dailyGoal}" />
        </div>
        <div class="field">
          <label>一键排版风格</label>
          <select id="setRule">
            <option value="cjk-indent" ${s.oneClickFormatRule === 'cjk-indent' ? 'selected' : ''}>中文缩进（段首两个全角空格）</option>
            <option value="blank-line" ${s.oneClickFormatRule === 'blank-line' ? 'selected' : ''}>网文风格（段首不缩进，段间空行）</option>
            <option value="tidy-only" ${s.oneClickFormatRule === 'tidy-only' ? 'selected' : ''}>仅清理空格与空行</option>
          </select>
        </div>
      </div>

      <div class="section-title">存储</div>
      <div class="kv-list">
        <div class="kv"><span class="k">数据目录</span><span style="word-break:break-all">${escapeHtml(state.storageDir)}</span></div>
        <div class="kv"><span class="k">占用空间</span><span id="setStorageSize">${formatBytes(state.storageBytes)}</span></div>
      </div>
      <div style="margin-top:8px;display:flex;gap:6px">
        <button class="mini" id="openDataDir">打开数据目录</button>
        <button class="mini" id="smokeTest">运行内置自检</button>
      </div>`,
    footer: `<button class="mini" data-role="preview">预览效果</button>
             <button class="mini" data-role="cancel">关闭</button>
             <button class="primary" data-role="save">保存设置</button>`,
    onMount(bodyEl, footEl) {
      const preview = bodyEl.querySelector('#fontPreview');
      const listEl = bodyEl.querySelector('#fontList');
      // 当前选中的字体族；保存时写回设置
      let chosen = s.fontFamily;

      const live = () => {
        preview.style.fontFamily = chosen;
        preview.style.fontSize = `${bodyEl.querySelector('#setFontSize').value}px`;
        preview.style.lineHeight = bodyEl.querySelector('#setLineHeight').value;
        preview.style.letterSpacing = `${bodyEl.querySelector('#setLetterSpacing').value}em`;
        bodyEl.querySelector('#fontCurrent').textContent = chosen;
      };
      const bindRange = (id, valId, suffix = '') => {
        const input = bodyEl.querySelector(id);
        const out = bodyEl.querySelector(valId);
        input.addEventListener('input', () => {
          out.textContent = `${input.value}${suffix}`;
          live();
        });
      };
      bindRange('#setWidth', '#setWidthVal', 'px');
      bindRange('#setFontSize', '#setFontSizeVal', 'px');
      bindRange('#setLineHeight', '#setLineHeightVal');
      bindRange('#setLetterSpacing', '#setLetterSpacingVal', 'em');

      // ---- 可搜索的字体列表（本地字体 + 常见中文字体）----
      const renderFontList = () => {
        const kw = (bodyEl.querySelector('#fontSearch').value || '').trim().toLowerCase();
        const seen = new Set();
        const items = [];
        const push = (name, file, isLocal) => {
          if (!name || seen.has(name)) return;
          seen.add(name);
          items.push({ name, file, isLocal });
        };
        localFontNames().forEach((name) => push(name, '', true));
        (state.fonts || []).forEach((f) => push(f.name, f.file, true));
        cjkPresets.forEach((name) => push(name, '', false));
        const filtered = (kw ? items.filter((it) => it.name.toLowerCase().includes(kw)) : items).slice(0, 260);
        listEl.innerHTML = filtered.length
          ? filtered
              .map(
                (it) =>
                  `<div class="font-opt ${it.name === chosen ? 'active' : ''}" data-font="${escapeHtml(it.name)}">
                     <span style="font-family:'${escapeHtml(it.name)}'">${escapeHtml(it.name)}</span>
                     <span class="f-tag">${it.file ? escapeHtml(it.file) : ''}</span>
                   </div>`,
              )
              .join('')
          : '<div class="empty-note">没有匹配的字体</div>';
        listEl.querySelectorAll('.font-opt').forEach((row) => {
          row.onclick = () => {
            chosen = row.dataset.font;
            listEl.querySelectorAll('.font-opt').forEach((r) => r.classList.toggle('active', r === row));
            live();
          };
        });
      };

      bodyEl.querySelector('#fontSearch').addEventListener('input', renderFontList);
      bodyEl.querySelector('#applyCustomFont').addEventListener('click', () => {
        const v = bodyEl.querySelector('#setFontCustom').value.trim();
        if (!v) return;
        chosen = v;
        live();
        toast(`已选择字体：${v}`, 'ok');
      });
      bodyEl.querySelector('#rescanFonts').addEventListener('click', async () => {
        try {
          await loadFonts(true);
          bodyEl.querySelector('#fontCount').textContent = `${state.fonts.length}`;
          renderFontList();
          toast(`已扫描到 ${state.fonts.length} 个系统字体`, 'ok');
        } catch (e) {
          toast(e.message, 'err');
        }
      });
      bodyEl.querySelector('#openFontsDir').addEventListener('click', async () => {
        try {
          await api.openInExplorer('C:\\Windows\\Fonts');
        } catch (e) {
          toast(e.message, 'err');
        }
      });
      renderFontList();
      live();

      bodyEl.querySelector('#openDataDir').addEventListener('click', async () => {
        try { await api.openInExplorer(state.storageDir); } catch (e) { toast(e.message, 'err'); }
      });
      bodyEl.querySelector('#smokeTest').addEventListener('click', async () => {
        try {
          const report = await api.smokeTest();
          openModal({
            title: '内置自检结果',
            body: `<pre style="white-space:pre-wrap;font-size:12px;line-height:1.7;margin:0">${escapeHtml(report)}</pre>`,
            footer: '<button class="primary" data-role="ok">好</button>',
            onMount(b, f) { f.querySelector('[data-role="ok"]').onclick = closeModal; },
          });
        } catch (e) { toast(e.message, 'err'); }
      });
      footEl.querySelector('[data-role="cancel"]').onclick = closeModal;
      footEl.querySelector('[data-role="preview"]').onclick = () => {
        // 用当前对话框里的选择（尚未保存）做一次整体预览
        openStylePreview({
          ...state.settings,
          theme: bodyEl.querySelector('#setTheme').value,
          fontFamily: chosen,
          fontSize: Number(bodyEl.querySelector('#setFontSize').value),
          lineHeight: Number(bodyEl.querySelector('#setLineHeight').value),
          letterSpacing: Number(bodyEl.querySelector('#setLetterSpacing').value),
          editorWidth: Number(bodyEl.querySelector('#setWidth').value),
        });
      };
      footEl.querySelector('[data-role="save"]').onclick = async () => {
        const next = {
          ...state.settings,
          theme: bodyEl.querySelector('#setTheme').value,
          fontFamily: chosen,
          fontSize: Number(bodyEl.querySelector('#setFontSize').value),
          lineHeight: Number(bodyEl.querySelector('#setLineHeight').value),
          letterSpacing: Number(bodyEl.querySelector('#setLetterSpacing').value),
          editorWidth: Number(bodyEl.querySelector('#setWidth').value),
          autosaveSecs: Number(bodyEl.querySelector('#setAutosave').value),
          historyDepth: Number(bodyEl.querySelector('#setDepth').value),
          snapshotCharDelta: Number(bodyEl.querySelector('#setDelta').value),
          dailyGoal: Number(bodyEl.querySelector('#setGoal').value),
          oneClickFormatRule: bodyEl.querySelector('#setRule').value,
        };
        try {
          const saved = await api.saveSettings(next);
          setState({ settings: { ...next, ...saved } });
          applyFonts();
          restartAutosave();
          closeModal();
          toast('设置已保存', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
      live();
    },
  });
}

/** 系统里一定能用到的中文字体名（用于补齐字体搜索列表）。 */
const cjkPresets = [
  '霞鹜文楷', 'LXGW WenKai', '思源宋体', 'Source Han Serif SC', 'Source Han Sans SC',
  'Microsoft YaHei', '微软雅黑', 'SimSun', '宋体', 'SimHei', '黑体', 'KaiTi', '楷体',
  'FangSong', '仿宋', 'Noto Serif SC', 'Noto Sans SC', 'PingFang SC', 'Songti SC',
  'HarmonyOS Sans SC', 'Alibaba PuHuiTi', '方正书宋', '华文楷体',
];

/** 已安装字体族名（从扫描结果里提取）。 */
function localFontNames() {
  return (state.fonts || []).map((f) => f.name);
}

/** 主题清单：与 styles.css 中的 html[data-theme=...] 一一对应。 */
export const THEMES = [
  { id: 'light', label: '浅色（默认）' },
  { id: 'sepia', label: '羊皮纸' },
  { id: 'dark', label: '暗色' },
  { id: 'md3', label: 'Material Design 3 亮色' },
  { id: 'md3-dark', label: 'Material Design 3 暗色' },
  { id: 'mono', label: '极简黑白' },
  { id: 'forest', label: '青绿护眼' },
];

export async function loadFonts(force = false) {
  if (state.fonts.length && !force) return state.fonts;
  try {
    const fonts = await api.listFonts();
    setState({ fonts });
    return fonts;
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ 导出

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
            <button class="mini" id="exBrowse">选择…</button>
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
      bodyEl.querySelector('#exBrowse').addEventListener('click', async () => {
        const ext = extOf(bodyEl.querySelector('#exFormat').value);
        try {
          const name = await api.suggestFilename(state.book.id, buildOptions());
          const path = await api.pickSavePath(name, ext);
          if (path) bodyEl.querySelector('#exPath').value = path;
        } catch (e) { toast(e.message, 'err'); }
      });
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
          const res = await api.exportBook(state.book.id, opt);
          const dir = res.path.replace(/[\\/][^\\/]*$/, '');
          const next = { ...state.settings, lastExportDir: dir };
          await api.saveSettings(next);
          setState({ settings: next });
          closeModal();
          toast(`导出成功：${res.chapters} 章 / ${res.chars.toLocaleString()} 字 / ${formatBytes(res.bytes)}`, 'ok', res.path);
          const opened = await confirmDialog('导出完成', `文件已保存到：\n${res.path}\n\n要打开所在文件夹吗？`, { okText: '打开文件夹' });
          if (opened) api.openInExplorer(dir).catch(() => {});
        } catch (e) { toast(`导出失败：${e.message}`, 'err'); }
      };
      refreshSummary();
    },
  });
}

async function openRecentExports() {
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
        bodyEl.querySelectorAll('.version-row').forEach((row) => {
          row.addEventListener('click', () => {
            api.openInExplorer(row.dataset.path.replace(/[\\/][^\\/]*$/, '')).catch(() => {});
          });
        });
      },
    });
  } catch (e) { toast(e.message, 'err'); }
}

/** 主题 / 字体预览：用下拉框实时切换主题与字体，整体界面 + 正文样例同步变化。 */
export function openStylePreview(draft) {
  const originalTheme = document.documentElement.getAttribute('data-theme');
  const originalStyle = document.documentElement.getAttribute('style') || '';
  const sample = [
    '雪落下来了。',
    '沈孤鸿站在城墙上，看着远处连绵的灯火。风从北面吹来，卷起他衣角的一片霜色。',
    '“你还是来了。”身后传来一个声音。',
    '他没有回头，只是把手按在刀柄上：“我等这一天，等了十年。”',
  ];
  // 可选字体：系统扫描结果 + 常见中文字体，去重排序
  const fontPool = (() => {
    const names = new Set();
    (state.fonts || []).forEach((f) => names.add(f.name));
    cjkPresets.forEach((n) => names.add(n));
    if (draft.fontFamily) names.add(draft.fontFamily);
    return [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  })();

  const applyDraft = () => {
    const root = document.documentElement;
    root.setAttribute('data-theme', draft.theme);
    root.style.setProperty('--font-body', draft.fontFamily);
    root.style.setProperty('--font-size', `${draft.fontSize}px`);
    root.style.setProperty('--line-height', String(draft.lineHeight));
    root.style.setProperty('--letter-spacing', `${draft.letterSpacing}em`);
    root.style.setProperty('--editor-width', `${draft.editorWidth}px`);
    const themeLabel = (THEMES.find((t) => t.id === draft.theme) || { label: draft.theme }).label;
    document.getElementById('modalTitle').textContent =
      `预览 · ${themeLabel} · ${String(draft.fontFamily).split(',')[0]}`;
    const info = document.getElementById('previewInfo');
    if (info) {
      info.innerHTML =
        `<div class="kv"><span class="k">主题</span><span>${escapeHtml(themeLabel)}</span></div>` +
        `<div class="kv"><span class="k">正文字体</span><span>${escapeHtml(draft.fontFamily)}</span></div>` +
        `<div class="kv"><span class="k">字号 / 行距 / 字距 / 栏宽</span><span>${draft.fontSize}px · ${draft.lineHeight} · ${draft.letterSpacing}em · ${draft.editorWidth}px</span></div>`;
    }
  };

  openModal({
    title: '预览',
    width: 'wide',
    body: `
      <div class="preview-controls">
        <label class="pc-field"><span>主题</span>
          <select id="pvTheme">
            ${THEMES.map((t) => `<option value="${t.id}" ${t.id === draft.theme ? 'selected' : ''}>${t.label}</option>`).join('')}
          </select>
        </label>
        <label class="pc-field pc-font"><span>字体</span>
          <select id="pvFont">
            ${fontPool
              .map(
                (n) =>
                  `<option value="${escapeHtml(n)}" ${n === draft.fontFamily ? 'selected' : ''}>${escapeHtml(n)}</option>`,
              )
              .join('')}
          </select>
        </label>
        <span class="pc-hint">切换后立即生效，关闭预览会恢复成保存前的样子</span>
      </div>

      <div class="preview-frame">
        <aside class="preview-side">
          <div class="preview-book">
            <span class="preview-dot"></span>
            <div><strong>剑气长河</strong><small>2 卷 · 4 章 · 200 字</small></div>
          </div>
          <div class="preview-toc">
            <div class="preview-vol">第一卷 风起</div>
            <div class="preview-ch active"><span class="status-pill published"></span>第一章 雪夜</div>
            <div class="preview-ch"><span class="status-pill revising"></span>第二章 旧约</div>
            <div class="preview-vol">第二卷 落子</div>
            <div class="preview-ch"><span class="status-pill draft"></span>第三章 落子</div>
          </div>
          <div class="preview-chips">
            <span>新建章</span><span>全文搜索</span><span>大纲视图</span><span>导入文本</span>
          </div>
        </aside>
        <main class="preview-main">
          <div class="preview-top">
            <span class="preview-crumb">第一卷 风起 / </span>
            <b>第一章 雪夜</b>
            <span class="preview-status">已发布</span>
          </div>
          <div class="preview-paper">
            <h3>第一章 雪夜</h3>
            ${sample.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}
          </div>
          <div class="preview-sidebar-right">
            <div class="preview-card" style="--card-color:#8ab4f8"><b>沈孤鸿</b><span>主角，沉默寡言。</span></div>
            <div class="preview-card" style="--card-color:#f5a623"><b>雪夜伏击</b><span>第三章埋伏笔。</span></div>
          </div>
        </main>
      </div>

      <div class="preview-fonts">
        <div class="section-title" style="margin-top:0">字体对比（同一段文字，三种字号）</div>
        <div class="preview-font-row" style="font-size:calc(var(--font-size) * 1.25)">第一章 雪夜 · 山有木兮木有枝</div>
        <div class="preview-font-row">沈孤鸿站在城墙上，看着远处连绵的灯火。风从北面吹来，卷起他衣角的一片霜色。</div>
        <div class="preview-font-row" style="font-size:calc(var(--font-size) * 0.8)">0123456789 · The quick brown fox jumps over the lazy dog.</div>
      </div>

      <div class="kv-list" id="previewInfo" style="margin-top:10px"></div>`,
    footer: `<button class="mini" data-role="apply">按预览保存</button>
             <span class="spacer">不满意就直接关闭，不会改动已保存的设置</span>
             <button class="primary" data-role="close">关闭预览</button>`,
    onMount(bodyEl, footEl) {
      applyDraft();
      bodyEl.querySelector('#pvTheme').onchange = (e) => {
        draft.theme = e.target.value;
        applyDraft();
      };
      bodyEl.querySelector('#pvFont').onchange = (e) => {
        draft.fontFamily = e.target.value;
        applyDraft();
      };
      footEl.querySelector('[data-role="close"]').onclick = () => closeModal();
      footEl.querySelector('[data-role="apply"]').onclick = async () => {
        try {
          const saved = await api.saveSettings({ ...state.settings, ...draft });
          setState({ settings: { ...state.settings, ...draft, ...saved } });
          applyFonts();
          closeModal();
          toast('已按预览保存设置', 'ok');
        } catch (e) {
          toast(e.message, 'err');
        }
      };
    },
    onClose() {
      // 恢复进入预览前的样式
      if (originalTheme) document.documentElement.setAttribute('data-theme', originalTheme);
      document.documentElement.setAttribute('style', originalStyle);
      applyFonts();
    },
  });
}

// ------------------------------------------------------------------ 历史版本

export async function openHistory() {
  if (!state.book || !state.activeChapterId) { toast('请先打开一章', 'warn'); return; }
  const chapterId = state.activeChapterId;
  const bookId = state.book.id;
  let versions = [];
  try {
    versions = await api.listVersions(bookId, chapterId);
  } catch (e) { toast(e.message, 'err'); return; }
  const ch = findChapter(chapterId);

  const rows = versions.length
    ? versions
        .map(
          (v) => `<div class="version-row" data-version-id="${v.id}">
            <span class="version-kind ${v.kind}">${kindLabel(v.kind)}</span>
            <div style="flex:1;min-width:0">
              <div class="v-time">${relativeTime(v.createdAt)} <span class="v-meta">${formatTime(v.createdAt)}</span></div>
              <div class="v-meta">${escapeHtml(v.label || '')}</div>
            </div>
            <span class="v-chars">${v.chars.toLocaleString()} 字</span>
          </div>`,
        )
        .join('')
    : '<div class="empty-note">本章还没有历史版本。<br/>编辑后自动保存或按 Ctrl+Shift+S 手动打快照即可生成。</div>';

  openModal({
    title: `历史版本 · ${ch ? ch.title : ''}`,
    width: 'wide',
    body: `<div style="display:grid;grid-template-columns:300px 1fr;gap:14px">
        <div class="version-list" id="versionList">${rows}</div>
        <div id="versionDetail" class="empty-note">选择左侧任一版本查看对比</div>
      </div>`,
    footer: `<span class="spacer">共 ${versions.length} 个版本（保留上限可在设置中调整）</span>
             <button class="mini" data-role="close">关闭</button>`,
    onMount(bodyEl, footEl) {
      footEl.querySelector('[data-role="close"]').onclick = closeModal;
      const detail = bodyEl.querySelector('#versionDetail');
      bodyEl.querySelectorAll('.version-row').forEach((row) => {
        row.addEventListener('click', async () => {
          bodyEl.querySelectorAll('.version-row').forEach((r) => r.classList.remove('active'));
          row.classList.add('active');
          const vid = row.dataset.versionId;
          detail.innerHTML = '<div class="empty-note">加载中…</div>';
          try {
            const d = await api.versionDetail(bookId, chapterId, vid);
            const { left, right } = diffHtml(d.content, d.current);
            detail.innerHTML = `
              <div class="kv-list" style="margin-bottom:8px">
                <div class="kv"><span class="k">版本时间</span><span>${formatTime(d.meta.createdAt)}</span></div>
                <div class="kv"><span class="k">版本字数</span><span>${d.meta.chars.toLocaleString()} → 当前 ${(d.current.length ? d.current : '').length}</span></div>
              </div>
              <div style="display:flex;gap:6px;margin-bottom:8px">
                <button class="mini" id="restoreBtn">回滚到此版本</button>
                <button class="mini" id="copyBtn">复制版本内容</button>
                <button class="mini" id="delBtn" style="color:var(--danger)">删除该版本</button>
              </div>
              <div class="diff-view">
                <div class="diff-pane"><h5>历史版本（- 表示已删除）</h5><pre class="diff-text">${left}</pre></div>
                <div class="diff-pane"><h5>当前正文（+ 表示新增）</h5><pre class="diff-text">${right}</pre></div>
              </div>`;
            detail.querySelector('#restoreBtn').onclick = async () => {
              const ok = await confirmDialog('回滚版本', '当前正文会先被存为一个新版本，然后回滚到你选择的历史版本。继续吗？', { okText: '回滚' });
              if (!ok) return;
              try {
                await api.restoreVersion(bookId, chapterId, vid);
                closeModal();
                await window.__moge.openChapter(chapterId);
                await refreshBook();
                toast('已回滚到历史版本', 'ok');
              } catch (e) { toast(e.message, 'err'); }
            };
            detail.querySelector('#copyBtn').onclick = async () => {
              try {
                await navigator.clipboard.writeText(d.content);
                toast('版本内容已复制到剪贴板', 'ok');
              } catch {
                toast('复制失败，请手动选择文本', 'warn');
              }
            };
            detail.querySelector('#delBtn').onclick = async () => {
              const ok = await confirmDialog('删除版本', '删除后无法恢复，确定吗？', { okText: '删除', danger: true });
              if (!ok) return;
              try {
                await api.deleteVersion(bookId, chapterId, vid);
                closeModal();
                openHistory();
                toast('版本已删除', 'ok');
              } catch (e) { toast(e.message, 'err'); }
            };
          } catch (e) {
            detail.innerHTML = `<div class="empty-note">加载失败：${escapeHtml(e.message)}</div>`;
          }
        });
      });
    },
  });
}

function kindLabel(kind) {
  return { auto: '自动', manual: '手动', restore: '回滚', import: '导入', current: '当前' }[kind] || kind;
}

/** 逐行 LCS 差异，输出两侧 HTML。 */
function diffHtml(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;
  const MAX = 900;
  if (n * m > 250000 || n > MAX || m > MAX) {
    return { left: escapeHtml(oldText), right: escapeHtml(newText) };
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const left = [];
  const right = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      left.push(escapeHtml(a[i]));
      right.push(escapeHtml(b[j]));
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      left.push(`<del>${escapeHtml(a[i]) || '&nbsp;'}</del>`);
      i += 1;
    } else {
      right.push(`<ins>${escapeHtml(b[j]) || '&nbsp;'}</ins>`);
      j += 1;
    }
  }
  while (i < n) { left.push(`<del>${escapeHtml(a[i]) || '&nbsp;'}</del>`); i += 1; }
  while (j < m) { right.push(`<ins>${escapeHtml(b[j]) || '&nbsp;'}</ins>`); j += 1; }
  return { left: left.join('\n'), right: right.join('\n') };
}

// ------------------------------------------------------------------ 统计

export async function openStats() {
  if (!state.book) { toast('请先选择一本书', 'warn'); return; }
  let stats;
  try {
    stats = await api.bookStats(state.book.id);
  } catch (e) { toast(e.message, 'err'); return; }
  const today = todayChars();
  const goal = Number(state.settings.dailyGoal) || 3000;
  const pct = Math.min(100, Math.round((today / goal) * 100));
  const chapter = findChapter(state.activeChapterId);
  const chapterChars = chapter ? chapter.charCount || 0 : 0;
  const chaptersList = chapters();
  const longest = chaptersList.slice().sort((a, b) => (b.charCount || 0) - (a.charCount || 0))[0];

  openModal({
    title: '字数统计',
    width: 'narrow',
    body: `
      <div class="stat-grid">
        <div class="stat-card"><div class="k">全书字数</div><div class="v">${stats.charCount.toLocaleString()}</div></div>
        <div class="stat-card"><div class="k">本章字数</div><div class="v">${chapterChars.toLocaleString()}</div></div>
        <div class="stat-card"><div class="k">今日字数</div><div class="v">${today.toLocaleString()}</div></div>
      </div>
      <div class="section-title">每日目标（${goal.toLocaleString()} 字）</div>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <div class="kv" style="margin-top:6px"><span class="k">完成度</span><span>${pct}%（还差 ${Math.max(0, goal - today).toLocaleString()} 字）</span></div>
      <div class="section-title">作品概况</div>
      <div class="kv-list">
        <div class="kv"><span class="k">卷 / 章</span><span>${stats.volumes} 卷 · ${stats.chapters} 章</span></div>
        <div class="kv"><span class="k">中文字符</span><span>${stats.cjk.toLocaleString()}</span></div>
        <div class="kv"><span class="k">英文单词</span><span>${stats.words.toLocaleString()}</span></div>
        <div class="kv"><span class="k">历史版本总数</span><span>${stats.versions}</span></div>
        <div class="kv"><span class="k">卡片数量</span><span>${stats.cards}</span></div>
        <div class="kv"><span class="k">平均每章</span><span>${stats.chapters ? Math.round(stats.charCount / stats.chapters).toLocaleString() : 0} 字</span></div>
        <div class="kv"><span class="k">最长章节</span><span>${longest ? `${escapeHtml(longest.title)}（${(longest.charCount || 0).toLocaleString()} 字）` : '-'}</span></div>
        <div class="kv"><span class="k">本次会话新增</span><span>${state.sessionChars.toLocaleString()} 字</span></div>
        <div class="kv"><span class="k">数据占用</span><span>${formatBytes(state.storageBytes)}</span></div>
      </div>`,
    footer: `<button class="mini" data-role="refresh">刷新</button><button class="primary" data-role="ok">好</button>`,
    onMount(bodyEl, footEl) {
      footEl.querySelector('[data-role="ok"]').onclick = closeModal;
      footEl.querySelector('[data-role="refresh"]').onclick = () => { closeModal(); openStats(); };
    },
  });
}

// ------------------------------------------------------------------ 大纲

export function openOutline() {
  if (!state.book) { toast('请先选择一本书', 'warn'); return; }
  const rows = state.book.volumes
    .map((v) => {
      const volChars = v.chapters.reduce((s, c) => s + (c.charCount || 0), 0);
      const head = `<tr data-volume-id="${v.id}"><td colspan="5" style="background:var(--accent-soft);font-weight:600">
          ${escapeHtml(v.title)} · ${v.chapters.length} 章 · ${volChars.toLocaleString()} 字</td></tr>`;
      const body = v.chapters
        .map(
          (c) => `<tr data-chapter-id="${c.id}">
            <td>${escapeHtml(c.title)}</td>
            <td class="num">${(c.charCount || 0).toLocaleString()}</td>
            <td class="num">${c.versions || 0}</td>
            <td><span class="status-pill" style="display:inline-block;background:${escapeHtml(statusInfo(c.status).color)};margin-right:6px"></span>${escapeHtml(statusInfo(c.status).label)}</td>
            <td>${escapeHtml(c.summary || '')}</td>
          </tr>`,
        )
        .join('');
      return head + body;
    })
    .join('');
  const total = bookCharCount();
  openModal({
    title: `大纲 · ${state.book.title}`,
    width: 'wide',
    body: `<div class="kv-list" style="margin-bottom:10px">
        <div class="kv"><span class="k">总字数</span><span>${total.toLocaleString()}</span></div>
        <div class="kv"><span class="k">章节数</span><span>${bookChapterCount()}</span></div>
      </div>
      <table class="outline-table">
        <thead><tr><th>章节</th><th style="text-align:right">字数</th><th style="text-align:right">版本</th><th>状态</th><th>概要</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5">还没有章节</td></tr>'}</tbody>
      </table>`,
    footer: `<span class="spacer">双击行可跳转</span><button class="primary" data-role="ok">好</button>`,
    onMount(bodyEl, footEl) {
      footEl.querySelector('[data-role="ok"]').onclick = closeModal;
      bodyEl.querySelectorAll('tr[data-chapter-id]').forEach((tr) => {
        tr.addEventListener('click', async () => {
          closeModal();
          await window.__moge.openChapter(tr.dataset.chapterId);
        });
      });
    },
  });
}

// ------------------------------------------------------------------ 搜索

export function openSearch() {
  if (!state.book) { toast('请先选择一本书', 'warn'); return; }
  openModal({
    title: '全文搜索',
    body: `<div class="field"><input id="searchInput" type="search" placeholder="输入关键词，回车搜索（章节正文 + 卡片）" /></div>
           <div id="searchResults" style="margin-top:12px"></div>`,
    footer: '<button class="mini" data-role="close">关闭</button>',
    onMount(bodyEl, footEl) {
      footEl.querySelector('[data-role="close"]').onclick = closeModal;
      const input = bodyEl.querySelector('#searchInput');
      const out = bodyEl.querySelector('#searchResults');
      const run = async () => {
        const kw = input.value.trim();
        if (!kw) { out.innerHTML = ''; return; }
        out.innerHTML = '<div class="empty-note">搜索中…</div>';
        const hits = [];
        for (const ch of chapters()) {
          try {
            const res = await api.readChapter(state.book.id, ch.id);
            const lower = res.content.toLowerCase();
            const k = kw.toLowerCase();
            let idx = lower.indexOf(k);
            let count = 0;
            while (idx >= 0 && count < 5) {
              count += 1;
              idx = lower.indexOf(k, idx + k.length);
            }
            if (count > 0) {
              const at = lower.indexOf(k);
              const from = Math.max(0, at - 30);
              hits.push({
                type: 'chapter',
                id: ch.id,
                title: ch.title,
                where: `${ch.volumeTitle} · 命中 ${count} 处`,
                snippet: `${res.content.slice(from, at)}<mark>${res.content.slice(at, at + kw.length)}</mark>${res.content.slice(at + kw.length, at + kw.length + 40)}`,
              });
            }
          } catch { /* ignore */ }
        }
        state.cards.forEach((c) => {
          const hay = `${c.title}\n${c.content}\n${(c.tags || []).join(' ')}`;
          if (hay.toLowerCase().includes(kw.toLowerCase())) {
            hits.push({
              type: 'card',
              id: c.id,
              title: c.title,
              where: `卡片 · ${KIND_LABEL[c.kind] || c.kind}`,
              snippet: escapeHtml(c.content.slice(0, 90)),
            });
          }
        });
        out.innerHTML = hits.length
          ? `<div class="hit-list">${hits
              .map(
                (hit, i) => `<div class="hit" data-index="${i}">
                  <div class="hit-where">${escapeHtml(hit.where)}</div>
                  <div><b>${escapeHtml(hit.title)}</b></div>
                  <div style="color:var(--ink-soft);margin-top:4px">…${hit.snippet}…</div>
                </div>`,
              )
              .join('')}</div>`
          : '<div class="empty-note">没有找到匹配内容</div>';
        out.querySelectorAll('.hit').forEach((el) => {
          el.addEventListener('click', async () => {
            const hit = hits[Number(el.dataset.index)];
            if (hit.type === 'chapter') {
              closeModal();
              await window.__moge.openChapter(hit.id);
            } else {
              const { renderCards } = await import('./cards.js');
              const card = state.cards.find((c) => c.id === hit.id);
              setState({ cardKind: card.kind, activeCardId: card.id, cardSearch: '' });
              renderCards();
              toast('已在右侧定位该卡片', 'ok');
            }
          });
        });
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
      void run;
    },
  });
}

// ------------------------------------------------------------------ 查找替换（编辑区内）

export function toggleFindBar(show) {
  const bar = document.getElementById('findBar');
  bar.hidden = show === undefined ? !bar.hidden : !show;
  if (!bar.hidden) document.getElementById('findInput').focus();
}

export function initFindBar() {
  const bar = document.getElementById('findBar');
  const findInput = document.getElementById('findInput');
  const replaceInput = document.getElementById('replaceInput');
  const caseSensitive = document.getElementById('caseSensitive');
  document.getElementById('closeFind').onclick = () => { bar.hidden = true; };
  const editor = () => document.getElementById('editor');

  const findNext = () => {
    const kw = findInput.value;
    if (!kw) return;
    const view = editor();
    const hay = caseSensitive.checked ? view.value : view.value.toLowerCase();
    const needle = caseSensitive.checked ? kw : kw.toLowerCase();
    const from = view.selectionEnd;
    let idx = hay.indexOf(needle, from);
    if (idx < 0) idx = hay.indexOf(needle, 0);
    if (idx < 0) { toast('没有找到匹配内容', 'warn'); return; }
    view.focus();
    view.setSelectionRange(idx, idx + kw.length);
    const line = view.value.slice(0, idx).split('\n').length;
    const lineHeight = parseFloat(getComputedStyle(view).lineHeight) || 34;
    document.getElementById('editorWrap').scrollTop = Math.max(0, (line - 4) * lineHeight);
  };

  document.getElementById('findNext').onclick = findNext;
  findInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') findNext(); });
  document.getElementById('replaceOne').onclick = () => {
    const view = editor();
    const kw = findInput.value;
    if (!kw) return;
    const hay = caseSensitive.checked ? view.value : view.value.toLowerCase();
    const needle = caseSensitive.checked ? kw : kw.toLowerCase();
    const sel = view.value.slice(view.selectionStart, view.selectionEnd);
    if (sel && (caseSensitive.checked ? sel === kw : sel.toLowerCase() === kw.toLowerCase())) {
      const start = view.selectionStart;
      view.setSelectionRange(start, view.selectionEnd);
      insertText(replaceInput.value);
      updateCounts();
    }
    void hay;
    void needle;
    findNext();
  };
  document.getElementById('replaceAllBtn').onclick = async () => {
    const view = editor();
    const kw = findInput.value;
    if (!kw) return;
    try {
      const [text, report] = await api.replaceAll(view.value, kw, replaceInput.value, caseSensitive.checked);
      view.value = text;
      view.dispatchEvent(new Event('input', { bubbles: true }));
      updateCounts();
      toast(`已替换 ${report.replaced} 处（${report.beforeChars} → ${report.afterChars} 字）`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
}

// ------------------------------------------------------------------ 回收站

export async function openTrash() {
  try {
    const list = await api.listTrash();
    openModal({
      title: '回收站',
      body: list.length
        ? `<div style="display:flex;flex-direction:column;gap:6px">${list
            .map(
              (t) => `<div class="trash-row">
                <span class="t-name">${escapeHtml(t.name)}</span>
                <span class="t-size">${formatBytes(t.size)} · ${formatTime(t.deletedAt)}</span>
                <button class="mini" data-role="open" data-path="${escapeHtml(t.path)}">定位</button>
              </div>`,
            )
            .join('')}</div>`
        : '<div class="empty-note">回收站是空的</div>',
      footer: `<span class="spacer">删除的书籍/章节会先移到这里</span>
               <button class="mini" data-role="clean" style="color:var(--danger)">清空回收站</button>
               <button class="primary" data-role="ok">好</button>`,
      onMount(bodyEl, footEl) {
        footEl.querySelector('[data-role="ok"]').onclick = closeModal;
        footEl.querySelector('[data-role="clean"]').onclick = async () => {
          const ok = await confirmDialog('清空回收站', '所有回收站内容将被永久删除，确定吗？', { okText: '永久删除', danger: true });
          if (!ok) return;
          try {
            const n = await api.emptyTrash();
            closeModal();
            toast(`已永久删除 ${n} 项`, 'ok');
          } catch (e) { toast(e.message, 'err'); }
        };
        bodyEl.querySelectorAll('[data-role="open"]').forEach((btn) => {
          btn.onclick = () => api.openInExplorer(btn.dataset.path).catch(() => {});
        });
      },
    });
  } catch (e) { toast(e.message, 'err'); }
}

// ------------------------------------------------------------------ 导入 / 体检 / 帮助

export async function importTextDialog() {
  if (!state.book) { toast('请先选择一本书', 'warn'); return; }
  const volId = state.activeVolumeId || (state.book.volumes[0] && state.book.volumes[0].id);
  openModal({
    title: '导入文本',
    width: 'narrow',
    body: `<div class="field"><label>导入方式</label>
        <select id="impMode">
          <option value="file">从 TXT / MD 文件导入（自动识别"第X章"分章）</option>
          <option value="paste">粘贴文本导入</option>
          <option value="backup">从写心 JSON 备份恢复</option>
        </select></div>
      <div class="field" id="impFileWrap" style="margin-top:10px">
        <label>文件</label>
        <div class="range-row"><input id="impPath" type="text" readonly placeholder="点击右侧按钮选择" />
        <button class="mini" id="impBrowse">选择…</button></div>
      </div>
      <div class="field" id="impPasteWrap" style="margin-top:10px" hidden>
        <label>粘贴内容</label><textarea id="impText" rows="10" placeholder="粘贴整本或整章文本，会自动按章节标题切分"></textarea>
      </div>
      <div class="field" style="margin-top:10px">
        <label>导入到</label>
        <select id="impVolume">${state.book.volumes.map((v) => `<option value="${v.id}" ${v.id === volId ? 'selected' : ''}>${escapeHtml(v.title)}</option>`).join('')}</select>
      </div>`,
    footer: `<button class="mini" data-role="cancel">取消</button><button class="primary" data-role="import">开始导入</button>`,
    onMount(bodyEl, footEl) {
      const mode = bodyEl.querySelector('#impMode');
      const sync = () => {
        const v = mode.value;
        bodyEl.querySelector('#impFileWrap').hidden = v !== 'file';
        bodyEl.querySelector('#impPasteWrap').hidden = v !== 'paste';
      };
      mode.addEventListener('change', sync);
      sync();
      bodyEl.querySelector('#impBrowse').onclick = async () => {
        try {
          const path = await api.pickOpenFile('txt');
          if (path) bodyEl.querySelector('#impPath').value = path;
        } catch (e) { toast(e.message, 'err'); }
      };
      footEl.querySelector('[data-role="cancel"]').onclick = closeModal;
      footEl.querySelector('[data-role="import"]').onclick = async () => {
        const v = mode.value;
        try {
          let book;
          if (v === 'backup') {
            const path = bodyEl.querySelector('#impPath').value;
            if (!path) {
              const picked = await api.pickOpenFile('json');
              if (!picked) return;
              book = await api.importBackup(picked, true);
            } else {
              book = await api.importBackup(path, true);
            }
            await reloadWorkspace();
            closeModal();
            await switchBook(book.id);
            toast(`已导入《${book.title}》`, 'ok');
            return;
          }
          if (v === 'file') {
            const path = bodyEl.querySelector('#impPath').value;
            if (!path) { toast('请先选择文件', 'warn'); return; }
            book = await api.importText(state.book.id, bodyEl.querySelector('#impVolume').value, path, null);
          } else {
            const text = bodyEl.querySelector('#impText').value;
            if (!text.trim()) { toast('请粘贴内容', 'warn'); return; }
            book = await api.importText(state.book.id, bodyEl.querySelector('#impVolume').value, null, text);
          }
          setState({ book });
          closeModal();
          renderToc();
          const all = book.volumes.flatMap((vv) => vv.chapters);
          if (all.length) await window.__moge.openChapter(all[all.length - 1].id);
          toast('导入完成', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
    },
  });
}

export async function runVerify() {
  if (!state.book) { toast('请先选择一本书', 'warn'); return; }
  try {
    const issues = await api.verifyBook(state.book.id);
    if (issues.length === 0) {
      toast('数据体检通过，未发现不一致', 'ok');
      return;
    }
    openModal({
      title: '数据体检结果',
      body: `<div class="kv-list">${issues.map((i) => `<div class="kv"><span>${escapeHtml(i)}</span></div>`).join('')}</div>`,
      footer: '<button class="primary" data-role="ok">好</button>',
      onMount(b, f) { f.querySelector('[data-role="ok"]').onclick = closeModal; },
    });
    await refreshBook();
  } catch (e) { toast(e.message, 'err'); }
}

export function openHelp() {
  const shortcuts = [
    ['Ctrl + S', '保存当前章节'],
    ['Ctrl + Shift + S', '保存并创建历史快照'],
    ['Ctrl + Shift + F', '一键排版'],
    ['Ctrl + E', '导出'],
    ['Ctrl + Y', '历史版本'],
    ['Ctrl + F', '全文搜索'],
    ['Ctrl + H', '查找替换'],
    ['Ctrl + N', '新建书籍'],
    ['Ctrl + Alt + N', '新建章节'],
    ['F9', '显示/隐藏左侧栏'],
    ['F10', '显示/隐藏右侧栏'],
    ['F11', '专注模式'],
    ['Ctrl + P', '番茄钟'],
    ['Esc', '关闭弹层 / 退出专注'],
  ];
  openModal({
    title: '写心 · 使用说明',
    body: `
      <div class="section-title">快捷键</div>
      <div class="shortcut-grid">
        ${shortcuts.map(([k, v]) => `<div class="row"><span>${v}</span><kbd>${k}</kbd></div>`).join('')}
      </div>
      <div class="section-title">数据与版本</div>
      <div style="font-size:12.5px;line-height:1.9;color:var(--ink-soft)">
        所有内容都保存在本机数据目录，可整目录拷贝备份：<br/>
        <code style="word-break:break-all">${escapeHtml(state.storageDir)}</code><br/>
        · 编辑时会按设定间隔自动保存；每章默认保留 ${state.settings.historyDepth} 个历史版本，可随时对比回滚。<br/>
        · "一键排版"点一下直接生效（段首两格、清理行尾空格与多余空行、自动补章节标题），排错了可 <kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤回。<br/>
        · 右侧卡片分人物 / 剧情 / 灵光 / 设定，双击编辑，选中后点"插入正文"即可写入光标处。<br/>
        · 导出支持 EPUB 电子书、TXT、Markdown、HTML 与 JSON 完整备份（含历史版本和卡片）。
      </div>
      <div class="section-title">关于</div>
      <div class="kv-list">
        <div class="kv"><span class="k">名称</span><span>写心 · HeartWrite</span></div>
        <div class="kv"><span class="k">版本</span><span>0.1.0</span></div>
        <div class="kv"><span class="k">技术栈</span><span>Rust + Tauri 2 + WebView2（原生桌面应用）</span></div>
        <div class="kv"><span class="k">许可证</span><span>GPL-3.0 · 修改后分发须同样开源</span></div>
        <div class="kv"><span class="k">本次会话新增</span><span>${state.sessionChars.toLocaleString()} 字</span></div>
      </div>
      <div style="font-size:12.5px;line-height:1.9;color:var(--ink-soft);margin-top:10px">
        写心是自由软件，采用 GPL-3.0：你可以随意使用、修改与再发布，
        但分发修改后的版本时必须一并公开完整源码。<br/>
        这不会影响你写出来的作品——小说版权完全属于你自己。
      </div>`,
    footer: '<button class="primary" data-role="ok">知道了</button>',
    onMount(b, f) { f.querySelector('[data-role="ok"]').onclick = closeModal; },
  });
}
