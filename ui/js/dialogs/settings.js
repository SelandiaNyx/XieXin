// 外观与偏好设置弹层、系统字体加载、主题与排版预览。

import { api } from '../api.js';
import { state, setState } from '../store.js';
import { toast, openModal, closeModal, escapeHtml, formatBytes } from '../ui.js';
import { applyFonts, restartAutosave } from '../editor.js';
import { changeStorageDir } from './location.js';

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

export function openSettings() {
  const s = state.settings;
  const canPick = state.hasNativePickers;
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
        ${canPick ? `<div class="field">
          <label>装新字体</label>
          <button class="mini" id="openFontsDir" style="margin-bottom:6px">打开系统字体文件夹</button>
          <span class="hint">把 .ttf/.otf 复制进去即安装（Windows 里双击也能装），然后点「重新扫描」就能选到它。</span>
        </div>` : ''}
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
        <div class="kv"><span class="k">稿件目录</span><span style="word-break:break-all">${escapeHtml(state.storageDir)}</span></div>
        <div class="kv"><span class="k">占用空间</span><span id="setStorageSize">${formatBytes(state.storageBytes)}</span></div>
      </div>
      ${!canPick
        ? '<div class="hint" style="margin-top:6px">手机端稿件保存在应用私有目录，卸载应用会一并清除，建议定期用「导出 → JSON 完整备份」留存副本。</div>'
        : state.location?.isForced
          ? '<div class="hint" style="margin-top:6px">当前位置由启动参数（--data-dir / NOVEL_MANAGER_DATA_DIR）指定，界面里不能改。</div>'
          : ''}
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
        ${canPick ? '<button class="mini" id="openDataDir">打开稿件目录</button>' : ''}
        ${canPick && !state.location?.isForced ? '<button class="mini" id="changeDataDir">更换位置…</button>' : ''}
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
      const openFontsBtn = bodyEl.querySelector('#openFontsDir');
      if (openFontsBtn) {
        openFontsBtn.addEventListener('click', async () => {
          try {
            await api.openInExplorer('C:\\Windows\\Fonts');
          } catch (e) {
            toast(e.message, 'err');
          }
        });
      }
      renderFontList();
      live();

      const openDataBtn = bodyEl.querySelector('#openDataDir');
      if (openDataBtn) {
        openDataBtn.addEventListener('click', async () => {
          try { await api.openInExplorer(state.storageDir); } catch (e) { toast(e.message, 'err'); }
        });
      }
      const changeDir = bodyEl.querySelector('#changeDataDir');
      if (changeDir) changeDir.addEventListener('click', () => changeStorageDir());
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

/** 主题 / 字体预览：用下拉框实时切换主题与字体，整体界面 + 正文样例同步变化。 */
export function openStylePreview(draft) {
  const originalTheme = document.documentElement.getAttribute('data-theme');
  const originalStyle = document.documentElement.getAttribute('style') || '';
  const sample = [
    '雪落下来了。',
    '他站在城墙上，看着远处连绵的灯火。风从北面吹来，卷起衣角的一片霜色。',
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
            <div><strong>作品名</strong><small>2 卷 · 4 章 · 200 字</small></div>
          </div>
          <div class="preview-toc">
            <div class="preview-vol">第一卷</div>
            <div class="preview-ch active"><span class="status-pill published"></span>第一章 起</div>
            <div class="preview-ch"><span class="status-pill revising"></span>第二章 承</div>
            <div class="preview-vol">第二卷</div>
            <div class="preview-ch"><span class="status-pill draft"></span>第三章 转</div>
          </div>
          <div class="preview-chips">
            <span>新建章</span><span>全文搜索</span><span>大纲视图</span><span>导入文本</span>
          </div>
        </aside>
        <main class="preview-main">
          <div class="preview-top">
            <span class="preview-crumb">第一卷 / </span>
            <b>第一章 起</b>
            <span class="preview-status">已发布</span>
          </div>
          <div class="preview-paper">
            <h3>第一章 起</h3>
            ${sample.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}
          </div>
          <div class="preview-sidebar-right">
            <div class="preview-card" style="--card-color:#8ab4f8"><b>人物卡</b><span>身份、性格、目标…</span></div>
            <div class="preview-card" style="--card-color:#f5a623"><b>剧情卡</b><span>伏笔、转折、回收…</span></div>
          </div>
        </main>
      </div>

      <div class="preview-fonts">
        <div class="section-title" style="margin-top:0">字体对比（同一段文字，三种字号）</div>
        <div class="preview-font-row" style="font-size:calc(var(--font-size) * 1.25)">第一章 起 · 山有木兮木有枝</div>
        <div class="preview-font-row">他站在城墙上，看着远处连绵的灯火。风从北面吹来，卷起衣角的一片霜色。</div>
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
