// 外观与偏好设置弹层（8 套 MD3 二次元主题 · 字体搜索 · 创作体验 · AI 接口配置 · 存储）。

import { api } from '../api.js';
import { state, setState } from '../store.js';
import { toast, openModal, closeModal, escapeHtml, formatBytes } from '../ui.js';
import { applyFonts, restartAutosave } from '../editor.js';
import { renderAiHeader } from '../ai.js';
import { changeStorageDir } from './location.js';

const cjkPresets = [
  '霞鹜文楷', 'LXGW WenKai', '思源宋体', 'Source Han Serif SC', 'Source Han Sans SC',
  'Microsoft YaHei', '微软雅黑', 'SimSun', '宋体', 'SimHei', '黑体', 'KaiTi', '楷体',
  'FangSong', '仿宋', 'Noto Serif SC', 'Noto Sans SC', 'PingFang SC', 'Songti SC',
  'HarmonyOS Sans SC', 'Alibaba PuHuiTi', '方正书宋', '华文楷体',
];

function localFontNames() {
  return (state.fonts || []).map((f) => f.name);
}

/** 8 套 MD3 + 二次元主题清单：与 css/tokens.css 中的 html[data-theme=...] 一一对应。 */
export const THEMES = [
  { id: 'sakura', label: '樱花物语（二次元亮色 · 默认）', tag: '轻小说粉', swatches: ['#c0396f', '#ffd8e6', '#fff8fa'] },
  { id: 'starlight', label: '星夜物语（二次元暗色 MD3）', tag: '夜空紫蓝', swatches: ['#b6c4ff', '#ffb0ce', '#0f1220'] },
  { id: 'miku', label: '苍蓝初音（青葱澄澈 MD3）', tag: '苍蓝薄荷', swatches: ['#007882', '#bbf2f5', '#f2fbfb'] },
  { id: 'sunset', label: '黄昏校园（温暖夕阳 MD3）', tag: '琥珀晚霞', swatches: ['#b65319', '#ffdec8', '#fff8f3'] },
  { id: 'wisteria', label: '紫藤幻境（MD3 基线紫）', tag: '经典 MD3', swatches: ['#6750a4', '#eaddff', '#fef7ff'] },
  { id: 'moonlight-ink', label: '墨染月夜（暗黑护眼 MD3）', tag: '深夜翠墨', swatches: ['#82d9be', '#135141', '#111515'] },
  { id: 'sepia', label: '羊皮书卷（古典护眼）', tag: '暖纸书卷', swatches: ['#8e562c', '#f5dfca', '#efe5d4'] },
  { id: 'mono', label: '极简黑白（纯粹文字台）', tag: '黑白极简', swatches: ['#1a1a1d', '#e6e6eb', '#f5f5f7'] },
];

function normalizeThemeId(id) {
  const aliases = { light: 'wisteria', md3: 'wisteria', dark: 'starlight', 'md3-dark': 'starlight', forest: 'miku' };
  const mapped = aliases[id] || id || 'sakura';
  return THEMES.some((t) => t.id === mapped) ? mapped : 'sakura';
}

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

export function openSettings(focusSection = '') {
  const s = state.settings;
  const currentTheme = normalizeThemeId(s.theme);
  const canPick = state.hasNativePickers;
  const aiProfiles = JSON.parse(JSON.stringify(s.ai?.profiles || []));
  let editingProfileId = s.ai?.activeProfileId || (aiProfiles[0] && aiProfiles[0].id) || 'deepseek';

  openModal({
    title: '设置 · 外观 / 写作 / AI 助手',
    width: 'wide',
    body: `
      <div class="section-title">外观与二次元 MD3 主题</div>
      <div class="theme-grid" id="themeCardGrid">
        ${THEMES.map(
          (t) => `<button type="button" class="theme-card ${t.id === currentTheme ? 'active' : ''}" data-theme-pick="${t.id}">
            <span class="theme-swatches">${t.swatches.map((c) => `<i style="background:${c}"></i>`).join('')}</span>
            <strong>${escapeHtml(t.label.split('（')[0])}</strong>
            <small>${escapeHtml(t.tag)}</small>
          </button>`,
        ).join('')}
      </div>
      <div class="form-grid">
        <div class="field">
          <label>主题配色（共 ${THEMES.length} 套 MD3 主题）</label>
          <select id="setTheme">
            ${THEMES.map(
              (t) => `<option value="${t.id}" ${currentTheme === t.id ? 'selected' : ''}>${t.label}</option>`,
            ).join('')}
          </select>
        </div>
        <div class="field">
          <label>正文最大宽度</label>
          <div class="range-row">
            <input id="setWidth" type="range" min="520" max="1400" step="20" value="${s.editorWidth}" />
            <span class="val" id="setWidthVal">${s.editorWidth}px</span>
          </div>
        </div>
        <div class="field">
          <div class="switch-row">
            <span>二次元氛围装饰（柔光渐变与星标）</span>
            <label class="switch"><input type="checkbox" id="setAnimeDecor" ${s.animeDecor !== false ? 'checked' : ''} /><i></i></label>
          </div>
        </div>
        <div class="field">
          <div class="switch-row">
            <span>打字机居中滚动模式</span>
            <label class="switch"><input type="checkbox" id="setTypewriter" ${s.typewriterMode ? 'checked' : ''} /><i></i></label>
          </div>
        </div>
        <div class="field">
          <div class="switch-row">
            <span>显示快捷标点栏</span>
            <label class="switch"><input type="checkbox" id="setQuickPunct" ${s.quickPunctBar !== false ? 'checked' : ''} /><i></i></label>
          </div>
        </div>
        <div class="field">
          <div class="switch-row">
            <span>显示章纲便签栏</span>
            <label class="switch"><input type="checkbox" id="setShowSynopsis" ${s.showSynopsis !== false ? 'checked' : ''} /><i></i></label>
          </div>
        </div>
      </div>

      <div class="section-title">正文字体与排版</div>
      <div class="form-grid">
        <div class="field full">
          <label>正文字体（可搜索系统字体）</label>
          <div class="font-picker">
            <div class="font-search-row">
              <input id="fontSearch" type="search" placeholder="搜索字体名，如 楷体 / Song / Noto…" />
              <button class="mini" type="button" id="rescanFonts">重新扫描</button>
            </div>
            <div class="font-current">当前：<b id="fontCurrent">${escapeHtml(s.fontFamily)}</b> · 系统已发现 <span id="fontCount">${state.fonts.length}</span> 个字体</div>
            <div class="font-list" id="fontList"></div>
            <div class="font-search-row">
              <input id="setFontCustom" type="text" placeholder="或直接填写 CSS 字体名 / 字体列表" />
              <button class="mini" type="button" id="applyCustomFont">使用</button>
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
          <label>安装新字体</label>
          <button class="mini" type="button" id="openFontsDir" style="margin-bottom:6px">打开系统字体文件夹</button>
          <span class="hint">安装 .ttf/.otf 后点「重新扫描」即可选用。</span>
        </div>` : ''}
      </div>
      <div class="font-preview" id="fontPreview">樱瓣落在青石阶上，风把远方的钟声吹得很慢。<br/>The quick brown fox jumps over the lazy dog. 1234567890</div>

      <div class="section-title" id="secAiConfig">✨ AI 写心酱接口配置（支持 OpenAI 兼容 / Claude / Gemini / Ollama）</div>
      <div class="sync-card" style="margin-bottom:10px">
        <div class="form-grid">
          <div class="field">
            <label>选择 / 切换预设方案</label>
            <div class="range-row">
              <select id="aiEditSelect" style="flex:1"></select>
              <button type="button" class="mini" id="aiAddProfileBtn">＋ 新增</button>
              <button type="button" class="mini" id="aiDelProfileBtn" style="color:var(--danger)">删</button>
            </div>
          </div>
          <div class="field">
            <label>方案名称</label>
            <input id="aiProfName" type="text" placeholder="如：DeepSeek / 硅基流动 / 中转站" />
          </div>
          <div class="field">
            <label>协议类型</label>
            <select id="aiProfProvider">
              <option value="openai">OpenAI 兼容（DeepSeek / 硅基流动 / Kimi / Ollama 等）</option>
              <option value="anthropic">Anthropic Claude（Messages API）</option>
              <option value="gemini">Google Gemini（Generative Language API）</option>
            </select>
          </div>
          <div class="field">
            <label>API 地址（Base URL）</label>
            <input id="aiProfBaseUrl" type="url" placeholder="https://api.deepseek.com/v1" />
          </div>
          <div class="field">
            <label>API Key（仅保存在本机 settings.json，不随稿件同步）</label>
            <input id="aiProfKey" type="password" placeholder="sk-..." />
          </div>
          <div class="field">
            <label>模型名称</label>
            <div class="range-row">
              <input id="aiProfModel" type="text" placeholder="deepseek-chat" style="flex:1" />
              <button type="button" class="mini" id="aiFetchModelsBtn">拉取模型</button>
            </div>
            <select id="aiModelPick" hidden style="margin-top:6px"></select>
          </div>
          <div class="field">
            <label>创意温度（Temperature）</label>
            <div class="range-row">
              <input id="aiProfTemp" type="range" min="0" max="1.6" step="0.05" value="0.75" />
              <span class="val" id="aiProfTempVal">0.75</span>
            </div>
          </div>
          <div class="field">
            <label>单次最大输出 Token</label>
            <input id="aiProfMaxTokens" type="number" min="256" max="16384" step="128" value="2048" />
          </div>
          <div class="field">
            <label>附带正文上下文字符数</label>
            <input id="aiContextChars" type="number" min="500" max="20000" step="250" value="${s.ai?.contextChars || 2500}" />
          </div>
          <div class="field" style="justify-content:flex-end">
            <button type="button" class="mini" id="aiTestConnBtn">🔌 测试当前接口连通性</button>
          </div>
          <div class="field full">
            <label>自定义人设 / 写作风格提示词（留空则使用默认「写心酱」提示词）</label>
            <textarea id="aiSystemPrompt" rows="2" placeholder="例如：请保持日式轻小说细腻的心理描写风格，减少说教……">${escapeHtml(s.ai?.systemPrompt || '')}</textarea>
          </div>
        </div>
      </div>

      <div class="section-title">写作与同步设备</div>
      <div class="form-grid">
        <div class="field">
          <label>本机设备名（局域网/云同步显示）</label>
          <input id="setDeviceName" type="text" value="${escapeHtml(s.deviceName || '')}" placeholder="如：主力电脑 / 随身手机" />
        </div>
        <div class="field">
          <label>每日目标字数</label>
          <input id="setGoal" type="number" min="100" max="50000" step="100" value="${s.dailyGoal}" />
        </div>
        <div class="field">
          <label>自动保存间隔（秒）</label>
          <input id="setAutosave" type="number" min="5" max="600" value="${s.autosaveSecs}" />
        </div>
        <div class="field">
          <label>历史版本保留数量（每章）</label>
          <input id="setDepth" type="number" min="1" max="200" value="${s.historyDepth}" />
        </div>
        <div class="field">
          <label>自动快照字数阈值</label>
          <input id="setDelta" type="number" min="0" max="5000" value="${s.snapshotCharDelta}" />
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

      <div class="section-title">本地存储</div>
      <div class="kv-list">
        <div class="kv"><span class="k">稿件目录</span><span style="word-break:break-all">${escapeHtml(state.storageDir)}</span></div>
        <div class="kv"><span class="k">占用空间</span><span id="setStorageSize">${formatBytes(state.storageBytes)}</span></div>
      </div>
      ${!canPick
        ? '<div class="hint" style="margin-top:6px">手机端稿件保存在应用私有目录，建议搭配「跨端同步（局域网 / WebDAV）」或「JSON 备份」随时留存副本。</div>'
        : state.location?.isForced
          ? '<div class="hint" style="margin-top:6px">当前位置由启动参数指定，界面里不可更改。</div>'
          : ''}
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
        ${canPick ? '<button class="mini" type="button" id="openDataDir">打开稿件目录</button>' : ''}
        ${canPick && !state.location?.isForced ? '<button class="mini" type="button" id="changeDataDir">更换位置…</button>' : ''}
        <button class="mini" type="button" id="smokeTest">运行内置自检</button>
      </div>`,
    footer: `<button class="mini" data-role="preview">预览效果</button>
             <button class="mini" data-role="cancel">关闭</button>
             <button class="primary" data-role="save">保存设置</button>`,
    onMount(bodyEl, footEl) {
      const preview = bodyEl.querySelector('#fontPreview');
      const listEl = bodyEl.querySelector('#fontList');
      const themeSel = bodyEl.querySelector('#setTheme');
      let chosen = s.fontFamily;

      const syncThemeCards = (val) => {
        bodyEl.querySelectorAll('[data-theme-pick]').forEach((btn) => {
          btn.classList.toggle('active', btn.dataset.themePick === val);
        });
      };
      bodyEl.querySelector('#themeCardGrid').addEventListener('click', (e) => {
        const card = e.target.closest('[data-theme-pick]');
        if (!card) return;
        themeSel.value = card.dataset.themePick;
        syncThemeCards(themeSel.value);
        document.documentElement.setAttribute('data-theme', themeSel.value);
      });
      themeSel.addEventListener('change', () => {
        syncThemeCards(themeSel.value);
        document.documentElement.setAttribute('data-theme', themeSel.value);
      });

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

      // ---- 字体列表 ----
      const renderFontList = () => {
        const kw = (bodyEl.querySelector('#fontSearch').value || '').trim().toLowerCase();
        const seen = new Set();
        const items = [];
        const push = (name, file) => {
          if (!name || seen.has(name)) return;
          seen.add(name);
          items.push({ name, file });
        };
        localFontNames().forEach((name) => push(name, ''));
        (state.fonts || []).forEach((f) => push(f.name, f.file));
        cjkPresets.forEach((name) => push(name, ''));
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
        } catch (e) { toast(e.message, 'err'); }
      });
      const openFontsBtn = bodyEl.querySelector('#openFontsDir');
      if (openFontsBtn) {
        openFontsBtn.addEventListener('click', async () => {
          try { await api.openInExplorer('C:\\Windows\\Fonts'); } catch (e) { toast(e.message, 'err'); }
        });
      }
      renderFontList();
      live();

      // ---- AI 配置方案编辑器 ----
      const aiSel = bodyEl.querySelector('#aiEditSelect');
      const aiName = bodyEl.querySelector('#aiProfName');
      const aiProv = bodyEl.querySelector('#aiProfProvider');
      const aiUrl = bodyEl.querySelector('#aiProfBaseUrl');
      const aiKey = bodyEl.querySelector('#aiProfKey');
      const aiModel = bodyEl.querySelector('#aiProfModel');
      const aiModelPick = bodyEl.querySelector('#aiModelPick');
      const aiTemp = bodyEl.querySelector('#aiProfTemp');
      const aiTempVal = bodyEl.querySelector('#aiProfTempVal');
      const aiMaxTok = bodyEl.querySelector('#aiProfMaxTokens');

      const findEditing = () => aiProfiles.find((p) => p.id === editingProfileId) || aiProfiles[0];
      const flushEditing = () => {
        const cur = findEditing();
        if (!cur) return;
        cur.name = aiName.value.trim() || cur.name || '自定义方案';
        cur.provider = aiProv.value;
        cur.baseUrl = aiUrl.value.trim();
        cur.apiKey = aiKey.value.trim();
        cur.model = aiModel.value.trim();
        cur.temperature = Number(aiTemp.value) || 0.75;
        cur.maxTokens = Math.max(256, Number(aiMaxTok.value) || 2048);
      };
      const loadEditing = () => {
        aiSel.innerHTML = aiProfiles
          .map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === editingProfileId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`)
          .join('');
        const cur = findEditing();
        if (!cur) return;
        editingProfileId = cur.id;
        aiName.value = cur.name || '';
        aiProv.value = cur.provider || 'openai';
        aiUrl.value = cur.baseUrl || '';
        aiKey.value = cur.apiKey || '';
        aiModel.value = cur.model || '';
        aiTemp.value = String(cur.temperature ?? 0.75);
        aiTempVal.textContent = aiTemp.value;
        aiMaxTok.value = String(cur.maxTokens || 2048);
        aiModelPick.hidden = true;
      };
      aiTemp.addEventListener('input', () => { aiTempVal.textContent = aiTemp.value; });
      aiSel.addEventListener('change', () => {
        flushEditing();
        editingProfileId = aiSel.value;
        loadEditing();
      });
      bodyEl.querySelector('#aiAddProfileBtn').onclick = () => {
        flushEditing();
        const id = `custom-${Date.now().toString(36)}`;
        aiProfiles.push({
          id,
          name: '自定义接口',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: '',
          model: 'gpt-4o-mini',
          temperature: 0.75,
          maxTokens: 2048,
        });
        editingProfileId = id;
        loadEditing();
      };
      bodyEl.querySelector('#aiDelProfileBtn').onclick = () => {
        if (aiProfiles.length <= 1) { toast('至少保留一个 AI 配置方案', 'warn'); return; }
        const idx = aiProfiles.findIndex((p) => p.id === editingProfileId);
        if (idx >= 0) aiProfiles.splice(idx, 1);
        editingProfileId = aiProfiles[0].id;
        loadEditing();
      };
      bodyEl.querySelector('#aiFetchModelsBtn').onclick = async () => {
        flushEditing();
        const cur = findEditing();
        const btn = bodyEl.querySelector('#aiFetchModelsBtn');
        btn.disabled = true;
        btn.textContent = '拉取中…';
        try {
          const models = await api.aiListModels(cur.provider, cur.baseUrl, cur.apiKey);
          if (!models.length) {
            toast('远端未返回可用模型列表，可手动填写模型名', 'warn');
          } else {
            aiModelPick.innerHTML = `<option value="">从拉取的 ${models.length} 个模型中选用…</option>` +
              models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
            aiModelPick.hidden = false;
            toast(`拉取到 ${models.length} 个模型`, 'ok');
          }
        } catch (e) { toast(e.message, 'err'); }
        finally { btn.disabled = false; btn.textContent = '拉取模型'; }
      };
      aiModelPick.addEventListener('change', () => {
        if (aiModelPick.value) aiModel.value = aiModelPick.value;
      });
      bodyEl.querySelector('#aiTestConnBtn').onclick = async () => {
        flushEditing();
        const cur = findEditing();
        const btn = bodyEl.querySelector('#aiTestConnBtn');
        btn.disabled = true;
        btn.textContent = '测试中…';
        try {
          const res = await api.aiTestConnection(cur);
          toast(`连接成功（${res.latencyMs} ms · ${res.model}）`, 'ok', res.reply || '');
        } catch (e) { toast(e.message, 'err'); }
        finally { btn.disabled = false; btn.textContent = '🔌 测试当前接口连通性'; }
      };
      loadEditing();

      // ---- 存储与自检 ----
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

      footEl.querySelector('[data-role="cancel"]').onclick = () => {
        applyFonts();
        closeModal();
      };
      footEl.querySelector('[data-role="preview"]').onclick = () => {
        openStylePreview({
          ...state.settings,
          theme: themeSel.value,
          fontFamily: chosen,
          fontSize: Number(bodyEl.querySelector('#setFontSize').value),
          lineHeight: Number(bodyEl.querySelector('#setLineHeight').value),
          letterSpacing: Number(bodyEl.querySelector('#setLetterSpacing').value),
          editorWidth: Number(bodyEl.querySelector('#setWidth').value),
        });
      };
      footEl.querySelector('[data-role="save"]').onclick = async () => {
        flushEditing();
        const next = {
          ...state.settings,
          theme: themeSel.value,
          fontFamily: chosen,
          fontSize: Number(bodyEl.querySelector('#setFontSize').value),
          lineHeight: Number(bodyEl.querySelector('#setLineHeight').value),
          letterSpacing: Number(bodyEl.querySelector('#setLetterSpacing').value),
          editorWidth: Number(bodyEl.querySelector('#setWidth').value),
          animeDecor: bodyEl.querySelector('#setAnimeDecor').checked,
          typewriterMode: bodyEl.querySelector('#setTypewriter').checked,
          quickPunctBar: bodyEl.querySelector('#setQuickPunct').checked,
          showSynopsis: bodyEl.querySelector('#setShowSynopsis').checked,
          deviceName: bodyEl.querySelector('#setDeviceName').value.trim() || state.settings.deviceName,
          autosaveSecs: Number(bodyEl.querySelector('#setAutosave').value),
          historyDepth: Number(bodyEl.querySelector('#setDepth').value),
          snapshotCharDelta: Number(bodyEl.querySelector('#setDelta').value),
          dailyGoal: Number(bodyEl.querySelector('#setGoal').value),
          oneClickFormatRule: bodyEl.querySelector('#setRule').value,
          ai: {
            ...state.settings.ai,
            activeProfileId: editingProfileId,
            profiles: aiProfiles,
            contextChars: Math.max(500, Number(bodyEl.querySelector('#aiContextChars').value) || 2500),
            systemPrompt: bodyEl.querySelector('#aiSystemPrompt').value,
          },
        };
        try {
          const saved = await api.saveSettings(next);
          setState({ settings: { ...next, ...saved } });
          applyFonts();
          restartAutosave();
          renderAiHeader();
          closeModal();
          toast('设置已保存', 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };

      if (focusSection === 'ai') {
        setTimeout(() => {
          bodyEl.querySelector('#secAiConfig')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 60);
      }
    },
    onClose() {
      applyFonts();
    },
  });
}

/** 主题 / 字体预览：用下拉框实时切换主题与字体，整体界面 + 正文样例同步变化。 */
export function openStylePreview(draft) {
  const originalTheme = document.documentElement.getAttribute('data-theme');
  const originalStyle = document.documentElement.getAttribute('style') || '';
  draft.theme = normalizeThemeId(draft.theme);
  const sample = [
    '雪落下来了。',
    '他站在城墙上，看着远处连绵的灯火。风从北面吹来，卷起衣角的一片霜色。',
    '“你还是来了。”身后传来一个声音。',
    '他没有回头，只是把手按在刀柄上：“我等这一天，等了十年。”',
  ];
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
              .map((n) => `<option value="${escapeHtml(n)}" ${n === draft.fontFamily ? 'selected' : ''}>${escapeHtml(n)}</option>`)
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
            <span>新建章</span><span>AI 助手</span><span>跨端同步</span><span>大纲视图</span>
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
            <div class="preview-card" style="--card-color:#c0396f"><b>人物卡</b><span>身份、性格、目标…</span></div>
            <div class="preview-card" style="--card-color:#4e5fa6"><b>✨ AI 写心酱</b><span>续写、润色、脑洞…</span></div>
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
        } catch (e) { toast(e.message, 'err'); }
      };
    },
    onClose() {
      if (originalTheme) document.documentElement.setAttribute('data-theme', originalTheme);
      document.documentElement.setAttribute('style', originalStyle);
      applyFonts();
    },
  });
}
